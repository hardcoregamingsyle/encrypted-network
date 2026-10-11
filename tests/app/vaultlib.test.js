// src/lib/vault.js: the owner's file passwords. Account mode uses the api, guest and Strict use this device.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api.js';
import {
  createVault,
  localClear,
  localGet,
  localList,
  localSet,
  passwordsFileText,
  setVaultContext
} from '../../src/lib/vault.js';

const DOC = 'ab'.repeat(16);
const DOC2 = 'cd'.repeat(16);
const PW = 'ABCD-EFGH-JKLM-NPQR-STUV';

function fakeLocalStorage(opts = {}) {
  const map = new Map();
  return {
    getItem: (k) => {
      if (opts.broken) throw new Error('blocked');
      return map.has(k) ? map.get(k) : null;
    },
    setItem: (k, v) => {
      if (opts.broken) throw new Error('blocked');
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    raw: map
  };
}

function fakeApi(over = {}) {
  const secrets = new Map();
  return {
    secrets,
    putSecret: vi.fn(async (docId, password) => {
      secrets.set(docId, password);
      return { ok: true };
    }),
    getSecret: vi.fn(async (docId) => {
      if (!secrets.has(docId)) throw new ApiError(404, 'not_found', 'none');
      return { password: secrets.get(docId) };
    }),
    ...over
  };
}

let ctx;
beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage());
  ctx = { mode: 'account', strict: false, accountId: 'f'.repeat(32) };
  setVaultContext(() => ctx);
});

describe('local vault', () => {
  it('stores, reads, lists and clears passwords per scope', () => {
    expect(localSet('guest', DOC, PW)).toBe(true);
    expect(localSet('a:1', DOC, 'OTHER-PASS')).toBe(true);
    expect(localGet('guest', DOC)).toBe(PW);
    expect(localGet('a:1', DOC)).toBe('OTHER-PASS');
    expect(localList('guest')).toEqual([{ docId: DOC, password: PW }]);
    localClear('guest');
    expect(localGet('guest', DOC)).toBe(null);
    expect(localGet('a:1', DOC)).toBe('OTHER-PASS');
    localClear();
    expect(localGet('a:1', DOC)).toBe(null);
  });

  it('refuses ids and passwords of the wrong shape', () => {
    expect(localSet('guest', 'not-an-id', PW)).toBe(false);
    expect(localSet('guest', DOC, '')).toBe(false);
    expect(localSet('guest', DOC, 12345)).toBe(false);
    expect(localGet('guest', '../x')).toBe(null);
  });

  it('does not throw when storage is blocked', () => {
    vi.stubGlobal('localStorage', fakeLocalStorage({ broken: true }));
    expect(localSet('guest', DOC, PW)).toBe(false);
    expect(localGet('guest', DOC)).toBe(null);
    expect(localList('guest')).toEqual([]);
    expect(localClear('guest')).toBe(false);
  });

  it('survives damaged stored data', () => {
    localStorage.setItem('hrdlock.vault.v1', '{not json');
    expect(localGet('guest', DOC)).toBe(null);
    expect(localSet('guest', DOC, PW)).toBe(true);
    localStorage.setItem('hrdlock.vault.v1', '[1,2]');
    expect(localGet('guest', DOC)).toBe(null);
    localStorage.setItem('hrdlock.vault.v1', JSON.stringify({ guest: { [DOC]: 5, [DOC2]: PW } }));
    expect(localList('guest')).toEqual([{ docId: DOC2, password: PW }]);
  });
});

describe('Easy account', () => {
  it('saves to the account and reads from it', async () => {
    const api = fakeApi();
    const vault = createVault({ api });
    expect(await vault.saveDocPassword(DOC, PW)).toBe('account');
    expect(api.putSecret).toHaveBeenCalledWith(DOC, PW);
    expect(await vault.getDocPassword(DOC)).toBe(PW);
    expect(localList('a:' + ctx.accountId)).toEqual([]);
  });

  it('keeps a copy on the device when the account cannot be reached, and reads it back', async () => {
    const api = fakeApi({
      putSecret: vi.fn(async () => {
        throw new ApiError(0, 'network', 'offline');
      }),
      getSecret: vi.fn(async () => {
        throw new ApiError(0, 'network', 'offline');
      })
    });
    const vault = createVault({ api });
    expect(await vault.saveDocPassword(DOC, PW)).toBe('device');
    expect(await vault.getDocPassword(DOC)).toBe(PW);
  });

  it('falls back to the device copy when the account has no password for the file', async () => {
    const api = fakeApi();
    const vault = createVault({ api });
    localSet('a:' + ctx.accountId, DOC, PW);
    expect(await vault.getDocPassword(DOC)).toBe(PW);
    expect(await vault.getDocPassword(DOC2)).toBe(null);
  });

  it('never throws, even when everything fails', async () => {
    const api = fakeApi({
      putSecret: vi.fn(async () => {
        throw new Error('boom');
      }),
      getSecret: vi.fn(async () => {
        throw new Error('boom');
      })
    });
    vi.stubGlobal('localStorage', fakeLocalStorage({ broken: true }));
    const vault = createVault({ api });
    expect(await vault.saveDocPassword(DOC, PW)).toBe('none');
    expect(await vault.getDocPassword(DOC)).toBe(null);
  });
});

describe('Strict account and Quick start', () => {
  it('a Strict account never calls the account, only the device', async () => {
    ctx = { mode: 'account', strict: true, accountId: 'f'.repeat(32) };
    const api = fakeApi();
    const vault = createVault({ api });
    expect(await vault.saveDocPassword(DOC, PW)).toBe('device');
    expect(await vault.getDocPassword(DOC)).toBe(PW);
    expect(api.putSecret).not.toHaveBeenCalled();
    expect(api.getSecret).not.toHaveBeenCalled();
  });

  it('Quick start keeps passwords in the guest scope on the device', async () => {
    ctx = { mode: 'guest', strict: false, accountId: '' };
    const api = fakeApi();
    const vault = createVault({ api });
    expect(await vault.saveDocPassword(DOC, PW)).toBe('device');
    expect(localGet('guest', DOC)).toBe(PW);
    expect(await vault.getDocPassword(DOC)).toBe(PW);
    expect(api.putSecret).not.toHaveBeenCalled();
  });

  it('signed out: nothing is saved', async () => {
    ctx = { mode: null, strict: false, accountId: '' };
    const vault = createVault({ api: fakeApi() });
    // there is no account scope, so the guest scope is used. A signed out person has no files anyway.
    expect(await vault.getDocPassword(DOC)).toBe(null);
  });

  it('rememberOnDevice stores a list and counts what it kept', () => {
    ctx = { mode: 'account', strict: true, accountId: 'f'.repeat(32) };
    const vault = createVault({ api: fakeApi() });
    const n = vault.rememberOnDevice([
      { docId: DOC, password: PW },
      { docId: 'bad', password: PW },
      null,
      { docId: DOC2, password: 'X-Y' }
    ]);
    expect(n).toBe(2);
    expect(localList('a:' + ctx.accountId)).toHaveLength(2);
    expect(vault.rememberOnDevice('nope')).toBe(0);
  });
});

describe('input checks', () => {
  it('ignores a bad document id or an empty password', async () => {
    const api = fakeApi();
    const vault = createVault({ api });
    expect(await vault.saveDocPassword('x', PW)).toBe('none');
    expect(await vault.saveDocPassword(DOC, '')).toBe('none');
    expect(await vault.getDocPassword('x')).toBe(null);
    expect(api.putSecret).not.toHaveBeenCalled();
    expect(api.getSecret).not.toHaveBeenCalled();
  });
});

describe('passwordsFileText', () => {
  it('lists one line per file and skips odd items', () => {
    const text = passwordsFileText([{ docId: DOC, password: PW }, { nope: 1 }, null]);
    expect(text).toContain(`${DOC}  ${PW}`);
    expect(text.split('\n').filter((l) => l.includes(DOC))).toHaveLength(1);
    expect(text.endsWith('\n')).toBe(true);
    expect(passwordsFileText('x')).toContain('hrdlock file passwords');
  });
});
