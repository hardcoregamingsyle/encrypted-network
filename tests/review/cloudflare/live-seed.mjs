// Review helper (not a vitest file). Seeds a running dev server with 500 signed document records
// and times the heavy reads. Usage: node tests/review/cloudflare/live-seed.mjs http://127.0.0.1:8793
import { sha256Hex } from '../../../shared/hash.js';
import { exportPublicJwk, generateKeyPair, keyIdOf, signRecord } from '../../../shared/keys.js';
import { ZERO_HASH, newDocId } from '../../../shared/records.js';

const BASE = (process.argv[2] || 'http://127.0.0.1:8793').replace(/\/+$/, '');
const TOTAL = Number(process.argv[3] || 500);
const ipBase = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

async function call(method, path, { json, headers = {}, body, ip } = {}) {
  const h = { ...headers };
  if (ip) h['CF-Connecting-IP'] = ip;
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    h['Content-Type'] = 'application/json';
  }
  const t0 = performance.now();
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ms = performance.now() - t0;
  let parsed = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    parsed = null;
  }
  return { status: res.status, json: parsed, bytes, ms };
}

async function person(i) {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: false });
  const publicJwk = await exportPublicJwk(publicKey);
  const keyId = await keyIdOf(publicJwk);
  const record = { v: 2, type: 'identity', publicKey: publicJwk, displayName: 'Seed person ' + i, createdAt: Date.now() };
  const signature = await signRecord(privateKey, record);
  const res = await call('POST', '/api/identities', { json: { record, signature }, ip: `${ipBase}.${i + 1}` });
  if (res.status !== 201) throw new Error('identity ' + res.status + JSON.stringify(res.json));
  return { keyId, privateKey };
}

async function putBlob(p, bytes) {
  const hash = await sha256Hex(bytes);
  const record = { v: 2, type: 'blob.put', hash, size: bytes.length, signer: p.keyId, createdAt: Date.now() };
  const signature = await signRecord(p.privateKey, record);
  const res = await call('PUT', '/api/blobs/' + hash, {
    headers: { 'x-hrd-key': p.keyId, 'x-hrd-time': String(record.createdAt), 'x-hrd-sig': signature },
    body: bytes
  });
  return { hash, res };
}

const people = [];
for (let i = 0; i < Math.ceil(TOTAL / 30); i++) people.push(await person(i));
const small = crypto.getRandomValues(new Uint8Array(2000));
for (let i = 0; i < 8; i++) small[i] = 'HRDLOCK3'.charCodeAt(i); // the server wants a locked file header
small[8] = 1;
new DataView(small.buffer).setUint32(9, 600000, false);
const { hash: blobHash, res: br } = await putBlob(people[0], small);
console.log('small blob', br.status);

let made = 0;
const label = 'L'.repeat(120);
for (let n = 0; n < TOTAL; n++) {
  const p = people[Math.floor(n / 30)];
  const record = {
    v: 2, type: 'doc.create', docId: newDocId(), version: 1, prev: ZERO_HASH, signer: p.keyId, createdAt: Date.now(),
    label, listed: true, blob: { hash: blobHash, size: small.length, suite: 1 },
    commitment: await sha256Hex('c' + n)
  };
  const signature = await signRecord(p.privateKey, record);
  const res = await call('POST', `/api/documents/${record.docId}/records`, { json: { record, signature } });
  if (res.status !== 201) throw new Error(`record ${n}: ${res.status} ${JSON.stringify(res.json)}`);
  made++;
}
console.log('records created', made);

for (const lim of [200, 500]) {
  const times = [];
  let size = 0;
  for (let k = 0; k < 5; k++) {
    const r = await call('GET', `/api/ledger?limit=${lim}`);
    times.push(Math.round(r.ms));
    size = r.bytes.length;
    if (r.status !== 200) throw new Error('ledger ' + r.status);
  }
  console.log(`GET /api/ledger?limit=${lim}: wall ms ${times.join(',')} body bytes ${size}`);
}
