// GET    /api/me/files/:id   the locked bytes of one private file, only for the account that owns it.
//                            The headers carry what the owner signed at upload, so the browser can check the
//                            bytes against that signature before it asks for the password.
// DELETE /api/me/files/:id   remove it
import { isDocId } from '../../../../shared/records.js';
import { authJson } from '../../../_lib/accounts.js';
import { ApiError, badRequest, notFound } from '../../../_lib/errors.js';
import { onlyMethods } from '../../../_lib/http.js';
import { requireAuth, requireSameOrigin } from '../../../_lib/session.js';
import { blobStore } from '../../../_lib/store.js';

function idParam(params) {
  if (typeof params.id !== 'string' || !isDocId(params.id)) throw badRequest('the file id must be 32 lowercase hex characters');
  return params.id;
}

export async function onRequestGet({ request, env, params }) {
  const id = idParam(params);
  const auth = await requireAuth(env, request);
  const row = await env.DB.prepare('SELECT label, blob_hash, signer, signed_at, signature FROM private_files WHERE id = ? AND account_id = ?')
    .bind(id, auth.row.id)
    .first();
  if (!row) throw notFound('file not found');
  const object = await blobStore(env).get('private/' + id);
  if (!object) throw notFound('file not found');
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(object.size),
    'Cache-Control': 'no-store',
    'x-blob-sha256': row.blob_hash,
    'x-hrd-key': row.signer,
    'x-hrd-time': String(row.signed_at),
    'x-hrd-sig': row.signature,
    'x-file-label': encodeURIComponent(row.label)
  };
  if (auth.setCookie) headers['Set-Cookie'] = auth.setCookie; // the session was just extended
  return new Response(object.body, { status: 200, headers });
}

export async function onRequestDelete({ request, env, params }) {
  requireSameOrigin(request);
  const id = idParam(params);
  const auth = await requireAuth(env, request);
  const res = await env.DB.prepare('DELETE FROM private_files WHERE id = ? AND account_id = ?').bind(id, auth.row.id).run();
  if (!res.meta || res.meta.changes < 1) throw new ApiError('not_found', 'file not found');
  await blobStore(env).delete('private/' + id);
  return authJson(auth, { ok: true });
}

export const onRequest = onlyMethods('GET', 'DELETE');
