import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lockFile } from '../../src/lib/lockfile.js';
import { buildBundleParts, clone, createIdentity, createServerKey, ledgerCheckpoint } from '../helpers/bundle.js';

// Fake api: getDocument and getBlob answer from tables the tests fill in.
const fake = vi.hoisted(() => ({
  state: { calls: [], bundles: new Map(), blobs: new Map(), failDoc: null, failBlob: null }
}));

vi.mock('../../src/lib/api.js', () => ({
  getDocument: async (docId) => {
    fake.state.calls.push('getDocument');
    if (fake.state.failDoc) throw fake.state.failDoc;
    return structuredClone(fake.state.bundles.get(docId));
  },
  getBlob: async (hash) => {
    fake.state.calls.push('getBlob');
    if (fake.state.failBlob) throw fake.state.failBlob;
    const b = fake.state.blobs.get(hash);
    if (!b) throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' });
    return b.slice();
  },
  putBlob: async () => ({}),
  postDocRecord: async () => ({})
}));

const { openDocument } = await import('../../src/lib/publish.js');

const FAST = 100000;
const PASSWORD = 'ABCD-EFGH-JKLM-NPQR-STUV';
const TEXT = 'The official text of the act.';

let owner;
let serverKey;

// Builds a real document: each version holds a really locked file.
async function makeDoc(contents = [TEXT], extra = {}) {
  const locks = [];
  const versions = [];
  for (let i = 0; i < contents.length; i++) {
    const lock = await lockFile({
      data: new TextEncoder().encode(contents[i]),
      name: `act-${i + 1}.txt`,
      password: PASSWORD,
      iterations: FAST
    });
    locks.push(lock);
    versions.push({
      mutate: (record) => {
        record.blob = { hash: lock.blobHash, size: lock.size, suite: 1 };
        record.commitment = lock.commitment;
      }
    });
  }
  if (extra.revokeAfter) versions.push({ revoke: true, reason: 'withdrawn' });
  const parts = await buildBundleParts({ owner, serverKey, versions, ...(extra.parts || {}) });
  fake.state.bundles.set(parts.docId, parts.bundle);
  for (const lock of locks) fake.state.blobs.set(lock.blobHash, lock.bytes);
  return { ...parts, locks };
}

beforeEach(async () => {
  Object.assign(fake.state, { calls: [], failDoc: null, failBlob: null });
  fake.state.bundles.clear();
  fake.state.blobs.clear();
  owner = await createIdentity('Registry Office');
  serverKey = await createServerKey();
});

const failed = (v) => v.checks.filter((c) => !c.ok).map((c) => c.id);

describe('openDocument', () => {
  it('good document with the right password: everything checks and the file comes back', async () => {
    const { docId, locks } = await makeDoc();
    const steps = [];
    const r = await openDocument({
      docId,
      password: PASSWORD,
      pinnedServerKeyId: serverKey.keyId,
      onStep: (id, text) => steps.push([id, text])
    });
    expect(r.verification.ok).toBe(true);
    expect(r.verification.status).toBe('active');
    expect(r.verification.anchored).toBe(true);
    expect(r.verification.head.version).toBe(1);
    expect(r.blobCheck.ok).toBe(true);
    expect(r.plaintextCheck.ok).toBe(true);
    expect(r.file.name).toBe('act-1.txt');
    expect(new TextDecoder().decode(r.file.data)).toBe(TEXT);
    expect(r.fingerprint).toBe(locks[0].fileHash);
    expect(r.bundle.document.docId).toBe(docId);
    expect(steps.map((s) => s[0])).toEqual(['fetch', 'verify', 'download', 'blob', 'unlock', 'plaintext', 'done']);
    expect(Object.keys(r).sort()).toEqual(['blobCheck', 'bundle', 'file', 'fingerprint', 'plaintextCheck', 'verification']);
  });

  it('accepts the password in lower case with or without dashes', async () => {
    const { docId } = await makeDoc();
    for (const pw of ['abcd-efgh-jklm-npqr-stuv', 'ABCDEFGHJKLMNPQRSTUV', ' abcd efgh jklm npqr stuv ']) {
      const r = await openDocument({ docId, password: pw, pinnedServerKeyId: serverKey.keyId });
      expect(r.plaintextCheck.ok).toBe(true);
    }
  });

  it('without a password it verifies the bundle and the blob but does not unlock', async () => {
    const { docId } = await makeDoc();
    const r = await openDocument({ docId, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(true);
    expect(r.blobCheck.ok).toBe(true);
    expect(r.plaintextCheck).toBeNull();
    expect(r.file).toBeNull();
    expect(r.fingerprint).toBeNull();
    const r2 = await openDocument({ docId, password: '', pinnedServerKeyId: serverKey.keyId });
    expect(r2.plaintextCheck).toBeNull();
  });

  it('uses the latest version of a multi version document', async () => {
    const { docId } = await makeDoc(['first text', 'second text', 'third text']);
    const r = await openDocument({ docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.head.version).toBe(3);
    expect(new TextDecoder().decode(r.file.data)).toBe('third text');
    expect(r.file.name).toBe('act-3.txt');
  });

  it('wrong password: reported in the result, not thrown', async () => {
    const { docId } = await makeDoc();
    const r = await openDocument({ docId, password: 'WRONG-PASSWORD-HERE', pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(true);
    expect(r.blobCheck.ok).toBe(true);
    expect(r.plaintextCheck.ok).toBe(false);
    expect(r.plaintextCheck.detail).toBe('wrong password, or the file was changed');
    expect(r.file).toBeNull();
    expect(r.fingerprint).toBeNull();
  });

  it('tampered bundle record: verification fails, no throw, no file handed over blindly', async () => {
    const { docId, bundle } = await makeDoc();
    const bad = clone(bundle);
    bad.records[0].record.label = 'Something else';
    fake.state.bundles.set(docId, bad);
    const r = await openDocument({ docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(false);
    expect(r.verification.status).toBe('invalid');
    expect(failed(r.verification)).toContain('record_signatures');
    // the file itself is untouched, so its own checks still run and are reported separately
    expect(r.blobCheck.ok).toBe(true);
  });

  it('tampered locked file: blob check fails and the file is not unlocked', async () => {
    const { docId, locks } = await makeDoc();
    const bytes = locks[0].bytes.slice();
    bytes[bytes.length - 40] ^= 1;
    fake.state.blobs.set(locks[0].blobHash, bytes);
    const r = await openDocument({ docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(true);
    expect(r.blobCheck.ok).toBe(false);
    expect(r.plaintextCheck.ok).toBe(false);
    expect(r.file).toBeNull();
  });

  it('file with a different length than signed is reported', async () => {
    const { docId, locks } = await makeDoc();
    const longer = new Uint8Array(locks[0].bytes.length + 1);
    longer.set(locks[0].bytes);
    fake.state.blobs.set(locks[0].blobHash, longer);
    const r = await openDocument({ docId, pinnedServerKeyId: serverKey.keyId });
    expect(r.blobCheck.ok).toBe(false);
    expect(r.blobCheck.detail).toMatch(/size/);
  });

  it('commitment that does not match the unlocked file is reported and no file is returned', async () => {
    // signed record points at a real locked file but carries the commitment of another one
    const other = await lockFile({ data: new TextEncoder().encode('different'), name: 'x.txt', password: PASSWORD, iterations: FAST });
    const lock = await lockFile({ data: new TextEncoder().encode(TEXT), name: 'act.txt', password: PASSWORD, iterations: FAST });
    const parts = await buildBundleParts({
      owner,
      serverKey,
      versions: [
        {
          mutate: (record) => {
            record.blob = { hash: lock.blobHash, size: lock.size, suite: 1 };
            record.commitment = other.commitment;
          }
        }
      ]
    });
    fake.state.bundles.set(parts.docId, parts.bundle);
    fake.state.blobs.set(lock.blobHash, lock.bytes);
    const r = await openDocument({ docId: parts.docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(true);
    expect(r.blobCheck.ok).toBe(true);
    expect(r.plaintextCheck.ok).toBe(false);
    expect(r.plaintextCheck.detail).toMatch(/commitment/);
    expect(r.file).toBeNull();
    expect(r.fingerprint).toBe(lock.fileHash);
  });

  it('revoked document: reports revoked, fetches no file, never unlocks', async () => {
    const { docId } = await makeDoc([TEXT], { revokeAfter: true });
    const r = await openDocument({ docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(true);
    expect(r.verification.status).toBe('revoked');
    expect(r.blobCheck).toBeNull();
    expect(r.plaintextCheck).toBeNull();
    expect(r.file).toBeNull();
    expect(fake.state.calls).toEqual(['getDocument']);
  });

  it('bundle without any server checkpoint fails, even with allowUnanchored', async () => {
    serverKey = null;
    const { docId } = await makeDoc();
    const r = await openDocument({ docId, password: PASSWORD });
    expect(r.verification.ok).toBe(false);
    expect(r.verification.anchored).toBe(false);
    expect(failed(r.verification)).toContain('checkpoint');
    // the file checks run on their own
    expect(r.plaintextCheck.ok).toBe(true);
    const r2 = await openDocument({ docId, password: PASSWORD, allowUnanchored: true });
    expect(r2.verification.ok).toBe(false);
  });

  // The ledger moved on after this document's head and there is no head attestation.
  async function makeStaleDoc() {
    const parts = await makeDoc();
    const other = { v: 2, type: 'message', note: 'another record in the ledger' };
    await parts.ledger.append(other, 'sig');
    const bundle = clone(parts.bundle);
    bundle.checkpoint = await ledgerCheckpoint(serverKey, parts.ledger);
    bundle.headCheckpoint = null;
    fake.state.bundles.set(parts.docId, bundle);
    return parts.docId;
  }

  it('unanchored bundle: fails by default, passes with allowUnanchored and says so', async () => {
    const docId = await makeStaleDoc();
    const r = await openDocument({ docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(false);
    expect(r.verification.anchored).toBe(false);
    expect(failed(r.verification)).toContain('checkpoint');
    expect(r.plaintextCheck.ok).toBe(true);

    const r2 = await openDocument({ docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId, allowUnanchored: true });
    expect(r2.verification.ok).toBe(true);
    expect(r2.verification.anchored).toBe(false);
    expect(r2.verification.warnings.some((w) => /not tied to the server/i.test(w))).toBe(true);
  });

  it('allowUnanchored only counts when it is exactly true', async () => {
    const docId = await makeStaleDoc();
    for (const v of ['true', 1, {}, undefined, false]) {
      const r = await openDocument({ docId, pinnedServerKeyId: serverKey.keyId, allowUnanchored: v });
      expect(r.verification.ok).toBe(false);
    }
  });

  it('server key pin mismatch fails the checkpoint check', async () => {
    const { docId } = await makeDoc();
    const r = await openDocument({ docId, password: PASSWORD, pinnedServerKeyId: 'ab'.repeat(32) });
    expect(r.verification.ok).toBe(false);
    expect(failed(r.verification)).toContain('checkpoint');
  });

  it('no pin still verifies but warns that the key was not pinned', async () => {
    const { docId } = await makeDoc();
    for (const pin of [undefined, '', null]) {
      const r = await openDocument({ docId, pinnedServerKeyId: pin });
      expect(r.verification.ok).toBe(true);
      expect(r.verification.warnings.join(' ')).toMatch(/pinned/i);
    }
  });

  it('a malformed pin value fails instead of being ignored', async () => {
    const { docId } = await makeDoc();
    const r = await openDocument({ docId, pinnedServerKeyId: 'not-a-key-id' });
    expect(r.verification.ok).toBe(false);
  });

  it('the server answering with another document is caught by expectedDocId', async () => {
    const a = await makeDoc();
    const b = await makeDoc(['other']);
    fake.state.bundles.set(a.docId, b.bundle);
    const r = await openDocument({ docId: a.docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(false);
  });

  it('garbage bundles never throw', async () => {
    const docId = 'd'.repeat(32);
    for (const junk of [{}, { records: [] }, { records: [null], document: 5 }, { records: [{ record: 7 }] }, [], 'text', null]) {
      fake.state.bundles.set(docId, junk);
      const r = await openDocument({ docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
      expect(r.verification.ok).toBe(false);
      expect(r.file).toBeNull();
    }
    expect(fake.state.calls).not.toContain('getBlob');
  });

  it('a record with an odd blob entry is reported, not thrown', async () => {
    const { docId, bundle } = await makeDoc();
    const bad = clone(bundle);
    bad.records[0].record.blob = { hash: 'e'.repeat(64), size: 3, suite: 1 };
    fake.state.bundles.set(docId, bad);
    // blob missing on the server: network style error is allowed to throw
    await expect(openDocument({ docId, pinnedServerKeyId: serverKey.keyId })).rejects.toThrow('not found');
    // blob present with other content
    fake.state.blobs.set('e'.repeat(64), new Uint8Array([1, 2, 3]));
    const r = await openDocument({ docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(false);
    expect(r.blobCheck.ok).toBe(false);
    expect(r.file).toBeNull();
  });

  it('a hostile file that is not a locked file is reported as a plaintext failure', async () => {
    // signed hash matches the bytes, but the bytes are not a hrdlock file
    const junk = new TextEncoder().encode('this is just plain text and not a locked file at all, long enough to pass.');
    const { sha256Hex } = await import('../../shared/hash.js');
    const hash = await sha256Hex(junk);
    const parts = await buildBundleParts({
      owner,
      serverKey,
      versions: [
        {
          mutate: (record) => {
            record.blob = { hash, size: junk.length, suite: 1 };
          }
        }
      ]
    });
    fake.state.bundles.set(parts.docId, parts.bundle);
    fake.state.blobs.set(hash, junk);
    const r = await openDocument({ docId: parts.docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.blobCheck.ok).toBe(true);
    expect(r.plaintextCheck.ok).toBe(false);
    expect(r.plaintextCheck.detail).toBe('this is not a hrdlock file');
    expect(r.file).toBeNull();
  });

  it('network and server errors do throw', async () => {
    const { docId } = await makeDoc();
    fake.state.failDoc = Object.assign(new Error('network down'), { status: 0, code: 'network' });
    await expect(openDocument({ docId })).rejects.toThrow('network down');
    fake.state.failDoc = null;
    fake.state.failBlob = Object.assign(new Error('server error'), { status: 500, code: 'server_error' });
    await expect(openDocument({ docId, pinnedServerKeyId: serverKey.keyId })).rejects.toThrow('server error');
  });

  it('rejects a bad document id before any request', async () => {
    for (const bad of [undefined, '', 'xyz', 'A'.repeat(32), 'a'.repeat(31)]) {
      await expect(openDocument({ docId: bad })).rejects.toThrow('document id is not valid');
    }
    expect(fake.state.calls).toEqual([]);
  });

  it('works without onStep and with a throwing onStep', async () => {
    const { docId } = await makeDoc();
    const r = await openDocument({
      docId,
      password: PASSWORD,
      pinnedServerKeyId: serverKey.keyId,
      onStep: () => {
        throw new Error('ui bug');
      }
    });
    expect(r.plaintextCheck.ok).toBe(true);
  });
});
