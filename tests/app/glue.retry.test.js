// A failed publish must be safe to repeat: no second document, no second copy of the file, and a
// lost answer must not be reported as "nothing was published".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signRecord } from '../../shared/keys.js';
import { recordHash } from '../../shared/records.js';
import { listLocalDocs } from '../../src/lib/localDocs.js';
import { createIdentity } from '../helpers/bundle.js';

const fake = vi.hoisted(() => ({
  state: { calls: [], failPost: [], landed: null, putHashes: [], posts: [] }
}));

vi.mock('../../src/lib/api.js', () => ({
  putBlob: async (args) => {
    fake.state.calls.push('putBlob');
    fake.state.putHashes.push(args.hash);
    return { hash: args.hash, size: args.size };
  },
  postDocRecord: async (docId, record, signature) => {
    fake.state.calls.push('postDocRecord');
    fake.state.posts.push({ docId, record, signature });
    const err = fake.state.failPost.shift();
    if (err) {
      if (err.landed) fake.state.landed = { docId, record, signature };
      throw err;
    }
    const records = await import('../../shared/records.js');
    return { recordHash: await records.recordHash(record), ledgerSeq: 1, ledgerHash: 'f'.repeat(64), document: { docId } };
  },
  getDocument: async (docId) => {
    fake.state.calls.push('getDocument');
    const l = fake.state.landed;
    if (!l || l.docId !== docId) throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' });
    const records = await import('../../shared/records.js');
    return { records: [{ record: l.record, signature: l.signature, recordHash: await records.recordHash(l.record) }] };
  },
  getBlob: async () => {
    throw new Error('not used here');
  }
}));

const { publishNewDocument, publishNewVersion, revokeDocument, forgetPendingPublish } = await import('../../src/lib/publish.js');

const FAST = 100000;

function makeFile(text = 'retry me', name = 'retry.txt') {
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

const network = (landed = false) => Object.assign(new Error('Could not reach the server.'), { status: 0, code: 'network', landed });
const refusal = () => Object.assign(new Error('slow down'), { status: 429, code: 'rate_limited' });

let identity;

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', fakeStorage());
  Object.assign(fake.state, { calls: [], failPost: [], landed: null, putHashes: [], posts: [] });
  forgetPendingPublish();
  const alice = await createIdentity('Alice');
  identity = { keyId: alice.keyId, sign: (record) => signRecord(alice.privateKey, record) };
});

describe('publishNewDocument after a failure', () => {
  it('a retry reuses the document id, the password, the locked file and the signed record', async () => {
    fake.state.failPost = [network(false)];
    const args = { file: makeFile(), label: 'Deed', listed: false, identity, iterations: FAST };
    await expect(publishNewDocument(args)).rejects.toThrow('Could not reach the server.');
    const first = fake.state.posts[0];
    const out = await publishNewDocument(args);
    const second = fake.state.posts[1];

    expect(second.docId).toBe(first.docId);
    expect(second.record).toEqual(first.record); // the very same signed record, same time stamp
    expect(second.signature).toBe(first.signature);
    expect(out.docId).toBe(first.docId);
    expect(new Set(fake.state.putHashes).size).toBe(1); // one locked file, uploaded again as the same bytes
    expect(out.password).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    expect(out.recordHash).toBe(await recordHash(first.record));
  });

  it('keeps the password of the failed attempt, so the document can still be unlocked', async () => {
    fake.state.failPost = [network(false)];
    const args = { file: makeFile('same file'), label: 'x', listed: false, identity, iterations: FAST };
    await expect(publishNewDocument(args)).rejects.toThrow();
    const a = await publishNewDocument(args);
    // a later, unrelated publish gets its own document id and password
    const b = await publishNewDocument({ ...args, file: makeFile('other file', 'other.txt') });
    expect(b.docId).not.toBe(a.docId);
    expect(b.password).not.toBe(a.password);
  });

  it('a lost answer for a record the server did store counts as published', async () => {
    fake.state.failPost = [network(true)]; // the server kept the record, the answer was lost
    const out = await publishNewDocument({ file: makeFile(), label: 'Deed', listed: false, identity, iterations: FAST });
    expect(out.version).toBe(1);
    expect(out.docId).toBe(fake.state.landed.docId);
    expect(out.recordHash).toBe(await recordHash(fake.state.landed.record));
    expect(fake.state.calls).toContain('getDocument');
  });

  it('a lost answer that the server did not keep stays an error, and the id stays in the local list', async () => {
    fake.state.failPost = [network(false)];
    await expect(publishNewDocument({ file: makeFile(), label: 'Deed', listed: false, identity, iterations: FAST })).rejects.toThrow();
    const ids = listLocalDocs().map((d) => d.docId);
    expect(ids).toEqual([fake.state.posts[0].docId]);
  });

  it('a clear refusal removes the id from the local list and the next try signs a new record', async () => {
    fake.state.failPost = [refusal()];
    const args = { file: makeFile(), label: 'Deed', listed: false, identity, iterations: FAST };
    await expect(publishNewDocument(args)).rejects.toThrow('slow down');
    expect(listLocalDocs()).toEqual([]);
    const first = fake.state.posts[0];
    await publishNewDocument(args);
    const second = fake.state.posts[1];
    expect(second.docId).toBe(first.docId);
    expect(second.signature).not.toBe(first.signature); // signed again, the refused record is spent
  });
});

describe('publishNewVersion and revokeDocument after a failure', () => {
  const head = { version: 1, recordHash: 'ab'.repeat(32) };
  const docId = 'cd'.repeat(16);

  it('a lost answer for a version the server kept counts as published', async () => {
    fake.state.failPost = [network(true)];
    const out = await publishNewVersion({
      docId,
      head,
      file: makeFile(),
      label: 'v2',
      identity,
      password: 'ABCD-EFGH-JKLM-NPQR-STUV',
      iterations: FAST
    });
    expect(out.version).toBe(2);
  });

  it('a conflict on the retry of a record that landed counts as published', async () => {
    const args = { docId, head, file: makeFile(), label: 'v2', identity, password: 'ABCD-EFGH-JKLM-NPQR-STUV', iterations: FAST };
    // first try: the answer is lost and getDocument cannot see it yet
    fake.state.failPost = [network(false)];
    await expect(publishNewVersion(args)).rejects.toThrow();
    const sent = fake.state.posts[0];
    // second try: the server already has it and answers 409; the document now shows the record
    fake.state.landed = { docId, record: sent.record, signature: sent.signature };
    fake.state.failPost = [Object.assign(new Error('the next version must be 3'), { status: 409, code: 'conflict' })];
    const out = await publishNewVersion(args);
    expect(out.recordHash).toBe(await recordHash(sent.record));
    expect(fake.state.posts[1].signature).toBe(sent.signature);
  });

  it('a conflict for a record the server does not hold is still an error', async () => {
    fake.state.failPost = [Object.assign(new Error('the next version must be 3'), { status: 409, code: 'conflict' })];
    await expect(
      publishNewVersion({ docId, head, file: makeFile(), label: 'v2', identity, password: 'ABCD-EFGH-JKLM-NPQR-STUV', iterations: FAST })
    ).rejects.toThrow('the next version must be 3');
  });

  it('a revoke whose answer was lost but was stored counts as done', async () => {
    fake.state.failPost = [network(true)];
    const out = await revokeDocument({ docId, head, reason: 'wrong file', identity });
    expect(out.version).toBe(2);
  });
});
