// GET  /api/channels/:channelId/messages  read the chain (after=<seq>, limit, tail)
// POST /api/channels/:channelId/messages  post a signed message
import { LIMITS, isChannelId, validateRecord } from '../../../../shared/records.js';
import { appendMessage, channelFromRow, CHANNEL_SELECT, loadChannel, messageFromRow, requireChannel } from '../../../_lib/channels.js';
import { badRequest } from '../../../_lib/errors.js';
import { intParam, json, onlyMethods, readSignedBody } from '../../../_lib/http.js';
import { identityMapFromRows, requireSigner } from '../../../_lib/identities.js';
import { consumeRate } from '../../../_lib/rate.js';
import { loadServerKey, serverInfo, signScope } from '../../../_lib/serverKey.js';
import { ZERO_HASH } from '../../../../shared/encoding.js';
import { assertFresh } from '../../../_lib/time.js';

function channelParam(params) {
  const id = params.channelId;
  if (typeof id !== 'string' || !isChannelId(id)) throw badRequest('channelId is not valid');
  return id;
}

const MESSAGE_COLUMNS = 'SELECT hash, seq, prev_chain_hash, chain_hash, body, signature FROM messages';

export async function onRequestGet({ request, env, params }) {
  const channelId = channelParam(params);
  const url = new URL(request.url);
  const after = intParam(url, 'after', { min: 0, max: Number.MAX_SAFE_INTEGER, def: 0 });
  const limit = intParam(url, 'limit', { min: 1, max: 100, def: 50 });
  const tail = intParam(url, 'tail', { min: 1, max: 100, def: null });

  // One batch so the page, the channel info and the checkpoint agree with each other.
  const messageQuery =
    tail !== null
      ? env.DB.prepare(MESSAGE_COLUMNS + ' WHERE channel_id = ? ORDER BY seq DESC LIMIT ?').bind(channelId, tail)
      : env.DB.prepare(MESSAGE_COLUMNS + ' WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').bind(channelId, after, limit + 1);
  const [chanRes, msgRes, lastRes] = await env.DB.batch([
    env.DB.prepare(CHANNEL_SELECT + ' WHERE c.channel_id = ?').bind(channelId),
    messageQuery,
    env.DB.prepare('SELECT seq, chain_hash FROM messages WHERE channel_id = ? ORDER BY seq DESC LIMIT 1').bind(channelId)
  ]);
  requireChannel(chanRes.results[0]);

  let rows = msgRes.results;
  let hasMore = false;
  if (tail !== null) {
    rows = rows.slice().reverse();
  } else if (rows.length > limit) {
    hasMore = true;
    rows = rows.slice(0, limit);
  }
  const messages = rows.map(messageFromRow);

  let identities = {};
  if (messages.length > 0) {
    const idRes = await env.DB.prepare(
      'SELECT * FROM identities WHERE key_id IN (SELECT DISTINCT signer FROM messages WHERE channel_id = ? AND seq >= ? AND seq <= ?)'
    )
      .bind(channelId, messages[0].seq, messages[messages.length - 1].seq)
      .all();
    identities = identityMapFromRows(idRes.results);
  }

  const last = lastRes.results[0];
  const key = await loadServerKey(env);
  return json({
    channel: channelFromRow(chanRes.results[0]),
    messages,
    identities,
    checkpoint: await signScope(key, {
      scope: 'channel:' + channelId,
      seq: last ? last.seq : 0,
      hash: last ? last.chain_hash : ZERO_HASH
    }),
    server: serverInfo(key),
    hasMore
  });
}

export async function onRequestPost({ request, env, params }) {
  const channelId = channelParam(params);
  const { record, signature } = await readSignedBody(request);
  const valid = validateRecord(record);
  if (!valid.ok) throw badRequest(valid.error);
  if (record.type !== 'message') throw badRequest('record type must be message');
  if (record.channelId !== channelId) throw badRequest('record.channelId does not match the address');
  requireChannel(await loadChannel(env, channelId));

  const now = Date.now();
  assertFresh(record.createdAt, LIMITS.RECORD_TIME_WINDOW_MS, now);
  await requireSigner(env, record, signature);
  await consumeRate(env, 'message', record.signer, now);

  return json(await appendMessage(env, record, signature), 201);
}

export const onRequest = onlyMethods('GET', 'POST');
