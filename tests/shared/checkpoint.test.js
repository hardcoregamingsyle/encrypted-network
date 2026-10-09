import { beforeAll, describe, expect, it } from 'vitest';
import { makeCheckpointPayload, signCheckpoint, verifyCheckpoint } from '../../shared/checkpoint.js';
import { ZERO_HASH } from '../../shared/records.js';
import { createServerKey } from '../helpers/bundle.js';

let server;
let other;
const payload = (over = {}) => ({
  v: 2,
  type: 'checkpoint',
  scope: 'ledger',
  seq: 7,
  hash: 'a'.repeat(64),
  signedAt: 1700000000000,
  serverKeyId: server.keyId,
  ...over
});

beforeAll(async () => {
  server = await createServerKey();
  other = await createServerKey();
});

describe('signCheckpoint and verifyCheckpoint', () => {
  it('signs and verifies a ledger checkpoint', async () => {
    const cp = await signCheckpoint(server.privateKey, payload());
    expect(Object.keys(cp).sort()).toEqual(['payload', 'signature']);
    expect(cp.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(await verifyCheckpoint(server.publicJwk, cp)).toBe(true);
  });
  it('signs and verifies a channel checkpoint', async () => {
    const cp = await signCheckpoint(server.privateKey, payload({ scope: 'channel:town-hall' }));
    expect(await verifyCheckpoint(server.publicJwk, cp)).toBe(true);
  });
  it('accepts the empty chain checkpoint', async () => {
    const cp = await signCheckpoint(server.privateKey, payload({ seq: 0, hash: ZERO_HASH }));
    expect(await verifyCheckpoint(server.publicJwk, cp)).toBe(true);
  });
  it('fails when any payload field is changed', async () => {
    const cp = await signCheckpoint(server.privateKey, payload());
    const changes = { scope: 'channel:abc', seq: 8, hash: 'b'.repeat(64), signedAt: 1700000000001, serverKeyId: other.keyId };
    for (const [k, v] of Object.entries(changes)) {
      const bad = { ...cp, payload: { ...cp.payload, [k]: v } };
      expect(await verifyCheckpoint(server.publicJwk, bad), k).toBe(false);
    }
  });
  it('fails with the wrong server key', async () => {
    const cp = await signCheckpoint(server.privateKey, payload());
    expect(await verifyCheckpoint(other.publicJwk, cp)).toBe(false);
  });
  it('fails when serverKeyId names another key even if the signature is valid', async () => {
    const cp = await signCheckpoint(server.privateKey, payload({ serverKeyId: other.keyId }));
    expect(await verifyCheckpoint(server.publicJwk, cp)).toBe(false);
  });
  it('fails on a tampered or malformed signature', async () => {
    const cp = await signCheckpoint(server.privateKey, payload());
    const flipped = cp.signature.slice(0, 10) + (cp.signature[10] === 'A' ? 'B' : 'A') + cp.signature.slice(11);
    for (const signature of [flipped, '', 'x', cp.signature.slice(1), null, undefined, 5]) {
      expect(await verifyCheckpoint(server.publicJwk, { ...cp, signature })).toBe(false);
    }
  });
  it('fails on a checkpoint signed as another record type', async () => {
    // A signature over the same fields with another type tag must not count.
    const { signRecord } = await import('../../shared/keys.js');
    const p = payload();
    const sig = await signRecord(server.privateKey, { ...p, type: 'message' });
    expect(await verifyCheckpoint(server.publicJwk, { payload: p, signature: sig })).toBe(false);
  });
  it('never throws on malformed input', async () => {
    const cp = await signCheckpoint(server.privateKey, payload());
    for (const bad of [null, undefined, 5, 'x', [], {}, { payload: null }, { payload: {}, signature: cp.signature }, { payload: cp.payload }]) {
      expect(await verifyCheckpoint(server.publicJwk, bad)).toBe(false);
    }
    expect(await verifyCheckpoint(null, cp)).toBe(false);
    expect(await verifyCheckpoint({ ...server.publicJwk, ext: true }, cp)).toBe(false);
    expect(await verifyCheckpoint('key', cp)).toBe(false);
  });
  it('rejects extra payload fields', async () => {
    const cp = await signCheckpoint(server.privateKey, payload());
    const { signRecord } = await import('../../shared/keys.js');
    const extra = { ...cp.payload, note: 'x' };
    const signature = await signRecord(server.privateKey, extra);
    expect(await verifyCheckpoint(server.publicJwk, { payload: extra, signature })).toBe(false);
  });
  it('signCheckpoint refuses invalid payloads', async () => {
    await expect(signCheckpoint(server.privateKey, payload({ seq: -1 }))).rejects.toThrow();
    await expect(signCheckpoint(server.privateKey, payload({ scope: 'nope' }))).rejects.toThrow();
    await expect(signCheckpoint(server.privateKey, payload({ seq: 0 }))).rejects.toThrow();
    await expect(signCheckpoint(server.privateKey, { ...payload(), extra: 1 })).rejects.toThrow();
    await expect(signCheckpoint(server.privateKey, null)).rejects.toThrow();
  });
});

describe('makeCheckpointPayload', () => {
  it('builds a valid payload and uses the zero hash for an empty chain', async () => {
    const empty = makeCheckpointPayload({ scope: 'ledger', seq: 0, hash: 'f'.repeat(64), signedAt: 5, serverKeyId: server.keyId });
    expect(empty.hash).toBe(ZERO_HASH);
    expect(empty.seq).toBe(0);
    const cp = await signCheckpoint(server.privateKey, empty);
    expect(await verifyCheckpoint(server.publicJwk, cp)).toBe(true);
    const full = makeCheckpointPayload({ scope: 'ledger', seq: 3, hash: 'f'.repeat(64), signedAt: 5, serverKeyId: server.keyId });
    expect(full.hash).toBe('f'.repeat(64));
  });
});
