// GET /api/documents/:docId: the full verification bundle (works for unlisted documents too).
import { isDocId } from '../../../../shared/records.js';
import { badRequest } from '../../../_lib/errors.js';
import { docSummary, readDocument } from '../../../_lib/documents.js';
import { headOf, json, onlyMethods } from '../../../_lib/http.js';
import { loadServerKey, serverInfo, signDocHead, signScope } from '../../../_lib/serverKey.js';

export async function onRequestGet({ env, params }) {
  const docId = params.docId;
  if (typeof docId !== 'string' || !isDocId(docId)) throw badRequest('docId must be 32 lowercase hex characters');
  const { doc, records, identities, ledgerHead } = await readDocument(env, docId);
  const key = await loadServerKey(env);
  const now = Date.now();
  return json({
    document: docSummary(doc),
    records,
    identities,
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
