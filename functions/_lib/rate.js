// Fixed window rate limits stored in D1 (table rate_limits).
import { LIMITS } from '../../shared/records.js';
import { ApiError } from './errors.js';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

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
  // One bucket for the whole service. Every other limit is per identity and identities are free, so this
  // is the ceiling on how fast new ones can appear. It is checked after the per address limit.
  identityAll: { prefix: 'ident-all', windowMs: HOUR, max: 500, what: 'identities created on this service' },
  message: { prefix: 'msg', windowMs: MINUTE, max: LIMITS.RATE.MESSAGES_PER_MINUTE_PER_SIGNER, what: 'messages' },
  docRecord: { prefix: 'doc', windowMs: HOUR, max: LIMITS.RATE.DOC_RECORDS_PER_HOUR_PER_SIGNER, what: 'document records' },
  channel: { prefix: 'chan', windowMs: HOUR, max: LIMITS.RATE.CHANNELS_PER_HOUR_PER_SIGNER, what: 'channels' },
  blob: { prefix: 'blob', windowMs: HOUR, max: LIMITS.RATE.BLOB_PUTS_PER_HOUR_PER_SIGNER, what: 'file uploads' },
  // Sign in codes. codeIp and codeNet count every request from a source (a request that sends nothing is
  // still work for the server). codeEmail, codeAll, codeDay and codeSent count MAILS THAT WERE SENT: they are
  // taken just before the mail goes out and given back when it could not be stored or sent. codeEmail is
  // keyed by the canonical inbox (see functions/_lib/email.js) and slides over two windows, so a window
  // edge does not double the rate. codeAll and codeDay are the service wide ceilings (the operator can set
  // them with MAIL_CAP_HOUR and MAIL_CAP_DAY); see functions/api/auth/request.js for how a share of them
  // is kept for sources that have sent little.
  codeIp: { prefix: 'code-ip', windowMs: HOUR, max: 20, what: 'sign in codes requested from this address' },
  codeNet: { prefix: 'code-net', windowMs: HOUR, max: 60, what: 'sign in codes requested from this network' },
  codeAll: { prefix: 'code-all', windowMs: HOUR, max: 400, what: 'sign in codes requested on this service' },
  codeDay: { prefix: 'code-day', windowMs: DAY, max: 2000, what: 'sign in codes requested on this service today' },
  codeSent: { prefix: 'code-sent', windowMs: HOUR, max: Number.MAX_SAFE_INTEGER, what: 'sign in codes sent' },
  codeEmail: { prefix: 'code-mail', windowMs: HOUR, max: 5, sliding: true, what: 'sign in codes requested for this email' },
  // Code checks per address. Five wrong tries from one source for one email (vfySrc) and 25 wrong tries
  // in an hour for one email from all sources together (vfyAddr). A wrong try is counted before the code
  // is looked at and given back when the code was right or there was no live code.
  vfySrc: { prefix: 'vfy-src', windowMs: HOUR, max: 5, what: 'wrong codes typed from this address' },
  vfyAddr: { prefix: 'vfy-bad', windowMs: HOUR, max: 25, sliding: true, what: 'wrong codes typed for this email' },
  verifyIp: { prefix: 'vfy-ip', windowMs: 10 * MINUTE, max: 10, what: 'code checks from this address' },
  keyRegister: { prefix: 'key-reg', windowMs: HOUR, max: 10, what: 'key registrations for this account' }
});

const CLEAN_EVERY = 50; // about one request in 50 also removes old windows
const KEEP_MS = 2 * 24 * HOUR;

// Counts one use of the named limit for `who`. Throws 429 when over the limit.
//   opts.max          a limit to use instead of the one in RATES (the operator can set the service ceilings)
//   opts.undoOnDeny   when the answer is "over the limit", the count this call added is taken off again, so
//                     refused requests do not use up the allowance (the default keeps counting, which is
//                     harmless for a fixed window that is already over its limit)
// A limit marked sliding also counts the part of the previous window that still lies inside the last
// `windowMs`, so the rate can not double at a window edge. Returns the count of the current window.
export async function consumeRate(env, name, who, now = Date.now(), opts = {}) {
  const rate = RATES[name];
  if (!rate) throw new Error('unknown rate limit ' + name);
  const max = opts.max === undefined ? rate.max : opts.max;
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
  let effective = row ? row.count : Infinity;
  if (row && rate.sliding && row.count <= max) {
    const before = await env.DB.prepare('SELECT count FROM rate_limits WHERE bucket = ? AND "window" = ?')
      .bind(bucket, win - rate.windowMs)
      .first();
    if (before) effective += Math.ceil(before.count * ((win + rate.windowMs - now) / rate.windowMs) - 1e-9);
  }
  if (!row || effective > max) {
    if (row && opts.undoOnDeny) {
      try {
        await refundRate(env, name, who, now);
      } catch {
        // the count stays one too high until the window ends
      }
    }
    throw new ApiError('rate_limited', `too many ${rate.what}, try again later`, {
      headers: { 'Retry-After': retryAfterSeconds(now, rate.windowMs) }
    });
  }
  return row.count;
}

// Takes one use of the named limit back (never below zero). Used when the work a count was taken for
// did not happen. Best effort for the caller: it may throw, callers decide whether that matters.
export async function refundRate(env, name, who, now = Date.now()) {
  const rate = RATES[name];
  if (!rate) throw new Error('unknown rate limit ' + name);
  await env.DB.prepare('UPDATE rate_limits SET count = MAX(count - 1, 0) WHERE bucket = ? AND "window" = ?')
    .bind(`${rate.prefix}:${who}`, windowStart(now, rate.windowMs))
    .run();
}

// The statement that removes every count of a bucket prefix and a key, all windows, for a batch (account
// deletion). Buckets that hold a further part after the key (`<key>:<more>`) go too.
export function forgetRate(env, name, who) {
  const rate = RATES[name];
  if (!rate) throw new Error('unknown rate limit ' + name);
  const base = `${rate.prefix}:${who}`;
  // ':' is followed by ';' in ASCII, so [base, base';') covers base and base + ':' + anything.
  return env.DB.prepare('DELETE FROM rate_limits WHERE bucket = ? OR (bucket >= ? AND bucket < ?)').bind(base, base + ':', base + ';');
}

// A service ceiling the operator may set with an environment value: a whole number from 1 to 1000000,
// anything else (missing, text, zero, negative) falls back to the built in number.
export function ceilingFrom(env, variable, fallback) {
  const raw = env ? env[variable] : undefined;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]{1,7}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 1000000 ? n : fallback;
}
