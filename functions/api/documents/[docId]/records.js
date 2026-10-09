// POST /api/documents/:docId/records: add a signed doc.create, doc.update or doc.revoke record.
import { DOC_RECORD_TYPES, LIMITS, isDocId, validateRecord } from '../../../../shared/records.js';
import { badRequest } from '../../../_lib/errors.js';
import { appendDocRecord } from '../../../_lib/documents.js';
import { json, onlyMethods, readSignedBody } from '../../../_lib/http.js';
import { requireSigner } from '../../../_lib/identities.js';
import { consumeRate } from '../../../_lib/rate.js';
import { assertFresh } from '../../../_lib/time.js';

export async function onRequestPost({ request, env, params }) {
  const docId = params.docId;
  if (typeof docId !== 'string' || !isDocId(docId)) throw badRequest('docId must be 32 lowercase hex characters');
  const { record, signature } = await readSignedBody(request);
  const valid = validateRecord(record);
  if (!valid.ok) throw badRequest(valid.error);
  if (!DOC_RECORD_TYPES.includes(record.type)) throw badRequest('record type must be doc.create, doc.update or doc.revoke');
  if (record.docId !== docId) throw badRequest('record.docId does not match the address');

  const now = Date.now();
  assertFresh(record.createdAt, LIMITS.RECORD_TIME_WINDOW_MS, now);
  await requireSigner(env, record, signature);
  await consumeRate(env, 'docRecord', record.signer, now);

  const result = await appendDocRecord(env, record, signature);
  return json(result, 201);
}

export const onRequest = onlyMethods('POST');
