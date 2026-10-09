import { beforeAll, describe, expect, it } from 'vitest';
import { verifyDocumentBundle } from '../../shared/verify.js';
import { makeCheckpointPayload, signCheckpoint } from '../../shared/checkpoint.js';
import { ZERO_HASH } from '../../shared/records.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../shared/encoding.js';
import { buildBundle, buildBundleParts, clone, createIdentity, createServerKey, docHeadCheckpoint, identityEntry } from '../helpers/bundle.js';

const IDS = ['identities_match', 'record_signatures', 'chain_links', 'single_owner', 'no_post_revoke', 'ledger_links', 'head_matches', 'checkpoint'];
const failed = (res) => res.checks.filter((c) => !c.ok).map((c) => c.id);
const flip = (sig) => {
  const b = base64UrlToBytes(sig);
  b[5] ^= 1;
  return bytesToBase64Url(b);
};

let alice;
let bob;
let server;
let parts3; // 3 versions
const three = [{ label: 'Lease' }, { label: 'Lease, amended' }, { label: 'Lease, final' }];

// Fresh copy of a valid 3 version bundle each time.
const fresh = () => clone(parts3.bundle);

beforeAll(async () => {
  alice = await createIdentity('Alice Registrar');
  bob = await createIdentity('Bob Clerk');
  server = await createServerKey();
  parts3 = await buildBundleParts({ owner: alice, versions: three, serverKey: server });
});

describe('valid bundles', () => {
  it('a single version document verifies', async () => {
    const bundle = await buildBundle({ owner: alice, versions: [{ label: 'Deed' }], serverKey: server });
    const res = await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('active');
    expect(res.head.version).toBe(1);
    expect(res.head.label).toBe('Deed');
  });
  it('a multi version bundle verifies and reports the head', async () => {
    const res = await verifyDocumentBundle(fresh(), { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('active');
    expect(failed(res)).toEqual([]);
    const last = parts3.versions[2];
    expect(res.anchored).toBe(true);
    expect(res.head).toEqual({
      docId: parts3.docId,
      version: 3,
      recordHash: last.recordHash,
      blobHash: last.record.blob.hash,
      label: 'Lease, final',
      signer: alice.keyId,
      signerName: 'Alice Registrar',
      createdAt: last.record.createdAt
    });
  });
  it('returns every check in a stable order', async () => {
    const res = await verifyDocumentBundle(fresh());
    expect(res.checks.map((c) => c.id)).toEqual(IDS);
    for (const c of res.checks) expect(typeof c.detail).toBe('string');
    expect(res.checks.every((c) => c.detail.length > 0)).toBe(true);
  });
  it('a revoked document is ok with status revoked and no blob', async () => {
    const bundle = await buildBundle({
      owner: alice,
      versions: [{ label: 'Permit' }, { label: 'Permit v2' }, { revoke: true, reason: 'issued in error' }],
      serverKey: server
    });
    const res = await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('revoked');
    expect(res.head.version).toBe(3);
    expect(res.head.blobHash).toBeNull();
    expect(res.head.label).toBe('Permit v2');
  });
  it('works for documents that are not first in the ledger', async () => {
    const first = await buildBundleParts({ owner: bob, versions: [{}, {}], serverKey: server });
    const second = await buildBundleParts({ owner: alice, versions: [{}, {}], serverKey: server, ledger: first.ledger });
    expect(second.bundle.records[0].ledgerSeq).toBe(3);
    const res = await verifyDocumentBundle(second.bundle, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(true);
  });
  it('unlisted documents verify too', async () => {
    const bundle = await buildBundle({ owner: alice, listed: false, serverKey: server });
    expect(bundle.document.listed).toBe(false);
    expect((await verifyDocumentBundle(bundle)).ok).toBe(true);
  });
  it('does not change its input', async () => {
    const b = fresh();
    const copy = clone(b);
    await verifyDocumentBundle(b);
    expect(b).toEqual(copy);
  });
});

describe('warnings', () => {
  it('always says latest means latest as of the checkpoint', async () => {
    for (const bundle of [fresh(), {}, null]) {
      const res = await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId });
      expect(res.warnings.some((w) => /latest as of the checkpoint time/i.test(w) && /ledger audit/i.test(w))).toBe(true);
    }
  });
  it('warns when the server key is not pinned and passes anyway', async () => {
    const res = await verifyDocumentBundle(fresh());
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => /not pinned/i.test(w))).toBe(true);
  });
  it('does not warn about pinning when pinned', async () => {
    const res = await verifyDocumentBundle(fresh(), { pinnedServerKeyId: server.keyId });
    expect(res.warnings.some((w) => /not pinned/i.test(w))).toBe(false);
  });
  it('accepts a pinned key id with spaces and capitals', async () => {
    const res = await verifyDocumentBundle(fresh(), { pinnedServerKeyId: '  ' + server.keyId.toUpperCase() + ' ' });
    expect(res.ok).toBe(true);
  });
  it('reports the checkpoint age using the given clock', async () => {
    const signedAt = fresh().checkpoint.payload.signedAt;
    const res = await verifyDocumentBundle(fresh(), { now: signedAt + 3 * 3600 * 1000 });
    expect(res.warnings.some((w) => /3 hours/.test(w))).toBe(true);
    const early = await verifyDocumentBundle(fresh(), { now: signedAt - 3600 * 1000 });
    expect(early.warnings.some((w) => /future/.test(w))).toBe(true);
    expect(early.ok).toBe(true);
  });
  it('a dropped newest version with an edited summary is caught by the anchoring rule', async () => {
    // The two record history is valid on its own, but the checkpoint is ahead of it and the
    // server attestation names version 3, so the bundle is not tied to the server.
    const b = fresh();
    b.records.pop();
    b.document.headVersion = 2;
    b.document.headRecordHash = b.records[1].recordHash;
    const res = await verifyDocumentBundle(b, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(false);
    expect(failed(res)).toEqual(['checkpoint']);
    expect(res.anchored).toBe(false);
  });
  it('known limit: a server that signs a fresh attestation for an older head is not caught by one bundle', async () => {
    // A hostile server can attest an older head. Only a pinned older checkpoint or a ledger audit
    // by the caller can show that a newer version exists.
    const b = fresh();
    b.records.pop();
    b.document.headVersion = 2;
    b.document.headRecordHash = b.records[1].recordHash;
    b.headCheckpoint = await docHeadCheckpoint(server, parts3.docId, 2, b.records[1].recordHash);
    const res = await verifyDocumentBundle(b, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(true);
    expect(res.head.version).toBe(2);
    expect(res.warnings.some((w) => /ledger audit/i.test(w))).toBe(true);
  });
});

describe('identities_match', () => {
  it('fails when an identity record is changed after signing', async () => {
    const b = fresh();
    b.identities[alice.keyId].record.displayName = 'Mallory';
    b.identities[alice.keyId].displayName = 'Mallory';
    const res = await verifyDocumentBundle(b);
    expect(res.ok).toBe(false);
    expect(failed(res)).toContain('identities_match');
    expect(res.status).toBe('invalid');
    expect(res.head).toBeNull();
  });
  it('fails when the outer fields disagree with the signed record', async () => {
    for (const edit of [(e) => (e.displayName = 'Someone Else'), (e) => (e.createdAt += 1), (e) => (e.publicKey = clone(bob.publicJwk))]) {
      const b = fresh();
      edit(b.identities[alice.keyId]);
      expect(failed(await verifyDocumentBundle(b)), edit.toString()).toContain('identities_match');
    }
  });
  it('fails when the keyId does not match the key', async () => {
    const b = fresh();
    b.identities[alice.keyId].keyId = bob.keyId;
    expect(failed(await verifyDocumentBundle(b))).toContain('identities_match');
  });
  it('fails when an identity is listed under a different key id', async () => {
    const b = fresh();
    b.identities[bob.keyId] = clone(b.identities[alice.keyId]);
    const res = await verifyDocumentBundle(b);
    expect(failed(res)).toContain('identities_match');
  });
  it('fails when an identity is swapped for another key with a stolen signature', async () => {
    const b = fresh();
    b.identities[alice.keyId].record = clone(identityEntry(bob).record);
    b.identities[alice.keyId].publicKey = clone(bob.publicJwk);
    expect(failed(await verifyDocumentBundle(b))).toContain('identities_match');
  });
  it('fails on a bad identity self signature', async () => {
    const b = fresh();
    b.identities[alice.keyId].signature = flip(b.identities[alice.keyId].signature);
    expect(failed(await verifyDocumentBundle(b))).toContain('identities_match');
  });
  it('fails when identities are missing entirely', async () => {
    const b = fresh();
    delete b.identities;
    const res = await verifyDocumentBundle(b);
    expect(failed(res)).toContain('identities_match');
    expect(res.ok).toBe(false);
  });
  it('fails for an invalid identity record', async () => {
    const b = fresh();
    b.identities[alice.keyId].record = { ...b.identities[alice.keyId].record, extra: 1 };
    expect(failed(await verifyDocumentBundle(b))).toContain('identities_match');
  });
});

describe('record_signatures', () => {
  it('fails when a record is changed after signing', async () => {
    const b = fresh();
    b.records[1].record.label = 'Lease, secretly changed';
    const res = await verifyDocumentBundle(b);
    expect(failed(res)).toContain('record_signatures');
    expect(res.ok).toBe(false);
  });
  it('fails when the file hash in a record is swapped for another version\'s hash', async () => {
    const b = fresh();
    const a1 = b.records[0].record.blob;
    b.records[0].record.blob = b.records[1].record.blob;
    b.records[1].record.blob = a1;
    expect(failed(await verifyDocumentBundle(b))).toContain('record_signatures');
  });
  it('fails when a record is signed by another key', async () => {
    const bundle = await buildBundle({ owner: alice, versions: [{}, { signWith: bob }, {}], serverKey: server });
    const res = await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId });
    expect(failed(res)).toEqual(['record_signatures']);
  });
  it('fails on a flipped or malformed signature', async () => {
    for (const sig of [flip(parts3.bundle.records[2].signature), '', 'abc', null, 5]) {
      const b = fresh();
      b.records[2].signature = sig;
      expect(failed(await verifyDocumentBundle(b)), String(sig)).toContain('record_signatures');
    }
  });
  it('fails when the signer has no identity in the bundle', async () => {
    const b = fresh();
    b.identities = {};
    const res = await verifyDocumentBundle(b);
    expect(failed(res)).toEqual(['record_signatures']);
    expect(res.checks.find((c) => c.id === 'record_signatures').detail).toMatch(/no identity/);
  });
  it('fails when the stated record hash is wrong', async () => {
    const b = fresh();
    b.records[1].recordHash = '0'.repeat(63) + '1';
    expect(failed(await verifyDocumentBundle(b))).toContain('record_signatures');
  });
  it('fails when a record is not a valid document record', async () => {
    const b = fresh();
    b.records[1].record.extra = 1;
    expect(failed(await verifyDocumentBundle(b))).toContain('record_signatures');
    const c = fresh();
    c.records[1].record = null;
    expect(failed(await verifyDocumentBundle(c))).toContain('record_signatures');
  });
  it('fails when an identity with the right id has a different key than the signer used', async () => {
    const b = fresh();
    // Alice's identity entry replaced with Bob's under Alice's id: signatures cannot match.
    b.identities[alice.keyId] = clone(b.identities[bob.keyId] || identityEntry(bob));
    const res = await verifyDocumentBundle(b);
    expect(failed(res)).toContain('record_signatures');
  });
});

describe('chain_links', () => {
  it('fails when prev is changed on a record (signed correctly)', async () => {
    const bundle = await buildBundle({
      owner: alice,
      versions: [{}, { mutate: (r) => (r.prev = 'a'.repeat(64)) }, {}],
      serverKey: server
    });
    const res = await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId });
    expect(failed(res)).toEqual(['chain_links']);
  });
  it('fails when a version number is skipped even though prev links hold', async () => {
    const bundle = await buildBundle({ owner: alice, versions: [{}, { mutate: (r) => (r.version = 3) }], serverKey: server });
    const res = await verifyDocumentBundle(bundle);
    expect(failed(res)).toEqual(['chain_links']);
    expect(res.checks.find((c) => c.id === 'chain_links').detail).toMatch(/version 3, expected 2/);
  });
  it('fails when version 1 does not start from the zero hash', async () => {
    const bundle = await buildBundle({
      owner: alice,
      versions: [{ mutate: (r) => (r.prev = 'a'.repeat(64)) }],
      serverKey: server
    });
    // The validator already rejects this record, so signatures fail as well.
    const res = await verifyDocumentBundle(bundle);
    expect(res.ok).toBe(false);
    expect(failed(res)).toContain('chain_links');
  });
  it('fails when the versions are reordered', async () => {
    const b = fresh();
    [b.records[0], b.records[1]] = [b.records[1], b.records[0]];
    const res = await verifyDocumentBundle(b);
    expect(res.ok).toBe(false);
    expect(failed(res)).toEqual(expect.arrayContaining(['chain_links', 'ledger_links']));
  });
  it('fails when a middle version is dropped', async () => {
    const b = fresh();
    b.records.splice(1, 1);
    const res = await verifyDocumentBundle(b);
    expect(failed(res)).toContain('chain_links');
  });
  it('fails when the first version is dropped', async () => {
    const b = fresh();
    b.records.shift();
    expect(failed(await verifyDocumentBundle(b))).toContain('chain_links');
  });
  it('fails when a version is repeated', async () => {
    const b = fresh();
    b.records.push(clone(b.records[2]));
    expect(failed(await verifyDocumentBundle(b))).toContain('chain_links');
  });
  it('fails when a record belongs to a different document', async () => {
    const bundle = await buildBundle({
      owner: alice,
      versions: [{}, { mutate: (r) => (r.docId = 'f'.repeat(32)) }, {}],
      serverKey: server
    });
    expect(failed(await verifyDocumentBundle(bundle))).toContain('chain_links');
  });
  it('fails when the document summary names another document id', async () => {
    const b = fresh();
    b.document.docId = 'e'.repeat(32);
    expect(failed(await verifyDocumentBundle(b))).toContain('chain_links');
  });
  it('fails when there are no records', async () => {
    const b = fresh();
    b.records = [];
    const res = await verifyDocumentBundle(b);
    expect(res.ok).toBe(false);
    expect(failed(res)).toContain('chain_links');
  });
});

describe('single_owner', () => {
  it('fails when another registered key signs a version', async () => {
    const bundle = await buildBundle({ owner: alice, versions: [{}, { signer: bob }, {}], serverKey: server });
    const res = await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId });
    expect(failed(res)).toEqual(['single_owner']);
  });
  it('fails when the document owner differs from the signer', async () => {
    const b = fresh();
    b.document.ownerKeyId = bob.keyId;
    expect(failed(await verifyDocumentBundle(b))).toContain('head_matches');
  });
});

describe('no_post_revoke', () => {
  it('fails when an update follows a revoke', async () => {
    const bundle = await buildBundle({
      owner: alice,
      versions: [{}, { revoke: true, reason: 'oops' }, { label: 'sneaky update' }],
      serverKey: server
    });
    const res = await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId });
    expect(failed(res)).toEqual(['no_post_revoke']);
  });
  it('fails when two revokes follow each other', async () => {
    const bundle = await buildBundle({
      owner: alice,
      versions: [{}, { revoke: true }, { revoke: true }],
      serverKey: server
    });
    expect(failed(await verifyDocumentBundle(bundle))).toContain('no_post_revoke');
  });
  it('fails when createdAt goes backwards', async () => {
    const t = Date.now();
    const bundle = await buildBundle({
      owner: alice,
      versions: [{ createdAt: t }, { createdAt: t - 5000 }],
      serverKey: server
    });
    const res = await verifyDocumentBundle(bundle);
    expect(failed(res)).toEqual(['no_post_revoke']);
  });
  it('allows equal timestamps', async () => {
    const t = Date.now();
    const bundle = await buildBundle({ owner: alice, versions: [{ createdAt: t }, { createdAt: t }], serverKey: server });
    expect((await verifyDocumentBundle(bundle)).ok).toBe(true);
  });
});

describe('ledger_links', () => {
  it('fails when a ledger hash is changed', async () => {
    const b = fresh();
    b.records[1].ledgerHash = 'c'.repeat(64);
    const res = await verifyDocumentBundle(b);
    expect(failed(res)).toContain('ledger_links');
  });
  it('fails when a ledger hash is forged consistently with its neighbour (recomputation catches it)', async () => {
    const b = fresh();
    b.records[1].ledgerHash = 'c'.repeat(64);
    b.records[2].prevLedgerHash = 'c'.repeat(64);
    const res = await verifyDocumentBundle(b);
    expect(failed(res)).toEqual(['ledger_links']);
    expect(res.checks.find((c) => c.id === 'ledger_links').detail).toMatch(/does not match the record/);
  });
  it('fails when prevLedgerHash is changed', async () => {
    const b = fresh();
    b.records[2].prevLedgerHash = 'c'.repeat(64);
    expect(failed(await verifyDocumentBundle(b))).toContain('ledger_links');
  });
  it('fails when ledgerSeq does not increase', async () => {
    const b = fresh();
    b.records[2].ledgerSeq = b.records[1].ledgerSeq;
    expect(failed(await verifyDocumentBundle(b))).toContain('ledger_links');
    const c = fresh();
    c.records[2].ledgerSeq = 1;
    expect(failed(await verifyDocumentBundle(c))).toContain('ledger_links');
  });
  it('fails when ledger fields are missing or malformed', async () => {
    for (const edit of [(r) => delete r.ledgerHash, (r) => (r.ledgerSeq = '2'), (r) => (r.ledgerSeq = 0), (r) => (r.prevLedgerHash = 'xyz')]) {
      const b = fresh();
      edit(b.records[1]);
      expect(failed(await verifyDocumentBundle(b)), edit.toString()).toContain('ledger_links');
    }
  });
  it('fails when the first ledger entry does not start from the zero hash', async () => {
    const b = fresh();
    b.records[0].ledgerSeq = 1;
    b.records[0].prevLedgerHash = 'a'.repeat(64);
    expect(failed(await verifyDocumentBundle(b))).toContain('ledger_links');
  });
  it('accepts gaps in ledger seq (other documents in between)', async () => {
    const other = await buildBundleParts({ owner: bob, serverKey: server });
    const a = await buildBundleParts({ owner: alice, versions: [{}], serverKey: server, ledger: other.ledger });
    const more = await buildBundleParts({ owner: bob, serverKey: server, ledger: other.ledger });
    const parts = await buildBundleParts({ owner: alice, versions: [{}, {}], serverKey: server, ledger: more.ledger });
    expect(parts.bundle.records[0].ledgerSeq).toBeGreaterThan(a.bundle.records[0].ledgerSeq);
    expect((await verifyDocumentBundle(parts.bundle)).ok).toBe(true);
  });
});

describe('head_matches', () => {
  it('fails when the latest record is dropped but the summary still claims it', async () => {
    const b = fresh();
    b.records.pop();
    const res = await verifyDocumentBundle(b, { pinnedServerKeyId: server.keyId });
    // The checkpoint check fails too: the checkpoint is ahead of the records left.
    expect(failed(res)).toEqual(['head_matches', 'checkpoint']);
  });
  it('fails on a wrong head version, head hash, status or owner', async () => {
    const edits = [
      (d) => (d.headVersion = 2),
      (d) => (d.headRecordHash = 'd'.repeat(64)),
      (d) => (d.status = 'revoked'),
      (d) => (d.ownerKeyId = bob.keyId)
    ];
    for (const edit of edits) {
      const b = fresh();
      edit(b.document);
      expect(failed(await verifyDocumentBundle(b)), edit.toString()).toEqual(['head_matches']);
    }
  });
  it('fails when a revoked document is shown as active', async () => {
    const bundle = await buildBundle({ owner: alice, versions: [{}, { revoke: true }], serverKey: server });
    bundle.document.status = 'active';
    expect(failed(await verifyDocumentBundle(bundle))).toEqual(['head_matches']);
  });
  it('fails when the document summary is missing', async () => {
    for (const doc of [undefined, null, 'x', []]) {
      const b = fresh();
      b.document = doc;
      expect(failed(await verifyDocumentBundle(b))).toContain('head_matches');
    }
  });
  it('only warns when the unsigned listed flag disagrees', async () => {
    const b = fresh();
    b.document.listed = !b.document.listed;
    const res = await verifyDocumentBundle(b);
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => /listed/.test(w))).toBe(true);
  });
});

describe('checkpoint', () => {
  it('fails when the checkpoint is missing', async () => {
    const b = fresh();
    b.checkpoint = null;
    const res = await verifyDocumentBundle(b);
    expect(failed(res)).toEqual(['checkpoint']);
    expect(res.ok).toBe(false);
  });
  it('fails when the server info is missing', async () => {
    const b = fresh();
    b.server = null;
    expect(failed(await verifyDocumentBundle(b))).toEqual(['checkpoint']);
  });
  it('fails for a server that never signs (no checkpoint, no server)', async () => {
    const bundle = await buildBundle({ owner: alice, serverKey: null });
    expect(bundle.checkpoint).toBeNull();
    expect(bundle.server).toBeNull();
    const res = await verifyDocumentBundle(bundle);
    expect(failed(res)).toEqual(['checkpoint']);
  });
  it('fails on a bad checkpoint signature', async () => {
    const b = fresh();
    b.checkpoint.signature = flip(b.checkpoint.signature);
    expect(failed(await verifyDocumentBundle(b))).toEqual(['checkpoint']);
  });
  it('fails when the checkpoint payload is changed', async () => {
    const b = fresh();
    b.checkpoint.payload.seq += 5;
    expect(failed(await verifyDocumentBundle(b))).toEqual(['checkpoint']);
  });
  it('fails when the pinned server key is different', async () => {
    const wrong = await createServerKey();
    const res = await verifyDocumentBundle(fresh(), { pinnedServerKeyId: wrong.keyId });
    expect(failed(res)).toEqual(['checkpoint']);
    expect(res.ok).toBe(false);
    expect(res.checks.find((c) => c.id === 'checkpoint').detail).toMatch(/pinned/);
  });
  it('fails when an attacker signs a checkpoint with their own key and swaps the server info', async () => {
    const attacker = await createServerKey();
    const b = fresh();
    b.server = { keyId: attacker.keyId, publicKey: attacker.publicJwk };
    const payload = { ...b.checkpoint.payload, serverKeyId: attacker.keyId };
    b.checkpoint = await signCheckpoint(attacker.privateKey, payload);
    // Leaving the old head attestation in place already fails, even without a pin.
    expect(failed(await verifyDocumentBundle(b))).toEqual(['checkpoint']);
    const last = b.records[b.records.length - 1];
    b.headCheckpoint = await docHeadCheckpoint(attacker, b.document.docId, last.record.version, last.recordHash);
    // With everything re-signed, this looks valid without a pin, which is exactly why pinning matters.
    expect((await verifyDocumentBundle(b)).ok).toBe(true);
    expect(failed(await verifyDocumentBundle(b, { pinnedServerKeyId: server.keyId }))).toEqual(['checkpoint']);
  });
  it('fails when the stated server key id does not match the server key', async () => {
    const b = fresh();
    b.server.keyId = 'f'.repeat(64);
    expect(failed(await verifyDocumentBundle(b))).toEqual(['checkpoint']);
  });
  it('fails when the server public key is invalid', async () => {
    const b = fresh();
    b.server.publicKey = { ...b.server.publicKey, x: 'bad' };
    expect(failed(await verifyDocumentBundle(b))).toEqual(['checkpoint']);
  });
  it('fails when the checkpoint is older than the last record', async () => {
    const b = fresh();
    const payload = makeCheckpointPayload({
      scope: 'ledger',
      seq: b.records[1].ledgerSeq,
      hash: b.records[1].ledgerHash,
      signedAt: Date.now(),
      serverKeyId: server.keyId
    });
    b.checkpoint = await signCheckpoint(server.privateKey, payload);
    const res = await verifyDocumentBundle(b);
    expect(failed(res)).toEqual(['checkpoint']);
    expect(res.checks.find((c) => c.id === 'checkpoint').detail).toMatch(/older/);
  });
  it('fails when the checkpoint is for the same position but a different hash', async () => {
    const b = fresh();
    const payload = makeCheckpointPayload({
      scope: 'ledger',
      seq: b.records[2].ledgerSeq,
      hash: 'e'.repeat(64),
      signedAt: Date.now(),
      serverKeyId: server.keyId
    });
    b.checkpoint = await signCheckpoint(server.privateKey, payload);
    expect(failed(await verifyDocumentBundle(b))).toEqual(['checkpoint']);
  });
  // A newer ledger checkpoint (other documents were added since) only counts when the server
  // attests the head of this document too.
  async function withNewerCheckpoint() {
    const parts = await buildBundleParts({ owner: alice, serverKey: server });
    await buildBundleParts({ owner: bob, serverKey: server, ledger: parts.ledger });
    const payload = makeCheckpointPayload({ scope: 'ledger', seq: parts.ledger.head().seq, hash: parts.ledger.head().hash, signedAt: Date.now(), serverKeyId: server.keyId });
    const b = clone(parts.bundle);
    b.checkpoint = await signCheckpoint(server.privateKey, payload);
    return b;
  }
  it('accepts a newer checkpoint than the last record when the document head is attested', async () => {
    const b = await withNewerCheckpoint();
    const res = await verifyDocumentBundle(b, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(true);
    expect(res.anchored).toBe(true);
  });
  it('rejects a newer checkpoint without a head attestation', async () => {
    const b = await withNewerCheckpoint();
    delete b.headCheckpoint;
    const res = await verifyDocumentBundle(b, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(false);
    expect(failed(res)).toEqual(['checkpoint']);
    expect(res.anchored).toBe(false);
    b.headCheckpoint = null;
    expect((await verifyDocumentBundle(b, { pinnedServerKeyId: server.keyId })).ok).toBe(false);
  });
  it('allowUnanchored accepts it with a warning and anchored false', async () => {
    const b = await withNewerCheckpoint();
    b.headCheckpoint = null;
    const res = await verifyDocumentBundle(b, { pinnedServerKeyId: server.keyId, allowUnanchored: true });
    expect(res.ok).toBe(true);
    expect(res.anchored).toBe(false);
    expect(res.warnings.some((w) => /not tied to the server/i.test(w))).toBe(true);
  });
  it('rejects an attestation for another version, another document or signed by another key', async () => {
    const b = await withNewerCheckpoint();
    const last = b.records[b.records.length - 1];
    const wrong = [
      await docHeadCheckpoint(server, b.document.docId, last.record.version + 1, last.recordHash),
      await docHeadCheckpoint(server, b.document.docId, last.record.version, 'f'.repeat(64)),
      await docHeadCheckpoint(server, 'e'.repeat(32), last.record.version, last.recordHash),
      await docHeadCheckpoint(await createServerKey(), b.document.docId, last.record.version, last.recordHash),
      { payload: b.checkpoint.payload, signature: b.checkpoint.signature }
    ];
    for (const att of wrong) {
      const c = clone(b);
      c.headCheckpoint = att;
      const res = await verifyDocumentBundle(c, { pinnedServerKeyId: server.keyId });
      expect(res.ok).toBe(false);
      expect(failed(res)).toEqual(['checkpoint']);
    }
  });
  it('an attestation does not rescue a bundle whose records were swapped for another history', async () => {
    const b = await withNewerCheckpoint();
    const mallory = await createIdentity('Mallory');
    const other = await buildBundle({ owner: mallory, serverKey: null, versions: [{}] });
    other.checkpoint = b.checkpoint;
    other.server = b.server;
    other.headCheckpoint = b.headCheckpoint;
    expect((await verifyDocumentBundle(other, { pinnedServerKeyId: server.keyId })).ok).toBe(false);
  });
  it('fails for a channel checkpoint', async () => {
    const b = fresh();
    const payload = makeCheckpointPayload({
      scope: 'channel:general',
      seq: 100,
      hash: 'a'.repeat(64),
      signedAt: Date.now(),
      serverKeyId: server.keyId
    });
    b.checkpoint = await signCheckpoint(server.privateKey, payload);
    expect(failed(await verifyDocumentBundle(b))).toEqual(['checkpoint']);
  });
});

describe('malformed input never throws', () => {
  const inputs = [undefined, null, 0, 'text', [], {}, { records: 'x' }, { records: [null] }, { document: {}, records: [{}], identities: [] }, { records: [{ record: { type: 'doc.create' } }] }];
  it.each(inputs.map((v, i) => [i, v]))('input %i', async (_, input) => {
    const res = await verifyDocumentBundle(input, { pinnedServerKeyId: 5 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('invalid');
    expect(res.head).toBeNull();
    expect(res.checks.map((c) => c.id)).toEqual(IDS);
    expect(res.checks.some((c) => !c.ok)).toBe(true);
    expect(Array.isArray(res.warnings)).toBe(true);
  });
  it('handles a bad options argument', async () => {
    expect((await verifyDocumentBundle(fresh(), null)).ok).toBe(true);
    expect((await verifyDocumentBundle(fresh(), 'x')).ok).toBe(true);
    expect((await verifyDocumentBundle(fresh(), { now: 'soon' })).ok).toBe(true);
  });
  it('survives hostile structures in records', async () => {
    const b = fresh();
    b.records[1].record = JSON.parse('{"__proto__":{"x":1},"type":"doc.update"}');
    b.records[0].record.label = { a: [undefined] };
    const res = await verifyDocumentBundle(b);
    expect(res.ok).toBe(false);
  });
  it('zero hash constant is not used as a valid signer', async () => {
    const b = fresh();
    b.records[0].record.signer = ZERO_HASH;
    expect((await verifyDocumentBundle(b)).ok).toBe(false);
  });
});
