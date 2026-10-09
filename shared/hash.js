// SHA-256 helpers on top of WebCrypto.
import { ZERO_HASH, bytesToHex, concatBytes, hexToBytes, isHex, toBytes, utf8Encode } from './encoding.js';

export { ZERO_HASH };

export async function sha256Bytes(input) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toBytes(input));
  return new Uint8Array(digest);
}

// Strings are hashed as UTF-8. Returns 64 lowercase hex chars.
export async function sha256Hex(input) {
  return bytesToHex(await sha256Bytes(input));
}

// chainHash(prev, h) = sha256Hex(prev + ":" + h). Both must be 64 lowercase hex chars, so the
// joined text is unambiguous. Rejects (throws) on anything else.
export async function chainHash(prev, h) {
  if (!isHex(prev, 64) || !isHex(h, 64)) throw new TypeError('chainHash: both inputs must be 64 lowercase hex chars');
  return sha256Hex(prev + ':' + h);
}

const COMMIT_TAG = utf8Encode('hrdlock/v2/commit');

// commitment = sha256Hex("hrdlock/v2/commit" ++ commitSalt(16) ++ fileHash(32))
// Inputs are hex strings. Throws on bad input.
export async function computeCommitment({ fileHash, commitSalt }) {
  const salt = hexToBytes(commitSalt);
  const fh = hexToBytes(fileHash);
  if (salt.length !== 16 || fh.length !== 32) throw new Error('bad commitment input');
  return sha256Hex(concatBytes(COMMIT_TAG, salt, fh));
}
