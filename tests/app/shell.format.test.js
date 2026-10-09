import { describe, expect, it } from 'vitest';
import { formatBytes, formatTime, shortHash, shortKeyId, timeAgo } from '../../src/lib/format.js';

describe('formatBytes', () => {
  it('formats common sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(52428800)).toBe('50 MiB');
    expect(formatBytes(1024 ** 3)).toBe('1 GiB');
    expect(formatBytes(250 * 1024)).toBe('250 KiB');
  });

  it('gives an empty string for bad input', () => {
    for (const bad of [-1, NaN, Infinity, '12', null, undefined, {}]) {
      expect(formatBytes(bad)).toBe('');
    }
  });

  it('caps at the largest unit', () => {
    expect(formatBytes(1024 ** 6)).toMatch(/TiB$/);
  });
});

describe('formatTime', () => {
  it('formats a time with a year in it', () => {
    const text = formatTime(Date.UTC(2026, 9, 9, 12, 0, 0));
    expect(text).toMatch(/2026/);
    expect(text).not.toBe('unknown time');
  });

  it('handles bad input without throwing', () => {
    for (const bad of [NaN, Infinity, '1', null, undefined, 1e20]) {
      expect(formatTime(bad)).toBe('unknown time');
    }
  });
});

describe('timeAgo', () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  const sec = 1000;
  const min = 60 * sec;
  const hour = 60 * min;
  const day = 24 * hour;

  it('says just now for the last seconds', () => {
    expect(timeAgo(now, now)).toBe('just now');
    expect(timeAgo(now - 30 * sec, now)).toBe('just now');
    expect(timeAgo(now + 30 * sec, now)).toBe('just now');
  });

  it('counts minutes, hours, days, months and years', () => {
    expect(timeAgo(now - min, now)).toBe('1 minute ago');
    expect(timeAgo(now - 5 * min, now)).toBe('5 minutes ago');
    expect(timeAgo(now - 3 * hour, now)).toBe('3 hours ago');
    expect(timeAgo(now - day, now)).toBe('1 day ago');
    expect(timeAgo(now - 10 * day, now)).toBe('10 days ago');
    expect(timeAgo(now - 60 * day, now)).toBe('2 months ago');
    expect(timeAgo(now - 800 * day, now)).toBe('2 years ago');
  });

  it('handles times in the future', () => {
    expect(timeAgo(now + 2 * hour, now)).toBe('in 2 hours');
    expect(timeAgo(now + 5 * min, now)).toBe('in 5 minutes');
  });

  it('handles bad input', () => {
    expect(timeAgo(NaN, now)).toBe('unknown time');
    expect(timeAgo(undefined, now)).toBe('unknown time');
    expect(timeAgo('x', now)).toBe('unknown time');
  });

  it('uses the real clock by default', () => {
    expect(timeAgo(Date.now())).toBe('just now');
  });
});

describe('shortHash and shortKeyId', () => {
  const h = 'abcdef0123456789'.repeat(4);

  it('shortens hashes', () => {
    expect(shortHash(h)).toBe('abcdef01...');
    expect(shortHash(h, 4)).toBe('abcd...');
    expect(shortHash('abc')).toBe('abc');
    expect(shortHash('12345678')).toBe('12345678');
  });

  it('copes with bad input', () => {
    expect(shortHash(undefined)).toBe('');
    expect(shortHash(null)).toBe('');
    expect(shortHash(12)).toBe('');
    expect(shortKeyId(undefined)).toBe('');
    expect(shortKeyId(5)).toBe('');
  });

  it('gives the first 8 characters of a key id', () => {
    expect(shortKeyId(h)).toBe('abcdef01');
    expect(shortKeyId('abc')).toBe('abc');
  });
});
