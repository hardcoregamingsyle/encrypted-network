// Where the account is signed in, sign out everywhere, and a session that ends while the app is in use.
// Server: tests/app/_accountFake.js.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as device from '../../src/lib/deviceKey.js';
import { createMemoryAdapter, setStorageAdapter } from '../../src/lib/keystore.js';
import { SESSION_ENDED_NOTICE, createSessionStore } from '../../src/lib/sessionStore.js';
import * as vault from '../../src/lib/vault.js';
import { CODE, EMAIL, fakeLocalStorage, makeAccountServer, settle } from './_accountFake.js';

beforeEach(() => {
  setStorageAdapter(createMemoryAdapter());
  vi.stubGlobal('localStorage', fakeLocalStorage());
  vi.stubGlobal('sessionStorage', fakeLocalStorage());
});

function newStore(server) {
  return createSessionStore({ api: server.api, device, vault });
}

async function signedIn(server) {
  const store = newStore(server);
  await store.init();
  await store.verifyCode(EMAIL, CODE);
  await store.registerName('Priya');
  return store;
}

const sessionsOf = (server) => {
  server.sessions = [
    server.makeSession('a'.repeat(16), { current: true, createdAt: 5000, lastSeenAt: 9000 }),
    server.makeSession('b'.repeat(16), { createdAt: 4000, lastSeenAt: 4500 }),
    server.makeSession('c'.repeat(16), { createdAt: 3000, lastSeenAt: 3500 })
  ];
};

describe('the devices list', () => {
  it('lists the sessions as the service sends them, this device marked', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    sessionsOf(server);
    const list = await store.listSessions();
    expect(list.map((s) => [s.id, s.current])).toEqual([
      ['a'.repeat(16), true],
      ['b'.repeat(16), false],
      ['c'.repeat(16), false]
    ]);
    expect(list[0]).toEqual({ id: 'a'.repeat(16), createdAt: 5000, lastSeenAt: 9000, expiresAt: 9000, current: true });
  });

  it('leaves out rows without an id and fixes odd numbers', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.api.getSessions = async () => ({ sessions: [null, { id: '' }, { id: 'd'.repeat(16), createdAt: 'x', current: 'yes' }] });
    expect(await store.listSessions()).toEqual([{ id: 'd'.repeat(16), createdAt: 0, lastSeenAt: 0, expiresAt: 0, current: false }]);
    server.api.getSessions = async () => ({ sessions: 'nope' });
    expect(await store.listSessions()).toEqual([]);
  });

  it('needs an account', async () => {
    const store = newStore(makeAccountServer());
    await store.init();
    await expect(store.listSessions()).rejects.toThrow(/sign in/i);
    await expect(store.endOtherSessions()).rejects.toThrow(/sign in/i);
    await expect(store.endSession('a'.repeat(16))).rejects.toThrow(/sign in/i);
  });

  it('sign out other devices ends the others and keeps this one', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    sessionsOf(server);
    const out = await store.endOtherSessions();
    expect(out).toEqual({ ended: 2 });
    expect((await store.listSessions()).map((s) => s.current)).toEqual([true]);
    expect(store.getState().status).toBe('ready');
  });

  it('sign out one other device; a device that is gone already counts as done', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    sessionsOf(server);
    await store.endSession('b'.repeat(16));
    expect(server.sessions.map((s) => s.id)).toEqual(['a'.repeat(16), 'c'.repeat(16)]);
    await expect(store.endSession('b'.repeat(16))).resolves.toEqual({ ended: 1 });
  });

  it('a failure other than "gone" is shown', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    sessionsOf(server);
    server.down = true;
    await expect(store.endSession('b'.repeat(16))).rejects.toMatchObject({ code: 'network' });
    await expect(store.endOtherSessions()).rejects.toMatchObject({ code: 'network' });
  });
});

describe('sign out everywhere', () => {
  it('asks the service to end every session and leaves this browser signed out like a plain sign out', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    await store.signOut({ all: true });
    expect(server.calls).toContain('authLogoutAll');
    expect(server.calls).not.toContain('authLogout');
    expect(store.getState().status).toBe('signedOut');
    expect((await device.loadAccountKeys(server.account.id)).active).toBe(null); // Easy: the key can be downloaded again
  });

  it('a Strict account keeps its key on this device', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    await store.setStrict(true);
    await store.signOut({ all: true });
    expect(store.getState().status).toBe('signedOut');
    expect((await device.loadAccountKeys(server.account.id)).active).toBeTruthy();
  });

  it('a session that ran out already counts as signed out', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.signedIn = false;
    await store.signOut({ all: true });
    expect(store.getState().status).toBe('signedOut');
  });

  it('a lost connection changes nothing', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.api.authLogout = async () => {
      throw Object.assign(new Error('offline'), { status: 0, code: 'network' });
    };
    await expect(store.signOut({ all: true })).rejects.toMatchObject({ code: 'network' });
    expect(store.getState().status).toBe('ready');
  });

  it('the plain sign out still sends no flag', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    await store.signOut();
    expect(server.calls).toContain('authLogout');
    expect(server.calls).not.toContain('authLogoutAll');
  });
});

describe('a 401 in the middle of using the app', () => {
  it('moves to the signed out state with a short message, not an error', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.signedIn = false; // the session ended on the server (signed out elsewhere, or 90 days)
    await expect(server.api.getSessions()).rejects.toMatchObject({ code: 'unauthenticated' }); // the api layer tells the store
    await settle();
    const s = store.getState();
    expect(s.status).toBe('signedOut');
    expect(s.mode).toBe(null);
    expect(s.notice).toBe(SESSION_ENDED_NOTICE);
    expect(s.error).toBe('');
    expect(s.account).toBe(null);
  });

  it('a burst of calls that fail together makes one look', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.signedIn = false;
    const before = server.calls.filter((c) => c === 'getMe').length;
    await Promise.allSettled([server.api.getSessions(), server.api.getSessions(), server.api.endOtherSessions()]);
    await settle();
    expect(server.calls.filter((c) => c === 'getMe').length - before).toBe(1);
    expect(store.getState().notice).toBe(SESSION_ENDED_NOTICE);
  });

  it('a stray 401 while the session is fine changes nothing', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.onUnauth(Object.assign(new Error('x'), { status: 401, code: 'unauthenticated' }));
    await settle();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().notice).toBe('');
  });

  it('the notice goes away when the person signs in again, or dismisses it', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.signedIn = false;
    await expect(server.api.getSessions()).rejects.toBeTruthy();
    await settle();
    expect(store.getState().notice).toBe(SESSION_ENDED_NOTICE);
    store.dismissNotice();
    expect(store.getState().notice).toBe('');

    server.signedIn = false;
    store.getState();
    await store.verifyCode(EMAIL, CODE);
    expect(store.getState().notice).toBe('');
  });

  it('a Quick start person is not told anything (they have no session)', async () => {
    const server = makeAccountServer();
    const store = newStore(server);
    await store.init();
    await store.startGuest('Asha');
    server.onUnauth(Object.assign(new Error('x'), { status: 401, code: 'unauthenticated' }));
    await settle();
    expect(store.getState().mode).toBe('guest');
    expect(store.getState().notice).toBe('');
  });

  it('a lost connection is not a sign out', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    server.down = true;
    server.onUnauth(Object.assign(new Error('x'), { status: 401, code: 'unauthenticated' }));
    await settle();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().notice).toBe('');
  });
});

describe('nobody signed in is not an error', () => {
  it('GET /api/me answering 401 on the first look leaves no error and no notice', async () => {
    const server = makeAccountServer();
    const store = newStore(server);
    await store.init();
    const s = store.getState();
    expect(s.status).toBe('signedOut');
    expect(s.error).toBe('');
    expect(s.notice).toBe('');
    expect(s.keyProblem).toBe(false);
  });

  it('the first look does not tell the 401 handler (no "your sign in ended" for a visitor)', async () => {
    const server = makeAccountServer();
    const seen = vi.fn();
    const base = server.api.setUnauthenticatedHandler;
    server.api.setUnauthenticatedHandler = (fn) => base((e) => (seen(e), fn(e)));
    const store = newStore(server);
    await store.init();
    expect(seen).not.toHaveBeenCalled();
    expect(store.getState().notice).toBe('');
  });
});
