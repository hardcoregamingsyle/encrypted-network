// End to end check of the API over real HTTP.
//   node scripts/e2e.mjs http://127.0.0.1:8790
//
// Uses only HTTP plus the real shared/ and src/lib/lockfile.js code, with freshly generated
// identities and random ids, so it can run again and again against the same server.
// Prints one line per check and exits non zero if any check failed.
import { bytesToHex } from '../shared/encoding.js';
import { sha256Hex } from '../shared/hash.js';
import { verifyCheckpoint } from '../shared/checkpoint.js';
import { exportPublicJwk, generateKeyPair, keyIdOf, signRecord } from '../shared/keys.js';
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('e2e crashed: ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
