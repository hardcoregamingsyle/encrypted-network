// DELETE /api/me/sessions/<id>  ends one session of the account (id from GET /api/me/sessions). When it is
// the session that asks, the cookie is cleared too. Answer { ok:true }, or 404 when there is no such session.
import { authJson, clearedJson } from '../../../_lib/accounts.js';
import { atRest } from '../../../_lib/atRest.js';
import { ApiError, badRequest } from '../../../_lib/errors.js';
import { onlyMethods } from '../../../_lib/http.js';
import { requireAuth, requireSameOrigin } from '../../../_lib/session.js';

export async function onRequestDelete({ request, env, params }) {
  requireSameOrigin(request);
  await atRest(env);
  const id = params.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw badRequest('id must be 16 lowercase hex characters');
  const auth = await requireAuth(env, request);
  const row = await env.DB.prepare('SELECT token_hash FROM sessions WHERE account_id = ? AND substr(token_hash, 1, 16) = ? LIMIT 1')
    .bind(auth.row.id, id)
    .first();
  if (!row) throw new ApiError('not_found', 'no such session');
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ? AND account_id = ?').bind(row.token_hash, auth.row.id).run();
  if (row.token_hash === auth.tokenHash) return clearedJson(request, { ok: true });
  return authJson(auth, { ok: true });
}

export const onRequest = onlyMethods('DELETE');
