// The server signing key, loaded from env.SERVER_SIGNING_JWK (a private JWK as a JSON string).
// Imported once per isolate. Without a key the server still works but signs nothing.
import { makeCheckpointPayload, makeDocHeadPayload, signCheckpoint } from '../../shared/checkpoint.js';
import { importPrivateJwk, keyIdOf, publicJwkFromPrivate } from '../../shared/keys.js';
import { ApiError } from './errors.js';

// Parses a private JWK JSON string. Returns { privateKey, publicJwk, keyId }. Throws on bad input.
export async function parseServerKey(text) {
  let jwk;
  try {
    jwk = JSON.parse(text);
  } catch {
    throw new Error('SERVER_SIGNING_JWK is not valid JSON');
  }
  const publicJwk = publicJwkFromPrivate(jwk);
  const privateKey = await importPrivateJwk(jwk, { extractable: false });
  const keyId = await keyIdOf(publicJwk);
  return { privateKey, publicJwk, keyId };
}

let memo = { raw: null, promise: null };

// Test helper: forget the memoised key.
export function resetServerKeyCache() {
  memo = { raw: null, promise: null };
}

// Returns { privateKey, publicJwk, keyId } or null when no key is configured.
// A key that is set but broken is a server error, so a bad setup is noticed.
export async function loadServerKey(env) {
  const raw = env && typeof env.SERVER_SIGNING_JWK === 'string' ? env.SERVER_SIGNING_JWK.trim() : '';
  if (!raw) return null;
  if (memo.raw !== raw) {
    const promise = parseServerKey(raw);
    memo = { raw, promise };
    promise.catch(() => {
      if (memo.promise === promise) memo = { raw: null, promise: null };
    });
  }
  try {
    return await memo.promise;
  } catch (err) {
    console.error('server key could not be loaded: ' + (err && err.message));
    throw new ApiError('server_error', 'server error');
  }
}

// The "server" field of responses.
export function serverInfo(key) {
  return key ? { keyId: key.keyId, publicKey: key.publicJwk } : null;
}

// Signed ledger or channel checkpoint, or null without a server key. seq 0 means an empty chain.
export async function signScope(key, { scope, seq, hash }, now = Date.now()) {
  if (!key) return null;
  const payload = makeCheckpointPayload({ scope, seq, hash, signedAt: now, serverKeyId: key.keyId });
  return signCheckpoint(key.privateKey, payload);
}

// Signed document head attestation, or null without a server key.
export async function signDocHead(key, { docId, headVersion, headRecordHash }, now = Date.now()) {
  if (!key) return null;
  const payload = makeDocHeadPayload({ docId, headVersion, headRecordHash, signedAt: now, serverKeyId: key.keyId });
  return signCheckpoint(key.privateKey, payload);
}
