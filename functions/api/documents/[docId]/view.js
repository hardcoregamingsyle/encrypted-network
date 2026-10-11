// A public file is "viewable" when its owner lets anyone open it. Then the file password is handed out, so any
// browser can unlock the file and check it. When it is off, only the checks work (the locked copy is useless
// without the password).
// GET /api/documents/:docId/view   -> { viewable: false } or { viewable: true, password }. Open to everyone.
// PUT /api/documents/:docId/view   body { on: true | false }, the owner only. Turning it on needs the password
//                                  to be kept on the server (Easy accounts, PUT /api/me/secrets/:docId).
import { utf8Decode } from '../../../../shared/encoding.js';
import { isDocId } from '../../../../shared/records.js';
import { authJson } from '../../../_lib/accounts.js';
import { atRest } from '../../../_lib/atRest.js';
import { ApiError, badRequest } from '../../../_lib/errors.js';
import { json, onlyMethods, readJson } from '../../../_lib/http.js';
import { requireAuth, requireSameOrigin } from '../../../_lib/session.js';

function docParam(params) {
  if (typeof params.docId !== 'string' || !isDocId(params.docId)) throw badRequest('docId must be 32 lowercase hex characters');
  return params.docId;
}

export async function onRequestGet({ env, params }) {
  const docId = docParam(params);
  const row = await env.DB.prepare(
    'SELECT k.account_id, s.wrapped FROM documents d JOIN account_keys k ON k.key_id = d.owner_key_id ' +
      "JOIN account_secrets s ON s.account_id = k.account_id AND s.doc_id = d.doc_id WHERE d.doc_id = ? AND d.viewable = 1 AND d.status = 'active'"
  )
    .bind(docId)
    .first();
  if (!row) return json({ viewable: false }, 200, { 'Cache-Control': 'no-store' });
  try {
    const password = utf8Decode(await (await atRest(env)).unwrap(row.wrapped, 'secret', row.account_id, docId));
    return json({ viewable: true, password }, 200, { 'Cache-Control': 'no-store' });
  } catch {
    console.error('a stored document password could not be opened');
    throw new ApiError('server_error', 'server error');
  }
}

export async function onRequestPut({ request, env, params }) {
  requireSameOrigin(request);
  const docId = docParam(params);
  const body = await readJson(request);
  if (typeof body.on !== 'boolean') throw badRequest('on must be true or false');
  const auth = await requireAuth(env, request);
  const id = auth.row.id;
  const res = await env.DB.prepare(
    "UPDATE documents SET viewable = ? WHERE doc_id = ? AND status = 'active' " +
      'AND EXISTS (SELECT 1 FROM account_keys k WHERE k.key_id = documents.owner_key_id AND k.account_id = ?) ' +
      'AND (? = 0 OR EXISTS (SELECT 1 FROM account_secrets s WHERE s.account_id = ? AND s.doc_id = documents.doc_id))'
  )
    .bind(body.on ? 1 : 0, docId, id, body.on ? 1 : 0, id)
    .run();
  if (!res.meta || res.meta.changes < 1) {
    const doc = await env.DB.prepare('SELECT status FROM documents WHERE doc_id = ?').bind(docId).first();
    if (!doc) throw new ApiError('not_found', 'no such document');
    if (doc.status !== 'active') throw new ApiError('conflict', 'this file was withdrawn');
    const owner = await env.DB.prepare(
      'SELECT 1 AS x FROM documents d JOIN account_keys k ON k.key_id = d.owner_key_id WHERE d.doc_id = ? AND k.account_id = ?'
    )
      .bind(docId, id)
      .first();
    if (!owner) throw new ApiError('not_owner', 'this document is not owned by a key of your account');
    throw new ApiError('conflict', 'the server does not keep the password of this file, so it cannot be opened for everyone');
  }
  return authJson(auth, { ok: true, viewable: body.on });
}

export const onRequest = onlyMethods('GET', 'PUT');
