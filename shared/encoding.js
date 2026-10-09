// Byte and text encoding helpers. Web APIs only, no Node APIs.

export const ZERO_HASH = '0'.repeat(64);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Map();
for (let i = 0; i < B64.length; i++) B64_INDEX.set(B64[i], i);

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// UTF-8 encode a string.
export function utf8Encode(text) {
  return encoder.encode(text);
}

// UTF-8 decode, throws on invalid bytes.
export function utf8Decode(bytes) {
  return decoder.decode(bytes);
}

// Accepts a string (UTF-8 encoded), Uint8Array, ArrayBuffer or any typed array view.
export function toBytes(input) {
  if (typeof input === 'string') return encoder.encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('expected a string or bytes');
}

// True when s is lowercase hex, optionally of an exact length.
export function isHex(s, length) {
  if (typeof s !== 'string') return false;
  if (length !== undefined && s.length !== length) return false;
  return s.length > 0 && /^[0-9a-f]+$/.test(s);
}

export function bytesToHex(bytes) {
  const b = toBytes(bytes);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

// Strict: lowercase hex, even length. Throws otherwise.
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error('bad hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// base64url without padding.
export function bytesToBase64Url(bytes) {
  const b = toBytes(bytes);
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  }
  return out;
}

// Strict decoder: no padding, no other characters, no leftover non zero bits.
export function base64UrlToBytes(text) {
  if (typeof text !== 'string') throw new Error('bad base64url');
  const len = text.length;
  if (len % 4 === 1) throw new Error('bad base64url');
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    const v = B64_INDEX.get(text[i]);
    if (v === undefined) throw new Error('bad base64url');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) throw new Error('bad base64url');
  return out;
}

export function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Constant time comparison of two byte arrays.
export function timingSafeEqual(a, b) {
  const x = toBytes(a);
  const y = toBytes(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
