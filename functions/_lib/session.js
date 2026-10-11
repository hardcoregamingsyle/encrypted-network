// Sessions, the session cookie, the same origin rule for writes, and the clock the account code uses.
//
// A session token is 32 random bytes (base64url). Only its sha256 is stored, so a copy of the
// database does not hold a usable token. The cookie is HttpOnly and SameSite=Lax. On https it is named
// __Host-hrd_session and is Secure. On plain http it is named hrd_session and has no Secure flag, which
// is only allowed on a local development host. A session lasts 30 days from the last time it was used
// (pushed forward at most once an hour) but never longer than 90 days from the day it was made, so a
// stolen cookie can not live for ever. The few things that can not be undone (reading the stored signing
// key, switching to Strict, deleting the account) ask for a session that was made in the last 15 minutes,
// that is, for a fresh email code.
import { bytesToBase64Url } from '../../shared/encoding.js';
import { sha256Hex } from '../../shared/hash.js';
import { ApiError } from './errors.js';
import { echoAllowed } from './mail.js';

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_EXTEND_AFTER_MS = 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
export const FRESH_SESSION_MS = 15 * 60 * 1000;
export const MAX_SESSIONS_PER_ACCOUNT = 20;
export const COOKIE_NAME_SECURE = '__Host-hrd_session';
export const COOKIE_NAME_PLAIN = 'hrd_session';
export const TEST_NOW_HEADER = 'x-hrd-test-now';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function isLocalHostName(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

// The clock for sign in and session logic. It is the server clock, except that where the echo mail
// mode is honoured (local development only) a request may set x-hrd-test-now to a time in ms. This lets
// the end to end script test code and session expiry without waiting. It is ignored everywhere else.
export function requestNow(env, request) {
  if (echoAllowed(env, request)) {
    const raw = request.headers.get(TEST_NOW_HEADER);
    if (raw !== null && /^[0-9]{1,16}$/.test(raw)) return Number(raw);
  }
  return Date.now();
}

// Which cookie to use for this request. Plain http is only for a local development host.
export function cookiePlan(request) {
  const url = new URL(request.url);
  if (url.protocol === 'https:') return { name: COOKIE_NAME_SECURE, secure: true };
  if (isLocalHostName(url.hostname)) return { name: COOKIE_NAME_PLAIN, secure: false };
  throw new ApiError('forbidden', 'signing in needs a secure (https) connection');
}

export function sessionCookie(request, token, maxAgeSeconds = SESSION_MS / 1000) {
  const { name, secure } = cookiePlan(request);
  return `${name}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearCookie(request) {
  const { name, secure } = cookiePlan(request);
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// The session token in the Cookie header, or null. Only the cookie name that fits this request counts
// (so a plain cookie set by another site can not stand in for the Secure one on https).
export function readSessionToken(request) {
  let name;
  try {
    name = cookiePlan(request).name;
  } catch {
    return null;
  }
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

export function newSessionToken() {
  return bytesToBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export function hashToken(token) {
  return sha256Hex(token);
}

// A write that is authenticated by a cookie must come from this site: the Origin header has to be
// present and equal to the origin of the request. Reads need no check.
export function requireSameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ApiError('forbidden', 'this request did not come from this site');
  }
}

export function accountFromRow(row) {
  return {
    id: row.id,
    displayName: row.display_name === null || row.display_name === undefined ? null : row.display_name,
    emailMasked: row.email_masked,
    strict: row.strict === 1,
    createdAt: row.created_at
  };
}

function unauthenticated(request, hadCookie) {
  let headers = null;
  if (hadCookie) {
    try {
      headers = { 'Set-Cookie': clearCookie(request) };
    } catch {
      headers = null;
    }
  }
  return new ApiError('unauthenticated', 'sign in first', { headers });
}

// Finds the signed in account. Returns { row, token, tokenHash, setCookie } where row is the accounts
// row and setCookie is a new cookie text when the session was just extended (else null). Throws 401.
export async function requireAuth(env, request, now = requestNow(env, request)) {
  const token = readSessionToken(request);
  if (!token) throw unauthenticated(request, false);
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare(
    'SELECT s.expires_at AS s_expires, s.last_seen_at AS s_seen, s.created_at AS s_created, a.* ' +
      'FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?'
  )
    .bind(tokenHash)
    .first();
  if (!row) throw unauthenticated(request, true);
  if (row.s_expires <= now || now - row.s_created >= SESSION_ABSOLUTE_MS) {
    try {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    } catch {
      // cleaning is best effort
    }
    throw unauthenticated(request, true);
  }
  let setCookie = null;
  if (now - row.s_seen >= SESSION_EXTEND_AFTER_MS) {
    try {
      // never past the absolute end of the session
      const expires = Math.min(now + SESSION_MS, row.s_created + SESSION_ABSOLUTE_MS);
      await env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
        .bind(now, expires, tokenHash)
        .run();
      setCookie = sessionCookie(request, token, Math.max(1, Math.floor((expires - now) / 1000)));
    } catch {
      // the session still works, it just was not extended this time
    }
  }
  return { row, token, tokenHash, setCookie, now, sessionCreatedAt: row.s_created };
}

// For the things that can not be undone: the session has to be young. Throws 401 reauth_required, which
// tells the client to ask for a new email code (the old session is kept, nothing is signed out).
export function requireFresh(auth) {
  if (auth.now - auth.sessionCreatedAt > FRESH_SESSION_MS) {
    throw new ApiError('reauth_required', 'to do this, sign in again with a new email code');
  }
}
