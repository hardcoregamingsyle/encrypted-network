// Database invariants after all the other attack scripts have run (run this one last).
// node tests/review/backend/invariants.mjs <baseUrl>
import { chainHash } from '../../../shared/hash.js';
import { verifyMessages } from '../../../shared/verify.js';
import { ZERO_HASH, assert, call, check, eq, finish, openDb } from './_lib.mjs';

const serverKey = (await call('GET', '/api/server-key')).json;
const db = await openDb();
assert(db, 'local database not found');
const n = (sql, ...a) => db.prepare(sql).get(...a).n;

await check('ledger and records: same count, contiguous seqs, every record points at its own ledger row', async () => {
  eq(n('SELECT COUNT(*) n FROM ledger'), n('SELECT COUNT(*) n FROM records'), 'row counts');
  eq(n('SELECT MAX(seq) n FROM ledger'), n('SELECT COUNT(*) n FROM ledger'), 'contiguous seqs');
  eq(n('SELECT COUNT(*) n FROM records r JOIN ledger l ON l.seq = r.ledger_seq AND l.record_hash = r.record_hash'), n('SELECT COUNT(*) n FROM records'), 'ledger_seq matches');
});

await check('no document without records, no record without a document, heads agree with the newest record', async () => {
  eq(n('SELECT COUNT(*) n FROM documents WHERE doc_id NOT IN (SELECT doc_id FROM records)'), 0, 'documents without records');
  eq(n('SELECT COUNT(*) n FROM records WHERE doc_id NOT IN (SELECT doc_id FROM documents)'), 0, 'records without documents');
  eq(
    n(`SELECT COUNT(*) n FROM documents d JOIN records r ON r.doc_id = d.doc_id AND r.version = d.head_version
        WHERE r.record_hash = d.head_record_hash AND d.head_version = (SELECT MAX(version) FROM records x WHERE x.doc_id = d.doc_id)`),
    n('SELECT COUNT(*) n FROM documents'),
    'head agreement'
  );
  eq(n("SELECT COUNT(*) n FROM documents d JOIN records r ON r.record_hash = d.head_record_hash WHERE (d.status = 'revoked') != (r.type = 'doc.revoke')"), 0, 'status agrees with head type');
  eq(n('SELECT COUNT(*) n FROM documents d JOIN records r ON r.record_hash = d.head_record_hash WHERE d.updated_at != r.created_at'), 0, 'updated_at agrees with head createdAt');
});

await check('records versions are 1..n per document with prev links, owner never changes, nothing after a revoke', async () => {
  const docs = db.prepare('SELECT doc_id FROM documents').all();
  for (const { doc_id } of docs) {
    const rows = db.prepare('SELECT record_hash, version, type, signer, body, created_at FROM records WHERE doc_id = ? ORDER BY version').all(doc_id);
    let prev = ZERO_HASH;
    let owner = rows[0].signer;
    let t = 0;
    rows.forEach((r, i) => {
      const rec = JSON.parse(r.body);
      eq(r.version, i + 1, 'version');
      eq(rec.prev, prev, 'prev at ' + doc_id.slice(0, 8) + ' v' + r.version);
      eq(r.signer, owner, 'owner');
      assert(r.created_at >= t, 'createdAt backwards in ' + doc_id.slice(0, 8));
      if (i < rows.length - 1) assert(r.type !== 'doc.revoke', 'record after revoke');
      prev = r.record_hash;
      t = r.created_at;
    });
  }
});

await check('every message chain is contiguous from 1 and hash linked, and verifyMessages agrees', async () => {
  const chans = db.prepare('SELECT DISTINCT channel_id c FROM messages').all();
  let checked = 0;
  for (const { c } of chans) {
    const rows = db.prepare('SELECT seq, hash, prev_chain_hash, chain_hash FROM messages WHERE channel_id = ? ORDER BY seq').all(c);
    let prev = ZERO_HASH;
    rows.forEach((r, i) => eq(r.seq, i + 1, 'seq in ' + c));
    for (const r of rows) {
      eq(r.prev_chain_hash, prev, 'prev in ' + c + ' #' + r.seq);
      eq(await chainHash(prev, r.hash), r.chain_hash, 'chain in ' + c + ' #' + r.seq);
      prev = r.chain_hash;
    }
    if (rows.length <= 100) {
      const page = await call('GET', `/api/channels/${c}/messages?limit=100`);
      const v = await verifyMessages(page.json, { pinnedServerKeyId: serverKey.keyId, expectedChannelId: c });
      assert(v.ok && v.anchored, `${c}: ${JSON.stringify(v.results.filter((x) => !x.ok).slice(0, 2))} ${v.warnings.join(' ')}`);
      checked++;
    }
  }
  assert(chans.length > 0 && checked > 0, 'no channel was verified');
});

await check('blobs: every row has its object, and every doc blob exists with the signed size', async () => {
  const rows = db.prepare('SELECT hash, size FROM blobs ORDER BY created_at DESC LIMIT 60').all();
  for (const r of rows) {
    const head = await call('HEAD', '/api/blobs/' + r.hash);
    eq(head.status, 200, 'object for row ' + r.hash.slice(0, 8));
    eq(head.headers.get('content-length'), String(r.size), 'size');
  }
  const docBlobs = db.prepare("SELECT body FROM records WHERE type != 'doc.revoke'").all();
  for (const { body } of docBlobs) {
    const rec = JSON.parse(body);
    eq(n('SELECT COUNT(*) n FROM blobs WHERE hash = ? AND size = ?', rec.blob.hash, rec.blob.size), 1, 'blob row for doc record');
  }
});

await check('stored bodies are canonical and hash to their keys', async () => {
  const { canonicalize } = await import('../../../shared/canonical.js');
  const { recordHash } = await import('../../../shared/records.js');
  for (const r of db.prepare('SELECT record_hash, body FROM records').all()) {
    const rec = JSON.parse(r.body);
    eq(canonicalize(rec), r.body, 'canonical text');
    eq(await recordHash(rec), r.record_hash, 'hash');
  }
  for (const r of db.prepare('SELECT hash, body FROM messages').all()) {
    const rec = JSON.parse(r.body);
    eq(canonicalize(rec), r.body, 'canonical text (message)');
    eq(await recordHash(rec), r.hash, 'hash (message)');
  }
});

finish();
