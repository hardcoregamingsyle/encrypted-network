// ECDSA P-256 keys and record signing (WebCrypto only).
//
// keyId = sha256Hex(canonicalBytes(public jwk)), the "hashed signing key".
// Signature = raw 64 byte r||s, base64url (86 chars).
// Signed bytes = UTF-8("hrdlock/v2/" + record.type + "\n") ++ canonicalBytes(record).
//
// Note: normalizePublicJwk, importPublicJwk, keyIdOf, signRecord and verifyRecord
// are async because WebCrypto is async.
import { canonicalBytes, isPlainObject } from './canonical.js';
import { base64UrlToBytes, bytesToBase64Url, concatBytes, utf8Encode } from './encoding.js';
import { sha256Hex } from './hash.js';

const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' };
const PUBLIC_FIELDS = ['kty', 'crv', 'x', 'y'];
const PRIVATE_FIELDS = ['kty', 'crv', 'x', 'y', 'd'];

function subtle() {
  return globalThis.crypto.subtle;
}

function coordinateOk(s) {
  if (typeof s !== 'string' || s.length !== 43) return false;
  try {
    return base64UrlToBytes(s).length === 32;
  } catch {
    return false;
  }
}

function hasExactly(obj, names) {
  const keys = Object.keys(obj);
  return keys.length === names.length && names.every((n) => Object.prototype.hasOwnProperty.call(obj, n));
}

// Sync shape check. Returns the clean 4 field jwk or throws.
// Does not check that the point is on the curve (see normalizePublicJwk).
export function normalizePublicJwkShape(jwk) {
  if (!isPlainObject(jwk)) throw new Error('public key must be an object');
  if (!hasExactly(jwk, PUBLIC_FIELDS)) throw new Error('public key must have exactly kty, crv, x, y');
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('public key must be EC P-256');
  if (!coordinateOk(jwk.x) || !coordinateOk(jwk.y)) throw new Error('public key coordinates are malformed');
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

// Full check: shape plus the point must import as a P-256 key. Returns the clean jwk or throws.
export async function normalizePublicJwk(jwk) {
  const clean = normalizePublicJwkShape(jwk);
  await importPublicJwk(clean);
  return clean;
}

const keyCache = new Map();
const KEY_CACHE_MAX = 256;

// Verify only CryptoKey from a public jwk. Throws on a bad key.
export async function importPublicJwk(jwk) {
  const clean = normalizePublicJwkShape(jwk);
  const cacheKey = clean.x + '.' + clean.y;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const key = await subtle().importKey('jwk', clean, ALG, true, ['verify']);
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value);
  keyCache.set(cacheKey, key);
  return key;
}

// keyId of a public jwk (64 hex chars). Throws if the key is not valid.
export async function keyIdOf(jwk) {
  const clean = await normalizePublicJwk(jwk);
  return sha256Hex(canonicalBytes(clean));
}

export async function generateKeyPair({ extractable = false } = {}) {
  const pair = await subtle().generateKey(ALG, extractable, ['sign', 'verify']);
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export async function exportPublicJwk(publicKey) {
  const raw = await subtle().exportKey('jwk', publicKey);
  return normalizePublicJwkShape({ kty: raw.kty, crv: raw.crv, x: raw.x, y: raw.y });
}

// Public jwk from a private jwk (drops d).
export function publicJwkFromPrivate(privateJwk) {
  if (!isPlainObject(privateJwk)) throw new Error('private key must be an object');
  return normalizePublicJwkShape({ kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y });
}

// Needs a key that was created or imported as extractable.
export async function exportPrivateJwk(privateKey) {
  const raw = await subtle().exportKey('jwk', privateKey);
  return { kty: raw.kty, crv: raw.crv, x: raw.x, y: raw.y, d: raw.d };
}

// For backup restore and the server key. jwk must be exactly kty, crv, x, y, d.
export async function importPrivateJwk(jwk, { extractable = false } = {}) {
  if (!isPlainObject(jwk) || !hasExactly(jwk, PRIVATE_FIELDS)) {
    throw new Error('private key must have exactly kty, crv, x, y, d');
  }
  publicJwkFromPrivate(jwk);
  if (!coordinateOk(jwk.d)) throw new Error('private key is malformed');
  const clean = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d };
  return subtle().importKey('jwk', clean, ALG, extractable, ['sign']);
}

// The exact bytes that get signed for a record.
export function signedBytes(record) {
  if (record === null || typeof record !== 'object' || typeof record.type !== 'string') {
    throw new TypeError('record.type must be a string');
  }
  return concatBytes(utf8Encode('hrdlock/v2/' + record.type + '\n'), canonicalBytes(record));
}

export async function signRecord(privateKey, record) {
  const sig = await subtle().sign(SIGN_ALG, privateKey, signedBytes(record));
  return bytesToBase64Url(new Uint8Array(sig));
}

// Never throws. False on any problem (bad key, bad record, bad signature text).
export async function verifyRecord(publicJwk, record, signature) {
  try {
    if (typeof signature !== 'string' || signature.length !== 86) return false;
    const sig = base64UrlToBytes(signature);
    if (sig.length !== 64) return false;
    const key = await importPublicJwk(publicJwk);
    return await subtle().verify(SIGN_ALG, key, sig, signedBytes(record));
  } catch {
    return false;
  }
}
