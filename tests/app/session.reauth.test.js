// "Confirm it is you": requireFresh in the session store. The service answers 401 reauth_required when the session
// is older than 15 minutes; the store opens the sheet through a callback, verifies the new code while the old
// cookie is still sent, and repeats the action once. Server: tests/app/_accountFake.js.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as device from '../../src/lib/deviceKey.js';
import { createMemoryAdapter, setStorageAdapter } from '../../src/lib/keystore.js';
import { CANCELLED_MESSAGE, KEY_REAUTH_MESSAGE, REAUTH_FAILED_MESSAGE, createSessionStore } from '../../src/lib/sessionStore.js';
import * as vault from '../../src/lib/vault.js';
import { CODE, EMAIL, addSecrets, fakeLocalStorage, makeAccountServer } from './_accountFake.js';

let tab;

beforeEach(() => {
  setStorageAdapter(createMemoryAdapter());
  vi.stubGlobal('localStorage', fakeLocalStorage());
  tab = fakeLocalStorage();
  vi.stubGlobal('sessionStorage', tab);
});

function newStore(server) {
  return createSessionStore({ api: server.api, device, vault });
}

async function signedIn(server) {
  const store = newStore(server);
  await store.init();
  await store.verifyCode(EMAIL, CODE);
  await store.registerName('Priya');
  expect(store.getState().status).toBe('ready');
  return store;
}

// A sheet that confirms with the right code (what a person does)
const confirms = (store, requests = []) =>
  store.setReauthHandler(async (req) => {
    requests.push(req);
    if (!req.sent) await req.sendCode(req.email || EMAIL);
    await req.verify(req.email || EMAIL, CODE);
    return true;
  });

const calls = (server, name) => server.calls.filter((c) => (Array.isArray(c) ? c[0] === name : c === name));

describe('requireFresh', () => {
  it('runs the action once when the session is fresh, and never opens the sheet', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    const handler = vi.fn(async () => true);
    store.setReauthHandler(handler);
    const action = vi.fn(async () => 'done');
    expect(await store.requireFresh(action)).toBe('done');
    expect(action).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('other errors pass through untouched and open nothing', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    const handler = vi.fn(async () => true);
    store.setReauthHandler(handler);
    await expect(store.requireFresh(async () => Promise.reject(Object.assign(new Error('x'), { status: 500, code: 'server_error' })))).rejects.toMatchObject({ code: 'server_error' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('reauth success: sends a code to the remembered address, verifies it, and repeats the action once', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.fresh = false;
    const requests = [];
    confirms(store, requests);
    const out = await store.setStrict(true);
    expect(out.kept).toBe(0);
    expect(store.getState().account.strict).toBe(true);
    // the order: refused, code sent to the address typed at sign in, code verified, asked again
    const names = server.calls.map((c) => (Array.isArray(c) ? c[0] : c)).filter((n) => ['postStrict', 'authRequest', 'authVerify'].includes(n));
    expect(names.slice(-4)).toEqual(['postStrict', 'authRequest', 'authVerify', 'postStrict']);
    expect(calls(server, 'authRequest').at(-1)[1]).toBe(EMAIL);
    expect(requests).toHaveLength(1);
    expect(requests[0].email).toBe(EMAIL);
    expect(requests[0].sent).toBe(true);
    expect(requests[0].emailMasked).toBe('pr***@example.com');
  });

  it('the address is asked for when this tab does not remember it, and it is never put in a link', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    tab.map.clear();
    server.fresh = false;
    const requests = [];
    confirms(store, requests);
    await store.setStrict(true);
    expect(requests[0].email).toBe('');
    expect(requests[0].sent).toBe(false);
    expect(calls(server, 'authRequest').at(-1)[1]).toBe(EMAIL);
    // the address lives only in this tab's storage, under one name, and is gone after sign out
    expect(JSON.stringify([...tab.map.entries()])).toContain(EMAIL);
    await store.signOut();
    expect(tab.map.size).toBe(0);
  });

  it('the address is only accepted if it belongs to this account (the masked form must match)', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.fresh = false;
    let sendError;
    store.setReauthHandler(async (req) => {
      try {
        await req.sendCode('someone.else@example.com');
      } catch (err) {
        sendError = err;
      }
      return false;
    });
    await expect(store.deleteAccount()).rejects.toMatchObject({ code: 'cancelled' });
    expect(sendError.code).toBe('wrong_account');
    expect(sendError.message).toContain('pr***@example.com');
    expect(calls(server, 'authRequest').filter((c) => c[1] === 'someone.else@example.com')).toHaveLength(0);
  });

  it('a remembered address that does not fit the account is not used', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    tab.setItem('hrdlock.signin.email', 'other@example.com');
    server.fresh = false;
    const requests = [];
    confirms(store, requests);
    await store.setStrict(true);
    expect(requests[0].email).toBe('');
  });

  it('a code for another account is reported, and the store shows the account the browser is now signed in as', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    const other = { id: 'e'.repeat(32), displayName: null, emailMasked: 'pr***@example.com', strict: false, createdAt: 5 };
    server.fresh = false;
    server.verifyAs = other;
    let failure;
    store.setReauthHandler(async (req) => {
      try {
        await req.verify(req.email, CODE);
        return true;
      } catch (err) {
        failure = err;
        return false;
      }
    });
    await expect(store.setStrict(true)).rejects.toMatchObject({ code: 'cancelled' });
    expect(failure.code).toBe('wrong_account');
    expect(server.account.strict).toBe(false);
  });

  it('cancel: the action reports cancelled and nothing changes', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 4);
    server.fresh = false;
    store.setReauthHandler(async () => false);
    await expect(store.setStrict(true)).rejects.toMatchObject({ code: 'cancelled', message: CANCELLED_MESSAGE });
    expect(server.account.strict).toBe(false);
    expect(server.secrets.size).toBe(4);
    expect(store.getState().account.strict).toBe(false);
    expect(calls(server, 'authVerify').length).toBe(1); // only the sign in
    expect(store.strictUnfinished()).toBe(false); // closing the sheet does not leave a half finished switch behind
    // the same for delete
    await expect(store.deleteAccount()).rejects.toMatchObject({ code: 'cancelled' });
    expect(server.account).not.toBe(null);
    expect(store.getState().status).toBe('ready');
    // and for turning Strict off
    await expect(store.setStrict(false)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('wrong code: the sheet gets the error, the person types the right one, and the action then goes through', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.fresh = false;
    const errors = [];
    store.setReauthHandler(async (req) => {
      try {
        await req.verify(req.email, '000000');
      } catch (err) {
        errors.push(err.code);
      }
      await req.verify(req.email, CODE);
      return true;
    });
    await store.setStrict(true);
    expect(errors).toEqual(['invalid_code']);
    expect(store.getState().account.strict).toBe(true);
    expect(calls(server, 'postStrict').filter((c) => c[1] !== false)).toHaveLength(2);
  });

  it('wrong code and then closing the sheet is a cancel', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.fresh = false;
    store.setReauthHandler(async (req) => {
      await req.verify(req.email, '000000').catch(() => {});
      return false;
    });
    await expect(store.deleteAccount()).rejects.toMatchObject({ code: 'cancelled' });
    expect(server.account).not.toBe(null);
  });

  it('two reauth failures: a service that keeps asking is a plain error after ONE sheet, not a loop', async () => {
    const server = makeAccountServer({ alwaysStale: true });
    const store = await signedIn(server);
    const handler = vi.fn(async (req) => {
      await req.verify(req.email, CODE);
      return true;
    });
    store.setReauthHandler(handler);
    await expect(store.deleteAccount()).rejects.toMatchObject({ code: 'reauth_failed', message: REAUTH_FAILED_MESSAGE });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls(server, 'deleteMe')).toHaveLength(2);
    expect(server.account).not.toBe(null);
    // Strict the same
    await expect(store.setStrict(true)).rejects.toMatchObject({ code: 'reauth_failed' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('without a sheet (no handler) the error is plain and nothing loops', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.fresh = false;
    await expect(store.deleteAccount()).rejects.toMatchObject({ code: 'reauth_required' });
    expect(calls(server, 'deleteMe')).toHaveLength(1);
  });

  it('two actions that both need a code share one sheet', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.fresh = false;
    let opened = 0;
    store.setReauthHandler(async (req) => {
      opened += 1;
      await new Promise((r) => setTimeout(r, 5));
      await req.verify(req.email, CODE);
      return true;
    });
    const both = await Promise.allSettled([store.requireFresh(() => server.api.getMyKey()), store.requireFresh(() => server.api.getMyKey())]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(opened).toBe(1);
  });

  it('the code could not be sent: the sheet is told and can send again', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.fresh = false;
    server.requestError = Object.assign(new Error('wait'), { status: 429, code: 'rate_limited' });
    let seen;
    store.setReauthHandler(async (req) => {
      seen = req;
      server.requestError = null;
      await req.sendCode(req.email);
      await req.verify(req.email, CODE);
      return true;
    });
    await store.deleteAccount();
    expect(seen.sent).toBe(false);
    expect(seen.sendError.code).toBe('rate_limited');
    expect(store.getState().status).toBe('signedOut');
  });

  it('delete goes through the same path: refused, confirmed, repeated', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.fresh = false;
    confirms(store);
    await store.deleteAccount();
    expect(calls(server, 'deleteMe')).toHaveLength(2);
    expect(store.getState().status).toBe('signedOut');
    expect(tab.map.size).toBe(0);
  });

  it('going back to Easy mode goes through it too', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    await store.setStrict(true);
    server.fresh = false;
    confirms(store);
    await store.setStrict(false);
    expect(server.account.strict).toBe(false);
    expect(calls(server, 'postStrict').filter((c) => c[1] === false)).toHaveLength(2);
  });

  it('a session that goes stale in the middle of the pages asks once and carries on', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 250);
    const base = server.api.postStrict;
    let n = 0;
    server.api.postStrict = async (enabled, opts) => {
      n += 1;
      if (n === 3) server.fresh = false; // after page 1 and its confirm
      return base(enabled, opts);
    };
    const handler = vi.fn(async (req) => {
      await req.verify(req.email, CODE);
      return true;
    });
    store.setReauthHandler(handler);
    const out = await store.setStrict(true);
    expect(out.kept).toBe(250);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(vault.localList('a:' + server.account.id)).toHaveLength(250);
  });
});

describe('the key on a new device with an old session', () => {
  async function secondDevice(server) {
    const first = await signedIn(server);
    expect(first.getState().keys[0].hasCloudCopy).toBe(true);
    setStorageAdapter(createMemoryAdapter()); // a device with no key yet, the cookie is still valid
    server.fresh = false;
    const store = newStore(server);
    await store.init();
    return store;
  }

  it('asks for a code instead of failing for ever, then loads the key', async () => {
    const server = makeAccountServer();
    const store = await secondDevice(server);
    expect(store.getState().status).toBe('needsKey');
    expect(store.getState().keyProblem).toBe('reauth');
    await expect(store.registerName('Another')).rejects.toThrow(KEY_REAUTH_MESSAGE);
    expect(server.keys).toHaveLength(1); // no second key was made

    confirms(store);
    await store.unlockKey();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().identity.keyId).toBe(server.keys[0].keyId);
    expect(store.getState().keyProblem).toBe(false);
  });

  it('cancelling leaves things as they are', async () => {
    const server = makeAccountServer();
    const store = await secondDevice(server);
    store.setReauthHandler(async () => false);
    await expect(store.unlockKey()).rejects.toMatchObject({ code: 'cancelled' });
    expect(store.getState().status).toBe('needsKey');
    expect(store.getState().keyProblem).toBe('reauth');
  });

  it('only works while a key is needed', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    await expect(store.unlockKey()).rejects.toThrow(/sign in/i);
  });
});
