// None of the public verify functions may throw or reject on garbage.
import { describe, expect, it } from 'vitest';
import { verifyBlobBytes, verifyDocumentBundle, verifyLedgerPage, verifyMessages, verifyPlaintext } from '../../../shared/verify.js';
import { verifyCheckpoint } from '../../../shared/checkpoint.js';
import { verifyRecord, keyIdOf } from '../../../shared/keys.js';
import { validateRecord } from '../../../shared/records.js';
import { buildBundle, buildChannelPage, createIdentity, createServerKey, buildBundleParts, buildLedger, identityEntry } from '../../helpers/bundle.js';

function deepObject(depth) {
  let o = { v: 2 };
  for (let i = 0; i < depth; i++) o = { a: o };
  return o;
}
function deepArray(depth) {
  let o = [];
  for (let i = 0; i < depth; i++) o = [o];
  return o;
}
class Weird {
  constructor() {
    this.a = 1;
  }
}

const cyclic = {};
cyclic.self = cyclic;
cyclic.records = [cyclic];
cyclic.messages = [cyclic];
cyclic.entries = [cyclic];
cyclic.identities = cyclic;
cyclic.document = cyclic;
cyclic.checkpoint = cyclic;
cyclic.server = cyclic;
cyclic.record = cyclic;

const throwingProxy = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
const throwingGetter = { get records() { throw new Error('boom'); }, get messages() { throw new Error('boom'); }, get entries() { throw new Error('boom'); }, get identities() { throw new Error('boom'); } };

const garbage = [
  undefined,
  null,
  0,
  -0,
  NaN,
  Infinity,
  1n,
  true,
  '',
  'x'.repeat(100000),
  Symbol('s'),
  () => 1,
  [],
  [[]],
  [null],
  {},
  { records: null },
  { records: 'abc' },
  { records: [null, 1, 'x', [], {}] },
  { records: [{ record: null }, { record: [] }, { record: 'x' }, { record: { type: 'doc.create' } }] },
  { messages: [null, 1, 'x', [], {}, { record: null }] },
  { entries: [null, 1, 'x', [], {}, { record: null }] },
  { identities: [], document: [], checkpoint: [], server: [], records: [] },
  { identities: { x: null }, document: { docId: 1 }, checkpoint: { payload: null }, server: { publicKey: null }, records: [{}] },
  { identities: { [('a').repeat(64)]: { record: { type: 'identity', publicKey: [] } } }, records: [{ record: { signer: 'a'.repeat(64) } }] },
  JSON.parse('{"__proto__":{"records":[]},"records":[{"__proto__":1}]}'),
  JSON.parse('{"constructor":{"prototype":1},"records":[{"record":{"constructor":1}}]}'),
  deepObject(100),
  deepObject(5000),
  deepArray(5000),
  { records: deepArray(3000), messages: deepArray(3000), entries: deepArray(3000), identities: deepObject(3000) },
  { records: Array.from({ length: 20000 }, () => null) },
  { messages: Array.from({ length: 5000 }, () => ({})) },
  { entries: Array.from({ length: 5000 }, () => ({})) },
  new Map([[1, 2]]),
  new Set([1]),
  new Date(0),
  new Uint8Array(10),
  new ArrayBuffer(8),
  new Weird(),
  Object.create(null),
  Object.create({ records: [] }),
  cyclic,
  throwingProxy,
  throwingGetter,
  new Proxy([], {}),
  Object.freeze({ records: Object.freeze([]) })
];

const optionSets = [undefined, null, 5, 'x', [], {}, { pinnedServerKeyId: 5 }, { pinnedServerKeyId: {} }, { now: 'x' }, { now: NaN }, { startSeq: 'x', startPrev: 5, docState: 5 }];

describe('garbage input never throws and never verifies', () => {
  it('verifyDocumentBundle', async () => {
    for (const g of garbage) {
      for (const o of optionSets) {
        const r = await verifyDocumentBundle(g, o);
        expect(r.ok).toBe(false);
        expect(r.head).toBe(null);
        expect(r.status).toBe('invalid');
        expect(Array.isArray(r.checks)).toBe(true);
        expect(Array.isArray(r.warnings)).toBe(true);
      }
    }
  }, 120000);

  it('verifyLedgerPage', async () => {
    for (const g of garbage) {
      for (const o of optionSets) {
        const r = await verifyLedgerPage(g, o);
        expect(r.ok).toBe(false);
        expect(Array.isArray(r.problems)).toBe(true);
      }
    }
  }, 120000);

  it('verifyMessages', async () => {
    for (const g of garbage) {
      for (const o of optionSets) {
        const r = await verifyMessages(g, o);
        expect(r.ok).toBe(false);
        expect(Array.isArray(r.results)).toBe(true);
      }
    }
  }, 120000);

  it('verifyBlobBytes, verifyPlaintext, verifyCheckpoint, verifyRecord, keyIdOf, validateRecord', async () => {
    for (const a of garbage) {
      for (const b of garbage.slice(0, 20)) {
        expect((await verifyBlobBytes(a, b)).ok).toBe(false);
        expect((await verifyPlaintext(a, b)).ok).toBe(false);
        expect(await verifyCheckpoint(a, b)).toBe(false);
        expect(await verifyRecord(a, b, a)).toBe(false);
      }
      await expect(keyIdOf(a)).rejects.toThrow();
      expect(validateRecord(a).ok).toBe(false);
    }
  }, 120000);

  it('real data with garbage options still verifies or fails cleanly', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const bundle = await buildBundle({ owner: alice, serverKey: server, versions: [{}] });
    for (const o of optionSets) {
      const r = await verifyDocumentBundle(bundle, o);
      expect(typeof r.ok).toBe('boolean');
    }
    const parts = await buildBundleParts({ owner: alice, serverKey: server, versions: [{}], ledger: buildLedger() });
    const page = { ...parts.ledger.page(), identities: { [alice.keyId]: identityEntry(alice) } };
    for (const o of optionSets) {
      const r = await verifyLedgerPage(page, o);
      expect(typeof r.ok).toBe('boolean');
    }
    const chat = await buildChannelPage({ messages: [{ author: alice, body: 'hi' }], serverKey: server });
    for (const o of optionSets) {
      const r = await verifyMessages(chat, o);
      expect(typeof r.ok).toBe('boolean');
    }
  }, 120000);
});
