import { beforeAll, describe, expect, it } from 'vitest';
import { cleanSeenHead, compareWithSeen, headFromBundle, nextSeenHead } from '../../shared/headMemory.js';
import { buildBundleParts, clone, createIdentity, createServerKey } from '../helpers/bundle.js';

let v2;
let docId;

beforeAll(async () => {
  const owner = await createIdentity('Registry Office');
  const serverKey = await createServerKey();
  v2 = await buildBundleParts({ owner, serverKey, versions: [{ label: 'v1' }, { label: 'v2' }, { label: 'v3' }] });
  docId = v2.docId;
});

const cut = (bundle, n) => {
  const b = clone(bundle);
  b.records = b.records.slice(0, n);
  return b;
};

describe('headFromBundle and cleanSeenHead', () => {
  it('reads version, hash and ledger position of the last record', () => {
    const got = headFromBundle(v2.bundle, docId);
    expect(got.head.headVersion).toBe(3);
    expect(got.head.docId).toBe(docId);
    expect(got.head.headRecordHash).toBe(v2.bundle.records[2].recordHash);
    expect(Object.keys(got.hashes)).toEqual(['1', '2', '3']);
  });
  it('returns null for junk', () => {
    for (const x of [null, undefined, 5, 'x', {}, { records: [] }, { records: [null] }, { records: [{ record: {} }] }]) {
      expect(headFromBundle(x, docId)).toBe(null);
    }
  });
  it('rejects malformed seen heads', () => {
    const good = headFromBundle(v2.bundle, docId).head;
    expect(cleanSeenHead(good)).toEqual(good);
    for (const bad of [null, 1, [], { ...good, docId: 'zz' }, { ...good, headVersion: 0 }, { ...good, headRecordHash: 'A'.repeat(64) }, { ...good, ledgerSeq: -1 }, { ...good, ledgerSeq: 1.5 }]) {
      expect(cleanSeenHead(bad)).toBe(null);
    }
  });
  it('does not keep extra fields', () => {
    const good = headFromBundle(v2.bundle, docId).head;
    expect(Object.keys(cleanSeenHead({ ...good, password: 'secret' })).sort()).toEqual(
      ['checkpointSeq', 'docId', 'headRecordHash', 'headVersion', 'ledgerSeq']
    );
  });
});

describe('compareWithSeen', () => {
  it('no warning without a remembered head, for the same bundle, or for a longer history', () => {
    const seen2 = headFromBundle(cut(v2.bundle, 2), docId).head;
    expect(compareWithSeen(null, v2.bundle, docId)).toEqual({ rollback: false, warnings: [] });
    expect(compareWithSeen(seen2, cut(v2.bundle, 2), docId).rollback).toBe(false);
    expect(compareWithSeen(seen2, v2.bundle, docId).rollback).toBe(false);
  });
  it('warns when the version goes down', () => {
    const seen3 = headFromBundle(v2.bundle, docId).head;
    const r = compareWithSeen(seen3, cut(v2.bundle, 1), docId);
    expect(r.rollback).toBe(true);
    expect(r.warnings[0]).toMatch(/went back/);
    expect(r.warnings[0]).toMatch(/version 3/);
  });
  it('warns when the remembered record is not in the new history (fork at the same version)', () => {
    const seen = headFromBundle(v2.bundle, docId).head;
    const forked = clone(v2.bundle);
    forked.records[2].recordHash = 'a'.repeat(64);
    const r = compareWithSeen(seen, forked, docId);
    expect(r.rollback).toBe(true);
    expect(r.warnings[0]).toMatch(/history changed/);
  });
  it('warns when an older record was swapped under a longer chain', () => {
    const seen = headFromBundle(cut(v2.bundle, 2), docId).head;
    const forked = clone(v2.bundle);
    forked.records[1].recordHash = 'b'.repeat(64);
    expect(compareWithSeen(seen, forked, docId).rollback).toBe(true);
  });
  it('warns when the ledger position goes down', () => {
    const seen = { ...headFromBundle(v2.bundle, docId).head, checkpointSeq: 50 };
    const b = clone(v2.bundle);
    b.checkpoint.payload.seq = 10;
    const r = compareWithSeen(seen, b, docId);
    expect(r.rollback).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/ledger went back/);
  });
  it('ignores a remembered head of another document or a bad one', () => {
    const seen = headFromBundle(v2.bundle, docId).head;
    expect(compareWithSeen(seen, cut(v2.bundle, 1), 'c'.repeat(32)).rollback).toBe(false);
    expect(compareWithSeen({ nonsense: true }, cut(v2.bundle, 1), docId).rollback).toBe(false);
  });
  it('never throws on a malformed bundle', () => {
    const seen = headFromBundle(v2.bundle, docId).head;
    for (const b of [null, {}, { records: 'x' }, { records: [{}] }]) {
      expect(compareWithSeen(seen, b, docId).rollback).toBe(false);
    }
  });
});

describe('nextSeenHead', () => {
  it('stores the first head and moves forward', () => {
    const b2 = cut(v2.bundle, 2);
    expect(nextSeenHead(null, b2, docId, { rollback: false }).headVersion).toBe(2);
    const seen2 = headFromBundle(b2, docId).head;
    expect(nextSeenHead(seen2, v2.bundle, docId, compareWithSeen(seen2, v2.bundle, docId)).headVersion).toBe(3);
  });
  it('never replaces the remembered head with one that went back', () => {
    const seen3 = headFromBundle(v2.bundle, docId).head;
    const b1 = cut(v2.bundle, 1);
    expect(nextSeenHead(seen3, b1, docId, compareWithSeen(seen3, b1, docId))).toBe(null);
  });
  it('keeps the highest ledger position seen', () => {
    const seen = { ...headFromBundle(v2.bundle, docId).head, checkpointSeq: 99999 };
    const next = nextSeenHead(seen, v2.bundle, docId, { rollback: false });
    expect(next.checkpointSeq).toBe(99999);
  });
});
