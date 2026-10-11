// One time sign in codes: 6 digits, valid for 10 minutes, single use, 5 wrong tries from one source.
// The code itself is never stored, only an HMAC of the email hash and the code. A code, an email
// and a hash never appear in a log or an error message.
import { timingSafeEqual, utf8Encode } from '../../shared/encoding.js';
import { ApiError } from './errors.js';
import { consumeRate, forgetRate, refundRate } from './rate.js';

export const OTP_DIGITS = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
// Wrong tries one source (see rateKeyForRequest) may make for one email in an hour. checkCode kills a code
// at this many tries when it is called without a limit of its own.
export const OTP_MAX_ATTEMPTS = 5;
// Wrong tries one code takes from all sources together before it is dead. The real limit is 25 wrong tries
// per email per hour (the vfyAddr limit in rate.js), this only stops one code from taking more.
export const OTP_MAX_ATTEMPTS_ALL = 25;
export const OTP_COOLDOWN_MS = 30 * 1000;

const SPACE = 10 ** OTP_DIGITS;
// The largest multiple of 10^6 that fits in 32 bits. A random 32 bit number at or above it is thrown
// away, so every code has exactly the same chance (no modulo bias).
const LIMIT = Math.floor(0x100000000 / SPACE) * SPACE;

// A uniformly random 6 digit code as text, leading zeros kept. random32 is for tests.
export function generateCode(random32 = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0]) {
  for (;;) {
    const n = random32();
    if (n < LIMIT) return String(n % SPACE).padStart(OTP_DIGITS, '0');
  }
}

// Compares two strings without stopping at the first difference.
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(utf8Encode(a), utf8Encode(b));
}

// A code as typed: digits only, spaces allowed (people type 123 456). Returns the 6 digits or null.
export function cleanCode(input) {
  if (typeof input !== 'string' || input.length > 32) return null;
  const t = input.replace(/\s+/g, '');
  return /^[0-9]{6}$/.test(t) ? t : null;
}

// Seconds left of the resend cooldown for an email hash, 0 when a new code may be sent. A code that is
// dead (used up its tries) does not hold the person back: they may ask for a new one at once.
export async function cooldownLeft(env, emailHash, now) {
  const row = await env.DB.prepare('SELECT created_at, attempts FROM otp_codes WHERE email_hash = ?').bind(emailHash).first();
  if (!row || row.attempts >= OTP_MAX_ATTEMPTS_ALL) return 0;
  const left = row.created_at + OTP_COOLDOWN_MS - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

// Stores a new code for the email, replacing the old one (attempts start again at 0). The replace only
// happens when the old code is at least the cooldown old or is dead, in one statement, so two requests that
// race can not both send a code. Returns false when the cooldown has not passed. A new code starts the
// wrong tries of every source at zero again (the per email limit of 25 an hour is not reset).
export async function storeCode(env, emailHash, codeHash, now) {
  const res = await env.DB.prepare(
    'INSERT INTO otp_codes (email_hash, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?) ' +
      'ON CONFLICT (email_hash) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, ' +
      'attempts = 0, created_at = excluded.created_at WHERE otp_codes.created_at <= ? OR otp_codes.attempts >= ?'
  )
    .bind(emailHash, codeHash, now + OTP_TTL_MS, now, now - OTP_COOLDOWN_MS, OTP_MAX_ATTEMPTS_ALL)
    .run();
  const stored = Boolean(res.meta) && res.meta.changes === 1;
  if (stored) {
    try {
      await forgetRate(env, 'vfySrc', emailHash).run();
    } catch {
      // the old counts only make the next tries stricter, they never let more through
    }
  }
  return stored;
}

// True when a code is waiting for this email that has not run out (it may be dead from wrong tries). A
// check against an email with no live code has nothing to guess at, so it does not touch the try counters.
export async function hasLiveCode(env, emailHash, now) {
  const row = await env.DB.prepare('SELECT 1 AS x FROM otp_codes WHERE email_hash = ? AND expires_at > ?').bind(emailHash, now).first();
  return Boolean(row);
}

// Counts one wrong try before the code is looked at, for the source and for the email, and says no when
// either is used up. Throws 429 too_many_attempts. Returns the number of tries this source has now used.
// Call releaseTry when the try turned out right or there was no live code to guess.
export async function reserveTry(env, emailHash, source, now) {
  const dead = (err) =>
    err instanceof ApiError && err.code === 'rate_limited'
      ? new ApiError('too_many_attempts', 'too many wrong tries, ask for a new code or wait a while', { headers: err.headers })
      : err;
  let count;
  try {
    count = await consumeRate(env, 'vfySrc', `${emailHash}:${source}`, now, { undoOnDeny: true });
  } catch (err) {
    throw dead(err);
  }
  try {
    await consumeRate(env, 'vfyAddr', emailHash, now, { undoOnDeny: true });
  } catch (err) {
    await refundRate(env, 'vfySrc', `${emailHash}:${source}`, now).catch(() => {});
    // The whole email is out of wrong tries for now. A new code does not help, so this is a plain
    // rate_limited with Retry-After and not too_many_attempts (which tells the person to ask for a new code).
    if (err instanceof ApiError && err.code === 'rate_limited') {
      throw new ApiError('rate_limited', 'too many wrong codes were typed for this email, try again later', { headers: err.headers });
    }
    throw err;
  }
  return count;
}

export async function releaseTry(env, emailHash, source, now) {
  await Promise.all([
    refundRate(env, 'vfySrc', `${emailHash}:${source}`, now).catch(() => {}),
    refundRate(env, 'vfyAddr', emailHash, now).catch(() => {})
  ]);
}

// Removes the code that was just stored (when the email could not be sent), so the person is not
// held back by the cooldown for a mail that never left.
export async function dropCode(env, emailHash, codeHash) {
  await env.DB.prepare('DELETE FROM otp_codes WHERE email_hash = ? AND code_hash = ?').bind(emailHash, codeHash).run();
}

const WRONG = () => new ApiError('invalid_code', 'that code is not right, try again');
const DEAD = () => new ApiError('too_many_attempts', 'too many wrong tries, ask for a new code');
const GONE = () => new ApiError('code_expired', 'that code has expired, ask for a new one');

// Checks a code. Resolves when it is right and has been used up. Throws:
//   400 code_expired     no live code (never asked, expired, or already used)
//   429 too_many_attempts the code is dead after 5 wrong tries
//   400 invalid_code     wrong code (the try was counted)
// The try is counted in the same statement that reads the code, so parallel guesses can not get
// more than 5 tries. Use up is a delete that only one caller can win.
export async function checkCode(env, emailHash, codeHash, now, maxAttempts = OTP_MAX_ATTEMPTS) {
  const row = await env.DB.prepare(
    'UPDATE otp_codes SET attempts = attempts + 1 WHERE email_hash = ? AND attempts < ? AND expires_at > ? ' +
      'RETURNING code_hash, attempts'
  )
    .bind(emailHash, maxAttempts, now)
    .first();
  if (!row) {
    const old = await env.DB.prepare('SELECT expires_at, attempts FROM otp_codes WHERE email_hash = ?').bind(emailHash).first();
    if (!old) throw GONE();
    if (old.expires_at <= now) {
      await env.DB.prepare('DELETE FROM otp_codes WHERE email_hash = ? AND expires_at <= ?').bind(emailHash, now).run();
      throw GONE();
    }
    throw DEAD();
  }
  if (!constantTimeEqual(row.code_hash, codeHash)) {
    if (row.attempts >= maxAttempts) throw DEAD();
    throw WRONG();
  }
  const used = await env.DB.prepare('DELETE FROM otp_codes WHERE email_hash = ? AND code_hash = ?').bind(emailHash, row.code_hash).run();
  if (!used.meta || used.meta.changes !== 1) throw GONE();
}

// Now and then removes codes that ran out long ago (best effort).
export async function sweepCodes(env, now) {
  if (Math.random() * 50 >= 1) return;
  try {
    await env.DB.prepare('DELETE FROM otp_codes WHERE expires_at < ?').bind(now - 60 * 60 * 1000).run();
  } catch {
    // cleaning is best effort
  }
}
