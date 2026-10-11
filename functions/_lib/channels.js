// Channel and message logic.
import { canonicalize } from '../../shared/canonical.js';
import { ZERO_HASH } from '../../shared/encoding.js';
import { chainHash, recordHash } from '../../shared/records.js';
import { ApiError, busy, isUniqueConflict, notFound } from './errors.js';
import { RETRY_BUDGET_MS, backoff, canRetry, withLock } from './lock.js';

// message_count, last_message_at, last_text and last_signer_name are stored on the channel row and
// updated in the same batch that adds a message, so reading a channel never counts its messages.
// doc_owner is the owner of the document the channel names (empty when the channel names none, or
// none that exists).
export const CHANNEL_SELECT =
  'SELECT c.channel_id, c.title, c.doc_id, c.created_by, c.created_at, c.received_at, i.display_name AS created_by_name, ' +
  'c.message_count, c.last_message_at, c.last_text, c.last_signer_name, d.owner_key_id AS doc_owner ' +
  'FROM channels c LEFT JOIN identities i ON i.key_id = c.created_by LEFT JOIN documents d ON d.doc_id = c.doc_id';

export function channelFromRow(r) {
  return {
    channelId: r.channel_id,
    title: r.title,
    docId: r.doc_id,
    docOwnerKeyId: r.doc_owner || '',
    createdBy: r.created_by,
    createdByName: r.created_by_name || '',
    createdAt: r.created_at,
    messageCount: r.message_count || 0,
    lastMessageAt: r.last_message_at === undefined || r.last_message_at === null ? null : r.last_message_at,
    lastText: r.last_text || '',
    lastSignerName: r.last_signer_name || ''
  };
}

export const PREVIEW_CHARS = 140;

// The chat list preview of a message: the body on one line, cut to 140 characters (not UTF-16 units).
export function previewText(body) {
  const oneLine = String(body).replace(/\s+/g, ' ').trim();
  return Array.from(oneLine).slice(0, PREVIEW_CHARS).join('');
}

export function messageFromRow(r) {
  return {
    seq: r.seq,
    hash: r.hash,
    prevChainHash: r.prev_chain_hash,
    chainHash: r.chain_hash,
    record: JSON.parse(r.body),
    signature: r.signature
  };
}

export async function loadChannel(env, channelId) {
  const row = await env.DB.prepare(CHANNEL_SELECT + ' WHERE c.channel_id = ?').bind(channelId).first();
  return row ? channelFromRow(row) : null;
}

// Adds one message to the channel chain. replyTo (if set) must be a message of the same channel.
export async function appendMessage(env, record, signature, { budgetMs = RETRY_BUDGET_MS } = {}) {
  const hash = await recordHash(record);
  const body = canonicalize(record);
  return withLock('chan:' + record.channelId, async () => {
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      if (await env.DB.prepare('SELECT 1 AS x FROM messages WHERE hash = ?').bind(hash).first()) {
        throw new ApiError('exists', 'this message was already posted');
      }
      if (record.replyTo !== '') {
        const target = await env.DB.prepare('SELECT 1 AS x FROM messages WHERE hash = ? AND channel_id = ?')
          .bind(record.replyTo, record.channelId)
          .first();
        if (!target) throw new ApiError('bad_request', 'replyTo is not a message of this channel');
      }
      const last = await env.DB.prepare(
        'SELECT seq, chain_hash FROM messages WHERE channel_id = ? ORDER BY seq DESC LIMIT 1'
      )
        .bind(record.channelId)
        .first();
      const seq = last ? last.seq + 1 : 1;
      const prevChainHash = last ? last.chain_hash : ZERO_HASH;
      const newChain = await chainHash(prevChainHash, hash);
      try {
        // One batch: the message and the channel counters change together or not at all.
        await env.DB.batch([
          env.DB.prepare(
            'INSERT INTO messages (hash, channel_id, seq, signer, body, signature, prev_chain_hash, chain_hash, created_at) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(hash, record.channelId, seq, record.signer, body, signature, prevChainHash, newChain, record.createdAt),
          env.DB.prepare(
            'UPDATE channels SET message_count = message_count + 1, last_message_at = ?, last_text = ?, ' +
              "last_signer_name = COALESCE((SELECT display_name FROM identities WHERE key_id = ?), '') WHERE channel_id = ?"
          ).bind(record.createdAt, previewText(record.body), record.signer, record.channelId)
        ]);
      } catch (err) {
        if (!isUniqueConflict(err)) throw err;
        if (!canRetry(startedAt, budgetMs)) throw busy('the channel is busy, try again');
        await backoff(attempt);
        continue;
      }
      return { seq, hash, prevChainHash, chainHash: newChain };
    }
  });
}

export function requireChannel(channel) {
  if (!channel) throw notFound('channel not found');
  return channel;
}
