// Review r5 helper (not a vitest file). Against a LOCAL server (workerd through wrangler pages dev):
// signs in with the echo mail mode, registers a key with a server copy, fills N stored document
// passwords and times POST /api/me/strict. workerd gives no CPU clock, so the wall time of the call is
// used (the work in that request is pure computation plus one D1 read and one D1 batch).
// Usage: node tests/review/cloudflare/live-strict.mjs http://127.0.0.1:8803 <sqlite file> <N>
import { DatabaseSync } from 'node:sqlite';
import { exportPrivateJwk, exportPublicJwk, generateKeyPair, keyIdOf, signRecord } from '../../../shared/keys.js';

const BASE = process.argv[2];
const FILE = process.argv[3];
const N = Number(process.argv[4] || 300);
const email = `strict-${Date.now()}@example.test`;
let cookie = '';

async function call(method, path, json) {
  const headers = { Origin: BASE };
  if (cookie) headers.Cookie = cookie;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const t = performance.now();
  const res = await fetch(BASE + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  const ms = performance.now() - t;
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body, ms, bytes: text.length };
}

const req = await call('POST', '/api/auth/request', { email });
const ver = await call('POST', '/api/auth/verify', { email, code: req.body.debugCode });
if (ver.status !== 200) throw new Error('verify ' + JSON.stringify(ver.body));
const { publicKey, privateKey } = await generateKeyPair({ extractable: true });
const pub = await exportPublicJwk(publicKey);
const keyId = await keyIdOf(pub);
const record = { v: 2, type: 'identity', publicKey: pub, displayName: 'Strict Tester', createdAt: Date.now() };
const signature = await signRecord(privateKey, record);
const k = await call('POST', '/api/me/key', { record, signature, privateJwk: await exportPrivateJwk(privateKey) });
if (k.status !== 201) throw new Error('key ' + JSON.stringify(k.body));

const db = new DatabaseSync(FILE);
const ids = [];
db.exec('BEGIN');
const ins = db.prepare('INSERT INTO documents (doc_id, owner_key_id, status, listed, head_version, head_record_hash, label, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
for (let i = 0; i < N; i++) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  ids.push(id);
  ins.run(id, keyId, 'active', 1, 1, 'e'.repeat(64), 'live strict ' + i, 1, 1);
}
db.exec('COMMIT');
db.close();

let puts = 0;
const t0 = performance.now();
for (let i = 0; i < N; i += 10) {
  await Promise.all(ids.slice(i, i + 10).map(async (id) => {
    const r = await call('PUT', '/api/me/secrets/' + id, { password: 'abcd-efgh-ijkl-mnop-qrst' });
    if (r.status === 200) puts++;
  }));
}
console.log('stored', puts, 'passwords in', Math.round(performance.now() - t0), 'ms');
const one = await call('GET', '/api/me/secrets/' + ids[0]);
console.log('GET one secret wall ms', one.ms.toFixed(1), 'status', one.status);
const s = await call('POST', '/api/me/strict', { enabled: true });
console.log('POST /api/me/strict status', s.status, 'passwords', s.body && s.body.passwords && s.body.passwords.length, 'wall ms', s.ms.toFixed(1), 'bytes', s.bytes, s.body && s.body.code ? s.body.code : '');
const b = await call('POST', '/api/me/strict', { enabled: false });
console.log('back to easy', b.status);
