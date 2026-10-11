// The session logic with a stubbed api: sign in, needsKey, key import on a new device, Strict mode,
// Quick start, sign out and delete. Keys are real (WebCrypto), the server is a small in memory fake.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keyIdOf, verifyRecord } from '../../shared/keys.js';
import { validateRecord } from '../../shared/records.js';
import { ApiError } from '../../src/lib/api.js';
import * as device from '../../src/lib/deviceKey.js';
import { createMemoryAdapter, setStorageAdapter } from '../../src/lib/keystore.js';
import { createSessionStore } from '../../src/lib/sessionStore.js';
import * as vault from '../../src/lib/vault.js';
import { paginatedStrict } from './_accountFake.js';

function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

const DOC = 'ab'.repeat(16);
const DOC2 = 'cd'.repeat(16);

// A tiny server: one account, its keys, the secrets, the guest identities.
function makeServer(overrides = {}) {
  const s = {
    signedIn: false,
    account: null,
    keys: [], // { keyId, record, signature, privateJwk|null }
    secrets: new Map(),
    handover: new Map(),
    fresh: true,
    registered: new Map(),
    calls: [],
    otp: '123456',
    health: { ok: true, signing: true, mail: 'resend', accounts: true },
    down: false,
    ...overrides
  };
  const call = (name, arg) => s.calls.push(arg === undefined ? name : [name, arg]);
  const unauth = () => new ApiError(401, 'unauthenticated', 'sign in first');
  const net = () => new ApiError(0, 'network', 'offline');
  s.api = {
    async getHealth() {
      call('getHealth');
      if (s.down) throw net();
      return s.health;
    },
    async getMe() {
      call('getMe');
      if (s.down) throw net();
      if (!s.signedIn) throw unauth();
      return { account: { ...s.account }, keys: s.keys.map((k) => ({ keyId: k.keyId, hasCloudCopy: Boolean(k.privateJwk) })) };
    },
    async authRequest(email) {
      call('authRequest', email);
      return { sent: true, cooldown: 30 };
    },
    async authVerify(email, code) {
      call('authVerify', [email, code]);
      if (code !== s.otp) throw new ApiError(400, 'invalid_code', 'wrong');
      const isNew = !s.account;
      if (!s.account) s.account = { id: 'f'.repeat(32), displayName: null, emailMasked: 'pr***@example.com', strict: false, createdAt: 1 };
      s.signedIn = true;
      return { account: { ...s.account }, isNew };
    },
    async authLogout() {
      call('authLogout');
      s.signedIn = false;
      return { ok: true };
    },
    async postMyKey(body) {
      call('postMyKey', body);
      if (!s.signedIn) throw unauth();
      if (!validateRecord(body.record).ok) throw new ApiError(400, 'bad_request', 'bad record');
      if (!(await verifyRecord(body.record.publicKey, body.record, body.signature))) throw new ApiError(400, 'bad_signature', 'bad sig');
      if (body.privateJwk && s.account.strict) throw new ApiError(409, 'strict_mode', 'strict');
      if (body.privateJwk && s.keys.some((k) => k.privateJwk)) throw new ApiError(409, 'key_exists', 'exists');
      const keyId = await keyIdOf(body.record.publicKey);
      s.keys.push({ keyId, record: body.record, signature: body.signature, privateJwk: body.privateJwk || null });
      if (!s.account.displayName) s.account.displayName = body.record.displayName;
      return { keyId };
    },
    async getMyKey() {
      call('getMyKey');
      if (!s.signedIn) throw unauth();
      if (s.account.strict) throw new ApiError(409, 'strict_mode', 'strict');
      const k = s.keys.find((x) => x.privateJwk);
      if (!k) throw new ApiError(404, 'not_found', 'none');
      return { keyId: k.keyId, publicKey: k.record.publicKey, privateJwk: k.privateJwk, record: k.record, signature: k.signature };
    },
    async putSecret(docId, password) {
      call('putSecret', docId);
      if (!s.signedIn) throw unauth();
      if (s.account.strict) throw new ApiError(409, 'strict_mode', 'strict');
      s.secrets.set(docId, password);
      return { ok: true };
    },
    async getSecret(docId) {
      call('getSecret', docId);
      if (!s.secrets.has(docId)) throw new ApiError(404, 'not_found', 'none');
      return { password: s.secrets.get(docId) };
    },
    postStrict: null, // below: the server hands the passwords over in pages, see _accountFake.js
    async deleteMe() {
      call('deleteMe');
      s.signedIn = false;
      s.account = null;
      s.keys = [];
      s.secrets.clear();
      return { ok: true };
    },
    async getIdentity(keyId) {
      call('getIdentity', keyId);
      if (!s.registered.has(keyId)) throw new ApiError(404, 'not_found', 'unknown');
      return s.registered.get(keyId);
    },
    async registerIdentity(record, signature) {
      call('registerIdentity', record.displayName);
      if (s.down) throw net();
      const keyId = await keyIdOf(record.publicKey);
      s.registered.set(keyId, { keyId, record, signature });
      return { keyId };
    }
  };
  s.api.postStrict = paginatedStrict(s);
  return s;
}

function newStore(server) {
  return createSessionStore({ api: server.api, device, vault });
}

async function settle() {
  // lets the background registration check of a guest key finish
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  setStorageAdapter(createMemoryAdapter());
  vi.stubGlobal('localStorage', fakeLocalStorage());
});

describe('first look', () => {
  it('starts as loading and ends signed out when nobody is signed in', async () => {
    const server = makeServer();
    const store = newStore(server);
    expect(store.getState().status).toBe('loading');
    await store.init();
    const s = store.getState();
    expect(s.status).toBe('signedOut');
    expect(s.mode).toBe(null);
    expect(s.identity).toBe(null);
    expect(s.mailAvailable).toBe(true);
  });

  it('reads mail availability from the health answer', async () => {
    const none = makeServer({ health: { ok: true, mail: 'none', accounts: false } });
    const a = newStore(none);
    await a.init();
    expect(a.getState().mailAvailable).toBe(false);
    expect(a.getState().accountsAvailable).toBe(false);

    const mailOnly = makeServer({ health: { ok: true, mail: 'brevo', accounts: true } });
    const b = newStore(mailOnly);
    await b.init();
    expect(b.getState().mailAvailable).toBe(true);
  });

  it('keeps email sign in visible when the health call fails', async () => {
    const server = makeServer({ down: true });
    const store = newStore(server);
    await store.init();
    expect(store.getState().mailAvailable).toBe(true);
    expect(store.getState().status).toBe('signedOut');
    expect(store.getState().error).toBeTruthy();
  });

  it('treats accounts_unavailable on /api/me as no email sign in', async () => {
    const server = makeServer();
    server.api.getHealth = async () => {
      throw new ApiError(0, 'network', 'x');
    };
    server.api.getMe = async () => {
      throw new ApiError(503, 'accounts_unavailable', 'off');
    };
    const store = newStore(server);
    await store.init();
    expect(store.getState().mailAvailable).toBe(false);
    expect(store.getState().status).toBe('signedOut');
  });
});

describe('sign in with an email code', () => {
  it('requestCode returns the cooldown and the test code only when the server sends it', async () => {
    const server = makeServer();
    const store = newStore(server);
    const out = await store.requestCode('  priya@example.com ');
    expect(out).toEqual({ cooldown: 30 });
    expect(server.calls).toContainEqual(['authRequest', 'priya@example.com']);
    server.api.authRequest = async () => ({ sent: true, cooldown: 30, debugCode: '123456' });
    expect((await store.requestCode('priya@example.com')).debugCode).toBe('123456');
  });

  it('a wrong code rejects with the server error and changes nothing', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await expect(store.verifyCode('p@example.com', '000000')).rejects.toMatchObject({ code: 'invalid_code' });
    expect(store.getState().status).toBe('signedOut');
  });

  it('a lost connection right after the code was accepted is an error, not a half signed in state', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    server.api.getMe = async () => {
      throw new ApiError(0, 'network', 'offline');
    };
    await expect(store.verifyCode('p@example.com', '123456')).rejects.toMatchObject({ code: 'finish_failed' });
    expect(store.getState().status).toBe('signedOut');
  });

  it('a new account needs a key, then registerName makes it and the account is ready', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    const out = await store.verifyCode('p@example.com', '123456');
    expect(out).toEqual({ isNew: true, status: 'needsKey' });
    let s = store.getState();
    expect(s.status).toBe('needsKey');
    expect(s.mode).toBe('account');
    expect(s.account.emailMasked).toBe('pr***@example.com');
    expect(s.identity).toBe(null);

    const made = await store.registerName('Priya Nair');
    s = store.getState();
    expect(s.status).toBe('ready');
    expect(s.identity.keyId).toBe(made.keyId);
    expect(s.identity.displayName).toBe('Priya Nair');
    expect(s.account.displayName).toBe('Priya Nair');
    expect(s.keys).toEqual([{ keyId: made.keyId, hasCloudCopy: true }]);

    // the server got a valid self signed record and the private key (Easy mode)
    const post = server.calls.find((c) => Array.isArray(c) && c[0] === 'postMyKey')[1];
    expect(validateRecord(post.record).ok).toBe(true);
    expect(await verifyRecord(post.record.publicKey, post.record, post.signature)).toBe(true);
    expect(post.privateJwk.d).toBeTruthy();
    expect(await keyIdOf(post.record.publicKey)).toBe(made.keyId);

    // signing works and the signature verifies with the public key
    const record = { v: 2, type: 'message', n: 1 };
    const sig = await s.identity.sign(record);
    expect(await verifyRecord(s.identity.publicKey, record, sig)).toBe(true);
  });

  it('keeps only a non extractable key on the device after registering', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.verifyCode('p@example.com', '123456');
    await store.registerName('Priya');
    const { active } = await device.loadAccountKeys(server.account.id);
    expect(active).toBeTruthy();
    // read the raw stored record through the adapter
    const { storageGet } = await import('../../src/lib/keystore.js');
    const entry = await storageGet('acct:' + server.account.id);
    const stored = entry.keys[active.keyId];
    expect(stored.privateKey.extractable).toBe(false);
    expect(stored.privateJwk).toBeUndefined();
    await expect(globalThis.crypto.subtle.exportKey('jwk', stored.privateKey)).rejects.toThrow();
  });

  it('refuses a bad display name before calling the server', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.verifyCode('p@example.com', '123456');
    await expect(store.registerName('   ')).rejects.toThrow(/display name/i);
    await expect(store.registerName('x'.repeat(41))).rejects.toThrow();
    expect(server.calls.some((c) => Array.isArray(c) && c[0] === 'postMyKey')).toBe(false);
    expect(store.getState().status).toBe('needsKey');
  });

  it('registerName only works while a key is needed', async () => {
    const store = newStore(makeServer());
    await store.init();
    await expect(store.registerName('Priya')).rejects.toThrow(/sign in/i);
  });

  it('uses the key another device made when the account already has one (key_exists)', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.verifyCode('p@example.com', '123456');
    // another device registers its key between the first look and the name step
    const other = await device.makeKeyMaterial('Priya on a laptop', { extractable: true });
    server.signedIn = true;
    await server.api.postMyKey({ record: other.record, signature: other.signature, privateJwk: other.privateJwk });
    const out = await store.registerName('Priya');
    expect(out.keyId).toBe(other.keyId);
    expect(store.getState().status).toBe('ready');
    expect(store.getState().identity.displayName).toBe('Priya on a laptop');
  });
});

describe('a returning account on a new device', () => {
  async function accountWithKey(server) {
    const first = newStore(server);
    await first.init();
    await first.verifyCode('p@example.com', '123456');
    const made = await first.registerName('Priya');
    return made.keyId;
  }

  it('Easy: downloads the key and keeps a non extractable copy', async () => {
    const server = makeServer();
    const keyId = await accountWithKey(server);
    // a different device: empty key storage, the cookie is still valid
    setStorageAdapter(createMemoryAdapter());
    const store = newStore(server);
    await store.init();
    const s = store.getState();
    expect(s.status).toBe('ready');
    expect(s.mode).toBe('account');
    expect(s.identity.keyId).toBe(keyId);
    expect(server.calls.filter((c) => c === 'getMyKey').length).toBe(1);
    const sig = await s.identity.sign({ v: 2, type: 'message', n: 2 });
    expect(await verifyRecord(s.identity.publicKey, { v: 2, type: 'message', n: 2 }, sig)).toBe(true);
    const { storageGet } = await import('../../src/lib/keystore.js');
    const entry = await storageGet('acct:' + server.account.id);
    expect(entry.keys[keyId].privateKey.extractable).toBe(false);

    // the second visit uses the stored key and does not download it again
    const again = newStore(server);
    await again.init();
    expect(again.getState().status).toBe('ready');
    expect(server.calls.filter((c) => c === 'getMyKey').length).toBe(1);
  });

  it('Easy: a failed key download on a new device asks to try again instead of making a second key', async () => {
    const server = makeServer();
    await accountWithKey(server);
    setStorageAdapter(createMemoryAdapter());
    server.api.getMyKey = async () => {
      throw new ApiError(0, 'network', 'offline');
    };
    const store = newStore(server);
    await store.init();
    const s = store.getState();
    expect(s.status).toBe('needsKey');
    expect(s.keyProblem).toBe(true);
    await expect(store.registerName('Priya again')).rejects.toThrow(/try again/i);
  });

  it('Easy: rejects a downloaded key that does not match its record', async () => {
    const server = makeServer();
    await accountWithKey(server);
    setStorageAdapter(createMemoryAdapter());
    const stranger = await device.makeKeyMaterial('Mallory', { extractable: true });
    const real = server.keys[0];
    server.api.getMyKey = async () => ({ keyId: real.keyId, publicKey: real.record.publicKey, privateJwk: stranger.privateJwk, record: real.record, signature: real.signature });
    const store = newStore(server);
    await store.init();
    expect(store.getState().status).toBe('needsKey');
    expect(store.getState().keyProblem).toBe(true);
  });

  it('Strict: a new device has no key yet and makes its own without sending the private key', async () => {
    const server = makeServer();
    await accountWithKey(server);
    const s1 = newStore(server);
    await s1.init();
    await s1.setStrict(true);
    expect(server.account.strict).toBe(true);

    setStorageAdapter(createMemoryAdapter());
    const second = newStore(server);
    await second.init();
    expect(second.getState().status).toBe('needsKey');
    expect(second.getState().account.strict).toBe(true);
    const before = server.keys.length;
    const made = await second.registerName('Priya phone');
    expect(second.getState().status).toBe('ready');
    expect(server.keys.length).toBe(before + 1);
    const post = server.calls.filter((c) => Array.isArray(c) && c[0] === 'postMyKey').at(-1)[1];
    expect(post.privateJwk).toBeUndefined();
    expect(made.keyId).not.toBe(server.keys[0].keyId);
    expect(second.getState().keys.map((k) => k.hasCloudCopy)).toEqual([false, false]);
  });
});

describe('Strict and Easy mode', () => {
  it('turning Strict on hands back the passwords and keeps them on this device', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.verifyCode('p@example.com', '123456');
    await store.registerName('Priya');
    server.secrets.set(DOC, 'AAAA-BBBB-CCCC-DDDD-EEEE');
    server.secrets.set(DOC2, 'FFFF-GGGG-HHHH-JJJJ-KKKK');

    const out = await store.setStrict(true);
    expect(out.passwords).toHaveLength(2);
    expect(store.getState().account.strict).toBe(true);
    expect(store.getState().keys.every((k) => !k.hasCloudCopy)).toBe(true);
    expect(store.getState().identity.keyId).toBe(server.keys[0].keyId);
    // the passwords are readable here without the account
    expect(await vault.getDocPassword(DOC)).toBe('AAAA-BBBB-CCCC-DDDD-EEEE');
    expect(await vault.getDocPassword(DOC2)).toBe('FFFF-GGGG-HHHH-JJJJ-KKKK');
    expect(server.calls.filter((c) => Array.isArray(c) && c[0] === 'getSecret')).toHaveLength(0);
  });

  it('turning Easy back on makes a new key with a cloud copy and does NOT send the passwords the person kept off the server', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.verifyCode('p@example.com', '123456');
    const first = await store.registerName('Priya');
    server.secrets.set(DOC, 'AAAA-BBBB-CCCC-DDDD-EEEE');
    await store.setStrict(true);
    const out = await store.setStrict(false);
    expect(out.passwords).toEqual([]);
    const s = store.getState();
    expect(s.account.strict).toBe(false);
    expect(s.identity.keyId).not.toBe(first.keyId);
    expect(s.keys.find((k) => k.keyId === s.identity.keyId).hasCloudCopy).toBe(true);
    expect(server.keys.filter((k) => k.privateJwk)).toHaveLength(1);
    // the old key is still held on this device
    expect(store.identityFor(first.keyId)).toBeTruthy();
    expect((await device.loadAccountKeys(server.account.id)).all[first.keyId]).toBeTruthy();
    await settle();
    // Strict was chosen so that the operator holds nothing, so going back does not send the old passwords.
    expect(server.secrets.get(DOC)).toBeUndefined();
    expect(vault.localList('a:' + server.account.id).map((x) => x.docId)).toEqual([DOC]);
  });

  it('turning Strict on needs an account that is signed in with a key', async () => {
    const store = newStore(makeServer());
    await store.init();
    await expect(store.setStrict(true)).rejects.toThrow(/sign in/i);
  });
});

describe('Quick start (guest)', () => {
  it('makes a non extractable key, registers it and keeps it on the device', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    const out = await store.startGuest('Asha');
    const s = store.getState();
    expect(s.status).toBe('ready');
    expect(s.mode).toBe('guest');
    expect(s.account).toBe(null);
    expect(s.identity.keyId).toBe(out.keyId);
    expect(s.registration).toBe('registered');
    expect(server.registered.has(out.keyId)).toBe(true);
    expect(s.identity.hasBackup).toBe(false);
    const { storageGet } = await import('../../src/lib/keystore.js');
    const stored = await storageGet('identity');
    expect(stored.privateKey.extractable).toBe(false);
    expect(stored.backupText).toBeUndefined();
    const record = { v: 2, type: 'message', n: 3 };
    expect(await verifyRecord(s.identity.publicKey, record, await s.identity.sign(record))).toBe(true);
  });

  it('is found again on the next visit and told to the server if the server forgot it', async () => {
    const server = makeServer();
    const first = newStore(server);
    await first.init();
    const { keyId } = await first.startGuest('Asha');
    server.registered.clear();

    const again = newStore(server);
    await again.init();
    expect(again.getState().status).toBe('ready');
    expect(again.getState().mode).toBe('guest');
    expect(again.getState().identity.keyId).toBe(keyId);
    await settle();
    expect(server.registered.has(keyId)).toBe(true);
    expect(again.getState().registration).toBe('registered');
  });

  it('does not keep a key the server did not accept', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    server.api.registerIdentity = async () => {
      throw new ApiError(429, 'rate_limited', 'slow down');
    };
    await expect(store.startGuest('Asha')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(store.getState().status).toBe('signedOut');
    const fresh = newStore(server);
    await fresh.init();
    expect(fresh.getState().status).toBe('signedOut');
  });

  it('checks the display name like the identity record', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await expect(store.startGuest('')).rejects.toThrow(/display name/i);
    await expect(store.startGuest('a\u0000b')).rejects.toThrow();
    expect(server.calls.some((c) => Array.isArray(c) && c[0] === 'registerIdentity')).toBe(false);
  });

  it('only starts from the signed out state', async () => {
    const store = newStore(makeServer());
    await store.init();
    await store.startGuest('Asha');
    await expect(store.startGuest('Again')).rejects.toThrow(/already/i);
  });

  it('an account wins over the guest key, and signing out of it brings the guest key back', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    const guest = await store.startGuest('Asha');
    await store.verifyCode('p@example.com', '123456');
    expect(store.getState().mode).toBe('account');
    expect(store.getState().status).toBe('needsKey');
    await store.registerName('Priya');
    await store.signOut();
    expect(store.getState().mode).toBe('guest');
    expect(store.getState().identity.keyId).toBe(guest.keyId);
  });

  it('signing out of Quick start removes the key and the saved passwords', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.startGuest('Asha');
    await vault.saveDocPassword(DOC, 'AAAA-BBBB-CCCC-DDDD-EEEE');
    expect(await vault.getDocPassword(DOC)).toBe('AAAA-BBBB-CCCC-DDDD-EEEE');
    await store.signOut();
    expect(store.getState().status).toBe('signedOut');
    expect(await vault.getDocPassword(DOC)).toBe(null);
    const fresh = newStore(server);
    await fresh.init();
    expect(fresh.getState().status).toBe('signedOut');
  });
});

describe('sign out and delete', () => {
  async function signedIn(server) {
    const store = newStore(server);
    await store.init();
    await store.verifyCode('p@example.com', '123456');
    await store.registerName('Priya');
    return store;
  }

  it('Easy: ends the session and drops the key from this device', async () => {
    const server = makeServer();
    const store = await signedIn(server);
    await store.signOut();
    expect(server.calls).toContain('authLogout');
    expect(store.getState().status).toBe('signedOut');
    expect((await device.loadAccountKeys(server.account.id)).active).toBe(null);
  });

  it('Strict: ends the session but keeps the key, because no copy exists anywhere else', async () => {
    const server = makeServer();
    const store = await signedIn(server);
    await store.setStrict(true);
    await store.signOut();
    expect(store.getState().status).toBe('signedOut');
    expect((await device.loadAccountKeys(server.account.id)).active).toBeTruthy();
    // signing in again finds the same key
    await store.verifyCode('p@example.com', '123456');
    expect(store.getState().status).toBe('ready');
  });

  it('a failed sign out (offline) changes nothing', async () => {
    const server = makeServer();
    const store = await signedIn(server);
    server.api.authLogout = async () => {
      throw new ApiError(0, 'network', 'offline');
    };
    await expect(store.signOut()).rejects.toMatchObject({ code: 'network' });
    expect(store.getState().status).toBe('ready');
    expect((await device.loadAccountKeys(server.account.id)).active).toBeTruthy();
  });

  it('an already expired session counts as signed out', async () => {
    const server = makeServer();
    const store = await signedIn(server);
    server.api.authLogout = async () => {
      throw new ApiError(401, 'unauthenticated', 'expired');
    };
    server.signedIn = false;
    await store.signOut();
    expect(store.getState().status).toBe('signedOut');
  });

  it('delete removes the account, the keys on this device and the saved passwords', async () => {
    const server = makeServer();
    const store = await signedIn(server);
    await vault.saveDocPassword(DOC, 'AAAA-BBBB-CCCC-DDDD-EEEE');
    const id = server.account.id;
    await store.deleteAccount();
    expect(server.calls).toContain('deleteMe');
    expect(store.getState().status).toBe('signedOut');
    expect((await device.loadAccountKeys(id)).active).toBe(null);
    expect(vault.localList('a:' + id)).toEqual([]);
  });

  it('delete needs an account', async () => {
    const store = newStore(makeServer());
    await store.init();
    await expect(store.deleteAccount()).rejects.toThrow();
  });
});

describe('staying up to date', () => {
  it('a refresh notices a sign out in another tab', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.verifyCode('p@example.com', '123456');
    await store.registerName('Priya');
    server.signedIn = false;
    await store.refresh();
    expect(store.getState().status).toBe('signedOut');
  });

  it('a refresh without a connection keeps the state', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.verifyCode('p@example.com', '123456');
    await store.registerName('Priya');
    server.down = true;
    await store.refresh();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().mode).toBe('account');
  });

  it('listeners are told about changes only when something changed', async () => {
    const server = makeServer();
    const store = newStore(server);
    const seen = vi.fn();
    const off = store.subscribe(seen);
    await store.init();
    const afterInit = seen.mock.calls.length;
    expect(afterInit).toBeGreaterThan(0);
    await store.refresh();
    expect(seen.mock.calls.length).toBe(afterInit);
    off();
    await store.verifyCode('p@example.com', '123456');
    expect(seen.mock.calls.length).toBe(afterInit);
  });

  it('the identity object stays the same while the key stays the same', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.verifyCode('p@example.com', '123456');
    await store.registerName('Priya');
    const before = store.getState().identity;
    await store.refresh();
    expect(store.getState().identity.keyId).toBe(before.keyId);
  });

  it('identityFor gives the identity of a key held on this device, and null for others', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.verifyCode('p@example.com', '123456');
    const made = await store.registerName('Priya');
    expect(store.identityFor(made.keyId).keyId).toBe(made.keyId);
    expect(store.identityFor('0'.repeat(64))).toBe(null);
  });
});

describe('identities from the old backup flow', () => {
  it('restores a backup into Quick start mode and can make a fresh backup', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    const made = await store.createLegacy({ displayName: 'Old User', passphrase: 'correct horse battery' });
    expect(made.backupName).toMatch(/\.hrdkey$/);
    await settle();
    expect(store.getState().mode).toBe('guest');
    expect(store.getState().identity.hasBackup).toBe(true);
    expect(server.registered.has(store.getState().identity.keyId)).toBe(true);

    await store.forgetDevice();
    expect(store.getState().status).toBe('signedOut');
    const restored = await store.restoreBackup(made.backupText, 'correct horse battery');
    expect(store.getState().identity.keyId).toBe(restored.keyId);
    await expect(store.restoreBackup(made.backupText, 'wrong passphrase!!')).rejects.toThrow(/passphrase/);
  });
});
