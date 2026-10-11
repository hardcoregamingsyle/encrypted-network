// Cookie settings, token reading, the same origin rule, the test clock, and the rate windows.
import { describe, expect, it } from 'vitest';
import { RATES, HOUR, MINUTE, ceilingFrom, consumeRate, forgetRate, refundRate, retryAfterSeconds, windowStart } from '../../functions/_lib/rate.js';
import {
  COOKIE_NAME_PLAIN,
  COOKIE_NAME_SECURE,
  clearCookie,
  cookiePlan,
  hashToken,
  newSessionToken,
  readSessionToken,
  requestNow,
  requireSameOrigin,
  sessionCookie
} from '../../functions/_lib/session.js';
import { accountEnv } from './fakes.js';

const req = (url, headers = {}, method = 'GET') => new Request(url, { method, headers });
const TOKEN = 'A'.repeat(43);

describe('session cookie', () => {
  it('on https: __Host- name, Secure, HttpOnly, SameSite=Lax, Path=/, 30 days, no Domain', () => {
    const c = sessionCookie(req('https://hrdlock.example/api/auth/verify'), TOKEN);
    expect(c).toBe(`__Host-hrd_session=${TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure`);
    expect(c).not.toMatch(/Domain/i);
  });

  it('on http localhost: plain name, no Secure', () => {
    for (const host of ['http://localhost:8800', 'http://127.0.0.1:8800', 'http://[::1]:8800', 'http://dev.localhost:8800']) {
      const c = sessionCookie(req(host + '/x'), TOKEN);
      expect(c, host).toBe(`hrd_session=${TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
    }
  });

  it('on http to any other host there is no cookie at all (403)', () => {
    for (const host of ['http://hrdlock.example', 'http://192.168.1.5:8800', 'http://localhost.evil.test']) {
      expect(() => cookiePlan(req(host + '/x')), host).toThrow(/secure/);
      expect(() => sessionCookie(req(host + '/x'), TOKEN)).toThrow();
    }
  });

  it('clearing uses the same name and attributes with Max-Age=0', () => {
    expect(clearCookie(req('https://hrdlock.example/'))).toBe('__Host-hrd_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
    expect(clearCookie(req('http://localhost/'))).toBe('hrd_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  });

  it('the names are the ones in the spec', () => {
    expect(COOKIE_NAME_SECURE).toBe('__Host-hrd_session');
    expect(COOKIE_NAME_PLAIN).toBe('hrd_session');
  });
});

describe('readSessionToken', () => {
  const https = (cookie) => req('https://hrdlock.example/', { Cookie: cookie });
  const http = (cookie) => req('http://localhost/', { Cookie: cookie });

  it('finds the token among other cookies', () => {
    expect(readSessionToken(https(`a=1; __Host-hrd_session=${TOKEN}; b=2`))).toBe(TOKEN);
    expect(readSessionToken(http(`hrd_session=${TOKEN}`))).toBe(TOKEN);
    expect(readSessionToken(http(`x=1;hrd_session=${TOKEN};y=2`))).toBe(TOKEN);
  });

  it('only reads the name that fits the connection', () => {
    expect(readSessionToken(https(`hrd_session=${TOKEN}`))).toBeNull();
    expect(readSessionToken(http(`__Host-hrd_session=${TOKEN}`))).toBeNull();
  });

  it('ignores look alike names', () => {
    for (const name of ['xhrd_session', 'hrd_session_x', 'HRD_SESSION', 'hrd-session', ' hrd_sessionx']) {
      expect(readSessionToken(http(`${name}=${TOKEN}`)), name).toBeNull();
    }
  });

  it('refuses malformed tokens: wrong length, wrong characters, quotes, empty', () => {
    for (const v of ['', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + '=', 'A'.repeat(42) + '+', '"' + TOKEN + '"', 'A'.repeat(42) + '/', '\u00e9'.repeat(43)]) {
      expect(readSessionToken(http(`hrd_session=${v}`)), JSON.stringify(v)).toBeNull();
    }
  });

  it('takes the first cookie of that name (the browser sends the most specific first)', () => {
    const other = 'B'.repeat(43);
    expect(readSessionToken(http(`hrd_session=${other}; hrd_session=${TOKEN}`))).toBe(other);
  });

  it('is null without a Cookie header or on an insecure real host', () => {
    expect(readSessionToken(req('http://localhost/'))).toBeNull();
    expect(readSessionToken(req('http://hrdlock.example/', { Cookie: `hrd_session=${TOKEN}` }))).toBeNull();
  });
});

describe('tokens', () => {
  it('are 32 random bytes as base64url and only the sha256 is kept', async () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      const t = newSessionToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(100);
    const h = await hashToken(TOKEN);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(await hashToken(TOKEN));
    expect(h).not.toBe(await hashToken('B'.repeat(43)));
  });
});

describe('requireSameOrigin', () => {
  it('passes only an Origin equal to the origin of the request', () => {
    expect(() => requireSameOrigin(req('https://hrdlock.example/api/x', { Origin: 'https://hrdlock.example' }, 'POST'))).not.toThrow();
    expect(() => requireSameOrigin(req('http://localhost:8800/api/x', { Origin: 'http://localhost:8800' }, 'POST'))).not.toThrow();
  });

  it('refuses missing, null, other host, other port, other scheme, trailing slash, path and case tricks', () => {
    const cases = [
      [undefined],
      ['null'],
      [''],
      ['https://evil.example'],
      ['https://hrdlock.example.evil.example'],
      ['https://evil.example/https://hrdlock.example'],
      ['http://hrdlock.example'],
      ['https://hrdlock.example:8443'],
      ['https://hrdlock.example/'],
      ['https://hrdlock.example/path'],
      ['HTTPS://HRDLOCK.EXAMPLE '],
      ['https://hrdlock.example, https://evil.example'],
      ['*']
    ];
    for (const [origin] of cases) {
      const headers = origin === undefined ? {} : { Origin: origin };
      let err;
      try {
        requireSameOrigin(req('https://hrdlock.example/api/x', headers, 'POST'));
      } catch (e) {
        err = e;
      }
      expect(err, String(origin)).toBeDefined();
      expect(err.code).toBe('forbidden');
      expect(err.status).toBe(403);
    }
  });
});

describe('requestNow (the test clock)', () => {
  const env = { MAIL_PROVIDER: 'echo' };
  it('uses the header only where echo is honoured', () => {
    expect(requestNow(env, req('http://localhost/', { 'x-hrd-test-now': '12345' }))).toBe(12345);
    const near = Date.now();
    for (const r of [
      req('https://hrdlock.example/', { 'x-hrd-test-now': '12345' }),
      req('http://localhost/', { 'x-hrd-test-now': '12345', 'CF-Connecting-IP': '8.8.8.8' }),
      req('http://localhost/', { 'x-hrd-test-now': '12345', 'cf-ray': 'abc' })
    ]) {
      expect(Math.abs(requestNow(env, r) - near)).toBeLessThan(2000);
    }
    expect(Math.abs(requestNow({ MAIL_PROVIDER: 'resend' }, req('http://localhost/', { 'x-hrd-test-now': '12345' })) - near)).toBeLessThan(2000);
  });

  it('ignores junk values', () => {
    const near = Date.now();
    for (const v of ['', '-1', '1.5', '1e9', 'abc', '12345678901234567']) {
      expect(Math.abs(requestNow(env, req('http://localhost/', { 'x-hrd-test-now': v })) - near), v).toBeLessThan(2000);
    }
  });
});

describe('rate windows', () => {
  it('fixed windows start on multiples of their length', () => {
    expect(windowStart(3_600_000 * 5 + 123, HOUR)).toBe(3_600_000 * 5);
    expect(windowStart(3_600_000 * 5, HOUR)).toBe(3_600_000 * 5);
    expect(windowStart(3_600_000 * 5 - 1, HOUR)).toBe(3_600_000 * 4);
    expect(retryAfterSeconds(3_600_000 * 5 + 1000, HOUR)).toBe(3599);
    expect(retryAfterSeconds(3_600_000 * 6 - 1, HOUR)).toBe(1);
    expect(retryAfterSeconds(10 * MINUTE * 3, 10 * MINUTE)).toBe(600);
  });

  it('the account limits are the numbers in the spec', () => {
    expect(RATES.codeEmail).toMatchObject({ windowMs: HOUR, max: 5 });
    expect(RATES.codeIp).toMatchObject({ windowMs: HOUR, max: 20 });
    expect(RATES.codeAll).toMatchObject({ windowMs: HOUR, max: 400 });
    expect(RATES.verifyIp).toMatchObject({ windowMs: 10 * MINUTE, max: 10 });
    expect(RATES.keyRegister).toMatchObject({ windowMs: HOUR, max: 10 });
  });

  it('allows max uses, refuses the next with Retry-After, and starts again in the next window', async () => {
    const { env } = accountEnv();
    const t0 = 7 * HOUR + 5 * MINUTE;
    // keyRegister is a plain fixed window limit of 10 an hour
    for (let i = 1; i <= 10; i++) expect(await consumeRate(env, 'keyRegister', 'h1', t0)).toBe(i);
    let err;
    try {
      await consumeRate(env, 'keyRegister', 'h1', t0 + 1000);
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(err.headers['Retry-After']).toBe(retryAfterSeconds(t0 + 1000, HOUR));
    // another key is separate
    expect(await consumeRate(env, 'keyRegister', 'h2', t0)).toBe(1);
    // the window after
    expect(await consumeRate(env, 'keyRegister', 'h1', 8 * HOUR)).toBe(1);
    // the window before still holds its count (boundary: the last millisecond belongs to the old window)
    await expect(consumeRate(env, 'keyRegister', 'h1', 8 * HOUR - 1)).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('a sliding limit also counts the part of the last window that is still inside the hour (no doubling at the edge)', async () => {
    const { env } = accountEnv();
    expect(RATES.codeEmail.sliding).toBe(true);
    const edge = 9 * HOUR;
    // 5 uses in the last 2.5 minutes of the hour
    for (let i = 0; i < 5; i++) await consumeRate(env, 'codeEmail', 'e1', edge - 150_000 + i * 30_000);
    // just after the edge the new window is empty but the old one still weighs almost fully
    await expect(consumeRate(env, 'codeEmail', 'e1', edge + 1000, { undoOnDeny: true })).rejects.toMatchObject({ code: 'rate_limited' });
    // half an hour later half of it has gone (3 of 5 still count), so two more fit and the third does not
    expect(await consumeRate(env, 'codeEmail', 'e1', edge + 30 * MINUTE)).toBe(1);
    expect(await consumeRate(env, 'codeEmail', 'e1', edge + 30 * MINUTE)).toBe(2);
    await expect(consumeRate(env, 'codeEmail', 'e1', edge + 30 * MINUTE, { undoOnDeny: true })).rejects.toMatchObject({ code: 'rate_limited' });
    // a whole hour after the edge only the new window counts
    expect(await consumeRate(env, 'codeEmail', 'e1', edge + 2 * HOUR + 1)).toBe(1);
  });

  it('undoOnDeny leaves the count as it was, a refund takes one use back and never goes below zero', async () => {
    const { env, db } = accountEnv();
    const t0 = 11 * HOUR;
    for (let i = 0; i < 5; i++) await consumeRate(env, 'codeEmail', 'u1', t0, { undoOnDeny: true });
    for (let i = 0; i < 3; i++) await expect(consumeRate(env, 'codeEmail', 'u1', t0, { undoOnDeny: true })).rejects.toMatchObject({ code: 'rate_limited' });
    const count = () => db.prepare("SELECT count FROM rate_limits WHERE bucket = 'code-mail:u1'").get().count;
    expect(count()).toBe(5);
    await refundRate(env, 'codeEmail', 'u1', t0);
    expect(count()).toBe(4);
    expect(await consumeRate(env, 'codeEmail', 'u1', t0, { undoOnDeny: true })).toBe(5);
    for (let i = 0; i < 7; i++) await refundRate(env, 'codeEmail', 'u1', t0);
    expect(count()).toBe(0);
    await refundRate(env, 'codeEmail', 'nobody', t0); // no row, no error
  });

  it('opts.max replaces the built in limit, and ceilingFrom reads a whole number from the environment', async () => {
    const { env } = accountEnv();
    expect(await consumeRate(env, 'codeAll', 'all', 0, { max: 1 })).toBe(1);
    await expect(consumeRate(env, 'codeAll', 'all', 0, { max: 1 })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(ceilingFrom({ X: '250' }, 'X', 400)).toBe(250);
    expect(ceilingFrom({ X: ' 250 ' }, 'X', 400)).toBe(250);
    expect(ceilingFrom({ X: 77 }, 'X', 400)).toBe(77);
    for (const bad of [undefined, '', '0', '-5', '1.5', 'many', '1e3', '99999999', 0, -1, 2.5, null]) expect(ceilingFrom({ X: bad }, 'X', 400)).toBe(400);
    expect(ceilingFrom(undefined, 'X', 400)).toBe(400);
  });

  it('forgetRate removes every window of a key and the buckets that continue with a colon, and nothing else', async () => {
    const { env, db } = accountEnv();
    await consumeRate(env, 'vfySrc', 'hash1:ip-a', 0);
    await consumeRate(env, 'vfySrc', 'hash1:ip-b', 5 * HOUR);
    await consumeRate(env, 'vfySrc', 'hash12:ip-a', 0);
    await consumeRate(env, 'vfySrc', 'hash1', 0);
    await consumeRate(env, 'codeEmail', 'hash1', 0);
    await forgetRate(env, 'vfySrc', 'hash1').run();
    const left = db.prepare('SELECT bucket FROM rate_limits ORDER BY bucket').all().map((r) => r.bucket);
    expect(left).toEqual(['code-mail:hash1', 'vfy-src:hash12:ip-a']);
  });

  it('the 10 minute window for code checks moves every 10 minutes', async () => {
    const { env } = accountEnv();
    const t0 = 100 * HOUR;
    for (let i = 0; i < 10; i++) await consumeRate(env, 'verifyIp', 'ip', t0 + i * 1000);
    await expect(consumeRate(env, 'verifyIp', 'ip', t0 + 599_999)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await consumeRate(env, 'verifyIp', 'ip', t0 + 600_000)).toBe(1);
  });

  it('counts are kept per bucket name, so the same key under two limits does not mix', async () => {
    const { env } = accountEnv();
    await consumeRate(env, 'codeIp', 'k', 0);
    expect(await consumeRate(env, 'verifyIp', 'k', 0)).toBe(1);
    expect(await consumeRate(env, 'codeIp', 'k', 0)).toBe(2);
  });
});
