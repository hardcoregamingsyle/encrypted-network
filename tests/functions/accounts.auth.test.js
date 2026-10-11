// Sign in with email and a code: request, verify, me, logout, limits, the echo guard through the routes.
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../shared/hash.js';
import { Jar, accountEnv, callApi, loopbackIp, signIn } from './fakes.js';

const post = (env, path, json, o = {}) => callApi(env, 'POST', path, { json, ...o });

describe('POST /api/auth/request', () => {
  it('sends a code in echo mode and returns it as debugCode', async () => {
    const { env } = accountEnv();
    const res = await post(env, '/api/auth/request', { email: 'Priya@Example.Test ' });
    expect(res.status).toBe(200);
    expect(res.json.sent).toBe(true);
    expect(res.json.cooldown).toBe(30);
    expect(res.json.debugCode).toMatch(/^[0-9]{6}$/);
  });

  it('gives the same answer for a known and an unknown email', async () => {
    const { env } = accountEnv();
    const known = await signIn(env, { email: 'known@example.test' });
    expect(known.isNew).toBe(true);
    const a = await post(env, '/api/auth/request', { email: 'known@example.test' }, { ip: loopbackIp() });
    const b = await post(env, '/api/auth/request', { email: 'nobody@example.test' }, { ip: loopbackIp() });
    expect(a.status).toBe(b.status);
    expect(Object.keys(a.json).sort()).toEqual(Object.keys(b.json).sort());
    expect(a.json.cooldown).toBe(b.json.cooldown);
  });

  it('validates the email before any work (no code row, no rate use)', async () => {
    const { env, db } = accountEnv();
    for (const bad of [undefined, null, 5, '', 'x', 'a@b', 'a b@c.de', 'caf\u00e9@example.test', 'a@@b.cc', '<script>@a.bc']) {
      const res = await post(env, '/api/auth/request', { email: bad });
      expect(res.status, String(bad)).toBe(400);
      expect(res.json.code).toBe('invalid_email');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM otp_codes').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n).toBe(0);
  });

  it('refuses a body that is not a JSON object, and a missing Origin', async () => {
    const { env } = accountEnv();
    expect((await callApi(env, 'POST', '/api/auth/request', { body: 'nope', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
    expect((await callApi(env, 'POST', '/api/auth/request', { json: [1] })).status).toBe(400);
    const noOrigin = await callApi(env, 'POST', '/api/auth/request', { json: { email: 'a@example.test' }, origin: null });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.json.code).toBe('forbidden');
    const wrong = await callApi(env, 'POST', '/api/auth/request', { json: { email: 'a@example.test' }, origin: 'https://evil.test' });
    expect(wrong.status).toBe(403);
  });

  it('answers 503 accounts_unavailable without a master key and a bad master key', async () => {
    for (const key of [undefined, '', 'short', 'x'.repeat(44), '!'.repeat(44)]) {
      const { env } = accountEnv({ env: { ACCOUNT_MASTER_KEY: key } });
      const res = await post(env, '/api/auth/request', { email: 'a@example.test' });
      expect(res.status, String(key)).toBe(503);
      expect(res.json.code).toBe('accounts_unavailable');
    }
  });

  it('answers 503 mail_unavailable when no mail provider is set', async () => {
    for (const provider of [undefined, 'none', 'smtp', 'resend']) {
      const { env } = accountEnv({ env: { MAIL_PROVIDER: provider } });
      const res = await post(env, '/api/auth/request', { email: 'a@example.test' });
      expect(res.status, String(provider)).toBe(503);
      expect(res.json.code).toBe('mail_unavailable');
    }
  });

  it('does not log or return the code outside echo mode and drops it when the mail fails', async () => {
    const { env, db } = accountEnv({ env: { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key', MAIL_FROM: 'hrdlock <no-reply@example.test>' } });
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), body: init.body });
      return new Response('{"message":"secret provider text"}', { status: 500 });
    };
    try {
      const res = await post(env, '/api/auth/request', { email: 'a@example.test' }, { base: 'https://hrdlock.example', ip: '203.0.113.8' });
      expect(res.status).toBe(502);
      expect(res.json.code).toBe('mail_failed');
      expect(res.text).not.toMatch(/secret provider text|re_test_key/);
      expect(seen.length).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM otp_codes').get().n).toBe(0);
      // the person may try again at once, the cooldown does not apply to a mail that never left
      const again = await post(env, '/api/auth/request', { email: 'a@example.test' }, { base: 'https://hrdlock.example', ip: '203.0.113.9' });
      expect(again.status).toBe(502);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('sends the email with the real provider shape on success and returns no code', async () => {
    const { env } = accountEnv({ env: { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key', MAIL_FROM: 'no-reply@example.test' } });
    let sent = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      sent = { url: String(url), init };
      return new Response('{"id":"1"}', { status: 200 });
    };
    try {
      const res = await post(env, '/api/auth/request', { email: 'Person@Example.Test' }, { base: 'https://hrdlock.example', ip: '203.0.113.9' });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ sent: true, cooldown: 30 });
      const body = JSON.parse(sent.init.body);
      expect(body.to).toEqual(['person@example.test']);
      expect(body.subject).toMatch(/^Your hrdlock code: [0-9]{6}$/);
      expect(body.text).toContain(body.subject.slice(-6));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('applies the resend cooldown of 30 seconds per email with Retry-After', async () => {
    const { env } = accountEnv();
    const first = await post(env, '/api/auth/request', { email: 'cool@example.test' }, { ip: loopbackIp() });
    expect(first.status).toBe(200);
    const second = await post(env, '/api/auth/request', { email: 'cool@example.test' }, { ip: loopbackIp() });
    expect(second.status).toBe(429);
    expect(second.json.code).toBe('rate_limited');
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(second.headers.get('retry-after'))).toBeLessThanOrEqual(30);
    // another email is not held back
    expect((await post(env, '/api/auth/request', { email: 'other@example.test' }, { ip: loopbackIp() })).status).toBe(200);
  });

  it('allows a new code once the cooldown has passed, and the new code replaces the old', async () => {
    const { env } = accountEnv();
    const t0 = 2_000_000_000_000;
    const at = (t) => ({ ip: loopbackIp(), headers: { 'x-hrd-test-now': String(t) } });
    const a = await post(env, '/api/auth/request', { email: 'again@example.test' }, at(t0));
    const b = await post(env, '/api/auth/request', { email: 'again@example.test' }, at(t0 + 31_000));
    expect(b.status).toBe(200);
    if (a.json.debugCode !== b.json.debugCode) {
      const old = await post(env, '/api/auth/verify', { email: 'again@example.test', code: a.json.debugCode }, at(t0 + 32_000));
      expect(old.json.code).toBe('invalid_code');
    }
    const ok = await post(env, '/api/auth/verify', { email: 'again@example.test', code: b.json.debugCode }, at(t0 + 33_000));
    expect(ok.status).toBe(200);
  });

  it('limits requests: 5 per hour per email, 20 per hour per address, 400 per hour in total', async () => {
    const { env } = accountEnv();
    const t0 = 2_000_000_000_000;
    // 5 per hour for one email (spaced past the cooldown)
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const res = await post(env, '/api/auth/request', { email: 'busy@example.test' }, { ip: loopbackIp(), headers: { 'x-hrd-test-now': String(t0 + i * 31_000) } });
      codes.push(res.status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    // 20 per hour for one address
    const ip = loopbackIp();
    const statuses = [];
    for (let i = 0; i < 22; i++) {
      const res = await post(env, '/api/auth/request', { email: `user${i}@example.test` }, { ip, headers: { 'x-hrd-test-now': String(t0) } });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200).length).toBe(20);
    expect(statuses.slice(20)).toEqual([429, 429]);
    // the window moves on after an hour
    const later = await post(env, '/api/auth/request', { email: 'later@example.test' }, { ip, headers: { 'x-hrd-test-now': String(t0 + 3_700_000) } });
    expect(later.status).toBe(200);
  });

  it('limits the whole service to 400 codes an hour', async () => {
    const { env, db } = accountEnv();
    const t0 = 2_000_000_000_000;
    const window = Math.floor(t0 / 3_600_000) * 3_600_000;
    db.prepare("INSERT INTO rate_limits (bucket, \"window\", count) VALUES ('code-all:all', ?, 400)").run(window);
    const res = await post(env, '/api/auth/request', { email: 'late@example.test' }, { ip: loopbackIp(), headers: { 'x-hrd-test-now': String(t0) } });
    expect(res.status).toBe(429);
    expect(res.json.code).toBe('rate_limited');
  });
});

describe('POST /api/auth/verify', () => {
  it('creates an account on the first right code and sets the session cookie', async () => {
    const { env, db } = accountEnv();
    const s = await signIn(env, { email: 'New.Person@Example.Test' });
    expect(s.isNew).toBe(true);
    expect(s.account.displayName).toBeNull();
    expect(s.account.emailMasked).toBe('ne***@example.test');
    expect(s.account.strict).toBe(false);
    expect(s.account.id).toMatch(/^[0-9a-f]{32}$/);
    const row = db.prepare('SELECT * FROM accounts').get();
    expect(row.email_hash).toMatch(/^[0-9a-f]{64}$/);
    // the address itself is stored nowhere
    for (const t of ['accounts', 'sessions', 'otp_codes', 'account_keys', 'account_secrets', 'rate_limits']) {
      const text = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());
      expect(text.toLowerCase(), t).not.toContain('new.person');
    }
    expect(s.jar.get('hrd_session')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sess = db.prepare('SELECT * FROM sessions').get();
    expect(sess.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sess.token_hash).not.toBe(s.jar.get('hrd_session'));
  });

  it('a second sign in finds the same account, with isNew false', async () => {
    const { env } = accountEnv();
    const a = await signIn(env, { email: 'same@example.test' });
    const b = await signIn(env, { email: ' SAME@example.test' });
    expect(b.isNew).toBe(false);
    expect(b.account.id).toBe(a.account.id);
  });

  it('uses the code up: a second use of the same right code is code_expired', async () => {
    const { env } = accountEnv();
    const ip = loopbackIp();
    const req = await post(env, '/api/auth/request', { email: 'once@example.test' }, { ip });
    const body = { email: 'once@example.test', code: req.json.debugCode };
    expect((await post(env, '/api/auth/verify', body, { ip })).status).toBe(200);
    const again = await post(env, '/api/auth/verify', body, { ip });
    expect(again.status).toBe(400);
    expect(again.json.code).toBe('code_expired');
  });

  // Wrong tries are counted per source (one address, for one email) and per email: 5 an hour from one
  // address, 25 an hour from all addresses together. A stranger's tries from other addresses do not kill the
  // code that was mailed to its owner (finding: auth-lockout, "live code").
  it('a wrong code is invalid_code (400); the fifth wrong try from one address ends that address tries', async () => {
    const { env, db } = accountEnv();
    const ip = loopbackIp();
    const req = await post(env, '/api/auth/request', { email: 'wrong@example.test' }, { ip: loopbackIp() });
    const good = req.json.debugCode;
    const bad = good === '000000' ? '000001' : '000000';
    const outcomes = [];
    for (let i = 0; i < 6; i++) {
      const res = await post(env, '/api/auth/verify', { email: 'wrong@example.test', code: bad }, { ip });
      outcomes.push(res.status + ':' + res.json.code);
    }
    // (the 10 per 10 minutes limit of one address is not reached with 6 tries)
    expect(outcomes).toEqual(['400:invalid_code', '400:invalid_code', '400:invalid_code', '400:invalid_code', '429:too_many_attempts', '429:too_many_attempts']);
    expect(db.prepare('SELECT attempts FROM otp_codes').get().attempts).toBe(5);
    // even the right code is refused to that address now
    const right = await post(env, '/api/auth/verify', { email: 'wrong@example.test', code: good }, { ip });
    expect(right.status).toBe(429);
    expect(right.json.code).toBe('too_many_attempts');
    expect(Number(right.headers.get('retry-after'))).toBeGreaterThan(0);
    // a new request makes a fresh code (after the cooldown) and the address may try again
    const t = Date.now() + 40_000;
    const fresh = await post(env, '/api/auth/request', { email: 'wrong@example.test' }, { ip: loopbackIp(), headers: { 'x-hrd-test-now': String(t) } });
    expect(fresh.status).toBe(200);
    const ok = await post(env, '/api/auth/verify', { email: 'wrong@example.test', code: fresh.json.debugCode }, { ip, headers: { 'x-hrd-test-now': String(t + 1000) } });
    expect(ok.status).toBe(200);
  });

  it('wrong tries from other addresses do not kill the code: the owner still gets in with the right one', async () => {
    const { env, db } = accountEnv();
    const req = await post(env, '/api/auth/request', { email: 'stranger@example.test' }, { ip: loopbackIp() });
    const bad = req.json.debugCode === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await post(env, '/api/auth/verify', { email: 'stranger@example.test', code: bad }, { ip: loopbackIp() });
      expect(res.json.code).toBe('invalid_code');
    }
    expect(db.prepare('SELECT attempts FROM otp_codes').get().attempts).toBe(5);
    const owner = await post(env, '/api/auth/verify', { email: 'stranger@example.test', code: req.json.debugCode }, { ip: loopbackIp() });
    expect(owner.status).toBe(200);
  });

  it('one email takes at most 25 wrong tries an hour from all addresses together, then even the right code waits', async () => {
    const { env } = accountEnv();
    const t0 = 2_100_000_000_000;
    const at = (t) => ({ ip: loopbackIp(), headers: { 'x-hrd-test-now': String(t) } });
    const req = await post(env, '/api/auth/request', { email: 'budget@example.test' }, at(t0));
    const bad = req.json.debugCode === '000000' ? '000001' : '000000';
    const codes = [];
    for (let i = 0; i < 28; i++) codes.push((await post(env, '/api/auth/verify', { email: 'budget@example.test', code: bad }, at(t0 + 1000))).json.code);
    // the 25th wrong try is the one that answers too_many_attempts (as the fifth does above)
    expect(codes.filter((c) => c === 'invalid_code').length).toBe(24);
    expect(codes[24]).toBe('too_many_attempts'); // the code is dead
    // after that the email is out of wrong tries: a plain rate_limited (a new code would not help)
    expect(codes.slice(25)).toEqual(['rate_limited', 'rate_limited', 'rate_limited']);
    const owner = await post(env, '/api/auth/verify', { email: 'budget@example.test', code: req.json.debugCode }, at(t0 + 2000));
    expect(owner.json.code).toBe('rate_limited');
    expect(Number(owner.headers.get('retry-after'))).toBeGreaterThan(0);
    // two hours later the budget is back
    const fresh = await post(env, '/api/auth/request', { email: 'budget@example.test' }, at(t0 + 2 * 3_600_000));
    const ok = await post(env, '/api/auth/verify', { email: 'budget@example.test', code: fresh.json.debugCode }, at(t0 + 2 * 3_600_000 + 1000));
    expect(ok.status).toBe(200);
  });

  it('a right code costs nothing, and a try when there is no live code is not counted', async () => {
    const { env, db } = accountEnv();
    const ip = loopbackIp();
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      const req = await post(env, '/api/auth/request', { email: 'free@example.test' }, { ip: loopbackIp(), headers: { 'x-hrd-test-now': String(base + i * 40_000) } });
      const ok = await post(env, '/api/auth/verify', { email: 'free@example.test', code: req.json.debugCode }, { ip: loopbackIp(), headers: { 'x-hrd-test-now': String(base + i * 40_000 + 1000) } });
      expect(ok.status).toBe(200);
    }
    const none = await post(env, '/api/auth/verify', { email: 'nocode@example.test', code: '123456' }, { ip });
    expect(none.json.code).toBe('code_expired');
    const counts = db.prepare("SELECT bucket, count FROM rate_limits WHERE bucket LIKE 'vfy-src:%' OR bucket LIKE 'vfy-bad:%'").all();
    expect(counts.every((r) => r.count === 0), JSON.stringify(counts)).toBe(true);
  });

  it('the fifth try can still be the right one', async () => {
    const { env } = accountEnv();
    const ip = loopbackIp();
    const req = await post(env, '/api/auth/request', { email: 'fifth@example.test' }, { ip: loopbackIp() });
    const bad = req.json.debugCode === '111111' ? '222222' : '111111';
    for (let i = 0; i < 4; i++) await post(env, '/api/auth/verify', { email: 'fifth@example.test', code: bad }, { ip });
    const ok = await post(env, '/api/auth/verify', { email: 'fifth@example.test', code: req.json.debugCode }, { ip });
    expect(ok.status).toBe(200);
  });

  it('parallel guesses from one address can not get more than five tries', async () => {
    const { env, db } = accountEnv();
    const req = await post(env, '/api/auth/request', { email: 'race@example.test' }, { ip: loopbackIp() });
    const bad = req.json.debugCode === '123456' ? '654321' : '123456';
    const ip = loopbackIp();
    const results = await Promise.all(Array.from({ length: 10 }, () => post(env, '/api/auth/verify', { email: 'race@example.test', code: bad }, { ip })));
    expect(results.filter((r) => r.json.code === 'invalid_code').length).toBe(4);
    expect(results.filter((r) => r.json.code === 'too_many_attempts').length).toBe(6);
    expect(db.prepare('SELECT attempts FROM otp_codes').get().attempts).toBe(5);
  });

  it('parallel guesses from many addresses can not get more than 25 tries at one email', async () => {
    const { env, db } = accountEnv();
    const req = await post(env, '/api/auth/request', { email: 'race2@example.test' }, { ip: loopbackIp() });
    const bad = req.json.debugCode === '123456' ? '654321' : '123456';
    const results = await Promise.all(Array.from({ length: 40 }, () => post(env, '/api/auth/verify', { email: 'race2@example.test', code: bad }, { ip: loopbackIp() })));
    expect(results.filter((r) => r.json.code === 'invalid_code').length).toBe(24);
    expect(results.filter((r) => r.json.code === 'too_many_attempts').length).toBe(1);
    expect(results.filter((r) => r.json.code === 'rate_limited').length).toBe(15);
    expect(db.prepare('SELECT attempts FROM otp_codes').get().attempts).toBe(25);
  });

  it('a dead code does not hold the person back: the next request sends a new code at once', async () => {
    const { env } = accountEnv();
    const t0 = 2_200_000_000_000;
    const at = (t, ip = loopbackIp()) => ({ ip, headers: { 'x-hrd-test-now': String(t) } });
    const req = await post(env, '/api/auth/request', { email: 'dead@example.test' }, at(t0));
    const bad = req.json.debugCode === '000000' ? '000001' : '000000';
    for (let i = 0; i < 25; i++) await post(env, '/api/auth/verify', { email: 'dead@example.test', code: bad }, at(t0 + 1000));
    // 2 seconds after the first code (inside the 30 second wait), but the code is dead
    const again = await post(env, '/api/auth/request', { email: 'dead@example.test' }, at(t0 + 2000));
    expect(again.status).toBe(200);
  });

  it('an expired code is code_expired (checked against the test clock)', async () => {
    const { env } = accountEnv();
    const t0 = 2_000_000_000_000;
    const req = await post(env, '/api/auth/request', { email: 'late@example.test' }, { ip: loopbackIp(), headers: { 'x-hrd-test-now': String(t0) } });
    const late = await post(env, '/api/auth/verify', { email: 'late@example.test', code: req.json.debugCode }, { ip: loopbackIp(), headers: { 'x-hrd-test-now': String(t0 + 10 * 60_000) } });
    expect(late.status).toBe(400);
    expect(late.json.code).toBe('code_expired');
    const just = await post(env, '/api/auth/request', { email: 'edge@example.test' }, { ip: loopbackIp(), headers: { 'x-hrd-test-now': String(t0) } });
    const edge = await post(env, '/api/auth/verify', { email: 'edge@example.test', code: just.json.debugCode }, { ip: loopbackIp(), headers: { 'x-hrd-test-now': String(t0 + 10 * 60_000 - 1) } });
    expect(edge.status).toBe(200);
  });

  it('no code at all (never asked) looks the same as an expired one', async () => {
    const { env } = accountEnv();
    const res = await post(env, '/api/auth/verify', { email: 'never@example.test', code: '123456' }, { ip: loopbackIp() });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('code_expired');
  });

  it('a code for one email does not work for another', async () => {
    const { env } = accountEnv();
    const a = await post(env, '/api/auth/request', { email: 'one@example.test' }, { ip: loopbackIp() });
    const b = await post(env, '/api/auth/request', { email: 'two@example.test' }, { ip: loopbackIp() });
    // use a code that is surely not the one of the second email
    const other = a.json.debugCode === b.json.debugCode ? (a.json.debugCode === '000000' ? '000001' : '000000') : a.json.debugCode;
    const res = await post(env, '/api/auth/verify', { email: 'two@example.test', code: other }, { ip: loopbackIp() });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('invalid_code');
  });

  it('validates the code format first and does not use a try for it', async () => {
    const { env, db } = accountEnv();
    const req = await post(env, '/api/auth/request', { email: 'fmt@example.test' }, { ip: loopbackIp() });
    for (const code of [undefined, null, 123456, '12345', '1234567', 'abcdef', '12 34', '12-3456', ' ', '', '\u0661\u0662\u0663\u0664\u0665\u0666']) {
      const res = await post(env, '/api/auth/verify', { email: 'fmt@example.test', code }, { ip: loopbackIp() });
      expect(res.status, String(code)).toBe(400);
      expect(res.json.code).toBe('invalid_code');
    }
    expect(db.prepare('SELECT attempts FROM otp_codes').get().attempts).toBe(0);
    // digits with spaces in between are fine (people type "123 456")
    const spaced = req.json.debugCode.slice(0, 3) + ' ' + req.json.debugCode.slice(3);
    expect((await post(env, '/api/auth/verify', { email: 'fmt@example.test', code: spaced }, { ip: loopbackIp() })).status).toBe(200);
  });

  it('limits code checks to 10 per 10 minutes per address', async () => {
    const { env } = accountEnv();
    const ip = loopbackIp();
    const t0 = 2_000_000_000_000;
    const codes = [];
    for (let i = 0; i < 12; i++) {
      const res = await post(env, '/api/auth/verify', { email: 'nobody@example.test', code: '123456' }, { ip, headers: { 'x-hrd-test-now': String(t0) } });
      codes.push(res.json.code);
    }
    expect(codes.slice(0, 10).every((c) => c === 'code_expired')).toBe(true);
    expect(codes.slice(10)).toEqual(['rate_limited', 'rate_limited']);
    const later = await post(env, '/api/auth/verify', { email: 'nobody@example.test', code: '123456' }, { ip, headers: { 'x-hrd-test-now': String(t0 + 10 * 60_000) } });
    expect(later.json.code).toBe('code_expired');
  });

  it('keeps at most 20 sessions per account and removes the ones that ran out', async () => {
    const { env, db } = accountEnv();
    const first = await signIn(env, { email: 'many@example.test' });
    for (let i = 0; i < 24; i++) {
      db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(
        String(i).padStart(64, '0'), first.account.id, 1000 + i, Date.now() + 100000, 1000 + i
      );
    }
    // one that ran out long ago
    db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?, ?, 1, 2, 1)').run('f'.repeat(64), first.account.id);
    const next = await signIn(env, { email: 'many@example.test', ip: loopbackIp() });
    const rows = db.prepare('SELECT token_hash FROM sessions WHERE account_id = ?').all(first.account.id);
    expect(rows.length).toBe(20);
    expect(rows.some((r) => r.token_hash === 'f'.repeat(64))).toBe(false);
    expect((await callApi(env, 'GET', '/api/me', { jar: next.jar })).status).toBe(200);
  });
});

describe('sessions: GET /api/me, logout, expiry', () => {
  it('GET /api/me needs a session (401 unauthenticated)', async () => {
    const { env } = accountEnv();
    const res = await callApi(env, 'GET', '/api/me');
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('unauthenticated');
  });

  it('GET /api/me returns the account and its keys', async () => {
    const { env } = accountEnv();
    const s = await signIn(env, { email: 'me@example.test' });
    const res = await callApi(env, 'GET', '/api/me', { jar: s.jar });
    expect(res.status).toBe(200);
    expect(res.json.account).toEqual({ id: s.account.id, displayName: null, emailMasked: 'me***@example.test', strict: false, createdAt: s.account.createdAt });
    expect(res.json.keys).toEqual([]);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('a made up, truncated or foreign cookie is 401 and gets cleared', async () => {
    const { env } = accountEnv();
    for (const value of ['x', 'A'.repeat(43), 'A'.repeat(44), '../../etc', 'A'.repeat(42) + ';']) {
      const res = await callApi(env, 'GET', '/api/me', { headers: { Cookie: `hrd_session=${value}` } });
      expect(res.status).toBe(401);
    }
    const real = await callApi(env, 'GET', '/api/me', { headers: { Cookie: 'hrd_session=' + 'A'.repeat(43) } });
    expect(real.headers.get('set-cookie')).toMatch(/^hrd_session=; .*Max-Age=0/);
  });

  it('logout deletes the session and clears the cookie, and works twice', async () => {
    const { env, db } = accountEnv();
    const s = await signIn(env, { email: 'out@example.test' });
    const old = s.jar.header();
    const out = await callApi(env, 'POST', '/api/auth/logout', { jar: s.jar });
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ ok: true });
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
    // the old cookie no longer works
    const res = await callApi(env, 'GET', '/api/me', { headers: { Cookie: old } });
    expect(res.status).toBe(401);
    expect((await callApi(env, 'POST', '/api/auth/logout', { jar: new Jar() })).status).toBe(200);
  });

  it('logout only ends its own session', async () => {
    const { env } = accountEnv();
    const a = await signIn(env, { email: 'dev@example.test' });
    const b = await signIn(env, { email: 'dev@example.test' });
    await callApi(env, 'POST', '/api/auth/logout', { jar: a.jar });
    expect((await callApi(env, 'GET', '/api/me', { jar: b.jar })).status).toBe(200);
  });

  it('a session ends after 30 days (test clock) and the row is removed', async () => {
    const { env, db } = accountEnv();
    const t0 = Date.now();
    const req = await post(env, '/api/auth/request', { email: 'exp@example.test' }, { ip: loopbackIp() });
    const jar = new Jar();
    await post(env, '/api/auth/verify', { email: 'exp@example.test', code: req.json.debugCode }, { ip: loopbackIp(), jar });
    const day = 24 * 3600 * 1000;
    expect((await callApi(env, 'GET', '/api/me', { jar: copyJar(jar), headers: { 'x-hrd-test-now': String(t0 + 29 * day) } })).status).toBe(200);
    // the check above pushed that session forward, so use a session of its own for the late check
    db.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ?').run(t0 + 30 * day, t0);
    const gone = await callApi(env, 'GET', '/api/me', { jar: copyJar(jar), headers: { 'x-hrd-test-now': String(t0 + 31 * day) } });
    expect(gone.status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
  });

  it('use pushes the expiry forward at most once an hour and renews the cookie', async () => {
    const { env, db } = accountEnv();
    const t0 = Date.now();
    const s = await signIn(env, { email: 'ext@example.test' });
    const before = db.prepare('SELECT expires_at FROM sessions').get().expires_at;
    const soon = await callApi(env, 'GET', '/api/me', { jar: s.jar, headers: { 'x-hrd-test-now': String(t0 + 10 * 60_000) } });
    expect(soon.headers.get('set-cookie')).toBeNull();
    expect(db.prepare('SELECT expires_at FROM sessions').get().expires_at).toBe(before);
    const later = await callApi(env, 'GET', '/api/me', { jar: s.jar, headers: { 'x-hrd-test-now': String(t0 + 2 * 3600_000) } });
    expect(later.headers.get('set-cookie')).toMatch(/^hrd_session=.*Max-Age=2592000/);
    expect(db.prepare('SELECT expires_at FROM sessions').get().expires_at).toBe(t0 + 2 * 3600_000 + 30 * 24 * 3600_000);
  });

  it('the test clock header is ignored when echo mail is not honoured', async () => {
    const { env, db } = accountEnv({ env: { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', MAIL_FROM: 'a@example.test' } });
    db.prepare("INSERT INTO accounts (id, email_hash, email_masked, strict, created_at, last_login_at) VALUES ('acc1', 'h', 'x***@y.zz', 0, 1, 1)").run();
    const token = 'A'.repeat(43);
    db.prepare("INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?, 'acc1', 1, ?, ?)").run(
      await sha256Hex(token),
      Date.now() - 1000,
      Date.now() - 5000
    );
    // an expired session can not be revived by a header that claims an earlier time
    const res = await callApi(env, 'GET', '/api/me', { base: 'https://hrdlock.example', ip: '203.0.113.5', headers: { 'x-hrd-test-now': '1', Cookie: '__Host-hrd_session=' + token } });
    expect(res.status).toBe(401);
    // the same header does work when echo is honoured (local development), to show it is the guard that matters
    const ok = accountEnv();
    ok.db.prepare("INSERT INTO accounts (id, email_hash, email_masked, strict, created_at, last_login_at) VALUES ('acc1', 'h', 'x***@y.zz', 0, 1, 1)").run();
    ok.db.prepare("INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?, 'acc1', 1, ?, ?)").run(await sha256Hex(token), Date.now() - 1000, 1);
    const local = await callApi(ok.env, 'GET', '/api/me', { headers: { 'x-hrd-test-now': '2', Cookie: 'hrd_session=' + token } });
    expect(local.status).toBe(200);
  });

  it('on https the cookie is __Host-hrd_session with Secure, HttpOnly, SameSite=Lax, Path=/', async () => {
    const { env } = accountEnv({ env: { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', MAIL_FROM: 'a@example.test' } });
    // no echo on https, so make the code ourselves by writing the hash with the real helper
    const { atRest } = await import('../../functions/_lib/atRest.js');
    const ar = await atRest(env);
    const emailHash = await ar.emailHash('https@example.test');
    await env.DB.prepare('INSERT INTO otp_codes (email_hash, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)')
      .bind(emailHash, await ar.codeHash(emailHash, '424242'), Date.now() + 600000, Date.now())
      .run();
    const res = await post(env, '/api/auth/verify', { email: 'https@example.test', code: '424242' }, { base: 'https://hrdlock.example', ip: '203.0.113.7' });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toMatch(/^__Host-hrd_session=[A-Za-z0-9_-]{43}; /);
    for (const part of ['Path=/', 'Max-Age=2592000', 'HttpOnly', 'SameSite=Lax', 'Secure']) expect(cookie).toContain(part);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('on plain http to a local host the cookie is hrd_session without Secure', async () => {
    const { env } = accountEnv();
    const s = await signIn(env, { email: 'plain@example.test' });
    expect(s.jar.last[0]).toMatch(/^hrd_session=/);
    expect(s.jar.last[0]).not.toMatch(/Secure/);
    expect(s.jar.last[0]).toMatch(/HttpOnly/);
    expect(s.jar.last[0]).toMatch(/SameSite=Lax/);
  });

  it('on plain http to a real host sign in is refused before the code is used up', async () => {
    const { env, db } = accountEnv();
    const ip = loopbackIp();
    const req = await post(env, '/api/auth/request', { email: 'insecure@example.test' }, { ip });
    const res = await post(env, '/api/auth/verify', { email: 'insecure@example.test', code: req.json.debugCode }, { base: 'http://hrdlock.example', ip });
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM otp_codes').get().n).toBe(1);
  });

  it('only the cookie name that fits the connection counts', async () => {
    const { env } = accountEnv();
    const s = await signIn(env, { email: 'names@example.test' });
    const token = s.jar.get('hrd_session');
    // a plain cookie sent over https is not a session
    const https = await callApi(env, 'GET', '/api/me', { base: 'https://hrdlock.example', headers: { Cookie: 'hrd_session=' + token } });
    expect(https.status).toBe(401);
    // the Secure name sent over plain http is not a session either
    const http = await callApi(env, 'GET', '/api/me', { headers: { Cookie: '__Host-hrd_session=' + token } });
    expect(http.status).toBe(401);
  });
});

function copyJar(jar) {
  const c = new Jar();
  for (const [k, v] of jar.cookies) c.cookies.set(k, v);
  return c;
}

describe('same origin rule for writes', () => {
  it('a cookie authenticated POST, PUT and DELETE without a matching Origin is 403 forbidden', async () => {
    const { env } = accountEnv();
    const s = await signIn(env, { email: 'csrf@example.test' });
    const docId = 'a'.repeat(32);
    const cases = [
      ['POST', '/api/me/key', { record: {}, signature: 'x' }],
      ['POST', '/api/me/strict', { enabled: true }],
      ['PUT', `/api/me/secrets/${docId}`, { password: 'abc' }],
      ['DELETE', '/api/me', undefined],
      ['POST', '/api/auth/logout', {}]
    ];
    for (const [method, path, json] of cases) {
      for (const origin of [null, 'https://evil.test', 'null', 'http://localhost:1', 'http://localhost.evil.test']) {
        const res = await callApi(env, method, path, { jar: s.jar, json, origin });
        expect(res.status, `${method} ${path} ${origin}`).toBe(403);
        expect(res.json.code).toBe('forbidden');
      }
    }
    // the account is untouched
    expect((await callApi(env, 'GET', '/api/me', { jar: s.jar })).status).toBe(200);
  });

  it('reads need no Origin', async () => {
    const { env } = accountEnv();
    const s = await signIn(env, { email: 'reads@example.test' });
    for (const path of ['/api/me', '/api/me/documents']) {
      expect((await callApi(env, 'GET', path, { jar: s.jar })).status).toBe(200);
    }
  });
});

describe('DELETE /api/me', () => {
  it('removes the account, sessions, codes, keys and secrets, and clears the cookie', async () => {
    const { env, db } = accountEnv();
    const s = await signIn(env, { email: 'bye@example.test' });
    await callApi(env, 'POST', '/api/me/key', { jar: s.jar, json: { record: undefined } });
    const res = await callApi(env, 'DELETE', '/api/me', { jar: s.jar });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    for (const t of ['accounts', 'sessions', 'account_keys', 'account_secrets']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, t).toBe(0);
    }
    expect((await callApi(env, 'GET', '/api/me', { headers: { Cookie: 'hrd_session=' + 'A'.repeat(43) } })).status).toBe(401);
    // signing in again makes a new account
    const again = await signIn(env, { email: 'bye@example.test' });
    expect(again.isNew).toBe(true);
    expect(again.account.id).not.toBe(s.account.id);
  });

  it('does not touch another account', async () => {
    const { env, db } = accountEnv();
    const a = await signIn(env, { email: 'keep@example.test' });
    const b = await signIn(env, { email: 'drop@example.test' });
    await callApi(env, 'DELETE', '/api/me', { jar: b.jar });
    expect((await callApi(env, 'GET', '/api/me', { jar: a.jar })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n).toBe(1);
  });
});

describe('responses', () => {
  it('carry the security headers and no CORS headers, also on errors', async () => {
    const { env } = accountEnv();
    const ok = await post(env, '/api/auth/request', { email: 'hdr@example.test' }, { ip: loopbackIp() });
    const bad = await post(env, '/api/auth/request', { email: 'x' });
    const unauth = await callApi(env, 'GET', '/api/me');
    for (const r of [ok, bad, unauth]) {
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('wrong methods are 405', async () => {
    const { env } = accountEnv();
    expect((await callApi(env, 'GET', '/api/auth/request')).status).toBe(405);
    expect((await callApi(env, 'GET', '/api/auth/verify')).status).toBe(405);
    expect((await callApi(env, 'PUT', '/api/me')).status).toBe(405);
    expect((await callApi(env, 'GET', '/api/me/strict')).status).toBe(405);
  });
});

describe('every account endpoint without a master key', () => {
  it('answers 503 accounts_unavailable (also with a cookie and with a bad body)', async () => {
    const { env } = accountEnv({ env: { ACCOUNT_MASTER_KEY: undefined } });
    const docId = 'a'.repeat(32);
    const jar = new Jar();
    jar.cookies.set('hrd_session', 'A'.repeat(43));
    const calls = [
      ['POST', '/api/auth/request', { email: 'a@example.test' }],
      ['POST', '/api/auth/verify', { email: 'a@example.test', code: '123456' }],
      ['POST', '/api/auth/logout', {}],
      ['GET', '/api/me', undefined],
      ['DELETE', '/api/me', undefined],
      ['GET', '/api/me/key', undefined],
      ['POST', '/api/me/key', { record: {}, signature: 'x' }],
      ['GET', '/api/me/documents', undefined],
      ['POST', '/api/me/strict', { enabled: true }],
      ['GET', `/api/me/secrets/${docId}`, undefined],
      ['PUT', `/api/me/secrets/${docId}`, { password: 'ABCD' }]
    ];
    for (const [method, path, json] of calls) {
      const res = await callApi(env, method, path, { json, jar });
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(res.json.code).toBe('accounts_unavailable');
    }
  });

  it('the open endpoints keep working without accounts', async () => {
    const { env } = accountEnv({ env: { ACCOUNT_MASTER_KEY: undefined } });
    expect((await callApi(env, 'GET', '/api/health')).status).toBe(200);
    expect((await callApi(env, 'GET', '/api/documents')).status).toBe(200);
    expect((await callApi(env, 'GET', '/api/channels')).status).toBe(200);
  });
});
