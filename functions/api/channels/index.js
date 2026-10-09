// GET /api/channels: list channels. POST /api/channels: create one (signed channel.create).
import { canonicalize } from '../../../shared/canonical.js';
import { LIMITS, validateRecord } from '../../../shared/records.js';
import { CHANNEL_SELECT, channelFromRow, loadChannel } from '../../_lib/channels.js';
import { ApiError, badRequest, isUniqueConflict } from '../../_lib/errors.js';
import { json, onlyMethods, readSignedBody } from '../../_lib/http.js';
import { requireSigner } from '../../_lib/identities.js';
import { consumeRate } from '../../_lib/rate.js';
import { assertFresh } from '../../_lib/time.js';

const MAX_CHANNELS = 200;

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(CHANNEL_SELECT + ' ORDER BY c.created_at DESC, c.channel_id ASC LIMIT ?')
    .bind(MAX_CHANNELS)
    .all();
  return json({ channels: results.map(channelFromRow) });
}

export async function onRequestPost({ request, env }) {
  const { record, signature } = await readSignedBody(request);
  const valid = validateRecord(record);
  if (!valid.ok) throw badRequest(valid.error);
  if (record.type !== 'channel.create') throw badRequest('record type must be channel.create');

  const now = Date.now();
  assertFresh(record.createdAt, LIMITS.RECORD_TIME_WINDOW_MS, now);
  await requireSigner(env, record, signature);
  await consumeRate(env, 'channel', record.signer, now);

  const taken = new ApiError('exists', 'a channel with this id already exists');
  if (await env.DB.prepare('SELECT 1 AS x FROM channels WHERE channel_id = ?').bind(record.channelId).first()) throw taken;
  try {
    await env.DB.prepare(
      'INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, record, signature) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(record.channelId, record.title, record.docId, record.signer, record.createdAt, canonicalize(record), signature)
      .run();
  } catch (err) {
    if (isUniqueConflict(err)) throw taken;
    throw err;
  }
  return json({ channel: await loadChannel(env, record.channelId) }, 201);
}

export const onRequest = onlyMethods('GET', 'POST');
