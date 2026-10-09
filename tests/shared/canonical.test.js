import { describe, expect, it } from 'vitest';
import { canonicalBytes, canonicalize, isPlainObject, isWellFormedString } from '../../shared/canonical.js';
import { bytesToHex } from '../../shared/encoding.js';

describe('canonicalize vectors', () => {
  it('sorts keys and removes whitespace', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
  });
  it('is independent of key insertion order', () => {
    const a = { z: 1, y: { q: 1, p: 2 }, x: [1, 2] };
    const b = { x: [1, 2], y: { p: 2, q: 1 }, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });
  it('sorts by UTF-16 code unit, not by code point', () => {
    // The emoji is a surrogate pair starting at D83D, which is below FF5E, so it sorts first.
    const o = { '～': 1, '\u{1F600}': 2, a: 3, B: 4, '': 5 };
    expect(canonicalize(o)).toBe('{"":5,"B":4,"a":3,"\u{1F600}":2,"～":1}');
  });
  it('keeps array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });
  it('handles scalars', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize(0)).toBe('0');
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(-17)).toBe('-17');
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(canonicalize('')).toBe('""');
  });
  it('handles empty containers and nesting', () => {
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
    expect(canonicalize({ a: { b: { c: [{ d: [] }] } } })).toBe('{"a":{"b":{"c":[{"d":[]}]}}}');
  });
  it('escapes strings like JSON.stringify', () => {
    expect(canonicalize('a"b\\c\n\t\u0001')).toBe('"a\\"b\\\\c\\n\\t\\u0001"');
  });
  it('writes unicode as is and does not normalize it', () => {
    const nfc = 'é';
    const nfd = 'é';
    expect(canonicalize(nfc)).toBe('"é"');
    expect(canonicalize(nfc)).not.toBe(canonicalize(nfd));
    expect(canonicalize('\u{1F600}')).toBe('"\u{1F600}"');
  });
  it('canonicalBytes is UTF-8 of the text', () => {
    expect(bytesToHex(canonicalBytes({ a: 'é' }))).toBe(bytesToHex(new TextEncoder().encode('{"a":"é"}')));
    expect(bytesToHex(canonicalBytes({ a: 1 }))).toBe('7b2261223a317d');
  });
  it('accepts null prototype objects', () => {
    const o = Object.create(null);
    o.b = 1;
    o.a = 2;
    expect(canonicalize(o)).toBe('{"a":2,"b":1}');
  });
  it('accepts objects parsed from JSON', () => {
    expect(canonicalize(JSON.parse('{"b":[1,{"z":null,"a":true}],"a":"x"}'))).toBe('{"a":"x","b":[1,{"a":true,"z":null}]}');
  });
});

describe('canonicalize rejections', () => {
  const bad = {
    undefined: undefined,
    NaN: NaN,
    Infinity: Infinity,
    '-Infinity': -Infinity,
    float: 1.5,
    'tiny float': 1e-7,
    'unsafe integer': Number.MAX_SAFE_INTEGER + 1,
    function: () => 1,
    symbol: Symbol('x'),
    bigint: 10n,
    Date: new Date(0),
    Map: new Map(),
    Set: new Set(),
    'typed array': new Uint8Array(2),
    'class instance': new (class Foo {
      constructor() {
        this.a = 1;
      }
    })(),
    RegExp: /x/,
    'lone high surrogate': '\ud800',
    'lone low surrogate': '\udc00',
    'high surrogate at end': 'abc\ud83d',
    'reversed pair': '\udc00\ud800'
  };
  for (const [name, value] of Object.entries(bad)) {
    it(`throws for ${name}`, () => {
      expect(() => canonicalize(value)).toThrow();
      expect(() => canonicalize({ a: value })).toThrow();
      expect(() => canonicalize([value])).toThrow();
    });
  }
  it('throws for undefined object values (not skipped like JSON.stringify)', () => {
    expect(() => canonicalize({ a: undefined })).toThrow();
  });
  it('throws for a lone surrogate in a key', () => {
    expect(() => canonicalize({ '\ud800': 1 })).toThrow();
  });
  it('throws for an own __proto__ key', () => {
    expect(() => canonicalize(JSON.parse('{"__proto__":{"x":1}}'))).toThrow();
    expect(() => canonicalize(JSON.parse('{"a":{"__proto__":1}}'))).toThrow();
  });
  it('throws for objects with another prototype', () => {
    const o = Object.create({ inherited: 1 });
    o.own = 1;
    expect(() => canonicalize(o)).toThrow();
    expect(() => canonicalize(Object.setPrototypeOf({ a: 1 }, Array.prototype))).toThrow();
  });
  it('throws for symbol keys, non enumerable properties and accessors', () => {
    expect(() => canonicalize({ [Symbol('s')]: 1 })).toThrow();
    const hidden = {};
    Object.defineProperty(hidden, 'h', { value: 1, enumerable: false });
    expect(() => canonicalize(hidden)).toThrow();
    expect(() => canonicalize({ get a() { return 1; } })).toThrow();
  });
  it('throws for sparse arrays and arrays with extra properties', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalize([1, , 3])).toThrow();
    const arr = [1, 2];
    arr.extra = 1;
    expect(() => canonicalize(arr)).toThrow();
  });
  it('throws for circular structures and absurd depth', () => {
    const a = {};
    a.self = a;
    expect(() => canonicalize(a)).toThrow();
    let deep = [];
    for (let i = 0; i < 200; i++) deep = [deep];
    expect(() => canonicalize(deep)).toThrow();
  });
});

describe('helpers', () => {
  it('isWellFormedString', () => {
    expect(isWellFormedString('abc')).toBe(true);
    expect(isWellFormedString('\u{1F600}')).toBe(true);
    expect(isWellFormedString('\ud83d')).toBe(false);
    expect(isWellFormedString('\ude00')).toBe(false);
    expect(isWellFormedString('')).toBe(true);
  });
  it('isPlainObject', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(new (class A {})())).toBe(false);
  });
});
