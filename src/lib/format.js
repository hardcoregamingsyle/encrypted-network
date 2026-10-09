// Small display helpers. Plain functions, no DOM.

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

// 0 -> "0 B", 1536 -> "1.5 KiB", 52428800 -> "50 MiB". Bad input gives an empty string.
export function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const text = value >= 100 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${UNITS[unit]}`;
}

function validTime(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;
}

// Local date and time that people can read, for example "9 Oct 2026, 14:05".
export function formatTime(ms) {
  if (!validTime(ms)) return 'unknown time';
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// "just now", "5 minutes ago", "in 2 hours". now can be passed for tests.
export function timeAgo(ms, now = Date.now()) {
  if (!validTime(ms) || !validTime(now)) return 'unknown time';
  const diff = now - ms;
  const abs = Math.abs(diff);
  if (abs < 45 * 1000) return 'just now';
  const steps = [
    [60 * 1000, 'minute', 60 * 60 * 1000],
    [60 * 60 * 1000, 'hour', 24 * 60 * 60 * 1000],
    [24 * 60 * 60 * 1000, 'day', 30 * 24 * 60 * 60 * 1000],
    [30 * 24 * 60 * 60 * 1000, 'month', 365 * 24 * 60 * 60 * 1000],
    [365 * 24 * 60 * 60 * 1000, 'year', Infinity]
  ];
  for (const [size, word, limit] of steps) {
    if (abs < limit) {
      const count = Math.max(1, Math.round(abs / size));
      return diff >= 0 ? `${plural(count, word)} ago` : `in ${plural(count, word)}`;
    }
  }
  return 'a long time ago';
}

// First n characters of a hash followed by "...". Short or odd input is returned as it is.
export function shortHash(h, n = 8) {
  if (typeof h !== 'string') return '';
  if (h.length <= n) return h;
  return h.slice(0, n) + '...';
}

// The first 8 characters of a key id, used as a recognisable tag next to a name.
export function shortKeyId(id) {
  if (typeof id !== 'string') return '';
  return id.slice(0, 8);
}
