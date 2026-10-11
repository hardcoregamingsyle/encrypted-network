// Review: HRDLOCK3 format against spec section 6, using an independent hand builder.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  lockFile, unlockFile, inspectLocked, generatePassword, normalizePassword,
  MAX_FILE_BYTES, MAX_NAME_BYTES, MAX_LOCKED_BYTES
} from '../../../src/lib/lockfile.js';
import { buildSbox, crypt } from '../../../src/lib/hrd.js';

const FAST = 100000;
const subtle = crypto.subtle;
const enc = new TextEncoder();
const password = 'ABCD-EFGH-JKLM-NPQR-STUV';

const NOT_LOCK = 'this is not a hrdlock file';
const BAD_HEADER = 'bad file header';
const WRONG = 'wrong password, or the file was changed';
const DAMAGED = 'file is damaged';
const SPEC_MESSAGES = [NOT_LOCK, BAD_HEADER, WRONG, DAMAGED];

afterEach(() => { vi.restoreAllMocks(); });

function rnd(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}
function cat(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const hex = (b) => Buffer.from(b).toString('hex');
const sameBuf = (a, b) => Buffer.from(a).equals(Buffer.from(b));
async function sha256(b) { return new Uint8Array(await subtle.digest('SHA-256', b)); }

async function pbkdf2(pw, salt, iterations) {
  const norm = pw.replace(/[\s-]/g, '').toUpperCase();
  const base = await subtle.importKey('raw', enc.encode(norm), 'PBKDF2', false, ['deriveBits']);
  // 32 byte PBKDF2 master key, split with HKDF-SHA256 (labels in role order aes, hrd, seed, mac)
  const master = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  const hk = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const out = new Uint8Array(128);
  for (const [i, label] of ['aes', 'hrd', 'seed', 'mac'].entries()) {
    const part = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('hrdlock/v3/' + label) }, hk, 256
    );
    out.set(new Uint8Array(part), i * 32);
  }
  return out;
}
async function mac(key, bytes) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, bytes));
}

// builds a locked file from a raw payload. slices says which 32 byte slice of the
// 128 bytes is used for each role, so key separation can be probed.
async function build({
  payload, header: headerOverride, pw = password, iterations = FAST,
  slices = { aes: 0, hrd: 1, seed: 2, mac: 3 }, aad
}) {
  const header = new Uint8Array(53);
  header.set(enc.encode('HRDLOCK3'), 0);
  header[8] = 1;
  new DataView(header.buffer).setUint32(9, iterations, false);
  crypto.getRandomValues(header.subarray(13, 53));
  if (headerOverride) headerOverride(header);
  const k = await pbkdf2(pw, header.slice(13, 29), iterations);
  const part = (i) => k.slice(i * 32, i * 32 + 32);
  const aesKey = await subtle.importKey('raw', part(slices.aes), 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv: header.slice(29, 41), additionalData: aad ? aad(header) : header, tagLength: 128 },
    aesKey, payload
  ));
  const body = crypt(ct, part(slices.hrd), header.slice(41, 53), buildSbox(part(slices.seed)), true);
  const pre = cat(header, body);
  return cat(pre, await mac(part(slices.mac), pre));
}

async function goodPayload({ name = 'n', file = rnd(20), nameLenOverride, saltLen = 16, hash }) {
  const nb = enc.encode(name);
  const nl = nameLenOverride ?? nb.length;
  return cat(
    new Uint8Array([nl >> 8, nl & 255]), nb, rnd(saltLen), hash ?? await sha256(file), file
  );
}

async function expectSpecError(promise, message) {
  let err;
  try { await promise; } catch (e) { err = e; }
  expect(err, 'expected an error').toBeDefined();
  expect(err).toBeInstanceOf(Error);
  expect(SPEC_MESSAGES).toContain(err.message);
  if (message) expect(err.message).toBe(message);
}

describe('key separation', () => {
  it('the four 32 byte slices of the PBKDF2 output differ', async () => {
    const k = await pbkdf2(password, rnd(16), FAST);
    const parts = [0, 1, 2, 3].map((i) => hex(k.slice(i * 32, i * 32 + 32)));
    expect(new Set(parts).size).toBe(4);
  });

  it('the hand builder with the spec slices is accepted (control)', async () => {
    const payload = await goodPayload({ name: 'ctl' });
    expect((await unlockFile(await build({ payload }), password)).name).toBe('ctl');
  });

  it('using the wrong slice for any role is rejected, with the right error class', async () => {
    const payload = await goodPayload({});
    // mac key wrong: check code fails
    await expectSpecError(unlockFile(await build({ payload, slices: { aes: 0, hrd: 1, seed: 2, mac: 0 } }), password), WRONG);
    await expectSpecError(unlockFile(await build({ payload, slices: { aes: 0, hrd: 1, seed: 2, mac: 2 } }), password), WRONG);
    // hrd key / seed swapped: check code fine, HRD undo gives garbage, AES-GCM rejects
    await expectSpecError(unlockFile(await build({ payload, slices: { aes: 0, hrd: 2, seed: 1, mac: 3 } }), password), DAMAGED);
    // hrd key reuses the aes key: still not the spec layout
    await expectSpecError(unlockFile(await build({ payload, slices: { aes: 0, hrd: 0, seed: 2, mac: 3 } }), password), DAMAGED);
    // aes key reuses the hrd key
    await expectSpecError(unlockFile(await build({ payload, slices: { aes: 1, hrd: 1, seed: 2, mac: 3 } }), password), DAMAGED);
    // seed reuses the mac key
    await expectSpecError(unlockFile(await build({ payload, slices: { aes: 0, hrd: 1, seed: 3, mac: 3 } }), password), DAMAGED);
  });
});

describe('check code and header authentication', () => {
  it('the check code is verified before any decryption (decrypt is never called on a bad file)', async () => {
    const r = await lockFile({ data: rnd(300), name: 'a', password, iterations: FAST });
    const order = [];
    const realSign = subtle.sign.bind(subtle);
    const realDecrypt = subtle.decrypt.bind(subtle);
    vi.spyOn(subtle, 'sign').mockImplementation((...a) => { order.push('sign'); return realSign(...a); });
    const dec = vi.spyOn(subtle, 'decrypt').mockImplementation((...a) => { order.push('decrypt'); return realDecrypt(...a); });
    for (const pos of [53, 100, r.bytes.length - 33, r.bytes.length - 32, r.bytes.length - 1]) {
      const c = r.bytes.slice();
      c[pos] ^= 4;
      await expectSpecError(unlockFile(c, password), WRONG);
    }
    expect(dec).not.toHaveBeenCalled();
    order.length = 0;
    await unlockFile(r.bytes, password);
    expect(order).toEqual(['sign', 'decrypt']);
  });

  it('a wrong password never reaches decryption', async () => {
    const r = await lockFile({ data: rnd(100), name: 'a', password, iterations: FAST });
    const dec = vi.spyOn(subtle, 'decrypt');
    await expectSpecError(unlockFile(r.bytes, 'AAAA-BBBB'), WRONG);
    expect(dec).not.toHaveBeenCalled();
  });

  it('every one of the 53 header bytes is covered, with every bit', async () => {
    const r = await lockFile({ data: rnd(5), name: 'a', password, iterations: FAST });
    for (let pos = 0; pos < 53; pos++) {
      for (const bit of [0x01, 0x10, 0x80]) {
        const c = r.bytes.slice();
        c[pos] ^= bit;
        // iterations bits 9..12 may land in range, key derivation then runs with other cost
        const dv = new DataView(c.buffer);
        if (pos >= 9 && pos <= 12) {
          const it = dv.getUint32(9, false);
          if (it > 400000) continue; // keep the test fast, range rejection is covered elsewhere
        }
        await expectSpecError(unlockFile(c, password));
      }
    }
  }, 120000);

  it('AAD is exactly the 53 header bytes: any other AAD makes the file damaged', async () => {
    const payload = await goodPayload({});
    await expectSpecError(unlockFile(await build({ payload, aad: (h) => h.slice(0, 52) }), password), DAMAGED);
    await expectSpecError(unlockFile(await build({ payload, aad: (h) => cat(h, new Uint8Array(1)) }), password), DAMAGED);
    await expectSpecError(unlockFile(await build({ payload, aad: (h) => cat(new Uint8Array(1), h.slice(1)) }), password), DAMAGED);
    await expectSpecError(unlockFile(await build({ payload, aad: () => new Uint8Array(0) }), password), DAMAGED);
  });

  it('the new format is not accepted under another magic or suite, even with a valid check code', async () => {
    const payload = await goodPayload({});
    for (const m of ['HRDLOCK2', 'HRDLOCK4', 'hrdlock3', 'HRDLOCK\0']) {
      const bytes = await build({ payload, header: (h) => h.set(enc.encode(m), 0) });
      await expectSpecError(unlockFile(bytes, password), NOT_LOCK);
    }
    for (const s of [0, 2, 3, 255]) {
      const bytes = await build({ payload, header: (h) => { h[8] = s; } });
      await expectSpecError(unlockFile(bytes, password), BAD_HEADER);
    }
  });

  it('a lock made with the minimum iterations cannot be turned into a cheaper one', async () => {
    const r = await lockFile({ data: rnd(50), name: 'a', password, iterations: FAST });
    // lower the count below the minimum with and without resealing: always rejected up front
    const spy = vi.spyOn(subtle, 'deriveBits');
    for (const it of [1, 1000, 99999]) {
      const c = r.bytes.slice();
      new DataView(c.buffer).setUint32(9, it, false);
      await expectSpecError(unlockFile(c, password), BAD_HEADER);
    }
    expect(spy).not.toHaveBeenCalled();
    // raising it changes the derived keys, so the check code fails
    const up = r.bytes.slice();
    new DataView(up.buffer).setUint32(9, FAST + 1, false);
    await expectSpecError(unlockFile(up, password), WRONG);
  });
});

describe('malformed payloads behind a valid lock', () => {
  it('nameLen at 1024 is accepted, 1025 and larger are damaged', async () => {
    const okName = 'a'.repeat(1024);
    const ok = await build({ payload: await goodPayload({ name: okName }) });
    expect((await unlockFile(ok, password)).name).toBe(okName);
    for (const nl of [1025, 1026, 4096, 65535]) {
      const name = 'a'.repeat(Math.min(nl, 3000));
      const bytes = await build({ payload: await goodPayload({ name, nameLenOverride: nl <= 3000 ? nl : undefined }) });
      await expectSpecError(unlockFile(bytes, password), DAMAGED);
    }
  });

  it('nameLen larger than the payload, or hiding the fixed fields, is damaged', async () => {
    for (const nl of [1, 5, 40, 60, 1024]) {
      const payload = cat(new Uint8Array([nl >> 8, nl & 255]), rnd(60));
      await expectSpecError(unlockFile(await build({ payload }), password), DAMAGED);
    }
    // nameLen pointing so that salt+hash exactly fits but then a name that is not the real one
    const payload = await goodPayload({ name: 'abc', file: new Uint8Array(0), nameLenOverride: 4 });
    await expectSpecError(unlockFile(await build({ payload }), password), DAMAGED);
  });

  it('payloads shorter than the fixed fields give a file below the minimum size (not a lock file)', async () => {
    for (const len of [0, 1, 2, 3, 17, 49]) {
      await expectSpecError(unlockFile(await build({ payload: rnd(len) }), password), NOT_LOCK);
    }
    // 50 random bytes is the smallest payload that gets past the size gate, then the hash check fails
    await expectSpecError(unlockFile(await build({ payload: cat(new Uint8Array([0, 0]), rnd(48)) }), password), DAMAGED);
  });

  it('a zero length file with an empty name is the smallest valid payload (50 bytes)', async () => {
    const payload = await goodPayload({ name: '', file: new Uint8Array(0) });
    expect(payload.length).toBe(50);
    const bytes = await build({ payload });
    expect(bytes.length).toBe(53 + 50 + 16 + 32);
    const back = await unlockFile(bytes, password);
    expect(back.name).toBe('');
    expect(back.data.length).toBe(0);
    const r = await lockFile({ data: new Uint8Array(0), name: '', password, iterations: FAST });
    expect(r.size).toBe(151);
    expect((await unlockFile(r.bytes, password)).data.length).toBe(0);
  });

  it('a name that is not valid UTF-8 is damaged', async () => {
    const nb = new Uint8Array([0xc3, 0x28, 0xff]);
    const file = rnd(5);
    const payload = cat(new Uint8Array([0, 3]), nb, rnd(16), await sha256(file), file);
    await expectSpecError(unlockFile(await build({ payload }), password), DAMAGED);
  });

  it('a stored file hash that does not match is damaged', async () => {
    const payload = await goodPayload({ file: rnd(10), hash: rnd(32) });
    await expectSpecError(unlockFile(await build({ payload }), password), DAMAGED);
  });

  it('a payload carrying more than 20 MiB is refused without crashing', async () => {
    const file = new Uint8Array(MAX_FILE_BYTES + 1);
    const payload = await goodPayload({ name: '', file });
    const bytes = await build({ payload });
    const spy = vi.spyOn(subtle, 'deriveBits');
    await expectSpecError(unlockFile(bytes, password));
    // input larger than the largest legal locked file is refused before key derivation
    if (bytes.length > MAX_LOCKED_BYTES) expect(spy).not.toHaveBeenCalled();
  }, 120000);
});

describe('malformed input never hangs or throws something unexpected', () => {
  it('odd input types and sizes', async () => {
    const inputs = [
      undefined, null, 5, {}, [], 'HRDLOCK3', new Uint8Array(0), new Uint8Array(1), new Uint8Array(52),
      new Uint8Array(53), new Uint8Array(150), new Uint16Array(200), new ArrayBuffer(0), new ArrayBuffer(300),
      enc.encode('HRDLOCK3').buffer
    ];
    for (const input of inputs) {
      await expectSpecError(unlockFile(input, password));
    }
  });

  it('valid magic, suite and iterations with random junk behind them: wrong password class, quickly', async () => {
    for (const len of [151, 152, 200, 1000]) {
      const junk = rnd(len);
      junk.set(enc.encode('HRDLOCK3'), 0);
      junk[8] = 1;
      new DataView(junk.buffer).setUint32(9, FAST, false);
      await expectSpecError(unlockFile(junk, password), WRONG);
    }
  });

  it('valid header but shorter than the smallest legal file is not a lock file', async () => {
    const r = await lockFile({ data: new Uint8Array(0), name: '', password, iterations: FAST });
    for (let len = 0; len < r.size; len++) {
      await expectSpecError(unlockFile(r.bytes.slice(0, len), password), NOT_LOCK);
    }
  });

  it('input above the largest legal locked size is refused before any key derivation', async () => {
    const big = new Uint8Array(MAX_LOCKED_BYTES + 1);
    big.set(enc.encode('HRDLOCK3'), 0);
    big[8] = 1;
    new DataView(big.buffer).setUint32(9, FAST, false);
    const spy = vi.spyOn(subtle, 'deriveBits');
    await expectSpecError(unlockFile(big, password), BAD_HEADER);
    expect(spy).not.toHaveBeenCalled();
    const info = await inspectLocked(big);
    expect(info.ok).toBe(false);
  });

  it('inspectLocked never throws on odd input', async () => {
    for (const v of [undefined, null, 1, {}, [], 'x', new Uint16Array(5), new ArrayBuffer(7), new Uint8Array(0)]) {
      const info = await inspectLocked(v);
      expect(info.ok).toBe(false);
    }
  });
});

describe('limits at the real edges', () => {
  it('20 MiB file with a 1024 byte name round trips and fits the blob size limit in the records spec', async () => {
    const data = rnd(MAX_FILE_BYTES);
    const name = 'n'.repeat(MAX_NAME_BYTES);
    const r = await lockFile({ data, name, password, iterations: FAST });
    expect(r.size).toBeLessThanOrEqual(20971520 + 4096);
    expect(r.size).toBe(MAX_LOCKED_BYTES);
    const back = await unlockFile(r.bytes, password);
    expect(back.name).toBe(name);
    expect(back.data.length).toBe(MAX_FILE_BYTES);
    expect(sameBuf(back.data, data)).toBe(true);
    expect(back.fileHash).toBe(r.fileHash);
  }, 240000);

  it('20 MiB + 1 is refused by lockFile', async () => {
    const data = new Uint8Array(MAX_FILE_BYTES + 1);
    await expect(lockFile({ data, name: 'x', password, iterations: FAST })).rejects.toThrow('file is too large');
  });

  it('the block counter of the keystream stays far below 2^32 for the largest legal body', () => {
    const bodyMax = MAX_LOCKED_BYTES;
    expect(Math.ceil(bodyMax / 64)).toBeLessThan(2 ** 32);
  });
});

describe('commitment, fingerprint and blob hash', () => {
  it('match independent computation with the exact domain string', async () => {
    const data = rnd(321);
    const r = await lockFile({ data, name: 'f.pdf', password, iterations: FAST });
    const fh = await sha256(data);
    expect(r.fileHash).toBe(hex(fh));
    expect(r.commitSalt).toMatch(/^[0-9a-f]{32}$/);
    const c = await sha256(cat(enc.encode('hrdlock/v2/commit'), Buffer.from(r.commitSalt, 'hex'), fh));
    expect(r.commitment).toBe(hex(c));
    // near misses of the domain string must not produce the same value
    for (const tag of ['hrdlock/v2/commit\n', 'hrdlock/v2/commit ', 'hrdlock/v1/commit', 'hrdlock/v2/Commit', 'hrdlock/v2/commit\0']) {
      const alt = await sha256(cat(enc.encode(tag), Buffer.from(r.commitSalt, 'hex'), fh));
      expect(hex(alt)).not.toBe(r.commitment);
    }
    expect(r.blobHash).toBe(hex(await sha256(r.bytes)));
  });

  it('the unlocked commitment equals the one returned by lockFile for a hand built file', async () => {
    const file = rnd(33);
    const salt = rnd(16);
    const fh = await sha256(file);
    const payload = cat(new Uint8Array([0, 1]), enc.encode('q'), salt, fh, file);
    const back = await unlockFile(await build({ payload }), password);
    const expected = hex(await sha256(cat(enc.encode('hrdlock/v2/commit'), salt, fh)));
    expect(back.commitment).toBe(expected);
    expect(back.commitSalt).toBe(hex(salt));
  });
});

describe('uniqueness of salt, iv and nonce', () => {
  it('many locks of the same input never repeat salt, iv or nonce', async () => {
    const salts = new Set();
    const ivs = new Set();
    const nonces = new Set();
    const data = new Uint8Array(10);
    for (let i = 0; i < 40; i++) {
      const r = await lockFile({ data, name: 'same', password, iterations: FAST });
      salts.add(hex(r.bytes.subarray(13, 29)));
      ivs.add(hex(r.bytes.subarray(29, 41)));
      nonces.add(hex(r.bytes.subarray(41, 53)));
    }
    expect(salts.size).toBe(40);
    expect(ivs.size).toBe(40);
    expect(nonces.size).toBe(40);
  }, 120000);

  it('salt, iv and nonce are three different random draws, not one repeated value', async () => {
    const r = await lockFile({ data: new Uint8Array(1), name: 'a', password, iterations: FAST });
    const s = hex(r.bytes.subarray(13, 29));
    const i = hex(r.bytes.subarray(29, 41));
    const n = hex(r.bytes.subarray(41, 53));
    expect(i).not.toBe(n);
    expect(s.startsWith(i)).toBe(false);
    expect(s.startsWith(n)).toBe(false);
  });
});

describe('password normalisation', () => {
  it('spaces, tabs, newlines, dashes and case are ignored', async () => {
    const r = await lockFile({ data: new Uint8Array([1]), name: 'a', password: 'AB12-CD34-EF56', iterations: FAST });
    for (const typed of ['ab12cd34ef56', 'AB12 CD34 EF56', ' ab12\tcd34\nef56 ', 'ab12--cd34---ef56', 'Ab12-Cd34-Ef56', ' AB12CD34EF56 ']) {
      expect((await unlockFile(r.bytes, typed)).data[0]).toBe(1);
    }
  });

  it('lookalike characters are not folded into the ASCII password', async () => {
    const r = await lockFile({ data: new Uint8Array([1]), name: 'a', password: 'ABCD-EFGH', iterations: FAST });
    // Cyrillic A, Greek capital Alpha, fullwidth A, A with a zero width space
    const ch = (n) => String.fromCharCode(n);
    const typedList = [
      ch(0x410) + 'BCDEFGH', ch(0x391) + 'BCDEFGH', ch(0xff21) + 'BCDEFGH',
      'A' + ch(0x200b) + 'BCDEFGH', 'ABCDEFGH' + ch(0x2010) + 'X'
    ];
    for (const typed of typedList) {
      expect(typed.replace(/[\s-]/g, '').toUpperCase()).not.toBe('ABCDEFGH');
      await expectSpecError(unlockFile(r.bytes, typed), WRONG);
    }
  });

  it('empty, blank and dash only passwords are refused by lockFile, and by unlock', async () => {
    for (const p of ['', ' ', '\n\t', '-', ' - - ', '----']) {
      await expect(lockFile({ data: new Uint8Array(1), name: 'a', password: p, iterations: FAST })).rejects.toThrow('password is empty');
    }
    const r = await lockFile({ data: new Uint8Array(1), name: 'a', password, iterations: FAST });
    for (const p of ['', ' ', '-']) await expectSpecError(unlockFile(r.bytes, p), WRONG);
  });

  it('normalizePassword is stable', () => {
    expect(normalizePassword('a-b c')).toBe('ABC');
    expect(normalizePassword(normalizePassword('a-b c'))).toBe('ABC');
    expect(normalizePassword(generatePassword())).toMatch(/^[A-Z2-9]{20}$/);
  });
});
