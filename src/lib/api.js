// Same origin fetch wrappers for the server API.
// Every function throws ApiError on a non 2xx answer or a network failure.

export class ApiError extends Error {
  constructor(status, code, message, retryAfter = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    // seconds the server asked us to wait (429 answers), 0 when it did not say
    this.retryAfter = retryAfter;
  }
}

// Largest locked file the server may hold: 20 MiB of file plus the lock header and tag.
export const MAX_BLOB_BYTES = 20971520 + 4096;
// Largest JSON answer read from the server. A hostile server cannot make the tab read without end.
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.';

function codeForStatus(status) {
  if (status === 404) return 'not_found';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}

// Builds "?a=1&b=2" from an object, leaving out undefined, null and empty values.
export function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? '?' + text : '';
}

async function errorFrom(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const code = body && typeof body.code === 'string' ? body.code : codeForStatus(response.status);
  const message =
    body && typeof body.error === 'string' && body.error
      ? body.error
      : `The server answered with status ${response.status}.`;
  const header = response.headers && response.headers.get ? Number(response.headers.get('retry-after')) : NaN;
  const retryAfter = Number.isFinite(header) && header > 0 ? Math.min(3600, Math.ceil(header)) : 0;
  return new ApiError(response.status, code, message, retryAfter);
}

// The app is told when a normal call is answered 401 unauthenticated (the session ended or ran out), so it can
// move to the signed out state with a short message. Calls that look at the session on purpose (GET /api/me)
// are quiet: they handle the 401 themselves.
let unauthenticatedHandler = null;

export function setUnauthenticatedHandler(fn) {
  unauthenticatedHandler = typeof fn === 'function' ? fn : null;
}

function tellUnauthenticated(error) {
  if (!unauthenticatedHandler) return;
  try {
    unauthenticatedHandler(error);
  } catch {
    // the handler must never change what the caller sees
  }
}

const BUSY_RETRIES = 3;
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Lets a test skip the waiting between retries.
export function setSleepForTests(fn) {
  sleep = fn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

// Sends the request and returns the Response, or throws ApiError.
// The server answers 503 "busy" when many writers arrive at once and it wrote nothing,
// so the same request is safe to send again a few times.
async function send(path, init = {}, quiet = false) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await globalThis.fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new ApiError(0, 'network', NETWORK_MESSAGE);
    }
    if (response.ok) return response;
    const error = await errorFrom(response);
    const aborted = init.signal && init.signal.aborted;
    if (response.status === 503 && error.code === 'busy' && attempt < BUSY_RETRIES && !aborted) {
      const header = response.headers && response.headers.get ? Number(response.headers.get('retry-after')) : NaN;
      const seconds = Math.min(3, Number.isFinite(header) && header > 0 ? header : 1);
      await sleep(seconds * 1000 + attempt * 500);
      continue;
    }
    if (!quiet && error.status === 401 && error.code === 'unauthenticated') tellUnauthenticated(error);
    throw error;
  }
}

function tooLarge(limit) {
  return new ApiError(0, 'too_large', 'The server sent more data than expected (over ' + Math.round(limit / 1048576) + ' MiB), so it was not read.');
}

// Reads a response body, giving up as soon as it is larger than limit bytes. The announced length
// is checked first, and a body that lies about its length is stopped while it streams.
async function readLimited(response, limit) {
  const announced = Number(response.headers && response.headers.get ? response.headers.get('content-length') : NaN);
  if (Number.isFinite(announced) && announced > limit) {
    if (response.body && typeof response.body.cancel === 'function') response.body.cancel().catch(() => {});
    throw tooLarge(limit);
  }
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const all = new Uint8Array(await response.arrayBuffer());
    if (all.length > limit) throw tooLarge(limit);
    return all;
  }
  const reader = body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw tooLarge(limit);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function parseJson(response) {
  const bytes = await readLimited(response, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(response.status, 'server_error', 'The server sent an answer that could not be read.');
  }
}

async function requestJson(path, { method = 'GET', body, signal, quiet = false } = {}) {
  const init = { method, signal, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await send(path, init, quiet);
  return parseJson(response);
}

const enc = encodeURIComponent;

export function getServerKey(opts) {
  return requestJson('/api/server-key', opts);
}

export function registerIdentity(record, signature) {
  return requestJson('/api/identities', { method: 'POST', body: { record, signature } });
}

export function getIdentity(keyId, opts) {
  return requestJson(`/api/identities/${enc(keyId)}`, opts);
}

// sign(record) returns a signature. The blob.put record is never stored by the server.
export async function putBlob({ hash, size, bytes, signer, sign }) {
  const record = { v: 2, type: 'blob.put', hash, size, signer, createdAt: Date.now() };
  const signature = await sign(record);
  const response = await send(`/api/blobs/${enc(hash)}`, {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/octet-stream',
      'x-hrd-key': signer,
      'x-hrd-time': String(record.createdAt),
      'x-hrd-sig': signature
    },
    body: bytes
  });
  return parseJson(response);
}

// maxBytes is the size the signed record states for this file. The answer is never read past it
// (and never past the largest file the system accepts).
export async function getBlob(hash, { signal, maxBytes } = {}) {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, MAX_BLOB_BYTES) : MAX_BLOB_BYTES;
  const response = await send(`/api/blobs/${enc(hash)}`, { signal });
  return readLimited(response, limit);
}

// before and beforeId together are the cursor: the updatedAt and docId of the last row already shown.
export function listDocuments({ limit, before, beforeId, owner, q, signal } = {}) {
  return requestJson('/api/documents' + queryString({ limit, before, beforeId, owner, q }), { signal });
}

export function getDocument(docId, opts) {
  return requestJson(`/api/documents/${enc(docId)}`, opts);
}

export function getDocumentHead(docId, opts) {
  return requestJson(`/api/documents/${enc(docId)}/head`, opts);
}

export function postDocRecord(docId, record, signature) {
  return requestJson(`/api/documents/${enc(docId)}/records`, {
    method: 'POST',
    body: { record, signature }
  });
}

export function getLedger({ after, limit, signal } = {}) {
  return requestJson('/api/ledger' + queryString({ after, limit }), { signal });
}

// The answer is { channels, next }. next is the cursor { before, beforeId } for the following page, or null.
export function listChannels({ limit, before, beforeId, signal } = {}) {
  return requestJson('/api/channels' + queryString({ limit, before, beforeId }), { signal });
}

export function createChannel(record, signature) {
  return requestJson('/api/channels', { method: 'POST', body: { record, signature } });
}

export function getMessages(channelId, { after, limit, tail, signal } = {}) {
  return requestJson(`/api/channels/${enc(channelId)}/messages` + queryString({ after, limit, tail }), { signal });
}

export function postMessage(channelId, record, signature) {
  return requestJson(`/api/channels/${enc(channelId)}/messages`, {
    method: 'POST',
    body: { record, signature }
  });
}

// ---------------------------------------------------------------------------
// Accounts: email and code sign in, the session cookie, the account's key and file passwords.
// The cookie is HttpOnly and travels by itself (credentials: same-origin). The browser adds the
// Origin header to every POST, PUT and DELETE, which the server checks.

// { ok, signing, mail: 'none' | 'resend' | ..., accounts: boolean }
export function getHealth(opts) {
  return requestJson('/api/health', opts);
}

// -> { sent: true, cooldown: 30 }
export function authRequest(email) {
  return requestJson('/api/auth/request', { method: 'POST', body: { email } });
}

// -> { account, isNew }
export function authVerify(email, code) {
  return requestJson('/api/auth/verify', { method: 'POST', body: { email, code } });
}

// Signs this device out. { all: true } ends every session of the account, this one too -> { ok, ended }.
export function authLogout({ all = false } = {}) {
  // Quiet: a 401 here only means the session was gone already, which is what was asked for.
  return requestJson('/api/auth/logout', { method: 'POST', body: all ? { all: true } : {}, quiet: true });
}

// -> { account: { id, displayName, emailMasked, strict, createdAt }, keys: [{ keyId, hasCloudCopy }] }, or ApiError 401.
// Quiet: the caller reads the 401 itself (it only means nobody is signed in).
export function getMe(opts) {
  return requestJson('/api/me', { ...opts, quiet: true });
}

// body: { record, signature, privateJwk? } -> { keyId }
export function postMyKey(body) {
  return requestJson('/api/me/key', { method: 'POST', body });
}

// -> { keyId, publicKey, privateJwk, record, signature }. 401 reauth_required when the session is older than 15 minutes.
export function getMyKey(opts) {
  return requestJson('/api/me/key', opts);
}

// Same row shape as listDocuments, but every document owned by any key of the account.
export function listMyDocuments({ limit, before, beforeId, signal } = {}) {
  return requestJson('/api/me/documents' + queryString({ limit, before, beforeId }), { signal });
}

export function putSecret(docId, password) {
  return requestJson(`/api/me/secrets/${enc(docId)}`, { method: 'PUT', body: { password } });
}

// -> { password }
export function getSecret(docId, opts) {
  return requestJson(`/api/me/secrets/${enc(docId)}`, opts);
}

// Strict mode. Always needs a session made in the last 15 minutes (401 reauth_required).
//   postStrict(false)                     -> { strict: false, passwords: [] }
//   postStrict(true [, { after }])        -> { strict: true, passwords: [{ docId, password }] (at most 100), next: docId | null, unreadable? }
//                                            Nothing is deleted by asking. Send after: next for the following page.
//   postStrict(true, { confirmThrough })  -> { strict: true, passwords: [], next: null, remaining }
//                                            Deletes the server's copies up to and including that docId.
export function postStrict(enabled, { after, confirmThrough } = {}) {
  const body = { enabled: Boolean(enabled) };
  if (after !== undefined && after !== null) body.after = after;
  if (confirmThrough !== undefined && confirmThrough !== null) body.confirmThrough = confirmThrough;
  return requestJson('/api/me/strict', { method: 'POST', body });
}

// Needs a session made in the last 15 minutes (401 reauth_required).
export function deleteMe() {
  return requestJson('/api/me', { method: 'DELETE' });
}

// -> { sessions: [{ id, createdAt, lastSeenAt, expiresAt, current }] }, newest first
export function getSessions(opts) {
  return requestJson('/api/me/sessions', opts);
}

// Ends every session except this one -> { ok: true, ended: n }
export function endOtherSessions() {
  return requestJson('/api/me/sessions', { method: 'DELETE' });
}

// Ends one session by the id from getSessions -> { ok: true }, or 404 when it is gone already
export function endSession(id) {
  return requestJson(`/api/me/sessions/${enc(id)}`, { method: 'DELETE' });
}
