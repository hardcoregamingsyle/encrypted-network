// POST /api/auth/logout            ->  200 { ok:true } and the cookie is cleared. Works without a session too.
// POST /api/auth/logout {all:true} ->  ends every session of the account, this one too (a lost phone, a
//                                      stolen cookie). Needs a valid session. The answer says how many.
import { clearedJson } from '../../_lib/accounts.js';
import { atRest } from '../../_lib/atRest.js';
import { utf8Decode } from '../../../shared/encoding.js';
import { onlyMethods, readBodyBytes } from '../../_lib/http.js';
import { hashToken, readSessionToken, requireAuth, requireSameOrigin } from '../../_lib/session.js';

// The body is optional: a plain sign out sends none, and anything that is not a JSON object with
// all:true is a plain sign out.
async function wantsAll(request) {
  const bytes = await readBodyBytes(request, 1024);
  if (bytes.length === 0) return false;
  try {
    const body = JSON.parse(utf8Decode(bytes));
    return body !== null && typeof body === 'object' && body.all === true;
  } catch {
    return false;
  }
}

export async function onRequestPost({ request, env }) {
  requireSameOrigin(request);
  await atRest(env);
  if (await wantsAll(request)) {
    const auth = await requireAuth(env, request);
    const res = await env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(auth.row.id).run();
    return clearedJson(request, { ok: true, ended: res.meta ? res.meta.changes : 0 });
  }
  const token = readSessionToken(request);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).run();
  }
  return clearedJson(request, { ok: true });
}

export const onRequest = onlyMethods('POST');
