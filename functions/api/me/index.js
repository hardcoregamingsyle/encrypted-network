// GET    /api/me  the signed in account and its keys
// DELETE /api/me  delete the account: private files, sessions, codes, key links, stored keys and passwords, and the rate
//                 limit counts kept under the hash of the email. Needs a session made in the last 15 minutes
//                 (sign in again with a new code first, otherwise 401 reauth_required).
// Public identities and the ledger stay: they are signed history. A key that was linked to the account
// can be linked to a new account later by sending its private key again (see POST /api/me/key).
import { accountKeyRows, authJson, clearedJson, purgeOldHandover } from '../../_lib/accounts.js';
import { atRest } from '../../_lib/atRest.js';
import { ApiError } from '../../_lib/errors.js';
import { onlyMethods } from '../../_lib/http.js';
import { forgetRate } from '../../_lib/rate.js';
import { accountFromRow, requireAuth, requireFresh, requireSameOrigin } from '../../_lib/session.js';
import { blobStore } from '../../_lib/store.js';

export async function onRequestGet({ request, env }) {
  await atRest(env);
  const auth = await requireAuth(env, request);
  if (auth.row.strict === 1) await purgeOldHandover(env, auth.row.id, auth.now);
  const keys = await accountKeyRows(env, auth.row.id);
  return authJson(
    auth,
    { account: accountFromRow(auth.row), keys: keys.map((k) => ({ keyId: k.key_id, hasCloudCopy: k.wrapped_private !== null })) },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

export async function onRequestDelete({ request, env }) {
  requireSameOrigin(request);
  await atRest(env);
  const auth = await requireAuth(env, request);
  requireFresh(auth);
  const id = auth.row.id;
  const hash = auth.row.email_hash;
  // Private files go first, 40 at a time (a request may only make about 50 storage calls). With more left
  // the answer is 409 and the same request is sent again.
  const files = (await env.DB.prepare('SELECT id FROM private_files WHERE account_id = ? LIMIT 41').bind(id).all()).results;
  const some = files.slice(0, 40);
  for (const f of some) await blobStore(env).delete('private/' + f.id);
  if (files.length > 40) {
    await env.DB.prepare(`DELETE FROM private_files WHERE id IN (${some.map(() => '?').join(',')})`).bind(...some.map((f) => f.id)).run();
    throw new ApiError('conflict', 'your private files are still being removed, delete again to finish');
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE documents SET viewable = 0 WHERE owner_key_id IN (SELECT key_id FROM account_keys WHERE account_id = ?)").bind(id),
    env.DB.prepare('DELETE FROM private_files WHERE account_id = ?').bind(id),
    env.DB.prepare('DELETE FROM channel_members WHERE account_id = ?').bind(id),
    env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(id),
    env.DB.prepare('DELETE FROM otp_codes WHERE email_hash = ?').bind(hash),
    env.DB.prepare('DELETE FROM account_secrets WHERE account_id = ?').bind(id),
    env.DB.prepare('DELETE FROM account_keys WHERE account_id = ?').bind(id),
    env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id),
    // The hash of the email is the stored name of the person: the counts kept under it go as well. (The
    // count of the mail quota is kept under the hash of the canonical inbox. For an address without a plus
    // part or gmail dots that is the same hash. For an alias it is another hash that expires with the hour.)
    forgetRate(env, 'codeEmail', hash),
    forgetRate(env, 'vfyAddr', hash),
    forgetRate(env, 'vfySrc', hash)
  ]);
  return clearedJson(request, { ok: true });
}

export const onRequest = onlyMethods('GET', 'DELETE');
