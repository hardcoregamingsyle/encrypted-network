// GET    /api/me/sessions  the sessions (signed in devices) of the account: { sessions:[{ id, createdAt,
//                          lastSeenAt, expiresAt, current }] }, newest first. The id is a short handle, it is
//                          not the cookie and can not be turned into one.
// DELETE /api/me/sessions  ends every session except the one that asks. Answer { ok:true, ended:<n> }.
// Ending one session: DELETE /api/me/sessions/<id>. Ending all of them, this one too: POST /api/auth/logout
// with { "all": true }.
import { authJson } from '../../../_lib/accounts.js';
import { atRest } from '../../../_lib/atRest.js';
import { onlyMethods } from '../../../_lib/http.js';
import { requireAuth, requireSameOrigin } from '../../../_lib/session.js';

export const SESSION_ID_CHARS = 16;

export async function onRequestGet({ request, env }) {
  await atRest(env);
  const auth = await requireAuth(env, request);
  const { results } = await env.DB.prepare(
    'SELECT token_hash, created_at, last_seen_at, expires_at FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY created_at DESC, token_hash ASC LIMIT 50'
  )
    .bind(auth.row.id, auth.now)
    .all();
  const sessions = results.map((r) => ({
    id: r.token_hash.slice(0, SESSION_ID_CHARS),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    current: r.token_hash === auth.tokenHash
  }));
  return authJson(auth, { sessions }, 200, { 'Cache-Control': 'no-store' });
}

export async function onRequestDelete({ request, env }) {
  requireSameOrigin(request);
  await atRest(env);
  const auth = await requireAuth(env, request);
  const res = await env.DB.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?').bind(auth.row.id, auth.tokenHash).run();
  return authJson(auth, { ok: true, ended: res.meta ? res.meta.changes : 0 });
}

export const onRequest = onlyMethods('GET', 'DELETE');
