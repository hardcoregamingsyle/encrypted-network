// Server key loading and checkpoint signing helpers.
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyCheckpoint } from '../../shared/checkpoint.js';
import { exportPrivateJwk, generateKeyPair, keyIdOf, publicJwkFromPrivate } from '../../shared/keys.js';
import { ZERO_HASH } from '../../shared/encoding.js';
import { ApiError } from '../../functions/_lib/errors.js';
import {
  loadServerKey,
  parseServerKey,
  resetServerKeyCache,
  serverInfo,
  signDocHead,
  signScope
} from '../../functions/_lib/serverKey.js';

async function freshJwk() {
  const { privateKey } = await generateKeyPair({ extractable: true });
  return exportPrivateJwk(privateKey);
}

beforeEach(() => resetServerKeyCache());

describe('parseServerKey', () => {
  it('reads a private JWK string into a usable signing key', async () => {
    const jwk = await freshJwk();
    const key = await parseServerKey(JSON.stringify(jwk));
    expect(key.publicJwk).toEqual(publicJwkFromPrivate(jwk));
    expect(key.keyId).toBe(await keyIdOf(key.publicJwk));
    expect(key.privateKey.extractable).toBe(false);
    expect(Object.keys(key.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
  });

  it('refuses text that is not JSON, not a key, or not a private key', async () => {
    const jwk = await freshJwk();
    await expect(parseServerKey('not json')).rejects.toThrow();
    await expect(parseServerKey('{}')).rejects.toThrow();
    await expect(parseServerKey('[]')).rejects.toThrow();
    const { d, ...publicOnly } = jwk; // eslint-disable-line no-unused-vars
    await expect(parseServerKey(JSON.stringify(publicOnly))).rejects.toThrow();
    await expect(parseServerKey(JSON.stringify({ ...jwk, extra: 1 }))).rejects.toThrow();
    await expect(parseServerKey(JSON.stringify({ ...jwk, crv: 'P-384' }))).rejects.toThrow();
  });
});

describe('loadServerKey', () => {
  it('returns null without a key (missing, empty or blank)', async () => {
    expect(await loadServerKey({})).toBe(null);
    expect(await loadServerKey({ SERVER_SIGNING_JWK: '' })).toBe(null);
    expect(await loadServerKey({ SERVER_SIGNING_JWK: '   ' })).toBe(null);
    expect(await loadServerKey(undefined)).toBe(null);
    expect(await loadServerKey({ SERVER_SIGNING_JWK: 42 })).toBe(null);
  });

  it('loads the key and remembers it per isolate', async () => {
    const text = JSON.stringify(await freshJwk());
    const a = await loadServerKey({ SERVER_SIGNING_JWK: text });
    const b = await loadServerKey({ SERVER_SIGNING_JWK: text });
    expect(a).toBe(b);
    expect(a.keyId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('loads a different key when the secret changes', async () => {
    const a = await loadServerKey({ SERVER_SIGNING_JWK: JSON.stringify(await freshJwk()) });
    const b = await loadServerKey({ SERVER_SIGNING_JWK: JSON.stringify(await freshJwk()) });
    expect(a.keyId).not.toBe(b.keyId);
  });

  it('a broken key is a server error that does not leak details, and can recover', async () => {
    let err;
    try {
      await loadServerKey({ SERVER_SIGNING_JWK: '{"kty":"EC","secret":"leak-me"}' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('server_error');
    expect(err.message).not.toContain('leak-me');
    const good = await loadServerKey({ SERVER_SIGNING_JWK: JSON.stringify(await freshJwk()) });
    expect(good).not.toBe(null);
  });
});

describe('checkpoint signing', () => {
  it('returns null without a key', async () => {
    expect(await signScope(null, { scope: 'ledger', seq: 0, hash: ZERO_HASH })).toBe(null);
    expect(await signDocHead(null, { docId: 'a'.repeat(32), headVersion: 1, headRecordHash: 'b'.repeat(64) })).toBe(null);
    expect(serverInfo(null)).toBe(null);
  });

  it('signs a ledger checkpoint that verifies, and an empty chain uses seq 0', async () => {
    const key = await parseServerKey(JSON.stringify(await freshJwk()));
    const empty = await signScope(key, { scope: 'ledger', seq: 0, hash: 'f'.repeat(64) }, 1234);
    expect(empty.payload).toMatchObject({ scope: 'ledger', seq: 0, hash: ZERO_HASH, signedAt: 1234, serverKeyId: key.keyId });
    expect(await verifyCheckpoint(key.publicJwk, empty)).toBe(true);
    const some = await signScope(key, { scope: 'channel:room-1', seq: 5, hash: 'c'.repeat(64) });
    expect(some.payload.scope).toBe('channel:room-1');
    expect(some.payload.seq).toBe(5);
    expect(await verifyCheckpoint(key.publicJwk, some)).toBe(true);
    const other = await parseServerKey(JSON.stringify(await freshJwk()));
    expect(await verifyCheckpoint(other.publicJwk, some)).toBe(false);
  });

  it('signs a document head attestation', async () => {
    const key = await parseServerKey(JSON.stringify(await freshJwk()));
    const docId = 'd'.repeat(32);
    const cp = await signDocHead(key, { docId, headVersion: 3, headRecordHash: 'e'.repeat(64) }, 99);
    expect(cp.payload).toMatchObject({ scope: 'doc:' + docId, seq: 3, hash: 'e'.repeat(64), signedAt: 99 });
    expect(await verifyCheckpoint(key.publicJwk, cp)).toBe(true);
    const tampered = { ...cp, payload: { ...cp.payload, seq: 4 } };
    expect(await verifyCheckpoint(key.publicJwk, tampered)).toBe(false);
  });

  it('serverInfo shows the key id and public key only', async () => {
    const key = await parseServerKey(JSON.stringify(await freshJwk()));
    const info = serverInfo(key);
    expect(Object.keys(info).sort()).toEqual(['keyId', 'publicKey']);
    expect(info.publicKey.d).toBeUndefined();
  });
});
