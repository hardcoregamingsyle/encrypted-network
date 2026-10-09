// Ledger, checkpoint and head attestation correctness after parallel writes.
// node tests/review/backend/ledger.mjs <baseUrl>
import { verifyCheckpoint } from '../../../shared/checkpoint.js';
import { chainHash } from '../../../shared/hash.js';
import { recordHash } from '../../../shared/records.js';
import { verifyDocumentBundle, verifyLedgerPage } from '../../../shared/verify.js';
import {
  ZERO_HASH, assert, brief, call, check, createRecord, eq, expectStatus, finish, makeBlob, newPerson, openDb,
  postDoc, putBlob, updateRecord
} from './_lib.mjs';

const serverKey = (await call('GET', '/api/server-key')).json;
assert(serverKey.signing, 'server must have a signing key for this script');

const people = [];
for (let i = 0; i < 8; i++) people.push(await newPerson('Par' + i));
const blobs = [];
for (const p of people) {
  const b = await makeBlob(240);
  assert((await putBlob(p, b)).status < 300, 'upload');
  blobs.push(b);
}

const created = [];
await check('24 parallel doc.create from 8 signers all succeed with distinct contiguous ledger seqs', async () => {
  const jobs = [];
  for (let i = 0; i < people.length; i++) {
    for (let k = 0; k < 3; k++) {
      const rec = createRecord(people[i], blobs[i], { label: `parallel ${i}-${k}`, listed: k !== 2 });
      jobs.push(postDoc(people[i], rec).then((r) => ({ r, rec, owner: people[i], blob: blobs[i] })));
    }
  }
  const out = await Promise.all(jobs);
  const bad = out.filter((o) => o.r.status !== 201);
  assert(bad.length === 0, 'failed: ' + bad.map((o) => brief(o.r)).join(' | '));
  const seqs = out.map((o) => o.r.json.ledgerSeq).sort((a, b) => a - b);
  assert(new Set(seqs).size === seqs.length, 'duplicate ledger seqs');
  for (let i = 1; i < seqs.length; i++) assert(seqs[i] === seqs[i - 1] + 1, `gap in seqs ${seqs[i - 1]} -> ${seqs[i]}`);
  created.push(...out);
});

await check('parallel updates across documents keep the ledger linked', async () => {
  const jobs = created.slice(0, 16).map(async (c) => {
    const rec = updateRecord(c.owner, c.blob, { docId: c.rec.docId, version: 2, prev: c.r.json.recordHash, label: 'upd' });
    return postDoc(c.owner, rec);
  });
  const out = await Promise.all(jobs);
  const bad = out.filter((r) => r.status !== 201);
  assert(bad.length === 0, 'failed: ' + bad.map(brief).join(' | '));
});

await check('full ledger from genesis verifies with verifyLedgerPage (hash chain, signatures, per document rules)', async () => {
  let after = 0;
  let startSeq = 1;
  let startPrev = ZERO_HASH;
  const docState = new Map();
  let total = 0;
  for (;;) {
    const res = await call('GET', `/api/ledger?after=${after}&limit=200`);
    expectStatus(res, 200);
    const v = await verifyLedgerPage(res.json, { startSeq, startPrev, docState });
    assert(v.ok, 'ledger problems: ' + v.problems.slice(0, 5).join('; '));
    total += res.json.entries.length;
    if (!res.json.hasMore) {
      assert(await verifyCheckpoint(serverKey.publicKey, res.json.checkpoint), 'ledger checkpoint does not verify');
      eq(res.json.checkpoint.payload.seq, v.lastSeq, 'checkpoint seq equals last entry');
      eq(res.json.checkpoint.payload.hash, v.lastHash, 'checkpoint hash equals last ledger hash');
      break;
    }
    after = v.lastSeq;
    startSeq = v.lastSeq + 1;
    startPrev = v.lastHash;
  }
  assert(total >= 40, 'expected at least 40 entries, got ' + total);
});

await check('every created document bundle verifies, anchored, with a pinned key and a fresh checkpoint', async () => {
  for (const c of created.slice(0, 12)) {
    const res = await call('GET', `/api/documents/${c.rec.docId}`);
    expectStatus(res, 200);
    const v = await verifyDocumentBundle(res.json, {
      pinnedServerKeyId: serverKey.keyId,
      expectedDocId: c.rec.docId,
      maxCheckpointAgeMs: 30000
    });
    assert(v.ok && v.anchored, `bundle ${c.rec.docId} ${JSON.stringify(v.checks.filter((x) => !x.ok))}`);
  }
});

await check('record ledgerSeq in the bundle matches the ledger entry of the same record', async () => {
  const c = created[3];
  const bundle = (await call('GET', `/api/documents/${c.rec.docId}`)).json;
  const led = (await call('GET', `/api/ledger?after=${c.r.json.ledgerSeq - 1}&limit=1`)).json;
  eq(led.entries[0].seq, bundle.records[0].ledgerSeq, 'seq');
  eq(led.entries[0].recordHash, bundle.records[0].recordHash, 'recordHash');
  eq(led.entries[0].ledgerHash, bundle.records[0].ledgerHash, 'ledgerHash');
  eq(await recordHash(bundle.records[0].record), bundle.records[0].recordHash, 'stored body hashes to recordHash');
  eq(await chainHash(bundle.records[0].prevLedgerHash, bundle.records[0].recordHash), bundle.records[0].ledgerHash, 'chain');
});

await check('head endpoint: head checkpoint verifies and is freshly signed on every request', async () => {
  const c = created[5];
  const a = (await call('GET', `/api/documents/${c.rec.docId}/head`)).json;
  await new Promise((r) => setTimeout(r, 30));
  const b = (await call('GET', `/api/documents/${c.rec.docId}/head`)).json;
  assert(await verifyCheckpoint(serverKey.publicKey, a.headCheckpoint), 'head checkpoint A');
  assert(await verifyCheckpoint(serverKey.publicKey, b.headCheckpoint), 'head checkpoint B');
  eq(a.headCheckpoint.payload.scope, 'doc:' + c.rec.docId, 'scope');
  assert(b.headCheckpoint.payload.signedAt > a.headCheckpoint.payload.signedAt, 'signedAt did not advance');
  assert(Math.abs(Date.now() - b.headCheckpoint.payload.signedAt) < 5000, 'signedAt not fresh');
  eq(a.headCheckpoint.payload.hash, a.headRecordHash, 'head hash');
});

await check('read your writes: checkpoint right after a write already covers it', async () => {
  const p = await newPerson('Ryw');
  const b = await makeBlob(230);
  assert((await putBlob(p, b)).status < 300, 'upload');
  const rec = createRecord(p, b);
  const w = await postDoc(p, rec);
  expectStatus(w, 201);
  const bundle = (await call('GET', `/api/documents/${rec.docId}`)).json;
  assert(bundle.checkpoint.payload.seq >= w.json.ledgerSeq, 'checkpoint is behind the write');
  const v = await verifyDocumentBundle(bundle, { pinnedServerKeyId: serverKey.keyId, expectedDocId: rec.docId, maxCheckpointAgeMs: 30000 });
  assert(v.ok && v.anchored, JSON.stringify(v.checks.filter((x) => !x.ok)));
});

await check('database invariants: ledger and records agree row for row', async () => {
  const db = await openDb();
  assert(db, 'local database not found, run this on the machine that hosts the server');
  const n = (sql) => db.prepare(sql).get().n;
  eq(n('SELECT COUNT(*) n FROM ledger'), n('SELECT COUNT(*) n FROM records'), 'ledger rows vs record rows');
  eq(n('SELECT COUNT(*) n FROM records r JOIN ledger l ON l.seq = r.ledger_seq AND l.record_hash = r.record_hash'), n('SELECT COUNT(*) n FROM records'), 'records.ledger_seq points at its own ledger row');
  eq(n('SELECT COUNT(*) n FROM ledger WHERE seq < 1'), 0, 'bad seq');
  const mx = n('SELECT MAX(seq) n FROM ledger');
  eq(mx, n('SELECT COUNT(*) n FROM ledger'), 'seqs contiguous from 1');
  // heads
  eq(
    n(`SELECT COUNT(*) n FROM documents d WHERE d.head_version = (SELECT MAX(version) FROM records r WHERE r.doc_id = d.doc_id)
        AND d.head_record_hash = (SELECT record_hash FROM records r WHERE r.doc_id = d.doc_id AND r.version = d.head_version)`),
    n('SELECT COUNT(*) n FROM documents'),
    'documents head matches the latest record'
  );
  eq(n('SELECT COUNT(*) n FROM documents WHERE doc_id NOT IN (SELECT doc_id FROM records)'), 0, 'documents without records');
  eq(n('SELECT COUNT(*) n FROM records WHERE doc_id NOT IN (SELECT doc_id FROM documents)'), 0, 'records without documents');
  // chain of ledger hashes
  const rows = db.prepare('SELECT seq, record_hash, prev_ledger_hash, ledger_hash FROM ledger ORDER BY seq').all();
  let prev = ZERO_HASH;
  for (const r of rows) {
    eq(r.prev_ledger_hash, prev, 'prev at seq ' + r.seq);
    eq(await chainHash(prev, r.record_hash), r.ledger_hash, 'ledger hash at seq ' + r.seq);
    prev = r.ledger_hash;
  }
});

finish();
