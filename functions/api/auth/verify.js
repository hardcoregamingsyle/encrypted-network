// POST /api/auth/verify  body { email, code }  ->  200 { account, isNew } and a session cookie
// A right code is used up. The first right code for an email creates the account (display name empty
// until the first key is registered). Wrong codes are counted per source (5 wrong tries from one address
// for one email in an hour, then that address is told too_many_attempts, a stranger's wrong tries from
// somewhere else do not kill the code the owner was sent) and per email (25 an hour from everywhere).
//
// When the request already carries a valid session of the same account, that old session is replaced by
// the new one: this is how a signed in person confirms with a fresh code before the few things that need
// a session made in the last 15 minutes (see requireFresh in functions/_lib/session.js).
import { atRest } from '../../_lib/atRest.js';
import { normalizeEmail, maskEmail } from '../../_lib/email.js';
import { ApiError } from '../../_lib/errors.js';
import { json, onlyMethods, rateKeyForRequest, readJson } from '../../_lib/http.js';
import { newAccountId } from '../../_lib/accounts.js';
import { OTP_MAX_ATTEMPTS, OTP_MAX_ATTEMPTS_ALL, checkCode, cleanCode, hasLiveCode, releaseTry, reserveTry } from '../../_lib/otp.js';
import { consumeRate } from '../../_lib/rate.js';
import {
  MAX_SESSIONS_PER_ACCOUNT,
  SESSION_MS,
  accountFromRow,
  cookiePlan,
  hashToken,
  newSessionToken,
  readSessionToken,
  requestNow,
  requireSameOrigin,
  sessionCookie
} from '../../_lib/session.js';

export async function onRequestPost({ request, env }) {
  requireSameOrigin(request);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const code = cleanCode(body.code);
  if (code === null) throw new ApiError('invalid_code', 'enter the 6 digit code from the email');
  // A cookie can not be set on a plain http connection to a real host, so stop before a code is used up.
  cookiePlan(request);

  const ar = await atRest(env);
  const now = requestNow(env, request);
  const source = rateKeyForRequest(request);
  await consumeRate(env, 'verifyIp', source, now);
  const emailHash = await ar.emailHash(email);
  // Nothing to guess at without a live code: say so without counting a try.
  if (!(await hasLiveCode(env, emailHash, now))) throw new ApiError('code_expired', 'that code has expired, ask for a new one');
  const tries = await reserveTry(env, emailHash, source, now);
  try {
    await checkCode(env, emailHash, await ar.codeHash(emailHash, code), now, OTP_MAX_ATTEMPTS_ALL);
  } catch (err) {
    // No live code means nothing was guessed. The fifth wrong try from this address ends its tries.
    if (err instanceof ApiError && err.code === 'code_expired') await releaseTry(env, emailHash, source, now);
    if (err instanceof ApiError && err.code === 'invalid_code' && tries >= OTP_MAX_ATTEMPTS) {
      throw new ApiError('too_many_attempts', 'too many wrong tries, ask for a new code or wait a while');
    }
    throw err;
  }
  await releaseTry(env, emailHash, source, now);

  // The code is used up. One batch makes the account (if new), the login time and the session.
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  const who = '(SELECT id FROM accounts WHERE email_hash = ?)';
  // A session that came along with the request and belongs to this account is replaced by the new one.
  const oldToken = readSessionToken(request);
  const oldHash = oldToken ? await hashToken(oldToken) : '';
  const [created, , , , , account] = await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO accounts (id, email_hash, email_masked, display_name, strict, created_at, last_login_at) VALUES (?, ?, ?, NULL, 0, ?, ?)'
    ).bind(newAccountId(), emailHash, maskEmail(email), now, now),
    env.DB.prepare('UPDATE accounts SET last_login_at = ? WHERE email_hash = ?').bind(now, emailHash),
    // Keep the newest sessions only: drop the ones that ran out and any beyond the cap.
    env.DB.prepare(
      `DELETE FROM sessions WHERE account_id = ${who} AND (expires_at <= ? OR token_hash NOT IN ` +
        `(SELECT token_hash FROM sessions WHERE account_id = ${who} ORDER BY created_at DESC LIMIT ?))`
    ).bind(emailHash, now, emailHash, MAX_SESSIONS_PER_ACCOUNT - 1),
    env.DB.prepare(
      `INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?, ${who}, ?, ?, ?)`
    ).bind(tokenHash, emailHash, now, now + SESSION_MS, now),
    env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ? AND token_hash <> ? AND account_id = ${who}`).bind(oldHash, tokenHash, emailHash),
    env.DB.prepare('SELECT * FROM accounts WHERE email_hash = ?').bind(emailHash)
  ]);
  const row = account.results[0];
  if (!row) throw new ApiError('server_error', 'server error');
  const isNew = Boolean(created.meta) && created.meta.changes === 1;
  return json({ account: accountFromRow(row), isNew }, 200, { 'Set-Cookie': sessionCookie(request, token) });
}

export const onRequest = onlyMethods('POST');
