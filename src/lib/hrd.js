// hrd.js
// The homemade cipher layer of hrdlock. Same algorithm as the first version:
// a shuffled byte table (s-box), a 14 round add/rotate/xor keystream with a
// table substitution every third round, and byte chaining through the s-box
// so one changed byte changes everything after it.
//
// This is a learning project. The cipher is not reviewed by anyone. In the
// HRDLOCK3 format it only ever runs on top of AES-256-GCM output.

const ROUNDS = 14;
const CONSTS = [0x6872646c, 0x6f636b31, 0x5a3c9e17, 0x9b2d4f63];

export function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

// little endian 32 bit words of a byte array (length is rounded down to a multiple of 4)
export function toWords(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = new Uint32Array(bytes.length >>> 2);
  for (let i = 0; i < words.length; i++) words[i] = view.getUint32(i * 4, true);
  return words;
}

// ---------- the s-box (a table of 256 bytes, shuffled by the key) ----------

export function buildSbox(seedBytes) {
  const w = toWords(seedBytes);
  const s = new Uint32Array(4);

  function next() {
    const r = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return r;
  }

  for (let i = 0; i < 8; i++) {
    s[i & 3] ^= w[i];
    next();
  }
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 1;
  for (let k = 0; k < 16; k++) next();

  const box = new Uint8Array(256);
  const inv = new Uint8Array(256);
  for (let a = 0; a < 256; a++) box[a] = a;
  for (let b = 255; b > 0; b--) {
    const j = next() % (b + 1);
    const tmp = box[b];
    box[b] = box[j];
    box[j] = tmp;
  }
  for (let c = 0; c < 256; c++) inv[box[c]] = c;
  return { box, inv };
}

// ---------- the keystream ----------

function quarter(s, a, b, c, d) {
  let A = s[a], B = s[b], C = s[c], D = s[d];
  A = (A + B) >>> 0; D = rotl(D ^ A, 7);
  C = (C + D) >>> 0; B = rotl(B ^ C, 12);
  A = (A + Math.imul(B | 1, 0x2545f491)) >>> 0; D = rotl(D ^ A, 16);
  C = (C + (D ^ (B >>> 5))) >>> 0; B = rotl(B ^ C, 9);
  s[a] = A; s[b] = B; s[c] = C; s[d] = D;
}

function subWords(s, box) {
  for (let i = 0; i < 16; i++) {
    const x = s[i];
    s[i] = (box[x & 255] |
      (box[(x >>> 8) & 255] << 8) |
      (box[(x >>> 16) & 255] << 16) |
      (box[x >>> 24] << 24)) >>> 0;
  }
}

// makes one 64 byte block of keystream into out
export function makeBlock(keyWords, nonceWords, counter, box, out) {
  const init = new Uint32Array(16);
  let i;
  for (i = 0; i < 4; i++) init[i] = CONSTS[i];
  for (i = 0; i < 8; i++) init[4 + i] = keyWords[i];
  init[12] = counter >>> 0;
  for (i = 0; i < 3; i++) init[13 + i] = nonceWords[i];

  const w = new Uint32Array(init);
  for (let r = 0; r < ROUNDS; r++) {
    if (r % 2 === 0) {
      quarter(w, 0, 4, 8, 12); quarter(w, 1, 5, 9, 13);
      quarter(w, 2, 6, 10, 14); quarter(w, 3, 7, 11, 15);
    } else {
      quarter(w, 0, 5, 10, 15); quarter(w, 1, 6, 11, 12);
      quarter(w, 2, 7, 8, 13); quarter(w, 3, 4, 9, 14);
    }
    if (r % 3 === 2) subWords(w, box);
  }
  for (i = 0; i < 16; i++) {
    const v = (w[i] + init[i]) >>> 0;
    out[i * 4] = v & 255;
    out[i * 4 + 1] = (v >>> 8) & 255;
    out[i * 4 + 2] = (v >>> 16) & 255;
    out[i * 4 + 3] = v >>> 24;
  }
}

// keyBytes: 32 bytes, nonce: 12 bytes, sb: result of buildSbox
export function crypt(data, keyBytes, nonce, sb, encrypt) {
  const out = new Uint8Array(data.length);
  const keyWords = toWords(keyBytes);
  const nonceWords = toWords(nonce);
  const ks = new Uint8Array(64);
  let prev = 0;
  for (let i = 0; i < data.length; i++) {
    if ((i & 63) === 0) makeBlock(keyWords, nonceWords, i >>> 6, sb.box, ks);
    const k = ks[i & 63];
    let c;
    if (encrypt) {
      c = sb.box[((data[i] ^ k) + prev) & 255];
      out[i] = c;
    } else {
      c = data[i];
      out[i] = ((sb.inv[c] - prev) & 255) ^ k;
    }
    prev = c;
  }
  return out;
}

export function hrdEncrypt(data, keyBytes, nonce, seedBytes) {
  return crypt(data, keyBytes, nonce, buildSbox(seedBytes), true);
}

export function hrdDecrypt(data, keyBytes, nonce, seedBytes) {
  return crypt(data, keyBytes, nonce, buildSbox(seedBytes), false);
}

// compares two byte arrays without stopping at the first difference
export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
