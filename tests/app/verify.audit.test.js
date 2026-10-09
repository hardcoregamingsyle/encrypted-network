import { describe, expect, it } from 'vitest';
import { signRecord } from '../../shared/keys.js';
import { PAGE_LIMIT, PROBLEM_CAP, auditLedger } from '../../src/lib/audit.js';
import {
  buildBundleParts,
  buildLedger,
  clone,
  createIdentity,
  createServerKey,
  identityEntry,
  ledgerCheckpoint,
  serverInfo
} from '../helpers/bundle.js';

// Builds a ledger of documents. docs is a list of version lists, owners alternate between two people.
async function makeWorld(docs, { serverKey } = {}) {
  const alice = await createIdentity('Alice');
  const bob = await createIdentity('Bob');
  const key = serverKey === undefined ? await createServerKey() : serverKey;
  const ledger = buildLedger();
  const identities = {};
  const parts = [];
  for (let i = 0; i < docs.length; i++) {
    const owner = i % 2 === 0 ? alice : bob;
    const p = await buildBundleParts({ owner, versions: docs[i], serverKey: key, ledger });
    Object.assign(identities, p.identities);
    parts.push(p);
  }
  return { alice, bob, serverKey: key, ledger, identities, parts };
}

// A fake GET /api/ledger. transform(page, call) may change the (copied) page.
function makeFetch(w, { transform, calls = [] } = {}) {
  return async ({ after, limit, signal }) => {
    calls.push({ after, limit });
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const page = clone(w.ledger.page({ after, limit }));
    page.identities = clone(w.identities);
    page.checkpoint = w.serverKey ? await ledgerCheckpoint(w.serverKey, w.ledger) : null;
    page.server = serverInfo(w.serverKey);
    if (transform) await transform(page, calls.length);
    return page;
  };
}

const TWO_VERSIONS = [{}, {}];
const threeDocs = () => [[{}, {}, {}], TWO_VERSIONS, [{}, {}, {}]]; // 8 entries

describe('auditLedger: clean ledgers', () => {
  it('walks several pages and passes', async () => {
    const w = await makeWorld(threeDocs());
    const calls = [];
    const r = await auditLedger({ fetchPage: makeFetch(w, { calls }), limit: 3, pinnedServerKeyId: w.serverKey.keyId });
    expect(r.status).toBe('done');
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(8);
    expect(r.documents).toBe(3);
    expect(r.lastSeq).toBe(8);
    expect(r.lastHash).toBe(w.ledger.head().hash);
    expect(r.problemCount).toBe(0);
    expect(r.checkpoint.matchesEnd).toBe(true);
    expect(r.checkpoint.signatureOk).toBe(true);
    expect(r.checkpoint.pinMatches).toBe(true);
    expect(r.pinned).toBe(w.serverKey.keyId);
    // 3 pages with entries, then one empty page that carries the final checkpoint
    expect(calls.map((c) => c.after)).toEqual([0, 3, 6, 8]);
    expect(r.pages).toBe(4);
  });

  it('carries state across page borders (a document split over pages)', async () => {
    const w = await makeWorld([[{}, {}, {}, {}, {}]]);
    const r = await auditLedger({ fetchPage: makeFetch(w), limit: 2 });
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(5);
    expect(r.documents).toBe(1);
  });

  it('uses 200 entries per page by default', async () => {
    const w = await makeWorld([[{}]]);
    const calls = [];
    await auditLedger({ fetchPage: makeFetch(w, { calls }) });
    expect(PAGE_LIMIT).toBe(200);
    expect(calls[0].limit).toBe(200);
  });

  it('an empty ledger passes with a checkpoint at seq 0', async () => {
    const w = await makeWorld([]);
    const r = await auditLedger({ fetchPage: makeFetch(w) });
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(0);
    expect(r.checkpoint.matchesEnd).toBe(true);
    expect(r.checkpoint.seq).toBe(0);
  });

  it('warns when no key is pinned and when nothing earlier is compared', async () => {
    const w = await makeWorld(threeDocs());
    const r = await auditLedger({ fetchPage: makeFetch(w) });
    expect(r.ok).toBe(true);
    expect(r.pinned).toBe(null);
    expect(r.checkpoint.pinMatches).toBe(null);
    expect(r.warnings.some((t) => t.includes('not pinned'))).toBe(true);
    expect(r.warnings.some((t) => t.includes('saved earlier'))).toBe(true);
  });

  it('reports progress after each page', async () => {
    const w = await makeWorld(threeDocs());
    const seen = [];
    await auditLedger({ fetchPage: makeFetch(w), limit: 3, onProgress: (p) => seen.push(p) });
    const walking = seen.filter((p) => p.phase === 'walking').map((p) => p.entries);
    expect(walking).toEqual([3, 6, 8]);
    expect(seen[seen.length - 1].phase).toBe('done');
    expect(seen.every((p) => p.total === 8)).toBe(true);
  });

  it('a throwing progress callback does not stop the audit', async () => {
    const w = await makeWorld(threeDocs());
    const r = await auditLedger({
      fetchPage: makeFetch(w),
      onProgress: () => {
        throw new Error('boom');
      }
    });
    expect(r.ok).toBe(true);
  });

  it('follows a ledger that grows while it is walked', async () => {
    const w = await makeWorld([[{}, {}]]);
    let grown = false;
    const base = makeFetch(w);
    const fetchPage = async (args) => {
      const page = await base(args);
      if (!grown && args.after > 0) {
        grown = true;
        const p = await buildBundleParts({ owner: w.bob, versions: [{}], serverKey: w.serverKey, ledger: w.ledger });
        Object.assign(w.identities, p.identities);
      }
      return page;
    };
    const r = await auditLedger({ fetchPage, limit: 1 });
    expect(grown).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(3);
    expect(r.documents).toBe(2);
    expect(r.checkpoint.matchesEnd).toBe(true);
  });
});

describe('auditLedger: server key and checkpoint', () => {
  it('fails loudly when the server key is not the pinned one', async () => {
    const w = await makeWorld(threeDocs());
    const other = await createServerKey();
    const r = await auditLedger({ fetchPage: makeFetch(w), pinnedServerKeyId: other.keyId });
    expect(r.ok).toBe(false);
    expect(r.checkpoint.pinMatches).toBe(false);
    expect(r.problems.some((t) => t.includes('NOT the pinned key'))).toBe(true);
  });

  it('a malformed pin fails closed instead of meaning "not pinned"', async () => {
    const w = await makeWorld(threeDocs());
    const r = await auditLedger({ fetchPage: makeFetch(w), pinnedServerKeyId: 'abc' });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('pinned server key id is not valid');
  });

  it('accepts a pin in upper case with spaces around it', async () => {
    const w = await makeWorld(threeDocs());
    const r = await auditLedger({ fetchPage: makeFetch(w), pinnedServerKeyId: `  ${w.serverKey.keyId.toUpperCase()} ` });
    expect(r.ok).toBe(true);
    expect(r.checkpoint.pinMatches).toBe(true);
  });

  it('a checkpoint with a changed seq no longer verifies', async () => {
    const w = await makeWorld(threeDocs());
    const transform = (page) => {
      if (page.entries.length === 0) page.checkpoint.payload.seq = 3;
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }) });
    expect(r.ok).toBe(false);
    expect(r.checkpoint.signatureOk).toBe(false);
    expect(r.problems.some((t) => t.includes('signature does not verify'))).toBe(true);
  });

  it('detects a server that serves fewer entries than its signed checkpoint says', async () => {
    const w = await makeWorld(threeDocs());
    const transform = (page) => {
      page.entries = page.entries.filter((e) => e.seq <= 6);
      page.hasMore = false;
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }), limit: 3 });
    expect(r.ok).toBe(false);
    expect(r.lastSeq).toBe(6);
    expect(r.checkpoint.matchesEnd).toBe(false);
    expect(r.problems.some((t) => t.includes('says the ledger is at entry 8'))).toBe(true);
  });

  it('detects a checkpoint hash that differs at the same seq', async () => {
    const w = await makeWorld(threeDocs());
    const other = await makeWorld(threeDocs(), { serverKey: w.serverKey });
    // checkpoint from a different ledger of the same length, signed by the same server key
    const fetchPage = async (args) => {
      const page = await makeFetch(w)(args);
      page.checkpoint = await ledgerCheckpoint(w.serverKey, other.ledger);
      return page;
    };
    const r = await auditLedger({ fetchPage });
    expect(r.ok).toBe(false);
    expect(r.problems.some((t) => t.includes('hash differs'))).toBe(true);
  });

  it('no server key: passes the chain checks, warns, and fails when a pin is set', async () => {
    const w = await makeWorld(threeDocs(), { serverKey: null });
    const plain = await auditLedger({ fetchPage: makeFetch(w) });
    expect(plain.ok).toBe(true);
    expect(plain.checkpoint.present).toBe(false);
    expect(plain.warnings.some((t) => t.includes('did not send a signed checkpoint'))).toBe(true);

    const pin = 'a'.repeat(64);
    const pinned = await auditLedger({ fetchPage: makeFetch(w), pinnedServerKeyId: pin });
    expect(pinned.ok).toBe(false);
    expect(pinned.problems.some((t) => t.includes('no signed checkpoint'))).toBe(true);
  });

  it('a checkpoint without a server key is a problem', async () => {
    const w = await makeWorld(threeDocs());
    const transform = (page) => {
      page.server = null;
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }) });
    expect(r.ok).toBe(false);
    expect(r.problems.some((t) => t.includes('without the server key'))).toBe(true);
  });

  it('a checkpoint for another scope does not count', async () => {
    const w = await makeWorld(threeDocs());
    const transform = (page) => {
      page.checkpoint = null;
    };
    const base = makeFetch(w, { transform });
    const r = await auditLedger({ fetchPage: base });
    expect(r.ok).toBe(true); // nothing to compare, only a warning
    const docCp = w.parts[0].bundle.headCheckpoint;
    const fetchPage = async (args) => {
      const page = await base(args);
      page.checkpoint = clone(docCp);
      page.server = serverInfo(w.serverKey);
      return page;
    };
    const r2 = await auditLedger({ fetchPage });
    expect(r2.ok).toBe(false);
  });
});

describe('auditLedger: tampering', () => {
  it('finds a changed record once, without a flood of follow-up problems', async () => {
    const w = await makeWorld(threeDocs());
    const transform = (page) => {
      for (const e of page.entries) if (e.seq === 4) e.record.label = 'changed after the fact';
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }), limit: 3 });
    expect(r.ok).toBe(false);
    // entry 5 is the next version of the same document, so its prev link breaks too
    expect(r.problems.every((t) => t.startsWith('entry 4') || t.startsWith('entry 5'))).toBe(true);
    expect(r.problems.filter((t) => t.startsWith('entry 5'))).toHaveLength(1);
    expect(r.problems.some((t) => t.includes('recordHash does not match'))).toBe(true);
    expect(r.problems.some((t) => t.includes('signature does not verify'))).toBe(true);
    expect(r.problemCount).toBeLessThanOrEqual(4);
    expect(r.entries).toBe(8);
  });

  it('finds a forged signature', async () => {
    const w = await makeWorld(threeDocs());
    const transform = async (page) => {
      for (const e of page.entries) {
        if (e.seq === 2) e.signature = await signRecord(w.bob.privateKey, e.record);
      }
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }) });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['entry 2: signature does not verify']);
  });

  it('finds a broken chain link, also across a page border', async () => {
    const w = await makeWorld(threeDocs());
    const transform = (page) => {
      for (const e of page.entries) if (e.seq === 4) e.prevLedgerHash = 'f'.repeat(64);
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }), limit: 3 });
    expect(r.ok).toBe(false);
    expect(r.problems.some((t) => t.startsWith('entry 4') && t.includes('does not link'))).toBe(true);
    // the walk went on to the end
    expect(r.entries).toBe(8);
    expect(r.checkpoint.matchesEnd).toBe(true);
  });

  it('finds reordered entries', async () => {
    const w = await makeWorld(threeDocs());
    const transform = (page) => {
      const a = page.entries.findIndex((e) => e.seq === 3);
      const b = page.entries.findIndex((e) => e.seq === 4);
      if (a >= 0 && b >= 0) [page.entries[a], page.entries[b]] = [page.entries[b], page.entries[a]];
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }) });
    expect(r.ok).toBe(false);
    expect(r.problems.some((t) => t.includes('expected seq'))).toBe(true);
  });

  it('finds a dropped entry in the middle', async () => {
    const w = await makeWorld(threeDocs());
    const transform = (page) => {
      page.entries = page.entries.filter((e) => e.seq !== 5);
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }) });
    expect(r.ok).toBe(false);
    expect(r.problems.some((t) => t.includes('expected seq 5'))).toBe(true);
  });

  it('finds a document whose create record is missing', async () => {
    const w = await makeWorld([[{}, {}]]);
    // a ledger that starts with the document's second version
    const second = w.parts[0].versions[1];
    const ledger = buildLedger();
    await ledger.append(second.record, second.signature);
    const w2 = { ...w, ledger };
    const r = await auditLedger({ fetchPage: makeFetch(w2) });
    expect(r.ok).toBe(false);
    expect(r.problems.some((t) => t.includes('no create record'))).toBe(true);
  });

  it('finds a record signed by someone with no identity', async () => {
    const w = await makeWorld(threeDocs());
    const transform = (page) => {
      page.identities = {};
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }) });
    expect(r.ok).toBe(false);
    expect(r.problemCount).toBeGreaterThanOrEqual(8);
  });

  it('finds a second owner taking over a document', async () => {
    const w = await makeWorld([[{}]]);
    const created = w.parts[0].versions[0];
    const ledger = buildLedger();
    await ledger.append(created.record, created.signature);
    // bob signs version 2 of alice's document
    const rec = {
      ...clone(created.record),
      type: 'doc.update',
      version: 2,
      prev: created.recordHash,
      signer: w.bob.keyId,
      createdAt: created.record.createdAt + 1000
    };
    delete rec.listed;
    const sig = await signRecord(w.bob.privateKey, rec);
    await ledger.append(rec, sig);
    const r = await auditLedger({ fetchPage: makeFetch({ ...w, ledger }) });
    expect(r.ok).toBe(false);
    expect(r.problems.some((t) => t.includes('signer differs'))).toBe(true);
  });

  it('caps the problem list at 50 and still counts all of them', async () => {
    const w = await makeWorld([Array.from({ length: 30 }, () => ({})), Array.from({ length: 30 }, () => ({}))]);
    const transform = (page) => {
      for (const e of page.entries) {
        e.record.label = 'x';
        e.recordHash = 'e'.repeat(64);
      }
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }), limit: 20 });
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(PROBLEM_CAP);
    expect(r.problemCount).toBeGreaterThan(PROBLEM_CAP);
    expect(r.entries).toBe(60);
  });
});

describe('auditLedger: earlier saved position', () => {
  it('accepts a position that is still in the ledger', async () => {
    const w = await makeWorld(threeDocs());
    const e = w.ledger.entries[4];
    const r = await auditLedger({ fetchPage: makeFetch(w), limit: 3, knownPoint: { seq: e.seq, hash: e.ledgerHash } });
    expect(r.ok).toBe(true);
    expect(r.knownPointChecked).toBe(true);
    expect(r.warnings.some((t) => t.includes('saved earlier'))).toBe(false);
  });

  it('rejects a position whose hash changed (history rewritten)', async () => {
    const w = await makeWorld(threeDocs());
    const r = await auditLedger({ fetchPage: makeFetch(w), knownPoint: { seq: 5, hash: 'c'.repeat(64) } });
    expect(r.ok).toBe(false);
    expect(r.problems.some((t) => t.includes('different hash than the position you saved'))).toBe(true);
  });

  it('rejects a ledger that ends before the saved position', async () => {
    const w = await makeWorld(threeDocs());
    const r = await auditLedger({ fetchPage: makeFetch(w), knownPoint: { seq: 50, hash: 'c'.repeat(64) } });
    expect(r.ok).toBe(false);
    expect(r.problems.some((t) => t.includes('before the position you saved'))).toBe(true);
  });

  it('rejects a malformed saved position', async () => {
    const w = await makeWorld(threeDocs());
    const r = await auditLedger({ fetchPage: makeFetch(w), knownPoint: { seq: 0, hash: 'zz' } });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('saved ledger position is not valid');
  });
});

describe('auditLedger: stopping early', () => {
  it('can be cancelled midway and keeps the counts so far', async () => {
    const w = await makeWorld(threeDocs());
    const ctrl = new AbortController();
    const calls = [];
    const base = makeFetch(w, { calls });
    const fetchPage = async (args) => {
      const page = await base(args);
      if (calls.length === 2) ctrl.abort();
      return page;
    };
    const r = await auditLedger({ fetchPage, signal: ctrl.signal, limit: 3 });
    expect(r.status).toBe('aborted');
    expect(r.ok).toBe(false);
    expect(r.entries).toBe(3);
    expect(r.checkpoint).toBe(null);
    expect(r.warnings.some((t) => t.includes('did not finish'))).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('abort while a request is running (fetch throws AbortError)', async () => {
    const w = await makeWorld(threeDocs());
    const ctrl = new AbortController();
    const base = makeFetch(w);
    let n = 0;
    const fetchPage = async (args) => {
      n += 1;
      if (n === 2) {
        ctrl.abort();
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      return base(args);
    };
    const r = await auditLedger({ fetchPage, signal: ctrl.signal, limit: 3 });
    expect(r.status).toBe('aborted');
    expect(r.entries).toBe(3);
  });

  it('a signal that is already aborted fetches nothing', async () => {
    const w = await makeWorld(threeDocs());
    const calls = [];
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await auditLedger({ fetchPage: makeFetch(w, { calls }), signal: ctrl.signal });
    expect(r.status).toBe('aborted');
    expect(calls).toHaveLength(0);
    expect(r.entries).toBe(0);
  });

  it('a network failure ends in status error with the counts so far', async () => {
    const w = await makeWorld(threeDocs());
    const base = makeFetch(w);
    let n = 0;
    const fetchPage = async (args) => {
      n += 1;
      if (n === 3) throw new Error('Could not reach the server.');
      return base(args);
    };
    const r = await auditLedger({ fetchPage, limit: 3 });
    expect(r.status).toBe('error');
    expect(r.error).toBe('Could not reach the server.');
    expect(r.entries).toBe(6);
    expect(r.ok).toBe(false);
  });

  it('a missing fetch function is an error, not a crash', async () => {
    const r = await auditLedger({});
    expect(r.status).toBe('error');
    expect(r.ok).toBe(false);
    const r2 = await auditLedger();
    expect(r2.ok).toBe(false);
  });

  it('a server that says "more" but sends nothing ends the audit', async () => {
    const w = await makeWorld(threeDocs());
    const transform = (page) => {
      if (page.entries.length === 0) page.hasMore = true;
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }) });
    expect(r.status).toBe('incomplete');
    expect(r.ok).toBe(false);
  });

  it('a server that repeats the same page cannot loop the audit forever', async () => {
    const w = await makeWorld(threeDocs());
    const first = await makeFetch(w)({ after: 0, limit: 3 });
    first.entries = first.entries.slice(0, 3);
    let n = 0;
    const fetchPage = async () => {
      n += 1;
      if (n > 20) throw new Error('looped');
      return clone(first);
    };
    const r = await auditLedger({ fetchPage, limit: 3 });
    expect(r.status).toBe('incomplete');
    expect(r.ok).toBe(false);
    expect(n).toBeLessThan(5);
  });

  it('stops at the page cap', async () => {
    const w = await makeWorld(threeDocs());
    const r = await auditLedger({ fetchPage: makeFetch(w), limit: 1, maxPages: 3 });
    expect(r.status).toBe('incomplete');
    expect(r.entries).toBe(3);
    expect(r.ok).toBe(false);
  });

  it('a garbage page is a problem, not a crash', async () => {
    const r1 = await auditLedger({ fetchPage: async () => null });
    expect(r1.status).toBe('incomplete');
    expect(r1.ok).toBe(false);
    const r2 = await auditLedger({ fetchPage: async () => ({ entries: 'nope' }) });
    expect(r2.ok).toBe(false);
  });

  it('malformed entries are reported without throwing', async () => {
    const w = await makeWorld(threeDocs());
    const transform = (page) => {
      page.entries[0] = 42;
    };
    const r = await auditLedger({ fetchPage: makeFetch(w, { transform }) });
    expect(r.ok).toBe(false);
  });
});

describe('identity helper sanity', () => {
  it('identityEntry output is what the audit expects', async () => {
    const a = await createIdentity('Zed');
    expect(identityEntry(a).keyId).toBe(a.keyId);
  });
});
