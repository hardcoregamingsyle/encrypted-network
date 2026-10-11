import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPin, getPinnedServerKeyId, setPinnedServerKeyId } from '../../src/lib/pin.js';
import { fullLink, parseFragment, verifyLink } from '../../src/lib/links.js';
import { clearLocalDocs, forgetDoc, listLocalDocs, rememberDoc } from '../../src/lib/localDocs.js';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY_ID = 'ab'.repeat(32);
const DOC = '0123456789abcdef0123456789abcdef';

describe('pin', () => {
  it('starts empty and round trips', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(getPinnedServerKeyId()).toBe('');
    expect(setPinnedServerKeyId(KEY_ID)).toBe(true);
    expect(getPinnedServerKeyId()).toBe(KEY_ID);
    expect(clearPin()).toBe(true);
    expect(getPinnedServerKeyId()).toBe('');
  });

  it('fixes case and outer spaces, rejects bad ids and does not overwrite the old pin', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(setPinnedServerKeyId('  ' + KEY_ID.toUpperCase() + ' ')).toBe(true);
    expect(getPinnedServerKeyId()).toBe(KEY_ID);
    for (const bad of ['abc', 'zz'.repeat(32), 'ab'.repeat(33), null, undefined, 5, {}]) {
      expect(setPinnedServerKeyId(bad)).toBe(false);
    }
    expect(getPinnedServerKeyId()).toBe(KEY_ID);
  });

  it('an empty id clears the pin', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setPinnedServerKeyId(KEY_ID);
    expect(setPinnedServerKeyId('')).toBe(true);
    expect(getPinnedServerKeyId()).toBe('');
  });

  it('ignores a damaged stored value', () => {
    const s = fakeStorage();
    s.setItem('hrdlock.pinnedServerKeyId', 'not a key id');
    vi.stubGlobal('localStorage', s);
    expect(getPinnedServerKeyId()).toBe('');
  });

  it('never throws when storage throws', () => {
    vi.stubGlobal('localStorage', throwingStorage());
    expect(getPinnedServerKeyId()).toBe('');
    expect(setPinnedServerKeyId(KEY_ID)).toBe(false);
    expect(clearPin()).toBe(false);
  });

  it('never throws when reading localStorage itself throws or it is missing', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      }
    });
    try {
      expect(getPinnedServerKeyId()).toBe('');
      expect(setPinnedServerKeyId(KEY_ID)).toBe(false);
      expect(clearPin()).toBe(false);
    } finally {
      delete globalThis.localStorage;
    }
    vi.stubGlobal('localStorage', undefined);
    expect(getPinnedServerKeyId()).toBe('');
    expect(setPinnedServerKeyId(KEY_ID)).toBe(false);
  });
});

describe('localDocs', () => {
  it('remembers, lists newest first, and forgets', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(listLocalDocs()).toEqual([]);
    const a = 'a'.repeat(32);
    const b = 'b'.repeat(32);
    expect(rememberDoc({ docId: a, label: 'first', createdAt: 100 })).toBe(true);
    expect(rememberDoc({ docId: b, label: 'second', createdAt: 200 })).toBe(true);
    expect(listLocalDocs()).toEqual([
      { docId: b, label: 'second', createdAt: 200 },
      { docId: a, label: 'first', createdAt: 100 }
    ]);
    expect(forgetDoc(b)).toBe(true);
    expect(listLocalDocs().map((d) => d.docId)).toEqual([a]);
    expect(forgetDoc(b)).toBe(false);
  });

  it('replaces an entry with the same id', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    rememberDoc({ docId: DOC, label: 'old', createdAt: 1 });
    rememberDoc({ docId: DOC, label: 'new', createdAt: 2 });
    expect(listLocalDocs()).toEqual([{ docId: DOC, label: 'new', createdAt: 2 }]);
  });

  it('keeps only the three allowed fields, never a password', () => {
    const s = fakeStorage();
    vi.stubGlobal('localStorage', s);
    rememberDoc({ docId: DOC, label: 'x', createdAt: 5, password: 'SECRETSECRET', extra: 1 });
    const raw = [...s.map.values()].join('');
    expect(raw).not.toContain('SECRET');
    expect(Object.keys(listLocalDocs()[0]).sort()).toEqual(['createdAt', 'docId', 'label']);
  });

  it('keeps the key id of the person who published it, and only a well formed one', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const owner = 'ab'.repeat(32);
    rememberDoc({ docId: DOC, label: 'x', createdAt: 5, owner });
    expect(listLocalDocs()[0].owner).toBe(owner);
    rememberDoc({ docId: DOC, label: 'x', createdAt: 6, owner: 'not a key id' });
    expect(listLocalDocs()[0].owner).toBeUndefined();
  });

  it('clearLocalDocs forgets the whole list', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    rememberDoc({ docId: DOC, label: 'x', createdAt: 5 });
    expect(clearLocalDocs()).toBe(true);
    expect(listLocalDocs()).toEqual([]);
  });

  it('rejects bad entries', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    for (const bad of [null, undefined, 'x', {}, { docId: 'short' }, { docId: 'G'.repeat(32) }, { docId: 5 }]) {
      expect(rememberDoc(bad)).toBe(false);
    }
    expect(listLocalDocs()).toEqual([]);
  });

  it('cleans odd values: long label cut, bad createdAt becomes 0', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    rememberDoc({ docId: DOC, label: 'x'.repeat(500), createdAt: 'soon' });
    const [e] = listLocalDocs();
    expect(Array.from(e.label).length).toBe(120);
    expect(e.createdAt).toBe(0);
  });

  it('survives damaged stored data', () => {
    for (const text of ['{{{', '{"a":1}', 'null', '[1,2,{"docId":"nope"}]']) {
      const s = fakeStorage();
      s.setItem('hrdlock.localDocs', text);
      vi.stubGlobal('localStorage', s);
      expect(listLocalDocs()).toEqual([]);
      expect(rememberDoc({ docId: DOC, label: 'ok', createdAt: 1 })).toBe(true);
      expect(listLocalDocs()).toHaveLength(1);
    }
  });

  it('drops duplicate ids and bad items from stored data', () => {
    const s = fakeStorage();
    s.setItem(
      'hrdlock.localDocs',
      JSON.stringify([{ docId: DOC, label: 'a', createdAt: 1 }, { docId: DOC, label: 'b', createdAt: 2 }, 7])
    );
    vi.stubGlobal('localStorage', s);
    expect(listLocalDocs()).toEqual([{ docId: DOC, label: 'a', createdAt: 1 }]);
  });

  it('caps the list size', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    for (let i = 0; i < 520; i++) {
      rememberDoc({ docId: i.toString(16).padStart(32, '0'), label: String(i), createdAt: i });
    }
    const list = listLocalDocs();
    expect(list.length).toBe(500);
    expect(list[0].createdAt).toBe(519);
  });

  it('never throws when storage throws', () => {
    vi.stubGlobal('localStorage', throwingStorage());
    expect(listLocalDocs()).toEqual([]);
    expect(rememberDoc({ docId: DOC, label: 'x', createdAt: 1 })).toBe(false);
    expect(forgetDoc(DOC)).toBe(false);
  });

  it('never throws when there is no storage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(listLocalDocs()).toEqual([]);
    expect(rememberDoc({ docId: DOC, label: 'x', createdAt: 1 })).toBe(false);
  });
});

describe('links', () => {
  it('gives relative paths without a window', () => {
    expect(typeof window).toBe('undefined');
    expect(verifyLink(DOC)).toBe('/d/' + DOC);
    expect(fullLink(DOC, 'ABCD-EFGH-JKLM-NPQR-STUV')).toBe('/d/' + DOC + '#k=ABCDEFGHJKLMNPQRSTUV');
  });

  it('full link has the password without dashes, upper case', () => {
    expect(fullLink(DOC, 'abcd-efgh-jklm-npqr-stuv')).toBe('/d/' + DOC + '#k=ABCDEFGHJKLMNPQRSTUV');
  });

  it('gives absolute urls with a window', () => {
    vi.stubGlobal('window', { location: { origin: 'https://docs.example.org' } });
    expect(verifyLink(DOC)).toBe('https://docs.example.org/d/' + DOC);
    expect(fullLink(DOC, 'AB-CD')).toBe('https://docs.example.org/d/' + DOC + '#k=ABCD');
  });

  it('falls back to relative for an opaque origin or a window without location', () => {
    vi.stubGlobal('window', { location: { origin: 'null' } });
    expect(verifyLink(DOC)).toBe('/d/' + DOC);
    vi.stubGlobal('window', {});
    expect(verifyLink(DOC)).toBe('/d/' + DOC);
  });

  it('full link without a usable password is just the verify link', () => {
    expect(fullLink(DOC, '')).toBe('/d/' + DOC);
    expect(fullLink(DOC, ' - ')).toBe('/d/' + DOC);
    expect(fullLink(DOC, undefined)).toBe('/d/' + DOC);
  });

  it('full link encodes odd characters and parseFragment reads them back', () => {
    const link = fullLink(DOC, 'a&b=c%d+e#f');
    const hash = link.slice(link.indexOf('#'));
    expect(hash.slice(3)).not.toMatch(/[&=#+]/);
    expect(parseFragment(hash)).toBe('A&B=C%D+E#F');
  });

  it('parseFragment accepts dashes, no dashes and lowercase', () => {
    const want = 'ABCDEFGHJKLMNPQRSTUV';
    expect(parseFragment('#k=ABCD-EFGH-JKLM-NPQR-STUV')).toBe(want);
    expect(parseFragment('#k=ABCDEFGHJKLMNPQRSTUV')).toBe(want);
    expect(parseFragment('#k=abcd-efgh-jklm-npqr-stuv')).toBe(want);
    expect(parseFragment('k=abcdefghjklmnpqrstuv')).toBe(want);
    expect(parseFragment('#k=ABCD%20EFGH')).toBe('ABCDEFGH');
    expect(parseFragment('#k= abcd - efgh ')).toBe('ABCDEFGH');
  });

  it('parseFragment finds k among other parts', () => {
    expect(parseFragment('#x=1&k=ab-cd&y=2')).toBe('ABCD');
    expect(parseFragment('#k=ab&k=cd')).toBe('AB');
  });

  it('parseFragment returns null for anything else', () => {
    for (const bad of [
      '',
      '#',
      '#k=',
      '#k=---',
      '#k=%20',
      '#kk=ABCD',
      '#K=ABCD',
      '#ABCD',
      '#=ABCD',
      '#k',
      '#k=%E0%A4%A',
      '#k=%',
      null,
      undefined,
      42,
      {}
    ]) {
      expect(parseFragment(bad)).toBeNull();
    }
  });

  it('parseFragment refuses absurdly long values', () => {
    expect(parseFragment('#k=' + 'A'.repeat(257))).toBeNull();
    expect(parseFragment('#k=' + 'A'.repeat(256))).toBe('A'.repeat(256));
    expect(parseFragment('#k=' + 'A'.repeat(5000))).toBeNull();
  });

  it('parseFragment undoes fullLink for a generated style password', () => {
    const pw = 'ABCD-EFGH-JKLM-NPQR-STUV';
    const link = fullLink(DOC, pw);
    expect(parseFragment(link.slice(link.indexOf('#')))).toBe('ABCDEFGHJKLMNPQRSTUV');
  });
});
