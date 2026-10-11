// src/lib/deviceKey.js and the slot helpers added to keystore.js: device keys with no passphrase.
import { beforeEach, describe, expect, it } from 'vitest';
import { exportPrivateJwk, generateKeyPair, verifyRecord } from '../../shared/keys.js';
import { validateRecord } from '../../shared/records.js';
import {
  forgetGuest,
  identityOf,
  loadAccountKeys,
  loadGuest,
  makeKeyMaterial,
  removeAccountKeys,
  saveAccountKey,
  saveGuest,
  storedFromCloud,
  toStored
} from '../../src/lib/deviceKey.js';
import { createIdentity, createMemoryAdapter, openIdentityPayload, setStorageAdapter, storedFromOpened } from '../../src/lib/keystore.js';

beforeEach(() => {
  setStorageAdapter(createMemoryAdapter());
});

describe('makeKeyMaterial', () => {
  it('makes a valid self signed identity record', async () => {
    const m = await makeKeyMaterial('  Priya Nair ', { extractable: false });
    expect(m.displayName).toBe('Priya Nair');
    expect(m.keyId).toMatch(/^[0-9a-f]{64}$/);
    expect(validateRecord(m.record)).toEqual({ ok: true });
    expect(await verifyRecord(m.publicKey, m.record, m.signature)).toBe(true);
    expect(m.privateKey).toBeTruthy();
    expect(m.privateJwk).toBeUndefined();
    expect(m.privateKey.extractable).toBe(false);
  });

  it('an extractable key also gives the private jwk once, for the account', async () => {
    const m = await makeKeyMaterial('Priya', { extractable: true });
    expect(m.privateJwk.d).toBeTruthy();
    expect(m.privateKey).toBeUndefined();
    const stored = await toStored(m);
    expect(stored.privateKey.extractable).toBe(false);
    expect(stored.privateJwk).toBeUndefined();
    expect(stored.keyId).toBe(m.keyId);
  });

  it('uses the same name rules as the identity record', async () => {
    await expect(makeKeyMaterial('')).rejects.toThrow(/display name/i);
    await expect(makeKeyMaterial('   ')).rejects.toThrow();
    await expect(makeKeyMaterial('x'.repeat(41))).rejects.toThrow();
    await expect(makeKeyMaterial('bad\u0007name')).rejects.toThrow();
    await expect(makeKeyMaterial(null)).rejects.toThrow();
    expect((await makeKeyMaterial('x'.repeat(40))).displayName).toHaveLength(40);
  });

  it('two keys are different', async () => {
    const a = await makeKeyMaterial('A');
    const b = await makeKeyMaterial('A');
    expect(a.keyId).not.toBe(b.keyId);
  });
});

describe('guest key', () => {
  it('saves, loads and forgets', async () => {
    expect(await loadGuest()).toBe(null);
    const stored = await toStored(await makeKeyMaterial('Asha'));
    const identity = await saveGuest(stored);
    expect(identity.keyId).toBe(stored.keyId);
    const loaded = await loadGuest();
    expect(loaded.keyId).toBe(stored.keyId);
    expect(loaded.hasBackup).toBe(false);
    const record = { v: 2, type: 'message', n: 1 };
    expect(await verifyRecord(loaded.publicKey, record, await loaded.sign(record))).toBe(true);
    await forgetGuest();
    expect(await loadGuest()).toBe(null);
  });

  it('an identity made the old way (passphrase and backup) is a guest key with a backup', async () => {
    await createIdentity({ displayName: 'Old', passphrase: 'correct horse battery', iterations: 100000 });
    const loaded = await loadGuest();
    expect(loaded.hasBackup).toBe(true);
  });
});

describe('keys of an account on this device', () => {
  const ACCOUNT = 'f'.repeat(32);

  async function stored(name) {
    return toStored(await makeKeyMaterial(name));
  }

  it('keeps several keys and the newest one is active', async () => {
    const a = await stored('A');
    const b = await stored('B');
    await saveAccountKey(ACCOUNT, a);
    await saveAccountKey(ACCOUNT, b);
    const out = await loadAccountKeys(ACCOUNT);
    expect(out.active.keyId).toBe(b.keyId);
    expect(Object.keys(out.all).sort()).toEqual([a.keyId, b.keyId].sort());
  });

  it('makeActive false leaves the active key alone', async () => {
    const a = await stored('A');
    const b = await stored('B');
    await saveAccountKey(ACCOUNT, a);
    await saveAccountKey(ACCOUNT, b, { makeActive: false });
    expect((await loadAccountKeys(ACCOUNT)).active.keyId).toBe(a.keyId);
  });

  it('only returns keys the server still lists', async () => {
    const a = await stored('A');
    const b = await stored('B');
    await saveAccountKey(ACCOUNT, a);
    await saveAccountKey(ACCOUNT, b);
    const only = await loadAccountKeys(ACCOUNT, [a.keyId]);
    expect(Object.keys(only.all)).toEqual([a.keyId]);
    expect(only.active.keyId).toBe(a.keyId);
    const none = await loadAccountKeys(ACCOUNT, []);
    expect(none.active).toBe(null);
  });

  it('accounts do not see each other and a missing account is empty', async () => {
    await saveAccountKey(ACCOUNT, await stored('A'));
    expect((await loadAccountKeys('e'.repeat(32))).active).toBe(null);
    expect((await loadAccountKeys('nobody')).all).toEqual({});
  });

  it('removing an account clears its keys only', async () => {
    await saveAccountKey(ACCOUNT, await stored('A'));
    await saveAccountKey('e'.repeat(32), await stored('B'));
    await removeAccountKeys(ACCOUNT);
    expect((await loadAccountKeys(ACCOUNT)).active).toBe(null);
    expect((await loadAccountKeys('e'.repeat(32))).active).toBeTruthy();
  });

  it('ignores a stored entry that is damaged or does not match its key id', async () => {
    const a = await stored('A');
    await saveAccountKey(ACCOUNT, a);
    const { storageSet } = await import('../../src/lib/keystore.js');
    await storageSet('acct:' + ACCOUNT, { active: 'x', keys: { [a.keyId]: { ...a, keyId: 'y'.repeat(64) }, junk: 5 } });
    expect((await loadAccountKeys(ACCOUNT)).active).toBe(null);
    await storageSet('acct:' + ACCOUNT, 'not an object');
    expect((await loadAccountKeys(ACCOUNT)).active).toBe(null);
  });

  it('identityOf rejects things that are not a stored key', () => {
    expect(identityOf(null)).toBe(null);
    expect(identityOf({})).toBe(null);
    expect(identityOf({ keyId: 'x' })).toBe(null);
  });
});

describe('the key coming back from the account on a new device', () => {
  async function cloudPayload(name = 'Priya') {
    const m = await makeKeyMaterial(name, { extractable: true });
    return { keyId: m.keyId, publicKey: m.publicKey, privateJwk: m.privateJwk, record: m.record, signature: m.signature };
  }

  it('imports a good payload as a non extractable key that signs', async () => {
    const payload = await cloudPayload();
    const stored = await storedFromCloud(payload);
    expect(stored.privateKey.extractable).toBe(false);
    expect(stored.keyId).toBe(payload.keyId);
    expect(stored.displayName).toBe('Priya');
    const identity = identityOf(stored);
    const record = { v: 2, type: 'message', n: 9 };
    expect(await verifyRecord(payload.publicKey, record, await identity.sign(record))).toBe(true);
  });

  it('refuses a private key that belongs to another public key', async () => {
    const payload = await cloudPayload();
    const other = await makeKeyMaterial('Other', { extractable: true });
    await expect(storedFromCloud({ ...payload, privateJwk: other.privateJwk })).rejects.toThrow();
  });

  it('refuses a changed record or a changed signature', async () => {
    const payload = await cloudPayload();
    await expect(storedFromCloud({ ...payload, record: { ...payload.record, displayName: 'Mallory' } })).rejects.toThrow();
    const sig = payload.signature;
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    await expect(storedFromCloud({ ...payload, signature: flipped })).rejects.toThrow();
  });

  it('refuses a private key whose d part does not match its public part', async () => {
    const payload = await cloudPayload();
    const pair = await generateKeyPair({ extractable: true });
    const stranger = await exportPrivateJwk(pair.privateKey);
    await expect(storedFromCloud({ ...payload, privateJwk: { ...payload.privateJwk, d: stranger.d } })).rejects.toThrow();
  });

  it('refuses nothing, missing fields and junk without throwing a surprise type', async () => {
    for (const bad of [null, undefined, {}, { privateJwk: 1, record: 2, signature: 3 }, 'text']) {
      await expect(storedFromCloud(bad)).rejects.toThrow();
    }
    await expect(openIdentityPayload(null)).rejects.toThrow();
  });

  it('storedFromOpened keeps no private jwk and no backup text', async () => {
    const m = await makeKeyMaterial('Priya', { extractable: true });
    const opened = await openIdentityPayload({ privateJwk: m.privateJwk, record: m.record, signature: m.signature });
    const stored = await storedFromOpened(opened);
    expect(Object.keys(stored).sort()).toEqual(['createdAt', 'displayName', 'keyId', 'privateKey', 'publicKey', 'record', 'signature']);
  });
});
