import { describe, expect, it } from 'vitest';
import {
  ZERO_HASH,
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  concatBytes,
  hexToBytes,
  isHex,
  timingSafeEqual,
  toBytes,
  utf8Decode,
  utf8Encode
} from '../../shared/encoding.js';

const ascii = (s) => utf8Encode(s);

describe('hex', () => {
  it('encodes lowercase and round trips', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 171, 255]);
    expect(bytesToHex(bytes)).toBe('00010f10abff');
    expect(hexToBytes('00010f10abff')).toEqual(bytes);
  });
  it('handles empty', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });
  it('rejects bad hex', () => {
    for (const bad of ['abc', 'AB', 'zz', '0x00', ' 00', null, undefined, 12]) {
      expect(() => hexToBytes(bad)).toThrow();
    }
  });
  it('isHex checks lowercase and length', () => {
    expect(isHex('abcd')).toBe(true);
    expect(isHex('abcd', 4)).toBe(true);
    expect(isHex('abcd', 5)).toBe(false);
    expect(isHex('ABCD')).toBe(false);
    expect(isHex('')).toBe(false);
    expect(isHex(5)).toBe(false);
    expect(isHex('g0')).toBe(false);
  });
  it('ZERO_HASH is 64 zeros', () => {
    expect(ZERO_HASH).toBe('0'.repeat(64));
  });
});

describe('base64url', () => {
  const vectors = [
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy']
  ];
  it.each(vectors)('RFC 4648 vector %j', (plain, enc) => {
    expect(bytesToBase64Url(ascii(plain))).toBe(enc);
    expect(base64UrlToBytes(enc)).toEqual(ascii(plain));
  });
  it('uses url alphabet without padding', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
    expect(bytesToBase64Url(bytes)).toBe('-__-');
    expect(base64UrlToBytes('-__-')).toEqual(bytes);
  });
  it('round trips random bytes of many lengths', () => {
    for (let n = 0; n < 70; n++) {
      const b = globalThis.crypto.getRandomValues(new Uint8Array(n));
      expect(base64UrlToBytes(bytesToBase64Url(b))).toEqual(b);
    }
  });
  it('rejects padding, standard alphabet, odd length and leftover bits', () => {
    for (const bad of ['Zg==', 'Zm9v+', 'a/b_', 'A', 'Zh', 'Zm9vY', ' Zg', 'Z g', null, 5]) {
      expect(() => base64UrlToBytes(bad)).toThrow();
    }
  });
});

describe('utf8, bytes helpers', () => {
  it('encodes and decodes', () => {
    const s = 'héllo \u{1F600}';
    expect(utf8Decode(utf8Encode(s))).toBe(s);
  });
  it('decode throws on invalid utf8', () => {
    expect(() => utf8Decode(new Uint8Array([0xff, 0xfe]))).toThrow();
  });
  it('toBytes accepts strings, arrays, buffers and views', () => {
    expect(toBytes('a')).toEqual(new Uint8Array([97]));
    const u = new Uint8Array([1, 2]);
    expect(toBytes(u)).toBe(u);
    expect(toBytes(new Uint8Array([3, 4]).buffer)).toEqual(new Uint8Array([3, 4]));
    expect(toBytes(new DataView(new Uint8Array([5, 6, 7]).buffer, 1, 2))).toEqual(new Uint8Array([6, 7]));
    expect(() => toBytes(5)).toThrow();
    expect(() => toBytes(null)).toThrow();
  });
  it('concatBytes joins parts', () => {
    expect(concatBytes(new Uint8Array([1]), new Uint8Array(0), new Uint8Array([2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(concatBytes()).toEqual(new Uint8Array(0));
  });
  it('timingSafeEqual compares content and length', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false);
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });
});
