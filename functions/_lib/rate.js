// Fixed window rate limits stored in D1 (table rate_limits).
import { LIMITS } from '../../shared/records.js';
import { ApiError } from './errors.js';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;

// Start of the fixed window that contains `now`.
export function windowStart(now, windowMs) {
  return Math.floor(now / windowMs) * windowMs;
}

// Whole seconds until the current window ends (at least 1).
export function retryAfterSeconds(now, windowMs) {
  return Math.max(1, Math.ceil((windowStart(now, windowMs) + windowMs - now) / 1000));
}

// Named limits: bucket prefix, window length and maximum count.
export const RATES = Object.freeze({
  identity: { prefix: 'ident-ip', windowMs: HOUR, max: LIMITS.RATE.IDENTITY_PER_HOUR_PER_IP, what: 'identities created from this address' },
  message: { prefix: 'msg', windowMs: MINUTE, max: LIMITS.RATE.MESSAGES_PER_MINUTE_PER_SIGNER, what: 'messages' },
  docRecord: { prefix: 'doc', windowMs: HOUR, max: LIMITS.RATE.DOC_RECORDS_PER_HOUR_PER_SIGNER, what: 'document records' },
  channel: { prefix: 'chan', windowMs: HOUR, max: LIMITS.RATE.CHANNELS_PER_HOUR_PER_SIGNER, what: 'channels' },
  blob: { prefix: 'blob', windowMs: HOUR, max: LIMITS.RATE.BLOB_PUTS_PER_HOUR_PER_SIGNER, what: 'file uploads' }
});

const CLEAN_EVERY = 50; // about one request in 50 also removes old windows
const KEEP_MS = 2 * 24 * HOUR;

// Counts one use of the named limit for `who`. Throws 429 when over the limit.
export async function consumeRate(env, name, who, now = Date.now()) {
  const rate = RATES[name];
  if (!rate) throw new Error('unknown rate limit ' + name);
  const bucket = `${rate.prefix}:${who}`;
  const win = windowStart(now, rate.windowMs);
  const row = await env.DB.prepare(
    'INSERT INTO rate_limits (bucket, "window", count) VALUES (?, ?, 1) ' +
      'ON CONFLICT (bucket, "window") DO UPDATE SET count = count + 1 RETURNING count'
  )
    .bind(bucket, win)
    .first();
  if (Math.random() * CLEAN_EVERY < 1) {
    try {
      await env.DB.prepare('DELETE FROM rate_limits WHERE "window" < ?').bind(now - KEEP_MS).run();
    } catch {
      // cleaning is best effort
    }
  }
  if (!row || row.count > rate.max) {
    throw new ApiError('rate_limited', `too many ${rate.what}, try again later`, {
      headers: { 'Retry-After': retryAfterSeconds(now, rate.windowMs) }
    });
  }
  return row.count;
}
