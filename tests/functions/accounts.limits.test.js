// Sign in limits, mail failures, sessions that end, and the things that need a fresh sign in.
// Each test pins one finding of the account backend review (the names say which). Everything runs through
// the real routes and middleware (tests/functions/fakes.js), a stubbed mail provider and a test clock.
import { afterEach, describe, expect, it } from 'vitest';
import { sendMail } from '../../functions/_lib/mail.js';
import { parseMasterKey } from '../../functions/_lib/atRest.js';
import { Jar, accountEnv, callApi, loopbackIp, makeKey, randomDocId, seedDocument, signIn } from './fakes.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const post = (env, path, json, o = {}) => callApi(env, 'POST', path, { json, ...o });
const RESEND = { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key', MAIL_FROM: 'hrdlock <login@mail.example.test>' };
const SITE = 'https://hrdlock.example';

let nextIp = 0;
const publicIp = () => `198.51.${(nextIp >> 8) & 255}.${(nextIp++ & 255) + 1}`;

// A provider env whose mails are recorded (or refused), over https like a real deployment.
function providerSite(extraEnv = {}) {
  const ctx = accountEnv({ env: { ...RESEND, ...extraEnv } });
  const sent = [];
  const state = { answer: () => new Response('{"id":"1"}', { status: 200 }) };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), to: Array.isArray(body.to) ? body.to[0] : body.to, init });
    return state.answer(body);
  };
  restore.push(() => (globalThis.fetch = real));
  const ask = (email, ip = publicIp(), headers) => callApi(ctx.env, 'POST', '/api/auth/request', { base: SITE, ip, json: { email }, headers });
  return { ...ctx, sent, state, ask };
}
const restore = [];
afterEach(() => {
  while (restore.length) restore.pop()();
});

const count = (db, bucket) => {
  const rows = db.prepare('SELECT count FROM rate_limits WHERE bucket = ?').all(bucket);
  return rows.reduce((n, r) => n + r.count, 0);
};
const like = (db, pattern) => db.prepare('SELECT bucket, count FROM rate_limits WHERE bucket LIKE ? ORDER BY bucket').all(pattern);

describe('sign in codes: what counts against the limits', () => {
  it('requests refused for the 30 second wait use up nothing of the service or the inbox', async () => {
    const { env, db } = accountEnv();
    const t0 = 2_300_000_000_000;
    const at = (t) => ({ ip: loopbackIp(), headers: { 'x-hrd-test-now': String(t) } });
    expect((await post(env, '/api/auth/request', { email: 'dup@example.test' }, at(t0))).status).toBe(200);
    for (let i = 0; i < 60; i++) {
      const res = await post(env, '/api/auth/request', { email: 'dup@example.test' }, at(t0 + 1000));
      expect(res.status).toBe(429);
      expect(res.json.error).toMatch(/moment ago/);
    }
    expect(db.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE bucket LIKE 'code-all:%'").get().n).toBe(1);
    expect(db.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE bucket LIKE 'code-day:%'").get().n).toBe(1);
    expect(db.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE bucket LIKE 'code-mail:%'").get().n).toBe(1);
    // and a new person is still served
    expect((await post(env, '/api/auth/request', { email: 'legit@example.test' }, at(t0 + 2000))).status).toBe(200);
  });

  it('the plus part and gmail dots do not make a new inbox (5 mails an hour per inbox)', async () => {
    const { ask, sent } = providerSite();
    for (let i = 0; i < 12; i++) await ask(`victim+${i}@example.test`);
    expect(sent.filter((m) => m.to.startsWith('victim+')).length).toBe(5);
    for (let i = 1; i < 10; i++) await ask(`${'victimname'.slice(0, i)}.${'victimname'.slice(i)}@gmail.com`);
    await ask('victim.name+x@googlemail.com');
    expect(sent.filter((m) => /@(gmail|googlemail)\.com$/.test(m.to)).length).toBe(5);
    // another inbox is not held back, and the same name on another domain is another inbox
    expect((await ask('victim@other.example')).status).toBe(200);
    expect((await ask('victimname@example.test')).status).toBe(200);
  });

  it('many sources, one inbox: 25 sources with 20 alias spellings each reach the inbox 5 times', async () => {
    const { ask, sent } = providerSite();
    for (let s = 0; s < 25; s++) {
      const ip = `2001:db8:${(s + 1).toString(16)}::7`;
      for (let i = 0; i < 20; i++) await ask(`victim+${s}x${i}@gmail.com`, ip);
    }
    expect(sent.filter((m) => m.to.startsWith('victim+')).length).toBe(5);
  });

  it('one IPv6 /48 network is held to 60 requests an hour, whatever the /64 blocks and the addresses', async () => {
    const { ask, sent } = providerSite();
    let ok = 0;
    for (let i = 0; i < 80; i++) {
      const res = await ask(`net${i}@example.test`, `2001:db8:77:${(i + 1).toString(16)}::5`);
      if (res.status === 200) ok++;
    }
    // the first two sends of a source are always allowed, the rest of the network is cut at 60 requests
    expect(ok).toBe(60);
    expect(sent.length).toBe(60);
    // another /48 is not affected
    expect((await ask('elsewhere@example.test', '2001:db8:78::1')).status).toBe(200);
  });

  it('parallel requests for one address send one mail and keep one use of the inbox', async () => {
    const { ask, sent, db } = providerSite();
    const out = await Promise.all(Array.from({ length: 20 }, () => ask('parallel@example.test')));
    expect(out.filter((r) => r.status === 200).length).toBe(1);
    expect(sent.length).toBe(1);
    expect(db.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE bucket LIKE 'code-mail:%'").get().n).toBe(1);
    expect(db.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE bucket LIKE 'code-all:%'").get().n).toBe(1);
  });

  it('the service ceiling keeps a share for sources that have sent little (a few sources can not close sign in)', async () => {
    const { ask, sent } = providerSite({ MAIL_CAP_HOUR: '20' });
    // three heavy sources send 5 each: 15 of 20 is the open part (75 percent)
    const heavy = [publicIp(), publicIp(), publicIp()];
    for (const ip of heavy) for (let i = 0; i < 5; i++) expect((await ask(`h${ip}-${i}@example.test`, ip)).status).toBe(200);
    expect(sent.length).toBe(15);
    // a heavy source is refused now, the service is not shut: a fresh source still gets its codes
    expect((await ask('more@example.test', heavy[0])).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await ask(`fresh${i}@example.test`)).status).toBe(200);
    expect(sent.length).toBe(20);
    // the whole ceiling is a ceiling for everybody
    const last = await ask('last@example.test');
    expect(last.status).toBe(429);
    expect(last.json.code).toBe('rate_limited');
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('a source that sent more than two codes this hour only counts against the open part', async () => {
    const { ask, db } = providerSite({ MAIL_CAP_HOUR: '8' });
    const ip = publicIp();
    // open part is 6: this source sends 6, the seventh is refused although the ceiling is 8
    for (let i = 0; i < 6; i++) expect((await ask(`own${i}@example.test`, ip)).status).toBe(200);
    expect((await ask('own6@example.test', ip)).status).toBe(429);
    expect(db.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE bucket LIKE 'code-all:%'").get().n).toBe(6);
  });

  it('the day ceiling is set from MAIL_CAP_DAY and its refused requests are given back', async () => {
    const { ask, sent, db } = providerSite({ MAIL_CAP_DAY: '4' });
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await ask(`d${i}@example.test`, publicIp())).status);
    expect(results).toEqual([200, 200, 200, 200]);
    const refused = await ask('d5@example.test', publicIp());
    expect(refused.status).toBe(429);
    expect(sent.length).toBe(4);
    expect(db.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE bucket LIKE 'code-day:%'").get().n).toBe(4);
    expect(db.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE bucket LIKE 'code-mail:%'").get().n).toBe(4);
  });

  it('a nonsense MAIL_CAP value falls back to the built in ceilings', async () => {
    const { ask } = providerSite({ MAIL_CAP_HOUR: 'lots', MAIL_CAP_DAY: '-3' });
    expect((await ask('fine@example.test')).status).toBe(200);
  });
});

describe('sign in codes: a mail the provider refused costs nothing', () => {
  it('five provider failures in a row, then the provider is back: the person still gets a code', async () => {
    const { ask, state, sent, db } = providerSite();
    state.answer = () => new Response('upstream says the key re_test_key is over quota for bob@example.test', { status: 500 });
    const seen = [];
    for (let i = 0; i < 5; i++) seen.push((await ask('bob@example.test', '203.0.113.5')).status);
    expect(seen).toEqual([502, 502, 502, 502, 502]);
    state.answer = () => new Response('{"id":"1"}', { status: 200 });
    const after = await ask('bob@example.test', '203.0.113.6');
    expect(after.status).toBe(200);
    expect(sent.length).toBe(6);
    // the failed tries gave their counts back: one use of the inbox, the service and the day, one send
    expect(count(db, like(db, 'code-mail:%')[0].bucket)).toBe(1);
    expect(db.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE bucket LIKE 'code-all:%'").get().n).toBe(1);
    expect(db.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE bucket LIKE 'code-day:%'").get().n).toBe(1);
    expect(db.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE bucket LIKE 'code-sent:%'").get().n).toBe(1);
  });

  it('refused sends do not use up the service ceiling of other people', async () => {
    const { ask, state } = providerSite({ MAIL_CAP_HOUR: '10', MAIL_CAP_DAY: '10' });
    state.answer = () => new Response('', { status: 503 });
    for (let i = 0; i < 40; i++) await ask(`p${i}@example.test`, publicIp());
    state.answer = () => new Response('{"id":"1"}', { status: 200 });
    expect((await ask('someone-else@example.test', publicIp())).status).toBe(200);
  });

  it('a provider that does not accept the address (HTTP 400 or 422) gets a plain message about the address', async () => {
    const { ask, state } = providerSite();
    const logged = [];
    const realError = console.error;
    console.error = (...a) => logged.push(a.join(' '));
    try {
      for (const status of [400, 422]) {
        state.answer = () => new Response('{"message":"upstream: leak@example.test is not a valid recipient, key re_test_key"}', { status });
        const res = await ask(`typo${status}@example.test`);
        expect(res.status).toBe(502);
        expect(res.json.code).toBe('mail_failed');
        expect(res.json.error).toMatch(/address/);
        expect(res.json.error).not.toMatch(/moment/);
        expect(res.text + logged.join('\n')).not.toMatch(/upstream|leak@example|re_test_key|typo/);
      }
      state.answer = () => new Response('', { status: 500 });
      const res = await ask('later@example.test');
      expect(res.json.error).toMatch(/try again in a moment/);
    } finally {
      console.error = realError;
    }
  });

  it('the code of a mail that was not sent is not left valid', async () => {
    const { ask, state, db } = providerSite();
    state.answer = () => new Response('nope', { status: 500 });
    expect((await ask('dead@example.test')).status).toBe(502);
    expect(db.prepare('SELECT COUNT(*) AS n FROM otp_codes').get().n).toBe(0);
  });
});

describe('mail provider requests', () => {
  const MSG = { to: 'person@example.test', subject: 's', text: 't', html: '<p>h</p>' };
  const CF = { MAIL_PROVIDER: 'cloudflare', CF_ACCOUNT_ID: 'a'.repeat(32), CF_EMAIL_TOKEN: 'cf-token-1', MAIL_FROM: 'login@example.test' };

  it('refuses redirects, so a provider key header never follows a redirect to another host', async () => {
    const seen = [];
    await sendMail({ MAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k', MAIL_FROM: 'a@example.test' }, MSG, {
      fetchImpl: async (url, init) => (seen.push(init), new Response('{}', { status: 200 }))
    });
    expect(seen[0].redirect).toBe('error');
  });

  it('a body that never ends does not hold the request past the timeout (success answer of the Cloudflare provider)', async () => {
    const started = Date.now();
    await expect(
      sendMail(CF, MSG, { fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }) })
    ).rejects.toMatchObject({ code: 'mail_failed' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(9000);
    expect(Date.now() - started).toBeLessThan(12000);
  }, 20000);

  it('an error answer with a body that never ends is given up at once, without reading it', async () => {
    const started = Date.now();
    await expect(
      sendMail(RESEND, MSG, { fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 500 }) })
    ).rejects.toMatchObject({ code: 'mail_failed' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a success answer of Resend or Brevo is given up without being read', async () => {
    let cancelled = false;
    const answer = { ok: true, status: 200, body: { cancel: () => ((cancelled = true), Promise.resolve()) }, text: () => Promise.reject(new Error('read')), json: () => Promise.reject(new Error('read')) };
    await sendMail(RESEND, MSG, { fetchImpl: async () => answer });
    expect(cancelled).toBe(true);
  });
});

describe('sessions: the end of a session, and ending the others', () => {
  const at = (t) => ({ 'x-hrd-test-now': String(t) });
  const get = (env, jar, t, path = '/api/me') => callApi(env, 'GET', path, { jar, headers: at(t) });

  it('a session used every day still ends 90 days after it was made, and the cookie shortens near the end', async () => {
    const { env } = accountEnv();
    const t0 = Date.now();
    const s = await signIn(env, { email: 'forever@example.test' });
    // sign in at the real time, then use the session once a day on the test clock
    let alive = 0;
    let lastCookie = '';
    for (let day = 1; day <= 120; day++) {
      const res = await get(env, s.jar, t0 + day * DAY);
      if (res.status !== 200) break;
      alive = day;
      const c = res.headers.get('set-cookie');
      if (c) lastCookie = c;
    }
    expect(alive).toBeGreaterThanOrEqual(89);
    expect(alive).toBeLessThanOrEqual(90);
    expect((await get(env, s.jar, t0 + 90 * DAY + 1000)).status).toBe(401);
    // within the last 30 days the cookie lives only as long as the session
    const max = Number(/Max-Age=(\d+)/.exec(lastCookie)[1]);
    expect(max).toBeLessThanOrEqual(2 * DAY / 1000);
  });

  it('a session unused for 31 days is dead, one used on day 29 lives on (30 days from the last use)', async () => {
    const { env } = accountEnv();
    const t0 = Date.now();
    const a = await signIn(env, { email: 'idle1@example.test' });
    const b = await signIn(env, { email: 'idle2@example.test' });
    expect((await get(env, a.jar, t0 + 29 * DAY)).status).toBe(200);
    expect((await get(env, a.jar, t0 + 58 * DAY)).status).toBe(200);
    expect((await get(env, b.jar, t0 + 31 * DAY)).status).toBe(401);
  });

  it('logout with all:true ends every session of the account, this one too, and nobody else', async () => {
    const { env } = accountEnv();
    const owner = await signIn(env, { email: 'many@example.test' });
    const phone = await signIn(env, { email: 'many@example.test' });
    const other = await signIn(env, { email: 'someone-else@example.test' });
    const res = await post(env, '/api/auth/logout', { all: true }, { jar: owner.jar });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, ended: 2 });
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await callApi(env, 'GET', '/api/me', { jar: phone.jar })).status).toBe(401);
    expect((await callApi(env, 'GET', '/api/me', { jar: other.jar })).status).toBe(200);
    // without a session, all:true is a 401 and not a silent success
    expect((await post(env, '/api/auth/logout', { all: true })).status).toBe(401);
    // a plain logout still works with no body, with an empty object, and with junk
    for (const [n, body] of [undefined, {}, { all: false }, { all: 'yes' }].entries()) {
      const s = await signIn(env, { email: `plain${n}@example.test` });
      const other2 = await signIn(env, { email: `plain${n}@example.test` });
      expect((await callApi(env, 'POST', '/api/auth/logout', { jar: s.jar, json: body })).status).toBe(200);
      expect((await callApi(env, 'GET', '/api/me', { jar: other2.jar })).status).toBe(200);
    }
  });

  it('GET /api/me/sessions lists the devices, DELETE ends the others or one of them', async () => {
    const { env } = accountEnv();
    const a = await signIn(env, { email: 'list@example.test' });
    const b = await signIn(env, { email: 'list@example.test' });
    const c = await signIn(env, { email: 'list@example.test' });
    const stranger = await signIn(env, { email: 'stranger@example.test' });
    const list = await callApi(env, 'GET', '/api/me/sessions', { jar: b.jar });
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toMatch(/no-store/);
    expect(list.json.sessions.length).toBe(3);
    expect(list.json.sessions.filter((s) => s.current).length).toBe(1);
    for (const s of list.json.sessions) {
      expect(s.id).toMatch(/^[0-9a-f]{16}$/);
      expect(Object.keys(s).sort()).toEqual(['createdAt', 'current', 'expiresAt', 'id', 'lastSeenAt']);
    }
    expect(JSON.stringify(list.json)).not.toContain(b.jar.get('hrd_session'));
    // ending one by its id
    const mine = list.json.sessions.find((s) => s.current);
    const others = list.json.sessions.filter((s) => !s.current);
    expect((await callApi(env, 'DELETE', `/api/me/sessions/${others[0].id}`, { jar: b.jar })).status).toBe(200);
    expect((await callApi(env, 'GET', '/api/me/sessions', { jar: b.jar })).json.sessions.length).toBe(2);
    // an id that is not a session of this account is a 404, a malformed one a 400
    const theirs = (await callApi(env, 'GET', '/api/me/sessions', { jar: stranger.jar })).json.sessions[0].id;
    expect((await callApi(env, 'DELETE', `/api/me/sessions/${theirs}`, { jar: b.jar })).status).toBe(404);
    expect((await callApi(env, 'GET', '/api/me', { jar: stranger.jar })).status).toBe(200);
    expect((await callApi(env, 'DELETE', '/api/me/sessions/not-an-id', { jar: b.jar })).status).toBe(400);
    // ending all the others keeps this one
    const ended = await callApi(env, 'DELETE', '/api/me/sessions', { jar: b.jar });
    expect(ended.json).toEqual({ ok: true, ended: 1 });
    expect((await callApi(env, 'GET', '/api/me', { jar: b.jar })).status).toBe(200);
    expect((await callApi(env, 'GET', '/api/me', { jar: a.jar })).status).toBe(401);
    expect((await callApi(env, 'GET', '/api/me', { jar: c.jar })).status).toBe(401);
    // ending the current one clears the cookie
    const self = await callApi(env, 'DELETE', `/api/me/sessions/${mine.id}`, { jar: b.jar });
    expect(self.status).toBe(200);
    expect(self.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await callApi(env, 'GET', '/api/me', { jar: b.jar })).status).toBe(401);
  });

  it('the session routes need a session, the same origin for writes, and say no to other methods', async () => {
    const { env } = accountEnv();
    const s = await signIn(env, { email: 'routes@example.test' });
    expect((await callApi(env, 'GET', '/api/me/sessions')).status).toBe(401);
    expect((await callApi(env, 'DELETE', '/api/me/sessions')).status).toBe(401);
    expect((await callApi(env, 'DELETE', '/api/me/sessions', { jar: s.jar, origin: 'https://evil.test' })).status).toBe(403);
    expect((await callApi(env, 'DELETE', `/api/me/sessions/${'a'.repeat(16)}`, { jar: s.jar, origin: null })).status).toBe(403);
    expect((await callApi(env, 'POST', '/api/me/sessions', { jar: s.jar, json: {} })).status).toBe(405);
    expect((await callApi(env, 'GET', `/api/me/sessions/${'a'.repeat(16)}`, { jar: s.jar })).status).toBe(405);
  });
});

describe('the things that can not be undone need a session made in the last 15 minutes', () => {
  const at = (t) => ({ 'x-hrd-test-now': String(t) });

  async function withKey(email) {
    const ctx = accountEnv();
    const s = await signIn(ctx.env, { email });
    const k = await makeKey('Fresh');
    const res = await callApi(ctx.env, 'POST', '/api/me/key', { jar: s.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } });
    expect(res.status).toBe(201);
    return { ...ctx, s, k };
  }

  it('an old session can not read the stored key, switch to Strict, or delete the account (401 reauth_required)', async () => {
    const { env, db, s, k } = await withKey('old@example.test');
    const later = Date.now() + 20 * DAY;
    const key = await callApi(env, 'GET', '/api/me/key', { jar: s.jar, headers: at(later) });
    expect(key.status).toBe(401);
    expect(key.json.code).toBe('reauth_required');
    expect(key.text).not.toContain(k.privateJwk.d);
    expect(key.headers.get('set-cookie')).toBeNull(); // the session is kept, nothing is signed out
    const strict = await callApi(env, 'POST', '/api/me/strict', { jar: s.jar, json: { enabled: true }, headers: at(later) });
    expect(strict.status).toBe(401);
    expect(strict.json.code).toBe('reauth_required');
    const del = await callApi(env, 'DELETE', '/api/me', { jar: s.jar, headers: at(later) });
    expect(del.status).toBe(401);
    expect(del.json.code).toBe('reauth_required');
    // nothing changed
    expect(db.prepare('SELECT strict FROM accounts').get().strict).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_keys WHERE wrapped_private IS NOT NULL').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n).toBe(1);
    // the old session still works for ordinary reads
    expect((await callApi(env, 'GET', '/api/me', { jar: s.jar, headers: at(later) })).status).toBe(200);
  });

  it('the limit is 15 minutes from the day the session was made, and using the session does not renew it', async () => {
    const { env, s } = await withKey('edge@example.test');
    const t0 = Date.now();
    const ok = await callApi(env, 'GET', '/api/me/key', { jar: s.jar, headers: at(t0 + 14 * 60_000) });
    expect(ok.status).toBe(200);
    // a use at minute 14 extends the idle time of the session (not its age)
    const late = await callApi(env, 'GET', '/api/me/key', { jar: s.jar, headers: at(t0 + 16 * 60_000) });
    expect(late.status).toBe(401);
    expect(late.json.code).toBe('reauth_required');
  });

  it('signing in again with a new code, with the old cookie, replaces the old session by a fresh one', async () => {
    const { env, db, s } = await withKey('again@example.test');
    const later = Date.now() + 20 * DAY;
    expect((await callApi(env, 'GET', '/api/me/key', { jar: s.jar, headers: at(later) })).status).toBe(401);
    const asked = await callApi(env, 'POST', '/api/auth/request', { json: { email: 'again@example.test' }, ip: loopbackIp(), headers: at(later) });
    expect(asked.status).toBe(200);
    const before = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    const verified = await callApi(env, 'POST', '/api/auth/verify', {
      jar: s.jar,
      json: { email: 'again@example.test', code: asked.json.debugCode },
      ip: loopbackIp(),
      headers: at(later + 1000)
    });
    expect(verified.status).toBe(200);
    expect(verified.json.isNew).toBe(false);
    // the old session was replaced, not added to
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(before);
    const fresh = await callApi(env, 'GET', '/api/me/key', { jar: s.jar, headers: at(later + 2000) });
    expect(fresh.status).toBe(200);
    expect(fresh.json.privateJwk.d).toBeTruthy();
  });

  it('signing in for another account does not end the session of the cookie that came along', async () => {
    const { env } = accountEnv();
    const first = await signIn(env, { email: 'one@example.test' });
    const asked = await callApi(env, 'POST', '/api/auth/request', { json: { email: 'two@example.test' }, ip: loopbackIp() });
    const verified = await callApi(env, 'POST', '/api/auth/verify', { jar: new Jar(), json: { email: 'two@example.test', code: asked.json.debugCode }, headers: { Cookie: first.jar.header() }, ip: loopbackIp() });
    expect(verified.status).toBe(200);
    expect((await callApi(env, 'GET', '/api/me', { jar: first.jar })).json.account.id).toBe(first.account.id);
  });

  it('a fresh session can do all three, the stored key is not logged and the cache is off', async () => {
    const { env, db, s, k } = await withKey('now@example.test');
    const key = await callApi(env, 'GET', '/api/me/key', { jar: s.jar });
    expect(key.status).toBe(200);
    expect(key.headers.get('cache-control')).toMatch(/no-store/);
    expect(key.json.privateJwk.d).toBe(k.privateJwk.d);
    expect((await callApi(env, 'POST', '/api/me/strict', { jar: s.jar, json: { enabled: true } })).status).toBe(200);
    expect((await callApi(env, 'DELETE', '/api/me', { jar: s.jar })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n).toBe(0);
  });

  it('turning Strict off needs one too (a stolen old session must not decide who holds the keys)', async () => {
    const { env, s } = await withKey('off@example.test');
    expect((await callApi(env, 'POST', '/api/me/strict', { jar: s.jar, json: { enabled: true } })).status).toBe(200);
    const later = Date.now() + 20 * DAY;
    const res = await callApi(env, 'POST', '/api/me/strict', { jar: s.jar, json: { enabled: false }, headers: at(later) });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('reauth_required');
    expect((await callApi(env, 'GET', '/api/me', { jar: s.jar, headers: at(later) })).json.account.strict).toBe(true);
  });
});

describe('POST /api/me/key with a key that is already linked or registered', () => {
  async function setup() {
    const ctx = accountEnv();
    const s = await signIn(ctx.env);
    return { ...ctx, s, jar: s.jar };
  }
  const link = (env, jar, k, extra = {}) => callApi(env, 'POST', '/api/me/key', { jar, json: { record: k.record, signature: k.signature, ...extra } });

  it('the same key sent again WITH its private key is stored when it has no server copy, never an empty ok', async () => {
    const { env, db, jar } = await setup();
    const k = await makeKey('No Copy Yet');
    expect((await link(env, jar, k)).status).toBe(201);
    expect(db.prepare('SELECT wrapped_private FROM account_keys').get().wrapped_private).toBe(null);
    expect((await callApi(env, 'GET', '/api/me/key', { jar })).status).toBe(404);
    const again = await link(env, jar, k, { privateJwk: k.privateJwk });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ keyId: k.keyId, existed: true, stored: true });
    expect(db.prepare('SELECT wrapped_private FROM account_keys').get().wrapped_private).toMatch(/^[A-Za-z0-9_-]+$/);
    const got = await callApi(env, 'GET', '/api/me/key', { jar });
    expect(got.status).toBe(200);
    expect(got.json.privateJwk.d).toBe(k.privateJwk.d);
    // and once more: it is there, nothing new is stored
    const third = await link(env, jar, k, { privateJwk: k.privateJwk });
    expect(third.json).toEqual({ keyId: k.keyId, existed: true });
  });

  it('a private key that is not the pair of a linked key is a 400, also for a key that already has a copy', async () => {
    const { env, jar } = await setup();
    const k = await makeKey('Pair');
    const other = await makeKey('Other');
    expect((await link(env, jar, k, { privateJwk: k.privateJwk })).status).toBe(201);
    for (const privateJwk of [other.privateJwk, { kty: 'EC', crv: 'P-256', x: k.privateJwk.x, y: k.privateJwk.y, d: 'AAAA' }, { garbage: true }]) {
      const res = await link(env, jar, k, { privateJwk });
      expect(res.status, JSON.stringify(privateJwk).slice(0, 40)).toBe(400);
    }
    const unlinked = await makeKey('Plain');
    expect((await link(env, jar, unlinked)).status).toBe(409); // an Easy account that has a copy takes no second key
  });

  it('a linked key without a copy is refused (409 key_exists) when another key of the account holds the copy', async () => {
    const { env, db, jar, s } = await setup();
    const k1 = await makeKey('First');
    expect((await link(env, jar, k1)).status).toBe(201);
    await callApi(env, 'POST', '/api/me/strict', { jar, json: { enabled: true } });
    await callApi(env, 'POST', '/api/me/strict', { jar, json: { enabled: false } });
    const k2 = await makeKey('Second');
    expect((await link(env, jar, k2, { privateJwk: k2.privateJwk })).status).toBe(201);
    const res = await link(env, jar, k1, { privateJwk: k1.privateJwk });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('key_exists');
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_keys WHERE wrapped_private IS NOT NULL AND account_id = ?').get(s.account.id).n).toBe(1);
  });

  it('a Strict account still refuses a private key', async () => {
    const { env, jar } = await setup();
    const k = await makeKey('Strict');
    expect((await link(env, jar, k)).status).toBe(201);
    await callApi(env, 'POST', '/api/me/strict', { jar, json: { enabled: true } });
    const res = await link(env, jar, k, { privateJwk: k.privateJwk });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('strict_mode');
  });

  it('after the account was deleted, the same key links to a new account when its private key is sent, and not without it', async () => {
    const ctx = accountEnv();
    const one = await signIn(ctx.env, { email: 'relink@example.test' });
    const k = await makeKey('Relink');
    expect((await link(ctx.env, one.jar, k, { privateJwk: k.privateJwk })).status).toBe(201);
    const docId = randomDocId();
    seedDocument(ctx.db, { docId, ownerKeyId: k.keyId });
    expect((await callApi(ctx.env, 'DELETE', '/api/me', { jar: one.jar })).status).toBe(200);
    const two = await signIn(ctx.env, { email: 'relink@example.test' });
    // the public record alone proves nothing
    const bare = await link(ctx.env, two.jar, k);
    expect(bare.status).toBe(409);
    expect(bare.json.code).toBe('exists');
    expect((await callApi(ctx.env, 'GET', '/api/me/documents', { jar: two.jar })).json.documents.length).toBe(0);
    // a private key that is not the pair is refused
    const wrong = await makeKey('Wrong');
    expect((await link(ctx.env, two.jar, k, { privateJwk: wrong.privateJwk })).status).toBe(400);
    // the right private key links it, with a server copy, and the files show up
    const res = await link(ctx.env, two.jar, k, { privateJwk: k.privateJwk });
    expect(res.status).toBe(201);
    expect((await callApi(ctx.env, 'GET', '/api/me/documents', { jar: two.jar })).json.documents.map((d) => d.docId)).toEqual([docId]);
    expect((await callApi(ctx.env, 'GET', '/api/me/key', { jar: two.jar })).json.privateJwk.d).toBe(k.privateJwk.d);
    expect((await callApi(ctx.env, 'GET', '/api/me', { jar: two.jar })).json.account.displayName).toBe('Relink');
  });

  it('a key that belongs to another account can not be linked, whoever holds the private key', async () => {
    const ctx = accountEnv();
    const a = await signIn(ctx.env);
    const b = await signIn(ctx.env);
    const k = await makeKey('Taken');
    expect((await link(ctx.env, a.jar, k, { privateJwk: k.privateJwk })).status).toBe(201);
    const res = await link(ctx.env, b.jar, k, { privateJwk: k.privateJwk });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('exists');
  });

  it('a guest key (registered through the open endpoint, never exported) can not be linked by its public record', async () => {
    const { env, jar } = await setup();
    const k = await makeKey('Guest');
    expect((await callApi(env, 'POST', '/api/identities', { json: { record: k.record, signature: k.signature }, ip: loopbackIp() })).status).toBe(201);
    expect((await link(env, jar, k)).status).toBe(409);
  });
});

describe('deleting the account', () => {
  it('removes every count the limits kept under the hash of the email', async () => {
    const { env, db } = accountEnv();
    const addr = 'gone@example.test';
    const s = await signIn(env, { email: addr });
    const hash = db.prepare('SELECT email_hash FROM accounts').get().email_hash;
    // some wrong tries leave counts under the hash as well
    const asked = await post(env, '/api/auth/request', { email: addr }, { ip: loopbackIp(), headers: { 'x-hrd-test-now': String(Date.now() + 60_000) } });
    await post(env, '/api/auth/verify', { email: addr, code: asked.json.debugCode === '000000' ? '000001' : '000000' }, { ip: loopbackIp(), headers: { 'x-hrd-test-now': String(Date.now() + 61_000) } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE bucket LIKE ?').get('%' + hash + '%').n).toBeGreaterThan(0);
    expect((await callApi(env, 'DELETE', '/api/me', { jar: s.jar })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE bucket LIKE ?').get('%' + hash + '%').n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM otp_codes').get().n).toBe(0);
    // other people's counts stay
    expect(db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE bucket LIKE 'code-ip:%'").get().n).toBeGreaterThan(0);
  });
});

describe('the master key', () => {
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
  it('refuses a placeholder: all zero, all 255, one repeated byte, 43 letters A, a short repeating pattern', () => {
    for (const weak of [b64(new Uint8Array(32)), b64(new Uint8Array(32).fill(255)), b64(new Uint8Array(32).fill(65)), 'A'.repeat(43), b64(Uint8Array.from({ length: 32 }, (_, i) => i % 4))]) {
      expect(parseMasterKey(weak), weak).toBeNull();
    }
  });
  it('accepts a random key, and a key with 16 different byte values is the least that is accepted', () => {
    const random = crypto.getRandomValues(new Uint8Array(32));
    expect(parseMasterKey(b64(random))).not.toBeNull();
    expect(parseMasterKey(b64(Uint8Array.from({ length: 32 }, (_, i) => i % 16)))).not.toBeNull();
    expect(parseMasterKey(b64(Uint8Array.from({ length: 32 }, (_, i) => i % 15)))).toBeNull();
  });
  it('accounts stay off with a placeholder key, and health says so', async () => {
    const { env } = accountEnv({ env: { ACCOUNT_MASTER_KEY: 'A'.repeat(43) } });
    const health = await callApi(env, 'GET', '/api/health');
    expect(health.json.accounts).toBe(false);
    const res = await post(env, '/api/auth/request', { email: 'a@example.test' });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('accounts_unavailable');
  });
});
