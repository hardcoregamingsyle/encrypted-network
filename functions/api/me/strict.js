// POST /api/me/strict  body { enabled:boolean [, after:docId] [, confirmThrough:docId] }
//
//   enabled:false  Back to Easy mode. The flag changes and any password still waiting to be handed over is
//                  removed. The client then registers a new key with a server copy.
//   enabled:true   Strict mode: the account's key copy is removed from the server and no new password can be
//                  stored. The passwords that are stored are handed over in pages of 100, in docId order:
//                    { strict:true, passwords:[{ docId, password }], next:<docId>|null [, unreadable] }
//                  next is the docId to send as `after` for the following page (null at the end). Nothing is
//                  deleted by handing a page over, so an answer that never arrived costs nothing: ask again
//                  (the same pages come back).
//   enabled:true, confirmThrough:<docId>
//                  The client has stored every password up to and including that docId: they are deleted
//                  from the server. Only what is named is deleted, so a client that got one page can not
//                  lose the next ones. Answer { strict:true, passwords:[], remaining:<n> }.
//
// Passwords that are not confirmed are deleted by the server 24 hours after the switch (the next time
// the account is looked at), so a client that never confirms does not leave them behind for ever. Until
// then they can only be had through this endpoint: GET /api/me/secrets/:docId does not serve them.
// Every call needs a session made in the last 15 minutes (401 reauth_required otherwise).
import { utf8Decode } from '../../../shared/encoding.js';
import { isDocId } from '../../../shared/records.js';
import { authJson, purgeOldHandover } from '../../_lib/accounts.js';
import { atRest } from '../../_lib/atRest.js';
import { badRequest } from '../../_lib/errors.js';
import { onlyMethods, readJson } from '../../_lib/http.js';
import { requireAuth, requireFresh, requireSameOrigin } from '../../_lib/session.js';

const PAGE = 100;

function docIdField(body, name) {
  const v = body[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !isDocId(v)) throw badRequest(`${name} must be 32 lowercase hex characters`);
  return v;
}

export async function onRequestPost({ request, env }) {
  requireSameOrigin(request);
  const ar = await atRest(env);
  const auth = await requireAuth(env, request);
  const body = await readJson(request);
  if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be true or false');
  const after = docIdField(body, 'after');
  const through = docIdField(body, 'confirmThrough');
  const id = auth.row.id;

  // Both ways are a decision about who holds the keys: a stolen old session must not make it.
  requireFresh(auth);

  if (!body.enabled) {
    // Passwords still waiting from the switch to Strict go. An account that is in Easy mode already keeps
    // its stored passwords: the delete only runs when the account is in Strict mode (and comes first).
    await env.DB.batch([
      env.DB.prepare('DELETE FROM account_secrets WHERE account_id = ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND strict = 1)').bind(id, id),
      env.DB.prepare('UPDATE accounts SET strict = 0 WHERE id = ?').bind(id)
    ]);
    return authJson(auth, { strict: false, passwords: [] });
  }

  // One step: the passwords get the time of the switch (the 24 hours run from here), the flag flips, the
  // key copy goes. Only the call that really flips marks the passwords. A later call changes nothing
  // here (the key copy is removed again in case an earlier call stopped halfway).
  await env.DB.batch([
    env.DB.prepare('UPDATE account_secrets SET created_at = ? WHERE account_id = ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND strict = 0)').bind(auth.now, id, id),
    env.DB.prepare('UPDATE accounts SET strict = 1 WHERE id = ? AND strict = 0').bind(id),
    env.DB.prepare('UPDATE account_keys SET wrapped_private = NULL WHERE account_id = ? AND wrapped_private IS NOT NULL').bind(id)
  ]);
  await purgeOldHandover(env, id, auth.now);

  if (through !== undefined) {
    await env.DB.prepare('DELETE FROM account_secrets WHERE account_id = ? AND doc_id <= ?').bind(id, through).run();
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM account_secrets WHERE account_id = ?').bind(id).first();
    return authJson(auth, { strict: true, passwords: [], next: null, remaining: left ? left.n : 0 });
  }

  const { results } = await env.DB.prepare('SELECT doc_id, wrapped FROM account_secrets WHERE account_id = ? AND doc_id > ? ORDER BY doc_id ASC LIMIT ?')
    .bind(id, after === undefined ? '' : after, PAGE + 1)
    .all();
  const page = results.slice(0, PAGE);
  const passwords = [];
  let unreadable = 0;
  for (const r of page) {
    try {
      passwords.push({ docId: r.doc_id, password: utf8Decode(await ar.unwrap(r.wrapped, 'secret', id, r.doc_id)) });
    } catch {
      unreadable++;
    }
  }
  const next = results.length > PAGE ? page[page.length - 1].doc_id : null;
  const answer = { strict: true, passwords, next };
  if (unreadable > 0) answer.unreadable = unreadable;
  return authJson(auth, answer);
}

export const onRequest = onlyMethods('POST');
