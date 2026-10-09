// Shared helpers for the backend attack scripts in this folder. Not a script itself.
// Every script: node tests/review/backend/<name>.mjs http://127.0.0.1:8791
// A PASS line means the server defended correctly. A FAIL line means a defect was proved.
import net from 'node:net';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex } from '../../../shared/encoding.js';
import { sha256Hex } from '../../../shared/hash.js';
import { exportPublicJwk, generateKeyPair, keyIdOf, signRecord } from '../../../shared/keys.js';
import { ZERO_HASH, newDocId, newNonce } from '../../../shared/records.js';

export { ZERO_HASH, newDocId, newNonce, sha256Hex, signRecord, bytesToHex };

// Applies every migration, in file name order, to a scratch node:sqlite database.
export function applyMigrations(db) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, name), 'utf8'));
}

export const BASE = (process.argv[2] || 'http://127.0.0.1:8791').replace(/\/+$/, '');
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const RUN = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(4)));

let passed = 0;
let failed = 0;

export async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + name + ': ' + (err && err.message ? err.message : err));
  }
}

export function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

export function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

export function eq(actual, expected, what = 'value') {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function brief(res) {
  return `HTTP ${res.status} ${res.json ? JSON.stringify(res.json).slice(0, 200) : res.text.slice(0, 200)}`;
}

export function expectStatus(res, status, code) {
  if (res.status !== status) throw new Error(`expected HTTP ${status}${code ? ' ' + code : ''}, got ${brief(res)}`);
  if (code && (!res.json || res.json.code !== code)) throw new Error(`expected code ${code}, got ${brief(res)}`);
}

// Any 4xx (not 5xx) is a proper rejection.
export function expectRejected(res, what = 'request') {
  if (res.status < 400 || res.status >= 500) throw new Error(`${what} should be rejected with 4xx, got ${brief(res)}`);
}

export async function call(method, path, { json, headers = {}, body, ip, raw } = {}) {
  const h = { ...headers };
  if (ip) h['CF-Connecting-IP'] = ip;
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
  }
  if (raw !== undefined) payload = raw;
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let parsed = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, headers: res.headers, json: parsed, bytes, text };
}

// Raw TCP HTTP/1.1 request, for lying Content-Length, truncated bodies and chunked bodies.
// parts: array of Buffers or strings written one after another. Returns { status, head, body }.
export function rawHttp(parts, { closeAfterWrite = false, waitMs = 4000 } = {}) {
  const u = new URL(BASE);
  return new Promise((resolveP) => {
    const sock = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    const chunks = [];
    let done = false;
    const finishUp = () => {
      if (done) return;
      done = true;
      const buf = Buffer.concat(chunks);
      const text = buf.toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      const head = split >= 0 ? text.slice(0, split) : text;
      const body = split >= 0 ? text.slice(split + 4) : '';
      const m = head.match(/^HTTP\/1\.[01] (\d{3})/);
      sock.destroy();
      resolveP({ status: m ? Number(m[1]) : 0, head, body });
    };
    sock.on('data', (d) => chunks.push(d));
    sock.on('close', finishUp);
    sock.on('error', finishUp);
    sock.on('connect', async () => {
      for (const p of parts) {
        sock.write(p);
        await new Promise((r) => setTimeout(r, 20));
      }
      if (closeAfterWrite) sock.end();
    });
    setTimeout(finishUp, waitMs);
  });
}

// ---------------------------------------------------------------------------
// identities

const ipSeed = Math.floor(Math.random() * 200) + 20;
let ipCounter = 0;
// A fresh fake client address (the server trusts CF-Connecting-IP in local dev).
export function freshIp() {
  ipCounter++;
  return `${ipSeed}.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${(ipCounter & 255) + 1}`;
}

export async function makeIdentity(displayName) {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: false });
  const publicJwk = await exportPublicJwk(publicKey);
  const keyId = await keyIdOf(publicJwk);
  const identityRecord = { v: 2, type: 'identity', publicKey: publicJwk, displayName, createdAt: Date.now() };
  const identitySignature = await signRecord(privateKey, identityRecord);
  return { keyId, publicJwk, privateKey, identityRecord, identitySignature, name: displayName };
}

export async function register(identity, ip = freshIp()) {
  const res = await call('POST', '/api/identities', {
    json: { record: identity.identityRecord, signature: identity.identitySignature },
    ip
  });
  expectStatus(res, 201);
  return identity;
}

export async function newPerson(name) {
  return register(await makeIdentity(`${name} ${RUN}`));
}

// ---------------------------------------------------------------------------
// blobs and documents (the server does not look inside blobs, so random bytes stand in)

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) globalThis.crypto.getRandomValues(out.subarray(off, Math.min(n, off + 65536)));
  return out;
}

// Stamps the HRDLOCK3 header (magic, suite 1, iterations) on random bytes. The server checks the first
// 53 bytes of an upload, and a locked file is never shorter than 151 bytes.
export const MIN_LOCKED = 151;
export function stampLockHeader(bytes, { iterations = 600000, suite = 1, magic = 'HRDLOCK3' } = {}) {
  for (let i = 0; i < 8; i++) bytes[i] = magic.charCodeAt(i);
  bytes[8] = suite;
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(9, iterations, false);
  return bytes;
}

export async function makeBlob(n = 300, header = {}) {
  const bytes = stampLockHeader(randomBytes(Math.max(n, MIN_LOCKED)), header);
  return { bytes, hash: await sha256Hex(bytes), size: bytes.length };
}

export async function putBlob(signer, blob, opts = {}) {
  const hash = opts.hash || blob.hash;
  const record = {
    v: 2,
    type: 'blob.put',
    hash,
    size: opts.signSize ?? blob.bytes.length,
    signer: opts.signerKeyId || signer.keyId,
    createdAt: opts.time ?? Date.now()
  };
  const signature = opts.signature || (await signRecord((opts.signWith || signer).privateKey, record));
  const headers = { 'x-hrd-key': record.signer, 'x-hrd-time': String(record.createdAt), 'x-hrd-sig': signature, ...(opts.headers || {}) };
  return call('PUT', '/api/blobs/' + (opts.pathHash || hash), { headers, body: opts.body || blob.bytes });
}

export function createRecord(owner, blob, o = {}) {
  return {
    v: 2,
    type: 'doc.create',
    docId: o.docId || newDocId(),
    version: 1,
    prev: ZERO_HASH,
    signer: o.signer || owner.keyId,
    createdAt: o.createdAt ?? Date.now(),
    label: o.label ?? 'review doc',
    listed: o.listed ?? true,
    blob: { hash: blob.hash, size: blob.size, suite: 1 },
    commitment: o.commitment || bytesToHex(randomBytes(32))
  };
}

export function updateRecord(owner, blob, o) {
  return {
    v: 2,
    type: 'doc.update',
    docId: o.docId,
    version: o.version,
    prev: o.prev,
    signer: o.signer || owner.keyId,
    createdAt: o.createdAt ?? Date.now(),
    label: o.label ?? 'review doc',
    blob: { hash: blob.hash, size: blob.size, suite: 1 },
    commitment: o.commitment || bytesToHex(randomBytes(32))
  };
}

export function revokeRecord(owner, o) {
  return {
    v: 2,
    type: 'doc.revoke',
    docId: o.docId,
    version: o.version,
    prev: o.prev,
    signer: o.signer || owner.keyId,
    createdAt: o.createdAt ?? Date.now(),
    reason: o.reason ?? 'withdrawn'
  };
}

export async function postDoc(signer, record, { docId = record.docId, signWith } = {}) {
  const signature = await signRecord((signWith || signer).privateKey, record);
  return call('POST', `/api/documents/${docId}/records`, { json: { record, signature } });
}

// Uploads a blob and creates a document. Returns { docId, blob, record, res, hash }.
export async function publish(owner, o = {}) {
  const blob = o.blob || (await makeBlob(o.size || 300));
  const up = await putBlob(owner, blob);
  assert(up.status === 200 || up.status === 201, 'blob upload failed: ' + brief(up));
  const record = createRecord(owner, blob, o);
  const res = await postDoc(owner, record);
  expectStatus(res, 201);
  return { docId: record.docId, blob, record, res, hash: res.json.recordHash };
}

// ---------------------------------------------------------------------------
// channels

export function channelRecord(owner, o = {}) {
  return {
    v: 2,
    type: 'channel.create',
    channelId: o.channelId || 'rv-' + bytesToHex(randomBytes(6)),
    title: o.title || 'review channel',
    docId: o.docId ?? '',
    signer: o.signer || owner.keyId,
    createdAt: o.createdAt ?? Date.now()
  };
}

export async function postChannel(signer, record, signWith) {
  const signature = await signRecord((signWith || signer).privateKey, record);
  return call('POST', '/api/channels', { json: { record, signature } });
}

export function messageRecord(owner, channelId, o = {}) {
  return {
    v: 2,
    type: 'message',
    channelId,
    body: o.body ?? 'hello ' + bytesToHex(randomBytes(4)),
    replyTo: o.replyTo ?? '',
    signer: o.signer || owner.keyId,
    createdAt: o.createdAt ?? Date.now(),
    nonce: o.nonce || newNonce()
  };
}

export async function postMessage(signer, channelId, record, signWith) {
  const signature = await signRecord((signWith || signer).privateKey, record);
  return call('POST', `/api/channels/${channelId}/messages`, { json: { record, signature } });
}

// ---------------------------------------------------------------------------
// read the local database directly (only possible because the server runs on this machine)

export async function openDb(stateDir) {
  const dir = stateDir || process.env.HRD_STATE_DIR || join(ROOT, '.wrangler', 'state-r1');
  const base = join(dir, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  if (!existsSync(base)) return null;
  const file = readdirSync(base).find((f) => f.endsWith('.sqlite'));
  if (!file) return null;
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(join(base, file), { readOnly: true });
}
