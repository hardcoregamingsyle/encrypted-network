// GET /api/documents/:docId/head: a small answer to "what is the latest version".
// ledgerSeq and ledgerHash are the ledger position of the head record itself.
import { isDocId } from '../../../../shared/records.js';
import { badRequest, notFound } from '../../../_lib/errors.js';
import { ledgerHeadFromRow } from '../../../_lib/documents.js';
import { headOf, json, onlyMethods } from '../../../_lib/http.js';
import { loadServerKey, serverInfo, signDocHead, signScope } from '../../../_lib/serverKey.js';

export async function onRequestGet({ env, params }) {
  const docId = params.docId;
  if (typeof docId !== 'string' || !isDocId(docId)) throw badRequest('docId must be 32 lowercase hex characters');
  const [docRes, recRes, headRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM documents WHERE doc_id = ?').bind(docId),
    env.DB
      .prepare(
        'SELECT r.body, r.ledger_seq, l.ledger_hash FROM records r JOIN ledger l ON l.seq = r.ledger_seq ' +
          'WHERE r.doc_id = ? ORDER BY r.version DESC LIMIT 1'
      )
      .bind(docId),
    env.DB.prepare('SELECT seq, ledger_hash FROM ledger ORDER BY seq DESC LIMIT 1')
  ]);
  const doc = docRes.results[0];
  const headRow = recRes.results[0];
  if (!doc || !headRow) throw notFound('document not found');
  const headRecord = JSON.parse(headRow.body);
  const ledgerHead = ledgerHeadFromRow(headRes.results[0]);
  const key = await loadServerKey(env);
  const now = Date.now();
  return json({
    docId,
    status: doc.status,
    headVersion: doc.head_version,
    headRecordHash: doc.head_record_hash,
    blobHash: headRecord.blob ? headRecord.blob.hash : null,
    ledgerSeq: headRow.ledger_seq,
    ledgerHash: headRow.ledger_hash,
    checkpoint: await signScope(key, { scope: 'ledger', seq: ledgerHead.seq, hash: ledgerHead.hash }, now),
    headCheckpoint: await signDocHead(
      key,
      { docId, headVersion: doc.head_version, headRecordHash: doc.head_record_hash },
      now
    ),
    server: serverInfo(key)
  });
}

export const onRequestHead = headOf(onRequestGet);
export const onRequest = onlyMethods('GET');
