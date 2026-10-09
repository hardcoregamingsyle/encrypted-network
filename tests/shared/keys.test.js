import { beforeAll, describe, expect, it } from 'vitest';
import {
  exportPrivateJwk,
  exportPublicJwk,
  generateKeyPair,
  importPrivateJwk,
  importPublicJwk,
  keyIdOf,
  normalizePublicJwk,
  normalizePublicJwkShape,
  publicJwkFromPrivate,
  signRecord,
  signedBytes,
  verifyRecord
} from '../../shared/keys.js';
import { sha256Hex } from '../../shared/hash.js';
import { base64UrlToBytes, bytesToBase64Url, bytesToHex } from '../../shared/encoding.js';
import { recordHash } from '../../shared/records.js';

// A fixed vector made once with this library, so format changes are caught.
const VECTOR = {
  pub: { kty: 'EC', crv: 'P-256', x: 'wQFxF_QpYgcJdh-G8iJ2WJBrT6FH3fFD0yvBeAq76do', y: 'KUrBWVdDS8dMtv8kbd4h0-WmOwkMY94PyqieHcnfYVc' },
  keyId: '8c8832254fa3f3d70d43c9c676e0de7b1c43fe61db5b9b96f34a3d82984862d9',
  rec: {
    v: 2,
    type: 'blob.put',
    hash: 'ab'.repeat(32),
    size: 1234,
    signer: '8c8832254fa3f3d70d43c9c676e0de7b1c43fe61db5b9b96f34a3d82984862d9',
    createdAt: 1700000000000
  },
  sig: 'OypWu1DfrGE0ysm4Bc3VQLLJKXOpDQN-ifS3IOiCsu03FKlR7HQLEKQoSoSCdBl5lUmpvCMyREovjQ_TxoK0Uw',
  recordHash: '7cd94e08610deb81d6deaebc2bb672a0f9c5ae0b0e6f0717a530abe74dcff871'
};

let pair;
let pub;
let other;
let otherPub;
const sample = () => ({ v: 2, type: 'message', channelId: 'general', body: 'hello', replyTo: '', signer: 'a'.repeat(64), createdAt: 1700000000000, nonce: 'b'.repeat(32) });

beforeAll(async () => {
  pair = await generateKeyPair();
  pub = await exportPublicJwk(pair.publicKey);
  other = await generateKeyPair();
  otherPub = await exportPublicJwk(other.publicKey);
});

describe('fixed vector', () => {
  it('keyId, record hash and signature verify', async () => {
    expect(await keyIdOf(VECTOR.pub)).toBe(VECTOR.keyId);
    expect(await recordHash(VECTOR.rec)).toBe(VECTOR.recordHash);
    expect(await verifyRecord(VECTOR.pub, VECTOR.rec, VECTOR.sig)).toBe(true);
  });
  it('signed bytes start with the domain tag', () => {
    const bytes = signedBytes(VECTOR.rec);
    const head = new TextDecoder().decode(bytes.subarray(0, 'hrdlock/v2/blob.put\n'.length));
    expect(head).toBe('hrdlock/v2/blob.put\n');
  });
});

describe('key generation and export', () => {
  it('private keys are not extractable by default, public keys export', async () => {
    expect(pair.privateKey.extractable).toBe(false);
    await expect(exportPrivateJwk(pair.privateKey)).rejects.toThrow();
    expect(Object.keys(pub).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(pub.kty).toBe('EC');
    expect(pub.crv).toBe('P-256');
    expect(pub.x).toHaveLength(43);
    expect(pub.y).toHaveLength(43);
  });
  it('extractable keys round trip through private jwk', async () => {
    const p = await generateKeyPair({ extractable: true });
    const jwk = await exportPrivateJwk(p.privateKey);
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'd', 'kty', 'x', 'y']);
    const back = await importPrivateJwk(jwk, { extractable: false });
    expect(back.extractable).toBe(false);
    const pubJwk = await exportPublicJwk(p.publicKey);
    expect(publicJwkFromPrivate(jwk)).toEqual(pubJwk);
    const rec = sample();
    const sig = await signRecord(back, rec);
    expect(await verifyRecord(pubJwk, rec, sig)).toBe(true);
    const again = await importPrivateJwk(jwk, { extractable: true });
    expect((await exportPrivateJwk(again)).d).toBe(jwk.d);
  });
  it('importPrivateJwk rejects bad input', async () => {
    const p = await generateKeyPair({ extractable: true });
    const jwk = await exportPrivateJwk(p.privateKey);
    await expect(importPrivateJwk({ ...jwk, extra: 1 })).rejects.toThrow();
    const { d, ...noD } = jwk;
    await expect(importPrivateJwk(noD)).rejects.toThrow();
    await expect(importPrivateJwk({ ...jwk, d: 'short' })).rejects.toThrow();
    await expect(importPrivateJwk({ ...jwk, crv: 'P-384' })).rejects.toThrow();
    await expect(importPrivateJwk(null)).rejects.toThrow();
    await expect(importPrivateJwk('x')).rejects.toThrow();
    await expect(importPrivateJwk({ ...jwk, d: 'A'.repeat(43) })).rejects.toThrow();
  });
});

describe('normalizePublicJwk and keyId', () => {
  it('returns the clean 4 field key', async () => {
    expect(await normalizePublicJwk(pub)).toEqual(pub);
    expect(normalizePublicJwkShape(pub)).toEqual(pub);
  });
  it('rejects extra fields, wrong curve and type, bad lengths and non objects', async () => {
    const bad = [
      { ...pub, ext: true },
      { ...pub, key_ops: ['verify'] },
      { ...pub, d: pub.x },
      { ...pub, crv: 'P-384' },
      { ...pub, kty: 'RSA' },
      { ...pub, x: pub.x.slice(1) },
      { ...pub, y: pub.y + 'A' },
      { ...pub, x: '' },
      { ...pub, x: 5 },
      { kty: 'EC', crv: 'P-256', x: pub.x },
      { ...pub, x: pub.x.slice(0, 42) + '=' },
      { ...pub, x: pub.x.slice(0, 42) + '+' },
      null,
      undefined,
      'jwk',
      [],
      42
    ];
    for (const jwk of bad) {
      expect(() => normalizePublicJwkShape(jwk)).toThrow();
      await expect(normalizePublicJwk(jwk)).rejects.toThrow();
      await expect(importPublicJwk(jwk)).rejects.toThrow();
      await expect(keyIdOf(jwk)).rejects.toThrow();
    }
  });
  it('rejects a point that is not on the curve', async () => {
    const off = { ...pub, y: bytesToBase64Url(new Uint8Array(32).fill(1)) };
    expect(() => normalizePublicJwkShape(off)).not.toThrow();
    await expect(normalizePublicJwk(off)).rejects.toThrow();
    await expect(keyIdOf(off)).rejects.toThrow();
    expect(await verifyRecord(off, sample(), VECTOR.sig)).toBe(false);
  });
  it('keyId is sha256 of the canonical jwk', async () => {
    const text = `{"crv":"P-256","kty":"EC","x":"${pub.x}","y":"${pub.y}"}`;
    expect(await keyIdOf(pub)).toBe(await sha256Hex(text));
    expect(await keyIdOf(pub)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('keyId does not depend on field order and differs per key', async () => {
    const shuffled = { y: pub.y, x: pub.x, crv: pub.crv, kty: pub.kty };
    expect(await keyIdOf(shuffled)).toBe(await keyIdOf(pub));
    expect(await keyIdOf(otherPub)).not.toBe(await keyIdOf(pub));
  });
});

describe('sign and verify', () => {
  it('signature is 86 chars base64url of 64 bytes', async () => {
    const sig = await signRecord(pair.privateKey, sample());
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(base64UrlToBytes(sig)).toHaveLength(64);
  });
  it('verifies a good signature', async () => {
    const rec = sample();
    expect(await verifyRecord(pub, rec, await signRecord(pair.privateKey, rec))).toBe(true);
  });
  it('is not sensitive to key order of the record', async () => {
    const rec = sample();
    const sig = await signRecord(pair.privateKey, rec);
    const reordered = Object.fromEntries(Object.entries(rec).reverse());
    expect(await verifyRecord(pub, reordered, sig)).toBe(true);
  });
  it('fails when any field is changed', async () => {
    const rec = sample();
    const sig = await signRecord(pair.privateKey, rec);
    const changes = {
      v: 3,
      type: 'blob.put',
      channelId: 'other',
      body: 'hellO',
      replyTo: 'c'.repeat(64),
      signer: 'b'.repeat(64),
      createdAt: rec.createdAt + 1,
      nonce: 'c'.repeat(32)
    };
    for (const [k, v] of Object.entries(changes)) {
      expect(await verifyRecord(pub, { ...rec, [k]: v }, sig), k).toBe(false);
    }
  });
  it('fails when a field is added or removed', async () => {
    const rec = sample();
    const sig = await signRecord(pair.privateKey, rec);
    expect(await verifyRecord(pub, { ...rec, extra: 1 }, sig)).toBe(false);
    const { nonce, ...rest } = rec;
    expect(await verifyRecord(pub, rest, sig)).toBe(false);
  });
  it('binds the signature to the record type (domain separation)', async () => {
    // Same fields but another type tag must not verify, even if the JSON were equal.
    const rec = { v: 2, type: 'a.one', x: 1 };
    const sig = await signRecord(pair.privateKey, rec);
    expect(await verifyRecord(pub, { ...rec, type: 'a.two' }, sig)).toBe(false);
  });
  it('fails with the wrong key', async () => {
    const rec = sample();
    const sig = await signRecord(pair.privateKey, rec);
    expect(await verifyRecord(otherPub, rec, sig)).toBe(false);
  });
  it('fails on any flipped bit of the signature', async () => {
    const rec = sample();
    const sig = await signRecord(pair.privateKey, rec);
    const bytes = base64UrlToBytes(sig);
    for (const i of [0, 1, 31, 32, 33, 63]) {
      const copy = bytes.slice();
      copy[i] ^= 1;
      expect(await verifyRecord(pub, rec, bytesToBase64Url(copy)), 'byte ' + i).toBe(false);
    }
  });
  it('rejects malformed signatures without throwing', async () => {
    const rec = sample();
    const sig = await signRecord(pair.privateKey, rec);
    const bad = [
      '',
      'abc',
      sig.slice(1),
      sig + 'A',
      sig + '=',
      sig.slice(0, 85) + '+',
      sig.slice(0, 85) + '*',
      sig.slice(0, 85) + 'B', // non zero trailing bits
      bytesToBase64Url(new Uint8Array(64)), // r = s = 0
      bytesToBase64Url(new Uint8Array(63)),
      bytesToBase64Url(new Uint8Array(65)),
      null,
      undefined,
      42,
      {},
      [sig]
    ];
    for (const s of bad) expect(await verifyRecord(pub, rec, s), String(s)).toBe(false);
  });
  it('verifyRecord never throws on bad keys or records', async () => {
    const sig = await signRecord(pair.privateKey, sample());
    expect(await verifyRecord(null, sample(), sig)).toBe(false);
    expect(await verifyRecord({ ...pub, ext: true }, sample(), sig)).toBe(false);
    expect(await verifyRecord(pub, null, sig)).toBe(false);
    expect(await verifyRecord(pub, { v: 2 }, sig)).toBe(false);
    expect(await verifyRecord(pub, { type: 5 }, sig)).toBe(false);
    expect(await verifyRecord(pub, { type: 'x', f: 1.5 }, sig)).toBe(false);
    expect(await verifyRecord(pub, { type: 'x', f: undefined }, sig)).toBe(false);
  });
  it('signRecord requires a string type and canonical content', async () => {
    await expect(signRecord(pair.privateKey, { v: 2 })).rejects.toThrow();
    await expect(signRecord(pair.privateKey, { type: 5 })).rejects.toThrow();
    await expect(signRecord(pair.privateKey, null)).rejects.toThrow();
    await expect(signRecord(pair.privateKey, { type: 'x', n: 1.5 })).rejects.toThrow();
    await expect(signRecord(pair.privateKey, { type: 'x', n: undefined })).rejects.toThrow();
  });
  it('a verify only key cannot sign', async () => {
    await expect(signRecord(pair.publicKey, sample())).rejects.toThrow();
  });
  it('signed bytes include type tag and canonical record', () => {
    const rec = { type: 'x', b: 1, a: 2 };
    const text = new TextDecoder().decode(signedBytes(rec));
    expect(text).toBe('hrdlock/v2/x\n{"a":2,"b":1,"type":"x"}');
    expect(bytesToHex(signedBytes(rec)).length).toBe(text.length * 2);
  });
});
