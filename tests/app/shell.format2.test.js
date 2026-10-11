// Format helpers added for the chat app feel: initials, avatar colours, short times, file kinds.
import { describe, expect, it } from 'vitest';
import {
  AVATAR_COLOR_COUNT,
  avatarColorNumber,
  chatListTime,
  dayLabel,
  fileExtension,
  fileIconName,
  fileKind,
  formatClock,
  formatShortDate,
  hashString,
  initialsOf,
  previewLine,
  relativeDay,
  safeNextPath,
  sameDay,
  secondsLeft,
  versionLine
} from '../../src/lib/format.js';

// local time, so the tests agree with the code in every time zone
const at = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm, 0).getTime();
const NOW = at(2026, 10, 11, 15, 30);

describe('initialsOf', () => {
  it('takes the first letters of the first and last word', () => {
    expect(initialsOf('Priya Nair')).toBe('PN');
    expect(initialsOf('asha')).toBe('A');
    expect(initialsOf('  priya   kumari   nair ')).toBe('PN');
    expect(initialsOf('Mary-Jane Watson')).toBe('MW');
  });

  it('gives a question mark for nothing', () => {
    for (const x of ['', '   ', null, undefined, 42, {}]) expect(initialsOf(x)).toBe('?');
  });

  it('keeps a letter outside the basic range whole', () => {
    expect(initialsOf('\u00E9mile zola')).toBe('\u00C9Z');
    expect(initialsOf('\u{1D7D8}x')).toHaveLength(2);
  });
});

describe('avatar colours', () => {
  it('hashes the same text to the same number', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(hashString('')).toBe(hashString(null));
    expect(Number.isInteger(hashString('x'))).toBe(true);
  });

  it('always gives a colour from 1 to the number of colours', () => {
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
      const n = avatarColorNumber('key-' + i);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(AVATAR_COLOR_COUNT);
      seen.add(n);
    }
    expect(seen.size).toBe(AVATAR_COLOR_COUNT);
    expect(avatarColorNumber(undefined)).toBe(avatarColorNumber(''));
  });
});

describe('times', () => {
  it('formats a clock as HH:MM with zero padding', () => {
    expect(formatClock(at(2026, 10, 11, 9, 5))).toBe('09:05');
    expect(formatClock(at(2026, 10, 11, 0, 0))).toBe('00:00');
    expect(formatClock(at(2026, 10, 11, 23, 59))).toBe('23:59');
    expect(formatClock(NaN)).toBe('');
    expect(formatClock('x')).toBe('');
  });

  it('formats a short date and adds the year only for another year', () => {
    expect(formatShortDate(at(2026, 10, 9), NOW)).toBe('9 Oct');
    expect(formatShortDate(at(2025, 3, 1), NOW)).toBe('1 Mar 2025');
    expect(formatShortDate(NaN)).toBe('');
  });

  it('chat list time: clock today, Yesterday, weekday this week, date after that', () => {
    expect(chatListTime(at(2026, 10, 11, 14, 5), NOW)).toBe('14:05');
    expect(chatListTime(at(2026, 10, 11, 0, 1), NOW)).toBe('00:01');
    expect(chatListTime(at(2026, 10, 10, 23, 59), NOW)).toBe('Yesterday');
    expect(chatListTime(at(2026, 10, 8, 12), NOW)).toBe('Thu');
    expect(chatListTime(at(2026, 10, 4, 12), NOW)).toBe('4 Oct');
    expect(chatListTime(at(2025, 12, 31, 12), NOW)).toBe('31 Dec 2025');
    expect(chatListTime(NaN, NOW)).toBe('');
    expect(chatListTime(NOW, NaN)).toBe('');
  });

  it('day separators: Today, Yesterday, weekday with date, then date', () => {
    expect(dayLabel(at(2026, 10, 11, 1), NOW)).toBe('Today');
    expect(dayLabel(at(2026, 10, 10, 23), NOW)).toBe('Yesterday');
    expect(dayLabel(at(2026, 10, 7, 12), NOW)).toBe('Wed, 7 Oct');
    expect(dayLabel(at(2026, 9, 1, 12), NOW)).toBe('1 Sep');
    expect(dayLabel(at(2024, 9, 1, 12), NOW)).toBe('1 Sep 2024');
    expect(dayLabel('x', NOW)).toBe('');
  });

  it('a message from the future counts as today and does not break the label', () => {
    expect(chatListTime(NOW + 3600 * 1000, NOW)).toMatch(/^\d\d:\d\d$/);
    expect(relativeDay(NOW + 5 * 24 * 3600 * 1000, NOW)).toBe('today');
  });

  it('sameDay compares calendar days', () => {
    expect(sameDay(at(2026, 10, 11, 0, 0), at(2026, 10, 11, 23, 59))).toBe(true);
    expect(sameDay(at(2026, 10, 11, 23, 59), at(2026, 10, 12, 0, 0))).toBe(false);
    expect(sameDay(NaN, NOW)).toBe(false);
  });

  it('relativeDay and versionLine read like a sentence', () => {
    expect(relativeDay(at(2026, 10, 11, 8), NOW)).toBe('today');
    expect(relativeDay(at(2026, 10, 10, 8), NOW)).toBe('yesterday');
    expect(relativeDay(at(2026, 10, 8, 8), NOW)).toBe('3 days ago');
    expect(relativeDay(at(2026, 9, 20, 8), NOW)).toBe('on 20 Sep');
    expect(relativeDay(NaN, NOW)).toBe('at an unknown time');
    expect(versionLine(3, at(2026, 10, 11, 8), NOW)).toBe('Version 3, edited today');
    expect(versionLine(1, at(2026, 10, 10, 8), NOW)).toBe('Version 1, edited yesterday');
    expect(versionLine(0, NOW, NOW)).toBe('Version 1, edited today');
    expect(versionLine('2', NOW, NOW)).toBe('Version 1, edited today');
  });

  it('secondsLeft counts down and never goes below zero', () => {
    expect(secondsLeft(NOW + 30000, NOW)).toBe(30);
    expect(secondsLeft(NOW + 29001, NOW)).toBe(30);
    expect(secondsLeft(NOW + 1, NOW)).toBe(1);
    expect(secondsLeft(NOW - 5000, NOW)).toBe(0);
    expect(secondsLeft(NaN, NOW)).toBe(0);
    expect(secondsLeft(0, NOW)).toBe(0);
  });
});

describe('previewLine', () => {
  it('writes "Name: text" on one line', () => {
    expect(previewLine('Priya', 'hello there')).toBe('Priya: hello there');
    expect(previewLine('Priya', 'line one\n\n  line   two')).toBe('Priya: line one line two');
  });

  it('cuts long text and leaves the name out when it is missing', () => {
    const out = previewLine('A', 'x'.repeat(200), 20);
    expect(out).toBe('A: ' + 'x'.repeat(20) + '...');
    expect(previewLine('', 'only text')).toBe('only text');
    expect(previewLine('A', '')).toBe('');
    expect(previewLine('A', null)).toBe('');
  });

  it('does not cut a character in half', () => {
    const out = previewLine('A', '\u{1F600}'.repeat(10), 3);
    expect(out).toBe('A: ' + '\u{1F600}'.repeat(3) + '...');
  });
});

describe('file kinds', () => {
  it('finds the extension', () => {
    expect(fileExtension('Report.PDF')).toBe('pdf');
    expect(fileExtension('a.b.tar.gz')).toBe('gz');
    expect(fileExtension('.hidden')).toBe('');
    expect(fileExtension('noext')).toBe('');
    expect(fileExtension('trailing.')).toBe('');
    expect(fileExtension(null)).toBe('');
  });

  it('maps extensions to a kind and a kind to an icon', () => {
    expect(fileKind('a.pdf')).toBe('pdf');
    expect(fileKind('a.JPG')).toBe('image');
    expect(fileKind('a.xlsx')).toBe('sheet');
    expect(fileKind('a.docx')).toBe('doc');
    expect(fileKind('a.pptx')).toBe('slides');
    expect(fileKind('a.zip')).toBe('archive');
    expect(fileKind('a.mp3')).toBe('audio');
    expect(fileKind('a.mp4')).toBe('video');
    expect(fileKind('a.txt')).toBe('text');
    expect(fileKind('a.unknownthing')).toBe('file');
    expect(fileKind('')).toBe('file');
    expect(fileIconName('image')).toBe('image');
    expect(fileIconName('pdf')).toBe('file');
    expect(fileIconName('nonsense')).toBe('file');
  });
});

describe('safeNextPath', () => {
  it('keeps an in-app path with its query and hash', () => {
    expect(safeNextPath('/files')).toBe('/files');
    expect(safeNextPath('/d/' + 'a'.repeat(32) + '#k=ABC')).toBe('/d/' + 'a'.repeat(32) + '#k=ABC');
    expect(safeNextPath('/chats/town-hall?x=1')).toBe('/chats/town-hall?x=1');
  });

  it('refuses anything that could leave the site', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil', 'javascript:alert(1)', 'evil', '', null, undefined, 5, '/a\nb', '/' + 'x'.repeat(400)]) {
      expect(safeNextPath(bad), String(bad)).toBe('/chats');
    }
  });

  it('never sends a person back to the sign in or welcome screens', () => {
    expect(safeNextPath('/signin')).toBe('/chats');
    expect(safeNextPath('/signin?next=%2Ffiles')).toBe('/chats');
    expect(safeNextPath('/welcome')).toBe('/chats');
    expect(safeNextPath('/welcome', '/me')).toBe('/me');
  });
});
