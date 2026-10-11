// Review r2-trust: the session state machine (src/lib/sessionStore.js) with a fake server and real
// WebCrypto keys. "HELD UP" tests pass today. "DEFECT" tests assert the correct behaviour and FAIL today.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/lib/api.js';
import { authErrorText } from '../../../src/lib/authText.js';
import * as device from '../../../src/lib/deviceKey.js';
import * as keystore from '../../../src/lib/keystore.js';
import { createMemoryAdapter, setStorageAdapter } from '../../../src/lib/keystore.js';
import { createSessionStore } from '../../../src/lib/sessionStore.js';
import * as vault from '../../../src/lib/vault.js';
import { createVault } from '../../../src/lib/vault.js';
import { listLocalDocs, rememberDoc } from '../../../src/lib/localDocs.js';
import { getLastSeen, markSeen } from '../../../src/lib/unread.js';
import { ACCOUNT_ID, DOC, DOC2, blockedLocalStorage, fakeLocalStorage, makeServer, settle } from './_fakes.js';

const EMAIL = 'priya@example.com';
const PW = 'ABCDE-FGHIJ-KLMNO-PQRST';

beforeEach(() => {
  setStorageAdapter(createMemoryAdapter());
  vi.stubGlobal('localStorage', fakeLocalStorage());
});

function newStore(server, dev = device) {
  return createSessionStore({ api: server.api, device: dev, vault });
}

async function signedInEasy(server) {
  const store = newStore(server);
  await store.init();
  await store.requestCode(EMAIL);
  await store.verifyCode(EMAIL, server.otp);
  await store.registerName('Priya');
  expect(store.getState().status).toBe('ready');
  return store;
}

describe('HELD UP: keys and secrets', () => {
  it('the key kept on the device is non extractable in every flow, and its private half is in no readable storage', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    // account flow
    const slot = await keystore.storageGet('acct:' + ACCOUNT_ID);
    const stored = Object.values(slot.keys)[0];
    expect(stored.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('jwk', stored.privateKey)).rejects.toBeTruthy();
    expect(stored.privateJwk).toBeUndefined();
    // the private scalar d went to the server once (Easy) and is not in localStorage
    const sent = server.calls.filter((c) => Array.isArray(c) && c[0] === 'postMyKey')[0][1];
    expect(typeof sent.privateJwk.d).toBe('string');
    const text = JSON.stringify([...globalThis.localStorage.map.entries()]);
    expect(text).not.toContain(sent.privateJwk.d);
    // sign out of an Easy account removes the key from the device
    await store.signOut();
    expect(await keystore.storageGet('acct:' + ACCOUNT_ID)).toBeUndefined();

    // new device, same account: the key comes back and is non extractable again
    const second = newStore(server);
    await second.init();
    await second.requestCode(EMAIL);
    server.otp = '654321';
    await second.verifyCode(EMAIL, '654321');
    expect(second.getState().status).toBe('ready');
    const slot2 = await keystore.storageGet('acct:' + ACCOUNT_ID);
    const key2 = Object.values(slot2.keys)[0].privateKey;
    expect(key2.extractable).toBe(false);
  });

  it('Quick start keys are non extractable and registered with the open endpoint only', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.startGuest('Guest One');
    const stored = await keystore.storageGet('identity');
    expect(stored.privateKey.extractable).toBe(false);
    expect(server.count('registerIdentity')).toBe(1);
    expect(server.count('postMyKey')).toBe(0);
  });

  it('a server that hands back a key which is not the one it listed never becomes the identity', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    await store.signOut();
    // a hostile answer: valid key material, but a different key id than /api/me lists
    const other = await device.makeKeyMaterial('Mallory', { extractable: true });
    server.api.getMyKey = async () => ({ keyId: other.keyId, publicKey: other.publicKey, privateJwk: other.privateJwk, record: other.record, signature: other.signature });
    server.otp = '111111';
    const again = newStore(server);
    await again.init();
    await again.verifyCode(EMAIL, '111111');
    expect(again.getState().status).toBe('needsKey');
    expect(again.getState().identity).toBe(null);
    expect(again.getState().keyProblem).toBe(true);
  });

  it('a damaged private key (does not match the public key) is refused', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    await store.signOut();
    const real = server.keys[0];
    const other = await device.makeKeyMaterial('Mallory', { extractable: true });
    server.api.getMyKey = async () => ({ keyId: real.keyId, publicKey: real.record.publicKey, privateJwk: other.privateJwk, record: real.record, signature: real.signature });
    server.otp = '222222';
    const again = newStore(server);
    await again.init();
    await again.verifyCode(EMAIL, '222222');
    expect(again.getState().status).toBe('needsKey');
  });

  it('a flaky /api/me never signs a signed in person out', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    server.api.getMe = async () => {
      throw new ApiError(0, 'network', 'offline');
    };
    await store.refresh();
    expect(store.getState().status).toBe('ready');
  });

  it('another account on the same browser never gets the first account\'s key or vault entries', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    const v = createVault({ api: server.api });
    expect(await v.saveDocPassword(DOC, PW)).toBe('account');
    server.failSecrets = true;
    expect(await v.saveDocPassword(DOC2, PW + 'X')).toBe('device');
    server.failSecrets = false;
    // Strict on keeps the passwords on the device under the account scope only
    await store.setStrict(true);
    expect(vault.localList('a:' + ACCOUNT_ID).length).toBe(2);
    expect(vault.localList('a:' + 'e'.repeat(32))).toEqual([]);
    expect(vault.localList('guest')).toEqual([]);
    const loaded = await device.loadAccountKeys('e'.repeat(32), null);
    expect(loaded.active).toBe(null);
  });

  it('two stores: after one signs out the other finds out on its next refresh', async () => {
    const server = makeServer();
    const a = await signedInEasy(server);
    const b = newStore(server);
    await b.init();
    expect(b.getState().status).toBe('ready');
    await a.signOut();
    await b.refresh();
    expect(b.getState().status).toBe('signedOut');
    expect(b.getState().identity).toBe(null);
  });
});

describe('DEFECT: sign out and delete lose or leave data', () => {
  it('signing out of an Easy account must not throw away a file password that never reached the server', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    server.failSecrets = true; // the account could not be reached when the file was published
    const v = createVault({ api: server.api });
    expect(await v.saveDocPassword(DOC, PW)).toBe('device'); // the UI says "saved on this device only"
    server.failSecrets = false;
    await store.signOut();
    const onServer = server.secrets.has(DOC);
    const onDevice = vault.localGet('a:' + ACCOUNT_ID, DOC) !== null;
    // The owner has no copy left. The only other copy is the link they may or may not have kept.
    expect(onServer || onDevice, 'password lost by sign out').toBe(true);
  });

  it.each(['signOut', 'deleteAccount', 'forgetDevice'])('%s must not leave the file labels of the person for the next one', async (how) => {
    const server = makeServer();
    let store;
    if (how === 'forgetDevice') {
      store = newStore(server);
      await store.init();
      await store.startGuest('Guest');
    } else {
      store = await signedInEasy(server);
    }
    rememberDoc({ docId: DOC, label: 'Divorce settlement 2026.pdf', createdAt: Date.now() });
    await store[how]();
    // src/components/files/useMineFiles.js draws listLocalDocs() under Mine for a Quick start person,
    // with no check of who published the file
    expect(listLocalDocs()).toEqual([]);
  });

  it('a publish that finishes after sign out must not drop its password into the vault of the next Quick start person', async () => {
    const server = makeServer();
    const a = await signedInEasy(server);
    await a.signOut(); // the publish (AddFileSheet, runAddFile) is still running and calls save() when it ends
    const late = createVault({ api: server.api });
    await late.saveDocPassword(DOC, PW);

    const guestServer = makeServer();
    const b = newStore(guestServer);
    await b.init();
    await b.startGuest('Somebody else');
    // DocumentPage.initialPassword() asks the vault for every file a signed in person opens
    expect(await createVault({ api: guestServer.api }).getDocPassword(DOC)).toBe(null);
  });

  it('sign out must not leave which chats were read', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    markSeen('general', 42);
    await store.signOut();
    expect(getLastSeen('general')).toBe(0);
  });
});

describe('DEFECT: restoring a backup destroys a Quick start key', () => {
  it('restoreBackup while a Quick start key exists keeps the Quick start key', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    // an old backup file
    const made = await keystore.createIdentity({ displayName: 'Old Person', passphrase: 'correct horse battery', iterations: 100000 });
    await keystore.forgetIdentity();
    await store.startGuest('Quick Person');
    const guestId = store.getState().identity.keyId;
    // The finding's own fix is to refuse, so the call is expected to reject with the plain sentence.
    await expect(store.restoreBackup(made.backupText, 'correct horse battery')).rejects.toThrow(/forget this one first/);
    const stillThere = await keystore.loadIdentity();
    expect(stillThere && stillThere.keyId, 'the Quick start key (no backup, not extractable) was overwritten').toBe(guestId);
  });
});

describe('DEFECT: Strict mode', () => {
  it('turning Strict on with blocked device storage must not delete the server copies, and must not claim they were kept', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    expect(await createVault({ api: server.api }).saveDocPassword(DOC, PW)).toBe('account');
    vi.stubGlobal('localStorage', blockedLocalStorage());
    let threw = false;
    try {
      await store.setStrict(true);
    } catch {
      threw = true;
    }
    // MePage prints "N file passwords were handed back and kept on this device" from passwords.length
    expect(threw || server.count('postStrict') === 0, 'server copies deleted although the device could not keep them').toBe(true);
  });

  it('going back to Easy must not upload the passwords the person kept off the server (the sheet says "from now on")', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    await createVault({ api: server.api }).saveDocPassword(DOC, PW);
    await store.setStrict(true); // passwords handed back, kept on this device
    expect(vault.localList('a:' + ACCOUNT_ID).map((x) => x.docId)).toEqual([DOC]);
    const before = server.calls.filter((c) => Array.isArray(c) && c[0] === 'putSecret' && c[1] === DOC).length;
    await store.setStrict(false);
    await settle();
    const sent = server.calls.filter((c) => Array.isArray(c) && c[0] === 'putSecret' && c[1] === DOC).slice(before);
    expect(sent.length, 'src/pages/MePage.jsx line 170 says "of the file passwords you publish from now on"').toBe(0);
  });

  it('a second key registration is not made when the first one only failed to be saved on the device', async () => {
    const server = makeServer({ strictFromStart: true });
    const broken = { ...device, saveAccountKey: async () => { throw new Error('storage is blocked'); } };
    const store = newStore(server, broken);
    await store.init();
    await store.requestCode(EMAIL);
    await store.verifyCode(EMAIL, server.otp);
    await expect(store.registerName('Priya')).rejects.toBeTruthy();
    await expect(store.registerName('Priya')).rejects.toBeTruthy();
    // every retry registers one more key on the server (limit 5 per account)
    expect(server.count('postMyKey')).toBeLessThanOrEqual(1);
  });

  it('registerName never resolves while the person is still not signed in with a key', async () => {
    const server = makeServer();
    const broken = { ...device, saveAccountKey: async () => { throw new Error('storage is blocked'); } };
    const store = newStore(server, broken);
    await store.init();
    await store.requestCode(EMAIL);
    await store.verifyCode(EMAIL, server.otp);
    await expect(store.registerName('Priya')).rejects.toBeTruthy(); // key saved on the server, not on the device
    // second try: the server says key_exists, the store loads, the device still cannot save it
    let resolved = null;
    try {
      resolved = await store.registerName('Priya');
    } catch {
      resolved = null;
    }
    // SignInPage.jsx line 166 to 167: a resolved call means onDone() and the person is sent on
    if (resolved !== null) expect(store.getState().status).toBe('ready');
  });
});

describe('DEFECT: double submit', () => {
  it('two verifyCode calls at once send one request', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await Promise.allSettled([store.verifyCode(EMAIL, server.otp), store.verifyCode(EMAIL, '123456')]);
    expect(server.count('authVerify')).toBe(1);
  });

  it('two registerName calls at once make one key', async () => {
    const server = makeServer({ strictFromStart: true });
    const store = newStore(server);
    await store.init();
    await store.requestCode(EMAIL);
    await store.verifyCode(EMAIL, server.otp);
    await Promise.allSettled([store.registerName('Priya'), store.registerName('Priya')]);
    expect(server.count('postMyKey')).toBe(1);
  });
});

describe('DEFECT: error text', () => {
  it('"the code was right but we could not finish" is not replaced by the generic network text', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    const real = server.api.getMe;
    server.api.getMe = async () => {
      if (server.signedIn) throw new ApiError(0, 'network', 'offline');
      return real();
    };
    const err = await store.verifyCode(EMAIL, server.otp).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    // The server has the cookie already: asking for a new code is wrong advice, and the shown text drops the sentence
    expect(authErrorText(err)).toMatch(/code was right/i);
  });
});

describe('HELD UP: order of events', () => {
  it('startGuest is refused while somebody is signed in', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    await expect(store.startGuest('x')).rejects.toBeTruthy();
  });

  it('sign out with the server unreachable keeps the person signed in and says so', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    server.api.authLogout = async () => {
      throw new ApiError(0, 'network', 'offline');
    };
    await expect(store.signOut()).rejects.toBeTruthy();
    expect(store.getState().status).toBe('ready');
  });

  it('a session that already ended (401 on logout) still signs out and clears the device', async () => {
    const server = makeServer();
    const store = await signedInEasy(server);
    server.api.authLogout = async () => {
      server.signedIn = false;
      throw new ApiError(401, 'unauthenticated', 'gone');
    };
    await store.signOut();
    expect(store.getState().status).toBe('signedOut');
    expect(await keystore.storageGet('acct:' + ACCOUNT_ID)).toBeUndefined();
  });
});
