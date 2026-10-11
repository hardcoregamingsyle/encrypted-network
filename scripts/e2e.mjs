// End to end check of the API over real HTTP.
//   node scripts/e2e.mjs http://127.0.0.1:8790 [--require-accounts]
//
// The account checks (sign in by email code, keys, stored passwords, Strict mode, CSRF, sessions) need a
// LOCAL server with ACCOUNT_MASTER_KEY and MAIL_PROVIDER=echo, which `npm run setup` puts in .dev.vars.
// Without them those checks are skipped with a SKIP line, unless --require-accounts is given.
//
// Uses only HTTP plus the real shared/ and src/lib/lockfile.js code, with freshly generated
// identities and random ids, so it can run again and again against the same server.
// Prints one line per check and exits non zero if any check failed.
import { canonicalize } from '../shared/canonical.js';
import { bytesToHex } from '../shared/encoding.js';
import { sha256Hex } from '../shared/hash.js';
import { verifyCheckpoint } from '../shared/checkpoint.js';
import { exportPrivateJwk, exportPublicJwk, generateKeyPair, importPrivateJwk, keyIdOf, signRecord, verifyRecord } from '../shared/keys.js';
import { LIMITS, ZERO_HASH, newDocId, newNonce, recordHash } from '../shared/records.js';
import {
  verifyBlobBytes,
  verifyDocumentBundle,
  verifyLedgerPage,
  verifyMessages,
  verifyPlaintext
} from '../shared/verify.js';
import { generatePassword, lockFile, unlockFile } from '../src/lib/lockfile.js';

const BASE = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const RUN = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(4)));
const ITERATIONS = 100000; // the lowest allowed, keeps the run quick

// ---------------------------------------------------------------------------
// tiny test runner

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + ': ' + (err && err.message ? err.message : err));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function eq(actual, expected, what = 'value') {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function expectStatus(res, status, code) {
  if (res.status !== status) {
    throw new Error(`expected HTTP ${status}${code ? ' ' + code : ''}, got ${res.status} ${JSON.stringify(res.json)}`);
  }
  if (code && (!res.json || res.json.code !== code)) {
    throw new Error(`expected code ${code}, got ${JSON.stringify(res.json)}`);
  }
}

// ---------------------------------------------------------------------------
// http

async function call(method, path, { json, headers = {}, body, ip } = {}) {
  const h = { ...headers };
  if (ip) h['CF-Connecting-IP'] = ip;
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    h['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let parsed = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, headers: res.headers, json: parsed, bytes };
}

// ---------------------------------------------------------------------------
// identities

// Each fake client address allows 10 identities per hour, so spread them over a few addresses.
let identityCount = 0;
let ipBase = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
function nextIp() {
  const ip = `${ipBase}.${Math.floor(identityCount / 8) + 1}`;
  identityCount++;
  return ip;
}

async function makeIdentity(displayName) {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: false });
  const publicJwk = await exportPublicJwk(publicKey);
  const keyId = await keyIdOf(publicJwk);
  const identityRecord = { v: 2, type: 'identity', publicKey: publicJwk, displayName, createdAt: Date.now() };
  const identitySignature = await signRecord(privateKey, identityRecord);
  return { keyId, publicJwk, privateKey, identityRecord, identitySignature, name: displayName };
}

async function register(identity, ip = nextIp()) {
  const res = await call('POST', '/api/identities', {
    json: { record: identity.identityRecord, signature: identity.identitySignature },
    ip
  });
  expectStatus(res, 201);
  eq(res.json.keyId, identity.keyId, 'keyId');
  return identity;
}

async function newPerson(name) {
  return register(await makeIdentity(`${name} ${RUN}`));
}

// ---------------------------------------------------------------------------
// documents

async function lock(text, password, name = 'paper.txt') {
  const data = new TextEncoder().encode(text);
  const locked = await lockFile({ data, name, password, iterations: ITERATIONS });
  return { ...locked, data };
}

async function putBlob(signer, bytes, opts = {}) {
  const hash = opts.hash || (await sha256Hex(bytes));
  const record = {
    v: 2,
    type: 'blob.put',
    hash,
    size: opts.signSize ?? bytes.length,
    signer: opts.signerKeyId || signer.keyId,
    createdAt: opts.time ?? Date.now()
  };
  const signature = await signRecord((opts.signWith || signer).privateKey, record);
  const headers = { 'x-hrd-key': record.signer, 'x-hrd-time': String(record.createdAt), 'x-hrd-sig': signature };
  return call('PUT', '/api/blobs/' + (opts.pathHash || hash), { headers, body: bytes });
}

function createRecord(owner, locked, o = {}) {
  return {
    v: 2,
    type: 'doc.create',
    docId: o.docId,
    version: 1,
    prev: ZERO_HASH,
    signer: owner.keyId,
    createdAt: o.createdAt ?? Date.now(),
    label: o.label ?? 'e2e document',
    listed: o.listed ?? true,
    blob: { hash: locked.blobHash, size: locked.size, suite: 1 },
    commitment: locked.commitment
  };
}

function updateRecord(owner, locked, o) {
  return {
    v: 2,
    type: 'doc.update',
    docId: o.docId,
    version: o.version,
    prev: o.prev,
    signer: owner.keyId,
    createdAt: o.createdAt ?? Date.now(),
    label: o.label ?? 'e2e document',
    blob: { hash: locked.blobHash, size: locked.size, suite: 1 },
    commitment: locked.commitment
  };
}

function revokeRecord(owner, o) {
  return {
    v: 2,
    type: 'doc.revoke',
    docId: o.docId,
    version: o.version,
    prev: o.prev,
    signer: owner.keyId,
    createdAt: o.createdAt ?? Date.now(),
    reason: o.reason ?? 'withdrawn in the e2e run'
  };
}

async function postDoc(signer, record, { docId = record.docId, signWith } = {}) {
  const signature = await signRecord((signWith || signer).privateKey, record);
  return call('POST', `/api/documents/${docId}/records`, { json: { record, signature } });
}

// Uploads a locked file and creates a document. Returns details for later steps.
async function publishNew(owner, text, o = {}) {
  const password = o.password || generatePassword();
  const locked = await lock(text, password);
  const up = await putBlob(owner, locked.bytes);
  assert(up.status === 201 || up.status === 200, 'blob upload failed: ' + JSON.stringify(up.json));
  const docId = newDocId();
  const record = createRecord(owner, locked, { docId, label: o.label, listed: o.listed, createdAt: o.createdAt });
  const res = await postDoc(owner, record);
  expectStatus(res, 201);
  return { docId, password, locked, record, recordHash: res.json.recordHash, res };
}

async function publishUpdate(owner, doc, text, o = {}) {
  const locked = await lock(text, doc.password);
  const up = await putBlob(owner, locked.bytes);
  assert(up.status === 201 || up.status === 200, 'blob upload failed: ' + JSON.stringify(up.json));
  const record = updateRecord(owner, locked, {
    docId: doc.docId,
    version: o.version ?? doc.version + 1,
    prev: o.prev ?? doc.recordHash,
    label: o.label
  });
  const res = await postDoc(owner, record);
  return { locked, record, res };
}

// ---------------------------------------------------------------------------
// chat

function messageRecord(author, channelId, body, o = {}) {
  return {
    v: 2,
    type: 'message',
    channelId,
    body,
    replyTo: o.replyTo ?? '',
    signer: author.keyId,
    createdAt: o.createdAt ?? Date.now(),
    nonce: newNonce()
  };
}

async function postMessage(author, channelId, body, o = {}) {
  const record = o.record || messageRecord(author, channelId, body, o);
  const signature = await signRecord((o.signWith || author).privateKey, record);
  const res = await call('POST', `/api/channels/${o.pathChannel || channelId}/messages`, { json: { record, signature } });
  return { res, record };
}

async function createChannel(creator, channelId, title, docId = '', o = {}) {
  const record = {
    v: 2,
    type: 'channel.create',
    channelId,
    title,
    docId,
    signer: creator.keyId,
    createdAt: o.createdAt ?? Date.now()
  };
  const signature = await signRecord(creator.privateKey, record);
  return call('POST', '/api/channels', { json: { record, signature } });
}

// ---------------------------------------------------------------------------

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY'
};

function assertSecurityHeaders(res, what) {
  for (const [k, v] of Object.entries(SECURITY)) eq(res.headers.get(k), v, `${what} header ${k}`);
  assert(!res.headers.get('access-control-allow-origin'), `${what} must not send CORS headers`);
}

// ---------------------------------------------------------------------------
// accounts: sign in with email and a code over the real endpoints (local echo mode only)

const ORIGIN = new URL(BASE).origin;
const REQUIRE_ACCOUNTS = process.argv.includes('--require-accounts');
const DAY = 24 * 60 * 60 * 1000;
let mailCount = 0;

// A random loopback address. Echo mode accepts any 127.x.y.z, and each one has its own rate limit buckets.
function loopback() {
  const n = () => Math.floor(Math.random() * 250) + 1;
  return `127.${n()}.${n()}.${n()}`;
}

function newEmail(tag = 'p') {
  mailCount++;
  return `e2e-${tag}-${RUN}-${mailCount}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

// A cookie jar for one "device".
class Jar {
  constructor() {
    this.cookies = new Map();
    this.raw = [];
  }
  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    this.raw = list;
    for (const c of list) {
      const [pair, ...attrs] = c.split(';').map((s) => s.trim());
      const eqAt = pair.indexOf('=');
      const name = pair.slice(0, eqAt);
      const value = pair.slice(eqAt + 1);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      if (value === '' || (maxAge && Number(maxAge.split('=')[1]) <= 0)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  clone() {
    const j = new Jar();
    for (const [k, v] of this.cookies) j.cookies.set(k, v);
    return j;
  }
}

// A call to an account endpoint. origin: undefined = the site's own origin, null = send none, string = send that.
// ip: undefined = a fresh loopback address, null = no CF-Connecting-IP header, string = that address.
// now: pretend time for the server (echo mode only).
async function acall(method, path, { json, jar, origin, ip, now, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (origin !== null && method !== 'GET' && method !== 'HEAD') h.Origin = origin || ORIGIN;
  if (ip !== null) h['CF-Connecting-IP'] = ip === undefined ? loopback() : ip;
  if (jar && jar.header()) h.Cookie = jar.header();
  if (now !== undefined) h['x-hrd-test-now'] = String(now);
  let body = raw;
  if (json !== undefined) {
    body = JSON.stringify(json);
    h['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });
  const text = await res.text();
  let parsed = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (jar) jar.absorb(res);
  return { status: res.status, headers: res.headers, json: parsed, text };
}

// Asks for a code and uses it. Returns { jar, account, isNew, email, ip }.
async function signInAs(email = newEmail(), { jar = new Jar(), now, ip = loopback() } = {}) {
  const req = await acall('POST', '/api/auth/request', { json: { email }, ip, now });
  expectStatus(req, 200);
  assert(/^[0-9]{6}$/.test(req.json.debugCode || ''), 'echo mode must return debugCode');
  const ver = await acall('POST', '/api/auth/verify', { json: { email, code: req.json.debugCode }, jar, ip, now });
  expectStatus(ver, 200);
  return { jar, account: ver.json.account, isNew: ver.json.isNew, email, ip };
}

// An identity record for a new key whose private part may be sent to the server.
async function exportableKey(name) {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: true });
  const publicJwk = await exportPublicJwk(publicKey);
  const keyId = await keyIdOf(publicJwk);
  const identityRecord = { v: 2, type: 'identity', publicKey: publicJwk, displayName: name, createdAt: Date.now() };
  const identitySignature = await signRecord(privateKey, identityRecord);
  const privateJwk = await exportPrivateJwk(privateKey);
  return { keyId, publicJwk, privateKey, identityRecord, identitySignature, privateJwk, name };
}

// A signer built from the key a server hands back (imported without the right to export it again).
async function personFromServerKey(body, name = 'Account key') {
  return { keyId: body.keyId, publicJwk: body.publicKey, privateKey: await importPrivateJwk(body.privateJwk, { extractable: false }), name };
}

async function accountChecks(ctx) {
  const health = await call('GET', '/api/health');
  const ready = health.json && health.json.accounts === true && health.json.mail === 'echo';
  if (!ready) {
    const why = `health says accounts: ${JSON.stringify(health.json && health.json.accounts)}, mail: ${JSON.stringify(health.json && health.json.mail)}`;
    if (REQUIRE_ACCOUNTS) {
      await check('accounts: the server runs with ACCOUNT_MASTER_KEY and MAIL_PROVIDER=echo', async () => {
        throw new Error(why);
      });
    } else {
      console.log(`SKIP accounts checks (${why}). Run against a local server with echo mail, or pass --require-accounts to make this a failure.`);
    }
    return;
  }

  await check('accounts: health reports mail echo and accounts on', async () => {
    eq(health.json.mail, 'echo', 'mail');
    eq(health.json.accounts, true, 'accounts');
  });

  await check('accounts: asking for a code validates the email (400 invalid_email)', async () => {
    for (const email of [undefined, '', 'nobody', 'a@b', 'a b@c.de', 'caf\u00e9@example.test', 'a@b.cc\r\nBcc: x@y.zz', 'x'.repeat(300) + '@example.test']) {
      const res = await acall('POST', '/api/auth/request', { json: { email } });
      expectStatus(res, 400, 'invalid_email');
    }
    expectStatus(await acall('POST', '/api/auth/request', { raw: '{nope', headers: { 'Content-Type': 'application/json' } }), 400);
  });

  await check('accounts: the answer is the same for a known and an unknown email', async () => {
    const known = await signInAs(newEmail('known'));
    const a = await acall('POST', '/api/auth/request', { json: { email: known.email } });
    const b = await acall('POST', '/api/auth/request', { json: { email: newEmail('unknown') } });
    eq(a.status, b.status, 'status');
    eq(JSON.stringify(Object.keys(a.json).sort()), JSON.stringify(Object.keys(b.json).sort()), 'fields');
    eq(a.json.cooldown, 30, 'cooldown');
  });

  let primary;
  await check('accounts: sign in creates an account and sets an HttpOnly session cookie', async () => {
    const email = newEmail('main');
    primary = await signInAs(email);
    eq(primary.isNew, true, 'isNew');
    eq(primary.account.displayName, null, 'displayName');
    assert(/^[a-z0-9]{2}\*\*\*@example\.test$/.test(primary.account.emailMasked), 'masked: ' + primary.account.emailMasked);
    assert(!JSON.stringify(primary.account).includes(email), 'the address must not come back');
    const cookie = primary.jar.raw[0] || '';
    assert(/^hrd_session=[A-Za-z0-9_-]{43};/.test(cookie), 'cookie: ' + cookie.replace(/=[A-Za-z0-9_-]{43}/, '=<token>'));
    for (const part of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) assert(cookie.includes(part), 'cookie lacks ' + part);
    assert(!/;\s*Secure/i.test(cookie), 'plain http must not set Secure');
    const me = await acall('GET', '/api/me', { jar: primary.jar });
    expectStatus(me, 200);
    eq(me.json.account.id, primary.account.id, 'account id');
    eq(JSON.stringify(me.json.keys), '[]', 'no keys yet');
    eq(me.headers.get('cache-control'), 'no-store', 'cache-control');
  });

  await check('accounts: signing in again with the same email finds the same account', async () => {
    const again = await signInAs(primary.email);
    eq(again.isNew, false, 'isNew');
    eq(again.account.id, primary.account.id, 'id');
  });

  await check('accounts: auth responses carry the security headers and no CORS headers', async () => {
    const res = await acall('GET', '/api/me', { jar: primary.jar });
    assertSecurityHeaders(res, 'GET /api/me');
    const bad = await acall('GET', '/api/me');
    expectStatus(bad, 401, 'unauthenticated');
    assertSecurityHeaders(bad, '401 /api/me');
    const post = await acall('POST', '/api/auth/request', { json: { email: newEmail() } });
    assertSecurityHeaders(post, 'POST /api/auth/request');
  });

  await check('accounts: a wrong code is 400 invalid_code, five wrong tries kill the code (429), even the right one', async () => {
    const email = newEmail('wrong');
    const ip = loopback();
    const req = await acall('POST', '/api/auth/request', { json: { email }, ip });
    const bad = req.json.debugCode === '000000' ? '000001' : '000000';
    const seen = [];
    for (let i = 0; i < 6; i++) {
      const res = await acall('POST', '/api/auth/verify', { json: { email, code: bad }, ip });
      seen.push(res.status + ':' + res.json.code);
    }
    eq(seen.join(','), '400:invalid_code,400:invalid_code,400:invalid_code,400:invalid_code,429:too_many_attempts,429:too_many_attempts', 'tries');
    const right = await acall('POST', '/api/auth/verify', { json: { email, code: req.json.debugCode }, ip });
    expectStatus(right, 429, 'too_many_attempts');
  });

  await check('accounts: a code is used once; a malformed code is 400 and not counted', async () => {
    const email = newEmail('once');
    const ip = loopback();
    const req = await acall('POST', '/api/auth/request', { json: { email }, ip });
    for (const code of [undefined, 123456, '12345', 'abcdef', '']) {
      expectStatus(await acall('POST', '/api/auth/verify', { json: { email, code }, ip }), 400, 'invalid_code');
    }
    expectStatus(await acall('POST', '/api/auth/verify', { json: { email, code: req.json.debugCode }, ip }), 200);
    expectStatus(await acall('POST', '/api/auth/verify', { json: { email, code: req.json.debugCode }, ip }), 400, 'code_expired');
  });

  await check('accounts: a code that ran out (10 minutes, test clock) is 400 code_expired', async () => {
    const email = newEmail('expired');
    const ip = loopback();
    const req = await acall('POST', '/api/auth/request', { json: { email }, ip, now: Date.now() - 11 * 60 * 1000 });
    expectStatus(req, 200);
    expectStatus(await acall('POST', '/api/auth/verify', { json: { email, code: req.json.debugCode }, ip }), 400, 'code_expired');
  });

  await check('accounts: a new code needs 30 seconds after the last (429 with Retry-After)', async () => {
    const email = newEmail('cool');
    expectStatus(await acall('POST', '/api/auth/request', { json: { email } }), 200);
    const second = await acall('POST', '/api/auth/request', { json: { email } });
    expectStatus(second, 429, 'rate_limited');
    const wait = Number(second.headers.get('retry-after'));
    assert(wait >= 1 && wait <= 30, 'Retry-After: ' + second.headers.get('retry-after'));
    // after the cooldown (test clock) a new code replaces the old one
    const t = Date.now() + 31 * 1000;
    const third = await acall('POST', '/api/auth/request', { json: { email }, now: t });
    expectStatus(third, 200);
    expectStatus(await acall('POST', '/api/auth/verify', { json: { email, code: third.json.debugCode }, now: t + 1000 }), 200);
  });

  await check('accounts: 5 codes an hour per email, then 429', async () => {
    const email = newEmail('hourly');
    const t0 = Date.now() - 20 * DAY;
    const seen = [];
    for (let i = 0; i < 6; i++) seen.push((await acall('POST', '/api/auth/request', { json: { email }, now: t0 + i * 31000 })).status);
    eq(seen.join(','), '200,200,200,200,200,429', 'statuses');
  });

  await check('accounts: 20 codes an hour per address, then 429', async () => {
    const ip = loopback();
    const t0 = Date.now() - 21 * DAY;
    const seen = [];
    for (let i = 0; i < 22; i++) seen.push((await acall('POST', '/api/auth/request', { json: { email: newEmail('ip') }, ip, now: t0 })).status);
    eq(seen.filter((s) => s === 200).length, 20, 'accepted: ' + seen.join());
    eq(seen[20] + ',' + seen[21], '429,429', 'the rest');
  });

  await check('accounts: 10 code checks per 10 minutes per address, then 429', async () => {
    const ip = loopback();
    const t0 = Date.now() - 22 * DAY;
    const seen = [];
    for (let i = 0; i < 12; i++) {
      const res = await acall('POST', '/api/auth/verify', { json: { email: newEmail('v'), code: '123456' }, ip, now: t0 });
      seen.push(res.json.code);
    }
    eq(seen.slice(0, 10).every((c) => c === 'code_expired'), true, 'first ten: ' + seen.join());
    eq(seen.slice(10).join(), 'rate_limited,rate_limited', 'last two');
  });

  await check('accounts: a session older than 30 days is not valid (test clock), the stale cookie is cleared', async () => {
    const old = await signInAs(newEmail('old'), { now: Date.now() - 31 * DAY });
    const res = await acall('GET', '/api/me', { jar: old.jar });
    expectStatus(res, 401, 'unauthenticated');
    assert(/Max-Age=0/.test(res.headers.get('set-cookie') || ''), 'the stale cookie should be cleared');
    expectStatus(await acall('GET', '/api/me', { jar: old.jar }), 401, 'unauthenticated');
  });

  await check('accounts: junk cookies are 401 and never a server error', async () => {
    for (const v of ['x', 'A'.repeat(43), 'A'.repeat(44), '%00', '../../x', 'A'.repeat(5000)]) {
      const res = await acall('GET', '/api/me', { headers: { Cookie: 'hrd_session=' + v } });
      eq(res.status, 401, 'cookie ' + v.slice(0, 20));
    }
    expectStatus(await acall('GET', '/api/me', { headers: { Cookie: '__Host-hrd_session=' + 'A'.repeat(43) } }), 401);
  });

  // ---- keys: with and without a server copy ----
  const named = await exportableKey('Easy Person ' + RUN);
  await check('accounts: POST /api/me/key with a cloud copy registers and links the key (201)', async () => {
    const res = await acall('POST', '/api/me/key', { jar: primary.jar, json: { record: named.identityRecord, signature: named.identitySignature, privateJwk: named.privateJwk } });
    expectStatus(res, 201);
    eq(res.json.keyId, named.keyId, 'keyId');
    assert(!res.text.includes(named.privateJwk.d), 'the private key must not come back here');
    const me = await acall('GET', '/api/me', { jar: primary.jar });
    eq(me.json.account.displayName, named.name, 'display name set from the key');
    eq(JSON.stringify(me.json.keys), JSON.stringify([{ keyId: named.keyId, hasCloudCopy: true }]), 'keys');
    // the identity is public through the open endpoint
    const pub = await call('GET', '/api/identities/' + named.keyId);
    expectStatus(pub, 200);
    eq(pub.json.displayName, named.name, 'public name');
  });

  await check('accounts: the same key again is a quiet 200, a second key is 409 key_exists', async () => {
    const again = await acall('POST', '/api/me/key', { jar: primary.jar, json: { record: named.identityRecord, signature: named.identitySignature, privateJwk: named.privateJwk } });
    expectStatus(again, 200);
    const other = await exportableKey('Second ' + RUN);
    for (const withCopy of [true, false]) {
      const res = await acall('POST', '/api/me/key', {
        jar: primary.jar,
        json: { record: other.identityRecord, signature: other.identitySignature, ...(withCopy ? { privateJwk: other.privateJwk } : {}) }
      });
      expectStatus(res, 409, 'key_exists');
    }
  });

  await check('accounts: a private key that does not belong to the public key is refused (400) and never echoed', async () => {
    const acct = await signInAs(newEmail('mismatch'));
    const k = await exportableKey('Mismatch ' + RUN);
    const other = await exportableKey('Other ' + RUN);
    const res = await acall('POST', '/api/me/key', { jar: acct.jar, json: { record: k.identityRecord, signature: k.identitySignature, privateJwk: { ...k.privateJwk, d: other.privateJwk.d } } });
    expectStatus(res, 400, 'bad_request');
    assert(!res.text.includes(other.privateJwk.d) && !res.text.includes(k.privateJwk.d), 'a private key leaked into an error');
    eq((await call('GET', '/api/identities/' + k.keyId)).status, 404, 'the identity must not be registered');
  });

  let second;
  await check('accounts: a second device (fresh cookie jar) signs in and gets the key back, which signs correctly', async () => {
    second = await signInAs(primary.email);
    eq(second.isNew, false, 'isNew');
    eq(second.account.displayName, named.name, 'name on the second device');
    const res = await acall('GET', '/api/me/key', { jar: second.jar });
    expectStatus(res, 200);
    eq(res.headers.get('cache-control'), 'no-store', 'cache-control');
    eq(res.json.keyId, named.keyId, 'keyId');
    eq(canonicalize(res.json.record), canonicalize(named.identityRecord), 'record');
    eq(res.json.signature, named.identitySignature, 'signature');
    eq(res.json.privateJwk.d, named.privateJwk.d, 'private key');
    const person = await personFromServerKey(res.json, named.name);
    const probe = { v: 2, type: 'message', note: 'probe' };
    assert(await verifyRecordFor(person, probe), 'the key from the server does not sign correctly');
    ctx.accountPerson = person;
  });

  async function verifyRecordFor(person, record) {
    return verifyRecord(person.publicJwk, record, await signRecord(person.privateKey, record));
  }

  let channelId;
  await check('accounts: the key from the server can post to a chat and the room shows the preview', async () => {
    channelId = 'e2e-acct-' + RUN;
    expectStatus(await createChannel(ctx.accountPerson, channelId, 'Account room ' + RUN), 201);
    const { res } = await postMessage(ctx.accountPerson, channelId, 'hello from the account\nsecond line   with  blanks');
    expectStatus(res, 201);
    const list = await call('GET', '/api/channels?limit=200');
    const row = list.json.channels.find((c) => c.channelId === channelId);
    assert(row, 'channel in the list');
    eq(row.lastText, 'hello from the account second line with blanks', 'lastText');
    eq(row.lastSignerName, named.name, 'lastSignerName');
    const long = await postMessage(ctx.accountPerson, channelId, 'z'.repeat(400));
    expectStatus(long.res, 201);
    const after = (await call('GET', '/api/channels?limit=200')).json.channels.find((c) => c.channelId === channelId);
    eq(after.lastText, 'z'.repeat(140), 'lastText is cut at 140');
    eq(after.messageCount, 2, 'messageCount');
  });

  await check('accounts: without a cloud copy the key is registered but not stored (404 on GET /api/me/key)', async () => {
    const acct = await signInAs(newEmail('nocopy'));
    const k = await exportableKey('No Copy ' + RUN);
    expectStatus(await acall('POST', '/api/me/key', { jar: acct.jar, json: { record: k.identityRecord, signature: k.identitySignature } }), 201);
    const me = await acall('GET', '/api/me', { jar: acct.jar });
    eq(JSON.stringify(me.json.keys), JSON.stringify([{ keyId: k.keyId, hasCloudCopy: false }]), 'keys');
    expectStatus(await acall('GET', '/api/me/key', { jar: acct.jar }), 404, 'not_found');
  });

  await check('accounts: guests still register with POST /api/identities (no cookie, no Origin) and can post', async () => {
    const guest = await newPerson('Guest');
    const { res } = await postMessage(guest, channelId, 'a guest speaks');
    expectStatus(res, 201);
    const withCookie = await makeIdentity('Guest cookie ' + RUN);
    const reg = await fetch(BASE + '/api/identities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp(), Cookie: primary.jar.header() },
      body: JSON.stringify({ record: withCookie.identityRecord, signature: withCookie.identitySignature })
    });
    eq(reg.status, 201, 'the open endpoint ignores cookies');
    const me = await acall('GET', '/api/me', { jar: primary.jar });
    eq(me.json.keys.length, 1, 'the guest key is not linked to the account');
  });

  // ---- documents, stored passwords, My files ----
  let mine;
  let hidden;
  await check('accounts: documents published with the account key show up in GET /api/me/documents (listed and unlisted)', async () => {
    mine = await publishNew(ctx.accountPerson, 'account file ' + RUN, { label: 'Account file ' + RUN, listed: true });
    hidden = await publishNew(ctx.accountPerson, 'hidden file ' + RUN, { label: 'Hidden file ' + RUN, listed: false });
    const other = await newPerson('Other publisher');
    const foreign = await publishNew(other, 'foreign ' + RUN, { label: 'Foreign ' + RUN });
    const res = await acall('GET', '/api/me/documents', { jar: second.jar });
    expectStatus(res, 200);
    const ids = res.json.documents.map((d) => d.docId);
    assert(ids.includes(mine.docId) && ids.includes(hidden.docId), 'both documents are listed for the owner');
    assert(!ids.includes(foreign.docId), 'a foreign document must not be listed');
    const hiddenRow = res.json.documents.find((d) => d.docId === hidden.docId);
    eq(hiddenRow.listed, false, 'listed flag');
    eq(hiddenRow.ownerKeyId, named.keyId, 'owner');
    eq(hiddenRow.headVersion, 1, 'headVersion');
    const pub = await call('GET', '/api/documents?owner=' + named.keyId);
    assert(!pub.json.documents.some((d) => d.docId === hidden.docId), 'the public list must not show the unlisted one');
    for (let i = 1; i < res.json.documents.length; i++) {
      assert(res.json.documents[i - 1].updatedAt >= res.json.documents[i].updatedAt, 'newest update first');
    }
    expectStatus(await acall('GET', '/api/me/documents?limit=0', { jar: second.jar }), 400);
    expectStatus(await acall('GET', '/api/me/documents'), 401);
  });

  await check('accounts: document passwords are stored for the owner and read back on another device', async () => {
    const put = await acall('PUT', `/api/me/secrets/${mine.docId}`, { jar: primary.jar, json: { password: mine.password } });
    expectStatus(put, 200);
    const third = await signInAs(primary.email);
    const got = await acall('GET', `/api/me/secrets/${mine.docId}`, { jar: third.jar });
    expectStatus(got, 200);
    eq(got.json.password, mine.password, 'password');
    eq(got.headers.get('cache-control'), 'no-store', 'cache-control');
    // the stored password opens the stored file
    const blob = await call('GET', '/api/blobs/' + mine.locked.blobHash);
    const opened = await unlockFile(blob.bytes, got.json.password);
    eq(new TextDecoder().decode(opened.data), 'account file ' + RUN, 'file content');
    expectStatus(await acall('GET', `/api/me/secrets/${hidden.docId}`, { jar: third.jar }), 404, 'not_found');
  });

  await check('accounts: passwords can only be stored for documents the account owns, and must look like passwords', async () => {
    const stranger = await newPerson('Stranger docs');
    const foreign = await publishNew(stranger, 'not yours ' + RUN);
    expectStatus(await acall('PUT', `/api/me/secrets/${foreign.docId}`, { jar: primary.jar, json: { password: 'ABCD-EFGH-JKLM-NPQR-STUV' } }), 403, 'not_owner');
    expectStatus(await acall('PUT', `/api/me/secrets/${newDocId()}`, { jar: primary.jar, json: { password: 'ABCD' } }), 404, 'not_found');
    expectStatus(await acall('PUT', '/api/me/secrets/not-an-id', { jar: primary.jar, json: { password: 'ABCD' } }), 400);
    for (const password of [undefined, '', 'x'.repeat(129), 'caf\u00e9', 'two\nlines']) {
      expectStatus(await acall('PUT', `/api/me/secrets/${mine.docId}`, { jar: primary.jar, json: { password } }), 400);
    }
    expectStatus(await acall('GET', `/api/me/secrets/${foreign.docId}`, { jar: primary.jar }), 404);
    // someone else's account can not read this account's password
    const other = await signInAs(newEmail('snoop'));
    expectStatus(await acall('GET', `/api/me/secrets/${mine.docId}`, { jar: other.jar }), 404);
    expectStatus(await acall('GET', `/api/me/secrets/${mine.docId}`), 401);
  });

  // ---- strict mode ----
  await check('accounts: strict mode hands the stored passwords over until the client confirms, drops the key copy and blocks new ones', async () => {
    const on = await acall('POST', '/api/me/strict', { jar: primary.jar, json: { enabled: true } });
    expectStatus(on, 200);
    eq(on.json.strict, true, 'strict');
    eq(JSON.stringify(on.json.passwords), JSON.stringify([{ docId: mine.docId, password: mine.password }]), 'passwords');
    const me = await acall('GET', '/api/me', { jar: primary.jar });
    eq(me.json.account.strict, true, 'account.strict');
    eq(me.json.keys[0].hasCloudCopy, false, 'the copy is gone');
    expectStatus(await acall('GET', '/api/me/key', { jar: primary.jar }), 409, 'strict_mode');
    expectStatus(await acall('GET', `/api/me/secrets/${mine.docId}`, { jar: primary.jar }), 404, 'not_found');
    expectStatus(await acall('PUT', `/api/me/secrets/${mine.docId}`, { jar: primary.jar, json: { password: mine.password } }), 409, 'strict_mode');
    eq(on.json.next, null, 'one page is all there is');
    // an answer that got lost costs nothing: asking again hands the same passwords over
    const again = await acall('POST', '/api/me/strict', { jar: primary.jar, json: { enabled: true } });
    eq(JSON.stringify(again.json.passwords), JSON.stringify(on.json.passwords), 'asked again');
    // the client confirms what it stored, only that is deleted
    const done = await acall('POST', '/api/me/strict', { jar: primary.jar, json: { enabled: true, confirmThrough: mine.docId } });
    expectStatus(done, 200);
    eq(done.json.remaining, 0, 'remaining');
    const gone = await acall('POST', '/api/me/strict', { jar: primary.jar, json: { enabled: true } });
    eq(JSON.stringify(gone.json.passwords), '[]', 'nothing left to return');
    // the account still sees its files, and the key it already published with
    const docs = await acall('GET', '/api/me/documents', { jar: primary.jar });
    assert(docs.json.documents.some((d) => d.docId === mine.docId), 'My files still lists the document');
  });

  await check('accounts: a strict account registers keys without a copy (up to 5) and refuses a private key', async () => {
    const withCopy = await exportableKey('Strict copy ' + RUN);
    const refused = await acall('POST', '/api/me/key', { jar: primary.jar, json: { record: withCopy.identityRecord, signature: withCopy.identitySignature, privateJwk: withCopy.privateJwk } });
    expectStatus(refused, 409, 'strict_mode');
    assert(!refused.text.includes(withCopy.privateJwk.d), 'the private key must not be echoed');
    let accepted = 0;
    for (let i = 0; i < 5; i++) {
      const k = await exportableKey(`Strict device ${i} ${RUN}`);
      const res = await acall('POST', '/api/me/key', { jar: primary.jar, json: { record: k.identityRecord, signature: k.identitySignature } });
      if (res.status === 201) accepted++;
      else expectStatus(res, 409);
    }
    eq(accepted, 4, 'one key existed, so 4 more fit under the limit of 5');
    const me = await acall('GET', '/api/me', { jar: primary.jar });
    eq(me.json.keys.length, 5, 'five keys');
  });

  await check('accounts: turning strict off only flips the flag; a new key with a copy can be registered', async () => {
    const off = await acall('POST', '/api/me/strict', { jar: primary.jar, json: { enabled: false } });
    expectStatus(off, 200);
    eq(off.json.strict, false, 'strict');
    const fresh = await signInAs(newEmail('flip'));
    expectStatus(await acall('POST', '/api/me/strict', { jar: fresh.jar, json: { enabled: true } }), 200);
    expectStatus(await acall('POST', '/api/me/strict', { jar: fresh.jar, json: { enabled: false } }), 200);
    const k = await exportableKey('After flip ' + RUN);
    expectStatus(await acall('POST', '/api/me/key', { jar: fresh.jar, json: { record: k.identityRecord, signature: k.identitySignature, privateJwk: k.privateJwk } }), 201);
    const got = await acall('GET', '/api/me/key', { jar: fresh.jar });
    expectStatus(got, 200);
    eq(got.json.keyId, k.keyId, 'keyId');
    for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }]) expectStatus(await acall('POST', '/api/me/strict', { jar: fresh.jar, json: body }), 400);
  });

  // ---- CSRF ----
  await check('accounts: a cookie authenticated write without the site\'s own Origin is 403 forbidden', async () => {
    const acct = await signInAs(newEmail('csrf'));
    const docId = newDocId();
    const cases = [
      ['POST', '/api/me/key', { record: {}, signature: 'x' }],
      ['POST', '/api/me/strict', { enabled: true }],
      ['PUT', `/api/me/secrets/${docId}`, { password: 'ABCD' }],
      ['DELETE', '/api/me', undefined],
      ['POST', '/api/auth/logout', {}]
    ];
    for (const [method, path, json] of cases) {
      // (wrangler's local proxy rewrites an https Origin for its own host to http, so that variant is only in the unit tests)
      for (const origin of [null, 'https://evil.example', 'null', ORIGIN + '.evil.example']) {
        const res = await acall(method, path, { jar: acct.jar, json, origin });
        eq(res.status, 403, `${method} ${path} origin ${origin}`);
        eq(res.json && res.json.code, 'forbidden', 'code');
      }
    }
    // the session is untouched by all of that
    expectStatus(await acall('GET', '/api/me', { jar: acct.jar }), 200);
    // sign in and code requests need the Origin as well
    expectStatus(await acall('POST', '/api/auth/request', { json: { email: newEmail() }, origin: 'https://evil.example' }), 403, 'forbidden');
    expectStatus(await acall('POST', '/api/auth/verify', { json: { email: newEmail(), code: '123456' }, origin: null }), 403, 'forbidden');
    // reads need none
    expectStatus(await acall('GET', '/api/me/documents', { jar: acct.jar, origin: 'https://evil.example' }), 200);
  });

  await check('accounts: the echo mode is refused when the request is not from this machine', async () => {
    const email = newEmail('guard');
    const viaEdge = await acall('POST', '/api/auth/request', { json: { email }, ip: '203.0.113.77' });
    expectStatus(viaEdge, 503, 'mail_unavailable');
    assert(!viaEdge.text.includes('debugCode'), 'no code outside loopback');
    const withRay = await acall('POST', '/api/auth/request', { json: { email }, headers: { 'cf-ray': '8f1c2d3e4f5a6b7c-FRA' } });
    expectStatus(withRay, 503, 'mail_unavailable');
    const v6 = await acall('POST', '/api/auth/request', { json: { email }, ip: '2001:db8::5' });
    expectStatus(v6, 503, 'mail_unavailable');
    // and the test clock is ignored on such a request, so it can not be used to age a code
    const real = await acall('POST', '/api/auth/request', { json: { email: newEmail('guard2') } });
    expectStatus(real, 200);
    const health2 = await acall('GET', '/api/health', { ip: '203.0.113.77' });
    eq(health2.json.mail, 'none', 'health mail seen from outside');
    eq(health2.json.mailConfigured, 'echo', 'health mailConfigured');
  });

  // ---- logout and delete ----
  await check('accounts: logout ends the session and clears the cookie; the old cookie stops working', async () => {
    const acct = await signInAs(newEmail('logout'));
    const old = acct.jar.clone();
    const out = await acall('POST', '/api/auth/logout', { jar: acct.jar });
    expectStatus(out, 200);
    eq(out.json.ok, true, 'ok');
    assert(/Max-Age=0/.test(out.headers.get('set-cookie') || ''), 'cookie cleared');
    eq(acct.jar.header(), '', 'jar emptied');
    expectStatus(await acall('GET', '/api/me', { jar: old }), 401, 'unauthenticated');
    expectStatus(await acall('POST', '/api/auth/logout', { jar: new Jar() }), 200);
  });

  await check('accounts: logout only ends its own session', async () => {
    const email = newEmail('twice');
    const a = await signInAs(email);
    const b = await signInAs(email);
    expectStatus(await acall('POST', '/api/auth/logout', { jar: a.jar }), 200);
    expectStatus(await acall('GET', '/api/me', { jar: b.jar }), 200);
  });

  await check('accounts: logout with all:true ends every session of the account; the sessions list shows them and ends one', async () => {
    const email = newEmail('everywhere');
    const a = await signInAs(email);
    const b = await signInAs(email);
    const c = await signInAs(email);
    const list = await acall('GET', '/api/me/sessions', { jar: a.jar });
    expectStatus(list, 200);
    eq(list.json.sessions.length, 3, 'sessions');
    eq(list.json.sessions.filter((x) => x.current).length, 1, 'current');
    const other = list.json.sessions.find((x) => !x.current);
    expectStatus(await acall('DELETE', '/api/me/sessions/' + other.id, { jar: a.jar }), 200);
    eq((await acall('GET', '/api/me/sessions', { jar: a.jar })).json.sessions.length, 2, 'after ending one');
    const out = await acall('POST', '/api/auth/logout', { jar: a.jar, json: { all: true } });
    expectStatus(out, 200);
    eq(out.json.ended, 2, 'ended');
    for (const jar of [a.jar, b.jar, c.jar]) expectStatus(await acall('GET', '/api/me', { jar: jar.clone() }), 401, 'unauthenticated');
  });

  await check('accounts: a session ends 90 days after it was made even when it is used every day', async () => {
    const t = Date.now();
    const s = await signInAs(newEmail('forever'), { now: t });
    let alive = 0;
    for (let day = 1; day <= 120; day++) {
      const res = await acall('GET', '/api/me', { jar: s.jar, now: t + day * DAY });
      if (res.status !== 200) break;
      alive = day;
    }
    assert(alive >= 89 && alive <= 90, 'alive for ' + alive + ' days');
  });

  await check('accounts: the stored key, Strict and deleting the account need a session made in the last 15 minutes (401 reauth_required)', async () => {
    const t = Date.now();
    const s = await signInAs(newEmail('stepup'), { now: t });
    const k = await exportableKey('Step ' + RUN);
    expectStatus(await acall('POST', '/api/me/key', { jar: s.jar, now: t, json: { record: k.identityRecord, signature: k.identitySignature, privateJwk: k.privateJwk } }), 201);
    const later = t + 20 * DAY;
    const key = await acall('GET', '/api/me/key', { jar: s.jar, now: later });
    expectStatus(key, 401, 'reauth_required');
    assert(!key.text.includes(k.privateJwk.d), 'the key must not come back');
    expectStatus(await acall('POST', '/api/me/strict', { jar: s.jar, now: later, json: { enabled: true } }), 401, 'reauth_required');
    expectStatus(await acall('DELETE', '/api/me', { jar: s.jar, now: later }), 401, 'reauth_required');
    // a fresh code with the old cookie replaces the old session, and then all three work
    const asked = await acall('POST', '/api/auth/request', { json: { email: s.email }, now: later });
    expectStatus(asked, 200);
    expectStatus(await acall('POST', '/api/auth/verify', { jar: s.jar, now: later + 1000, json: { email: s.email, code: asked.json.debugCode } }), 200);
    expectStatus(await acall('GET', '/api/me/key', { jar: s.jar, now: later + 2000 }), 200);
  });

  await check('accounts: deleting the account removes it, ends every session and keeps the public history', async () => {
    const email = newEmail('delete');
    const a = await signInAs(email);
    const b = await signInAs(email);
    const k = await exportableKey('Leaver ' + RUN);
    expectStatus(await acall('POST', '/api/me/key', { jar: a.jar, json: { record: k.identityRecord, signature: k.identitySignature, privateJwk: k.privateJwk } }), 201);
    const person = await personFromServerKey((await acall('GET', '/api/me/key', { jar: b.jar })).json);
    const doc = await publishNew(person, 'leaver file ' + RUN, { label: 'Leaver ' + RUN });
    expectStatus(await acall('PUT', `/api/me/secrets/${doc.docId}`, { jar: a.jar, json: { password: doc.password } }), 200);
    const del = await acall('DELETE', '/api/me', { jar: a.jar });
    expectStatus(del, 200);
    eq(del.json.ok, true, 'ok');
    expectStatus(await acall('GET', '/api/me', { jar: a.jar }), 401);
    expectStatus(await acall('GET', '/api/me', { jar: b.jar }), 401, 'unauthenticated');
    // the signed history stays
    expectStatus(await call('GET', '/api/identities/' + k.keyId), 200);
    const bundle = await call('GET', '/api/documents/' + doc.docId);
    expectStatus(bundle, 200);
    // signing in again makes a new, empty account
    const again = await signInAs(email);
    eq(again.isNew, true, 'isNew');
    assert(again.account.id !== a.account.id, 'new id');
    expectStatus(await acall('GET', `/api/me/secrets/${doc.docId}`, { jar: again.jar }), 404);
    eq(JSON.stringify((await acall('GET', '/api/me/documents', { jar: again.jar })).json.documents), '[]', 'no files');
  });

  await check('accounts: wrong methods and unknown account routes answer in JSON', async () => {
    expectStatus(await acall('GET', '/api/auth/request'), 405);
    expectStatus(await acall('PUT', '/api/me', { jar: primary.jar }), 405);
    expectStatus(await acall('GET', '/api/me/strict', { jar: primary.jar }), 405);
    expectStatus(await acall('GET', '/api/me/nothing', { jar: primary.jar }), 404, 'not_found');
    expectStatus(await acall('POST', '/api/auth/request', { raw: 'x'.repeat(70000), headers: { 'Content-Type': 'application/json' } }), 413, 'too_large');
  });
}

async function main() {
  console.log(`e2e run ${RUN} against ${BASE}`);
  const ctx = {};

  // ---- basics ----
  await check('health answers ok', async () => {
    const res = await call('GET', '/api/health');
    expectStatus(res, 200);
    eq(res.json.ok, true, 'ok');
  });

  await check('server key is published and its id matches the key', async () => {
    const res = await call('GET', '/api/server-key');
    expectStatus(res, 200);
    eq(res.json.signing, true, 'signing');
    eq(await keyIdOf(res.json.publicKey), res.json.keyId, 'keyId');
    ctx.server = res.json;
  });
  const pinned = ctx.server ? ctx.server.keyId : null;

  // ---- identities ----
  let alice;
  await check('register an identity (201)', async () => {
    alice = await newPerson('Alice');
  });

  await check('registering the same key again is idempotent and the first name stays', async () => {
    const again = {
      ...alice,
      identityRecord: { ...alice.identityRecord, displayName: 'Renamed ' + RUN, createdAt: Date.now() }
    };
    again.identitySignature = await signRecord(alice.privateKey, again.identityRecord);
    const res = await call('POST', '/api/identities', {
      json: { record: again.identityRecord, signature: again.identitySignature },
      ip: nextIp()
    });
    expectStatus(res, 200);
    eq(res.json.existed, true, 'existed');
    const got = await call('GET', '/api/identities/' + alice.keyId);
    expectStatus(got, 200);
    eq(got.json.displayName, alice.name, 'displayName');
  });

  await check('an identity with a bad self signature is rejected (400 bad_signature)', async () => {
    const victim = await makeIdentity('Victim ' + RUN);
    const other = await makeIdentity('Other ' + RUN);
    const sig = await signRecord(other.privateKey, victim.identityRecord);
    const res = await call('POST', '/api/identities', { json: { record: victim.identityRecord, signature: sig }, ip: nextIp() });
    expectStatus(res, 400, 'bad_signature');
    const after = await call('GET', '/api/identities/' + victim.keyId);
    expectStatus(after, 404, 'not_found');
  });

  await check('GET identity returns a verifiable self signed record', async () => {
    const res = await call('GET', '/api/identities/' + alice.keyId);
    expectStatus(res, 200);
    eq(res.json.keyId, alice.keyId, 'keyId');
    eq(await keyIdOf(res.json.publicKey), alice.keyId, 'public key matches');
    eq(res.json.record.displayName, alice.name, 'record name');
  });

  await check('identity input is validated (bad key id 400, unknown 404, junk record 400)', async () => {
    expectStatus(await call('GET', '/api/identities/nothex'), 400, 'bad_request');
    expectStatus(await call('GET', '/api/identities/' + '1'.repeat(64)), 404, 'not_found');
    const junk = await call('POST', '/api/identities', { json: { record: { type: 'identity' }, signature: 'x' }, ip: nextIp() });
    expectStatus(junk, 400, 'bad_request');
    const wrongType = await call('POST', '/api/identities', {
      json: { record: { v: 2, type: 'message' }, signature: 'x'.repeat(86) },
      ip: nextIp()
    });
    expectStatus(wrongType, 400, 'bad_request');
  });

  await check('identity creation is limited per address (11th from one address gets 429)', async () => {
    const ip = `172.31.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
    let limited = 0;
    let created = 0;
    for (let i = 0; i < 11; i++) {
      const id = await makeIdentity(`Burst ${i} ${RUN}`);
      const res = await call('POST', '/api/identities', {
        json: { record: id.identityRecord, signature: id.identitySignature },
        ip
      });
      if (res.status === 201) created++;
      else if (res.status === 429) {
        limited++;
        eq(res.json.code, 'rate_limited', 'code');
        assert(Number(res.headers.get('retry-after')) >= 1, 'Retry-After header');
      } else throw new Error('unexpected status ' + res.status);
    }
    eq(created, 10, 'created');
    eq(limited, 1, 'limited');
  });

  // ---- blobs ----
  const password = generatePassword();
  let locked1;
  await check('blob: upload with a bad signature is refused (400 bad_signature)', async () => {
    locked1 = await lock('first version of the paper', password);
    const stranger = await makeIdentity('Stranger ' + RUN);
    const res = await putBlob(alice, locked1.bytes, { signWith: stranger });
    expectStatus(res, 400, 'bad_signature');
  });

  await check('blob: bytes that do not match the signed hash are refused (400 bad_request)', async () => {
    const other = await lock('some other content', password);
    // Signed for other.bytes' hash, but the body is locked1.bytes.
    const hash = await sha256Hex(other.bytes);
    const record = { v: 2, type: 'blob.put', hash, size: locked1.bytes.length, signer: alice.keyId, createdAt: Date.now() };
    const signature = await signRecord(alice.privateKey, record);
    const res = await call('PUT', '/api/blobs/' + hash, {
      headers: { 'x-hrd-key': alice.keyId, 'x-hrd-time': String(record.createdAt), 'x-hrd-sig': signature },
      body: locked1.bytes
    });
    expectStatus(res, 400, 'bad_request');
    const gone = await call('GET', '/api/blobs/' + hash);
    expectStatus(gone, 404, 'not_found');
  });

  await check('blob: a wrong signed size is refused (400)', async () => {
    const res = await putBlob(alice, locked1.bytes, { signSize: locked1.bytes.length + 1 });
    assert(res.status === 400, 'expected 400, got ' + res.status);
    assert(['bad_signature', 'bad_request'].includes(res.json.code), 'code ' + (res.json && res.json.code));
  });

  await check('blob: missing headers are refused (400)', async () => {
    const res = await call('PUT', '/api/blobs/' + '2'.repeat(64), { body: new Uint8Array([1, 2, 3]) });
    expectStatus(res, 400, 'bad_request');
  });

  await check('blob: an upload over the size limit is refused (413 too_large)', async () => {
    const big = new Uint8Array(LIMITS.MAX_BLOB_BYTES + 1);
    const hash = '3'.repeat(64);
    // The size is outside what a signed blob.put may carry, so the server must say too_large
    // from the Content-Length alone, whatever the signature says.
    const record = { v: 2, type: 'blob.put', hash, size: 1, signer: alice.keyId, createdAt: Date.now() };
    const signature = await signRecord(alice.privateKey, record);
    const res = await call('PUT', '/api/blobs/' + hash, {
      headers: { 'x-hrd-key': alice.keyId, 'x-hrd-time': String(record.createdAt), 'x-hrd-sig': signature },
      body: big
    });
    expectStatus(res, 413, 'too_large');
    const got = await call('GET', '/api/blobs/' + hash);
    expectStatus(got, 404, 'not_found');
  });

  await check('blob: an unknown signer is refused (403 unknown_signer)', async () => {
    const nobody = await makeIdentity('Nobody ' + RUN);
    const res = await putBlob(nobody, locked1.bytes);
    expectStatus(res, 403, 'unknown_signer');
  });

  await check('blob: an old signed time is refused (400 expired)', async () => {
    const res = await putBlob(alice, locked1.bytes, { time: Date.now() - 10 * 60 * 1000 });
    expectStatus(res, 400, 'expired');
    const future = await putBlob(alice, locked1.bytes, { time: Date.now() + 10 * 60 * 1000 });
    expectStatus(future, 400, 'expired');
  });

  await check('blob: a bad hash in the address is refused (400)', async () => {
    expectStatus(await call('GET', '/api/blobs/xyz'), 400, 'bad_request');
    expectStatus(await call('GET', '/api/blobs/' + 'A'.repeat(64)), 400, 'bad_request');
  });

  await check('blob: upload works (201) and repeating it says exists (200)', async () => {
    const res = await putBlob(alice, locked1.bytes);
    expectStatus(res, 201);
    eq(res.json.hash, locked1.blobHash, 'hash');
    eq(res.json.size, locked1.size, 'size');
    const again = await putBlob(alice, locked1.bytes);
    expectStatus(again, 200);
    eq(again.json.exists, true, 'exists');
  });

  await check('blob: GET returns the bytes with the right headers, HEAD and 304 work', async () => {
    const res = await call('GET', '/api/blobs/' + locked1.blobHash);
    expectStatus(res, 200);
    eq(await sha256Hex(res.bytes), locked1.blobHash, 'sha256 of the download');
    eq(res.headers.get('content-type'), 'application/octet-stream', 'content-type');
    assert((res.headers.get('content-disposition') || '').startsWith('attachment'), 'content-disposition');
    const cc = res.headers.get('cache-control') || '';
    assert(cc.includes('public') && cc.includes('max-age=31536000') && cc.includes('immutable'), 'cache-control ' + cc);
    eq(res.headers.get('etag'), `"${locked1.blobHash}"`, 'etag');
    eq(res.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
    const head = await fetch(BASE + '/api/blobs/' + locked1.blobHash, { method: 'HEAD' });
    eq(head.status, 200, 'HEAD status');
    eq(head.headers.get('etag'), `"${locked1.blobHash}"`, 'HEAD etag');
    eq(head.headers.get('content-length'), String(locked1.size), 'HEAD length');
    const cached = await fetch(BASE + '/api/blobs/' + locked1.blobHash, { headers: { 'If-None-Match': `"${locked1.blobHash}"` } });
    eq(cached.status, 304, '304 status');
    await cached.arrayBuffer();
    const missing = await call('GET', '/api/blobs/' + '4'.repeat(64));
    expectStatus(missing, 404, 'not_found');
    eq(missing.headers.get('cache-control'), 'no-store', 'a missing file must not be cached');
  });

  // ---- documents ----
  const doc = { docId: newDocId(), password, version: 1 };
  await check('document: create (201) with ledger position and summary', async () => {
    const record = createRecord(alice, locked1, { docId: doc.docId, label: `Contract ${RUN}` });
    const res = await postDoc(alice, record);
    expectStatus(res, 201);
    eq(res.json.recordHash, await recordHash(record), 'recordHash');
    assert(res.json.ledgerSeq >= 1, 'ledgerSeq');
    eq(res.json.document.docId, doc.docId, 'docId');
    eq(res.json.document.ownerKeyId, alice.keyId, 'owner');
    eq(res.json.document.status, 'active', 'status');
    eq(res.json.document.headVersion, 1, 'headVersion');
    eq(res.json.document.listed, true, 'listed');
    doc.recordHash = res.json.recordHash;
    doc.ledgerSeq = res.json.ledgerSeq;
    doc.record = record;
  });

  await check('document: creating the same id again is refused (409 exists)', async () => {
    const record = createRecord(alice, locked1, { docId: doc.docId, label: 'again' });
    expectStatus(await postDoc(alice, record), 409, 'exists');
  });

  await check('document: create without an uploaded file is refused (400)', async () => {
    const orphan = await lock('never uploaded ' + RUN, password);
    const record = createRecord(alice, orphan, { docId: newDocId() });
    expectStatus(await postDoc(alice, record), 400, 'bad_request');
  });

  await check('document: create with a wrong size for the uploaded file is refused (400)', async () => {
    const record = createRecord(alice, locked1, { docId: newDocId() });
    record.blob.size = locked1.size + 1;
    expectStatus(await postDoc(alice, record), 400, 'bad_request');
  });

  await check('document: record input is validated (address mismatch, bad signature, unknown signer, old time)', async () => {
    const mk = () => createRecord(alice, locked1, { docId: newDocId() });
    // address does not match record.docId
    const r1 = mk();
    expectStatus(await postDoc(alice, r1, { docId: newDocId() }), 400, 'bad_request');
    // bad docId in address
    expectStatus(await postDoc(alice, mk(), { docId: 'nothex' }), 400, 'bad_request');
    // signed by another key
    const stranger = await makeIdentity('Stranger2 ' + RUN);
    expectStatus(await postDoc(alice, mk(), { signWith: stranger }), 400, 'bad_signature');
    // signer not registered
    const ghost = await makeIdentity('Ghost ' + RUN);
    const r2 = mk();
    r2.signer = ghost.keyId;
    expectStatus(await postDoc(ghost, r2), 403, 'unknown_signer');
    // time too far from the server clock
    const r3 = mk();
    r3.createdAt = Date.now() - 11 * 60 * 1000;
    expectStatus(await postDoc(alice, r3), 400, 'expired');
    const r4 = mk();
    r4.createdAt = Date.now() + 11 * 60 * 1000;
    expectStatus(await postDoc(alice, r4), 400, 'expired');
    // extra field is refused
    const r5 = mk();
    r5.extra = 'x';
    expectStatus(await postDoc(alice, r5), 400, 'bad_request');
    // wrong record type for the route
    const r6 = { v: 2, type: 'message', channelId: 'abc', body: 'x', replyTo: '', signer: alice.keyId, createdAt: Date.now(), nonce: newNonce() };
    expectStatus(await postDoc(alice, r6, { docId: newDocId() }), 400, 'bad_request');
  });

  let locked2;
  let locked3;
  await check('document: two updates (201)', async () => {
    const u2 = await publishUpdate(alice, doc, 'second version of the paper', { label: `Contract ${RUN} v2` });
    expectStatus(u2.res, 201);
    eq(u2.res.json.document.headVersion, 2, 'headVersion');
    locked2 = u2.locked;
    doc.recordHash = u2.res.json.recordHash;
    doc.version = 2;
    const u3 = await publishUpdate(alice, doc, 'third version of the paper', { label: `Contract ${RUN} v3` });
    expectStatus(u3.res, 201);
    eq(u3.res.json.document.headVersion, 3, 'headVersion');
    assert(u3.res.json.ledgerSeq > u2.res.json.ledgerSeq, 'ledger seq grows');
    locked3 = u3.locked;
    doc.recordHash = u3.res.json.recordHash;
    doc.version = 3;
  });

  let bundle;
  await check('document: the bundle verifies with the pinned server key and is anchored', async () => {
    const res = await call('GET', '/api/documents/' + doc.docId);
    expectStatus(res, 200);
    bundle = res.json;
    eq(bundle.records.length, 3, 'record count');
    eq(bundle.document.headVersion, 3, 'headVersion');
    eq(bundle.document.headRecordHash, doc.recordHash, 'headRecordHash');
    assert(bundle.headCheckpoint && bundle.checkpoint && bundle.server, 'checkpoints and server key present');
    eq(bundle.headCheckpoint.payload.scope, 'doc:' + doc.docId, 'headCheckpoint scope');
    const v = await verifyDocumentBundle(bundle, { pinnedServerKeyId: pinned, expectedDocId: doc.docId });
    assert(v.ok, 'verification failed: ' + JSON.stringify(v.checks.filter((c) => !c.ok)));
    eq(v.anchored, true, 'anchored');
    eq(v.status, 'active', 'status');
    eq(v.head.version, 3, 'head version');
    eq(v.head.signerName, alice.name, 'signer name');
  });

  await check('document: a wrong pinned key or a changed bundle fails verification', async () => {
    const wrongPin = await verifyDocumentBundle(bundle, { pinnedServerKeyId: '5'.repeat(64) });
    assert(!wrongPin.ok, 'a wrong pin must fail');
    const edited = structuredClone(bundle);
    edited.records[2].record.label = 'tampered';
    const v = await verifyDocumentBundle(edited, { pinnedServerKeyId: pinned });
    assert(!v.ok, 'a changed record must fail');
  });

  await check('document: the stored bytes verify and unlock to the right file', async () => {
    const head = bundle.records[2].record;
    const blob = await call('GET', '/api/blobs/' + head.blob.hash);
    expectStatus(blob, 200);
    const b = await verifyBlobBytes(blob.bytes, head);
    assert(b.ok, 'verifyBlobBytes: ' + b.detail);
    const opened = await unlockFile(blob.bytes, doc.password);
    eq(new TextDecoder().decode(opened.data), 'third version of the paper', 'file content');
    eq(opened.name, 'paper.txt', 'file name');
    const p = await verifyPlaintext({ fileHash: opened.fileHash, commitSalt: opened.commitSalt }, head);
    assert(p.ok, 'verifyPlaintext: ' + p.detail);
    // the first version is still stored and still matches its own record
    const old = await call('GET', '/api/blobs/' + bundle.records[0].record.blob.hash);
    assert((await verifyBlobBytes(old.bytes, bundle.records[0].record)).ok, 'old version bytes');
    const wrong = await verifyBlobBytes(blob.bytes, bundle.records[0].record);
    assert(!wrong.ok, 'bytes of v3 must not match the record of v1');
    assert(locked2 && locked3, 'locked files exist');
  });

  await check('document: GET /head gives the latest version, blob hash and signed head', async () => {
    const res = await call('GET', `/api/documents/${doc.docId}/head`);
    expectStatus(res, 200);
    eq(res.json.docId, doc.docId, 'docId');
    eq(res.json.status, 'active', 'status');
    eq(res.json.headVersion, 3, 'headVersion');
    eq(res.json.headRecordHash, doc.recordHash, 'headRecordHash');
    eq(res.json.blobHash, locked3.blobHash, 'blobHash');
    eq(res.json.ledgerSeq, bundle.records[2].ledgerSeq, 'ledgerSeq');
    eq(res.json.ledgerHash, bundle.records[2].ledgerHash, 'ledgerHash');
    assert(await verifyCheckpoint(res.json.server.publicKey, res.json.headCheckpoint), 'headCheckpoint signature');
    eq(res.json.headCheckpoint.payload.scope, 'doc:' + doc.docId, 'scope');
    eq(res.json.headCheckpoint.payload.seq, 3, 'seq');
    eq(res.json.headCheckpoint.payload.hash, doc.recordHash, 'hash');
    assert(await verifyCheckpoint(res.json.server.publicKey, res.json.checkpoint), 'checkpoint signature');
    expectStatus(await call('GET', `/api/documents/${newDocId()}/head`), 404, 'not_found');
    expectStatus(await call('GET', `/api/documents/${newDocId()}`), 404, 'not_found');
    expectStatus(await call('GET', '/api/documents/nothex'), 400, 'bad_request');
  });

  // ---- chain rules ----
  let bob;
  await check('rules: an update by someone else is refused (403 not_owner)', async () => {
    bob = await newPerson('Bob');
    const locked = await lock('hijack attempt', doc.password);
    expectStatus(await putBlob(bob, locked.bytes), 201);
    const record = updateRecord(bob, locked, { docId: doc.docId, version: 4, prev: doc.recordHash });
    expectStatus(await postDoc(bob, record), 403, 'not_owner');
    const revoke = revokeRecord(bob, { docId: doc.docId, version: 4, prev: doc.recordHash });
    expectStatus(await postDoc(bob, revoke), 403, 'not_owner');
  });

  await check('rules: stale prev, wrong version and unknown document are refused', async () => {
    const stale = await publishUpdate(alice, doc, 'built on an old head', { version: 4, prev: bundle.records[0].recordHash });
    expectStatus(stale.res, 409, 'conflict');
    const skip = await publishUpdate(alice, doc, 'skips a version', { version: 5, prev: doc.recordHash });
    expectStatus(skip.res, 409, 'conflict');
    const again = await publishUpdate(alice, doc, 'repeats a version', { version: 3, prev: bundle.records[1].recordHash });
    expectStatus(again.res, 409, 'conflict');
    const lost = await publishUpdate(alice, { ...doc, docId: newDocId() }, 'no such document', { version: 2, prev: doc.recordHash });
    expectStatus(lost.res, 404, 'not_found');
    const back = await publishUpdate(alice, doc, 'fourth version', { version: 4, prev: doc.recordHash, label: `Contract ${RUN} v4` });
    // that one is fine, now the same with a createdAt older than the head
    expectStatus(back.res, 201);
    doc.recordHash = back.res.json.recordHash;
    doc.version = 4;
    const locked = await lock('older than the head', doc.password);
    expectStatus(await putBlob(alice, locked.bytes), 201);
    const old = updateRecord(alice, locked, { docId: doc.docId, version: 5, prev: doc.recordHash, createdAt: Date.now() - 5 * 60 * 1000 });
    expectStatus(await postDoc(alice, old), 400, 'bad_request');
  });

  let revoked;
  await check('rules: revoke works, status becomes revoked, updates after it are refused', async () => {
    const owner = await newPerson('Revoker');
    revoked = await publishNew(owner, 'to be revoked ' + RUN, { label: `Revoke me ${RUN}` });
    revoked.owner = owner;
    const rev = revokeRecord(owner, { docId: revoked.docId, version: 2, prev: revoked.recordHash, reason: 'issued in error' });
    const res = await postDoc(owner, rev);
    expectStatus(res, 201);
    eq(res.json.document.status, 'revoked', 'status');
    eq(res.json.document.headVersion, 2, 'headVersion');
    revoked.recordHash = res.json.recordHash;

    const locked = await lock('after the revoke', revoked.password);
    expectStatus(await putBlob(owner, locked.bytes), 201);
    const upd = updateRecord(owner, locked, { docId: revoked.docId, version: 3, prev: revoked.recordHash });
    expectStatus(await postDoc(owner, upd), 409, 'conflict');
    const rev2 = revokeRecord(owner, { docId: revoked.docId, version: 3, prev: revoked.recordHash });
    expectStatus(await postDoc(owner, rev2), 409, 'conflict');

    const got = await call('GET', '/api/documents/' + revoked.docId);
    expectStatus(got, 200);
    eq(got.json.document.status, 'revoked', 'bundle status');
    const v = await verifyDocumentBundle(got.json, { pinnedServerKeyId: pinned });
    assert(v.ok, 'revoked bundle should verify: ' + JSON.stringify(v.checks.filter((c) => !c.ok)));
    eq(v.status, 'revoked', 'verified status');
    eq(v.anchored, true, 'anchored');

    const head = await call('GET', `/api/documents/${revoked.docId}/head`);
    expectStatus(head, 200);
    eq(head.json.status, 'revoked', 'head status');
    eq(head.json.blobHash, null, 'blobHash of a revoked head');
    assert(await verifyCheckpoint(head.json.server.publicKey, head.json.headCheckpoint), 'head checkpoint');
  });

  // ---- unlisted and listing ----
  let unlisted;
  await check('listing: an unlisted document is hidden from the list but can be fetched', async () => {
    const owner = await newPerson('Quiet');
    unlisted = await publishNew(owner, 'private paper ' + RUN, { label: `Hidden ${RUN}`, listed: false });
    const list = await call('GET', `/api/documents?q=${encodeURIComponent('Hidden ' + RUN)}`);
    expectStatus(list, 200);
    eq(list.json.documents.length, 0, 'unlisted must not appear');
    const byOwner = await call('GET', `/api/documents?owner=${owner.keyId}`);
    eq(byOwner.json.documents.length, 0, 'unlisted must not appear in the owner list');
    const got = await call('GET', '/api/documents/' + unlisted.docId);
    expectStatus(got, 200);
    eq(got.json.document.listed, false, 'listed flag');
    const v = await verifyDocumentBundle(got.json, { pinnedServerKeyId: pinned });
    assert(v.ok, 'unlisted bundle verifies');
    expectStatus(await call('GET', `/api/documents/${unlisted.docId}/head`), 200);
  });

  let lister;
  const listed = [];
  await check('listing: search, owner filter, escaping and pagination', async () => {
    lister = await newPerson('Lister');
    const base = Date.now();
    const labels = [`Alpha ${RUN}`, `Beta ${RUN}`, `Gamma 100% ${RUN}`, `Delta_x ${RUN}`, `Epsilon ${RUN}`];
    for (let i = 0; i < labels.length; i++) {
      // distinct times, newest first in the list
      const d = await publishNew(lister, `list item ${i} ${RUN}`, { label: labels[i], createdAt: base - i * 1000 });
      listed.push({ ...d, label: labels[i] });
    }
    // owner filter shows exactly these five, newest update first
    const all = await call('GET', `/api/documents?owner=${lister.keyId}`);
    expectStatus(all, 200);
    eq(all.json.documents.length, 5, 'owner list size');
    eq(all.json.documents.map((d) => d.label).join('|'), labels.join('|'), 'order (newest update first)');
    const first = all.json.documents[0];
    eq(first.ownerKeyId, lister.keyId, 'ownerKeyId');
    eq(first.ownerName, lister.name, 'ownerName');
    eq(first.status, 'active', 'status');
    eq(first.headVersion, 1, 'headVersion');
    assert(first.createdAt > 0 && first.updatedAt > 0, 'times');
    // text search
    const q1 = await call('GET', `/api/documents?q=${encodeURIComponent('beta ' + RUN)}`);
    eq(q1.json.documents.length, 1, 'search is case insensitive and finds one');
    eq(q1.json.documents[0].docId, listed[1].docId, 'search result');
    // % and _ are plain characters
    const pct = await call('GET', `/api/documents?q=${encodeURIComponent('%')}&owner=${lister.keyId}`);
    eq(pct.json.documents.length, 1, 'percent matches only the label containing it');
    eq(pct.json.documents[0].label, labels[2], 'percent result');
    const us = await call('GET', `/api/documents?q=${encodeURIComponent('_')}&owner=${lister.keyId}`);
    eq(us.json.documents.length, 1, 'underscore matches only the label containing it');
    eq(us.json.documents[0].label, labels[3], 'underscore result');
    const none = await call('GET', `/api/documents?q=${encodeURIComponent('no such label ' + RUN)}`);
    eq(none.json.documents.length, 0, 'no match');
    // pagination with limit and before
    const seen = [];
    let before = '';
    for (let page = 0; page < 5; page++) {
      const res = await call('GET', `/api/documents?owner=${lister.keyId}&limit=2${before}`);
      expectStatus(res, 200);
      assert(res.json.documents.length <= 2, 'page size');
      if (res.json.documents.length === 0) break;
      seen.push(...res.json.documents.map((d) => d.label));
      before = '&before=' + res.json.documents[res.json.documents.length - 1].updatedAt;
    }
    eq(seen.join('|'), labels.join('|'), 'paged results');
    // bad parameters
    expectStatus(await call('GET', '/api/documents?limit=0'), 400, 'bad_request');
    expectStatus(await call('GET', '/api/documents?limit=101'), 400, 'bad_request');
    expectStatus(await call('GET', '/api/documents?limit=abc'), 400, 'bad_request');
    expectStatus(await call('GET', '/api/documents?before=-1'), 400, 'bad_request');
    expectStatus(await call('GET', '/api/documents?owner=zz'), 400, 'bad_request');
    // the main document shows up in the public list too, with its newest label
    const main = await call('GET', `/api/documents?q=${encodeURIComponent('Contract ' + RUN)}`);
    eq(main.json.documents.length, 1, 'main document is listed');
    eq(main.json.documents[0].headVersion, 4, 'list shows the head version');
  });

  // ---- races ----
  await check('races: 12 documents created at once all land on one valid ledger', async () => {
    const racer = await newPerson('Racer');
    const up = await putBlob(racer, locked1.bytes);
    assert(up.status === 201 || up.status === 200, 'blob upload');
    const jobs = [];
    for (let i = 0; i < 12; i++) {
      const record = createRecord(racer, locked1, { docId: newDocId(), label: `Race ${i} ${RUN}`, listed: false });
      jobs.push(postDoc(racer, record));
    }
    const results = await Promise.all(jobs);
    for (const res of results) expectStatus(res, 201);
    const seqs = results.map((r) => r.json.ledgerSeq).sort((a, b) => a - b);
    eq(new Set(seqs).size, 12, 'ledger seqs are distinct');
    for (let i = 1; i < seqs.length; i++) assert(seqs[i] > seqs[i - 1], 'seqs increase');
    ctx.racer = racer;
  });

  await check('races: five updates built on the same head, exactly one wins', async () => {
    const owner = await newPerson('Racer Two');
    const d = await publishNew(owner, 'race base ' + RUN, { label: `Race base ${RUN}` });
    d.version = 1;
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      const locked = await lock(`competing version ${i} ${RUN}`, d.password);
      expectStatus(await putBlob(owner, locked.bytes), 201);
      const record = updateRecord(owner, locked, { docId: d.docId, version: 2, prev: d.recordHash, label: `Race ${i}` });
      jobs.push(postDoc(owner, record));
    }
    const results = await Promise.all(jobs);
    const wins = results.filter((r) => r.status === 201);
    const losses = results.filter((r) => r.status === 409);
    eq(wins.length, 1, 'winners');
    eq(losses.length, 4, 'conflicts');
    for (const l of losses) eq(l.json.code, 'conflict', 'loser code');
    const bundle2 = await call('GET', '/api/documents/' + d.docId);
    eq(bundle2.json.records.length, 2, 'only one update was stored');
    const v = await verifyDocumentBundle(bundle2.json, { pinnedServerKeyId: pinned });
    assert(v.ok, 'bundle verifies after the race');
  });

  // ---- ledger audit ----
  await check('ledger: pages link up and a full audit across pages verifies', async () => {
    let after = 0;
    let startPrev = ZERO_HASH;
    let startSeq = 1;
    let docState = new Map();
    let entries = 0;
    let pages = 0;
    let checkpoint = null;
    let server = null;
    for (;;) {
      const res = await call('GET', `/api/ledger?after=${after}&limit=50`);
      expectStatus(res, 200);
      const page = res.json;
      const r = await verifyLedgerPage(page, { startPrev, startSeq, docState });
      assert(r.ok, `ledger page after ${after}: ${r.problems.slice(0, 3).join('; ')}`);
      docState = r.docState;
      entries += page.entries.length;
      pages++;
      checkpoint = page.checkpoint;
      server = page.server;
      if (page.entries.length > 0) {
        after = r.lastSeq;
        startSeq = r.lastSeq + 1;
        startPrev = r.lastHash;
      }
      if (!page.hasMore) break;
      assert(page.entries.length === 50, 'a page that has more must be full');
    }
    assert(entries >= 8, 'ledger has entries from this run: ' + entries);
    assert(pages >= 1, 'pages');
    assert(await verifyCheckpoint(server.publicKey, checkpoint), 'ledger checkpoint signature');
    eq(checkpoint.payload.scope, 'ledger', 'scope');
    assert(checkpoint.payload.seq >= after, 'checkpoint is at or after the last entry');
    // a changed entry must be noticed
    const res = await call('GET', '/api/ledger?after=0&limit=5');
    if (res.json.entries.length > 0) {
      const bad = structuredClone(res.json);
      bad.entries[0].record.createdAt += 1;
      const r = await verifyLedgerPage(bad, {});
      assert(!r.ok, 'a changed ledger entry must fail verification');
    }
    expectStatus(await call('GET', '/api/ledger?limit=0'), 400, 'bad_request');
    expectStatus(await call('GET', '/api/ledger?limit=501'), 400, 'bad_request');
    expectStatus(await call('GET', '/api/ledger?after=x'), 400, 'bad_request');
  });

  // ---- chat ----
  const channelId = `e2e-${RUN}`;
  let c1;
  let c2;
  await check('channel: create (201) and a duplicate id is refused (409 exists)', async () => {
    c1 = await newPerson('Chatter One');
    c2 = await newPerson('Chatter Two');
    const res = await createChannel(c1, channelId, `E2E ${RUN}`, doc.docId);
    expectStatus(res, 201);
    eq(res.json.channel.channelId, channelId, 'channelId');
    eq(res.json.channel.docId, doc.docId, 'docId');
    eq(res.json.channel.createdBy, c1.keyId, 'createdBy');
    eq(res.json.channel.createdByName, c1.name, 'createdByName');
    eq(res.json.channel.messageCount, 0, 'messageCount');
    eq(res.json.channel.lastMessageAt, null, 'lastMessageAt');
    expectStatus(await createChannel(c2, channelId, 'Copy'), 409, 'exists');
    const list = await call('GET', '/api/channels');
    expectStatus(list, 200);
    assert(list.json.channels.some((c) => c.channelId === channelId), 'channel is listed');
  });

  await check('channel: bad input is refused (id, signer, signature, time)', async () => {
    expectStatus(await createChannel(c1, 'AB', 'Bad id'), 400, 'bad_request');
    const ghost = await makeIdentity('Ghost2 ' + RUN);
    expectStatus(await createChannel(ghost, `ghost-${RUN}`, 'No identity'), 403, 'unknown_signer');
    const record = { v: 2, type: 'channel.create', channelId: `sig-${RUN}`, title: 'x', docId: '', signer: c1.keyId, createdAt: Date.now() };
    const sig = await signRecord(c2.privateKey, record);
    expectStatus(await call('POST', '/api/channels', { json: { record, signature: sig } }), 400, 'bad_signature');
    expectStatus(await createChannel(c1, `old-${RUN}`, 'Old', '', { createdAt: Date.now() - 20 * 60 * 1000 }), 400, 'expired');
  });

  await check('messages: 20 posted at once from two identities get seqs 1..20 and a valid chain', async () => {
    const jobs = [];
    for (let i = 0; i < 20; i++) {
      const author = i % 2 === 0 ? c1 : c2;
      jobs.push(postMessage(author, channelId, `message number ${i}`));
    }
    const results = await Promise.all(jobs);
    for (const { res } of results) expectStatus(res, 201);
    const seqs = results.map(({ res }) => res.json.seq).sort((a, b) => a - b);
    eq(seqs.join(','), Array.from({ length: 20 }, (_, i) => i + 1).join(','), 'seqs');

    const page = await call('GET', `/api/channels/${channelId}/messages?limit=100`);
    expectStatus(page, 200);
    eq(page.json.messages.length, 20, 'message count');
    eq(page.json.hasMore, false, 'hasMore');
    eq(page.json.channel.messageCount, 20, 'channel messageCount');
    const v = await verifyMessages(page.json, { pinnedServerKeyId: pinned, expectedChannelId: channelId });
    assert(v.ok, 'verifyMessages: ' + JSON.stringify(v.results.filter((r) => !r.ok)) + ' ' + v.warnings.join(' | '));
    eq(v.anchored, true, 'anchored');
    eq(v.chainOk, true, 'chainOk');
    eq(page.json.checkpoint.payload.scope, 'channel:' + channelId, 'checkpoint scope');
    eq(page.json.checkpoint.payload.seq, 20, 'checkpoint seq');
    ctx.chatPage = page.json;
  });

  await check('messages: paging with after and limit, tail, and polling past the end', async () => {
    let after = 0;
    let startPrev = ZERO_HASH;
    const seen = [];
    for (let i = 0; i < 10; i++) {
      const res = await call('GET', `/api/channels/${channelId}/messages?after=${after}&limit=7`);
      expectStatus(res, 200);
      const last = res.json.messages[res.json.messages.length - 1];
      const v = await verifyMessages(res.json, {
        pinnedServerKeyId: pinned,
        expectedChannelId: channelId,
        allowUnanchored: true,
        startPrev
      });
      assert(v.ok, 'page verifies: ' + v.warnings.join(' | '));
      eq(v.chainOk, true, 'chainOk');
      if (res.json.hasMore) eq(v.anchored, false, 'earlier pages are not anchored');
      else eq(v.anchored, true, 'the last page is anchored');
      seen.push(...res.json.messages.map((m) => m.seq));
      if (!res.json.hasMore) break;
      after = last.seq;
      startPrev = last.chainHash;
    }
    eq(seen.join(','), Array.from({ length: 20 }, (_, i) => i + 1).join(','), 'all seqs paged');

    const tail = await call('GET', `/api/channels/${channelId}/messages?tail=5`);
    expectStatus(tail, 200);
    eq(tail.json.messages.map((m) => m.seq).join(','), '16,17,18,19,20', 'tail seqs');
    const tv = await verifyMessages(tail.json, { pinnedServerKeyId: pinned, expectedChannelId: channelId });
    assert(tv.ok && tv.anchored, 'tail page is anchored: ' + tv.warnings.join(' | '));

    const empty = await call('GET', `/api/channels/${channelId}/messages?after=20`);
    expectStatus(empty, 200);
    eq(empty.json.messages.length, 0, 'nothing after the end');
    eq(empty.json.hasMore, false, 'hasMore');
    eq(empty.json.checkpoint.payload.seq, 20, 'checkpoint still reports the head');

    expectStatus(await call('GET', `/api/channels/${channelId}/messages?limit=101`), 400, 'bad_request');
    expectStatus(await call('GET', `/api/channels/${channelId}/messages?tail=0`), 400, 'bad_request');
    expectStatus(await call('GET', `/api/channels/nochan-${RUN}/messages`), 404, 'not_found');
  });

  await check('messages: a changed message or a swapped chain link is noticed', async () => {
    const bad = structuredClone(ctx.chatPage);
    bad.messages[3].record.body = 'edited afterwards';
    const v = await verifyMessages(bad, { pinnedServerKeyId: pinned, expectedChannelId: channelId });
    assert(!v.ok, 'an edited message must fail');
    const swapped = structuredClone(ctx.chatPage);
    [swapped.messages[4], swapped.messages[5]] = [swapped.messages[5], swapped.messages[4]];
    const v2 = await verifyMessages(swapped, { pinnedServerKeyId: pinned, expectedChannelId: channelId });
    assert(!v2.ok && !v2.chainOk, 'a reordered chain must fail');
  });

  await check('messages: replyTo must be a message of the same channel', async () => {
    const target = ctx.chatPage.messages[2].hash;
    const ok = await postMessage(c1, channelId, 'a reply', { replyTo: target });
    expectStatus(ok.res, 201);
    eq(ok.res.json.seq, 21, 'seq');
    const unknown = await postMessage(c1, channelId, 'reply to nothing', { replyTo: 'a'.repeat(64) });
    expectStatus(unknown.res, 400, 'bad_request');
    const otherId = `e2e2-${RUN}`;
    expectStatus(await createChannel(c1, otherId, 'Second'), 201);
    const cross = await postMessage(c1, otherId, 'reply across channels', { replyTo: target });
    expectStatus(cross.res, 400, 'bad_request');
    const shown = await call('GET', `/api/channels/${channelId}/messages?tail=1`);
    eq(shown.json.messages[0].record.replyTo, target, 'replyTo is stored');
  });

  await check('messages: duplicates and bad input are refused', async () => {
    const first = await postMessage(c2, channelId, 'only once');
    expectStatus(first.res, 201);
    const sig = await signRecord(c2.privateKey, first.record);
    const dup = await call('POST', `/api/channels/${channelId}/messages`, { json: { record: first.record, signature: sig } });
    expectStatus(dup, 409, 'exists');
    // record for another channel than the address
    const rec = messageRecord(c1, channelId, 'wrong address');
    const wrongAddr = await postMessage(c1, channelId, '', { record: rec, pathChannel: `e2e2-${RUN}` });
    expectStatus(wrongAddr.res, 400, 'bad_request');
    expectStatus((await postMessage(c1, `nochan-${RUN}`, 'hello')).res, 404, 'not_found');
    // empty body, too long body, stranger signature, unregistered, old time
    expectStatus((await postMessage(c1, channelId, '')).res, 400, 'bad_request');
    expectStatus((await postMessage(c1, channelId, 'x'.repeat(2001))).res, 400, 'bad_request');
    expectStatus((await postMessage(c1, channelId, 'forged', { signWith: c2 })).res, 400, 'bad_signature');
    const ghost = await makeIdentity('Ghost3 ' + RUN);
    expectStatus((await postMessage(ghost, channelId, 'who am i')).res, 403, 'unknown_signer');
    expectStatus((await postMessage(c1, channelId, 'late', { createdAt: Date.now() - 11 * 60 * 1000 })).res, 400, 'expired');
    expectStatus((await postMessage(c1, channelId, 'early', { createdAt: Date.now() + 11 * 60 * 1000 })).res, 400, 'expired');
    // the channel list shows the count and last message time
    const list = await call('GET', '/api/channels');
    const mine = list.json.channels.find((c) => c.channelId === channelId);
    assert(mine && mine.messageCount === 22, 'messageCount in the list: ' + (mine && mine.messageCount));
    assert(mine.lastMessageAt > 0, 'lastMessageAt');
  });

  await check('messages: more than 20 per minute from one identity gets 429', async () => {
    const spammer = await newPerson('Spammer');
    const room = `spam-${RUN}`;
    expectStatus(await createChannel(spammer, room, 'Spam room'), 201);
    let ok = 0;
    let limited = 0;
    let retryAfter = null;
    // two fixed windows can pass at most 40 messages, so 45 must hit the limit
    for (let i = 0; i < 45; i++) {
      const { res } = await postMessage(spammer, room, `spam ${i}`);
      if (res.status === 201) ok++;
      else if (res.status === 429) {
        limited++;
        eq(res.json.code, 'rate_limited', 'code');
        retryAfter = res.headers.get('retry-after');
      } else throw new Error('unexpected status ' + res.status + ' ' + JSON.stringify(res.json));
    }
    assert(ok >= 20 && ok <= 40, 'accepted messages: ' + ok);
    assert(limited >= 5, 'limited messages: ' + limited);
    assert(Number(retryAfter) >= 1, 'Retry-After header');
    // the limit is per identity, someone else still can talk
    expectStatus((await postMessage(c2, channelId, 'still allowed')).res, 201);
    // and the chain of the busy room is still valid
    const page = await call('GET', `/api/channels/${room}/messages?tail=100`);
    const v = await verifyMessages(page.json, { pinnedServerKeyId: pinned, expectedChannelId: room, allowUnanchored: true });
    assert(v.ok, 'spam room chain: ' + v.warnings.join(' | '));
    eq(page.json.messages.length, ok, 'stored messages equal accepted messages');
  });

  // ---- transport level ----
  await check('malformed JSON, wrong shapes and empty bodies are refused (400)', async () => {
    const ip = nextIp();
    const bad = await fetch(BASE + '/api/identities', { method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: '{not json' });
    eq(bad.status, 400, 'status');
    eq((await bad.json()).code, 'bad_request', 'code');
    const arr = await call('POST', '/api/identities', { json: [1, 2, 3], ip });
    expectStatus(arr, 400, 'bad_request');
    const empty = await call('POST', '/api/channels', { body: '' });
    expectStatus(empty, 400, 'bad_request');
    const noSig = await call('POST', '/api/channels', { json: { record: {} } });
    expectStatus(noSig, 400, 'bad_request');
    const nul = await call('POST', `/api/documents/${newDocId()}/records`, { body: 'null' });
    expectStatus(nul, 400, 'bad_request');
  });

  await check('a JSON body over 64 KiB is refused (413 too_large)', async () => {
    const big = JSON.stringify({ record: { padding: 'x'.repeat(70 * 1024) }, signature: 'y' });
    const res = await call('POST', '/api/identities', { body: big, headers: { 'Content-Type': 'application/json' } });
    expectStatus(res, 413, 'too_large');
    const res2 = await call('POST', `/api/channels/${channelId}/messages`, { body: big, headers: { 'Content-Type': 'application/json' } });
    expectStatus(res2, 413, 'too_large');
  });

  await check('unknown API routes answer with a JSON 404', async () => {
    for (const [method, path] of [
      ['GET', '/api/does-not-exist'],
      ['GET', '/api/documents/' + newDocId() + '/nothing'],
      ['POST', '/api/'],
      ['DELETE', '/api/documents']
    ]) {
      const res = await call(method, path);
      assert(res.status === 404 || res.status === 405, `${method} ${path}: status ${res.status}`);
      assert(res.json && typeof res.json.error === 'string' && typeof res.json.code === 'string', `${method} ${path}: JSON error body`);
    }
    const missing = await call('GET', '/api/does-not-exist');
    expectStatus(missing, 404, 'not_found');
    const wrongMethod = await call('POST', '/api/health');
    eq(wrongMethod.status, 405, 'status for the wrong method');
    assert(wrongMethod.headers.get('allow'), 'Allow header');
  });

  await check('API responses carry the security headers and no CORS headers', async () => {
    const samples = [
      ['GET', '/api/health'],
      ['GET', '/api/server-key'],
      ['GET', '/api/documents'],
      ['GET', '/api/ledger?limit=1'],
      ['GET', '/api/channels'],
      ['GET', '/api/documents/' + doc.docId],
      ['GET', '/api/nothing-here'],
      ['GET', '/api/identities/nothex'],
      ['POST', '/api/identities']
    ];
    for (const [method, path] of samples) {
      const res = await call(method, path, method === 'POST' ? { body: '{' } : {});
      assertSecurityHeaders(res, `${method} ${path}`);
      eq(res.headers.get('cache-control'), 'no-store', `${method} ${path} cache-control`);
    }
    const blob = await call('GET', '/api/blobs/' + locked1.blobHash);
    assertSecurityHeaders(blob, 'GET blob');
    assert(blob.headers.get('cache-control') !== 'no-store', 'blob GET is cacheable');
    const preflight = await call('OPTIONS', '/api/health', { headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' } });
    assert(!preflight.headers.get('access-control-allow-origin'), 'no CORS on preflight');
  });

  // ---- review fixes ----
  await check('health says whether signing is on, and HEAD works on JSON routes', async () => {
    const res = await call('GET', '/api/health');
    eq(res.json.signing, true, 'signing');
    for (const path of ['/api/health', '/api/server-key', '/api/ledger?limit=1', '/api/documents?limit=1', '/api/channels', '/api/documents/' + doc.docId]) {
      const head = await call('HEAD', path);
      eq(head.status, 200, 'HEAD ' + path);
      eq(head.bytes.length, 0, 'HEAD body ' + path);
      eq(head.headers.get('cache-control'), 'no-store', 'HEAD cache-control ' + path);
    }
  });

  await check('document search works for the longest allowed query, with percent signs and emoji', async () => {
    const owner = await newPerson('Search');
    const label = ('findme ' + RUN + ' ' + 'long label '.repeat(12)).slice(0, 120);
    const made = await publishNew(owner, 'search me', { label });
    for (const q of [label, label.toUpperCase(), 'q'.repeat(60), '%'.repeat(100), '\u{1F600}'.repeat(25)]) {
      const res = await call('GET', '/api/documents?limit=100&q=' + encodeURIComponent(q));
      expectStatus(res, 200);
      eq(res.json.documents.some((d) => d.docId === made.docId), q === label || q === label.toUpperCase(), 'found by ' + q.slice(0, 12));
    }
    expectStatus(await call('GET', '/api/documents?q=' + encodeURIComponent('a'.repeat(121))), 400);
  });

  await check('document list paging reaches documents that share one updatedAt', async () => {
    const owner = await newPerson('Ties');
    const T = Date.now() - 30000;
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const locked = await lock('tie ' + i + RUN, generatePassword());
      expectStatus(await putBlob(owner, locked.bytes), 201);
      const docId = (['00', 'ff', 'fe', 'fd'][i]) + newDocId().slice(2);
      expectStatus(await postDoc(owner, createRecord(owner, locked, { docId, createdAt: T, label: 'tie ' + RUN })), 201);
      ids.push(docId);
    }
    const seen = [];
    let qs = '?limit=1&owner=' + owner.keyId;
    for (let page = 0; page < 10; page++) {
      const res = await call('GET', '/api/documents' + qs);
      expectStatus(res, 200);
      if (res.json.documents.length === 0) break;
      const last = res.json.documents[res.json.documents.length - 1];
      seen.push(last.docId);
      qs = `?limit=1&owner=${owner.keyId}&before=${last.updatedAt}&beforeId=${last.docId}`;
    }
    eq(seen.slice().sort().join(), ids.slice().sort().join(), 'documents reached by paging');
  });

  await check('the ledger page size is capped at 200', async () => {
    expectStatus(await call('GET', '/api/ledger?limit=200'), 200);
    expectStatus(await call('GET', '/api/ledger?limit=201'), 400, 'bad_request');
  });

  await check('a channel may only name a document that exists, and shows the document owner', async () => {
    const owner = await newPerson('ChanDocOwner');
    const other = await newPerson('ChanDocOther');
    const made = await publishNew(owner, 'channel doc ' + RUN);
    expectStatus(await createChannel(other, 'ghost-' + RUN, 'Ghost link', newDocId()), 400, 'bad_request');
    const ours = await createChannel(owner, 'own-' + RUN, 'Own link', made.docId);
    expectStatus(ours, 201);
    eq(ours.json.channel.docOwnerKeyId, owner.keyId, 'docOwnerKeyId');
    const theirs = await createChannel(other, 'their-' + RUN, 'Other link', made.docId);
    expectStatus(theirs, 201);
    eq(theirs.json.channel.docOwnerKeyId, owner.keyId, 'docOwnerKeyId of a channel by someone else');
    assert(theirs.json.channel.createdBy !== theirs.json.channel.docOwnerKeyId, 'creator is not the owner');
  });

  await check('channel list pages with a cursor and counts messages without scanning them', async () => {
    const person = await newPerson('Counter');
    const id = 'cnt-' + RUN;
    expectStatus(await createChannel(person, id, 'Counter channel'), 201);
    for (let i = 0; i < 3; i++) expectStatus((await postMessage(person, id, 'count ' + i)).res, 201);
    const list = await call('GET', '/api/channels?limit=200');
    expectStatus(list, 200);
    const mine = list.json.channels.find((c) => c.channelId === id);
    assert(mine, 'channel listed');
    eq(mine.messageCount, 3, 'messageCount');
    assert(Number.isInteger(mine.lastMessageAt), 'lastMessageAt');
    const page = await call('GET', '/api/channels?limit=1');
    eq(page.json.channels.length, 1, 'one channel');
    assert(page.json.next && Number.isInteger(page.json.next.before) && typeof page.json.next.beforeId === 'string', 'next cursor');
    const second = await call('GET', `/api/channels?limit=1&before=${page.json.next.before}&beforeId=${page.json.next.beforeId}`);
    expectStatus(second, 200);
    assert(second.json.channels[0].channelId !== page.json.channels[0].channelId, 'second page differs');
    const msgs = await call('GET', `/api/channels/${id}/messages?tail=2`);
    eq(msgs.json.channel.messageCount, 3, 'messageCount in a message page');
  });

  await check('blobs: only locked file headers are stored, and uploads need a locked file size', async () => {
    const owner = await newPerson('Headers');
    const plain = new TextEncoder().encode('plain text, not a locked file. '.repeat(20));
    const refused = await putBlob(owner, plain);
    expectStatus(refused, 400, 'bad_request');
    eq((await call('GET', '/api/blobs/' + (await sha256Hex(plain)))).status, 404, 'nothing stored');
    const locked = await lock('header ok ' + RUN, generatePassword());
    expectStatus(await putBlob(owner, locked.bytes), 201);
  });

  await check('identity creation counts an IPv6 /64 as one address', async () => {
    const prefix = `2001:db8:${RUN.slice(0, 4)}:${RUN.slice(4, 8)}`;
    const codes = [];
    for (let i = 0; i < 12; i++) {
      const id = await makeIdentity('V6 ' + i + ' ' + RUN);
      const res = await call('POST', '/api/identities', { json: { record: id.identityRecord, signature: id.identitySignature }, ip: `${prefix}::${i + 1}` });
      codes.push(res.status);
    }
    eq(codes.filter((c) => c === 201).length, 10, 'accepted: ' + codes.join());
    eq(codes[10], 429, 'eleventh');
  });

  await accountChecks(ctx);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('e2e crashed: ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
