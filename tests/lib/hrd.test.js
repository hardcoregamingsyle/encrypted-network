import { describe, it, expect } from 'vitest';
import { buildSbox, crypt, hrdEncrypt, hrdDecrypt, sameBytes, toWords, rotl } from '../../src/lib/hrd.js';

function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) {
    crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  }
  return out;
}

function onesFraction(bytes) {
  let ones = 0;
  for (const b of bytes) {
    let x = b;
    while (x) { ones += x & 1; x >>= 1; }
  }
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

describe('hrd s-box', () => {
  it('is a permutation and inv undoes it', () => {
    for (let t = 0; t < 20; t++) {
      const sb = buildSbox(randomBytes(32));
      const seen = new Set(sb.box);
      expect(seen.size).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(sb.inv[sb.box[i]]).toBe(i);
        expect(sb.box[sb.inv[i]]).toBe(i);
      }
    }
  });

  it('is deterministic for the same seed and differs for another seed', () => {
    const seed = randomBytes(32);
    const a = buildSbox(seed);
    const b = buildSbox(seed.slice());
    expect(Array.from(a.box)).toEqual(Array.from(b.box));
    const seed2 = seed.slice();
    seed2[0] ^= 1;
    expect(Array.from(buildSbox(seed2).box)).not.toEqual(Array.from(a.box));
  });

  it('is not the identity table', () => {
    const sb = buildSbox(randomBytes(32));
    let fixed = 0;
    for (let i = 0; i < 256; i++) if (sb.box[i] === i) fixed++;
    expect(fixed).toBeLessThan(20);
  });

  it('copes with an all zero seed', () => {
    const sb = buildSbox(new Uint8Array(32));
    expect(new Set(sb.box).size).toBe(256);
  });
});

describe('hrd crypt', () => {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const seed = randomBytes(32);

  it('round trips at edge sizes around the 64 byte block', () => {
    for (const size of [0, 1, 2, 63, 64, 65, 1000, 100000]) {
      const data = randomBytes(size);
      const enc = hrdEncrypt(data, key, nonce, seed);
      expect(enc.length).toBe(size);
      const back = hrdDecrypt(enc, key, nonce, seed);
      expect(Buffer.from(back).equals(Buffer.from(data))).toBe(true);
    }
  });

  it('crypt with a prepared s-box matches the helpers', () => {
    const data = randomBytes(300);
    const sb = buildSbox(seed);
    const a = crypt(data, key, nonce, sb, true);
    const b = hrdEncrypt(data, key, nonce, seed);
    expect(sameBytes(a, b)).toBe(true);
  });

  it('a changed byte changes everything after it (byte chaining)', () => {
    const data = new Uint8Array(500);
    const a = hrdEncrypt(data, key, nonce, seed);
    const data2 = data.slice();
    data2[100] ^= 1;
    const b = hrdEncrypt(data2, key, nonce, seed);
    let before = 0;
    for (let i = 0; i < 100; i++) if (a[i] !== b[i]) before++;
    expect(before).toBe(0);
    let after = 0;
    for (let i = 100; i < 500; i++) if (a[i] !== b[i]) after++;
    expect(after).toBeGreaterThan(350);
  });

  it('a different nonce or key gives a different stream', () => {
    const data = new Uint8Array(200);
    const a = hrdEncrypt(data, key, nonce, seed);
    const n2 = nonce.slice();
    n2[0] ^= 1;
    expect(sameBytes(a, hrdEncrypt(data, key, n2, seed))).toBe(false);
    const k2 = key.slice();
    k2[31] ^= 1;
    expect(sameBytes(a, hrdEncrypt(data, k2, nonce, seed))).toBe(false);
  });

  it('works on a view into a bigger buffer', () => {
    const big = randomBytes(64);
    const k = big.subarray(8, 40);
    const n = big.subarray(40, 52);
    const data = randomBytes(77);
    const enc = hrdEncrypt(data, k, n, seed);
    const enc2 = hrdEncrypt(data, k.slice(), n.slice(), seed);
    expect(sameBytes(enc, enc2)).toBe(true);
  });

  it('a file of only zeros comes out looking random', () => {
    const zeros = new Uint8Array(200000);
    const out = hrdEncrypt(zeros, key, nonce, seed);
    const frac = onesFraction(out);
    expect(frac).toBeGreaterThan(0.49);
    expect(frac).toBeLessThan(0.51);
    const chi = chiSquare(out);
    // 255 degrees of freedom, expect near 255 (wide band so the test does not flake)
    expect(chi).toBeGreaterThan(165);
    expect(chi).toBeLessThan(360);
  });

  it('two keys on the same zeros give unrelated output', () => {
    const zeros = new Uint8Array(200000);
    const a = hrdEncrypt(zeros, key, nonce, seed);
    const b = hrdEncrypt(zeros, randomBytes(32), nonce, randomBytes(32));
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    expect(same / a.length).toBeLessThan(0.01);
  });

  it('known answer: output for fixed inputs never changes (guards the algorithm)', () => {
    const k = new Uint8Array(32).map((_, i) => i);
    const n = new Uint8Array(12).map((_, i) => 100 + i);
    const s = new Uint8Array(32).map((_, i) => 200 - i);
    const data = new Uint8Array(130).map((_, i) => (i * 7) & 255);
    const enc = hrdEncrypt(data, k, n, s);
    // decrypts back
    expect(sameBytes(hrdDecrypt(enc, k, n, s), data)).toBe(true);
    // fixed digest of the output, computed once from the legacy algorithm
    return crypto.subtle.digest('SHA-256', enc).then((d) => {
      const hex = Buffer.from(d).toString('hex');
      expect(hex).toBe(KNOWN_DIGEST);
    });
  });
});

describe('hrd helpers', () => {
  it('sameBytes', () => {
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1]))).toBe(false);
    expect(sameBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
  it('toWords is little endian and rotl wraps', () => {
    expect(Array.from(toWords(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0x80])))).toEqual([1, 0x80000000]);
    expect(rotl(0x80000001, 1)).toBe(3);
  });
});

// sha256 of the output, taken from the first version of the cipher (tests/fixtures/old-hrdcipher.js) for the same inputs
const KNOWN_DIGEST = '3c0bf297a773b3d4584adde3fb3ebe2b8a121cfd1dd07674e3cd7c33a92ea5b0';
