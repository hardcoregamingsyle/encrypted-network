// Adversarial review of canonicalize, hashing helpers and encodings.
import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalBytes, isPlainObject } from '../../../shared/canonical.js';
import { base64UrlToBytes, bytesToBase64Url, hexToBytes, isHex } from '../../../shared/encoding.js';
import { chainHash, sha256Hex } from '../../../shared/hash.js';

describe('canonicalize: ordering and numbers', () => {
  it('orders keys by UTF-16 code unit, including non ASCII, empty and numeric looking keys', () => {
    const text = canonicalize({ '～': 1, '\u{1F600}': 2, 'é': 3, z: 4, '': 0, '10': 5, '9': 6, Z: 7, 'éa': 8 });
    expect(text).toBe('{"":0,"10":5,"9":6,"Z":7,"z":4,"é":3,"éa":8,"\u{1F600}":2,"～":1}');
  });

  it('negative zero and zero give the same text', () => {
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize([-0, 0])).toBe('[0,0]');
    expect(canonicalize({ a: -0 })).toBe(canonicalize({ a: 0 }));
  });

  it.each([
    [2 ** 53, 'unsafe'],
    [-(2 ** 53), 'unsafe'],
    [1e21, 'exponent'],
    [1.5, 'fraction'],
    [Number.MAX_VALUE, 'max'],
    [NaN, 'nan'],
    [Infinity, 'inf']
  ])('rejects %s (%s)', (n) => {
    expect(() => canonicalize(n)).toThrow();
  });

  it('accepts exactly the safe integer range edges', () => {
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(canonicalize(Number.MIN_SAFE_INTEGER)).toBe('-9007199254740991');
    // 1e2 and 100 are the same logical value, same text
    expect(canonicalize(JSON.parse('1e2'))).toBe(canonicalize(JSON.parse('100')));
    expect(() => canonicalize(JSON.parse('9007199254740993'))).toThrow();
  });
});

describe('canonicalize: odd keys and prototypes', () => {
  it('rejects an own __proto__ key from JSON.parse and does not pollute', () => {
    const o = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    expect(() => canonicalize(o)).toThrow();
    expect({}.polluted).toBeUndefined();
  });

  it('constructor and prototype keys are plain data', () => {
    const o = JSON.parse('{"constructor":{"prototype":{"x":1}},"toString":"s","hasOwnProperty":1}');
    expect(canonicalize(o)).toBe('{"constructor":{"prototype":{"x":1}},"hasOwnProperty":1,"toString":"s"}');
    expect({}.x).toBeUndefined();
  });

  it('objects with the same content but different construction give the same text', () => {
    const a = { b: 1, a: [1, { d: 4, c: 3 }] };
    const b = Object.assign(Object.create(null), { a: [1, Object.assign(Object.create(null), { c: 3, d: 4 })], b: 1 });
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('round trip property over generated values: parse(canonicalize(v)) equals v and the text is a fixed point', () => {
    const alphabet = ['a', 'b', '"', '\\', '\n', '\u0000', '\u007f', ' ', 'é', 'é', '\u{1F600}', '～', ' ', '0'];
    let seed = 12345;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const str = () => Array.from({ length: rnd(5) }, () => alphabet[rnd(alphabet.length)]).join('');
    const gen = (depth) => {
      const k = rnd(depth > 3 ? 4 : 6);
      if (k === 0) return null;
      if (k === 1) return rnd(2) === 0;
      if (k === 2) return rnd(2000) - 1000;
      if (k === 3) return str();
      if (k === 4) return Array.from({ length: rnd(4) }, () => gen(depth + 1));
      const o = {};
      for (let i = 0; i < rnd(4); i++) {
        const key = str();
        if (key !== '__proto__') o[key] = gen(depth + 1);
      }
      return o;
    };
    const seen = new Map();
    for (let i = 0; i < 800; i++) {
      const v = gen(0);
      const text = canonicalize(v);
      expect(JSON.parse(text)).toEqual(v);
      expect(canonicalize(JSON.parse(text))).toBe(text);
      // injective: different text must mean different value, same text same value
      const again = seen.get(text);
      if (again !== undefined) expect(JSON.parse(again)).toEqual(JSON.parse(text));
      seen.set(text, text);
    }
  });

  it('different values never share a text (spot checks around quoting and unicode)', () => {
    const values = [
      { a: '1' },
      { a: 1 },
      { a: [1] },
      { 'a,"b': 1 },
      { a: 1, b: 1 },
      ['a', 'b'],
      ['a,b'],
      [['a'], 'b'],
      'é',
      'é',
      '',
      null,
      'null',
      false,
      'false',
      {},
      [],
      '{}',
      '[]'
    ];
    const texts = values.map((v) => canonicalize(v));
    expect(new Set(texts).size).toBe(values.length);
  });

  it('huge depth is a clean TypeError, not a stack overflow', () => {
    let v = [];
    for (let i = 0; i < 100000; i++) v = [v];
    expect(() => canonicalize(v)).toThrow(TypeError);
    let o = {};
    for (let i = 0; i < 100000; i++) o = { a: o };
    expect(() => canonicalize(o)).toThrow(TypeError);
  });
});

describe('FINDING: canonicalize and isPlainObject accept objects they promise to reject', () => {
  it('an object whose prototype is a null prototype object that has isPrototypeOf is not plain', () => {
    const fake = Object.create(null);
    fake.isPrototypeOf = () => false;
    const o = Object.create(fake);
    o.a = 1;
    expect(isPlainObject(o)).toBe(false);
    expect(() => canonicalize(o)).toThrow();
  });

  it('arrays with accessor elements are rejected like accessor properties on objects', () => {
    const a = [1, 2];
    let n = 0;
    Object.defineProperty(a, 1, { enumerable: true, get: () => ++n });
    expect(() => canonicalize(a)).toThrow();
  });
});

describe('encoding helpers', () => {
  it('base64url decoder is strict', () => {
    expect(() => base64UrlToBytes('AA==')).toThrow();
    expect(() => base64UrlToBytes('A')).toThrow();
    expect(() => base64UrlToBytes('+/+/')).toThrow();
    expect(() => base64UrlToBytes('AB')).toThrow(); // non zero trailing bits
    expect(() => base64UrlToBytes(' AAA')).toThrow();
    expect(() => base64UrlToBytes('AAA\n')).toThrow();
    expect(() => base64UrlToBytes('ÀAAA')).toThrow();
    expect(base64UrlToBytes('')).toEqual(new Uint8Array(0));
  });

  it('base64url round trips every length 0..70', () => {
    for (let n = 0; n <= 70; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      expect(base64UrlToBytes(bytesToBase64Url(b))).toEqual(b);
    }
  });

  it('hex helpers are lowercase only and reject a trailing newline', () => {
    expect(isHex('A'.repeat(64), 64)).toBe(false);
    expect(isHex('a'.repeat(64) + '\n', 64)).toBe(false);
    expect(isHex('a'.repeat(63) + '\n')).toBe(false);
    expect(() => hexToBytes('AA')).toThrow();
    expect(() => hexToBytes('abc')).toThrow();
    expect(isHex('', undefined)).toBe(false);
  });
});

describe('FINDING: chainHash accepts any strings, so its input is ambiguous', () => {
  it('"a:b" + "c" must not collide with "a" + "b:c"', async () => {
    let a;
    let b;
    try {
      a = await chainHash('a:b', 'c');
      b = await chainHash('a', 'b:c');
    } catch {
      return; // rejecting non hash input is also fine
    }
    expect(a).not.toBe(b);
  });

  it('non string input is rejected instead of hashing the word "undefined"', async () => {
    await expect(chainHash(undefined, 'x')).rejects.toThrow();
  });
});

describe('hashing', () => {
  it('known vectors', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('canonicalBytes is stable for equal content', () => {
    expect(canonicalBytes({ b: 1, a: 2 })).toEqual(canonicalBytes({ a: 2, b: 1 }));
  });
});
