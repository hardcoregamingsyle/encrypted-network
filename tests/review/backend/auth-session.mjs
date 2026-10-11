// Sessions, cookies, cross site requests and what a stolen session can do.
// node tests/review/backend/auth-session.mjs http://127.0.0.1:8801
// Needs a LOCAL server with accounts and MAIL_PROVIDER=echo. A PASS line means the server defended
// correctly. A FAIL line means a defect was proved. The https parts run in process (a plain http local
// server can not show the Secure cookie).
import {
  DAY, Jar, ORIGIN, RUN, a, addKey, assert, brief, call, check, email, eq, expectStatus, finish, freshWindow, loop, needEcho, newKey, signIn
} from './auth-kit.mjs';
import { SITE, callApi, accountEnv, installMailStub, providerEnv, Jar as ProcJar } from './auth-proc.mjs';

await needEcho();

// ---------------------------------------------------------------------------
// lifetime and revocation

await check('lifetime: a session unused for 31 days is dead', async () => {
  const t = Date.now();
  const s = await signIn(email('idle'), { now: t });
  expectStatus(await a('GET', '/api/me', { jar: s.jar.clone(), now: t + 29 * DAY }), 200);
  const idle = await signIn(email('idle2'), { now: t });
  eq((await a('GET', '/api/me', { jar: idle.jar, now: t + 31 * DAY })).status, 401, 'after 31 idle days');
});

await check('lifetime: sliding extension happens at most once an hour and renews the cookie', async () => {
  const t = Date.now();
  const s = await signIn(email('slide'), { now: t });
  const soon = await a('GET', '/api/me', { jar: s.jar, now: t + 30 * 60 * 1000 });
  eq(soon.headers.get('set-cookie'), null, 'cookie renewed within the hour');
  const later = await a('GET', '/api/me', { jar: s.jar, now: t + 61 * 60 * 1000 });
  assert(/Max-Age=2592000/.test(later.headers.get('set-cookie') || ''), 'cookie not renewed after an hour');
});

await check('lifetime: a session must end after a fixed number of days even when it is used every day (stolen cookie)', async () => {
  const t = Date.now();
  const s = await signIn(email('forever'), { now: t });
  let cur = t;
  let alive = true;
  let days = 0;
  while (alive && days < 200) {
    cur += 1 * DAY;
    days += 1;
    alive = (await a('GET', '/api/me', { jar: s.jar, now: cur })).status === 200;
  }
  assert(!alive && days <= 100, `the session was still valid after ${days} days of daily use (no absolute limit, a stolen cookie never has to be replaced)`);
});

await check('revocation: the owner of a lost phone or a stolen cookie must have some way to end the other sessions of the account', async () => {
  const addr = email('twodevices');
  const tries = [
    ['POST', '/api/auth/logout', { all: true }],
    ['POST', '/api/auth/logout', { everywhere: true }],
    ['POST', '/api/auth/logout-all', {}],
    ['DELETE', '/api/me/sessions', undefined],
    ['POST', '/api/me/sessions', { revokeOthers: true }]
  ];
  let ended = false;
  for (const [m, p, json] of tries) {
    const t = freshWindow();
    const owner = await signIn(addr, { now: t });
    const stolen = await signIn(addr, { now: t + 1000 });
    const res = await a(m, p, { jar: owner.jar, json, now: t + 2000 });
    if (res.status === 200 && (await a('GET', '/api/me', { jar: stolen.jar, now: t + 3000 })).status === 401) ended = true;
  }
  const t = freshWindow();
  const owner = await signIn(addr, { now: t });
  const stolen = await signIn(addr, { now: t + 1000 });
  expectStatus(await a('POST', '/api/auth/logout', { jar: owner.jar, now: t + 2000 }), 200);
  const still = await a('GET', '/api/me', { jar: stolen.jar, now: t + 3000 });
  assert(ended || still.status === 401, 'after the owner signed out (and tried every way to end the others), the other session still works: nothing lists or ends it, except deleting the whole account');
});

await check('step up: a 20 day old session can read the stored private key without a fresh code', async () => {
  const t = Date.now();
  const s = await signIn(email('stepkey'), { now: t });
  await addKey(s, { copy: true, now: t });
  const res = await a('GET', '/api/me/key', { jar: s.jar, now: t + 20 * DAY });
  assert(res.status === 401 || res.status === 403, `GET /api/me/key gave HTTP ${res.status}: the signing key of the owner came back to a session that signed in 20 days ago`);
});

await check('step up: a 20 day old session can switch the account to Strict (deleting the stored key and passwords) without a fresh code', async () => {
  const t = Date.now();
  const s = await signIn(email('stepstrict'), { now: t });
  await addKey(s, { copy: true, now: t });
  const res = await a('POST', '/api/me/strict', { jar: s.jar, json: { enabled: true }, now: t + 20 * DAY });
  assert(res.status === 401 || res.status === 403, `POST /api/me/strict gave HTTP ${res.status}`);
});

await check('step up: a 20 day old session can delete the whole account without a fresh code', async () => {
  const t = Date.now();
  const s = await signIn(email('stepdelete'), { now: t });
  await addKey(s, { copy: true, now: t });
  const res = await a('DELETE', '/api/me', { jar: s.jar, now: t + 20 * DAY });
  assert(res.status === 401 || res.status === 403, `DELETE /api/me gave HTTP ${res.status}`);
});

await check('logout really deletes the session (the old cookie is dead, a second logout is harmless)', async () => {
  const s = await signIn(email('out'));
  const copy = s.jar.clone();
  expectStatus(await a('POST', '/api/auth/logout', { jar: s.jar }), 200);
  eq((await a('GET', '/api/me', { jar: copy })).status, 401, 'old cookie');
  eq((await a('POST', '/api/auth/logout', { jar: copy })).status, 200, 'second logout');
});

await check('fixation: a cookie sent along with sign in is never adopted, a new token is issued each time', async () => {
  const addr = email('fix');
  const planted = 'P'.repeat(43);
  const req = await a('POST', '/api/auth/request', { json: { email: addr } });
  const jar = new Jar();
  jar.map.set('hrd_session', planted);
  const ver = await a('POST', '/api/auth/verify', { json: { email: addr, code: req.json.debugCode }, jar });
  expectStatus(ver, 200);
  assert(jar.token() && jar.token() !== planted, 'the planted value was kept');
  const attacker = new Jar();
  attacker.map.set('hrd_session', planted);
  eq((await a('GET', '/api/me', { jar: attacker })).status, 401, 'the planted token works');
});

await check('tokens: 120 sign ins give 120 different 43 character tokens that look random', async () => {
  const t = freshWindow();
  const tokens = [];
  for (let i = 0; i < 120; i++) tokens.push((await signIn(email('tok'), { now: t, ip: loop() })).jar.token());
  eq(new Set(tokens).size, 120, 'distinct tokens');
  assert(tokens.every((x) => /^[A-Za-z0-9_-]{43}$/.test(x)), 'shape');
  for (let pos = 0; pos < 42; pos++) {
    const seen = new Set(tokens.map((x) => x[pos]));
    assert(seen.size >= 35, `position ${pos} shows only ${seen.size} different characters in 120 tokens`);
  }
  let ones = 0;
  let total = 0;
  for (const x of tokens) {
    for (const ch of x.slice(0, 42)) {
      const v = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(ch);
      for (let b = 0; b < 6; b++) ones += (v >> b) & 1;
      total += 6;
    }
  }
  assert(Math.abs(ones / total - 0.5) < 0.02, `bit balance ${(ones / total).toFixed(3)}`);
});

// ---------------------------------------------------------------------------
// cookie attributes

await check('cookie over http (local only): HttpOnly, SameSite=Lax, Path=/, no Domain, 30 days, plain name', async () => {
  const addr = email('flags');
  const req = await a('POST', '/api/auth/request', { json: { email: addr } });
  const ver = await a('POST', '/api/auth/verify', { json: { email: addr, code: req.json.debugCode } });
  const raw = ver.headers.getSetCookie();
  eq(raw.length, 1, 'cookies set');
  const c = raw[0];
  assert(/^hrd_session=[A-Za-z0-9_-]{43};/.test(c), c.slice(0, 40));
  for (const need of [/; Path=\/(;|$)/, /; HttpOnly/, /; SameSite=Lax/, /; Max-Age=2592000/]) assert(need.test(c), 'missing ' + need);
  assert(!/Domain=/i.test(c), 'a Domain attribute widens the cookie to subdomains');
  assert(!/Secure/i.test(c), 'local http cookie is not Secure (documented)');
});

await check('cookie over https (in process): __Host- name, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain; a plain cookie is ignored', async () => {
  const { env } = accountEnv({ env: { MAIL_PROVIDER: 'echo' } });
  const base = 'https://localhost';
  const req = await callApi(env, 'POST', '/api/auth/request', { base, json: { email: 'https@example.test' } });
  const jar = new ProcJar();
  const ver = await callApi(env, 'POST', '/api/auth/verify', { base, jar, json: { email: 'https@example.test', code: req.json.debugCode } });
  eq(ver.status, 200, 'verify');
  const c = ver.headers.getSetCookie()[0];
  assert(/^__Host-hrd_session=[A-Za-z0-9_-]{43}; Path=\//.test(c), c.slice(0, 50));
  for (const need of [/; Secure/, /; HttpOnly/, /; SameSite=Lax/, /; Max-Age=2592000/]) assert(need.test(c), 'missing ' + need + ' in ' + c);
  assert(!/Domain=/i.test(c), 'Domain attribute');
  const token = jar.get('__Host-hrd_session');
  eq((await callApi(env, 'GET', '/api/me', { base, jar })).status, 200, 'the Secure cookie works');
  const planted = new ProcJar();
  planted.cookies.set('hrd_session', token);
  eq((await callApi(env, 'GET', '/api/me', { base, jar: planted })).status, 401, 'the plain cookie name stands in on https');
  const out = await callApi(env, 'POST', '/api/auth/logout', { base, jar });
  assert(/Max-Age=0/.test(out.headers.getSetCookie()[0]) && /Secure/.test(out.headers.getSetCookie()[0]), 'clearing cookie must carry the same attributes');
});

await check('http on a real host name: sign in is refused before the code is used up (no cookie can be set safely)', async () => {
  const stub = installMailStub();
  try {
    const { env } = providerEnv('resend');
    const plain = 'http://hrdlock.example';
    const address = `plain-${RUN}@example.test`;
    const req = await callApi(env, 'POST', '/api/auth/request', { base: plain, ip: '203.0.113.20', json: { email: address } });
    eq(req.status, 200, 'request');
    const code = stub.calls[0].code;
    const refused = await callApi(env, 'POST', '/api/auth/verify', { base: plain, ip: '203.0.113.20', json: { email: address, code } });
    eq(refused.status, 403, 'verify over http');
    assert(!refused.headers.getSetCookie().length, 'a cookie was set');
    const ok = await callApi(env, 'POST', '/api/auth/verify', { base: SITE, ip: '203.0.113.20', json: { email: address, code } });
    eq(ok.status, 200, 'the same code over https');
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// cross site

const victim = await signIn(email('csrfvictim'));
await addKey(victim, { copy: true });
const origin = new URL(ORIGIN);
const hostPort = origin.host;

// The local server (miniflare) answers 403 itself for an Origin or Host with a foreign host name and
// rewrites an https Origin to http, so the full list below is run IN PROCESS against the real route code.
// The live part only uses what miniflare lets through: other ports, localhost against 127.0.0.1.
const WRITES = [
  ['POST', '/api/auth/request', () => ({ email: email('o') })],
  ['POST', '/api/auth/verify', () => ({ email: email('o'), code: '123456' })],
  ['POST', '/api/auth/logout', () => ({})],
  ['POST', '/api/me/key', () => ({})],
  ['POST', '/api/me/strict', () => ({ enabled: true })],
  ['PUT', '/api/me/secrets/' + 'a'.repeat(32), () => ({ password: 'x' })],
  ['DELETE', '/api/me', () => undefined]
];

await check('origin (live): other ports, localhost against 127.0.0.1, and a missing Origin are all refused, nothing changes', async () => {
  const liveBad = [null, `http://${origin.hostname}:${Number(origin.port) + 1}`, `http://${origin.hostname}`, `http://localhost:${origin.port}`, `http://[::1]:${origin.port}`, 'null'];
  for (const o of liveBad) {
    for (const [method, path, body] of WRITES) {
      const headers = {};
      if (o !== null) headers.Origin = o;
      const res = await call(method, path, { json: body(), headers: { ...headers, Cookie: victim.jar.header() }, ip: loop() });
      assert(res.status === 403, `${method} ${path} with Origin ${JSON.stringify(o)} gave HTTP ${res.status} ${res.json && res.json.code}`);
    }
  }
  const me = await a('GET', '/api/me', { jar: victim.jar });
  eq(me.status, 200, 'the victim is still signed in');
  eq(me.json.account.strict, false, 'strict was switched');
  assert(me.json.keys.length === 1 && me.json.keys[0].hasCloudCopy === true, 'the stored key changed');
});

await check('origin (in process, real route code): 26 wrong or odd Origin values never pass on any cookie write', async () => {
  const { env } = accountEnv({ env: { MAIL_PROVIDER: 'echo' } });
  const jar = new ProcJar();
  const reqq = await callApi(env, 'POST', '/api/auth/request', { base: 'http://localhost:8788', ip: '127.0.0.6', json: { email: 'o@example.test' } });
  const ver = await callApi(env, 'POST', '/api/auth/verify', { base: 'http://localhost:8788', ip: '127.0.0.6', jar, json: { email: 'o@example.test', code: reqq.json.debugCode } });
  eq(ver.status, 200, 'sign in');
  const lbase = 'http://localhost:8788';
  const bad = [
    'null', '', 'https://evil.example', 'https://localhost:8788', 'http://localhost', 'http://localhost:8789', 'http://localhost:8788.evil.example', 'http://localhost.evil.example:8788',
    'http://evil.example/localhost:8788', 'http://evil.example#localhost:8788', 'http://localhost:8788/', 'http://localhost:8788/x', 'HTTP://localhost:8788', 'http://LOCALHOST:8788',
    'http://user@localhost:8788', 'http://localhost:8788, https://evil.example', 'https://evil.example, http://localhost:8788', 'file://', 'chrome-extension://abcdefghijklmnop',
    'http://127.0.0.1:8788', 'http://[::1]:8788', 'http://localhost:08788', 'http://localhost:8788?x', 'http://localhost:8788#x', 'ws://localhost:8788', 'http://localhost:8788x'
  ];
  for (const o of bad) {
    for (const [method, path, body] of WRITES) {
      const headers = { Origin: o, Cookie: jar.header() };
      const res = await callApi(env, method, path, { base: lbase, ip: '127.0.0.9', headers, json: body() });
      assert(res.status === 403, `${method} ${path} with Origin ${JSON.stringify(o)} gave HTTP ${res.status} ${res.json && res.json.code}`);
    }
  }
  const me = await callApi(env, 'GET', '/api/me', { base: lbase, jar });
  eq(me.status, 200, 'still signed in');
  eq(me.json.account.strict, false, 'strict');
});

await check('origin: a repeated Origin header or one with an odd case in the header name is not a way round', async () => {
  const body = JSON.stringify({ enabled: true });
  const parts = (extra) => [`POST /api/me/strict HTTP/1.1\r\nHost: ${hostPort}\r\n${extra}Cookie: ${victim.jar.header()}\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`];
  const { rawHttp } = await import('./_lib.mjs');
  const other = `http://localhost:${origin.port}`;
  for (const extra of [`Origin: ${other}\r\nOrigin: ${ORIGIN}\r\n`, `Origin: ${ORIGIN}\r\nOrigin: ${other}\r\n`, `origin: ${other}\r\n`, `ORIGIN: ${other}\r\n`]) {
    const res = await rawHttp(parts(extra));
    assert(res.status === 403 || res.status === 400, `${JSON.stringify(extra)} gave HTTP ${res.status}`);
  }
  eq((await a('GET', '/api/me', { jar: victim.jar })).json.account.strict, false, 'strict');
});

await check('login CSRF: an attacker\'s own valid code posted from another origin gives no cookie', async () => {
  const addr = email('lcsrf');
  const req = await a('POST', '/api/auth/request', { json: { email: addr } });
  const res = await a('POST', '/api/auth/verify', { json: { email: addr, code: req.json.debugCode }, origin: 'https://evil.example' });
  eq(res.status, 403, 'status');
  eq(res.headers.getSetCookie().length, 0, 'cookies set');
  // and the code was not used up by the refused request
  expectStatus(await a('POST', '/api/auth/verify', { json: { email: addr, code: req.json.debugCode } }), 200);
});

await check('cors: no route answers a preflight or a cross origin read with permission headers', async () => {
  const paths = ['/api/auth/request', '/api/auth/verify', '/api/auth/logout', '/api/me', '/api/me/key', '/api/me/strict', '/api/me/documents', '/api/me/secrets/' + 'a'.repeat(32), '/api/health'];
  for (const p of paths) {
    const pre = await call('OPTIONS', p, { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    const names = [...pre.headers.keys()].filter((k) => /^access-control-/i.test(k));
    assert(names.length === 0, `${p} preflight answered with ${names.join()}`);
    assert(pre.status >= 400 || pre.status === 204, `${p} preflight gave ${pre.status}`);
    const read = await call('GET', p, { headers: { Origin: 'https://evil.example', Cookie: victim.jar.header() }, ip: loop() });
    assert(!read.headers.get('access-control-allow-origin'), `${p} read allows another origin`);
  }
});

await check('cache: answers that carry keys, passwords or sessions are never cacheable', async () => {
  const s = await signIn(email('cache'));
  await addKey(s, { copy: true });
  for (const p of ['/api/me', '/api/me/key', '/api/me/documents']) {
    const res = await a('GET', p, { jar: s.jar });
    assert(/no-store/.test(res.headers.get('cache-control') || ''), `${p}: Cache-Control ${res.headers.get('cache-control')}`);
  }
  const ver = await a('POST', '/api/auth/request', { json: { email: email('cache') } });
  assert(/no-store/.test(ver.headers.get('cache-control') || ''), 'request answer');
  const strict = await a('POST', '/api/me/strict', { jar: s.jar, json: { enabled: true } });
  assert(/no-store/.test(strict.headers.get('cache-control') || ''), 'strict answer carries every password');
});

await check('guest paths: the open registration works without Origin and ignores a session cookie entirely (no account is touched)', async () => {
  const k = await newKey('Guest ' + Math.random().toString(36).slice(2, 8));
  const res = await call('POST', '/api/identities', { json: { record: k.record, signature: k.signature }, headers: { Cookie: victim.jar.header(), Origin: 'https://evil.example' }, ip: loop() });
  eq(res.status, 201, 'registration: ' + brief(res));
  const me = await a('GET', '/api/me', { jar: victim.jar });
  eq(me.json.keys.length, 1, 'the victim account gained a key');
  eq((await call('GET', '/api/identities/' + k.keyId)).status, 200, 'readable');
});

finish();
