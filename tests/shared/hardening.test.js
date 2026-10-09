// Tests for the hardening fixes: plain object detection across realms, array accessors,
// chainHash input rules, invisible text, document head attestation options.
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { canonicalize, isPlainObject } from '../../shared/canonical.js';
import { chainHash } from '../../shared/hash.js';
import { ZERO_HASH, validateRecord } from '../../shared/records.js';
import { makeDocHeadPayload, signCheckpoint, verifyCheckpoint } from '../../shared/checkpoint.js';
import { verifyDocumentBundle, verifyLedgerPage } from '../../shared/verify.js';
import { buildBundle, buildBundleParts, buildLedger, clone, createIdentity, createServerKey, docHeadCheckpoint, identityEntry } from '../helpers/bundle.js';
import { signRecord } from '../../shared/keys.js';
import { newDocId } from '../../shared/records.js';

describe('isPlainObject across realms', () => {
  it('accepts plain objects made in another realm', () => {
    const foreign = vm.runInNewContext('({ a: 1, b: { c: 2 } })');
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect(isPlainObject(foreign)).toBe(true);
    expect(canonicalize(foreign)).toBe('{"a":1,"b":{"c":2}}');
  });
  it('rejects a hand made look alike prototype', () => {
    const fake = Object.create(null);
    fake.isPrototypeOf = () => false;
    fake.hasOwnProperty = () => true;
    fake.constructor = function Object() {};
    expect(isPlainObject(Object.create(fake))).toBe(false);
  });
  it('rejects class instances and foreign class instances', () => {
    expect(isPlainObject(vm.runInNewContext('new (class A {})()'))).toBe(false);
    expect(isPlainObject(vm.runInNewContext('new Date()'))).toBe(false);
  });
});

describe('canonicalize arrays', () => {
  it('rejects accessor elements', () => {
    const a = [1, 2];
    Object.defineProperty(a, 0, { enumerable: true, get: () => 5 });
    expect(() => canonicalize(a)).toThrow(/accessor/);
  });
  it('still accepts normal arrays', () => {
    expect(canonicalize([1, [2, 'x'], { b: 1, a: null }])).toBe('[1,[2,"x"],{"a":null,"b":1}]');
  });
});

describe('chainHash input rules', () => {
  const h = 'a'.repeat(64);
  it('rejects anything but two 64 char lowercase hex strings', async () => {
    const bad = [undefined, null, 5, '', 'a:b', 'A'.repeat(64), h + '\n', 'a'.repeat(63), [h], { toString: () => h }];
    for (const b of bad) {
      await expect(chainHash(b, h), String(b)).rejects.toThrow();
      await expect(chainHash(h, b), String(b)).rejects.toThrow();
    }
  });
  it('accepts the genesis link', async () => {
    await expect(chainHash(ZERO_HASH, h)).resolves.toHaveLength(64);
  });
});

describe('invisible text', () => {
  const idRec = { v: 2, type: 'identity', publicKey: null, displayName: 'Alice', createdAt: 1 };
  async function identityWith(displayName) {
    const id = await createIdentity('Alice');
    return validateRecord({ ...idRec, publicKey: id.publicJwk, displayName }).ok;
  }
  it('rejects invisible characters anywhere in a display name', async () => {
    expect(await identityWith('Alice')).toBe(true);
    for (const ch of ['​', '‌', '‍', '⁠', '­', 'ㅤ', '⠀', '﻿', '️', '\u{e0041}']) {
      expect(await identityWith('Al' + ch + 'ice'), JSON.stringify(ch)).toBe(false);
      expect(await identityWith(ch.repeat(2)), JSON.stringify(ch)).toBe(false);
    }
  });
  it('a message body may keep joiners (emoji), but needs a visible character', () => {
    const msg = { v: 2, type: 'message', channelId: 'room-1', body: 'x', replyTo: '', signer: 'a'.repeat(64), createdAt: 1, nonce: 'f'.repeat(32) };
    expect(validateRecord({ ...msg, body: '\u{1F468}‍\u{1F469}‍\u{1F467}' }).ok).toBe(true);
    expect(validateRecord({ ...msg, body: 'line one\nline two' }).ok).toBe(true);
    for (const body of ['​', '‍‍', 'ㅤ ⠀', ' \n ']) {
      expect(validateRecord({ ...msg, body }).ok, JSON.stringify(body)).toBe(false);
    }
  });
  it('a label may be empty but not only invisible, and has no invisible characters', async () => {
    const owner = await createIdentity('Owner');
    const rec = {
      v: 2, type: 'doc.create', docId: 'd'.repeat(32), version: 1, prev: ZERO_HASH, signer: owner.keyId, createdAt: 1,
      label: '', listed: true, blob: { hash: 'b'.repeat(64), size: 10, suite: 1 }, commitment: 'c'.repeat(64)
    };
    expect(validateRecord(rec).ok).toBe(true);
    expect(validateRecord({ ...rec, label: 'Lease 2026' }).ok).toBe(true);
    expect(validateRecord({ ...rec, label: '​' }).ok).toBe(false);
    expect(validateRecord({ ...rec, label: 'Le​ase' }).ok).toBe(false);
    expect(validateRecord({ ...rec, label: '   ' }).ok).toBe(false);
  });
});

describe('document head attestation', () => {
  it('makeDocHeadPayload signs and verifies like any checkpoint', async () => {
    const server = await createServerKey();
    const docId = newDocId();
    const payload = makeDocHeadPayload({ docId, headVersion: 3, headRecordHash: 'c'.repeat(64), signedAt: 100, serverKeyId: server.keyId });
    const cp = await signCheckpoint(server.privateKey, payload);
    expect(await verifyCheckpoint(server.publicJwk, cp)).toBe(true);
    expect(cp.payload.scope).toBe('doc:' + docId);
    await expect(signCheckpoint(server.privateKey, { ...payload, seq: 0, hash: ZERO_HASH })).rejects.toThrow();
    await expect(signCheckpoint(server.privateKey, { ...payload, scope: 'doc:xyz' })).rejects.toThrow();
  });
});

describe('verifyDocumentBundle options', () => {
  it('expectedDocId binds the result to the asked for document', async () => {
    const server = await createServerKey();
    const owner = await createIdentity('Owner');
    const bundle = await buildBundle({ owner, serverKey: server, versions: [{}, {}] });
    const docId = bundle.document.docId;
    const ok = await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId, expectedDocId: docId });
    expect(ok.ok).toBe(true);
    expect(ok.head.docId).toBe(docId);
    const other = await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId, expectedDocId: newDocId() });
    expect(other.ok).toBe(false);
    expect((await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId, expectedDocId: 'nope' })).ok).toBe(false);
  });

  it('maxCheckpointAgeMs also rejects a checkpoint dated in the future', async () => {
    const server = await createServerKey();
    const owner = await createIdentity('Owner');
    const future = Date.now() + 3600 * 1000;
    const bundle = await buildBundle({ owner, serverKey: server, now: future, versions: [{}] });
    expect((await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId })).ok).toBe(true);
    expect((await verifyDocumentBundle(bundle, { pinnedServerKeyId: server.keyId, maxCheckpointAgeMs: 600000 })).ok).toBe(false);
  });

  it('maxCheckpointAgeMs also applies to the head attestation', async () => {
    const server = await createServerKey();
    const owner = await createIdentity('Owner');
    const parts = await buildBundleParts({ owner, serverKey: server, versions: [{}] });
    await buildBundleParts({ owner, serverKey: server, ledger: parts.ledger });
    const b = clone(parts.bundle);
    const old = Date.now() - 7 * 24 * 3600 * 1000;
    b.headCheckpoint = await docHeadCheckpoint(server, b.document.docId, 1, b.records[0].recordHash, old);
    const res = await verifyDocumentBundle(b, { pinnedServerKeyId: server.keyId, maxCheckpointAgeMs: 3600 * 1000 });
    expect(res.ok).toBe(false);
  });

  it('a forged update for a document the server never saw does not verify', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const ledger = buildLedger();
    for (let i = 0; i < 4; i++) await buildBundleParts({ owner: alice, serverKey: server, ledger });
    const real = await buildBundleParts({ owner: alice, serverKey: server, ledger });
    const forged = await buildBundle({ owner: alice, serverKey: null, versions: [{}, {}] });
    forged.checkpoint = clone(real.bundle.checkpoint);
    forged.server = clone(real.bundle.server);
    forged.headCheckpoint = clone(real.bundle.headCheckpoint);
    const res = await verifyDocumentBundle(forged, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(false);
    expect(res.anchored).toBe(false);
  });
});

describe('verifyLedgerPage from the genesis', () => {
  it('a first entry that is an update is a problem, not a warning', async () => {
    const owner = await createIdentity('Owner');
    const source = await buildBundleParts({ owner, serverKey: null, versions: [{}, {}] });
    // Entry 2 of a real ledger, re-numbered as if it were the first one is not valid, so build
    // a ledger whose first appended record is the update.
    const ledger = buildLedger();
    const rec = clone(source.versions[1].record);
    const signature = await signRecord(owner.privateKey, rec);
    await ledger.append(rec, signature);
    const page = { ...ledger.page(), identities: { [owner.keyId]: identityEntry(owner) } };
    const res = await verifyLedgerPage(page);
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/no create record/);
    const loose = await verifyLedgerPage(page, { allowMidChain: true });
    expect(loose.ok).toBe(false);
  });
});
