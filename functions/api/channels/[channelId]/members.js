// POST /api/channels/:channelId/members   body { members: [email, ...] }   add people to a private chat.
// Any member can add people. Each address must belong to an account here.
import { isChannelId } from '../../../../shared/records.js';
import { authJson } from '../../../_lib/accounts.js';
import { MAX_MEMBERS, accountIdsFor, requireMember } from '../../../_lib/channels.js';
import { ApiError, badRequest } from '../../../_lib/errors.js';
import { onlyMethods, readJson } from '../../../_lib/http.js';
import { consumeRate } from '../../../_lib/rate.js';
import { requireSameOrigin } from '../../../_lib/session.js';

export async function onRequestPost({ request, env, params }) {
  requireSameOrigin(request);
  const id = params.channelId;
  if (typeof id !== 'string' || !isChannelId(id)) throw badRequest('channelId is not valid');
  const body = await readJson(request);
  if (!Array.isArray(body.members) || body.members.length < 1 || body.members.length >= MAX_MEMBERS) {
    throw badRequest(`give 1 to ${MAX_MEMBERS - 1} email addresses`);
  }
  const auth = await requireMember(env, request, id);
  await consumeRate(env, 'channel', auth.row.id, auth.now);
  const ids = await accountIdsFor(env, body.members);
  const have = await env.DB.prepare('SELECT account_id FROM channel_members WHERE channel_id = ?').bind(id).all();
  const known = new Set(have.results.map((r) => r.account_id));
  const fresh = ids.filter((a) => !known.has(a));
  if (known.size + fresh.length > MAX_MEMBERS) throw new ApiError('conflict', `a chat holds at most ${MAX_MEMBERS} people`);
  if (fresh.length) {
    await env.DB.batch(fresh.map((a) => env.DB.prepare('INSERT OR IGNORE INTO channel_members (channel_id, account_id) VALUES (?, ?)').bind(id, a)));
  }
  return authJson(auth, { ok: true, added: fresh.length });
}

export const onRequest = onlyMethods('POST');
