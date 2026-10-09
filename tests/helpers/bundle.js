// Test helper: builds valid protocol data in memory with real keys.
//
// Everything here uses the real shared/ code and WebCrypto, so the data it makes
// passes the real verifiers. Use the mutate / signer / signWith hooks to build
// data that is signed correctly but wrong in one specific way.
//
//   const alice = await createIdentity('Alice');
//   const bundle = await buildBundle({ owner: alice, versions: [{ label: 'v1' }, { label: 'v2' }] });
//   const page = await buildChannelPage({ messages: [{ author: alice, body: 'hello' }] });
//
// buildBundle returns exactly the JSON shape of GET /api/documents/:docId.
// buildBundleParts returns the same bundle plus the pieces used to make it.
// buildChannelPage returns the shape of GET /api/channels/:channelId/messages.
import { concatBytes, utf8Encode, bytesToHex } from '../../shared/encoding.js';
import { chainHash, computeCommitment, sha256Hex } from '../../shared/hash.js';
import { makeCheckpointPayload, makeDocHeadPayload, signCheckpoint } from '../../shared/checkpoint.js';
import {
  exportPrivateJwk,
  exportPublicJwk,
  generateKeyPair,
  keyIdOf,
  signRecord
} from '../../shared/keys.js';
import { ZERO_HASH, newDocId, newNonce, recordHash } from '../../shared/records.js';

export const clone = (value) => structuredClone(value);

// New identity with real keys. identityRecord and identitySignature are what
// POST /api/identities takes. The private key is non extractable.
export async function createIdentity(displayName = 'Test Person', { createdAt = Date.now() } = {}) {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: false });
  const publicJwk = await exportPublicJwk(publicKey);
  const keyId = await keyIdOf(publicJwk);
  const identityRecord = { v: 2, type: 'identity', publicKey: publicJwk, displayName, createdAt };
  const identitySignature = await signRecord(privateKey, identityRecord);
  return { keyId, publicJwk, privateKey, identityRecord, identitySignature };
}

// The entry shape used in the "identities" maps of API responses.
export function identityEntry(identity) {
  return {
    keyId: identity.keyId,
    publicKey: clone(identity.publicJwk),
    displayName: identity.identityRecord.displayName,
    createdAt: identity.identityRecord.createdAt,
    record: clone(identity.identityRecord),
    signature: identity.identitySignature
  };
}

// A server signing key. privateJwk is what SERVER_SIGNING_JWK would hold.
export async function createServerKey() {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: true });
  const publicJwk = await exportPublicJwk(publicKey);
  const privateJwk = await exportPrivateJwk(privateKey);
  return { keyId: await keyIdOf(publicJwk), publicJwk, privateKey, privateJwk };
}

// The "server" field of API responses, or null when there is no server key.
export function serverInfo(serverKey) {
  return serverKey ? { keyId: serverKey.keyId, publicKey: serverKey.publicJwk } : null;
}

// Signs a record with an identity. Returns { record, signature } (the POST body).
export async function signedDocRecord(identity, record) {
  return { record, signature: await signRecord(identity.privateKey, record) };
}

// Stand in for a locked file: some bytes, their blob entry and a commitment.
// (Not a real HRDLOCK3 file, the shared library never opens locked files.)
export async function makeFileParts(content = 'file content') {
  const data = typeof content === 'string' ? utf8Encode(content) : content;
  const lockedBytes = concatBytes(utf8Encode('LOCKED:'), data);
  const fileHash = await sha256Hex(data);
  const commitSalt = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const commitment = await computeCommitment({ fileHash, commitSalt });
  const blob = { hash: await sha256Hex(lockedBytes), size: lockedBytes.length, suite: 1 };
  return { data, lockedBytes, fileHash, commitSalt, commitment, blob };
}

// Fake in memory ledger with the same chaining as the server.
export function buildLedger() {
  const entries = [];
  return {
    entries,
    // Head position, seq 0 and ZERO_HASH when empty.
    head() {
      const last = entries[entries.length - 1];
      return last ? { seq: last.seq, hash: last.ledgerHash } : { seq: 0, hash: ZERO_HASH };
    },
    // Appends a signed record, returns the entry (page entry shape).
    async append(record, signature) {
      const h = this.head();
      const rh = await recordHash(record);
      const entry = {
        seq: h.seq + 1,
        recordHash: rh,
        prevLedgerHash: h.hash,
        ledgerHash: await chainHash(h.hash, rh),
        record,
        signature
      };
      entries.push(entry);
      return entry;
    },
    // Like GET /api/ledger without identities, checkpoint and server.
    page({ after = 0, limit = 200 } = {}) {
      const list = entries.filter((e) => e.seq > after);
      return { entries: list.slice(0, limit), hasMore: list.length > limit };
    }
  };
}

// Signed checkpoint for the current ledger head (scope 'ledger').
export async function ledgerCheckpoint(serverKey, ledger, signedAt = Date.now()) {
  const h = ledger.head();
  const payload = makeCheckpointPayload({
    scope: 'ledger',
    seq: h.seq,
    hash: h.hash,
    signedAt,
    serverKeyId: serverKey.keyId
  });
  return signCheckpoint(serverKey.privateKey, payload);
}

// Signed attestation of a document head (scope 'doc:<docId>', seq = head version, hash = head
// record hash). This is what the server adds to GET /api/documents/:docId as headCheckpoint.
export async function docHeadCheckpoint(serverKey, docId, headVersion, headRecordHash, signedAt = Date.now()) {
  const payload = makeDocHeadPayload({ docId, headVersion, headRecordHash, signedAt, serverKeyId: serverKey.keyId });
  return signCheckpoint(serverKey.privateKey, payload);
}

// Builds a document bundle and returns all the parts.
//   owner      identity from createIdentity
//   versions   array of version options. The first one is the create, the rest are updates.
//              { label, content, createdAt, listed, reason, revoke, signer, signWith, mutate }
//                content   string or bytes of the (fake) file, default 'version N'
//                revoke    true makes this a doc.revoke (use { revoke: true, reason: '...' })
//                signer    identity: record.signer is this identity and it signs (adds it to identities)
//                signWith  identity: signs with this key while record.signer stays the owner (bad signature)
//                mutate    (record) => void, changes the record before it is signed and hashed
//   serverKey  createServerKey() result. undefined makes a fresh one, null means no server signing.
//              The bundle gets checkpoint (ledger head) and headCheckpoint (document head attestation).
//   docId, ledger, now, listed   optional
export async function buildBundleParts({
  owner,
  versions = [{}],
  serverKey,
  docId = newDocId(),
  ledger = buildLedger(),
  now = Date.now(),
  listed = true
} = {}) {
  if (serverKey === undefined) serverKey = await createServerKey();
  const identities = { [owner.keyId]: identityEntry(owner) };
  const out = [];
  let prev = ZERO_HASH;
  const start = now - versions.length * 1000;

  for (let i = 0; i < versions.length; i++) {
    const opt = versions[i];
    const signerIdentity = opt.signer || owner;
    identities[signerIdentity.keyId] = identityEntry(signerIdentity);
    const base = {
      v: 2,
      docId,
      version: i + 1,
      prev,
      signer: signerIdentity.keyId,
      createdAt: opt.createdAt ?? start + i * 1000
    };
    let record;
    let parts = null;
    if (opt.revoke) {
      record = { ...base, type: 'doc.revoke', reason: opt.reason ?? 'withdrawn' };
    } else {
      parts = await makeFileParts(opt.content ?? `version ${i + 1}`);
      record = {
        ...base,
        type: i === 0 ? 'doc.create' : 'doc.update',
        label: opt.label ?? `Document v${i + 1}`,
        ...(i === 0 ? { listed: opt.listed ?? listed } : {}),
        blob: parts.blob,
        commitment: parts.commitment
      };
    }
    if (opt.mutate) opt.mutate(record);
    const signature = await signRecord((opt.signWith || signerIdentity).privateKey, record);
    const entry = await ledger.append(record, signature);
    out.push({ ...(parts || {}), record, signature, recordHash: entry.recordHash, ledgerSeq: entry.seq, ledgerHash: entry.ledgerHash, prevLedgerHash: entry.prevLedgerHash });
    prev = entry.recordHash;
  }

  const last = out[out.length - 1];
  const first = out[0];
  const bundle = {
    document: {
      docId,
      ownerKeyId: owner.keyId,
      status: last.record.type === 'doc.revoke' ? 'revoked' : 'active',
      headVersion: last.record.version,
      headRecordHash: last.recordHash,
      listed: first.record.listed ?? listed,
      createdAt: first.record.createdAt,
      updatedAt: last.record.createdAt
    },
    records: out.map((v) => ({
      record: v.record,
      signature: v.signature,
      recordHash: v.recordHash,
      ledgerSeq: v.ledgerSeq,
      ledgerHash: v.ledgerHash,
      prevLedgerHash: v.prevLedgerHash
    })),
    identities,
    checkpoint: serverKey ? await ledgerCheckpoint(serverKey, ledger, now) : null,
    headCheckpoint: serverKey ? await docHeadCheckpoint(serverKey, docId, last.record.version, last.recordHash, now) : null,
    server: serverInfo(serverKey)
  };
  return { bundle, docId, owner, serverKey, ledger, versions: out, identities };
}

// Just the bundle, in the shape of GET /api/documents/:docId.
export async function buildBundle(options) {
  return (await buildBundleParts(options)).bundle;
}

// Builds a page of chat messages and returns the shape of
// GET /api/channels/:channelId/messages. The whole chain is built from seq 1, then cut.
//   messages  [{ author, body, replyTo, createdAt, mutate }]
//             replyTo may be the index of an earlier message or a 64 hex hash
//   creator   identity that makes the channel (default: first author)
//   after, limit, tail   cut the page like the API does
//   serverKey undefined makes a fresh one, null means no checkpoint
export async function buildChannelPage({
  channelId = 'general',
  title = 'General',
  docId = '',
  messages = [],
  creator,
  serverKey,
  after = 0,
  limit = 50,
  tail,
  now = Date.now()
} = {}) {
  if (serverKey === undefined) serverKey = await createServerKey();
  const chan = creator || (messages[0] && messages[0].author);
  const all = [];
  const hashes = [];
  let prevChain = ZERO_HASH;
  const authors = {};
  const start = now - (messages.length + 1) * 1000;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    authors[m.author.keyId] = m.author;
    let replyTo = m.replyTo ?? '';
    if (typeof replyTo === 'number') replyTo = hashes[replyTo];
    const record = {
      v: 2,
      type: 'message',
      channelId,
      body: m.body,
      replyTo,
      signer: m.author.keyId,
      createdAt: m.createdAt ?? start + i * 1000,
      nonce: newNonce()
    };
    if (m.mutate) m.mutate(record);
    const signature = await signRecord((m.signWith || m.author).privateKey, record);
    const hash = await recordHash(record);
    const chain = await chainHash(prevChain, hash);
    all.push({ seq: i + 1, hash, prevChainHash: prevChain, chainHash: chain, record, signature });
    hashes.push(hash);
    prevChain = chain;
  }

  let shown;
  let hasMore;
  if (tail !== undefined) {
    shown = all.slice(Math.max(0, all.length - tail));
    hasMore = false;
  } else {
    const rest = all.filter((m) => m.seq > after);
    shown = rest.slice(0, limit);
    hasMore = rest.length > limit;
  }

  const identities = {};
  for (const m of shown) identities[m.record.signer] = identityEntry(authors[m.record.signer]);

  const payload = makeCheckpointPayload({
    scope: 'channel:' + channelId,
    seq: all.length,
    hash: prevChain,
    signedAt: now,
    serverKeyId: serverKey ? serverKey.keyId : ZERO_HASH
  });
  const last = all[all.length - 1];
  return {
    channel: {
      channelId,
      title,
      docId,
      createdBy: chan ? chan.keyId : ZERO_HASH,
      createdByName: chan ? chan.identityRecord.displayName : '',
      createdAt: start,
      messageCount: all.length,
      lastMessageAt: last ? last.record.createdAt : null
    },
    messages: shown,
    identities,
    checkpoint: serverKey ? await signCheckpoint(serverKey.privateKey, payload) : null,
    server: serverInfo(serverKey),
    hasMore
  };
}
