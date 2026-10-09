import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generatePassword, normalizePassword, lockFile, unlockFile, inspectLocked, assertSizes,
  MAX_FILE_BYTES, MAX_NAME_BYTES, MIN_ITERATIONS, MAX_ITERATIONS, DEFAULT_ITERATIONS
} from '../../src/lib/lockfile.js';
import { buildSbox, crypt } from '../../src/lib/hrd.js';

const FAST = 100000; // the minimum, keeps tests quick
const subtle = crypto.subtle;
const enc = new TextEncoder();

function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}
function hex(bytes) { return Buffer.from(bytes).toString('hex'); }
async function sha256Hex(bytes) { return hex(new Uint8Array(await subtle.digest('SHA-256', bytes))); }
function cat(...parts) { return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p)))); }
function onesFraction(bytes) {
  let ones = 0;
  for (const b of bytes) { let x = b; while (x) { ones += x & 1; x >>= 1; } }
  return ones / (bytes.length * 8);
}
function chiSquare(bytes) {
  const counts = new Array(256).fill(0);
  for (const x of bytes) counts[x]++;
  const expected = bytes.length / 256;
  let chi = 0;
  for (const c of counts) chi += ((c - expected) ** 2) / expected;
  return chi;
}

// independent derivation of the 128 key bytes, straight from the spec
async function specKeys(password, salt, iterations) {
  const pw = password.replace(/[\s-]/g, '').toUpperCase();
  const base = await subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  // 32 byte PBKDF2 master key, then HKDF-SHA256 with one label per key
  const master = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  const hk = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const one = async (label) => new Uint8Array(await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('hrdlock/v3/' + label) }, hk, 256
  ));
  return { aes: await one('aes'), hrd: await one('hrd'), seed: await one('seed'), mac: await one('mac') };
}
async function specMac(macKey, bytes) {
  const k = await subtle.importKey('raw', macKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, bytes));
}

// builds a locked file by hand following the spec, with a few knobs for negative tests
async function specLock({ data, name, password, iterations = FAST, aad = 'header', commitSalt = randomBytes(16), mutateHeader }) {
  const nameBytes = enc.encode(name);
  const fileHash = new Uint8Array(await subtle.digest('SHA-256', data));
  const payload = cat(new Uint8Array([nameBytes.length >> 8, nameBytes.length & 255]), nameBytes, commitSalt, fileHash, data);
  const header = new Uint8Array(53);
  header.set(enc.encode('HRDLOCK3'), 0);
  header[8] = 1;
  new DataView(header.buffer).setUint32(9, iterations, false);
  crypto.getRandomValues(header.subarray(13, 53));
  if (mutateHeader) mutateHeader(header);
  const keys = await specKeys(password, header.slice(13, 29), iterations);
  const aesKey = await subtle.importKey('raw', keys.aes, 'AES-GCM', false, ['encrypt']);
  const params = { name: 'AES-GCM', iv: header.slice(29, 41), tagLength: 128 };
  if (aad === 'header') params.additionalData = header;
  const ct = new Uint8Array(await subtle.encrypt(params, aesKey, payload));
  const body = crypt(ct, keys.hrd, header.slice(41, 53), buildSbox(keys.seed), true);
  const pre = cat(header, body);
  return cat(pre, await specMac(keys.mac, pre));
}

// re-seals a file with a fresh valid HMAC after the test changed some bytes
async function reseal(locked, password, change) {
  const copy = locked.slice(0, locked.length - 32);
  change(copy);
  const iterations = new DataView(copy.buffer).getUint32(9, false);
  const keys = await specKeys(password, copy.slice(13, 29), iterations);
  return cat(copy, await specMac(keys.mac, copy));
}

const password = generatePassword();

afterEach(() => { vi.restoreAllMocks(); });

describe('passwords', () => {
  it('generatePassword has 20 chars in 5 groups from the alphabet', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(p).toMatch(/^([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-){4}[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
  });

  it('normalizePassword removes spaces and dashes and uppercases', () => {
    expect(normalizePassword('ab12-cd34 ef\t56\n-gh')).toBe('AB12CD34EF56GH');
    expect(normalizePassword(' - ')).toBe('');
  });
});

describe('lockFile and unlockFile', () => {
  it('round trips at edge sizes', async () => {
    for (const size of [0, 1, 2, 63, 64, 65, 1000, 100000]) {
      const data = randomBytes(size);
      const name = 'test file ' + size + '.bin';
      const r = await lockFile({ data, name, password, iterations: FAST });
      const back = await unlockFile(r.bytes, password);
      expect(back.name).toBe(name);
      expect(Buffer.from(back.data).equals(Buffer.from(data))).toBe(true);
      expect(back.fileHash).toBe(await sha256Hex(data));
      expect(back.commitment).toBe(r.commitment);
      expect(back.commitSalt).toBe(r.commitSalt);
      expect(back.fileHash).toBe(r.fileHash);
    }
  });

  it('works with the default iterations', async () => {
    const data = randomBytes(300);
    const r = await lockFile({ data, name: 'default.bin', password });
    expect(new DataView(r.bytes.buffer, r.bytes.byteOffset).getUint32(9, false)).toBe(DEFAULT_ITERATIONS);
    expect(DEFAULT_ITERATIONS).toBe(600000);
    const back = await unlockFile(r.bytes, password);
    expect(Buffer.from(back.data).equals(Buffer.from(data))).toBe(true);
  }, 60000);

  it('writes the documented header layout', async () => {
    const r = await lockFile({ data: new Uint8Array([1, 2, 3]), name: 'a.txt', password, iterations: 123456 });
    const b = r.bytes;
    expect(new TextDecoder().decode(b.subarray(0, 8))).toBe('HRDLOCK3');
    expect(b[8]).toBe(1);
    expect(new DataView(b.buffer).getUint32(9, false)).toBe(123456);
    // header 53 + body (aes ciphertext = payload + 16 tag) + mac 32
    const payloadLen = 2 + 5 + 16 + 32 + 3;
    expect(b.length).toBe(53 + payloadLen + 16 + 32);
    expect(r.size).toBe(b.length);
  });

  it('typed lowercase password without dashes works', async () => {
    const r = await lockFile({ data: new Uint8Array([1, 2, 3]), name: 'a.txt', password, iterations: FAST });
    const typed = password.replace(/-/g, '').toLowerCase();
    expect(Array.from((await unlockFile(r.bytes, typed)).data)).toEqual([1, 2, 3]);
    expect(Array.from((await unlockFile(r.bytes, ' ' + password.toLowerCase().replace(/-/g, ' ') + ' ')).data)).toEqual([1, 2, 3]);
  });

  it('wrong password is rejected with the exact message', async () => {
    const r = await lockFile({ data: new Uint8Array([1, 2, 3]), name: 'a.txt', password, iterations: FAST });
    await expect(unlockFile(r.bytes, generatePassword())).rejects.toThrow('wrong password, or the file was changed');
    await expect(unlockFile(r.bytes, '')).rejects.toThrow('wrong password, or the file was changed');
    await expect(unlockFile(r.bytes, '---')).rejects.toThrow('wrong password, or the file was changed');
  });

  it('refuses an empty password when locking', async () => {
    await expect(lockFile({ data: new Uint8Array(1), name: 'a', password: ' - ', iterations: FAST })).rejects.toThrow('password is empty');
  });

  it('fresh salt, iv and nonce every time', async () => {
    const data = new Uint8Array(500);
    const a = await lockFile({ data, name: 'z.bin', password, iterations: FAST });
    const b = await lockFile({ data, name: 'z.bin', password, iterations: FAST });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(false);
    expect(hex(a.bytes.subarray(13, 29))).not.toBe(hex(b.bytes.subarray(13, 29)));
    expect(hex(a.bytes.subarray(29, 41))).not.toBe(hex(b.bytes.subarray(29, 41)));
    expect(hex(a.bytes.subarray(41, 53))).not.toBe(hex(b.bytes.subarray(41, 53)));
    // fresh commit salt means a fresh commitment, but the same file fingerprint
    expect(a.commitSalt).not.toBe(b.commitSalt);
    expect(a.commitment).not.toBe(b.commitment);
    expect(a.fileHash).toBe(b.fileHash);
    expect(a.blobHash).not.toBe(b.blobHash);
  });

  it('a file of only zeros comes out looking random', async () => {
    const zeros = new Uint8Array(200000);
    const r = await lockFile({ data: zeros, name: 'zeros.bin', password, iterations: FAST });
    const body = r.bytes.subarray(53, r.bytes.length - 32);
    const frac = onesFraction(body);
    expect(frac).toBeGreaterThan(0.49);
    expect(frac).toBeLessThan(0.51);
    const chi = chiSquare(body);
    expect(chi).toBeGreaterThan(165);
    expect(chi).toBeLessThan(360);

    // two passwords on the same file give unrelated output
    const other = await lockFile({ data: zeros, name: 'zeros.bin', password: generatePassword(), iterations: FAST });
    const otherBody = other.bytes.subarray(53, other.bytes.length - 32);
    let same = 0;
    for (let i = 0; i < body.length; i++) if (body[i] === otherBody[i]) same++;
    expect(same / body.length).toBeLessThan(0.01);
  });

  it('commitment, fingerprint and blob hash match the spec, computed independently', async () => {
    const data = randomBytes(777);
    const r = await lockFile({ data, name: 'doc.pdf', password, iterations: FAST });
    const fileHash = new Uint8Array(await subtle.digest('SHA-256', data));
    const commitSalt = Buffer.from(r.commitSalt, 'hex');
    expect(r.commitSalt).toMatch(/^[0-9a-f]{32}$/);
    const expected = await sha256Hex(cat(enc.encode('hrdlock/v2/commit'), commitSalt, fileHash));
    expect(r.commitment).toBe(expected);
    expect(r.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(r.fileHash).toBe(hex(fileHash));
    expect(r.fileHash).toBe(await sha256Hex(data));
    expect(r.blobHash).toBe(await sha256Hex(r.bytes));
    expect(r.size).toBe(r.bytes.length);
    const back = await unlockFile(r.bytes, password);
    expect(back.commitment).toBe(expected);
  });
});

describe('spec conformance, independent builder', () => {
  it('unlocks a file built by hand from the spec', async () => {
    const data = randomBytes(1234);
    const bytes = await specLock({ data, name: 'hand made.txt', password, iterations: FAST });
    const back = await unlockFile(bytes, password);
    expect(back.name).toBe('hand made.txt');
    expect(Buffer.from(back.data).equals(Buffer.from(data))).toBe(true);
  });

  it('rejects a hand built file that used no additional data (header is authenticated by AES-GCM)', async () => {
    const bytes = await specLock({ data: randomBytes(50), name: 'x', password, aad: 'none' });
    await expect(unlockFile(bytes, password)).rejects.toThrow('file is damaged');
  });

  it('a changed aesIv with a valid HMAC is still rejected', async () => {
    const r = await lockFile({ data: randomBytes(80), name: 'x', password, iterations: FAST });
    const forged = await reseal(r.bytes, password, (c) => { c[29] ^= 1; });
    await expect(unlockFile(forged, password)).rejects.toThrow('file is damaged');
  });

  it('a changed hrdNonce with a valid HMAC is still rejected', async () => {
    const r = await lockFile({ data: randomBytes(80), name: 'x', password, iterations: FAST });
    const forged = await reseal(r.bytes, password, (c) => { c[41] ^= 1; });
    await expect(unlockFile(forged, password)).rejects.toThrow('file is damaged');
  });

  it('a payload whose stored hash is wrong is rejected even with valid crypto', async () => {
    // hand build with a wrong fileHash inside the payload
    const data = randomBytes(40);
    const nameBytes = enc.encode('n');
    const payload = cat(new Uint8Array([0, 1]), nameBytes, randomBytes(16), randomBytes(32), data);
    const header = new Uint8Array(53);
    header.set(enc.encode('HRDLOCK3'), 0);
    header[8] = 1;
    new DataView(header.buffer).setUint32(9, FAST, false);
    crypto.getRandomValues(header.subarray(13, 53));
    const keys = await specKeys(password, header.slice(13, 29), FAST);
    const k = await subtle.importKey('raw', keys.aes, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: header.slice(29, 41), additionalData: header, tagLength: 128 }, k, payload));
    const body = crypt(ct, keys.hrd, header.slice(41, 53), buildSbox(keys.seed), true);
    const pre = cat(header, body);
    const bytes = cat(pre, await specMac(keys.mac, pre));
    await expect(unlockFile(bytes, password)).rejects.toThrow('file is damaged');
  });

  it('a payload with a name length that does not fit is rejected', async () => {
    const header = new Uint8Array(53);
    header.set(enc.encode('HRDLOCK3'), 0);
    header[8] = 1;
    new DataView(header.buffer).setUint32(9, FAST, false);
    crypto.getRandomValues(header.subarray(13, 53));
    const keys = await specKeys(password, header.slice(13, 29), FAST);
    for (const nameLen of [2000, 60000, 70]) {
      const payload = cat(new Uint8Array([nameLen >> 8, nameLen & 255]), randomBytes(16 + 32 + 10));
      const k = await subtle.importKey('raw', keys.aes, 'AES-GCM', false, ['encrypt']);
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: header.slice(29, 41), additionalData: header, tagLength: 128 }, k, payload));
      const body = crypt(ct, keys.hrd, header.slice(41, 53), buildSbox(keys.seed), true);
      const pre = cat(header, body);
      const bytes = cat(pre, await specMac(keys.mac, pre));
      await expect(unlockFile(bytes, password)).rejects.toThrow('file is damaged');
    }
  });
});

describe('tampering', () => {
  let locked;
  let ref;
  it('setup', async () => {
    ref = await lockFile({ data: new Uint8Array([7]), name: 'a', password, iterations: FAST });
    locked = ref.bytes;
    expect(locked.length).toBe(53 + 2 + 1 + 16 + 32 + 1 + 16 + 32);
  });

  it('every single byte position flipped is rejected', async () => {
    for (const mask of [0x01, 0xff]) {
      for (let pos = 0; pos < locked.length; pos++) {
        const copy = locked.slice();
        copy[pos] ^= mask;
        await expect(unlockFile(copy, password), 'position ' + pos + ' mask ' + mask).rejects.toThrow();
      }
    }
  }, 180000);

  it('flips are reported with the right message by region', async () => {
    const flip = (pos) => { const c = locked.slice(); c[pos] ^= 1; return c; };
    await expect(unlockFile(flip(0), password)).rejects.toThrow('this is not a hrdlock file');
    await expect(unlockFile(flip(8), password)).rejects.toThrow('bad file header');
    await expect(unlockFile(flip(10), password)).rejects.toThrow('bad file header');
    for (const pos of [13, 29, 41, 53, 60, locked.length - 33, locked.length - 32, locked.length - 1]) {
      await expect(unlockFile(flip(pos), password)).rejects.toThrow('wrong password, or the file was changed');
    }
  });

  it('truncation at every length is rejected', async () => {
    for (let len = 0; len < locked.length; len++) {
      await expect(unlockFile(locked.slice(0, len), password), 'length ' + len).rejects.toThrow();
    }
  }, 60000);

  it('extension is rejected', async () => {
    for (const extra of [1, 2, 16, 100]) {
      await expect(unlockFile(cat(locked, new Uint8Array(extra)), password)).rejects.toThrow();
    }
    await expect(unlockFile(cat(new Uint8Array(1), locked), password)).rejects.toThrow('this is not a hrdlock file');
  });

  it('wrong magic is rejected (including the old format)', async () => {
    const old = locked.slice();
    old[7] = 50; // HRDLOCK2
    await expect(unlockFile(old, password)).rejects.toThrow('this is not a hrdlock file');
    await expect(unlockFile(randomBytes(500), password)).rejects.toThrow('this is not a hrdlock file');
    await expect(unlockFile(new Uint8Array(0), password)).rejects.toThrow('this is not a hrdlock file');
    await expect(unlockFile('text', password)).rejects.toThrow('this is not a hrdlock file');
  });

  it('wrong suite byte is rejected', async () => {
    for (const s of [0, 2, 255]) {
      const c = locked.slice();
      c[8] = s;
      await expect(unlockFile(c, password)).rejects.toThrow('bad file header');
    }
  });

  it('iterations out of range are rejected before any key derivation runs', async () => {
    const spy = vi.spyOn(subtle, 'deriveBits');
    for (const it of [0, 1, 99999, 2000001, 4294967295]) {
      const c = locked.slice();
      new DataView(c.buffer).setUint32(9, it, false);
      await expect(unlockFile(c, password)).rejects.toThrow('bad file header');
    }
    expect(spy).not.toHaveBeenCalled();
    // the edges themselves are allowed through the header check
    for (const it of [MIN_ITERATIONS, MAX_ITERATIONS]) {
      const c = locked.slice();
      new DataView(c.buffer).setUint32(9, it, false);
      const info = await inspectLocked(c);
      expect(info.ok).toBe(true);
      expect(info.iterations).toBe(it);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('lockFile refuses iterations out of range', async () => {
    const spy = vi.spyOn(subtle, 'deriveBits');
    for (const it of [99999, 2000001, 1.5, NaN, -1]) {
      await expect(lockFile({ data: new Uint8Array(1), name: 'a', password, iterations: it })).rejects.toThrow('bad file header');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('short and wrong magic input is rejected before key derivation', async () => {
    const spy = vi.spyOn(subtle, 'deriveBits');
    await expect(unlockFile(locked.slice(0, 100), password)).rejects.toThrow('this is not a hrdlock file');
    await expect(unlockFile(randomBytes(300), password)).rejects.toThrow('this is not a hrdlock file');
    expect(spy).not.toHaveBeenCalled();
  });

  it('header fields are all authenticated', async () => {
    // changing salt, iv or nonce and fixing nothing else fails the HMAC;
    // swapping the header of two files of the same password fails too
    const other = await lockFile({ data: new Uint8Array([7]), name: 'a', password, iterations: FAST });
    const swapped = locked.slice();
    swapped.set(other.bytes.subarray(0, 53), 0);
    await expect(unlockFile(swapped, password)).rejects.toThrow('wrong password, or the file was changed');
    // every header byte from 9 to 52 is covered by the check code
    for (let pos = 9; pos < 53; pos++) {
      const c = locked.slice();
      c[pos] ^= 0x80;
      await expect(unlockFile(c, password)).rejects.toThrow();
    }
  }, 60000);
});

describe('inspectLocked', () => {
  it('reports header facts without a password', async () => {
    const r = await lockFile({ data: randomBytes(100), name: 'a', password, iterations: 150000 });
    const info = await inspectLocked(r.bytes);
    expect(info).toMatchObject({ ok: true, size: r.size, blobHash: r.blobHash, iterations: 150000 });
  });

  it('never throws and says why when the input is bad', async () => {
    const r = await lockFile({ data: randomBytes(10), name: 'a', password, iterations: FAST });
    const badSuite = r.bytes.slice();
    badSuite[8] = 9;
    const cases = [
      [new Uint8Array(0), 'this is not a hrdlock file'],
      [randomBytes(400), 'this is not a hrdlock file'],
      [badSuite, 'bad file header'],
      [null, 'this is not a hrdlock file'],
      [undefined, 'this is not a hrdlock file'],
      ['text', 'this is not a hrdlock file']
    ];
    for (const [input, msg] of cases) {
      const info = await inspectLocked(input);
      expect(info.ok).toBe(false);
      expect(info.error).toBe(msg);
    }
  });

  it('accepts an ArrayBuffer', async () => {
    const r = await lockFile({ data: randomBytes(10), name: 'a', password, iterations: FAST });
    const info = await inspectLocked(r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.length));
    expect(info.ok).toBe(true);
    expect(info.blobHash).toBe(r.blobHash);
  });
});

describe('names and limits', () => {
  it('keeps unicode file names exactly', async () => {
    for (const name of ['résumé 中文 हिन्दी 📄.pdf', 'a b/c\\d?.txt', '']) {
      const r = await lockFile({ data: new Uint8Array([1]), name, password, iterations: FAST });
      expect((await unlockFile(r.bytes, password)).name).toBe(name);
    }
  });

  it('allows a name of exactly 1024 bytes and refuses 1025', async () => {
    const ok = 'a'.repeat(MAX_NAME_BYTES);
    const r = await lockFile({ data: new Uint8Array([1]), name: ok, password, iterations: FAST });
    expect((await unlockFile(r.bytes, password)).name).toBe(ok);
    await expect(lockFile({ data: new Uint8Array([1]), name: ok + 'a', password, iterations: FAST })).rejects.toThrow('file name is too long');
    // multi byte characters count in bytes: 342 x 3 bytes = 1026
    await expect(lockFile({ data: new Uint8Array([1]), name: '中'.repeat(342), password, iterations: FAST })).rejects.toThrow('file name is too long');
    const edge = '中'.repeat(341) + 'ab'; // 1023 + 2 = 1025 bytes
    await expect(lockFile({ data: new Uint8Array([1]), name: edge, password, iterations: FAST })).rejects.toThrow('file name is too long');
    const edgeOk = '中'.repeat(341) + 'a'; // 1024 bytes
    const r2 = await lockFile({ data: new Uint8Array([1]), name: edgeOk, password, iterations: FAST });
    expect((await unlockFile(r2.bytes, password)).name).toBe(edgeOk);
  });

  it('assertSizes enforces 50 MiB without allocating it', () => {
    expect(MAX_FILE_BYTES).toBe(52428800);
    expect(() => assertSizes(MAX_FILE_BYTES, 10)).not.toThrow();
    expect(() => assertSizes(MAX_FILE_BYTES + 1, 10)).toThrow('file is too large');
    expect(() => assertSizes(-1, 10)).toThrow();
    expect(() => assertSizes(1.5, 10)).toThrow();
    expect(() => assertSizes(0, 1024)).not.toThrow();
    expect(() => assertSizes(0, 1025)).toThrow('file name is too long');
  });

  it('lockFile applies the 50 MiB limit before doing any work', async () => {
    const spy = vi.spyOn(subtle, 'digest');
    const fake = (len) => new Proxy(new Uint8Array(1), {
      get(target, prop) { return prop === 'length' ? len : Reflect.get(target, prop); }
    });
    await expect(lockFile({ data: fake(MAX_FILE_BYTES + 1), name: 'big', password, iterations: FAST })).rejects.toThrow('file is too large');
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects wrong argument types', async () => {
    await expect(lockFile({ data: 'abc', name: 'a', password })).rejects.toThrow();
    await expect(lockFile({ data: new Uint8Array(1), name: 5, password })).rejects.toThrow();
  });
});

describe('performance', () => {
  it('a 5 MiB file locks and unlocks in reasonable time', async () => {
    const data = randomBytes(5 * 1024 * 1024);
    const t0 = performance.now();
    const r = await lockFile({ data, name: 'five.bin', password, iterations: FAST });
    const t1 = performance.now();
    const back = await unlockFile(r.bytes, password);
    const t2 = performance.now();
    expect(Buffer.from(back.data).equals(Buffer.from(data))).toBe(true);
    console.log('5 MiB lock ms:', Math.round(t1 - t0), 'unlock ms:', Math.round(t2 - t1));
    expect(t1 - t0).toBeLessThan(20000);
    expect(t2 - t1).toBeLessThan(20000);
  }, 60000);
});

describe('key derivation and password types', () => {
  it('asks PBKDF2 for one 32 byte block only, then splits it with HKDF', async () => {
    const spy = vi.spyOn(subtle, 'deriveBits');
    await lockFile({ data: new Uint8Array([1]), name: 'a', password: 'ABCD-EFGH', iterations: FAST });
    const calls = spy.mock.calls;
    const pbkdf2 = calls.filter((c) => c[0].name === 'PBKDF2');
    const hkdf = calls.filter((c) => c[0].name === 'HKDF');
    expect(pbkdf2.length).toBe(1);
    expect(pbkdf2[0][2]).toBe(256);
    expect(hkdf.length).toBe(4);
    expect(new Set(hkdf.map((c) => hex(c[0].info))).size).toBe(4);
  });

  it('refuses a password that is not text, on lock and on unlock', async () => {
    const data = new Uint8Array([1, 2]);
    for (const password of [undefined, null, 12345678, ['ABCD'], { a: 1 }, true]) {
      await expect(lockFile({ data, name: 'a', password, iterations: FAST }), String(typeof password)).rejects.toThrow('password is empty');
    }
    const r = await lockFile({ data, name: 'a', password: 'ABCD-EFGH', iterations: FAST });
    for (const password of [undefined, null, 12345678, ['ABCD-EFGH'], Symbol('x')]) {
      await expect(unlockFile(r.bytes, password)).rejects.toThrow('wrong password, or the file was changed');
    }
  });
});
