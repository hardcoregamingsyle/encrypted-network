import { beforeAll, describe, expect, it } from 'vitest';
import {
  DOC_RECORD_TYPES,
  LIMITS,
  RECORD_TYPES,
  ZERO_HASH,
  chainHash,
  messageHash,
  newDocId,
  newNonce,
  recordHash,
  validateRecord
} from '../../shared/records.js';
import { sha256Hex } from '../../shared/hash.js';
import { canonicalize } from '../../shared/canonical.js';
import { exportPublicJwk, generateKeyPair } from '../../shared/keys.js';

const H = (c) => c.repeat(64);
const code = (...n) => String.fromCharCode(...n);
let jwk;

beforeAll(async () => {
  jwk = await exportPublicJwk((await generateKeyPair()).publicKey);
});

const make = {
  identity: () => ({ v: 2, type: 'identity', publicKey: { ...jwk }, displayName: 'Alice', createdAt: 1700000000000 }),
  'doc.create': () => ({
    v: 2,
    type: 'doc.create',
    docId: 'a'.repeat(32),
    version: 1,
    prev: ZERO_HASH,
    signer: H('b'),
    createdAt: 1700000000000,
    label: 'Lease',
    listed: true,
    blob: { hash: H('c'), size: 100, suite: 1 },
    commitment: H('d')
  }),
  'doc.update': () => ({
    v: 2,
    type: 'doc.update',
    docId: 'a'.repeat(32),
    version: 2,
    prev: H('e'),
    signer: H('b'),
    createdAt: 1700000000000,
    label: 'Lease v2',
    blob: { hash: H('c'), size: 100, suite: 1 },
    commitment: H('d')
  }),
  'doc.revoke': () => ({
    v: 2,
    type: 'doc.revoke',
    docId: 'a'.repeat(32),
    version: 3,
    prev: H('e'),
    signer: H('b'),
    createdAt: 1700000000000,
    reason: 'issued in error'
  }),
  'channel.create': () => ({
    v: 2,
    type: 'channel.create',
    channelId: 'town-hall',
    title: 'Town hall',
    docId: '',
    signer: H('b'),
    createdAt: 1700000000000
  }),
  message: () => ({
    v: 2,
    type: 'message',
    channelId: 'town-hall',
    body: 'Hello',
    replyTo: '',
    signer: H('b'),
    createdAt: 1700000000000,
    nonce: 'f'.repeat(32)
  }),
  'blob.put': () => ({ v: 2, type: 'blob.put', hash: H('c'), size: 100, signer: H('b'), createdAt: 1700000000000 }),
  checkpoint: () => ({ v: 2, type: 'checkpoint', scope: 'ledger', seq: 5, hash: H('a'), signedAt: 1700000000000, serverKeyId: H('b') })
};

const valid = (r) => validateRecord(r).ok;
const err = (r) => validateRecord(r).error;

describe('constants', () => {
  it('lists the record types', () => {
    expect(RECORD_TYPES).toEqual(expect.arrayContaining(Object.keys(make)));
    expect(DOC_RECORD_TYPES).toEqual(['doc.create', 'doc.update', 'doc.revoke']);
  });
  it('limits match the spec', () => {
    expect(LIMITS.MAX_FILE_BYTES).toBe(20971520);
    expect(LIMITS.MAX_BLOB_BYTES).toBe(20971520 + 4096);
    expect(LIMITS.DISPLAY_NAME_MAX).toBe(40);
    expect(LIMITS.BODY_MAX).toBe(2000);
    expect(LIMITS.RECORD_TIME_WINDOW_MS).toBe(600000);
    expect(LIMITS.BLOB_TIME_WINDOW_MS).toBe(300000);
    expect(ZERO_HASH).toBe('0'.repeat(64));
  });
});

describe.each(Object.keys(make))('validateRecord %s', (type) => {
  it('accepts a valid record', () => {
    expect(validateRecord(make[type]())).toEqual({ ok: true });
  });
  it('rejects each missing field', () => {
    for (const k of Object.keys(make[type]())) {
      const r = make[type]();
      delete r[k];
      const res = validateRecord(r);
      expect(res.ok, `missing ${k}`).toBe(false);
      expect(res.error).toContain(k);
    }
  });
  it('rejects extra fields', () => {
    expect(valid({ ...make[type](), extra: 1 })).toBe(false);
    expect(err({ ...make[type](), extra: 1 })).toContain('extra');
    expect(valid(JSON.parse('{"__proto__":{"a":1},' + JSON.stringify(make[type]()).slice(1)))).toBe(false);
  });
  it('rejects wrong v and wrong type tag', () => {
    expect(valid({ ...make[type](), v: 1 })).toBe(false);
    expect(valid({ ...make[type](), v: '2' })).toBe(false);
    expect(valid({ ...make[type](), type: 'message' === type ? 'blob.put' : 'message' })).toBe(false);
  });
  it('rejects wrong value types for every field', () => {
    for (const k of Object.keys(make[type]())) {
      if (k === 'type') continue;
      for (const bad of [null, undefined, [], {}, true, 1.5, NaN, Symbol.iterator]) {
        const r = { ...make[type](), [k]: bad };
        // booleans are valid only for the listed flag
        if (k === 'listed' && bad === true) continue;
        expect(valid(r), `${k}=${String(bad)}`).toBe(false);
      }
    }
  });
});

describe('validateRecord generic input', () => {
  it('rejects non objects and unknown types without throwing', () => {
    for (const bad of [null, undefined, 5, 'x', [], [make.message()], new Date(), () => 1, Symbol('s')]) {
      expect(valid(bad)).toBe(false);
    }
    expect(valid({})).toBe(false);
    expect(valid({ type: 'nope' })).toBe(false);
    expect(valid({ type: 5 })).toBe(false);
    expect(valid({ type: '__proto__' })).toBe(false);
    expect(valid({ type: 'toString' })).toBe(false);
    expect(valid({ type: 'constructor' })).toBe(false);
  });
  it('rejects class instances and getters', () => {
    class R {
      constructor() {
        Object.assign(this, make.message());
      }
    }
    expect(valid(new R())).toBe(false);
  });
  it('time must be a safe non negative integer', () => {
    for (const t of [-1, 1.5, '1700000000000', 2 ** 53, 8.65e15, Infinity]) {
      expect(valid({ ...make.message(), createdAt: t }), String(t)).toBe(false);
    }
    expect(valid({ ...make.message(), createdAt: 0 })).toBe(true);
  });
});

describe('identity', () => {
  it('display name length boundaries', () => {
    expect(valid({ ...make.identity(), displayName: 'a' })).toBe(true);
    expect(valid({ ...make.identity(), displayName: 'a'.repeat(40) })).toBe(true);
    expect(valid({ ...make.identity(), displayName: 'a'.repeat(41) })).toBe(false);
    expect(valid({ ...make.identity(), displayName: '' })).toBe(false);
  });
  it('counts characters, not UTF-16 units', () => {
    expect(valid({ ...make.identity(), displayName: '\u{1F600}'.repeat(40) })).toBe(true);
    expect(valid({ ...make.identity(), displayName: '\u{1F600}'.repeat(41) })).toBe(false);
  });
  it('rejects blank names, control characters, non NFC and lone surrogates', () => {
    for (const name of ['   ', '\t', 'a\nb', 'a\u0000b', 'a' + code(0x7f), 'a' + code(0x85), 'a\rb', 'e' + code(0x301), code(0xd800), 'a' + code(0xdc00)]) {
      expect(valid({ ...make.identity(), displayName: name }), JSON.stringify(name)).toBe(false);
    }
    expect(valid({ ...make.identity(), displayName: code(0xe9) })).toBe(true);
  });
  it('rejects direction overrides and line separators', () => {
    for (const cp of [0x202e, 0x202a, 0x2066, 0x2069, 0x2028, 0x2029]) {
      expect(valid({ ...make.identity(), displayName: 'ab' + code(cp) + 'cd' }), cp.toString(16)).toBe(false);
    }
  });
  it('public key must be a clean jwk', () => {
    expect(valid({ ...make.identity(), publicKey: { ...jwk, ext: true } })).toBe(false);
    expect(valid({ ...make.identity(), publicKey: { ...jwk, crv: 'P-384' } })).toBe(false);
    expect(valid({ ...make.identity(), publicKey: { ...jwk, x: 'short' } })).toBe(false);
    expect(valid({ ...make.identity(), publicKey: 'key' })).toBe(false);
  });
});

describe('doc records', () => {
  it('doc.create is version 1 with the zero prev', () => {
    expect(valid({ ...make['doc.create'](), version: 2 })).toBe(false);
    expect(valid({ ...make['doc.create'](), version: 0 })).toBe(false);
    expect(valid({ ...make['doc.create'](), prev: H('e') })).toBe(false);
  });
  it('doc.update and doc.revoke are version 2 or more with a real prev', () => {
    for (const t of ['doc.update', 'doc.revoke']) {
      expect(valid({ ...make[t](), version: 1 }), t).toBe(false);
      expect(valid({ ...make[t](), version: 0 }), t).toBe(false);
      expect(valid({ ...make[t](), version: 2 }), t).toBe(true);
      expect(valid({ ...make[t](), version: 1000000 }), t).toBe(true);
      expect(valid({ ...make[t](), prev: ZERO_HASH }), t).toBe(false);
      expect(valid({ ...make[t](), version: 2.5 }), t).toBe(false);
    }
  });
  it('ids and hashes must be lowercase hex of the exact length', () => {
    for (const t of DOC_RECORD_TYPES) {
      expect(valid({ ...make[t](), docId: 'a'.repeat(31) }), t).toBe(false);
      expect(valid({ ...make[t](), docId: 'a'.repeat(33) }), t).toBe(false);
      expect(valid({ ...make[t](), docId: 'A'.repeat(32) }), t).toBe(false);
      expect(valid({ ...make[t](), signer: 'b'.repeat(63) }), t).toBe(false);
      expect(valid({ ...make[t](), signer: 'B'.repeat(64) }), t).toBe(false);
      expect(valid({ ...make[t](), prev: 'g'.repeat(64) }), t).toBe(false);
    }
  });
  it('label length boundaries (0..120)', () => {
    for (const t of ['doc.create', 'doc.update']) {
      expect(valid({ ...make[t](), label: '' }), t).toBe(true);
      expect(valid({ ...make[t](), label: 'x'.repeat(120) }), t).toBe(true);
      expect(valid({ ...make[t](), label: 'x'.repeat(121) }), t).toBe(false);
      expect(valid({ ...make[t](), label: 'a\nb' }), t).toBe(false);
    }
  });
  it('reason length boundaries (0..500)', () => {
    expect(valid({ ...make['doc.revoke'](), reason: '' })).toBe(true);
    expect(valid({ ...make['doc.revoke'](), reason: 'r'.repeat(500) })).toBe(true);
    expect(valid({ ...make['doc.revoke'](), reason: 'r'.repeat(501) })).toBe(false);
    expect(valid({ ...make['doc.revoke'](), reason: 'a\nb' })).toBe(false);
  });
  it('doc.revoke has no blob or commitment', () => {
    expect(valid({ ...make['doc.revoke'](), blob: make['doc.create']().blob })).toBe(false);
    expect(valid({ ...make['doc.revoke'](), commitment: H('d') })).toBe(false);
  });
  it('doc.update has no listed flag', () => {
    expect(valid({ ...make['doc.update'](), listed: true })).toBe(false);
  });
  it('blob size boundaries', () => {
    for (const t of ['doc.create', 'doc.update']) {
      const withSize = (size) => ({ ...make[t](), blob: { hash: H('c'), size, suite: 1 } });
      expect(valid(withSize(1)), t).toBe(true);
      expect(valid(withSize(0)), t).toBe(false);
      expect(valid(withSize(-5)), t).toBe(false);
      expect(valid(withSize(20971520 + 4096)), t).toBe(true);
      expect(valid(withSize(20971520 + 4097)), t).toBe(false);
      expect(valid(withSize(1.5)), t).toBe(false);
      expect(valid(withSize('100')), t).toBe(false);
    }
  });
  it('blob shape is exact', () => {
    const t = 'doc.create';
    expect(valid({ ...make[t](), blob: { hash: H('c'), size: 5 } })).toBe(false);
    expect(valid({ ...make[t](), blob: { hash: H('c'), size: 5, suite: 2 } })).toBe(false);
    expect(valid({ ...make[t](), blob: { hash: H('c'), size: 5, suite: 1, x: 1 } })).toBe(false);
    expect(valid({ ...make[t](), blob: { hash: 'c'.repeat(63), size: 5, suite: 1 } })).toBe(false);
    expect(valid({ ...make[t](), blob: 'blob' })).toBe(false);
    expect(valid({ ...make[t](), blob: null })).toBe(false);
    expect(valid({ ...make[t](), commitment: 'd'.repeat(63) })).toBe(false);
  });
});

describe('channel and message records', () => {
  it('channel id pattern', () => {
    const ok = ['abc', 'a-b', '0ab', 'a'.repeat(40), 'general', 'a1-2-3'];
    const bad = ['ab', 'a'.repeat(41), '-abc', 'ABC', 'a_b', 'a b', 'a.b', '', 'abc\n'];
    for (const id of ok) expect(valid({ ...make['channel.create'](), channelId: id }), id).toBe(true);
    for (const id of bad) expect(valid({ ...make['channel.create'](), channelId: id }), id).toBe(false);
    for (const id of bad) expect(valid({ ...make.message(), channelId: id }), id).toBe(false);
  });
  it('title boundaries and blank titles', () => {
    expect(valid({ ...make['channel.create'](), title: 't' })).toBe(true);
    expect(valid({ ...make['channel.create'](), title: 't'.repeat(60) })).toBe(true);
    expect(valid({ ...make['channel.create'](), title: 't'.repeat(61) })).toBe(false);
    expect(valid({ ...make['channel.create'](), title: '' })).toBe(false);
    expect(valid({ ...make['channel.create'](), title: '  ' })).toBe(false);
  });
  it('channel docId is empty or 32 hex', () => {
    expect(valid({ ...make['channel.create'](), docId: '' })).toBe(true);
    expect(valid({ ...make['channel.create'](), docId: 'a'.repeat(32) })).toBe(true);
    expect(valid({ ...make['channel.create'](), docId: 'a'.repeat(31) })).toBe(false);
    expect(valid({ ...make['channel.create'](), docId: ' ' })).toBe(false);
  });
  it('message body boundaries (1..2000) and newlines', () => {
    expect(valid({ ...make.message(), body: 'x' })).toBe(true);
    expect(valid({ ...make.message(), body: 'x'.repeat(2000) })).toBe(true);
    expect(valid({ ...make.message(), body: 'x'.repeat(2001) })).toBe(false);
    expect(valid({ ...make.message(), body: '' })).toBe(false);
    expect(valid({ ...make.message(), body: ' \n ' })).toBe(false);
    expect(valid({ ...make.message(), body: 'line one\nline two' })).toBe(true);
  });
  it('message body rejects other control characters', () => {
    for (const body of ['a\rb', 'a\tb', 'a\u0000b', 'a' + code(0x1b) + 'b', 'a' + code(0x7f), 'a' + code(0x9f), code(0xd83d), 'e' + code(0x301)]) {
      expect(valid({ ...make.message(), body }), JSON.stringify(body)).toBe(false);
    }
  });
  it('replyTo is empty or 64 hex', () => {
    expect(valid({ ...make.message(), replyTo: H('a') })).toBe(true);
    expect(valid({ ...make.message(), replyTo: 'a'.repeat(63) })).toBe(false);
    expect(valid({ ...make.message(), replyTo: H('A') })).toBe(false);
  });
  it('nonce is 32 hex', () => {
    expect(valid({ ...make.message(), nonce: 'f'.repeat(31) })).toBe(false);
    expect(valid({ ...make.message(), nonce: 'F'.repeat(32) })).toBe(false);
    expect(valid({ ...make.message(), nonce: '' })).toBe(false);
  });
});

describe('blob.put and checkpoint', () => {
  it('blob.put size boundaries', () => {
    expect(valid({ ...make['blob.put'](), size: 0 })).toBe(false);
    expect(valid({ ...make['blob.put'](), size: 1 })).toBe(true);
    expect(valid({ ...make['blob.put'](), size: 20971520 + 4096 })).toBe(true);
    expect(valid({ ...make['blob.put'](), size: 20971520 + 4097 })).toBe(false);
  });
  it('checkpoint scope, seq and hash rules', () => {
    const cp = make.checkpoint;
    expect(valid({ ...cp(), scope: 'channel:town-hall' })).toBe(true);
    expect(valid({ ...cp(), scope: 'channel:ab' })).toBe(false);
    expect(valid({ ...cp(), scope: 'channel:' })).toBe(false);
    expect(valid({ ...cp(), scope: 'other' })).toBe(false);
    expect(valid({ ...cp(), scope: 'Ledger' })).toBe(false);
    expect(valid({ ...cp(), seq: -1 })).toBe(false);
    expect(valid({ ...cp(), seq: 0, hash: ZERO_HASH })).toBe(true);
    expect(valid({ ...cp(), seq: 0, hash: H('a') })).toBe(false);
    expect(valid({ ...cp(), hash: 'a'.repeat(63) })).toBe(false);
    expect(valid({ ...cp(), serverKeyId: 'x' })).toBe(false);
  });
});

describe('hashes and ids', () => {
  it('recordHash is sha256 of the canonical record and ignores key order', async () => {
    const r = make.message();
    expect(await recordHash(r)).toBe(await sha256Hex(canonicalize(r)));
    const reordered = Object.fromEntries(Object.entries(r).reverse());
    expect(await recordHash(reordered)).toBe(await recordHash(r));
    expect(await messageHash(r)).toBe(await recordHash(r));
  });
  it('recordHash changes with any field', async () => {
    const r = make['doc.create']();
    const base = await recordHash(r);
    expect(await recordHash({ ...r, label: 'Lease!' })).not.toBe(base);
    expect(await recordHash({ ...r, listed: false })).not.toBe(base);
    expect(await recordHash({ ...r, blob: { ...r.blob, size: 101 } })).not.toBe(base);
  });
  it('recordHash throws on non canonical records', () => {
    expect(() => recordHash({ a: 1.5 })).toThrow();
  });
  it('chainHash is re-exported and works for the genesis link', async () => {
    expect(await chainHash(ZERO_HASH, H('a'))).toBe(await sha256Hex(ZERO_HASH + ':' + H('a')));
  });
  it('newDocId and newNonce are 32 hex and random', () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      const a = newDocId();
      const n = newNonce();
      expect(a).toMatch(/^[0-9a-f]{32}$/);
      expect(n).toMatch(/^[0-9a-f]{32}$/);
      ids.add(a);
      ids.add(n);
    }
    expect(ids.size).toBe(100);
  });
});
