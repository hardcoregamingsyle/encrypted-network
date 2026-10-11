// GET /api/channels: list channels, newest first by the time the server received them.
//   ?limit=<1..200 default 200>&before=<receivedAt>&beforeId=<channelId> pages on. The answer has
//   next: { before, beforeId } | null, the cursor for the following page.
// POST /api/channels: create one (signed channel.create). With members: [email, ...] it is a private chat: only those
//   accounts and the creator can read or write, and a group password is made and kept sealed on the server.
// The list shows the public chats and the private chats of the signed in account.
import { canonicalize } from '../../../shared/canonical.js';
import { LIMITS, isChannelId, validateRecord } from '../../../shared/records.js';
import { authJson } from '../../_lib/accounts.js';
import { atRest } from '../../_lib/atRest.js';
import { CHANNEL_SELECT, MAX_MEMBERS, accountIdsFor, channelFromRow, loadChannel, requireOwnKey } from '../../_lib/channels.js';
import { ApiError, badRequest, isUniqueConflict } from '../../_lib/errors.js';
import { headOf, intParam, json, onlyMethods, readSignedBody } from '../../_lib/http.js';
import { requireSigner } from '../../_lib/identities.js';
import { consumeRate } from '../../_lib/rate.js';
import { requireAuth, requireSameOrigin } from '../../_lib/session.js';
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
  const mine = await requireAuth(env, request).then((a) => a.row.id, () => '');
  let where = ' WHERE (c.sealed IS NULL OR c.channel_id IN (SELECT channel_id FROM channel_members WHERE account_id = ?))';
  const args = [mine];
  if (before !== null) {
    if (beforeId) {
      where += ' AND (c.received_at < ? OR (c.received_at = ? AND c.channel_id < ?))';
      args.push(before, before, beforeId);
    } else {
      where += ' AND c.received_at < ?';
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
  const { record, signature, body } = await readSignedBody(request);
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

  // A private chat: the members are given by email, the group password is made here and never shown to anyone.
  let auth = null;
  let sealed = null;
  const members = [];
  if (body.members !== undefined) {
    requireSameOrigin(request);
    if (!Array.isArray(body.members) || body.members.length < 1 || body.members.length >= MAX_MEMBERS) {
      throw badRequest(`a private chat needs 1 to ${MAX_MEMBERS - 1} other people, given by email`);
    }
    auth = await requireAuth(env, request);
    await requireOwnKey(env, auth, record.signer);
    members.push(auth.row.id, ...(await accountIdsFor(env, body.members)));
    sealed = await (await atRest(env)).wrap(globalThis.crypto.getRandomValues(new Uint8Array(32)), 'chat', record.channelId, 'key');
  }

  const taken = new ApiError('exists', 'a channel with this id already exists');
  if (await env.DB.prepare('SELECT 1 AS x FROM channels WHERE channel_id = ?').bind(record.channelId).first()) throw taken;
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, received_at, record, signature, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(record.channelId, record.title, record.docId, record.signer, record.createdAt, now, canonicalize(record), signature, sealed),
      ...[...new Set(members)].map((id) => env.DB.prepare('INSERT INTO channel_members (channel_id, account_id) VALUES (?, ?)').bind(record.channelId, id))
    ]);
  } catch (err) {
    if (isUniqueConflict(err)) throw taken;
    throw err;
  }
  const made = { channel: await loadChannel(env, record.channelId) };
  return auth ? authJson(auth, made, 201) : json(made, 201);
}

export const onRequest = onlyMethods('GET', 'POST');
