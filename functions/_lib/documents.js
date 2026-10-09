// Document and ledger logic: chain rules, the atomic write, and reading bundles back.
import { canonicalize } from '../../shared/canonical.js';
import { chainHash, recordHash } from '../../shared/records.js';
import { ZERO_HASH } from '../../shared/encoding.js';
import { ApiError, badRequest, isUniqueConflict, notFound } from './errors.js';
import { identityMapFromRows } from './identities.js';
import { backoff, withLock } from './lock.js';

export const MAX_ATTEMPTS = 5;

// documents row to the "document" object of bundles and write responses.
export function docSummary(row) {
  return {
    docId: row.doc_id,
    ownerKeyId: row.owner_key_id,
    status: row.status,
    headVersion: row.head_version,
    headRecordHash: row.head_record_hash,
    listed: row.listed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Current end of the ledger: { seq, hash }, seq 0 and the zero hash when empty.
export function ledgerHeadFromRow(row) {
  return row ? { seq: row.seq, hash: row.ledger_hash } : { seq: 0, hash: ZERO_HASH };
}

export function getLedgerHead(env) {
  return env.DB.prepare('SELECT seq, ledger_hash FROM ledger ORDER BY seq DESC LIMIT 1').first().then(ledgerHeadFromRow);
}

// The chain rules for one new record against the current document row (or null).
// Throws ApiError with the right code. Returns nothing.
export async function checkChainRules(env, record, doc) {
  if (record.type === 'doc.create') {
    if (doc) throw new ApiError('exists', 'a document with this id already exists');
    await requireBlob(env, record.blob);
    return;
  }
  if (!doc) throw notFound('document not found');
  if (doc.owner_key_id !== record.signer) throw new ApiError('not_owner', 'only the owner of the document can add versions');
  if (doc.status === 'revoked') throw new ApiError('conflict', 'the document is revoked, no more versions can be added');
  if (record.version !== doc.head_version + 1) {
    throw new ApiError('conflict', `the next version must be ${doc.head_version + 1}, send a record built on the current head`);
  }
  if (record.prev !== doc.head_record_hash) {
    throw new ApiError('conflict', 'prev is not the current head record, reload the document and sign again');
  }
  if (record.createdAt < doc.updated_at) throw badRequest('createdAt is earlier than the previous version');
  if (record.type === 'doc.update') await requireBlob(env, record.blob);
}

async function requireBlob(env, blob) {
  const row = await env.DB.prepare('SELECT size FROM blobs WHERE hash = ?').bind(blob.hash).first();
  if (!row) throw badRequest('the locked file has not been uploaded, upload it first');
  if (row.size !== blob.size) throw badRequest('blob size does not match the uploaded file');
}

// Statements for the atomic write. The ledger row goes first so the record row can read its seq.
function writeStatements(env, record, signature, hash, head, ledgerHash, now) {
  const body = canonicalize(record);
  const db = env.DB;
  const stmts = [
    db
      .prepare('INSERT INTO ledger (record_hash, prev_ledger_hash, ledger_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(hash, head.hash, ledgerHash, now),
    db
      .prepare(
        'INSERT INTO records (record_hash, doc_id, version, type, signer, body, signature, ledger_seq, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT seq FROM ledger WHERE record_hash = ?), ?)'
      )
      .bind(hash, record.docId, record.version, record.type, record.signer, body, signature, hash, record.createdAt)
  ];
  if (record.type === 'doc.create') {
    stmts.push(
      db
        .prepare(
          'INSERT INTO documents (doc_id, owner_key_id, status, listed, head_version, head_record_hash, label, created_at, updated_at) ' +
            "VALUES (?, ?, 'active', ?, 1, ?, ?, ?, ?)"
        )
        .bind(record.docId, record.signer, record.listed ? 1 : 0, hash, record.label, record.createdAt, record.createdAt)
    );
  } else if (record.type === 'doc.update') {
    stmts.push(
      db
        .prepare('UPDATE documents SET head_version = ?, head_record_hash = ?, label = ?, updated_at = ? WHERE doc_id = ?')
        .bind(record.version, hash, record.label, record.createdAt, record.docId)
    );
  } else {
    stmts.push(
      db
        .prepare("UPDATE documents SET status = 'revoked', head_version = ?, head_record_hash = ?, updated_at = ? WHERE doc_id = ?")
        .bind(record.version, hash, record.createdAt, record.docId)
    );
  }
  return stmts;
}

// Checks the chain rules and writes the record with one D1 batch. If another writer got there
// first, the UNIQUE columns make the batch fail as a whole, and this recomputes and tries again.
export async function appendDocRecord(env, record, signature) {
  const hash = await recordHash(record);
  return withLock('ledger', async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const [docRow, headRow] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM documents WHERE doc_id = ?').bind(record.docId),
        env.DB.prepare('SELECT seq, ledger_hash FROM ledger ORDER BY seq DESC LIMIT 1')
      ]);
      const doc = docRow.results[0] || null;
      const head = ledgerHeadFromRow(headRow.results[0]);
      await checkChainRules(env, record, doc);
      const ledgerHash = await chainHash(head.hash, hash);
      const now = Date.now();
      try {
        await env.DB.batch(writeStatements(env, record, signature, hash, head, ledgerHash, now));
      } catch (err) {
        if (!isUniqueConflict(err)) throw err;
        await backoff(attempt);
        continue;
      }
      const [seqRes, docRes] = await env.DB.batch([
        env.DB.prepare('SELECT ledger_seq FROM records WHERE record_hash = ?').bind(hash),
        env.DB.prepare('SELECT * FROM documents WHERE doc_id = ?').bind(record.docId)
      ]);
      return {
        recordHash: hash,
        ledgerSeq: seqRes.results[0].ledger_seq,
        ledgerHash,
        document: docSummary(docRes.results[0])
      };
    }
    throw new ApiError('conflict', 'the server is busy, try again');
  });
}

// Reads everything for GET /api/documents/:docId from one consistent batch.
export async function readDocument(env, docId) {
  const [docRes, recRes, idRes, headRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM documents WHERE doc_id = ?').bind(docId),
    env.DB
      .prepare(
        'SELECT r.record_hash, r.body, r.signature, r.ledger_seq, l.ledger_hash, l.prev_ledger_hash ' +
          'FROM records r JOIN ledger l ON l.seq = r.ledger_seq WHERE r.doc_id = ? ORDER BY r.version ASC'
      )
      .bind(docId),
    env.DB
      .prepare('SELECT * FROM identities WHERE key_id IN (SELECT DISTINCT signer FROM records WHERE doc_id = ?)')
      .bind(docId),
    env.DB.prepare('SELECT seq, ledger_hash FROM ledger ORDER BY seq DESC LIMIT 1')
  ]);
  const doc = docRes.results[0];
  if (!doc) throw notFound('document not found');
  const records = recRes.results.map((r) => ({
    record: JSON.parse(r.body),
    signature: r.signature,
    recordHash: r.record_hash,
    ledgerSeq: r.ledger_seq,
    ledgerHash: r.ledger_hash,
    prevLedgerHash: r.prev_ledger_hash
  }));
  return {
    doc,
    records,
    identities: identityMapFromRows(idRes.results),
    ledgerHead: ledgerHeadFromRow(headRes.results[0])
  };
}
