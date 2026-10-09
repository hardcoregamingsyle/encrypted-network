// Review: does src/lib/hrd.js still behave exactly like the first version of the cipher (tests/fixtures/old-hrdcipher.js)?
// The legacy file only exports lock/unlock, so its source is loaded with the
// internals exposed and run unchanged.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSbox, crypt, makeBlock, toWords, rotl, hrdEncrypt, hrdDecrypt } from '../../../src/lib/hrd.js';

const legacyPath = fileURLToPath(new URL('../../fixtures/old-hrdcipher.js', import.meta.url));

function loadLegacy() {
  let src = readFileSync(legacyPath, 'utf8');
  const patched = src.replace(
    /return \{\s*lock: lock,/,
    'return { crypt: crypt, buildSbox: buildSbox, makeBlock: makeBlock, toWords: toWords, lock: lock,'
  );
  if (patched === src) throw new Error('could not expose legacy internals');
  const mod = { exports: {} };
  new Function('module', patched)(mod);
  return mod.exports;
}

const L = loadLegacy();

function rnd(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

describe('hrd.js matches the legacy cipher', () => {
  it('the legacy internals were really exposed', () => {
    expect(typeof L.crypt).toBe('function');
    expect(typeof L.buildSbox).toBe('function');
  });

  it('s-box and inverse are identical for random, zero, ones and short seeds', () => {
    const seeds = [rnd(32), rnd(32), rnd(32), new Uint8Array(32), new Uint8Array(32).fill(255), rnd(16), rnd(8), new Uint8Array(0)];
    for (const seed of seeds) {
      const a = buildSbox(seed);
      const b = L.buildSbox(seed);
      expect(same(a.box, b.box)).toBe(true);
      expect(same(a.inv, b.inv)).toBe(true);
      // really a permutation
      expect(new Set(a.box).size).toBe(256);
    }
  });

  it('s-box works on a seed that is a subarray view with an offset', () => {
    const big = rnd(100);
    const view = big.subarray(37, 69);
    const copy = big.slice(37, 69);
    expect(same(buildSbox(view).box, buildSbox(copy).box)).toBe(true);
    expect(same(buildSbox(view).box, L.buildSbox(copy).box)).toBe(true);
  });

  it('keystream blocks are identical, including counter edge values', () => {
    const key = toWords(rnd(32));
    const nonce = toWords(rnd(12));
    const sb = buildSbox(rnd(32));
    for (const counter of [0, 1, 2, 255, 65535, 0x7fffffff, 0x80000000, 0xffffffff]) {
      const a = new Uint8Array(64);
      const b = new Uint8Array(64);
      makeBlock(key, nonce, counter, sb.box, a);
      L.makeBlock(key, nonce, counter, sb.box, b);
      expect(same(a, b), 'counter ' + counter).toBe(true);
    }
  });

  it('encrypt output is identical for many keys, nonces and sizes', () => {
    const sizes = [0, 1, 2, 3, 63, 64, 65, 127, 128, 129, 255, 256, 1000, 4097, 70000];
    for (const size of sizes) {
      for (let round = 0; round < 3; round++) {
        const data = rnd(size);
        const key = rnd(32);
        const nonce = rnd(12);
        const seed = rnd(32);
        const mine = crypt(data, key, nonce, buildSbox(seed), true);
        const theirs = L.crypt(data, key, nonce, L.buildSbox(seed), true);
        expect(same(mine, theirs), 'size ' + size).toBe(true);
        // decrypt cross checks both ways
        expect(same(crypt(theirs, key, nonce, buildSbox(seed), false), data)).toBe(true);
        expect(same(L.crypt(mine, key, nonce, L.buildSbox(seed), false), data)).toBe(true);
        expect(same(hrdEncrypt(data, key, nonce, seed), mine)).toBe(true);
        expect(same(hrdDecrypt(mine, key, nonce, seed), data)).toBe(true);
      }
    }
  });

  it('degenerate inputs (all zero data, all zero key) match the legacy output', () => {
    const data = new Uint8Array(5000);
    const key = new Uint8Array(32);
    const nonce = new Uint8Array(12);
    const seed = new Uint8Array(32);
    expect(same(crypt(data, key, nonce, buildSbox(seed), true), L.crypt(data, key, nonce, L.buildSbox(seed), true))).toBe(true);
  });

  it('key, nonce and data given as offset views behave like copies', () => {
    const pool = rnd(400);
    const data = pool.subarray(3, 303);
    const key = pool.subarray(5, 37);
    const nonce = pool.subarray(40, 52);
    const seed = pool.subarray(60, 92);
    const a = crypt(data, key, nonce, buildSbox(seed), true);
    const b = L.crypt(data.slice(), key.slice(), nonce.slice(), L.buildSbox(seed.slice()), true);
    expect(same(a, b)).toBe(true);
  });

  it('rotl matches a reference', () => {
    expect(rotl(0x80000001, 1)).toBe(3);
    expect(rotl(1, 31)).toBe(0x80000000);
    expect(rotl(0xdeadbeef, 0)).toBe(0xdeadbeef);
  });

  it('a different nonce or key changes the output (sanity)', () => {
    const data = rnd(300);
    const key = rnd(32);
    const nonce = rnd(12);
    const sb = buildSbox(rnd(32));
    const base = crypt(data, key, nonce, sb, true);
    const n2 = nonce.slice();
    n2[0] ^= 1;
    expect(same(base, crypt(data, key, n2, sb, true))).toBe(false);
    const k2 = key.slice();
    k2[31] ^= 1;
    expect(same(base, crypt(data, k2, nonce, sb, true))).toBe(false);
  });
});
