// Helpers shared by the auth and me endpoints.
import { ApiError, badRequest } from './errors.js';
import { json } from './http.js';
import { clearCookie } from './session.js';

// A JSON answer for a signed in request. When the session was just extended the cookie is renewed.
// extra can carry more headers (for example Cache-Control).
export function authJson(auth, data, status = 200, extra = null) {
  const headers = { ...(extra || {}) };
  if (auth && auth.setCookie) headers['Set-Cookie'] = auth.setCookie;
  return json(data, status, headers);
}

export function clearedJson(request, data, status = 200) {
  let headers = null;
  try {
    headers = { 'Set-Cookie': clearCookie(request) };
  } catch {
    headers = null;
  }
  return json(data, status, headers);
}

// The keys linked to an account, oldest first.
export async function accountKeyRows(env, accountId) {
  const { results } = await env.DB.prepare(
    'SELECT key_id, wrapped_private, created_at FROM account_keys WHERE account_id = ? ORDER BY created_at ASC, key_id ASC'
  )
    .bind(accountId)
    .all();
  return results;
}

// Reads a body field that must be a plain object or missing.
export function optionalObject(value, name) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${name} must be an object`);
  return value;
}

export function strictModeError(message = 'this account keeps its keys only on its own devices') {
  return new ApiError('strict_mode', message);
}

// Account ids and other random ids: 32 lowercase hex characters.
export function newAccountId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// How long a password that was handed over at the switch to Strict waits for the client to confirm it.
export const HANDOVER_MS = 24 * 60 * 60 * 1000;

// Deletes handed over passwords that nobody confirmed within 24 hours of the switch to Strict (their
// created_at is the time of the switch, see functions/api/me/strict.js). Best effort.
export async function purgeOldHandover(env, accountId, now) {
  try {
    await env.DB.prepare('DELETE FROM account_secrets WHERE account_id = ? AND created_at < ?').bind(accountId, now - HANDOVER_MS).run();
  } catch {
    // runs again the next time
  }
}
