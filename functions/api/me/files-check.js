// GET /api/me/files-check              { check: <64 hex> | null }  the fingerprint of the files password, if one was set
// PUT /api/me/files-check  { check }   set it once (409 when it is already set)
// The fingerprint comes from src/lib/filesPassword.js (filesCheckFor). It only lets the app say "that is not your
// files password" before locking a file with the wrong key. It cannot be changed: files locked with the old
// password could not be opened any more.
import { isHash } from '../../../shared/records.js';
import { authJson } from '../../_lib/accounts.js';
import { ApiError, badRequest } from '../../_lib/errors.js';
import { onlyMethods, readJson } from '../../_lib/http.js';
import { requireAuth, requireSameOrigin } from '../../_lib/session.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(env, request);
  const row = await env.DB.prepare('SELECT files_check FROM accounts WHERE id = ?').bind(auth.row.id).first();
  return authJson(auth, { check: row && row.files_check ? row.files_check : null }, 200, { 'Cache-Control': 'no-store' });
}

export async function onRequestPut({ request, env }) {
  requireSameOrigin(request);
  const auth = await requireAuth(env, request);
  const body = await readJson(request);
  if (!isHash(body.check)) throw badRequest('check must be 64 lowercase hex characters');
  const res = await env.DB.prepare('UPDATE accounts SET files_check = ? WHERE id = ? AND files_check IS NULL').bind(body.check, auth.row.id).run();
  if (!res.meta || res.meta.changes < 1) throw new ApiError('conflict', 'the files password is already set');
  return authJson(auth, { ok: true });
}

export const onRequest = onlyMethods('GET', 'PUT');
