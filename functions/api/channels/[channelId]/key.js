// GET /api/channels/:channelId/key   the group password of a private chat, for its members only.
// Nobody picks or sees it as text: it is made when the chat is created and kept sealed on the server. The
// browser of a member uses it to lock and unlock the messages.
import { bytesToBase64Url } from '../../../../shared/encoding.js';
import { isChannelId } from '../../../../shared/records.js';
import { authJson } from '../../../_lib/accounts.js';
import { atRest } from '../../../_lib/atRest.js';
import { requireMember } from '../../../_lib/channels.js';
import { ApiError, badRequest } from '../../../_lib/errors.js';
import { onlyMethods } from '../../../_lib/http.js';

export async function onRequestGet({ request, env, params }) {
  const id = params.channelId;
  if (typeof id !== 'string' || !isChannelId(id)) throw badRequest('channelId is not valid');
  const auth = await requireMember(env, request, id);
  const row = await env.DB.prepare('SELECT sealed FROM channels WHERE channel_id = ?').bind(id).first();
  if (!row || !row.sealed) throw new ApiError('not_found', 'this chat has no group password');
  try {
    const key = await (await atRest(env)).unwrap(row.sealed, 'chat', id, 'key');
    return authJson(auth, { key: bytesToBase64Url(key) }, 200, { 'Cache-Control': 'no-store' });
  } catch {
    console.error('a group password could not be opened');
    throw new ApiError('server_error', 'server error');
  }
}

export const onRequest = onlyMethods('GET');
