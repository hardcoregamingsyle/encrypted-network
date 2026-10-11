// Trust on first use for the server key: remember on the first visit, warn when it changes, and an
// explicitly pinned key always wins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRUST_STATES,
  chooseEffectiveKey,
  classifyServerKey,
  clearPin,
  currentServerKeyId,
  effectivePinnedKey,
  forgetRememberedServerKey,
  getPinnedServerKeyId,
  getRememberedServerKeyId,
  loadServerTrust,
  prepareServerTrust,
  rememberServerKey,
  resetServerKeyCache,
  serverKeyTrust,
  setPinnedServerKeyId
} from '../../src/lib/pin.js';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const C = 'c3'.repeat(32);

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k)
  };
}

function throwingStorage() {
  const boom = () => {
    throw new Error('storage blocked');
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
  resetServerKeyCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remembering a server key', () => {
  it('starts empty, remembers a valid id and forgets it again', () => {
    expect(getRememberedServerKeyId()).toBe('');
    expect(rememberServerKey(A)).toBe(true);
    expect(getRememberedServerKeyId()).toBe(A);
    expect(forgetRememberedServerKey()).toBe(true);
    expect(getRememberedServerKeyId()).toBe('');
  });

  it('fixes case and outer spaces and refuses anything that is not 64 hex characters', () => {
    expect(rememberServerKey('  ' + A.toUpperCase() + ' ')).toBe(true);
    expect(getRememberedServerKeyId()).toBe(A);
    for (const bad of ['', 'abc', A.slice(1), A + 'a', 'g'.repeat(64), null, undefined, 5, {}, [A]]) {
      expect(rememberServerKey(bad)).toBe(false);
    }
    expect(getRememberedServerKeyId()).toBe(A);
  });

  it('ignores a damaged stored value', () => {
    localStorage.setItem('hrdlock.rememberedServerKeyId', 'not a key');
    expect(getRememberedServerKeyId()).toBe('');
  });

  it('is kept apart from the pin: clearing the pin keeps it, forgetting it keeps the pin', () => {
    setPinnedServerKeyId(A);
    rememberServerKey(B);
    clearPin();
    expect(getPinnedServerKeyId()).toBe('');
    expect(getRememberedServerKeyId()).toBe(B);
    setPinnedServerKeyId(C);
    forgetRememberedServerKey();
    expect(getPinnedServerKeyId()).toBe(C);
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', throwingStorage());
    expect(getRememberedServerKeyId()).toBe('');
    expect(rememberServerKey(A)).toBe(false);
    expect(forgetRememberedServerKey()).toBe(false);
    expect(serverKeyTrust(A)).toBe('first-visit');
    expect(effectivePinnedKey(A)).toBe(A);
  });

  it('survives a missing localStorage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(getRememberedServerKeyId()).toBe('');
    expect(rememberServerKey(A)).toBe(false);
    expect(effectivePinnedKey(A)).toBe(A);
  });

  it('does not report success when storage silently drops the write', () => {
    const s = fakeStorage();
    s.setItem = () => {};
    vi.stubGlobal('localStorage', s);
    expect(rememberServerKey(A)).toBe(false);
  });
});

describe('classifyServerKey (pure)', () => {
  it('is a first visit when nothing is pinned or remembered', () => {
    expect(classifyServerKey({ current: A })).toBe('first-visit');
    expect(classifyServerKey({})).toBe('first-visit');
    expect(classifyServerKey()).toBe('first-visit');
  });

  it('compares the current key with the remembered key', () => {
    expect(classifyServerKey({ remembered: A, current: A })).toBe('remembered-match');
    expect(classifyServerKey({ remembered: A, current: B })).toBe('remembered-mismatch');
  });

  it('compares the current key with the pin, and the pin wins over a remembered key', () => {
    expect(classifyServerKey({ pinned: A, current: A })).toBe('pinned-match');
    expect(classifyServerKey({ pinned: A, current: B })).toBe('pinned-mismatch');
    expect(classifyServerKey({ pinned: A, remembered: B, current: A })).toBe('pinned-match');
    expect(classifyServerKey({ pinned: A, remembered: B, current: B })).toBe('pinned-mismatch');
  });

  it('a missing or malformed current key never counts as a match', () => {
    for (const cur of ['', undefined, null, 'zz', 5, {}, A.slice(2)]) {
      expect(classifyServerKey({ pinned: A, current: cur })).toBe('pinned-mismatch');
      expect(classifyServerKey({ remembered: A, current: cur })).toBe('remembered-mismatch');
    }
  });

  it('ignores a malformed pin or remembered value', () => {
    expect(classifyServerKey({ pinned: 'nope', remembered: A, current: A })).toBe('remembered-match');
    expect(classifyServerKey({ pinned: 'nope', remembered: 'nope', current: A })).toBe('first-visit');
  });

  it('upper case and outer spaces do not matter', () => {
    expect(classifyServerKey({ pinned: ' ' + A.toUpperCase(), current: A })).toBe('pinned-match');
  });

  it('only ever returns one of the five states', () => {
    const values = ['', A, B, 'x', null];
    for (const pinned of values) {
      for (const remembered of values) {
        for (const current of values) {
          expect(TRUST_STATES).toContain(classifyServerKey({ pinned, remembered, current }));
        }
      }
    }
  });
});

describe('chooseEffectiveKey (pure)', () => {
  it('prefers the pin, then the remembered key, then the current key which is to be remembered', () => {
    expect(chooseEffectiveKey({ pinned: A, remembered: B, current: C })).toEqual({ key: A, remember: false });
    expect(chooseEffectiveKey({ remembered: B, current: C })).toEqual({ key: B, remember: false });
    expect(chooseEffectiveKey({ current: C })).toEqual({ key: C, remember: true });
    expect(chooseEffectiveKey({})).toEqual({ key: '', remember: false });
    expect(chooseEffectiveKey()).toEqual({ key: '', remember: false });
    expect(chooseEffectiveKey({ current: 'nope' })).toEqual({ key: '', remember: false });
  });
});

describe('serverKeyTrust and effectivePinnedKey (with storage)', () => {
  it('first visit: the current key is used and then remembered', () => {
    expect(serverKeyTrust(A)).toBe('first-visit');
    expect(getRememberedServerKeyId()).toBe('');
    expect(effectivePinnedKey(A)).toBe(A);
    expect(getRememberedServerKeyId()).toBe(A);
    expect(serverKeyTrust(A)).toBe('remembered-match');
  });

  it('serverKeyTrust alone never remembers anything', () => {
    serverKeyTrust(A);
    serverKeyTrust(B);
    expect(getRememberedServerKeyId()).toBe('');
  });

  it('a changed key after the first visit is a mismatch and the old key stays the effective one', () => {
    effectivePinnedKey(A);
    expect(serverKeyTrust(B)).toBe('remembered-mismatch');
    expect(effectivePinnedKey(B)).toBe(A);
    expect(getRememberedServerKeyId()).toBe(A);
    expect(serverKeyTrust(B)).toBe('remembered-mismatch');
  });

  it('an explicit pin wins and does not touch the remembered key', () => {
    setPinnedServerKeyId(C);
    expect(serverKeyTrust(C)).toBe('pinned-match');
    expect(serverKeyTrust(A)).toBe('pinned-mismatch');
    expect(effectivePinnedKey(A)).toBe(C);
    expect(getRememberedServerKeyId()).toBe('');
    rememberServerKey(B);
    expect(effectivePinnedKey(A)).toBe(C);
    expect(serverKeyTrust(B)).toBe('pinned-mismatch');
  });

  it('after the pin is cleared the remembered key is used again', () => {
    rememberServerKey(B);
    setPinnedServerKeyId(C);
    clearPin();
    expect(effectivePinnedKey(A)).toBe(B);
    expect(serverKeyTrust(A)).toBe('remembered-mismatch');
  });

  it('forgetting the remembered key makes the next visit a first visit', () => {
    effectivePinnedKey(A);
    forgetRememberedServerKey();
    expect(serverKeyTrust(B)).toBe('first-visit');
    expect(effectivePinnedKey(B)).toBe(B);
    expect(getRememberedServerKeyId()).toBe(B);
  });

  it('with no current key and nothing stored the effective key is empty and nothing is remembered', () => {
    expect(effectivePinnedKey('')).toBe('');
    expect(effectivePinnedKey(undefined)).toBe('');
    expect(effectivePinnedKey('garbage')).toBe('');
    expect(getRememberedServerKeyId()).toBe('');
  });

  it('with no current key the stored key is still the effective one', () => {
    rememberServerKey(A);
    expect(effectivePinnedKey('')).toBe(A);
  });
});

describe('prepareServerTrust', () => {
  it('reads the trust state before it remembers the key', () => {
    expect(prepareServerTrust(A)).toEqual({ trust: 'first-visit', pin: A });
    expect(prepareServerTrust(A)).toEqual({ trust: 'remembered-match', pin: A });
    expect(prepareServerTrust(B)).toEqual({ trust: 'remembered-mismatch', pin: A });
  });

  it('with a pin', () => {
    setPinnedServerKeyId(A);
    expect(prepareServerTrust(A)).toEqual({ trust: 'pinned-match', pin: A });
    expect(prepareServerTrust(B)).toEqual({ trust: 'pinned-mismatch', pin: A });
  });
});

describe('currentServerKeyId and loadServerTrust', () => {
  it('returns the id the fetcher finds and keeps it for a minute', async () => {
    const fetchId = vi.fn().mockResolvedValue(A);
    expect(await currentServerKeyId({ fetchId, now: 1000 })).toBe(A);
    expect(await currentServerKeyId({ fetchId, now: 30000 })).toBe(A);
    expect(fetchId).toHaveBeenCalledTimes(1);
    expect(await currentServerKeyId({ fetchId, now: 1000 + 61000 })).toBe(A);
    expect(fetchId).toHaveBeenCalledTimes(2);
  });

  it('gives an empty string when the key cannot be learned, and does not cache the failure', async () => {
    const fetchId = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(B);
    expect(await currentServerKeyId({ fetchId, now: 1 })).toBe('');
    expect(await currentServerKeyId({ fetchId, now: 2 })).toBe(B);
  });

  it('refuses a malformed id from the fetcher', async () => {
    expect(await currentServerKeyId({ fetchId: async () => 'nope', now: 1 })).toBe('');
    expect(await currentServerKeyId({ fetchId: async () => null, now: 1 })).toBe('');
  });

  it('loadServerTrust: first visit then remembered', async () => {
    const out = await loadServerTrust({ fetchId: async () => A, now: 1 });
    expect(out).toEqual({ trust: 'first-visit', pin: A, current: A });
    const again = await loadServerTrust({ fetchId: async () => A, now: 2 });
    expect(again).toEqual({ trust: 'remembered-match', pin: A, current: A });
  });

  it('loadServerTrust: a changed key is reported and not adopted', async () => {
    rememberServerKey(A);
    const out = await loadServerTrust({ fetchId: async () => B, now: 1 });
    expect(out).toEqual({ trust: 'remembered-mismatch', pin: A, current: B });
    expect(getRememberedServerKeyId()).toBe(A);
  });

  it('loadServerTrust: when the key cannot be learned the trust is unknown, not a mismatch', async () => {
    rememberServerKey(A);
    const out = await loadServerTrust({ fetchId: async () => '', now: 1 });
    expect(out).toEqual({ trust: '', pin: A, current: '' });
    forgetRememberedServerKey();
    const none = await loadServerTrust({ fetchId: async () => '', now: 5 });
    expect(none).toEqual({ trust: '', pin: '', current: '' });
    expect(getRememberedServerKeyId()).toBe('');
  });
});
