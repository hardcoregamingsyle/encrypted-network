// Shared helpers for the auth-*.mjs attack scripts (the account backend). Not a script itself.
// Every auth-*.mjs script: node tests/review/backend/auth-<name>.mjs http://127.0.0.1:8801
// A PASS line means the server defended correctly. A FAIL line means a defect was proved.
//
// The server must be a LOCAL one with ACCOUNT_MASTER_KEY and MAIL_PROVIDER=echo (npm run setup does both).
// Where a test needs its own rate limit windows it uses the local only test clock header
// (x-hrd-test-now) with a time far in the future, so the real hourly counters are not touched.
import { exportPrivateJwk, exportPublicJwk, generateKeyPair, keyIdOf, signRecord } from '../../../shared/keys.js';
import { BASE, RUN, assert, brief, call, check, eq, expectStatus, finish } from './_lib.mjs';

export { BASE, RUN, assert, brief, call, check, eq, expectStatus, finish };
export const ORIGIN = new URL(BASE).origin;
export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

export class Jar {
  constructor() {
    this.map = new Map();
    this.last = [];
  }
  absorb(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    this.last = list;
    for (const c of list) {
      const [pair, ...attrs] = c.split(';').map((s) => s.trim());
      const at = pair.indexOf('=');
      const maxAge = attrs.find((x) => /^max-age=/i.test(x));
      if (pair.slice(at + 1) === '' || (maxAge && Number(maxAge.split('=')[1]) <= 0)) this.map.delete(pair.slice(0, at));
      else this.map.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  token() {
    return this.map.get('hrd_session');
  }
  clone() {
    const j = new Jar();
    j.map = new Map(this.map);
    return j;
  }
}

let ipN = 0;
const ipSeed = 1 + Math.floor(Math.random() * 120);
// A fresh loopback client address. Loopback is what lets the local server answer with the code.
export function loop() {
  ipN++;
  return `127.${ipSeed}.${Math.floor(ipN / 254) % 255}.${(ipN % 254) + 1}`;
}

let counter = 0;
export const email = (tag = 'a') => `atk-${tag}-${RUN}-${++counter}-${Math.floor(Math.random() * 1e6)}@example.test`;

// A call with Origin, a loopback address and a cookie jar. origin: null sends none.
export async function a(method, path, { json, jar, origin, ip, now, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (origin !== null && method !== 'GET' && method !== 'HEAD') h.Origin = origin || ORIGIN;
  if (jar && jar.header()) h.Cookie = jar.header();
  if (now !== undefined) h['x-hrd-test-now'] = String(now);
  const res = await call(method, path, { json, headers: h, ip: ip === undefined ? loop() : ip, raw });
  if (jar) jar.absorb({ headers: res.headers });
  return res;
}

export async function signIn(addr = email(), { now, ip = loop() } = {}) {
  const req = await a('POST', '/api/auth/request', { json: { email: addr }, ip, now });
  expectStatus(req, 200);
  const jar = new Jar();
  const ver = await a('POST', '/api/auth/verify', { json: { email: addr, code: req.json.debugCode }, jar, ip, now });
  expectStatus(ver, 200);
  return { jar, account: ver.json.account, email: addr, ip, now };
}

export async function newKey(name = 'Key ' + RUN, { createdAt = Date.now() } = {}) {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: true });
  const publicJwk = await exportPublicJwk(publicKey);
  const keyId = await keyIdOf(publicJwk);
  const record = { v: 2, type: 'identity', publicKey: publicJwk, displayName: name, createdAt };
  return { keyId, publicJwk, record, signature: await signRecord(privateKey, record), privateJwk: await exportPrivateJwk(privateKey), privateKey };
}

// Links a new key to the account (with the server copy unless strict or copy:false). Returns the key.
export async function addKey(acct, { copy = true, now, name } = {}) {
  const k = await newKey(name, { createdAt: now ?? Date.now() });
  const body = { record: k.record, signature: k.signature };
  if (copy) body.privateJwk = k.privateJwk;
  const res = await a('POST', '/api/me/key', { jar: acct.jar, json: body, now });
  expectStatus(res, 201);
  return k;
}

// Hours far in the future, one per call, so every test counts in windows nobody else uses.
let windowN = 0;
const windowBase = Date.UTC(2100, 0, 1) + Math.floor(Math.random() * 2000) * 10 * HOUR;
export function freshWindow() {
  windowN++;
  return windowBase + windowN * 3 * HOUR + 5 * 60 * 1000;
}

export async function needEcho() {
  const health = await call('GET', '/api/health');
  if (!(health.json && health.json.accounts === true && health.json.mail === 'echo')) {
    console.log('SKIP the server has no accounts with echo mail (health: ' + JSON.stringify(health.json) + ')');
    process.exit(0);
  }
}
