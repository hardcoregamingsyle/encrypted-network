// lockfile.js
// The HRDLOCK3 locked file format.
//
// A file is locked in layers:
//   1. AES-256-GCM (standard, from WebCrypto) over the payload
//   2. the homemade HRD cipher (hrd.js) over the AES output
//   3. an HMAC-SHA256 over everything before it
// All keys come from one 32 byte PBKDF2 master key, split by HKDF-SHA256 with
// distinct labels, so they are independent of each other and every password
// guess costs the full iteration count. The result is at least as strong as
// AES-GCM alone.
//
// Layout (bytes):
//   0..7    magic "HRDLOCK3"
//   8       suite, 1 = AES-256-GCM then HRD
//   9..12   PBKDF2 iterations, uint32 big endian
//   13..28  salt (16)
//   29..40  aesIv (12)
//   41..52  hrdNonce (12)
//   53..    body = HRD(AES-GCM(payload))
//   last 32 HMAC-SHA256 of all bytes before it
// The header (bytes 0..52) is also the AES-GCM additional data.
//
// Payload: u16 nameLen | name utf8 | commitSalt (16) | fileHash (32) | file bytes

import { buildSbox, crypt, sameBytes } from './hrd.js';

export const MAGIC = 'HRDLOCK3';
export const SUITE = 1;
export const MIN_ITERATIONS = 100000;
export const MAX_ITERATIONS = 2000000;
export const DEFAULT_ITERATIONS = 600000;
export const MAX_FILE_BYTES = 20971520; // 20 MiB of plaintext
export const MAX_NAME_BYTES = 1024;

const HEADER_LEN = 53;
const MAC_LEN = 32;
const TAG_LEN = 16;
const SALT_LEN = 16;
const IV_LEN = 12;
const NONCE_LEN = 12;
const COMMIT_SALT_LEN = 16;
const HASH_LEN = 32;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COMMIT_TAG = 'hrdlock/v2/commit';

// smallest possible locked file: empty name, empty file
const MIN_LOCKED = HEADER_LEN + (2 + COMMIT_SALT_LEN + HASH_LEN) + TAG_LEN + MAC_LEN;
// largest possible locked file
export const MAX_LOCKED_BYTES =
  HEADER_LEN + (2 + MAX_NAME_BYTES + COMMIT_SALT_LEN + HASH_LEN + MAX_FILE_BYTES) + TAG_LEN + MAC_LEN;

const MSG_NOT_LOCK = 'this is not a hrdlock file';
const MSG_BAD_HEADER = 'bad file header';
const MSG_WRONG = 'wrong password, or the file was changed';
const MSG_DAMAGED = 'file is damaged';

const MAGIC_BYTES = new TextEncoder().encode(MAGIC);

function subtle() {
  return globalThis.crypto.subtle;
}

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

function concat(...parts) {
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

// Only text is a password. Anything else (undefined, null, numbers, objects)
// is a caller bug and must never turn into a guessable word like UNDEFINED.
export function normalizePassword(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/[\s-]/g, '').toUpperCase();
}

export function generatePassword() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(20));
  let out = '';
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += ALPHABET[bytes[i] & 31];
  }
  return out;
}

// throws if a file of this size or a name of this size is not allowed
export function assertSizes(fileBytes, nameBytes) {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 0) throw new Error('bad file size');
  if (fileBytes > MAX_FILE_BYTES) throw new Error('file is too large (20 MiB limit)');
  if (nameBytes > MAX_NAME_BYTES) throw new Error('file name is too long');
}

export function commitmentOf(commitSalt, fileHash) {
  return sha256(concat(new TextEncoder().encode(COMMIT_TAG), commitSalt, fileHash)).then(toHex);
}

// header checks that need no password. Returns { iterations } or throws.
function checkHeader(bytes) {
  if (bytes.length < MIN_LOCKED) throw new Error(MSG_NOT_LOCK);
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) throw new Error(MSG_NOT_LOCK);
  }
  if (bytes.length > MAX_LOCKED_BYTES) throw new Error(MSG_BAD_HEADER);
  if (bytes[8] !== SUITE) throw new Error(MSG_BAD_HEADER);
  const iterations = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(9, false);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new Error(MSG_BAD_HEADER);
  return { iterations };
}

// Four independent 32 byte keys: aes, hrd, seed, mac.
// PBKDF2 makes ONE 32 byte master key, so every password guess costs the full
// iteration count (asking PBKDF2 for more than 32 bytes would let a guesser
// test a guess with a single block). HKDF then splits the master key into the
// four keys using distinct labels.
const KDF_LABELS = {
  aes: 'hrdlock/v3/aes',
  hrd: 'hrdlock/v3/hrd',
  seed: 'hrdlock/v3/seed',
  mac: 'hrdlock/v3/mac'
};

async function deriveKeys(password, salt, iterations) {
  const pw = normalizePassword(password);
  const enc = new TextEncoder();
  const base = await subtle().importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const master = new Uint8Array(await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256
  ));
  const hkdfKey = await subtle().importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const one = async (label) => new Uint8Array(await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(label) }, hkdfKey, 256
  ));
  return {
    aes: await one(KDF_LABELS.aes),
    hrd: await one(KDF_LABELS.hrd),
    seed: await one(KDF_LABELS.seed),
    mac: await one(KDF_LABELS.mac)
  };
}

async function hmac(macKey, bytes) {
  const key = await subtle().importKey('raw', macKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', key, bytes));
}

async function aesKeyOf(raw, usage) {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
}

export async function lockFile({ data, name, password, iterations = DEFAULT_ITERATIONS }) {
  if (!(data instanceof Uint8Array)) throw new Error('data must be a Uint8Array');
  if (typeof name !== 'string') throw new Error('file name must be text');
  const nameBytes = new TextEncoder().encode(name);
  assertSizes(data.length, nameBytes.length);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error(MSG_BAD_HEADER);
  }
  if (typeof password !== 'string' || normalizePassword(password).length === 0) {
    throw new Error('password is empty');
  }

  const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const fileHash = await sha256(data);
  const commitSalt = rand(COMMIT_SALT_LEN);
  const commitment = await commitmentOf(commitSalt, fileHash);

  // payload
  const payload = new Uint8Array(2 + nameBytes.length + COMMIT_SALT_LEN + HASH_LEN + data.length);
  payload[0] = nameBytes.length >>> 8;
  payload[1] = nameBytes.length & 255;
  payload.set(nameBytes, 2);
  payload.set(commitSalt, 2 + nameBytes.length);
  payload.set(fileHash, 2 + nameBytes.length + COMMIT_SALT_LEN);
  payload.set(data, 2 + nameBytes.length + COMMIT_SALT_LEN + HASH_LEN);

  // header
  const header = new Uint8Array(HEADER_LEN);
  header.set(MAGIC_BYTES, 0);
  header[8] = SUITE;
  new DataView(header.buffer).setUint32(9, iterations, false);
  header.set(rand(SALT_LEN), 13);
  header.set(rand(IV_LEN), 29);
  header.set(rand(NONCE_LEN), 41);
  const salt = header.slice(13, 29);
  const iv = header.slice(29, 41);
  const hrdNonce = header.slice(41, 53);

  const keys = await deriveKeys(password, salt, iterations);
  const aes = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: header, tagLength: 128 },
    await aesKeyOf(keys.aes, 'encrypt'),
    payload
  );
  const body = crypt(new Uint8Array(aes), keys.hrd, hrdNonce, buildSbox(keys.seed), true);

  const out = new Uint8Array(HEADER_LEN + body.length + MAC_LEN);
  out.set(header, 0);
  out.set(body, HEADER_LEN);
  out.set(await hmac(keys.mac, out.subarray(0, HEADER_LEN + body.length)), HEADER_LEN + body.length);

  return {
    bytes: out,
    blobHash: toHex(await sha256(out)),
    size: out.length,
    fileHash: toHex(fileHash),
    commitment,
    commitSalt: toHex(commitSalt)
  };
}

export async function unlockFile(bytes, password) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (!(bytes instanceof Uint8Array)) throw new Error(MSG_NOT_LOCK);
  const { iterations } = checkHeader(bytes);
  if (typeof password !== 'string' || normalizePassword(password).length === 0) throw new Error(MSG_WRONG);

  const header = bytes.slice(0, HEADER_LEN);
  const salt = header.slice(13, 29);
  const iv = header.slice(29, 41);
  const hrdNonce = header.slice(41, 53);
  const macStart = bytes.length - MAC_LEN;

  const keys = await deriveKeys(password, salt, iterations);
  const mac = await hmac(keys.mac, bytes.subarray(0, macStart));
  if (!sameBytes(mac, bytes.subarray(macStart))) throw new Error(MSG_WRONG);

  // the check code is good, so from here on a failure means a damaged file
  const aesOut = crypt(bytes.slice(HEADER_LEN, macStart), keys.hrd, hrdNonce, buildSbox(keys.seed), false);
  let payload;
  try {
    payload = new Uint8Array(await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: header, tagLength: 128 },
      await aesKeyOf(keys.aes, 'decrypt'),
      aesOut
    ));
  } catch {
    throw new Error(MSG_DAMAGED);
  }

  if (payload.length < 2 + COMMIT_SALT_LEN + HASH_LEN) throw new Error(MSG_DAMAGED);
  const nameLen = (payload[0] << 8) | payload[1];
  if (nameLen > MAX_NAME_BYTES) throw new Error(MSG_DAMAGED);
  const saltAt = 2 + nameLen;
  const hashAt = saltAt + COMMIT_SALT_LEN;
  const dataAt = hashAt + HASH_LEN;
  if (dataAt > payload.length) throw new Error(MSG_DAMAGED);
  if (payload.length - dataAt > MAX_FILE_BYTES) throw new Error(MSG_DAMAGED);

  let name;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2, saltAt));
  } catch {
    throw new Error(MSG_DAMAGED);
  }
  const commitSalt = payload.slice(saltAt, hashAt);
  const fileHash = payload.slice(hashAt, dataAt);
  const data = payload.slice(dataAt);

  // the file that came out must match the fingerprint that went in
  if (!sameBytes(await sha256(data), fileHash)) throw new Error(MSG_DAMAGED);

  return {
    name,
    data,
    fileHash: toHex(fileHash),
    commitment: await commitmentOf(commitSalt, fileHash),
    commitSalt: toHex(commitSalt)
  };
}

// header sanity only, no password needed. Never throws.
export async function inspectLocked(bytes) {
  try {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    if (!(bytes instanceof Uint8Array)) return { ok: false, size: 0, blobHash: null, iterations: null, error: MSG_NOT_LOCK };
    const blobHash = toHex(await sha256(bytes));
    try {
      const { iterations } = checkHeader(bytes);
      return { ok: true, size: bytes.length, blobHash, iterations };
    } catch (e) {
      return { ok: false, size: bytes.length, blobHash, iterations: null, error: e.message };
    }
  } catch (e) {
    return { ok: false, size: 0, blobHash: null, iterations: null, error: MSG_NOT_LOCK };
  }
}
