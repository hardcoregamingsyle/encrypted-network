// Pure logic of the shell: code boxes, sheet focus trap, navigation table, unread counts, auth wording.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OTP_LENGTH,
  digitsOnly,
  otpBackspace,
  otpComplete,
  otpDelete,
  otpInsert,
  otpMove,
  otpTyped
} from '../../src/components/otpLogic.js';
import { NAV_ITEMS, activeTab, chromeFor } from '../../src/components/navConfig.js';
import { FOCUSABLE_SELECTOR, createScrollLock, nextTabIndex, pickReturnTarget, sheetKeyAction } from '../../src/components/sheetLogic.js';
import { authErrorText, looksLikeEmail, maskEmail, plainErrorText } from '../../src/lib/authText.js';
import { clearSeen, getLastSeen, markSeen, seedSeen, unreadCount } from '../../src/lib/unread.js';

describe('code boxes: typing and pasting', () => {
  it('has six boxes', () => {
    expect(OTP_LENGTH).toBe(6);
  });

  it('keeps only digits and at most six', () => {
    expect(digitsOnly('12a3-4 5')).toBe('12345');
    expect(digitsOnly('1234567890')).toBe('123456');
    expect(digitsOnly(null)).toBe('');
    expect(digitsOnly(undefined)).toBe('');
    expect(digitsOnly('１２')).toBe('');
    expect(digitsOnly('١٢٣')).toBe('');
  });

  it('a digit typed in the next box is added and focus moves on', () => {
    expect(otpInsert('', 0, '4')).toEqual({ value: '4', focus: 1 });
    expect(otpInsert('42', 2, '9')).toEqual({ value: '429', focus: 3 });
  });

  it('a letter or symbol is ignored and focus stays', () => {
    expect(otpInsert('42', 2, 'x')).toEqual({ value: '42', focus: 2 });
    expect(otpInsert('', 0, '!')).toEqual({ value: '', focus: 0 });
  });

  it('typing in a box far to the right fills from the next free box (no gaps)', () => {
    expect(otpInsert('1', 4, '7')).toEqual({ value: '17', focus: 2 });
  });

  it('typing in a filled box replaces from that box on', () => {
    expect(otpInsert('123456', 2, '9')).toEqual({ value: '129456', focus: 3 });
  });

  it('a pasted code fills all boxes, from any box, with noise removed', () => {
    expect(otpInsert('', 0, '123456')).toEqual({ value: '123456', focus: 5 });
    expect(otpInsert('', 3, '123 456')).toEqual({ value: '123456', focus: 5 });
    expect(otpInsert('12', 2, '  3-4-5-6-7-8 ')).toEqual({ value: '123456', focus: 5 });
    expect(otpInsert('', 0, 'Your code is 654321.')).toEqual({ value: '654321', focus: 5 });
  });

  it('a longer paste is cut at six digits', () => {
    expect(otpInsert('', 0, '1234567890').value).toBe('123456');
  });

  it('overtyping a box keeps the new character', () => {
    expect(otpTyped('57', '5')).toBe('7');
    expect(otpTyped('75', '5')).toBe('7');
    expect(otpTyped('7', '5')).toBe('7');
    expect(otpTyped('', '5')).toBe('');
    expect(otpTyped('5', '')).toBe('5');
    expect(otpTyped('123456', '')).toBe('123456');
  });

  it('knows when the code is complete', () => {
    expect(otpComplete('12345')).toBe(false);
    expect(otpComplete('123456')).toBe(true);
    expect(otpComplete('12345a')).toBe(false);
  });
});

describe('code boxes: backspace, delete and arrows', () => {
  it('backspace in a filled box removes that digit and stays', () => {
    expect(otpBackspace('1234', 1)).toEqual({ value: '134', focus: 1 });
    expect(otpBackspace('1234', 3)).toEqual({ value: '123', focus: 3 });
  });

  it('backspace in an empty box removes the digit before it and moves back', () => {
    expect(otpBackspace('123', 3)).toEqual({ value: '12', focus: 2 });
    expect(otpBackspace('123', 5)).toEqual({ value: '12', focus: 2 });
    expect(otpBackspace('1', 1)).toEqual({ value: '', focus: 0 });
  });

  it('backspace on an empty code does nothing', () => {
    expect(otpBackspace('', 0)).toEqual({ value: '', focus: 0 });
    expect(otpBackspace('', 4)).toEqual({ value: '', focus: 0 });
  });

  it('delete removes the digit in that box and stays', () => {
    expect(otpDelete('1234', 1)).toEqual({ value: '134', focus: 1 });
    expect(otpDelete('12', 4)).toEqual({ value: '12', focus: 4 });
  });

  it('arrow keys, home and end move between boxes and stop at the ends', () => {
    expect(otpMove('ArrowLeft', 3)).toBe(2);
    expect(otpMove('ArrowLeft', 0)).toBe(0);
    expect(otpMove('ArrowRight', 3)).toBe(4);
    expect(otpMove('ArrowRight', 5)).toBe(5);
    expect(otpMove('Home', 4)).toBe(0);
    expect(otpMove('End', 1)).toBe(5);
    expect(otpMove('a', 2)).toBe(2);
  });

  it('a full sequence: type, paste over, backspace down to nothing', () => {
    let v = '';
    for (const ch of '4821') v = otpInsert(v, v.length, ch).value;
    expect(v).toBe('4821');
    v = otpInsert(v, 4, '97').value;
    expect(v).toBe('482197');
    for (let i = 0; i < 6; i++) v = otpBackspace(v, 5 - i).value;
    expect(v).toBe('');
  });
});

describe('sheet focus trap', () => {
  it('Tab wraps from the last control to the first and Shift+Tab the other way', () => {
    expect(nextTabIndex(3, 2, false)).toBe(0);
    expect(nextTabIndex(3, 0, true)).toBe(2);
    expect(nextTabIndex(3, 1, false)).toBe(2);
    expect(nextTabIndex(3, 1, true)).toBe(0);
  });

  it('focus outside the list goes to the first (Tab) or last (Shift+Tab) control', () => {
    expect(nextTabIndex(3, -1, false)).toBe(0);
    expect(nextTabIndex(3, -1, true)).toBe(2);
    expect(nextTabIndex(3, 9, false)).toBe(0);
  });

  it('no controls: nothing to focus', () => {
    expect(nextTabIndex(0, -1, false)).toBe(-1);
    expect(nextTabIndex(NaN, 0, false)).toBe(-1);
  });

  it('Escape closes when the sheet may be dismissed, and does nothing when it may not', () => {
    expect(sheetKeyAction({ key: 'Escape' }, { count: 2, index: 0 })).toEqual({ action: 'close' });
    expect(sheetKeyAction({ key: 'Escape' }, { count: 2, index: 0, dismissible: false })).toEqual({ action: 'none' });
  });

  it('Tab on the last control wraps, Tab in the middle is left to the browser', () => {
    expect(sheetKeyAction({ key: 'Tab' }, { count: 3, index: 2 })).toEqual({ action: 'focus', index: 0 });
    expect(sheetKeyAction({ key: 'Tab', shiftKey: true }, { count: 3, index: 0 })).toEqual({ action: 'focus', index: 2 });
    expect(sheetKeyAction({ key: 'Tab' }, { count: 3, index: 1 })).toEqual({ action: 'none' });
    expect(sheetKeyAction({ key: 'Tab', shiftKey: true }, { count: 3, index: 1 })).toEqual({ action: 'none' });
  });

  it('Tab when focus has left the sheet pulls it back in', () => {
    expect(sheetKeyAction({ key: 'Tab' }, { count: 3, index: -1 })).toEqual({ action: 'focus', index: 0 });
    expect(sheetKeyAction({ key: 'Tab', shiftKey: true }, { count: 3, index: -1 })).toEqual({ action: 'focus', index: 2 });
  });

  it('Tab with nothing focusable keeps focus on the sheet itself', () => {
    expect(sheetKeyAction({ key: 'Tab' }, { count: 0, index: -1 })).toEqual({ action: 'focus', index: -1 });
  });

  it('other keys are not touched', () => {
    expect(sheetKeyAction({ key: 'a' }, { count: 3, index: 1 })).toEqual({ action: 'none' });
    expect(sheetKeyAction({ key: 'Enter' }, { count: 3, index: 1 })).toEqual({ action: 'none' });
  });

  it('the selector finds links, buttons and fields but not disabled ones', () => {
    expect(FOCUSABLE_SELECTOR).toContain('a[href]');
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('input:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('textarea:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });
});

describe('sheet scroll lock and focus return', () => {
  function fakeDoc() {
    const classes = new Set();
    return {
      classes,
      body: {
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) }
      },
      contains: vi.fn(() => true)
    };
  }

  it('locks once and unlocks when the last sheet closes', () => {
    const doc = fakeDoc();
    const lock = createScrollLock(doc);
    lock.lock();
    lock.lock();
    expect(doc.classes.has('ui-scroll-locked')).toBe(true);
    expect(lock.count()).toBe(2);
    lock.unlock();
    expect(doc.classes.has('ui-scroll-locked')).toBe(true);
    lock.unlock();
    expect(doc.classes.has('ui-scroll-locked')).toBe(false);
    lock.unlock();
    expect(lock.count()).toBe(0);
  });

  it('works without a document', () => {
    const lock = createScrollLock(null);
    expect(() => {
      lock.lock();
      lock.unlock();
    }).not.toThrow();
  });

  it('returns focus to the opener only while it is still on the page', () => {
    const opener = { focus: vi.fn() };
    const doc = fakeDoc();
    expect(pickReturnTarget(opener, doc)).toBe(opener);
    doc.contains = () => false;
    expect(pickReturnTarget(opener, doc)).toBe(null);
    expect(pickReturnTarget(null, doc)).toBe(null);
    expect(pickReturnTarget({}, fakeDoc())).toBe(null);
  });
});

describe('navigation table', () => {
  it('has the four tabs in order', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Chats', 'Files', 'Verify', 'Me']);
    expect(NAV_ITEMS.map((i) => i.to)).toEqual(['/chats', '/files', '/verify', '/me']);
    for (const item of NAV_ITEMS) expect(item.icon).toBeTruthy();
  });

  it('maps a path to its tab', () => {
    const cases = [
      ['/chats', 'chats'],
      ['/chats/town-hall', 'chats'],
      ['/chat', 'chats'],
      ['/chat/town-hall', 'chats'],
      ['/files', 'files'],
      ['/d/' + 'a'.repeat(32), 'files'],
      ['/verify', 'verify'],
      ['/me', 'me'],
      ['/me/advanced', 'me'],
      ['/about', 'me'],
      ['/welcome', ''],
      ['/signin', ''],
      ['/', ''],
      ['/nothing', ''],
      ['/chatsX', ''],
      [undefined, '']
    ];
    for (const [path, tab] of cases) expect(activeTab(path), String(path)).toBe(tab);
  });

  it('decides how much chrome a path gets', () => {
    expect(chromeFor('/welcome')).toBe('bare');
    expect(chromeFor('/signin')).toBe('bare');
    expect(chromeFor('/chats/town-hall')).toBe('room');
    expect(chromeFor('/chats')).toBe('full');
    expect(chromeFor('/files')).toBe('full');
    expect(chromeFor('/d/' + 'a'.repeat(32))).toBe('full');
    expect(chromeFor(undefined)).toBe('full');
  });
});

describe('unread counts', () => {
  beforeEach(() => {
    const map = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k)
    });
  });

  it('counts the messages after the last one seen', () => {
    markSeen('town-hall', 5);
    expect(getLastSeen('town-hall')).toBe(5);
    expect(unreadCount({ channelId: 'town-hall', messageCount: 8 })).toBe(3);
    expect(unreadCount({ channelId: 'town-hall', messageCount: 5 })).toBe(0);
    expect(unreadCount({ channelId: 'town-hall', messageCount: 2 })).toBe(0);
  });

  it('the seen number never goes down', () => {
    markSeen('a-chat', 9);
    expect(markSeen('a-chat', 4)).toBe(9);
    expect(getLastSeen('a-chat')).toBe(9);
  });

  it('a chat that was never opened counts as read, so a first visit is not a wall of badges', () => {
    expect(unreadCount({ channelId: 'never-seen', messageCount: 50 })).toBe(0);
    seedSeen([{ channelId: 'one-chat', messageCount: 7 }]);
    expect(unreadCount({ channelId: 'one-chat', messageCount: 9 })).toBe(2);
  });

  it('ignores bad input', () => {
    expect(markSeen('x-chat', -1)).toBe(0);
    expect(markSeen('x-chat', 1.5)).toBe(0);
    expect(markSeen('x-chat', 'ten')).toBe(0);
    expect(unreadCount(null)).toBe(0);
    expect(unreadCount({})).toBe(0);
    expect(unreadCount({ channelId: 'x-chat', messageCount: 'many' })).toBe(0);
  });

  it('forgets everything on clear and copes with damaged storage', () => {
    markSeen('town-hall', 5);
    clearSeen();
    expect(getLastSeen('town-hall')).toBe(0);
    localStorage.setItem('hrdlock.lastSeen.v1', 'not json');
    expect(getLastSeen('town-hall')).toBe(0);
    expect(markSeen('town-hall', 2)).toBe(2);
  });

  it('works when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      }
    });
    expect(getLastSeen('town-hall')).toBe(0);
    expect(markSeen('town-hall', 3)).toBe(0);
    expect(unreadCount({ channelId: 'town-hall', messageCount: 3 })).toBe(0);
    expect(() => clearSeen()).not.toThrow();
  });
});

describe('sign in wording', () => {
  it('has a plain sentence for each server code', () => {
    for (const code of ['invalid_email', 'invalid_code', 'code_expired', 'too_many_attempts', 'mail_unavailable', 'mail_failed', 'accounts_unavailable', 'rate_limited', 'unauthenticated', 'strict_mode', 'key_exists', 'forbidden', 'network']) {
      const text = authErrorText({ code });
      expect(text.length, code).toBeGreaterThan(10);
      expect(text, code).not.toMatch(/[_]/);
    }
    expect(authErrorText({ code: 'invalid_code' })).toBe('That code is not right, try again.');
  });

  it('says how long to wait when the server said so', () => {
    expect(authErrorText({ code: 'rate_limited', retryAfter: 20 })).toContain('20 seconds');
    expect(authErrorText({ code: 'rate_limited', retryAfter: 1 })).toContain('1 second ');
    expect(authErrorText({ code: 'rate_limited', retryAfter: 3000 })).not.toContain('3000');
    expect(authErrorText({ code: 'rate_limited' })).toMatch(/wait/i);
  });

  it('falls back to the status, then the message', () => {
    expect(authErrorText({ status: 0, code: 'weird' })).toMatch(/reach the server/);
    expect(authErrorText({ status: 502, code: 'weird' })).toMatch(/server had a problem/);
    expect(authErrorText({ status: 400, code: 'weird', message: 'Plain words.' })).toBe('Plain words.');
    expect(authErrorText(null)).toMatch(/Something went wrong/);
    expect(authErrorText({})).toMatch(/Something went wrong/);
  });

  it('plainErrorText uses the message or a fallback', () => {
    expect(plainErrorText(new Error('Display name is too long.'))).toBe('Display name is too long.');
    expect(plainErrorText(null)).toMatch(/Something went wrong/);
    expect(plainErrorText({}, 'custom')).toBe('custom');
  });

  it('checks an email loosely and leaves the real check to the server', () => {
    for (const ok of ['a@b.co', 'priya.nair@gmail.com', ' x+y@sub.example.org ']) expect(looksLikeEmail(ok), ok).toBe(true);
    for (const bad of ['', 'a', 'a@b', '@b.co', 'a@@b.co', 'a b@c.de', 'a@b .co', null, 42, 'a@b.' + 'c'.repeat(300)]) expect(looksLikeEmail(bad), String(bad)).toBe(false);
  });

  it('masks an email like the server does', () => {
    expect(maskEmail('priya.nair@gmail.com')).toBe('pr***@gmail.com');
    expect(maskEmail('  a@b.co ')).toBe('a***@b.co');
    expect(maskEmail('nope')).toBe('');
    expect(maskEmail('@x.co')).toBe('');
    expect(maskEmail(null)).toBe('');
  });
});
