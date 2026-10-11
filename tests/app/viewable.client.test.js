// Public files in the browser: the public commit salt, a viewable file opening without a password, and the
// password free comparison on the Verify page.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hexToBytes } from '../../shared/encoding.js';
import { PUBLIC_COMMIT_SALT, computeCommitment, sha256Hex } from '../../shared/hash.js';
import { compareWithPublicHead } from '../../src/components/verify/logic.js';
import { signRecord } from '../../shared/keys.js';
import { lockFile } from '../../src/lib/lockfile.js';
import { buildBundleParts, createIdentity, createServerKey } from '../helpers/bundle.js';

const fake = vi.hoisted(() => ({ state: { bundles: new Map(), blobs: new Map(), view: { viewable: false }, viewCalls: 0, viewFails: false, posted: [] } }));

vi.mock('../../src/lib/api.js', () => ({
  getDocument: async (docId) => structuredClone(fake.state.bundles.get(docId)),
  getBlob: async (hash) => fake.state.blobs.get(hash).slice(),
  getViewable: async () => {
    fake.state.viewCalls += 1;
    if (fake.state.viewFails) throw Object.assign(new Error('down'), { code: 'network', status: 0 });
    return structuredClone(fake.state.view);
  },
  putBlob: async () => ({}),
  postDocRecord: async (docId, record) => {
    fake.state.posted.push(record);
    return {};
  }
}));

const { openDocument, publishNewDocument } = await import('../../src/lib/publish.js');

const FAST = 100000;
const PASSWORD = 'ABCD-EFGH-JKLM-NPQR-STUV';
const TEXT = 'The official text of the act.';
const PLAIN = new TextEncoder().encode(TEXT);

let owner;
let serverKey;

// A real document whose file was locked with the public salt, or a random one like old documents (random: true).
async function makeDoc({ random = false, revoke = false } = {}) {
  const lock = await lockFile({ data: PLAIN, name: 'act.txt', password: PASSWORD, iterations: FAST, commitSalt: random ? undefined : hexToBytes(PUBLIC_COMMIT_SALT) });
  const versions = [{ mutate: (r) => { r.blob = { hash: lock.blobHash, size: lock.size, suite: 1 }; r.commitment = lock.commitment; } }];
  if (revoke) versions.push({ revoke: true, reason: 'withdrawn' });
  const parts = await buildBundleParts({ owner, serverKey, versions });
  fake.state.bundles.set(parts.docId, parts.bundle);
  fake.state.blobs.set(lock.blobHash, lock.bytes);
  return { ...parts, lock };
}

beforeEach(async () => {
  Object.assign(fake.state, { view: { viewable: false }, viewCalls: 0, viewFails: false, posted: [] });
  fake.state.bundles.clear();
  fake.state.blobs.clear();
  owner = await createIdentity('Registry Office');
  serverKey = await createServerKey();
});

describe('the public commit salt', () => {
  it('is 16 zero bytes, and a file locked with it has a commitment anyone can work out from the plain file', async () => {
    expect(PUBLIC_COMMIT_SALT).toBe('0'.repeat(32));
    const { lock } = await makeDoc();
    expect(lock.commitSalt).toBe(PUBLIC_COMMIT_SALT);
    expect(lock.commitment).toBe(await computeCommitment({ fileHash: await sha256Hex(PLAIN), commitSalt: PUBLIC_COMMIT_SALT }));
  });

  it('is random unless one is given, and a salt of the wrong size is refused', async () => {
    const a = await lockFile({ data: PLAIN, name: 'a.txt', password: PASSWORD, iterations: FAST });
    const b = await lockFile({ data: PLAIN, name: 'a.txt', password: PASSWORD, iterations: FAST });
    expect(a.commitSalt).not.toBe(b.commitSalt);
    expect(a.commitSalt).not.toBe(PUBLIC_COMMIT_SALT);
    for (const bad of [new Uint8Array(15), new Uint8Array(17), '0'.repeat(32), [0]]) {
      await expect(lockFile({ data: PLAIN, name: 'a.txt', password: PASSWORD, iterations: FAST, commitSalt: bad })).rejects.toThrow('bad commit salt');
    }
  });
});

describe('publishing', () => {
  it('a new file is locked with the public salt, so its commitment can be worked out from the plain file', async () => {
    const identity = { keyId: owner.keyId, sign: (record) => signRecord(owner.privateKey, record) };
    await publishNewDocument({ file: new File([PLAIN], 'act.txt'), identity, iterations: FAST, listed: true });
    const [record] = fake.state.posted;
    expect(record.type).toBe('doc.create');
    expect(record.commitment).toBe(await computeCommitment({ fileHash: await sha256Hex(PLAIN), commitSalt: PUBLIC_COMMIT_SALT }));
  });
});

describe('openDocument and a viewable file', () => {
  it('opens a viewable file with no password given, and the file checks out', async () => {
    const { docId, lock } = await makeDoc();
    fake.state.view = { viewable: true, password: PASSWORD };
    const r = await openDocument({ docId, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(true);
    expect(r.plaintextCheck.ok).toBe(true);
    expect(new TextDecoder().decode(r.file.data)).toBe(TEXT);
    expect(r.fingerprint).toBe(lock.fileHash);
  });

  it('a file that is not viewable stays locked, and so does one when the answer cannot be had', async () => {
    const { docId } = await makeDoc();
    const off = await openDocument({ docId, pinnedServerKeyId: serverKey.keyId });
    expect(off.file).toBeNull();
    expect(off.plaintextCheck).toBeNull();
    fake.state.viewFails = true;
    const down = await openDocument({ docId, pinnedServerKeyId: serverKey.keyId });
    expect(down.verification.ok).toBe(true);
    expect(down.file).toBeNull();
  });

  it('a password the person gave is used, and the server is not asked; a wrong handed out password gives no file', async () => {
    const { docId } = await makeDoc();
    fake.state.view = { viewable: true, password: PASSWORD };
    const own = await openDocument({ docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(own.file).not.toBeNull();
    expect(fake.state.viewCalls).toBe(0);
    fake.state.view = { viewable: true, password: 'WRONG-WRONG-WRONG-WRONG' };
    const wrong = await openDocument({ docId, pinnedServerKeyId: serverKey.keyId });
    expect(wrong.file).toBeNull();
    expect(wrong.plaintextCheck.ok).toBe(false);
  });

  it('does not ask for the password when the stored file does not match its signed hash', async () => {
    const { docId, lock } = await makeDoc();
    fake.state.view = { viewable: true, password: PASSWORD };
    const bad = lock.bytes.slice();
    bad[bad.length - 5] ^= 1;
    fake.state.blobs.set(lock.blobHash, bad);
    const r = await openDocument({ docId, pinnedServerKeyId: serverKey.keyId });
    expect(r.blobCheck.ok).toBe(false);
    expect(r.file).toBeNull();
    expect(fake.state.viewCalls).toBe(0);
  });
});

describe('compareWithPublicHead (Verify page, no password)', () => {
  const open = (docId) => openDocument({ docId, pinnedServerKeyId: serverKey.keyId });

  it('the plain file and the locked copy both match; anything else does not', async () => {
    const { docId, lock } = await makeDoc();
    const o = await open(docId);
    const plain = await compareWithPublicHead(await sha256Hex(PLAIN), o);
    expect(plain).toMatchObject({ state: 'same', verified: true, version: 1 });
    expect(plain.detail).toMatch(/plain file/);
    const locked = await compareWithPublicHead(await sha256Hex(lock.bytes), o);
    expect(locked).toMatchObject({ state: 'same', verified: true });
    expect(locked.detail).toMatch(/locked copy/);
    const other = await compareWithPublicHead(await sha256Hex(new TextEncoder().encode('another file')), o);
    expect(other.state).toBe('no_match'); // it cannot be told apart from an older file, so it is not called different
    expect(other.detail).toMatch(/with its password/);
  });

  it('an older document with a secret salt cannot be matched by its plain file without the password', async () => {
    const { docId, lock } = await makeDoc({ random: true });
    const o = await open(docId);
    expect((await compareWithPublicHead(await sha256Hex(PLAIN), o)).state).toBe('no_match');
    expect((await compareWithPublicHead(await sha256Hex(lock.bytes), o)).state).toBe('same'); // the locked copy still matches
  });

  it('says so for a withdrawn document, a missing fingerprint and a viewable file already opened', async () => {
    const gone = await makeDoc({ revoke: true });
    expect((await compareWithPublicHead(await sha256Hex(PLAIN), await open(gone.docId))).state).toBe('no_file');
    const { docId } = await makeDoc();
    const o = await open(docId);
    expect((await compareWithPublicHead('nope', o)).state).toBe('not_unlocked');
    fake.state.view = { viewable: true, password: PASSWORD };
    const unlocked = await open(docId);
    expect((await compareWithPublicHead(await sha256Hex(PLAIN), unlocked)).state).toBe('same');
    expect((await compareWithPublicHead(await sha256Hex(new TextEncoder().encode('x')), unlocked)).state).toBe('different');
    expect((await compareWithPublicHead(await sha256Hex(PLAIN), null)).state).toBe('not_unlocked');
  });
});
