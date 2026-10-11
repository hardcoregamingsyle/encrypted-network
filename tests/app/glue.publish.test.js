import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalBytes } from '../../shared/canonical.js';
import { verifyRecord } from '../../shared/keys.js';
import { ZERO_HASH, validateRecord } from '../../shared/records.js';
import { verifyBlobBytes } from '../../shared/verify.js';
import { signRecord } from '../../shared/keys.js';
import { unlockFile } from '../../src/lib/lockfile.js';
import { listLocalDocs } from '../../src/lib/localDocs.js';
import { createIdentity } from '../helpers/bundle.js';

// A fake api module that records every call in order. It works whether or not src/lib/api.js exists.
const fake = vi.hoisted(() => {
  const state = {
    calls: [],
    blobs: new Map(),
    failPut: null,
    failPost: null,
    putResult: null,
    postHashOverride: null
  };
  return { state };
});

vi.mock('../../src/lib/api.js', () => ({
  putBlob: async (args) => {
    fake.state.calls.push({ fn: 'putBlob', args });
    if (fake.state.failPut) throw fake.state.failPut;
    fake.state.blobs.set(args.hash, args.bytes);
    // signs like the real client does, so the sign callback is exercised
    const rec = { v: 2, type: 'blob.put', hash: args.hash, size: args.size, signer: args.signer, createdAt: Date.now() };
    const sig = await args.sign(rec);
    fake.state.calls.push({ fn: 'putBlob.signed', rec, sig });
    return fake.state.putResult || { hash: args.hash, size: args.size };
  },
  postDocRecord: async (docId, record, signature) => {
    fake.state.calls.push({ fn: 'postDocRecord', docId, record, signature });
    if (fake.state.failPost) throw fake.state.failPost;
    const { recordHash } = await import('../../shared/records.js');
    return {
      recordHash: fake.state.postHashOverride || (await recordHash(record)),
      ledgerSeq: 1,
      ledgerHash: 'f'.repeat(64),
      document: { docId }
    };
  },
  getDocument: async () => {
    throw new Error('not used here');
  },
  getBlob: async () => {
    throw new Error('not used here');
  }
}));

const { publishNewDocument, publishNewVersion, revokeDocument } = await import('../../src/lib/publish.js');

const FAST = 100000;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function makeFile(text = 'hello world', name = 'note.txt') {
  return new File([new TextEncoder().encode(text)], name);
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k)
  };
}

let alice;
let identity;

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', fakeStorage());
  Object.assign(fake.state, { calls: [], failPut: null, failPost: null, putResult: null, postHashOverride: null });
  fake.state.blobs.clear();
  alice = await createIdentity('Alice');
  identity = {
    keyId: alice.keyId,
    displayName: 'Alice',
    publicKey: alice.publicJwk,
    sign: (record) => signRecord(alice.privateKey, record)
  };
});

const names = () => fake.state.calls.map((c) => c.fn);
const posted = () => fake.state.calls.find((c) => c.fn === 'postDocRecord');

describe('publishNewDocument', () => {
  it('runs the steps in order, uploads before posting, and builds the exact record', async () => {
    const steps = [];
    const before = Date.now();
    const res = await publishNewDocument({
      file: makeFile('the contents', 'deed.txt'),
      label: 'Land deed',
      listed: true,
      identity,
      iterations: FAST,
      onStep: (id, text) => steps.push([id, text])
    });
    const after = Date.now();

    expect(steps.map((s) => s[0])).toEqual(['read', 'derive', 'lock', 'upload', 'sign', 'publish', 'done']);
    for (const [, text] of steps) {
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(text.includes(String.fromCharCode(0x2014))).toBe(false);
    }
    expect(names().filter((n) => n !== 'putBlob.signed')).toEqual(['putBlob', 'postDocRecord']);
    expect(names().indexOf('putBlob')).toBeLessThan(names().indexOf('postDocRecord'));

    const { record, signature, docId } = posted();
    expect(Object.keys(record).sort()).toEqual(
      ['blob', 'commitment', 'createdAt', 'docId', 'label', 'listed', 'prev', 'signer', 'type', 'v', 'version'].sort()
    );
    expect(record.v).toBe(2);
    expect(record.type).toBe('doc.create');
    expect(record.version).toBe(1);
    expect(record.prev).toBe(ZERO_HASH);
    expect(record.signer).toBe(alice.keyId);
    expect(record.label).toBe('Land deed');
    expect(record.listed).toBe(true);
    expect(record.docId).toMatch(/^[0-9a-f]{32}$/);
    expect(docId).toBe(record.docId);
    expect(record.createdAt).toBeGreaterThanOrEqual(before);
    expect(record.createdAt).toBeLessThanOrEqual(after);
    expect(validateRecord(record)).toEqual({ ok: true });

    // uploaded bytes: independent hash, size and flags
    const put = fake.state.calls.find((c) => c.fn === 'putBlob').args;
    expect(put.signer).toBe(alice.keyId);
    expect(put.size).toBe(put.bytes.length);
    expect(put.hash).toBe(sha(put.bytes));
    expect(record.blob).toEqual({ hash: sha(put.bytes), size: put.bytes.length, suite: 1 });
    expect(typeof put.sign).toBe('function');
    const bp = fake.state.calls.find((c) => c.fn === 'putBlob.signed');
    expect(await verifyRecord(alice.publicJwk, bp.rec, bp.sig)).toBe(true);

    // the signature verifies with the identity key, and the record hash is recomputed independently
    expect(await verifyRecord(alice.publicJwk, record, signature)).toBe(true);
    expect(res.recordHash).toBe(sha(canonicalBytes(record)));

    // the commitment matches the real file, recomputed independently
    const opened = await unlockFile(put.bytes, res.password);
    expect(opened.name).toBe('deed.txt');
    expect(new TextDecoder().decode(opened.data)).toBe('the contents');
    const salt = Buffer.from(opened.commitSalt, 'hex');
    const fileHash = Buffer.from(sha(new TextEncoder().encode('the contents')), 'hex');
    expect(sha(Buffer.concat([Buffer.from('hrdlock/v2/commit'), salt, fileHash]))).toBe(record.commitment);

    // result
    expect(res.docId).toBe(record.docId);
    expect(res.version).toBe(1);
    expect(res.blobHash).toBe(record.blob.hash);
    expect(res.fingerprint).toBe(sha(new TextEncoder().encode('the contents')));
    expect(res.password).toMatch(/^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);
    expect(res.links.verify).toBe('/d/' + res.docId);
    expect(res.links.full).toBe('/d/' + res.docId + '#k=' + res.password.replace(/-/g, ''));
    expect(Object.keys(res).sort()).toEqual(
      ['blobHash', 'docId', 'fingerprint', 'links', 'password', 'recordHash', 'version'].sort()
    );

    // the locked file the server holds passes the shared blob check
    expect((await verifyBlobBytes(put.bytes, record)).ok).toBe(true);
  });

  it('remembers the document locally with id and label only', async () => {
    const res = await publishNewDocument({ file: makeFile(), label: 'My label', identity, iterations: FAST });
    const list = listLocalDocs();
    expect(list).toHaveLength(1);
    expect(list[0].docId).toBe(res.docId);
    expect(list[0].label).toBe('My label');
    expect(JSON.stringify(list)).not.toContain(res.password);
  });

  it('uses a given password and a different file gets a different blob', async () => {
    const a = await publishNewDocument({ file: makeFile('a'), identity, password: 'abcd-efgh-jkmn', iterations: FAST });
    const b = await publishNewDocument({ file: makeFile('a'), identity, password: 'abcd-efgh-jkmn', iterations: FAST });
    expect(a.password).toBe('abcd-efgh-jkmn');
    expect(a.links.full).toBe('/d/' + a.docId + '#k=ABCDEFGHJKMN');
    // fresh salt and nonce every time
    expect(a.blobHash).not.toBe(b.blobHash);
    expect(a.docId).not.toBe(b.docId);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('defaults: label is the file name, not listed', async () => {
    await publishNewDocument({ file: makeFile('x', 'report.pdf'), identity, iterations: FAST });
    expect(posted().record.label).toBe('report.pdf');
    expect(posted().record.listed).toBe(false);
  });

  it('cleans the label (trim, NFC) and allows an empty label', async () => {
    await publishNewDocument({ file: makeFile(), label: '  Café  ', identity, iterations: FAST });
    expect(posted().record.label).toBe('Café');
    fake.state.calls.length = 0;
    await publishNewDocument({ file: makeFile(), label: '', identity, iterations: FAST });
    expect(posted().record.label).toBe('');
  });

  it('rejects a bad label before anything is uploaded', async () => {
    await expect(
      publishNewDocument({ file: makeFile(), label: 'x'.repeat(121), identity, iterations: FAST })
    ).rejects.toThrow(/record is not valid: label/);
    await expect(
      publishNewDocument({ file: makeFile(), label: 'zero​width', identity, iterations: FAST })
    ).rejects.toThrow(/invisible/);
    expect(names()).toEqual([]);
  });

  it('rejects bad files', async () => {
    const base = { identity, iterations: FAST };
    await expect(publishNewDocument({ ...base })).rejects.toThrow('choose a file first');
    await expect(publishNewDocument({ ...base, file: {} })).rejects.toThrow('choose a file first');
    await expect(publishNewDocument({ ...base, file: 'x' })).rejects.toThrow('choose a file first');
    await expect(publishNewDocument({ ...base, file: new File([], 'empty.txt') })).rejects.toThrow('the file is empty');
    await expect(publishNewDocument({ ...base, file: makeFile('x', '   ') })).rejects.toThrow('the file has no name');
    await expect(publishNewDocument({ ...base, file: makeFile('x', 'n'.repeat(1100)) })).rejects.toThrow(/name is too long/);
    const huge = { name: 'big.bin', size: 20971521, arrayBuffer: async () => new ArrayBuffer(0) };
    await expect(publishNewDocument({ ...base, file: huge })).rejects.toThrow('file is too large (20 MiB limit)');
    const lying = { name: 'big.bin', size: 5, arrayBuffer: async () => new ArrayBuffer(20971521) };
    await expect(publishNewDocument({ ...base, file: lying })).rejects.toThrow('file is too large (20 MiB limit)');
    const liar2 = { name: 'e.bin', size: 5, arrayBuffer: async () => new ArrayBuffer(0) };
    await expect(publishNewDocument({ ...base, file: liar2 })).rejects.toThrow('the file is empty');
    expect(names()).toEqual([]);
  });

  it('accepts a one byte file', async () => {
    const res = await publishNewDocument({ file: new File([new Uint8Array([7])], 'one.bin'), identity, iterations: FAST });
    expect(posted().record.blob.size).toBeGreaterThan(1);
    expect(res.fingerprint).toBe(sha(new Uint8Array([7])));
  });

  it('needs an identity that can sign', async () => {
    for (const bad of [undefined, null, {}, { keyId: alice.keyId }, { sign() {} }]) {
      await expect(publishNewDocument({ file: makeFile(), identity: bad, iterations: FAST })).rejects.toThrow(
        'create or restore an identity first'
      );
    }
    expect(names()).toEqual([]);
  });

  it('rejects an empty or non text password', async () => {
    for (const pw of ['', ' - ', 5, {}]) {
      await expect(publishNewDocument({ file: makeFile(), identity, password: pw, iterations: FAST })).rejects.toThrow(
        'password is empty'
      );
    }
  });

  it('surfaces upload and publish errors and posts nothing after a failed upload', async () => {
    fake.state.failPut = Object.assign(new Error('quota'), { code: 'too_large' });
    await expect(publishNewDocument({ file: makeFile(), identity, iterations: FAST })).rejects.toThrow('quota');
    expect(names()).toEqual(['putBlob']);
    expect(listLocalDocs()).toEqual([]);

    fake.state.failPut = null;
    fake.state.calls.length = 0;
    fake.state.failPost = Object.assign(new Error('rate limited'), { code: 'rate_limited' });
    await expect(publishNewDocument({ file: makeFile(), identity, iterations: FAST })).rejects.toThrow('rate limited');
    expect(listLocalDocs()).toEqual([]);
  });

  it('handles an already existing blob answer', async () => {
    fake.state.putResult = null;
    const first = await publishNewDocument({ file: makeFile(), identity, iterations: FAST });
    expect(first.version).toBe(1);
    fake.state.putResult = { exists: true, hash: undefined };
    const orig = fake.state.putResult;
    // exists answer without a hash is accepted
    const second = await publishNewDocument({ file: makeFile(), identity, iterations: FAST });
    expect(second.version).toBe(1);
    expect(orig.exists).toBe(true);
  });

  it('refuses when the server stored a different blob hash', async () => {
    fake.state.putResult = { hash: 'e'.repeat(64), size: 10 };
    await expect(publishNewDocument({ file: makeFile(), identity, iterations: FAST })).rejects.toThrow(
      'the server stored a different file than the one sent'
    );
    expect(names().includes('postDocRecord')).toBe(false);
  });

  it('refuses when the server answers with a different record hash', async () => {
    fake.state.postHashOverride = 'd'.repeat(64);
    await expect(publishNewDocument({ file: makeFile(), identity, iterations: FAST })).rejects.toThrow(
      'the server returned a different record hash than the one signed'
    );
    expect(listLocalDocs()).toEqual([]);
  });

  it('a throwing progress callback does not stop the publish', async () => {
    const res = await publishNewDocument({
      file: makeFile(),
      identity,
      iterations: FAST,
      onStep: () => {
        throw new Error('ui bug');
      }
    });
    expect(res.version).toBe(1);
  });

  it('works without onStep', async () => {
    const res = await publishNewDocument({ file: makeFile(), identity, iterations: FAST });
    expect(res.docId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('absolute links when a window exists', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://vault.example' } });
    const res = await publishNewDocument({ file: makeFile(), identity, iterations: FAST });
    expect(res.links.verify).toBe('https://vault.example/d/' + res.docId);
    expect(res.links.full.startsWith('https://vault.example/d/' + res.docId + '#k=')).toBe(true);
  });

  it('still publishes when local storage throws', async () => {
    const boom = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    const res = await publishNewDocument({ file: makeFile(), identity, iterations: FAST });
    expect(res.version).toBe(1);
  });
});

describe('publishNewVersion', () => {
  const docId = 'c'.repeat(32);
  const head = { version: 3, recordHash: 'b'.repeat(64) };

  it('builds a doc.update on top of the head and locks with the given password', async () => {
    const steps = [];
    const res = await publishNewVersion({
      docId,
      head,
      file: makeFile('second edition', 'deed-v4.txt'),
      label: 'Deed, fourth',
      identity,
      password: 'ABCD-EFGH-JKLM',
      iterations: FAST,
      onStep: (id) => steps.push(id)
    });
    expect(steps).toEqual(['read', 'derive', 'lock', 'upload', 'sign', 'publish', 'done']);
    expect(names().filter((n) => n !== 'putBlob.signed')).toEqual(['putBlob', 'postDocRecord']);

    const { record, signature, docId: urlDoc } = posted();
    expect(urlDoc).toBe(docId);
    expect(Object.keys(record).sort()).toEqual(
      ['blob', 'commitment', 'createdAt', 'docId', 'label', 'prev', 'signer', 'type', 'v', 'version'].sort()
    );
    expect(record.type).toBe('doc.update');
    expect(record.version).toBe(4);
    expect(record.prev).toBe(head.recordHash);
    expect(record.docId).toBe(docId);
    expect(record.signer).toBe(alice.keyId);
    expect(record.label).toBe('Deed, fourth');
    expect(validateRecord(record)).toEqual({ ok: true });
    expect(await verifyRecord(alice.publicJwk, record, signature)).toBe(true);

    const put = fake.state.calls.find((c) => c.fn === 'putBlob').args;
    expect(record.blob).toEqual({ hash: sha(put.bytes), size: put.bytes.length, suite: 1 });
    const opened = await unlockFile(put.bytes, 'abcdefghjklm');
    expect(new TextDecoder().decode(opened.data)).toBe('second edition');

    expect(res).toEqual({
      version: 4,
      recordHash: sha(canonicalBytes(record)),
      fingerprint: sha(new TextEncoder().encode('second edition')),
      blobHash: record.blob.hash
    });
  });

  it('chains: a second update uses the first result as its head', async () => {
    const first = await publishNewVersion({ docId, head, file: makeFile('one'), identity, password: 'PASS-WORD', iterations: FAST });
    const second = await publishNewVersion({
      docId,
      head: { version: first.version, recordHash: first.recordHash },
      file: makeFile('two'),
      identity,
      password: 'PASS-WORD',
      iterations: FAST
    });
    expect(second.version).toBe(5);
    const records = fake.state.calls.filter((c) => c.fn === 'postDocRecord').map((c) => c.record);
    expect(records[1].prev).toBe(first.recordHash);
    expect(records[1].createdAt).toBeGreaterThanOrEqual(records[0].createdAt);
  });

  it('rejects a missing or malformed head, doc id, password and identity', async () => {
    const ok = { docId, head, file: makeFile(), identity, password: 'PASS-WORD', iterations: FAST };
    await expect(publishNewVersion({ ...ok, head: undefined })).rejects.toThrow('current version');
    await expect(publishNewVersion({ ...ok, head: { version: 0, recordHash: head.recordHash } })).rejects.toThrow('current version');
    await expect(publishNewVersion({ ...ok, head: { version: 1.5, recordHash: head.recordHash } })).rejects.toThrow('current version');
    await expect(publishNewVersion({ ...ok, head: { version: 2, recordHash: 'abc' } })).rejects.toThrow('current version');
    await expect(publishNewVersion({ ...ok, head: { version: 2, recordHash: 'B'.repeat(64) } })).rejects.toThrow('current version');
    await expect(publishNewVersion({ ...ok, docId: 'short' })).rejects.toThrow('document id is not valid');
    await expect(publishNewVersion({ ...ok, password: '' })).rejects.toThrow('password is empty');
    await expect(publishNewVersion({ ...ok, password: undefined })).rejects.toThrow('password is empty');
    await expect(publishNewVersion({ ...ok, identity: null })).rejects.toThrow('identity');
    await expect(publishNewVersion({ ...ok, file: undefined })).rejects.toThrow('choose a file first');
    expect(names()).toEqual([]);
  });

  it('does not touch the local document list', async () => {
    await publishNewVersion({ docId, head, file: makeFile(), identity, password: 'PASS-WORD', iterations: FAST });
    expect(listLocalDocs()).toEqual([]);
  });
});

describe('revokeDocument', () => {
  const docId = 'a'.repeat(32);
  const head = { version: 2, recordHash: '9'.repeat(64) };

  it('builds a signed doc.revoke without blob or commitment, and posts only once', async () => {
    const steps = [];
    const before = Date.now();
    const res = await revokeDocument({ docId, head, reason: 'Replaced by a new law', identity, onStep: (id) => steps.push(id) });
    expect(steps).toEqual(['sign', 'publish', 'done']);
    expect(names()).toEqual(['postDocRecord']);
    const { record, signature } = posted();
    expect(record).toEqual({
      v: 2,
      type: 'doc.revoke',
      docId,
      version: 3,
      prev: head.recordHash,
      signer: alice.keyId,
      createdAt: record.createdAt,
      reason: 'Replaced by a new law'
    });
    expect(record.createdAt).toBeGreaterThanOrEqual(before);
    expect(validateRecord(record)).toEqual({ ok: true });
    expect(await verifyRecord(alice.publicJwk, record, signature)).toBe(true);
    expect(res).toEqual({ version: 3, recordHash: sha(canonicalBytes(record)) });
  });

  it('accepts an empty reason and rejects a reason that is too long', async () => {
    await revokeDocument({ docId, head, reason: '', identity });
    expect(posted().record.reason).toBe('');
    await expect(revokeDocument({ docId, head, reason: 'r'.repeat(501), identity })).rejects.toThrow(/record is not valid: reason/);
    await revokeDocument({ docId, head, reason: undefined, identity });
  });

  it('rejects bad input', async () => {
    await expect(revokeDocument({ docId, head: null, reason: 'x', identity })).rejects.toThrow('current version');
    await expect(revokeDocument({ docId: 'nope', head, reason: 'x', identity })).rejects.toThrow('document id is not valid');
    await expect(revokeDocument({ docId, head, reason: 'x', identity: {} })).rejects.toThrow('identity');
    expect(names()).toEqual([]);
  });

  it('surfaces server errors', async () => {
    fake.state.failPost = Object.assign(new Error('not the owner'), { code: 'not_owner' });
    await expect(revokeDocument({ docId, head, reason: 'x', identity })).rejects.toThrow('not the owner');
  });
});
