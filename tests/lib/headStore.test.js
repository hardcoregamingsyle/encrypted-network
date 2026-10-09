import { afterEach, describe, expect, it } from 'vitest';
import { forgetSeenHead, getSeenHead, setSeenHead } from '../../src/lib/headStore.js';

const ID = 'ab'.repeat(16);
const head = (over = {}) => ({ docId: ID, headVersion: 2, headRecordHash: 'cd'.repeat(32), ledgerSeq: 7, checkpointSeq: 9, ...over });

function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k)
  };
}

afterEach(() => {
  forgetSeenHead();
  delete globalThis.localStorage;
});

describe('headStore without usable storage', () => {
  it('keeps heads in memory', () => {
    expect(getSeenHead(ID)).toBe(null);
    expect(setSeenHead(head())).toBe(true);
    expect(getSeenHead(ID)).toEqual(head());
  });
  it('a throwing storage never throws out', () => {
    globalThis.localStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      }
    };
    expect(setSeenHead(head())).toBe(true);
    expect(getSeenHead(ID).headVersion).toBe(2);
    forgetSeenHead();
    expect(getSeenHead(ID)).toBe(null);
  });
  it('rejects a malformed head', () => {
    expect(setSeenHead({ docId: 'x' })).toBe(false);
    expect(setSeenHead(null)).toBe(false);
  });
});

describe('headStore with localStorage', () => {
  it('stores only ids, numbers and hashes and reads them back', () => {
    const s = fakeStorage();
    globalThis.localStorage = s;
    setSeenHead({ ...head(), password: 'SECRET', name: 'a.pdf' });
    const raw = s.data.get('hrdlock.seenHeads');
    expect(raw).not.toMatch(/SECRET|a\.pdf/);
    expect(getSeenHead(ID)).toEqual(head());
  });
  it('replaces the entry of the same document and can forget one or all', () => {
    globalThis.localStorage = fakeStorage();
    setSeenHead(head());
    setSeenHead(head({ headVersion: 5 }));
    expect(getSeenHead(ID).headVersion).toBe(5);
    forgetSeenHead(ID);
    expect(getSeenHead(ID)).toBe(null);
    setSeenHead(head());
    forgetSeenHead();
    expect(getSeenHead(ID)).toBe(null);
  });
  it('ignores damaged stored json and entries filed under the wrong id', () => {
    const s = fakeStorage();
    globalThis.localStorage = s;
    s.data.set('hrdlock.seenHeads', '{not json');
    expect(getSeenHead(ID)).toBe(null);
    s.data.set('hrdlock.seenHeads', JSON.stringify({ [ID]: head({ docId: 'cd'.repeat(16) }) }));
    expect(getSeenHead(ID)).toBe(null);
  });
  it('keeps at most 500 documents', () => {
    const s = fakeStorage();
    globalThis.localStorage = s;
    for (let i = 0; i < 510; i++) setSeenHead(head({ docId: i.toString(16).padStart(32, '0') }));
    expect(Object.keys(JSON.parse(s.data.get('hrdlock.seenHeads'))).length).toBe(500);
    expect(getSeenHead((509).toString(16).padStart(32, '0'))).not.toBe(null);
    expect(getSeenHead((0).toString(16).padStart(32, '0'))).toBe(null);
  });
});
