// Same origin fetch wrappers for the server API.
// Every function throws ApiError on a non 2xx answer or a network failure.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.';

function codeForStatus(status) {
  if (status === 404) return 'not_found';
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
  return new ApiError(response.status, code, message);
}

// Sends the request and returns the Response, or throws ApiError.
async function send(path, init = {}) {
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
  if (!response.ok) throw await errorFrom(response);
  return response;
}

async function requestJson(path, { method = 'GET', body, signal } = {}) {
  const init = { method, signal, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await send(path, init);
  try {
    return await response.json();
  } catch {
    throw new ApiError(response.status, 'server_error', 'The server sent an answer that could not be read.');
  }
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
  try {
    return await response.json();
  } catch {
    throw new ApiError(response.status, 'server_error', 'The server sent an answer that could not be read.');
  }
}

export async function getBlob(hash, { signal } = {}) {
  const response = await send(`/api/blobs/${enc(hash)}`, { signal });
  return new Uint8Array(await response.arrayBuffer());
}

export function listDocuments({ limit, before, owner, q, signal } = {}) {
  return requestJson('/api/documents' + queryString({ limit, before, owner, q }), { signal });
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

export function listChannels(opts) {
  return requestJson('/api/channels', opts);
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
