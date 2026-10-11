// Which messages of each chat this browser has already seen, so the list can show an unread count.
// lastSeenSeq per channel in localStorage. Every storage call is wrapped: a browser that blocks
// storage simply shows no unread counts.

const KEY = 'hrdlock.lastSeen.v1';
const MAX_CHANNELS = 500;

function store() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readAll() {
  try {
    const s = store();
    if (!s) return {};
    const data = JSON.parse(s.getItem(KEY) || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// The newest message number seen in a chat, 0 when unknown.
export function getLastSeen(channelId) {
  const v = readAll()[String(channelId)];
  return Number.isSafeInteger(v) && v > 0 ? v : 0;
}

// Remembers that messages up to seq were seen. The number never goes down. Returns the stored value.
export function markSeen(channelId, seq) {
  try {
    const s = store();
    if (!s || !Number.isSafeInteger(seq) || seq < 0) return getLastSeen(channelId);
    const all = readAll();
    const id = String(channelId);
    const next = Math.max(all[id] || 0, seq);
    all[id] = next;
    const ids = Object.keys(all);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_CHANNELS))) delete all[old];
    s.setItem(KEY, JSON.stringify(all));
    return next;
  } catch {
    return 0;
  }
}

// How many messages of a chat row from GET /api/channels are not seen yet.
// A chat this browser has never opened counts as read until it is opened once, so a new visitor
// does not see every old chat as unread.
export function unreadCount(channel) {
  if (!channel || typeof channel.channelId !== 'string') return 0;
  const total = Number.isSafeInteger(channel.messageCount) ? channel.messageCount : 0;
  const all = readAll();
  if (!(channel.channelId in all)) return 0;
  return Math.max(0, total - getLastSeen(channel.channelId));
}

// Marks a whole list of chat rows as seen, for the first visit.
export function seedSeen(channels) {
  for (const row of Array.isArray(channels) ? channels : []) {
    if (row && typeof row.channelId === 'string' && !(row.channelId in readAll())) markSeen(row.channelId, row.messageCount || 0);
  }
}

export function clearSeen() {
  try {
    const s = store();
    if (s) s.removeItem(KEY);
  } catch {
    // nothing to do
  }
}
