// Channel and message logic.
import { canonicalize } from '../../shared/canonical.js';
import { ZERO_HASH } from '../../shared/encoding.js';
import { chainHash, recordHash } from '../../shared/records.js';
import { ApiError, isUniqueConflict, notFound } from './errors.js';
import { backoff, withLock } from './lock.js';

export const CHANNEL_SELECT =
  'SELECT c.channel_id, c.title, c.doc_id, c.created_by, c.created_at, i.display_name AS created_by_name, ' +
  '(SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.channel_id) AS message_count, ' +
  '(SELECT m2.created_at FROM messages m2 WHERE m2.channel_id = c.channel_id ORDER BY m2.seq DESC LIMIT 1) AS last_message_at ' +
  'FROM channels c LEFT JOIN identities i ON i.key_id = c.created_by';

export function channelFromRow(r) {
  return {
    channelId: r.channel_id,
    title: r.title,
    docId: r.doc_id,
    createdBy: r.created_by,
    createdByName: r.created_by_name || '',
    createdAt: r.created_at,
    messageCount: r.message_count,
    lastMessageAt: r.last_message_at === undefined ? null : r.last_message_at
  };
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
export async function appendMessage(env, record, signature) {
  const hash = await recordHash(record);
  const body = canonicalize(record);
  return withLock('chan:' + record.channelId, async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
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
        await env.DB.prepare(
          'INSERT INTO messages (hash, channel_id, seq, signer, body, signature, prev_chain_hash, chain_hash, created_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
          .bind(hash, record.channelId, seq, record.signer, body, signature, prevChainHash, newChain, record.createdAt)
          .run();
      } catch (err) {
        if (!isUniqueConflict(err)) throw err;
        await backoff(attempt);
        continue;
      }
      return { seq, hash, prevChainHash, chainHash: newChain };
    }
    throw new ApiError('conflict', 'the channel is busy, try again');
  });
}

export function requireChannel(channel) {
  if (!channel) throw notFound('channel not found');
  return channel;
}
