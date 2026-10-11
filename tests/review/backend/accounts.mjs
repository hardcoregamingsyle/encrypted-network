// Attacks on the account endpoints (sign in by email code, sessions, keys, stored passwords).
// node tests/review/backend/accounts.mjs http://127.0.0.1:8791
// Needs a LOCAL server with ACCOUNT_MASTER_KEY and MAIL_PROVIDER=echo (npm run setup does both). Set
// HRD_STATE_DIR to the server's --persist-to folder to also check what the database holds.
// A PASS line means the server defended correctly. A FAIL line means a defect was proved.
import { exportPrivateJwk, exportPublicJwk, generateKeyPair, keyIdOf, signRecord } from '../../../shared/keys.js';
import {
  RUN,
  assert,
  brief,
  bytesToHex,
  call,
  check,
  createRecord,
  eq,
  expectStatus,
  finish,
  makeBlob,
  makeIdentity,
  newDocId,
  openDb,
  postDoc,
  putBlob,
  rawHttp,
  register
} from './_lib.mjs';

const health = await call('GET', '/api/health');
if (!(health.json && health.json.accounts === true && health.json.mail === 'echo')) {
  console.log('SKIP the server has no accounts with echo mail (health: ' + JSON.stringify(health.json) + ')');
  process.exit(0);
}

const ORIGIN = new URL(process.argv[2] || 'http://127.0.0.1:8791').origin;
const DAY = 24 * 3600 * 1000;
let counter = 0;
const email = (tag = 'a') => `atk-${tag}-${RUN}-${++counter}-${Math.floor(Math.random() * 1e6)}@example.test`;
const loop = () => `127.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

class Jar {
  constructor() {
    this.map = new Map();
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair, ...attrs] = c.split(';').map((s) => s.trim());
      const at = pair.indexOf('=');
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      if (pair.slice(at + 1) === '' || (maxAge && Number(maxAge.split('=')[1]) <= 0)) this.map.delete(pair.slice(0, at));
      else this.map.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// A call with Origin, a loopback address and a cookie jar. origin: null sends none.
async function a(method, path, { json, jar, origin, ip, now, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (origin !== null && method !== 'GET' && method !== 'HEAD') h.Origin = origin || ORIGIN;
  if (jar && jar.header()) h.Cookie = jar.header();
  if (now !== undefined) h['x-hrd-test-now'] = String(now);
  const res = await call(method, path, { json, headers: h, ip: ip === undefined ? loop() : ip, raw });
  if (jar) jar.absorb({ headers: res.headers });
  return res;
}

async function signIn(addr = email(), { now, ip = loop() } = {}) {
  const req = await a('POST', '/api/auth/request', { json: { email: addr }, ip, now });
  expectStatus(req, 200);
  const jar = new Jar();
  const ver = await a('POST', '/api/auth/verify', { json: { email: addr, code: req.json.debugCode }, jar, ip, now });
  expectStatus(ver, 200);
  return { jar, account: ver.json.account, email: addr, ip };
}

async function newKey(name) {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: true });
  const publicJwk = await exportPublicJwk(publicKey);
  const keyId = await keyIdOf(publicJwk);
  const record = { v: 2, type: 'identity', publicKey: publicJwk, displayName: name, createdAt: Date.now() };
  return { keyId, publicJwk, record, signature: await signRecord(privateKey, record), privateJwk: await exportPrivateJwk(privateKey), privateKey };
}

const db = await openDb();
if (!db) console.log('note: HRD_STATE_DIR not usable, the database checks are skipped');

// ---------------------------------------------------------------------------
// the echo guard

await check('echo guard: a request that names another host never gets a code', async () => {
  const body = JSON.stringify({ email: email('host') });
  const u = new URL(ORIGIN);
  for (const host of ['example.com', 'hrdlock.pages.dev', 'localhost.evil.test', '127.0.0.2', 'evil-localhost']) {
    const res = await rawHttp([
      `POST /api/auth/request HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://${host}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
    ]);
    assert(!/debugCode/.test(res.body), `Host ${host} got a code: ${res.body.slice(0, 120)}`);
    assert(res.status !== 200 || !/"sent":true/.test(res.body) || host === u.hostname, `Host ${host} was served as a sign in request`);
  }
});

await check('echo guard: edge address headers (public v4, v6, lists, junk) and cf-ray never get a code', async () => {
  const values = ['203.0.113.7', '8.8.8.8', '2001:db8::1', '10.0.0.1', '192.168.1.1', '::ffff:8.8.8.8', '127.0.0.1, 8.8.8.8', '8.8.8.8, 127.0.0.1', 'unknown', 'localhost', '0.0.0.0', '127.0.0.1.evil.test', '127.0.0.256', '0x7f.0.0.1', '2130706433', '::1%25eth0x'];
  for (const ip of values) {
    const res = await a('POST', '/api/auth/request', { json: { email: email('edge') }, ip });
    assert(!/debugCode/.test(res.text), `CF-Connecting-IP ${ip} got a code`);
    assert(res.status === 503 || res.status === 403 || res.status === 400 || res.status === 429, `CF-Connecting-IP ${ip} gave ${res.status}`);
  }
  const ray = await a('POST', '/api/auth/request', { json: { email: email('ray') }, headers: { 'cf-ray': '8f1c2d3e4f5a6b7c-FRA' } });
  assert(!/debugCode/.test(ray.text), 'cf-ray got a code');
  // a forwarded header must not turn a remote client into a local one, or the other way round
  const fwd = await a('POST', '/api/auth/request', { json: { email: email('fwd') }, ip: '203.0.113.9', headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1', Forwarded: 'for=127.0.0.1' } });
  assert(!/debugCode/.test(fwd.text), 'forwarded headers got a code');
});

await check('echo guard: the test clock header does nothing on a refused request', async () => {
  const addr = email('clock');
  // a code that ran out 11 minutes ago, made locally with the test clock
  const old = Date.now() - 11 * 60 * 1000;
  const req = await a('POST', '/api/auth/request', { json: { email: addr }, now: old });
  expectStatus(req, 200);
  // a remote client sends the same header to make the code look alive again
  const late = await a('POST', '/api/auth/verify', { json: { email: addr, code: req.json.debugCode }, ip: '203.0.113.50', now: old + 1000 });
  eq(late.status, 400, 'remote verify with the test clock: ' + brief(late));
  eq(late.json.code, 'code_expired', 'code');
  // and it can not make an ended session valid either
  const forged = new Jar();
  forged.map.set('hrd_session', 'A'.repeat(43));
  expectStatus(await a('GET', '/api/me', { jar: forged, ip: '203.0.113.50', now: 1 }), 401);
});

// ---------------------------------------------------------------------------
// codes

await check('codes: 60 parallel guesses from 60 addresses get at most 5 tries in total', async () => {
  const addr = email('brute');
  const req = await a('POST', '/api/auth/request', { json: { email: addr } });
  const bad = req.json.debugCode === '123456' ? '654321' : '123456';
  const results = await Promise.all(Array.from({ length: 60 }, () => a('POST', '/api/auth/verify', { json: { email: addr, code: bad } })));
  const counted = results.filter((r) => r.json && r.json.code === 'invalid_code').length;
  assert(counted <= 4, `${counted} wrong tries were counted as plain wrong answers (at most 4 before the fifth kills the code)`);
  assert(results.every((r) => r.status === 400 || r.status === 429), 'unexpected status: ' + results.map((r) => r.status).join());
  const right = await a('POST', '/api/auth/verify', { json: { email: addr, code: req.json.debugCode } });
  expectStatus(right, 429, 'too_many_attempts');
  if (db) {
    const rows = db.prepare('SELECT attempts FROM otp_codes').all();
    assert(rows.every((r) => r.attempts <= 5), 'attempts above 5 stored: ' + JSON.stringify(rows.map((r) => r.attempts)));
  }
});

await check('codes: two parallel right answers create exactly one session', async () => {
  const addr = email('twin');
  const ip = loop();
  const req = await a('POST', '/api/auth/request', { json: { email: addr }, ip });
  const both = await Promise.all([0, 1, 2, 3].map(() => a('POST', '/api/auth/verify', { json: { email: addr, code: req.json.debugCode }, ip: loop() })));
  eq(both.filter((r) => r.status === 200).length, 1, 'successes: ' + both.map((r) => r.status).join());
  for (const r of both.filter((x) => x.status !== 200)) eq(r.json.code, 'code_expired', 'the loser');
});

await check('codes: guessing from one address is stopped after 10 checks in 10 minutes', async () => {
  const ip = loop();
  const t0 = Date.now() - 40 * DAY;
  const codes = [];
  for (let i = 0; i < 13; i++) codes.push((await a('POST', '/api/auth/verify', { json: { email: email('g'), code: '000000' }, ip, now: t0 })).json.code);
  eq(codes.slice(10).every((c) => c === 'rate_limited'), true, 'after ten: ' + codes.join());
});

await check('codes: the rate limits follow CF-Connecting-IP only, not forwarded headers, and an IPv6 /64 is one address', async () => {
  const t0 = Date.now() - 41 * DAY;
  const ip = loop();
  const seen = [];
  for (let i = 0; i < 23; i++) {
    seen.push((await a('POST', '/api/auth/request', { json: { email: email('xff') }, ip, now: t0, headers: { 'X-Forwarded-For': `9.9.${i}.1`, 'X-Real-IP': `8.8.${i}.1` } })).status);
  }
  eq(seen.filter((s) => s === 200).length, 20, 'accepted with changing forwarded headers: ' + seen.join());
  // IPv6 inside one /64: loopback only counts for ::1, so use the verify limit with the test clock on ::1 neighbours
  // (non loopback v6 never gets echo, but the limit still runs first or after: both outcomes must be a refusal)
  const prefix = `2001:db8:${RUN.slice(0, 4)}:${RUN.slice(4, 8)}`;
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await a('POST', '/api/auth/verify', { json: { email: email('v6'), code: '123456' }, ip: `${prefix}::${i + 1}`, now: t0 })).json.code);
  eq(statuses.slice(10).join(), 'rate_limited,rate_limited', 'a whole /64 is one address: ' + statuses.join());
});

await check('codes: nothing tells a known email from an unknown one', async () => {
  const known = await signIn(email('known'));
  const fresh = email('fresh');
  const shapes = async (addr) => {
    const out = [];
    const r1 = await a('POST', '/api/auth/request', { json: { email: addr } });
    out.push(r1.status, Object.keys(r1.json).sort().join(), r1.json.cooldown);
    const r2 = await a('POST', '/api/auth/verify', { json: { email: addr, code: r1.json.debugCode === '111111' ? '222222' : '111111' } });
    out.push(r2.status, r2.json.code, Object.keys(r2.json).sort().join());
    return out.join('|');
  };
  eq(await shapes(known.email), await shapes(fresh), 'answers differ between a known and an unknown email');
  // the same for an email that never asked for a code at all
  const none = (addr) => a('POST', '/api/auth/verify', { json: { email: addr, code: '123456' } }).then((r) => r.status + ':' + r.json.code);
  eq(await none(known.email.replace('atk-known', 'atk-never')), await none(email('never')), 'verify without a code');
});

await check('codes: email spelling tricks do not split or merge accounts', async () => {
  const base = `Spell-${RUN}-${Math.floor(Math.random() * 1e6)}`;
  const one = await signIn(`${base}@Example.Test`);
  const two = await signIn(`  ${base.toUpperCase()}@EXAMPLE.TEST \n`);
  eq(two.account.id, one.account.id, 'case and blanks are the same account');
  const tagged = await signIn(`${base}+tag@example.test`);
  assert(tagged.account.id !== one.account.id, 'a plus tag is a different address');
  for (const bad of ['\uff21\uff22@example.test', `${base}@exa\u212ample.test`, `${base}\u0430@example.test`, `${base}@example.test\u0000`, `${base}@example.test\r\nBcc: a@b.cc`, `${base}@example.test,other@example.test`, `<${base}@example.test>`, `"${base}"@example.test`]) {
    expectStatus(await a('POST', '/api/auth/request', { json: { email: bad } }), 400, 'invalid_email');
  }
});

await check('codes: junk bodies on the sign in endpoints never cause a 5xx', async () => {
  const bodies = ['null', '[]', '"x"', '123', '{"email":{"a":1}}', '{"email":["a@b.cc"]}', '{"email":"a@b.cc","code":{"a":1}}', '{"__proto__":{"email":"a@b.cc"}}', '{"email":"a@b.cc","email":"c@d.ee"}', '{"constructor":{"prototype":{}}}', '[' .repeat(2000), '{"a":'.repeat(500), '\u0000', ''];
  for (const raw of bodies) {
    for (const path of ['/api/auth/request', '/api/auth/verify', '/api/auth/logout', '/api/me/key', '/api/me/strict']) {
      const res = await a('POST', path, { raw, headers: { 'Content-Type': 'application/json' } });
      assert(res.status < 500, `${path} with ${JSON.stringify(raw.slice(0, 20))}: ${brief(res)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// sessions

const victim = await signIn(email('victim'));

await check('sessions: forged and malformed cookies are 401, never 5xx (500 random tokens, long and odd values)', async () => {
  const values = ['', 'x', 'A'.repeat(43), 'A'.repeat(44), "' OR 1=1 --", '%27%20OR%201=1', '../../../etc/passwd', '{"a":1}', '\u0000', 'A'.repeat(43) + '; hrd_session=' + 'B'.repeat(43)];
  for (let i = 0; i < 40; i++) values.push(bytesToHex(crypto.getRandomValues(new Uint8Array(32))).slice(0, 43));
  for (const v of values.filter((x) => !/[\u0000-\u001f]/.test(x))) {
    const res = await a('GET', '/api/me', { headers: { Cookie: 'hrd_session=' + v } });
    assert(res.status === 401 || res.status === 400 || res.status === 431, `cookie ${JSON.stringify(v.slice(0, 30))} gave ${res.status}`);
  }
  const huge = await a('GET', '/api/me', { headers: { Cookie: 'hrd_session=' + 'A'.repeat(7000) } });
  assert(huge.status < 500, 'a huge cookie gave ' + huge.status);
  const manyCookies = Array.from({ length: 200 }, (_, i) => `c${i}=v${i}`).join('; ');
  assert((await a('GET', '/api/me', { headers: { Cookie: manyCookies } })).status < 500, 'many cookies');
});

await check('sessions: another cookie name does not stand in for the session (look alike names, Secure name over http)', async () => {
  const token = victim.jar.map.get('hrd_session');
  assert(token, 'victim has a session');
  for (const name of ['__Host-hrd_session', 'xhrd_session', 'hrd_session_', 'Hrd_Session', 'hrd-session', '__Secure-hrd_session']) {
    const res = await a('GET', '/api/me', { headers: { Cookie: `${name}=${token}` } });
    eq(res.status, 401, 'name ' + name);
  }
});

await check('sessions: the stored session is a hash, not the cookie value (database)', async () => {
  if (!db) return;
  const token = victim.jar.map.get('hrd_session');
  const rows = db.prepare('SELECT token_hash FROM sessions').all();
  assert(rows.length > 0, 'sessions exist');
  assert(rows.every((r) => r.token_hash !== token && !r.token_hash.includes(token)), 'a raw session token is stored');
});

await check('sessions: an account can not use the session of another (swap tokens between two devices of different accounts)', async () => {
  const other = await signIn(email('other'));
  const me = await a('GET', '/api/me', { jar: other.jar });
  assert(me.json.account.id !== victim.account.id, 'different accounts');
});

await check('csrf: sign in, code and logout requests need the site\'s own Origin', async () => {
  for (const origin of [null, 'https://evil.example', 'null', ORIGIN + '.evil.example', ORIGIN + '/']) {
    for (const [path, json] of [['/api/auth/request', { email: email('csrf') }], ['/api/auth/verify', { email: email('csrf'), code: '123456' }], ['/api/auth/logout', {}]]) {
      const res = await a('POST', path, { json, origin });
      eq(res.status, 403, `${path} with Origin ${origin}`);
    }
  }
  // the session of the victim survived all of it
  expectStatus(await a('GET', '/api/me', { jar: victim.jar }), 200);
});

await check('csrf: a form post with a simple content type from another origin is refused too', async () => {
  const res = await a('POST', '/api/me/strict', { jar: victim.jar, origin: 'https://evil.example', raw: 'enabled=true', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  eq(res.status, 403, 'form post');
  const text = await a('POST', '/api/me/strict', { jar: victim.jar, origin: 'https://evil.example', raw: '{"enabled":true}', headers: { 'Content-Type': 'text/plain' } });
  eq(text.status, 403, 'text/plain post');
  const me = await a('GET', '/api/me', { jar: victim.jar });
  eq(me.json.account.strict, false, 'the victim was not switched to strict');
});

// ---------------------------------------------------------------------------
// keys

await check('keys: another account\'s key, a guest key and a replayed public record can not be linked', async () => {
  const owner = await signIn(email('keyowner'));
  const thief = await signIn(email('thief'));
  const k = await newKey('Owner ' + RUN);
  expectStatus(await a('POST', '/api/me/key', { jar: owner.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } }), 201);
  // replay of the public record (anyone can read it) from another account
  const pub = await call('GET', '/api/identities/' + k.keyId);
  const replay = await a('POST', '/api/me/key', { jar: thief.jar, json: { record: pub.json.record, signature: pub.json.signature } });
  expectStatus(replay, 409, 'exists');
  // a guest key
  const guest = await makeIdentity('Guest ' + RUN);
  await register(guest);
  const take = await a('POST', '/api/me/key', { jar: thief.jar, json: { record: guest.identityRecord, signature: guest.identitySignature } });
  expectStatus(take, 409, 'exists');
  const me = await a('GET', '/api/me', { jar: thief.jar });
  eq(me.json.keys.length, 0, 'the thief gained no key');
  // and the thief sees none of the owner's files
  const docs = await a('GET', '/api/me/documents', { jar: thief.jar });
  eq(docs.json.documents.length, 0, 'documents of the thief');
  if (db) assert(db.prepare('SELECT COUNT(*) AS n FROM account_keys WHERE key_id = ?').get(k.keyId).n === 1, 'key linked once');
});

await check('keys: bad private keys are refused without echoing anything (wrong d, extra fields, types, huge)', async () => {
  let acct = await signIn(email('badkeys'));
  const k = await newKey('Bad ' + RUN);
  const other = await newKey('Other ' + RUN);
  const variants = [
    { ...k.privateJwk, d: other.privateJwk.d },
    { ...other.privateJwk },
    { ...k.privateJwk, ext: true },
    { ...k.privateJwk, key_ops: ['sign'] },
    { ...k.privateJwk, d: 5 },
    { ...k.privateJwk, d: 'A'.repeat(43) },
    { ...k.privateJwk, kty: 'RSA' },
    { ...k.privateJwk, crv: 'P-384' },
    { kty: 'EC', crv: 'P-256', x: k.privateJwk.x, y: k.privateJwk.y },
    [],
    'string',
    { __proto__: { d: other.privateJwk.d } },
    { ...k.privateJwk, junk: 'x'.repeat(20000) }
  ];
  let used = 0;
  for (const privateJwk of variants) {
    if (used++ % 8 === 7) acct = await signIn(email('badkeys'));
    const res = await a('POST', '/api/me/key', { jar: acct.jar, json: { record: k.record, signature: k.signature, privateJwk } });
    assert(res.status === 400, 'status ' + res.status + ' for ' + JSON.stringify(privateJwk).slice(0, 60));
    assert(!res.text.includes(k.privateJwk.d) && !res.text.includes(other.privateJwk.d), 'a private key leaked into the answer');
  }
  const big = await a('POST', '/api/me/key', { jar: acct.jar, raw: JSON.stringify({ record: k.record, signature: k.signature, privateJwk: { ...k.privateJwk, junk: 'x'.repeat(70000) } }), headers: { 'Content-Type': 'application/json' } });
  eq(big.status, 413, 'over 64 KiB');
  eq((await call('GET', '/api/identities/' + k.keyId)).status, 404, 'nothing registered');
});

await check('keys: a stored key and password are not readable in the database, and are bound to their row', async () => {
  const acct = await signIn(email('wrapcheck'));
  const k = await newKey('Wrap ' + RUN);
  expectStatus(await a('POST', '/api/me/key', { jar: acct.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } }), 201);
  if (!db) return;
  const row = db.prepare('SELECT wrapped_private FROM account_keys WHERE key_id = ?').get(k.keyId);
  assert(row.wrapped_private && !row.wrapped_private.includes(k.privateJwk.d), 'the private key is stored in clear');
  // database dump grep for the address and the private part
  for (const t of ['accounts', 'sessions', 'otp_codes', 'account_keys', 'account_secrets', 'rate_limits']) {
    const text = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());
    assert(!text.includes(k.privateJwk.d), `${t} holds the private key`);
    assert(!text.includes(acct.email) && !text.includes(acct.email.split('@')[0]), `${t} holds an email address`);
  }
});

await check('keys: a sixth key and a second server copy are refused', async () => {
  const acct = await signIn(email('limit'));
  expectStatus(await a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: true } }), 200);
  const codes = [];
  for (let i = 0; i < 7; i++) {
    const k = await newKey(`Dev ${i} ${RUN}`);
    codes.push((await a('POST', '/api/me/key', { jar: acct.jar, json: { record: k.record, signature: k.signature } })).status);
  }
  eq(codes.join(), '201,201,201,201,201,409,409', 'statuses');
  // a parallel burst can not push past five either
  const acct2 = await signIn(email('burst'));
  expectStatus(await a('POST', '/api/me/strict', { jar: acct2.jar, json: { enabled: true } }), 200);
  const keys = await Promise.all(Array.from({ length: 9 }, (_, i) => newKey(`Burst ${i} ${RUN}`)));
  const out = await Promise.all(keys.map((k) => a('POST', '/api/me/key', { jar: acct2.jar, json: { record: k.record, signature: k.signature } })));
  const me = await a('GET', '/api/me', { jar: acct2.jar });
  assert(me.json.keys.length <= 5, 'keys after a burst: ' + me.json.keys.length + ' (' + out.map((r) => r.status).join() + ')');
  // two copies at once
  const acct3 = await signIn(email('copies'));
  const pair = await Promise.all([newKey('Copy A ' + RUN), newKey('Copy B ' + RUN)]);
  await Promise.all(pair.map((k) => a('POST', '/api/me/key', { jar: acct3.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } })));
  if (db) {
    const copies = db.prepare('SELECT COUNT(*) AS n FROM account_keys WHERE account_id = ? AND wrapped_private IS NOT NULL').get(acct3.account.id).n;
    assert(copies <= 1, 'server copies stored: ' + copies);
  }
});

await check('keys: strict mode can not be bypassed by sending a private key, nor by racing the switch', async () => {
  const acct = await signIn(email('strictrace'));
  const keys = await Promise.all(Array.from({ length: 4 }, (_, i) => newKey(`Race ${i} ${RUN}`)));
  const out = await Promise.all([
    a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: true } }),
    ...keys.slice(0, 1).map((k) => a('POST', '/api/me/key', { jar: acct.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } }))
  ]);
  assert(out.every((r) => r.status < 500), 'statuses: ' + out.map((r) => r.status).join());
  const after = await a('GET', '/api/me', { jar: acct.jar });
  eq(after.json.account.strict, true, 'strict stayed on');
  assert(after.json.keys.every((k) => k.hasCloudCopy === false), 'a server copy survived the switch to strict');
  const refused = await a('POST', '/api/me/key', { jar: acct.jar, json: { record: keys[1].record, signature: keys[1].signature, privateJwk: keys[1].privateJwk } });
  expectStatus(refused, 409, 'strict_mode');
});

// ---------------------------------------------------------------------------
// stored passwords

await check('secrets: no reading, writing or guessing across accounts or documents', async () => {
  const owner = await signIn(email('secowner'));
  const other = await signIn(email('secother'));
  const k = await newKey('Sec ' + RUN);
  expectStatus(await a('POST', '/api/me/key', { jar: owner.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } }), 201);
  // publish a document directly as that key
  const person = { keyId: k.keyId, privateKey: k.privateKey };
  const blob = await makeBlob(300);
  expectStatus(await putBlob(person, blob), 201);
  const rec = createRecord(person, blob, {});
  expectStatus(await postDoc(person, rec), 201);
  const docId = rec.docId;
  expectStatus(await a('PUT', `/api/me/secrets/${docId}`, { jar: owner.jar, json: { password: 'ABCD-EFGH-JKLM-NPQR-STUV' } }), 200);
  eq((await a('GET', `/api/me/secrets/${docId}`, { jar: other.jar })).status, 404, 'other account reads');
  eq((await a('PUT', `/api/me/secrets/${docId}`, { jar: other.jar, json: { password: 'EVIL' } })).status, 403, 'other account writes');
  eq((await a('GET', `/api/me/secrets/${docId}`, { jar: owner.jar })).json.password, 'ABCD-EFGH-JKLM-NPQR-STUV', 'still the owner\'s');
  // (a plain .. is resolved by the client before it is sent, so it is not tried here)
  for (const id of ['..%2fme', '%2e%2e%2fme', docId.toUpperCase(), docId + 'x', docId.slice(1), "' OR 1=1", '%00', 'a'.repeat(200), 'ffffffffffffffffffffffffffffffff']) {
    const r1 = await a('GET', `/api/me/secrets/${id}`, { jar: owner.jar });
    assert(r1.status === 400 || r1.status === 404, `GET ${id} gave ${r1.status}`);
    const r2 = await a('PUT', `/api/me/secrets/${id}`, { jar: owner.jar, json: { password: 'ABCD' } });
    assert(r2.status === 400 || r2.status === 404, `PUT ${id} gave ${r2.status}`);
  }
  for (const password of [{ a: 1 }, ['x'], 5, null, true, 'x'.repeat(129), '\u0000', 'a\u202eb', 'caf\u00e9']) {
    eq((await a('PUT', `/api/me/secrets/${docId}`, { jar: owner.jar, json: { password } })).status, 400, 'password ' + JSON.stringify(password));
  }
  if (db) {
    const stored = db.prepare('SELECT wrapped FROM account_secrets WHERE doc_id = ?').get(docId);
    assert(stored && !stored.wrapped.includes('ABCD'), 'the password is stored in clear');
  }
});

await check('documents: My files lists only the account\'s own documents, even with odd paging values', async () => {
  const acct = await signIn(email('mydocs'));
  for (const q of ['limit=-1', 'limit=1e3', 'limit=999999999999999999999', 'before=abc', 'before=-5', 'beforeId=' + 'g'.repeat(32), 'before=1&beforeId=' + 'a'.repeat(31), "limit=1;DROP TABLE documents", 'limit=1&limit=2', 'owner=x', 'q=%25']) {
    const res = await a('GET', '/api/me/documents?' + q, { jar: acct.jar });
    assert(res.status === 400 || res.status === 200, `${q} gave ${res.status}`);
    if (res.status === 200) eq(res.json.documents.length, 0, 'documents for ' + q);
  }
});

// ---------------------------------------------------------------------------
// deleting

await check('delete: a deleted account is gone for every device, twice is 401, and the same email starts fresh', async () => {
  const addr = email('del');
  const one = await signIn(addr);
  const two = await signIn(addr);
  expectStatus(await a('DELETE', '/api/me', { jar: one.jar }), 200);
  expectStatus(await a('DELETE', '/api/me', { jar: one.jar }), 401);
  expectStatus(await a('GET', '/api/me', { jar: two.jar }), 401);
  expectStatus(await a('POST', '/api/me/strict', { jar: two.jar, json: { enabled: true } }), 401);
  const again = await signIn(addr);
  assert(again.account.id !== one.account.id, 'a new account id');
  if (db) {
    assert(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?').get(one.account.id).n === 0, 'sessions left behind');
    assert(db.prepare('SELECT COUNT(*) AS n FROM account_keys WHERE account_id = ?').get(one.account.id).n === 0, 'keys left behind');
  }
});

await check('everything above left the old open API untouched (health, identities, list)', async () => {
  expectStatus(await call('GET', '/api/health'), 200);
  const g = await makeIdentity('After ' + RUN);
  await register(g);
  expectStatus(await call('GET', '/api/documents?limit=1'), 200);
  expectStatus(await call('GET', '/api/channels'), 200);
  assert(newDocId().length === 32, 'ids');
});

finish();
