// Small display helpers. Plain functions, no DOM.

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

// 0 -> "0 B", 1536 -> "1.5 KiB", 20971520 -> "20 MiB". Bad input gives an empty string.
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

// Local date and time that people can read, with the time zone, for example "9 Oct 2026, 2:05 pm UTC".
// The zone matters on a record: the same moment prints differently on two computers.
export function formatTime(ms) {
  if (!validTime(ms)) return 'unknown time';
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

// The same moment in UTC, for example "2026-10-09 14:05:00 UTC".
export function formatUtc(ms) {
  if (!validTime(ms)) return 'unknown time';
  try {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return 'unknown time';
  }
}

// "is 20 MiB and 1 byte over the 20 MiB limit": exact, so rounding never makes the sentence contradict itself.
export function overLimitText(size, limit) {
  if (typeof size !== 'number' || typeof limit !== 'number' || !Number.isFinite(size) || !Number.isFinite(limit) || size <= limit) return '';
  const over = size - limit;
  return `${formatBytes(size)} (${size.toLocaleString('en')} bytes), which is ${over.toLocaleString('en')} ${over === 1 ? 'byte' : 'bytes'} over the limit of ${formatBytes(limit)}`;
}

// A server field shown as text: anything that is not a string becomes an empty string.
export function textOf(v) {
  return typeof v === 'string' ? v : '';
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

// The first 16 characters (64 bits) of a key id, used as a tag next to a name. It is a hint to
// recognise a signer, never the identifier itself: the full 64 character key id is the identifier.
export function shortKeyId(id) {
  if (typeof id !== 'string') return '';
  return id.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Chat app helpers: names, avatars, short times and file kinds.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 24 * 60 * 60 * 1000;

function two(n) {
  return n < 10 ? '0' + n : String(n);
}

// One or two capital letters for an avatar: "Priya Nair" -> "PN", "asha" -> "A", "" -> "?".
export function initialsOf(name) {
  const text = typeof name === 'string' ? name.normalize('NFC').trim() : '';
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0])[0];
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
  return (first + last).toLocaleUpperCase();
}

// A small stable number from text (FNV-1a, 32 bit). The same text always gives the same number.
export function hashString(text) {
  const s = typeof text === 'string' ? text : '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const AVATAR_COLOR_COUNT = 8;

// 1 to 8: which avatar colour token a name or key id gets.
export function avatarColorNumber(seed) {
  return (hashString(String(seed || '')) % AVATAR_COLOR_COUNT) + 1;
}

function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function sameDay(a, b) {
  return validTime(a) && validTime(b) && dayStart(a) === dayStart(b);
}

// Whole calendar days from a to b (b later gives a positive number).
function daysBetween(a, b) {
  return Math.round((dayStart(b) - dayStart(a)) / DAY_MS);
}

// "14:05" in the viewer's local time. Bad input gives an empty string.
export function formatClock(ms) {
  if (!validTime(ms)) return '';
  const d = new Date(ms);
  return two(d.getHours()) + ':' + two(d.getMinutes());
}

// "9 Oct" or, for another year than now, "9 Oct 2025".
export function formatShortDate(ms, now = Date.now()) {
  if (!validTime(ms)) return '';
  const d = new Date(ms);
  const base = d.getDate() + ' ' + MONTHS[d.getMonth()];
  return validTime(now) && new Date(now).getFullYear() !== d.getFullYear() ? base + ' ' + d.getFullYear() : base;
}

// The time shown on a chat list row: today "14:05", yesterday "Yesterday", this week "Mon", else "9 Oct".
export function chatListTime(ms, now = Date.now()) {
  if (!validTime(ms) || !validTime(now)) return '';
  const days = daysBetween(ms, now);
  if (days === 0) return formatClock(ms);
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return WEEKDAYS[new Date(ms).getDay()];
  return formatShortDate(ms, now);
}

// A date separator between messages: "Today", "Yesterday", "Mon, 6 Oct", "6 Oct 2025".
export function dayLabel(ms, now = Date.now()) {
  if (!validTime(ms) || !validTime(now)) return '';
  const days = daysBetween(ms, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return WEEKDAYS[new Date(ms).getDay()] + ', ' + formatShortDate(ms, now);
  return formatShortDate(ms, now);
}

// "today", "yesterday", "3 days ago", "on 9 Oct": for sentences such as "edited today".
export function relativeDay(ms, now = Date.now()) {
  if (!validTime(ms) || !validTime(now)) return 'at an unknown time';
  const days = daysBetween(ms, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return days + ' days ago';
  return 'on ' + formatShortDate(ms, now);
}

// "Version 3, edited today"
export function versionLine(version, updatedAt, now = Date.now()) {
  const v = Number.isSafeInteger(version) && version > 0 ? version : 1;
  return `Version ${v}, edited ${relativeDay(updatedAt, now)}`;
}

// A chat list preview: "Priya: hello there". Line breaks become spaces and long text is cut.
export function previewLine(name, text, max = 80) {
  const body = textOf(text).replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const cut = Array.from(body).length > max ? Array.from(body).slice(0, max).join('').trimEnd() + '...' : body;
  const who = textOf(name).trim();
  return who ? `${who}: ${cut}` : cut;
}

// The part after the last dot, lower case, or ''.
export function fileExtension(name) {
  const text = textOf(name);
  const dot = text.lastIndexOf('.');
  if (dot <= 0 || dot === text.length - 1) return '';
  return text.slice(dot + 1).toLowerCase();
}

const KINDS = {
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'avif'],
  sheet: ['xls', 'xlsx', 'csv', 'ods', 'tsv'],
  doc: ['doc', 'docx', 'odt', 'rtf', 'pages'],
  slides: ['ppt', 'pptx', 'odp', 'key'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi'],
  text: ['txt', 'md', 'json', 'xml', 'log', 'html', 'js']
};

// Which kind of file a name looks like: pdf, image, sheet, doc, slides, archive, audio, video, text or file.
export function fileKind(name) {
  const ext = fileExtension(name);
  if (!ext) return 'file';
  for (const [kind, list] of Object.entries(KINDS)) if (list.includes(ext)) return kind;
  return 'file';
}

// The Icon name for a kind of file.
export function fileIconName(kind) {
  const map = { image: 'image', sheet: 'table', archive: 'archive', audio: 'music', video: 'video', text: 'text' };
  return map[kind] || 'file';
}

// Keeps only a safe in-app path from a "next" query value. Anything else gives the fallback.
export function safeNextPath(value, fallback = '/chats') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes(String.fromCharCode(92))) return fallback;
  if (/[\u0000-\u001f]/.test(value)) return fallback;
  if (value === '/signin' || value.startsWith('/signin?') || value === '/welcome') return fallback;
  return value;
}

// Seconds left until a moment, never below 0. Used by the resend timer.
export function secondsLeft(untilMs, now = Date.now()) {
  if (!validTime(untilMs) || !validTime(now)) return 0;
  return Math.max(0, Math.ceil((untilMs - now) / 1000));
}
