import { beforeAll, describe, expect, it } from 'vitest';
import { verifyLedgerPage } from '../../shared/verify.js';
import { ZERO_HASH } from '../../shared/records.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../shared/encoding.js';
import { buildBundleParts, buildLedger, clone, createIdentity } from '../helpers/bundle.js';

let alice;
let bob;
let ledger;
let identities;
let docA;
let docB;

const pageOf = (l, extra = {}) => ({ entries: clone(l.entries), identities: clone(identities), ...extra });
const flip = (sig) => {
  const b = base64UrlToBytes(sig);
  b[3] ^= 1;
  return bytesToBase64Url(b);
};

// Ledger with doc A (alice, 3 versions), doc B (bob, 2 versions), interleaved by build order.
beforeAll(async () => {
  alice = await createIdentity('Alice');
  bob = await createIdentity('Bob');
  ledger = buildLedger();
  docA = await buildBundleParts({ owner: alice, versions: [{}, {}, {}], serverKey: null, ledger });
  docB = await buildBundleParts({ owner: bob, versions: [{}, { revoke: true, reason: 'x' }], serverKey: null, ledger });
  identities = { ...docA.identities, ...docB.identities };
});

describe('valid pages', () => {
  it('verifies a whole ledger', async () => {
    const res = await verifyLedgerPage(pageOf(ledger));
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.lastSeq).toBe(5);
    expect(res.lastHash).toBe(ledger.head().hash);
  });
  it('verifies an empty page', async () => {
    const res = await verifyLedgerPage({ entries: [], identities: {} });
    expect(res).toMatchObject({ ok: true, lastSeq: 0, lastHash: ZERO_HASH, problems: [] });
    const later = await verifyLedgerPage({ entries: [], identities: {} }, { startSeq: 4, startPrev: 'a'.repeat(64) });
    expect(later).toMatchObject({ ok: true, lastSeq: 3, lastHash: 'a'.repeat(64) });
  });
  it('verifies pages one after another carrying the state', async () => {
    const docState = new Map();
    const p1 = await verifyLedgerPage({ ...pageOf(ledger), entries: clone(ledger.entries.slice(0, 2)) }, { docState });
    expect(p1.ok).toBe(true);
    expect(p1.lastSeq).toBe(2);
    const p2 = await verifyLedgerPage({ ...pageOf(ledger), entries: clone(ledger.entries.slice(2, 4)) }, { startSeq: p1.lastSeq + 1, startPrev: p1.lastHash, docState });
    expect(p2.ok).toBe(true);
    const p3 = await verifyLedgerPage({ ...pageOf(ledger), entries: clone(ledger.entries.slice(4)) }, { startSeq: p2.lastSeq + 1, startPrev: p2.lastHash, docState });
    expect(p3.ok).toBe(true);
    expect(p3.lastHash).toBe(ledger.head().hash);
  });
  it('a later page without carried state is a problem unless allowMidChain is set', async () => {
    const e = ledger.entries[1];
    const start = { startSeq: e.seq, startPrev: e.prevLedgerHash };
    const strict = await verifyLedgerPage({ entries: clone(ledger.entries.slice(1)), identities }, start);
    expect(strict.ok).toBe(false);
    expect(strict.problems.some((p) => /no earlier record|no create/.test(p))).toBe(true);
    const loose = await verifyLedgerPage({ entries: clone(ledger.entries.slice(1)), identities }, { ...start, allowMidChain: true });
    expect(loose.ok).toBe(true);
    expect(loose.warnings.length).toBeGreaterThan(0);
  });

  it('does not change its input', async () => {
    const page = pageOf(ledger);
    const copy = clone(page);
    await verifyLedgerPage(page);
    expect(page).toEqual(copy);
  });
});

describe('tampered pages', () => {
  it('detects a changed record', async () => {
    const page = pageOf(ledger);
    page.entries[1].record.label = 'changed';
    const res = await verifyLedgerPage(page);
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/entry 2/);
    expect(res.lastSeq).toBe(1);
  });
  it('detects a bad signature', async () => {
    const page = pageOf(ledger);
    page.entries[2].signature = flip(page.entries[2].signature);
    const res = await verifyLedgerPage(page);
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /signature/.test(p))).toBe(true);
    expect(res.lastSeq).toBe(2);
  });
  it('detects a changed ledger hash and a changed prev ledger hash', async () => {
    const a = pageOf(ledger);
    a.entries[1].ledgerHash = 'c'.repeat(64);
    expect((await verifyLedgerPage(a)).ok).toBe(false);
    const b = pageOf(ledger);
    b.entries[2].prevLedgerHash = 'c'.repeat(64);
    expect((await verifyLedgerPage(b)).ok).toBe(false);
  });
  it('detects a changed stated record hash', async () => {
    const page = pageOf(ledger);
    page.entries[0].recordHash = 'c'.repeat(64);
    expect((await verifyLedgerPage(page)).ok).toBe(false);
  });
  it('detects a removed entry (gap)', async () => {
    const page = pageOf(ledger);
    page.entries.splice(2, 1);
    const res = await verifyLedgerPage(page);
    expect(res.ok).toBe(false);
    expect(res.lastSeq).toBe(2);
  });
  it('detects reordered entries', async () => {
    const page = pageOf(ledger);
    [page.entries[1], page.entries[2]] = [page.entries[2], page.entries[1]];
    expect((await verifyLedgerPage(page)).ok).toBe(false);
  });
  it('detects a wrong start position', async () => {
    expect((await verifyLedgerPage(pageOf(ledger), { startSeq: 2 })).ok).toBe(false);
    expect((await verifyLedgerPage(pageOf(ledger), { startPrev: 'a'.repeat(64) })).ok).toBe(false);
  });
  it('detects a missing identity and a forged identity', async () => {
    const a = pageOf(ledger);
    delete a.identities[alice.keyId];
    const resA = await verifyLedgerPage(a);
    expect(resA.ok).toBe(false);
    expect(resA.problems[0]).toMatch(/identity/);
    const b = pageOf(ledger);
    b.identities[alice.keyId].record.displayName = 'Mallory';
    expect((await verifyLedgerPage(b)).ok).toBe(false);
    const c = pageOf(ledger);
    c.identities = undefined;
    expect((await verifyLedgerPage(c)).ok).toBe(false);
  });
  it('detects a record signed by another key', async () => {
    const l = buildLedger();
    const d = await buildBundleParts({ owner: alice, versions: [{}, { signWith: bob }], serverKey: null, ledger: l });
    const res = await verifyLedgerPage({ entries: l.entries, identities: d.identities });
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /signature/.test(p))).toBe(true);
  });
  it('detects non document records', async () => {
    const page = pageOf(ledger);
    page.entries[0].record = { ...page.entries[0].record, type: 'message' };
    expect((await verifyLedgerPage(page)).ok).toBe(false);
  });
});

describe('per document rules', () => {
  const run = async (versions, extraDocs = []) => {
    const l = buildLedger();
    const d = await buildBundleParts({ owner: alice, versions, serverKey: null, ledger: l });
    const ids = { ...d.identities };
    for (const x of extraDocs) {
      const more = await x(l);
      Object.assign(ids, more.identities);
    }
    return verifyLedgerPage({ entries: l.entries, identities: ids });
  };
  it('accepts a normal create, update, revoke', async () => {
    expect((await run([{}, {}, { revoke: true }])).ok).toBe(true);
  });
  it('rejects an update after a revoke', async () => {
    const res = await run([{}, { revoke: true }, {}]);
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /revoke/.test(p))).toBe(true);
  });
  it('rejects a wrong prev (signed correctly)', async () => {
    const res = await run([{}, { mutate: (r) => (r.prev = 'a'.repeat(64)) }]);
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /prev/.test(p))).toBe(true);
  });
  it('rejects a skipped version number', async () => {
    const res = await run([{}, { mutate: (r) => (r.version = 3) }]);
    expect(res.ok).toBe(false);
  });
  it('rejects a different signer on a later version', async () => {
    const l = buildLedger();
    const d = await buildBundleParts({ owner: alice, versions: [{}, { signer: bob }], serverKey: null, ledger: l });
    const res = await verifyLedgerPage({ entries: l.entries, identities: d.identities });
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /signer/.test(p))).toBe(true);
  });
  it('rejects time going backwards', async () => {
    const t = Date.now();
    const res = await run([{ createdAt: t }, { createdAt: t - 1000 }]);
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /createdAt/.test(p))).toBe(true);
  });
  it('rejects a second create for the same document id', async () => {
    const l = buildLedger();
    const docId = 'd'.repeat(32);
    const a = await buildBundleParts({ owner: alice, docId, serverKey: null, ledger: l });
    const b = await buildBundleParts({ owner: bob, docId, serverKey: null, ledger: l });
    const res = await verifyLedgerPage({ entries: l.entries, identities: { ...a.identities, ...b.identities } });
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /twice/.test(p))).toBe(true);
  });
  it('rejects broken state carried over from an earlier page', async () => {
    const docState = new Map();
    await verifyLedgerPage({ entries: clone(ledger.entries.slice(0, 1)), identities }, { docState });
    // Skip entry 2 of doc A by feeding entry 3 next, with matching seq and prev, so only the doc rule trips.
    const e = clone(ledger.entries[2]);
    const res = await verifyLedgerPage({ entries: [e], identities }, { startSeq: e.seq, startPrev: e.prevLedgerHash, docState });
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /does not follow/.test(p))).toBe(true);
  });
});

describe('malformed pages never throw', () => {
  it.each([undefined, null, 5, 'x', [], {}, { entries: 'x' }, { entries: [null] }, { entries: [5] }, { entries: [{}] }, { entries: [{ seq: 1, record: null }], identities: {} }])('page %#', async (page) => {
    const res = await verifyLedgerPage(page);
    expect(res.ok).toBe(false);
    expect(Array.isArray(res.problems)).toBe(true);
    expect(res.problems.length).toBeGreaterThan(0);
  });
  it('rejects bad options', async () => {
    const res = await verifyLedgerPage(pageOf(ledger), { startSeq: 0 });
    expect(res.ok).toBe(false);
    expect((await verifyLedgerPage(pageOf(ledger), { startPrev: 'x' })).ok).toBe(false);
    expect((await verifyLedgerPage(pageOf(ledger), null)).ok).toBe(true);
  });
});
