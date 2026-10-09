// GET /api/channels: list channels, newest first by the time the server received them.
//   ?limit=<1..200 default 200>&before=<receivedAt>&beforeId=<channelId> pages on. The answer has
//   next: { before, beforeId } | null, the cursor for the following page.
// POST /api/channels: create one (signed channel.create).
import { canonicalize } from '../../../shared/canonical.js';
import { LIMITS, isChannelId, validateRecord } from '../../../shared/records.js';
import { CHANNEL_SELECT, channelFromRow, loadChannel } from '../../_lib/channels.js';
import { ApiError, badRequest, isUniqueConflict } from '../../_lib/errors.js';
import { headOf, intParam, json, onlyMethods, readSignedBody } from '../../_lib/http.js';
import { requireSigner } from '../../_lib/identities.js';
import { consumeRate } from '../../_lib/rate.js';
import { assertFresh } from '../../_lib/time.js';

const MAX_CHANNELS = 200;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const limit = intParam(url, 'limit', { min: 1, max: MAX_CHANNELS, def: MAX_CHANNELS });
  const before = intParam(url, 'before', { min: 0, max: Number.MAX_SAFE_INTEGER, def: null });
  const beforeId = url.searchParams.get('beforeId');
  if (beforeId !== null && beforeId !== '' && !isChannelId(beforeId)) throw badRequest('beforeId is not a channel id');

  // The cursor is the pair (received_at, channel_id), so channels received in the same millisecond
  // are never skipped. Without beforeId only earlier times are returned.
  let where = '';
  const args = [];
  if (before !== null) {
    if (beforeId) {
      where = ' WHERE (c.received_at < ? OR (c.received_at = ? AND c.channel_id < ?))';
      args.push(before, before, beforeId);
    } else {
      where = ' WHERE c.received_at < ?';
      args.push(before);
    }
  }
  args.push(limit + 1);
  const { results } = await env.DB.prepare(CHANNEL_SELECT + where + ' ORDER BY c.received_at DESC, c.channel_id DESC LIMIT ?')
    .bind(...args)
    .all();
  const more = results.length > limit;
  const rows = more ? results.slice(0, limit) : results;
  const last = rows[rows.length - 1];
  return json({
    channels: rows.map(channelFromRow),
    next: more ? { before: last.received_at, beforeId: last.channel_id } : null
  });
}

export const onRequestHead = headOf(onRequestGet);

export async function onRequestPost({ request, env }) {
  const { record, signature } = await readSignedBody(request);
  const valid = validateRecord(record);
  if (!valid.ok) throw badRequest(valid.error);
  if (record.type !== 'channel.create') throw badRequest('record type must be channel.create');

  const now = Date.now();
  assertFresh(record.createdAt, LIMITS.RECORD_TIME_WINDOW_MS, now);
  await requireSigner(env, record, signature);
  await consumeRate(env, 'channel', record.signer, now);

  // A channel may name a document, but only one that exists (otherwise the link is just made up).
  if (record.docId !== '') {
    const doc = await env.DB.prepare('SELECT 1 AS x FROM documents WHERE doc_id = ?').bind(record.docId).first();
    if (!doc) throw badRequest('docId is not a known document');
  }

  const taken = new ApiError('exists', 'a channel with this id already exists');
  if (await env.DB.prepare('SELECT 1 AS x FROM channels WHERE channel_id = ?').bind(record.channelId).first()) throw taken;
  try {
    await env.DB.prepare(
      'INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, received_at, record, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(record.channelId, record.title, record.docId, record.signer, record.createdAt, now, canonicalize(record), signature)
      .run();
  } catch (err) {
    if (isUniqueConflict(err)) throw taken;
    throw err;
  }
  return json({ channel: await loadChannel(env, record.channelId) }, 201);
}

export const onRequest = onlyMethods('GET', 'POST');
