// Secrets kept at rest. One server secret (ACCOUNT_MASTER_KEY, base64 of 32 random bytes) is split by
// HKDF into three independent keys:
//   'hrdlock/v3/email-hash'  HMAC key that turns an email into email_hash
//   'hrdlock/v3/otp'         HMAC key for one time code hashes
//   'hrdlock/v3/wrap'        AES-256-GCM key that wraps account keys and document passwords
// A wrapped value is base64url( 0x01 || iv(12) || AES-GCM ciphertext and tag ). The first byte is a
// version so a later master key change can be told apart. The additional data ties a wrapped value to
// its purpose, its account and its id, so a value copied to another row does not open.
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, concatBytes, utf8Encode } from '../../shared/encoding.js';
import { ApiError } from './errors.js';

export const WRAP_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const MASTER_KEY_BYTES = 32;
export const MIN_DISTINCT_BYTES = 16;

export const HKDF_INFO = Object.freeze({
  email: 'hrdlock/v3/email-hash',
  otp: 'hrdlock/v3/otp',
  wrap: 'hrdlock/v3/wrap'
});

function subtle() {
  return globalThis.crypto.subtle;
}

// Reads the master key text. Standard base64 and base64url are both accepted, with or without padding.
// Returns the 32 bytes or null when the text is not exactly that, or when the bytes are obviously not
// random (a placeholder such as 43 letters A, which is 32 zero bytes, is a key that everybody knows):
// 32 random bytes hold about 30 different values, fewer than 16 different values never happens by chance.
export function parseMasterKey(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t.length !== 43 && t.length !== 44) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return null;
  const std = t.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (std.length % 4 === 1) return null;
  let bytes;
  try {
    const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.length !== MASTER_KEY_BYTES) return null;
  if (new Set(bytes).size < MIN_DISTINCT_BYTES) return null;
  return bytes;
}

// The three subkeys for a master key (32 bytes). Not extractable.
export async function deriveSubkeys(master) {
  const base = await subtle().importKey('raw', master, 'HKDF', false, ['deriveKey']);
  const derive = (info, algorithm, usages) =>
    subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Encode(info) }, base, algorithm, false, usages);
  const [emailKey, otpKey, wrapKey] = await Promise.all([
    derive(HKDF_INFO.email, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
    derive(HKDF_INFO.otp, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
    derive(HKDF_INFO.wrap, { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt'])
  ]);
  return { emailKey, otpKey, wrapKey };
}

export async function hmacHex(key, text) {
  const mac = await subtle().sign('HMAC', key, utf8Encode(text));
  return bytesToHex(new Uint8Array(mac));
}

// purpose is 'key' or 'secret'.
export function aadFor(purpose, accountId, id) {
  return utf8Encode(`${purpose}|${accountId}|${id}`);
}

// Wraps bytes. Returns base64url text.
export async function wrap(wrapKey, plaintext, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_BYTES * 8 }, wrapKey, plaintext));
  return bytesToBase64Url(concatBytes(new Uint8Array([WRAP_VERSION]), iv, ct));
}

// Opens a wrapped value. Throws one plain Error for every kind of failure (tamper, wrong aad, wrong
// key, wrong version, bad text), and the message never carries any of the input.
export async function unwrap(wrapKey, text, aad) {
  const fail = () => new Error('could not open the stored value');
  let raw;
  try {
    raw = base64UrlToBytes(text);
  } catch {
    throw fail();
  }
  if (raw.length < 1 + IV_BYTES + TAG_BYTES || raw[0] !== WRAP_VERSION) throw fail();
  try {
    const iv = raw.slice(1, 1 + IV_BYTES);
    const ct = raw.slice(1 + IV_BYTES);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_BYTES * 8 }, wrapKey, ct));
  } catch {
    throw fail();
  }
}

let memo = { raw: null, promise: null };

export function resetAtRestCache() {
  memo = { raw: null, promise: null };
}

// True when ACCOUNT_MASTER_KEY is present and well formed.
export function accountsConfigured(env) {
  return Boolean(env) && parseMasterKey(env.ACCOUNT_MASTER_KEY) !== null;
}

// The helpers for one environment, derived once per isolate. Throws 503 accounts_unavailable when the
// master key is missing or malformed (the text of the key is never logged).
export async function atRest(env) {
  const raw = env && typeof env.ACCOUNT_MASTER_KEY === 'string' ? env.ACCOUNT_MASTER_KEY.trim() : '';
  const master = raw ? parseMasterKey(raw) : null;
  if (!master) {
    if (raw) console.error('ACCOUNT_MASTER_KEY is set but is not base64 of 32 bytes, or has too few different values to be random');
    throw new ApiError('accounts_unavailable', 'accounts are not switched on on this server');
  }
  if (memo.raw !== raw) {
    const promise = deriveSubkeys(master);
    memo = { raw, promise };
    promise.catch(() => {
      if (memo.promise === promise) memo = { raw: null, promise: null };
    });
  }
  const keys = await memo.promise;
  return {
    emailHash: (normalisedEmail) => hmacHex(keys.emailKey, normalisedEmail),
    codeHash: (emailHash, code) => hmacHex(keys.otpKey, emailHash + '|' + code),
    wrap: (plaintext, purpose, accountId, id) => wrap(keys.wrapKey, plaintext, aadFor(purpose, accountId, id)),
    unwrap: (text, purpose, accountId, id) => unwrap(keys.wrapKey, text, aadFor(purpose, accountId, id))
  };
}
