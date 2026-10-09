// hrdcipher.js
// The homemade cipher for hrdlock. Runs in the browser and in node.
//
// How a file gets locked:
//  1. the password is stretched into 96 bytes with PBKDF2 (150000 rounds)
//     - 32 bytes for the cipher key
//     - 32 bytes for the check code key
//     - 32 bytes to shuffle the s-box
//  2. a keystream is made from the key by a mixing function I wrote
//     (add, rotate, xor, multiply, plus a shuffled byte table)
//  3. every byte is xored with the keystream, then pushed through the
//     shuffled s-box together with the byte before it (so one changed
//     byte changes everything after it)
//  4. a check code (HMAC) goes on the end so a wrong password is caught
//
// This is a learning project. The cipher is not reviewed by anyone,
// do not use it to hide anything that really matters.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HRD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAGIC = [72, 82, 68, 76, 79, 67, 75, 49]; // HRDLOCK1
  var ITERATIONS = 150000;
  var HEADER_LEN = 8 + 4 + 16 + 12;
  var MAC_LEN = 32;
  var ROUNDS = 14;
  var CONSTS = [0x6872646c, 0x6f636b31, 0x5a3c9e17, 0x9b2d4f63];
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  var subtle = globalThis.crypto.subtle;

  function rotl(x, n) {
    return ((x << n) | (x >>> (32 - n))) >>> 0;
  }

  function toWords(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var words = new Uint32Array(bytes.length >>> 2);
    for (var i = 0; i < words.length; i++) words[i] = view.getUint32(i * 4, true);
    return words;
  }

  // ---------- the s-box (a table of 256 bytes, shuffled by the key) ----------

  function buildSbox(seedBytes) {
    var w = toWords(seedBytes);
    var s = new Uint32Array(4);

    function next() {
      var r = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
      var t = (s[1] << 9) >>> 0;
      s[2] ^= s[0];
      s[3] ^= s[1];
      s[1] ^= s[2];
      s[0] ^= s[3];
      s[2] ^= t;
      s[3] = rotl(s[3], 11);
      return r;
    }

    for (var i = 0; i < 8; i++) {
      s[i & 3] ^= w[i];
      next();
    }
    if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 1;
    for (var k = 0; k < 16; k++) next();

    var box = new Uint8Array(256);
    var inv = new Uint8Array(256);
    for (var a = 0; a < 256; a++) box[a] = a;
    for (var b = 255; b > 0; b--) {
      var j = next() % (b + 1);
      var tmp = box[b];
      box[b] = box[j];
      box[j] = tmp;
    }
    for (var c = 0; c < 256; c++) inv[box[c]] = c;
    return { box: box, inv: inv };
  }

  // ---------- the keystream ----------

  function quarter(s, a, b, c, d) {
    var A = s[a], B = s[b], C = s[c], D = s[d];
    A = (A + B) >>> 0; D = rotl(D ^ A, 7);
    C = (C + D) >>> 0; B = rotl(B ^ C, 12);
    A = (A + Math.imul(B | 1, 0x2545f491)) >>> 0; D = rotl(D ^ A, 16);
    C = (C + (D ^ (B >>> 5))) >>> 0; B = rotl(B ^ C, 9);
    s[a] = A; s[b] = B; s[c] = C; s[d] = D;
  }

  function subWords(s, box) {
    for (var i = 0; i < 16; i++) {
      var x = s[i];
      s[i] = (box[x & 255] |
        (box[(x >>> 8) & 255] << 8) |
        (box[(x >>> 16) & 255] << 16) |
        (box[x >>> 24] << 24)) >>> 0;
    }
  }

  function makeBlock(keyWords, nonceWords, counter, box, out) {
    var init = new Uint32Array(16);
    var i;
    for (i = 0; i < 4; i++) init[i] = CONSTS[i];
    for (i = 0; i < 8; i++) init[4 + i] = keyWords[i];
    init[12] = counter >>> 0;
    for (i = 0; i < 3; i++) init[13 + i] = nonceWords[i];

    var w = new Uint32Array(init);
    for (var r = 0; r < ROUNDS; r++) {
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
      var v = (w[i] + init[i]) >>> 0;
      out[i * 4] = v & 255;
      out[i * 4 + 1] = (v >>> 8) & 255;
      out[i * 4 + 2] = (v >>> 16) & 255;
      out[i * 4 + 3] = v >>> 24;
    }
  }

  function crypt(data, keyBytes, nonce, sb, encrypt) {
    var out = new Uint8Array(data.length);
    var keyWords = toWords(keyBytes);
    var nonceWords = toWords(nonce);
    var ks = new Uint8Array(64);
    var prev = 0;
    for (var i = 0; i < data.length; i++) {
      if ((i & 63) === 0) makeBlock(keyWords, nonceWords, i >>> 6, sb.box, ks);
      var k = ks[i & 63];
      var c;
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

  // ---------- keys and check code ----------

  function cleanPassword(p) {
    return String(p).replace(/[\s-]/g, '').toUpperCase();
  }

  async function deriveKeys(password, salt, iterations) {
    var base = await subtle.importKey(
      'raw', new TextEncoder().encode(cleanPassword(password)), 'PBKDF2', false, ['deriveBits']
    );
    var bits = await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations }, base, 768
    );
    var b = new Uint8Array(bits);
    return { enc: b.slice(0, 32), mac: b.slice(32, 64), box: b.slice(64, 96) };
  }

  async function makeMac(macKey, bytes) {
    var key = await subtle.importKey(
      'raw', macKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return new Uint8Array(await subtle.sign('HMAC', key, bytes));
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  // ---------- public functions ----------

  function generatePassword() {
    var bytes = crypto.getRandomValues(new Uint8Array(20));
    var out = '';
    for (var i = 0; i < 20; i++) {
      if (i > 0 && i % 4 === 0) out += '-';
      out += ALPHABET[bytes[i] & 31];
    }
    return out;
  }

  async function lock(data, name, password) {
    var nameBytes = new TextEncoder().encode(name);
    if (nameBytes.length > 65535) throw new Error('file name is too long');

    var payload = new Uint8Array(2 + nameBytes.length + data.length);
    payload[0] = nameBytes.length >>> 8;
    payload[1] = nameBytes.length & 255;
    payload.set(nameBytes, 2);
    payload.set(data, 2 + nameBytes.length);

    var salt = crypto.getRandomValues(new Uint8Array(16));
    var nonce = crypto.getRandomValues(new Uint8Array(12));
    var keys = await deriveKeys(password, salt, ITERATIONS);
    var sb = buildSbox(keys.box);
    var body = crypt(payload, keys.enc, nonce, sb, true);

    var out = new Uint8Array(HEADER_LEN + body.length + MAC_LEN);
    out.set(MAGIC, 0);
    new DataView(out.buffer).setUint32(8, ITERATIONS, false);
    out.set(salt, 12);
    out.set(nonce, 28);
    out.set(body, HEADER_LEN);
    var mac = await makeMac(keys.mac, out.subarray(0, HEADER_LEN + body.length));
    out.set(mac, HEADER_LEN + body.length);
    return out;
  }

  async function unlock(locked, password) {
    if (locked.length < HEADER_LEN + MAC_LEN + 2) throw new Error('this is not a hrdlock file');
    for (var i = 0; i < MAGIC.length; i++) {
      if (locked[i] !== MAGIC[i]) throw new Error('this is not a hrdlock file');
    }
    var iterations = new DataView(locked.buffer, locked.byteOffset).getUint32(8, false);
    if (iterations < 1000 || iterations > 2000000) throw new Error('bad file header');

    var salt = locked.slice(12, 28);
    var nonce = locked.slice(28, 40);
    var bodyEnd = locked.length - MAC_LEN;
    var keys = await deriveKeys(password, salt, iterations);
    var mac = await makeMac(keys.mac, locked.subarray(0, bodyEnd));
    if (!sameBytes(mac, locked.subarray(bodyEnd))) {
      throw new Error('wrong password, or the file was changed');
    }

    var sb = buildSbox(keys.box);
    var payload = crypt(locked.slice(HEADER_LEN, bodyEnd), keys.enc, nonce, sb, false);
    var nameLen = (payload[0] << 8) | payload[1];
    if (2 + nameLen > payload.length) throw new Error('file is damaged');
    return {
      name: new TextDecoder().decode(payload.subarray(2, 2 + nameLen)),
      data: payload.subarray(2 + nameLen)
    };
  }

  return { lock: lock, unlock: unlock, generatePassword: generatePassword, MAGIC: MAGIC };
});
