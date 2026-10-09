// Adversarial review of keys, signatures and checkpoints.
import { describe, expect, it } from 'vitest';
import {
  generateKeyPair,
  exportPublicJwk,
  importPrivateJwk,
  exportPrivateJwk,
  keyIdOf,
  normalizePublicJwk,
  signRecord,
  signedBytes,
  verifyRecord
} from '../../../shared/keys.js';
import { signCheckpoint, verifyCheckpoint, makeCheckpointPayload } from '../../../shared/checkpoint.js';
import { base64UrlToBytes, bytesToBase64Url, concatBytes, utf8Encode } from '../../../shared/encoding.js';
import { canonicalBytes } from '../../../shared/canonical.js';
import { createIdentity, createServerKey } from '../../helpers/bundle.js';

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const big = (bytes) => BigInt('0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''));
const toBytes32 = (n) => {
  const h = n.toString(16).padStart(64, '0');
  return Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
};

const record = (signer) => ({ v: 2, type: 'blob.put', hash: 'b'.repeat(64), size: 10, signer, createdAt: 1000 });

describe('signature text handling', () => {
  it('rejects wrong lengths, padding, whitespace, other alphabets and non string values', async () => {
    const a = await createIdentity('A');
    const r = record(a.keyId);
    const sig = await signRecord(a.privateKey, r);
    expect(sig).toHaveLength(86);
    expect(await verifyRecord(a.publicJwk, r, sig)).toBe(true);
    const bad = [
      sig.slice(0, 85),
      sig + 'A',
      sig + '==',
      sig + '\n',
      ' ' + sig,
      '+' + sig.slice(1), // (a replace of - or _ did nothing when the signature had neither, a random failure)
      sig.slice(0, 85) + '=',
      '',
      null,
      undefined,
      5,
      [sig],
      { toString: () => sig },
      new String(sig),
      'A'.repeat(86),
      sig.toUpperCase()
    ];
    for (const b of bad) expect(await verifyRecord(a.publicJwk, r, b), String(b)).toBe(false);
  });

  it('rejects a second text encoding of the same 64 bytes (trailing bits)', async () => {
    const a = await createIdentity('A');
    const r = record(a.keyId);
    const sig = await signRecord(a.privateKey, r);
    // The last char carries 2 data bits and 4 padding bits. Alter only the padding bits.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const idx = alphabet.indexOf(sig[85]);
    const altered = sig.slice(0, 85) + alphabet[idx ^ 1];
    expect(base64UrlToBytes(sig)).toBeDefined();
    expect(await verifyRecord(a.publicJwk, r, altered)).toBe(false);
  });

  it('degenerate signatures never verify and never throw', async () => {
    const a = await createIdentity('A');
    const r = record(a.keyId);
    const zeros = bytesToBase64Url(new Uint8Array(64));
    const ones = bytesToBase64Url(new Uint8Array(64).fill(255));
    const nR = bytesToBase64Url(concatBytes(toBytes32(N), toBytes32(1n)));
    const nS = bytesToBase64Url(concatBytes(toBytes32(1n), toBytes32(N)));
    const zeroS = bytesToBase64Url(concatBytes(toBytes32(5n), toBytes32(0n)));
    for (const s of [zeros, ones, nR, nS, zeroS]) expect(await verifyRecord(a.publicJwk, r, s)).toBe(false);
  });

  it('ECDSA malleability: the (r, n-s) twin verifies, which is harmless only because signatures are never hashed', async () => {
    const a = await createIdentity('A');
    const r = record(a.keyId);
    const sig = base64UrlToBytes(await signRecord(a.privateKey, r));
    const rr = big(sig.slice(0, 32));
    const s = big(sig.slice(32));
    const twin = bytesToBase64Url(concatBytes(toBytes32(rr), toBytes32(N - s)));
    expect(await verifyRecord(a.publicJwk, r, twin)).toBe(true);
  });
});

describe('domain separation and key binding', () => {
  it('a signature over the bare canonical bytes (no type tag) is not accepted', async () => {
    const a = await createIdentity('A');
    const r = record(a.keyId);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, a.privateKey, canonicalBytes(r)));
    expect(await verifyRecord(a.publicJwk, r, bytesToBase64Url(raw))).toBe(false);
  });

  it('a signature made with another type tag or version prefix is not accepted', async () => {
    const a = await createIdentity('A');
    const r = record(a.keyId);
    for (const tag of ['hrdlock/v2/message\n', 'hrdlock/v1/blob.put\n', 'hrdlock/v2/blob.put', 'hrdlock/v2/blob.put\n\n', 'HRDLOCK/V2/blob.put\n']) {
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, a.privateKey, concatBytes(utf8Encode(tag), canonicalBytes(r))));
      expect(await verifyRecord(a.publicJwk, r, bytesToBase64Url(raw)), tag).toBe(false);
    }
  });

  it('a signature for one record type does not verify for the same fields under another type', async () => {
    const a = await createIdentity('A');
    const m = { v: 2, type: 'message', channelId: 'room-1', body: 'hi', replyTo: '', signer: a.keyId, createdAt: 1, nonce: 'f'.repeat(32) };
    const sig = await signRecord(a.privateKey, m);
    for (const type of ['identity', 'doc.create', 'doc.update', 'doc.revoke', 'channel.create', 'blob.put', 'checkpoint', 'Message', 'message ']) {
      expect(await verifyRecord(a.publicJwk, { ...m, type }, sig), type).toBe(false);
    }
  });

  it('signed bytes cannot be confused across types even when the type contains a newline', () => {
    const one = signedBytes({ type: 'a\nb', x: 1 });
    const two = signedBytes({ type: 'a', x: 1 });
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
    expect(() => signedBytes({ type: 5 })).toThrow();
    expect(() => signedBytes(null)).toThrow();
  });

  it('a signature does not verify under another key, nor under a key id derived from a different jwk', async () => {
    const a = await createIdentity('A');
    const b = await createIdentity('B');
    const r = record(a.keyId);
    const sig = await signRecord(a.privateKey, r);
    expect(await verifyRecord(b.publicJwk, r, sig)).toBe(false);
    expect(a.keyId).not.toBe(b.keyId);
  });

  it('checkpoint signed by a user key is not a valid checkpoint for the server key and vice versa', async () => {
    const server = await createServerKey();
    const user = await createIdentity('User');
    const payload = makeCheckpointPayload({ scope: 'ledger', seq: 2, hash: 'a'.repeat(64), signedAt: 1, serverKeyId: server.keyId });
    const cp = await signCheckpoint(server.privateKey, payload);
    expect(await verifyCheckpoint(server.publicJwk, cp)).toBe(true);
    expect(await verifyCheckpoint(user.publicJwk, cp)).toBe(false);
    // a user signing a payload that names the server key id
    const forged = { payload, signature: await signRecord(user.privateKey, payload) };
    expect(await verifyCheckpoint(server.publicJwk, forged)).toBe(false);
    expect(await verifyCheckpoint(user.publicJwk, forged)).toBe(false);
  });
});

describe('public key handling', () => {
  async function base() {
    const { publicKey } = await generateKeyPair();
    return exportPublicJwk(publicKey);
  }

  it('rejects every kind of extra, missing or wrong field', async () => {
    const jwk = await base();
    const bad = [
      { ...jwk, alg: 'ES256' },
      { ...jwk, ext: true },
      { ...jwk, key_ops: ['verify'] },
      { ...jwk, kid: 'x' },
      { ...jwk, use: 'sig' },
      { ...jwk, d: jwk.x },
      { ...jwk, kty: 'OKP' },
      { ...jwk, crv: 'P-384' },
      { ...jwk, crv: 'secp256k1' },
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      { kty: jwk.kty, crv: jwk.crv, y: jwk.y },
      { ...jwk, x: jwk.x + 'A' },
      { ...jwk, x: jwk.x.slice(1) },
      { ...jwk, x: jwk.x.slice(0, 42) + '=' },
      { ...jwk, y: 5 },
      { ...jwk, x: null },
      [jwk],
      null,
      'jwk',
      Object.assign(Object.create({ kty: 'EC' }), { crv: jwk.crv, x: jwk.x, y: jwk.y })
    ];
    for (const b of bad) {
      await expect(normalizePublicJwk(b), JSON.stringify(b)).rejects.toThrow();
      await expect(keyIdOf(b)).rejects.toThrow();
      expect(await verifyRecord(b, record('a'.repeat(64)), 'A'.repeat(86))).toBe(false);
    }
  });

  it('rejects points that are not on the curve even though the text looks fine', async () => {
    const jwk = await base();
    const xs = [
      { ...jwk, y: jwk.x },
      { ...jwk, x: jwk.y, y: jwk.x },
      { ...jwk, x: 'A'.repeat(43), y: 'A'.repeat(43) },
      { ...jwk, x: '_'.repeat(42) + 'w', y: jwk.y }
    ];
    for (const j of xs) {
      await expect(keyIdOf(j)).rejects.toThrow();
      expect(await verifyRecord(j, record('a'.repeat(64)), bytesToBase64Url(new Uint8Array(64).fill(1)))).toBe(false);
    }
    // y off by one bit
    const bytes = base64UrlToBytes(jwk.y);
    bytes[31] ^= 1;
    await expect(keyIdOf({ ...jwk, y: bytesToBase64Url(bytes) })).rejects.toThrow();
  });

  it('key id is stable under property order and prototype shape, and is lowercase hex', async () => {
    const jwk = await base();
    const reordered = { y: jwk.y, x: jwk.x, crv: jwk.crv, kty: jwk.kty };
    const nullProto = Object.assign(Object.create(null), jwk);
    const id = await keyIdOf(jwk);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await keyIdOf(reordered)).toBe(id);
    expect(await keyIdOf(nullProto)).toBe(id);
  });

  it('key id differs for every key and the exported jwk never carries private data', async () => {
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      const { publicKey } = await generateKeyPair();
      const j = await exportPublicJwk(publicKey);
      expect(Object.keys(j).sort()).toEqual(['crv', 'kty', 'x', 'y']);
      ids.add(await keyIdOf(j));
    }
    expect(ids.size).toBe(5);
  });

  it('non canonical coordinate encodings (x + p) are not accepted as aliases of a key', async () => {
    const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
    const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
    const pow = (a, e, m) => {
      let r = 1n;
      a %= m;
      while (e > 0n) {
        if (e & 1n) r = (r * a) % m;
        a = (a * a) % m;
        e >>= 1n;
      }
      return r;
    };
    for (let x = 1n; x < 100n; x++) {
      const rhs = (x ** 3n - 3n * x + b) % p;
      const y = pow(rhs, (p + 1n) / 4n, p);
      if ((y * y) % p !== rhs) continue;
      const enc = (n) => bytesToBase64Url(toBytes32(n));
      const plain = { kty: 'EC', crv: 'P-256', x: enc(x), y: enc(y) };
      await keyIdOf(plain); // the small point itself is a valid key
      await expect(keyIdOf({ ...plain, x: enc(x + p) })).rejects.toThrow();
      await expect(keyIdOf({ ...plain, y: enc(y + p) })).rejects.toThrow();
      return;
    }
    throw new Error('no small point found');
  });
});

describe('private key import', () => {
  it('requires the exact private field set and round trips', async () => {
    const { privateKey, publicKey } = await generateKeyPair({ extractable: true });
    const priv = await exportPrivateJwk(privateKey);
    const pub = await exportPublicJwk(publicKey);
    expect(Object.keys(priv).sort()).toEqual(['crv', 'd', 'kty', 'x', 'y']);
    const again = await importPrivateJwk(priv, { extractable: false });
    const sig = await signRecord(again, record('a'.repeat(64)));
    expect(await verifyRecord(pub, record('a'.repeat(64)), sig)).toBe(true);
    await expect(importPrivateJwk({ ...priv, alg: 'ES256' })).rejects.toThrow();
    await expect(importPrivateJwk({ ...priv, d: undefined })).rejects.toThrow();
    await expect(importPrivateJwk({ ...priv, d: priv.d.slice(1) })).rejects.toThrow();
    await expect(importPrivateJwk({ kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y })).rejects.toThrow();
    await expect(importPrivateJwk(null)).rejects.toThrow();
    // a non extractable key cannot be exported
    await expect(exportPrivateJwk(again)).rejects.toThrow();
  });

  it('a private jwk whose x,y do not belong to d must not produce keys that sign for the claimed public key', async () => {
    const one = await generateKeyPair({ extractable: true });
    const two = await generateKeyPair({ extractable: true });
    const p1 = await exportPrivateJwk(one.privateKey);
    const p2 = await exportPrivateJwk(two.privateKey);
    const mixed = { ...p1, d: p2.d };
    let key = null;
    try {
      key = await importPrivateJwk(mixed);
    } catch {
      return; // refusing is the best outcome
    }
    // if it imported, the claimed public key must still not verify its signatures
    const sig = await signRecord(key, record('a'.repeat(64)));
    const claimed = await exportPublicJwk(one.publicKey);
    expect(await verifyRecord(claimed, record('a'.repeat(64)), sig)).toBe(false);
  });
});

describe('checkpoints', () => {
  it('rejects tampering with each payload field and malformed containers without throwing', async () => {
    const server = await createServerKey();
    const payload = makeCheckpointPayload({ scope: 'channel:general', seq: 4, hash: 'a'.repeat(64), signedAt: 100, serverKeyId: server.keyId });
    const cp = await signCheckpoint(server.privateKey, payload);
    expect(await verifyCheckpoint(server.publicJwk, cp)).toBe(true);
    const edits = [
      { scope: 'ledger' },
      { scope: 'channel:general2' },
      { seq: 5 },
      { hash: 'b'.repeat(64) },
      { signedAt: 101 },
      { serverKeyId: 'c'.repeat(64) }
    ];
    for (const e of edits) {
      expect(await verifyCheckpoint(server.publicJwk, { payload: { ...payload, ...e }, signature: cp.signature })).toBe(false);
    }
    for (const bad of [null, undefined, 5, 'x', [], {}, { payload: null }, { payload, signature: 5 }, { payload: [], signature: cp.signature }, { signature: cp.signature }]) {
      expect(await verifyCheckpoint(server.publicJwk, bad)).toBe(false);
    }
    expect(await verifyCheckpoint(null, cp)).toBe(false);
    expect(await verifyCheckpoint({}, cp)).toBe(false);
  });

  it('signCheckpoint refuses invalid payloads', async () => {
    const server = await createServerKey();
    const good = makeCheckpointPayload({ scope: 'ledger', seq: 1, hash: 'a'.repeat(64), signedAt: 1, serverKeyId: server.keyId });
    for (const bad of [{ ...good, extra: 1 }, { ...good, scope: 'doc:x' }, { ...good, seq: -1 }, { ...good, type: 'message' }]) {
      await expect(signCheckpoint(server.privateKey, bad)).rejects.toThrow();
    }
  });
});
