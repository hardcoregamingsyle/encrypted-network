// Strict mode in pages: the session store walks every page the service hands over, stores each page on this
// device, reads it back, and only then confirms it. Server: tests/app/_accountFake.js (follows strict.js).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api.js';
import * as device from '../../src/lib/deviceKey.js';
import { createMemoryAdapter, setStorageAdapter } from '../../src/lib/keystore.js';
import { STRICT_STORAGE_MESSAGE, createSessionStore } from '../../src/lib/sessionStore.js';
import * as vault from '../../src/lib/vault.js';
import { CODE, EMAIL, addSecrets, blockedStorage, docIdOf, fakeLocalStorage, makeAccountServer, passwordOf } from './_accountFake.js';

let ls;

beforeEach(() => {
  setStorageAdapter(createMemoryAdapter());
  ls = fakeLocalStorage();
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('sessionStorage', fakeLocalStorage());
});

function newStore(server, v = vault) {
  return createSessionStore({ api: server.api, device, vault: v });
}

async function signedIn(server, v = vault) {
  const store = newStore(server, v);
  await store.init();
  await store.verifyCode(EMAIL, CODE);
  await store.registerName('Priya');
  expect(store.getState().status).toBe('ready');
  return store;
}

const accountScope = (server) => 'a:' + server.account.id;
const strictCalls = (server) => server.calls.filter((c) => Array.isArray(c) && c[0] === 'postStrict').map((c) => c[1]);

describe('Strict on with N stored passwords', () => {
  it.each([
    [0, 1, 0],
    [1, 1, 1],
    [100, 1, 1],
    [101, 2, 2],
    [250, 3, 3]
  ])('%i passwords: %i page(s) asked, %i confirmed, every password stored here, nothing left on the service', async (n, pages, confirms) => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, n);
    const progress = [];
    const out = await store.setStrict(true, { onProgress: (p) => progress.push(p) });

    expect(out.kept).toBe(n);
    expect(out.passwords).toHaveLength(n);
    expect(out.unreadable).toBe(0);
    const calls = strictCalls(server);
    expect(calls.filter((c) => c.confirmThrough === undefined)).toHaveLength(pages);
    expect(calls.filter((c) => c.confirmThrough !== undefined)).toHaveLength(confirms * (n === 0 ? 0 : 1));
    // the passwords are on this device, read back
    const local = vault.localList(accountScope(server));
    expect(local).toHaveLength(n);
    for (let i = 1; i <= n; i++) expect(local.find((x) => x.docId === docIdOf(i)).password).toBe(passwordOf(i));
    expect(server.handover.size).toBe(0);
    expect(store.getState().account.strict).toBe(true);
    expect(store.getState().keys.every((k) => !k.hasCloudCopy)).toBe(true);
    expect(store.strictUnfinished()).toBe(false);
    // progress: grows page by page and ends with done
    expect(progress.at(-1)).toEqual({ saved: n, done: true });
    expect(progress.slice(0, -1).every((p) => p.done === false)).toBe(true);
    expect(progress.map((p) => p.saved)).toEqual([...progress.map((p) => p.saved)].sort((a, b) => a - b));
  });

  it('walks the pages in order: after is the next of the page before, and each page is confirmed before the next is asked', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 250);
    await store.setStrict(true);
    expect(strictCalls(server)).toEqual([
      {},
      { confirmThrough: docIdOf(100) },
      { after: docIdOf(100) },
      { confirmThrough: docIdOf(200) },
      { after: docIdOf(200) },
      { confirmThrough: docIdOf(250) }
    ]);
  });

  it('the account shows as Strict only after everything is stored', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 150);
    const seen = [];
    await store.setStrict(true, { onProgress: () => seen.push(store.getState().account.strict) });
    expect(seen).toEqual([false, false]);
    expect(store.getState().account.strict).toBe(true);
  });

  it('counts the passwords the service could not read, and says nothing is lost silently', async () => {
    const server = makeAccountServer({ unreadableOnFirstPage: 3 });
    const store = await signedIn(server);
    addSecrets(server, 5);
    const out = await store.setStrict(true);
    expect(out.unreadable).toBe(3);
    expect(out.kept).toBe(5);
  });

  it('adds up the unreadable count over the pages', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 150);
    const base = server.api.postStrict;
    let page = 0;
    server.api.postStrict = async (enabled, opts) => {
      const answer = await base(enabled, opts);
      if (enabled && opts && opts.confirmThrough === undefined) {
        page += 1;
        answer.unreadable = page; // 1 on the first page, 2 on the second
      }
      return answer;
    };
    const out = await store.setStrict(true);
    expect(out.unreadable).toBe(3);
  });

  it('an account in Easy mode again leaves the passwords it keeps on this device alone', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 3);
    await store.setStrict(true);
    await store.setStrict(false);
    expect(server.account.strict).toBe(false);
    expect(vault.localList(accountScope(server))).toHaveLength(3);
    expect(strictCalls(server).at(-1)).toBe(false);
    expect(strictCalls(server).filter((c) => c === false)).toHaveLength(1);
  });
});

describe('Strict on when storing fails halfway', () => {
  it('a failure while storing page 2 keeps the rest on the service, and a retry resumes without losing anything', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 250);

    // the browser storage fills up after page 1 is stored and confirmed
    await expect(
      store.setStrict(true, {
        onProgress: (p) => {
          if (p.saved === 100) ls.failWrites = true;
        }
      })
    ).rejects.toMatchObject({ code: 'strict_unfinished' });

    // page 1 was confirmed and is gone from the service, pages 2 and 3 are still there
    expect(server.handover.size).toBe(150);
    expect([...server.handover.keys()].sort()[0]).toBe(docIdOf(101));
    // the account does not show as Strict yet, and the screen can offer to finish
    expect(store.getState().account.strict).toBe(false);
    expect(store.strictUnfinished()).toBe(true);
    expect(vault.localList(accountScope(server))).toHaveLength(100);

    // the same person tries to go back to Easy: refused, because that would delete the 150
    ls.failWrites = false;
    await expect(store.setStrict(false)).rejects.toThrow(/not finished/);
    expect(server.handover.size).toBe(150);

    // retry: the service gives the same pages again, from the first unconfirmed one
    const before = strictCalls(server).length;
    const out = await store.setStrict(true);
    expect(out.kept).toBe(150);
    expect(strictCalls(server).slice(before)[0]).toEqual({});
    expect(server.handover.size).toBe(0);
    expect(vault.localList(accountScope(server))).toHaveLength(250);
    expect(store.getState().account.strict).toBe(true);
    expect(store.strictUnfinished()).toBe(false);
  });

  it('the error carries the passwords handed over so far, so the screen can offer a download', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 250);
    let err;
    try {
      await store.setStrict(true, { onProgress: (p) => { if (p.saved === 100) ls.failWrites = true; } });
    } catch (e) {
      err = e;
    }
    expect(err.passwords).toHaveLength(200); // page 1 stored, page 2 handed over but not stored
    expect(err.passwords[0]).toEqual({ docId: docIdOf(1), password: passwordOf(1) });
  });

  it('a lost answer to the confirm call costs nothing: the retry asks again and gets the same page', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 150);
    let failed = false;
    server.failStrictCall = ({ through }) => {
      if (through !== undefined && !failed) {
        failed = true;
        return true;
      }
      return false;
    };
    await expect(store.setStrict(true)).rejects.toMatchObject({ code: 'network' });
    expect(server.handover.size).toBe(150); // nothing was deleted
    expect(store.getState().account.strict).toBe(false);
    expect(store.strictUnfinished()).toBe(true);
    const out = await store.setStrict(true);
    expect(out.kept).toBe(150);
    expect(vault.localList(accountScope(server))).toHaveLength(150);
    expect(server.handover.size).toBe(0);
  });

  it('a lost answer to a page asked for changes nothing either', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 120);
    let pagesAsked = 0;
    server.failStrictCall = ({ after, through }) => {
      if (through === undefined && after !== undefined) {
        pagesAsked += 1;
        return pagesAsked === 1;
      }
      return false;
    };
    await expect(store.setStrict(true)).rejects.toMatchObject({ code: 'network' });
    expect(server.handover.size).toBe(20); // page 1 stored and confirmed, page 2 waits
    await store.setStrict(true);
    expect(vault.localList(accountScope(server))).toHaveLength(120);
  });

  it('a write that says it worked but did not keep the password is caught by the read back', async () => {
    const server = makeAccountServer();
    const lying = { ...vault, keepHandedOver: (list) => list.length, localList: () => [] };
    const store = await signedIn(server, lying);
    addSecrets(server, 3);
    await expect(store.setStrict(true)).rejects.toMatchObject({ code: 'strict_unfinished' });
    expect(store.getState().account.strict).toBe(false);
  });

  it('an unfinished switch is forgotten after the 24 hours the service keeps the passwords', () => {
    const id = 'c'.repeat(32);
    expect(vault.markStrictRun(id, 1000)).toBe(true);
    expect(vault.strictRunOpen(id, 1000 + 23 * 3600 * 1000)).toBe(true);
    expect(vault.strictRunOpen(id, 1000 + 25 * 3600 * 1000)).toBe(false);
    vault.clearStrictRun(id);
    expect(vault.strictRunOpen(id, 1001)).toBe(false);
  });
});

describe('Strict on when the browser storage is not available', () => {
  it('refuses with a plain message and asks the service for nothing', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 5);
    vi.stubGlobal('localStorage', blockedStorage());
    await expect(store.setStrict(true)).rejects.toThrow(STRICT_STORAGE_MESSAGE);
    expect(strictCalls(server)).toEqual([]);
    expect(server.account.strict).toBe(false);
    expect(server.secrets.size).toBe(5);
    expect(store.getState().account.strict).toBe(false);
  });

  it('no storage object at all is the same', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    vi.stubGlobal('localStorage', undefined);
    await expect(store.setStrict(true)).rejects.toThrow(STRICT_STORAGE_MESSAGE);
    expect(strictCalls(server)).toEqual([]);
  });
});

describe('Strict on with an answer that is not right', () => {
  it('a next that is not a document id is refused before anything is confirmed', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    addSecrets(server, 5);
    server.mangleNext = () => 'not-an-id';
    await expect(store.setStrict(true)).rejects.toMatchObject({ code: 'strict_answer' });
    expect(strictCalls(server).filter((c) => c.confirmThrough !== undefined)).toEqual([]);
    expect(server.handover.size).toBe(5);
  });

  it('a service that repeats the same page does not trap the tab', async () => {
    const server = makeAccountServer({ pageSize: 2 });
    const store = await signedIn(server);
    addSecrets(server, 6);
    // the page is confirmed but the service keeps saying "go on after the first page"
    server.mangleNext = () => docIdOf(2);
    await expect(store.setStrict(true)).rejects.toMatchObject({ code: 'strict_answer' });
    expect(strictCalls(server).length).toBeLessThan(10);
  });

  it('passwords with a bad id or an empty text are left out, not stored', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    const base = server.api.postStrict;
    server.api.postStrict = async (enabled, opts) => {
      const answer = await base(enabled, opts);
      if (enabled && opts && opts.confirmThrough === undefined) {
        answer.passwords.push({ docId: 'zz', password: 'x' }, { docId: docIdOf(900), password: '' }, null);
      }
      return answer;
    };
    addSecrets(server, 2);
    const out = await store.setStrict(true);
    expect(out.kept).toBe(2);
    expect(vault.localList(accountScope(server))).toHaveLength(2);
  });
});

describe('Strict from the name step (before any key exists)', () => {
  it('works with no passwords and no key yet', async () => {
    const server = makeAccountServer();
    const store = newStore(server);
    await store.init();
    await store.verifyCode(EMAIL, CODE);
    expect(store.getState().status).toBe('needsKey');
    const out = await store.setStrict(true);
    expect(out.kept).toBe(0);
    expect(store.getState().account.strict).toBe(true);
    await store.registerName('Priya');
    const sent = server.calls.find((c) => Array.isArray(c) && c[0] === 'postMyKey')[1];
    expect(sent.privateJwk).toBeUndefined();
  });
});

describe('Easy mode', () => {
  it('is one call, and the error of the service is shown as it is', async () => {
    const server = makeAccountServer();
    const store = await signedIn(server);
    await store.setStrict(true);
    server.failStrictCall = () => true;
    await expect(store.setStrict(false)).rejects.toMatchObject({ code: 'network' });
    expect(store.getState().account.strict).toBe(true);
    server.failStrictCall = null;
    await store.setStrict(false);
    expect(strictCalls(server).filter((c) => c === false)).toHaveLength(2);
    expect(ApiError).toBeTruthy();
  });
});
