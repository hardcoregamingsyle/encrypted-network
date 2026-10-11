// PUT /api/me/secrets/:docId  body { password }  keep the password of a document the account owns
// GET /api/me/secrets/:docId                     read it back
// Easy accounts only. The password is wrapped (AES-GCM under a key derived from ACCOUNT_MASTER_KEY)
// and tied to the account and the document. It never appears in a log or an error.
import { utf8Decode, utf8Encode } from '../../../../shared/encoding.js';
import { isDocId } from '../../../../shared/records.js';
import { authJson, strictModeError } from '../../../_lib/accounts.js';
import { atRest } from '../../../_lib/atRest.js';
import { ApiError, badRequest } from '../../../_lib/errors.js';
import { onlyMethods, readJson } from '../../../_lib/http.js';
import { requireAuth, requireSameOrigin } from '../../../_lib/session.js';

export const PASSWORD_MAX = 128;

// A generated password is 5 groups of 4 letters or digits with dashes, or 20 characters without.
// Anything else printable ASCII up to 128 characters is accepted as well.
export function passwordOk(p) {
  return typeof p === 'string' && p.length >= 1 && p.length <= PASSWORD_MAX && /^[\x20-\x7e]+$/.test(p);
}

function docParam(params) {
  const id = params.docId;
  if (typeof id !== 'string' || !isDocId(id)) throw badRequest('docId must be 32 lowercase hex characters');
  return id;
}

export async function onRequestPut({ request, env, params }) {
  requireSameOrigin(request);
  const docId = docParam(params);
  const body = await readJson(request);
  if (!passwordOk(body.password)) throw badRequest(`password must be 1 to ${PASSWORD_MAX} printable characters`);
  const ar = await atRest(env);
  const auth = await requireAuth(env, request);
  if (auth.row.strict === 1) throw strictModeError();
  const id = auth.row.id;
  const wrapped = await ar.wrap(utf8Encode(body.password), 'secret', id, docId);

  // One statement checks Easy mode and ownership and writes, so nothing is stored for a document
  // the account does not own or after the account switched to Strict.
  const res = await env.DB.prepare(
    'INSERT INTO account_secrets (account_id, doc_id, wrapped, created_at) ' +
      'SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND strict = 0) ' +
      'AND EXISTS (SELECT 1 FROM documents d JOIN account_keys k ON k.key_id = d.owner_key_id WHERE d.doc_id = ? AND k.account_id = ?) ' +
      'ON CONFLICT (account_id, doc_id) DO UPDATE SET wrapped = excluded.wrapped, created_at = excluded.created_at'
  )
    .bind(id, docId, wrapped, auth.now, id, docId, id)
    .run();
  if (!res.meta || res.meta.changes < 1) {
    const state = await env.DB.prepare('SELECT strict FROM accounts WHERE id = ?').bind(id).first();
    if (state && state.strict === 1) throw strictModeError();
    const doc = await env.DB.prepare('SELECT 1 AS x FROM documents WHERE doc_id = ?').bind(docId).first();
    if (!doc) throw new ApiError('not_found', 'no such document');
    throw new ApiError('not_owner', 'this document is not owned by a key of your account');
  }
  return authJson(auth, { ok: true });
}

export async function onRequestGet({ request, env, params }) {
  const docId = docParam(params);
  const ar = await atRest(env);
  const auth = await requireAuth(env, request);
  // A Strict account keeps no password on the server. What is still waiting there after the switch is
  // handed over through POST /api/me/strict only.
  if (auth.row.strict === 1) throw new ApiError('not_found', 'no password is stored for this document');
  const row = await env.DB.prepare('SELECT wrapped FROM account_secrets WHERE account_id = ? AND doc_id = ?')
    .bind(auth.row.id, docId)
    .first();
  if (!row) throw new ApiError('not_found', 'no password is stored for this document');
  let password;
  try {
    password = utf8Decode(await ar.unwrap(row.wrapped, 'secret', auth.row.id, docId));
  } catch {
    console.error('a stored document password could not be opened');
    throw new ApiError('server_error', 'server error');
  }
  return authJson(auth, { password }, 200, { 'Cache-Control': 'no-store' });
}

export const onRequest = onlyMethods('GET', 'PUT');
