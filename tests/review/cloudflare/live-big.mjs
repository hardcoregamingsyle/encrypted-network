// Review helper. Uploads a maximum size blob, reads it back, and checks chunked and wrong length uploads.
import { sha256Hex } from '../../../shared/hash.js';
import { exportPublicJwk, generateKeyPair, keyIdOf, signRecord } from '../../../shared/keys.js';
import { LIMITS } from '../../../shared/records.js';

const BASE = (process.argv[2] || 'http://127.0.0.1:8793').replace(/\/+$/, '');
const { publicKey, privateKey } = await generateKeyPair({ extractable: false });
const jwk = await exportPublicJwk(publicKey);
const keyId = await keyIdOf(jwk);
const rec = { v: 2, type: 'identity', publicKey: jwk, displayName: 'Big uploader', createdAt: Date.now() };
let r = await fetch(BASE + '/api/identities', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '10.99.' + Math.floor(Math.random() * 200) + '.7' }, body: JSON.stringify({ record: rec, signature: await signRecord(privateKey, rec) }) });
console.log('identity', r.status);

async function headers(hash, size) {
  const record = { v: 2, type: 'blob.put', hash, size, signer: keyId, createdAt: Date.now() };
  return { 'x-hrd-key': keyId, 'x-hrd-time': String(record.createdAt), 'x-hrd-sig': await signRecord(privateKey, record) };
}

function stampLockHeader(b) { for (let i = 0; i < 8; i++) b[i] = 'HRDLOCK3'.charCodeAt(i); b[8] = 1; new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(9, 600000, false); return b; }
const size = LIMITS.MAX_BLOB_BYTES;
const bytes = new Uint8Array(size);
for (let off = 0; off < size; off += 65536) crypto.getRandomValues(bytes.subarray(off, Math.min(size, off + 65536)));
stampLockHeader(bytes);
const hash = await sha256Hex(bytes);
let t = performance.now();
r = await fetch(BASE + '/api/blobs/' + hash, { method: 'PUT', headers: await headers(hash, size), body: bytes });
console.log('max size PUT', size, 'bytes ->', r.status, await r.text(), Math.round(performance.now() - t), 'ms');

t = performance.now();
r = await fetch(BASE + '/api/blobs/' + hash);
const back = new Uint8Array(await r.arrayBuffer());
console.log('GET', r.status, back.length, 'hash ok', (await sha256Hex(back)) === hash, Math.round(performance.now() - t), 'ms', 'content-length', r.headers.get('content-length'));

// chunked upload (no content-length)
const small = stampLockHeader(crypto.getRandomValues(new Uint8Array(1000)));
const sh = await sha256Hex(small);
const stream = new ReadableStream({ start(c) { c.enqueue(small); c.close(); } });
try {
  r = await fetch(BASE + '/api/blobs/' + sh, { method: 'PUT', headers: await headers(sh, small.length), body: stream, duplex: 'half' });
  console.log('chunked PUT ->', r.status, await r.text());
} catch (e) { console.log('chunked PUT error', e.message); }

// one byte over the max
const over = new Uint8Array(size + 1);
r = await fetch(BASE + '/api/blobs/' + 'a'.repeat(64), { method: 'PUT', headers: await headers('a'.repeat(64), size + 1), body: over });
console.log('over max ->', r.status, await r.text());
