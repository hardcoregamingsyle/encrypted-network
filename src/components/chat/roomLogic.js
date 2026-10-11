// Pure logic for the chat screens: no React, no DOM, so it can be tested in Node.
//
//   - buildTimeline: messages -> rows (date separators, "unread" marker, grouping of one sender)
//   - firstUnreadSeq: where the "unread messages" marker goes
//   - roomStatus: the one calm line under the room header
//   - composerStatus: what the writing box shows for the session state
//   - pinGetter: the server key to check against (pinned first, then the one remembered)
import { dayLabel, sameDay } from '../../lib/format.js';

// Two messages from one sender closer together than this are drawn as one group.
export const GROUP_GAP_MS = 5 * 60 * 1000;

function validTime(ms) {
  return typeof ms === 'number' && Number.isFinite(ms);
}

function isVerified(entry) {
  return Boolean(entry && entry.verdict && entry.verdict.status === 'verified');
}

// The first message (by position) that this browser has not seen and that somebody else wrote.
// 0 when there is none. lastSeen is the newest position seen before the room was opened.
export function firstUnreadSeq(entries, lastSeen, ownKeyId = '') {
  if (!Array.isArray(entries) || !Number.isSafeInteger(lastSeen) || lastSeen <= 0) return 0;
  for (const e of entries) {
    if (!e || !Number.isSafeInteger(e.seq) || e.seq <= lastSeen) continue;
    const signer = e.record && typeof e.record.signer === 'string' ? e.record.signer : '';
    if (ownKeyId && signer === ownKeyId) continue;
    return e.seq;
  }
  return 0;
}

// Turns the loaded messages into rows for the list.
//   { kind: 'day', key, label }                         a date separator
//   { kind: 'unread', key, label }                      the "unread messages" marker
//   { kind: 'msg', key, entry, grouped, endOfGroup }    one message
// grouped = the sender and avatar are not repeated (same verified sender, same day, close in time).
// endOfGroup = the last bubble of a group (it gets the tail and the space after it).
// Messages stay in the order the server numbered them. The time on a message is written by its
// sender, so it is only used for the separators and for grouping.
export function buildTimeline(entries, { firstUnread = 0, now = Date.now() } = {}) {
  const rows = [];
  const list = Array.isArray(entries) ? entries.filter((e) => e && Number.isSafeInteger(e.seq)) : [];
  let prev = null;
  let prevRow = null;
  let marked = false;
  for (const entry of list) {
    const rec = entry.record && typeof entry.record === 'object' ? entry.record : {};
    const at = validTime(rec.createdAt) ? rec.createdAt : null;
    const prevAt = prev && prev.record && validTime(prev.record.createdAt) ? prev.record.createdAt : null;
    let newDay = false;
    if (at !== null && (prevAt === null ? prev === null : !sameDay(prevAt, at))) {
      rows.push({ kind: 'day', key: `day-${entry.seq}`, label: dayLabel(at, now) });
      newDay = true;
    }
    let markedHere = false;
    if (firstUnread && !marked && entry.seq >= firstUnread) {
      rows.push({ kind: 'unread', key: 'unread', label: 'Unread messages' });
      marked = true;
      markedHere = true;
    }
    const sameSender =
      prev !== null &&
      isVerified(prev) &&
      isVerified(entry) &&
      typeof rec.signer === 'string' &&
      prev.record &&
      prev.record.signer === rec.signer;
    const close = at !== null && prevAt !== null && at - prevAt >= 0 && at - prevAt < GROUP_GAP_MS;
    const grouped = Boolean(sameSender && close && !newDay && !markedHere);
    if (prevRow) prevRow.endOfGroup = !grouped;
    const row = { kind: 'msg', key: `m-${entry.seq}`, entry, grouped, endOfGroup: true };
    rows.push(row);
    prevRow = row;
    prev = entry;
  }
  return rows;
}

// The calm line under the room header. Returns { tone: 'good' | 'info' | 'warn' | 'bad', text }.
//   view   the chat session state (phase, entries, anchor, problems, error)
//   poll   { status, delay } from the poller
export function roomStatus(view, poll = { status: 'running', delay: 0 }) {
  const entries = view && Array.isArray(view.entries) ? view.entries : [];
  const verified = entries.filter((e) => isVerified(e)).length;
  const failed = entries.filter((e) => e && e.verdict && e.verdict.status === 'invalid').length;
  if (poll && poll.status === 'retrying') {
    const s = Math.max(1, Math.round((poll.delay || 0) / 1000));
    return { tone: 'warn', text: `Connection problem. Trying again in ${s} ${s === 1 ? 'second' : 'seconds'}.` };
  }
  if (failed > 0 || (view && Array.isArray(view.problems) && view.problems.length > 0)) {
    return { tone: 'bad', text: failed > 0 ? `${failed} ${failed === 1 ? 'message' : 'messages'} could not be verified. Do not trust them.` : 'Something does not add up in this chat. Open the details.' };
  }
  const anchor = view ? view.anchor : null;
  if (anchor && (anchor.pinMismatch || anchor.badSignature)) {
    return { tone: 'bad', text: anchor.pinMismatch ? "The server's identity changed since your last visit." : "The server's newest record could not be checked." };
  }
  if (entries.length === 0) return { tone: 'info', text: 'Everything in this chat is signed and checked on your device.' };
  const n = entries.length;
  const checked = verified === n ? (n === 1 ? 'The message was checked here.' : 'All messages were checked here.') : `${verified} of ${n} messages were checked here.`;
  if (anchor && anchor.anchored) {
    // Green only when the server key is one this browser knows (chosen or remembered). On a first visit the
    // chat only agrees with the server's own word, so it is a calm note, not a green one.
    if (anchor.pinned === true) return { tone: 'good', text: `${checked} The newest one matches the server's record.` };
    return { tone: 'info', text: `${checked} The newest one matches the server's record, but this browser did not know the server's key before.` };
  }
  return { tone: 'info', text: `${checked} This view is not tied to the server's newest record.` };
}

// What the writing box shows. session is useSession(). Returns 'loading' | 'ready' | 'needsKey' | 'none'.
export function composerStatus(session) {
  if (!session || session.status === 'loading') return 'loading';
  if (session.status === 'ready' && session.identity) return 'ready';
  if (session.status === 'needsKey') return 'needsKey';
  return 'none';
}

// The server key id the chat is checked against: the one the person pinned, else the one remembered
// from an earlier visit, else none. pinLib is the module src/lib/pin.js. The remembered key getter
// is looked up by name, so this keeps working while that part is not there.
export function pinGetter(pinLib) {
  return () => {
    try {
      const pinned = pinLib && typeof pinLib.getPinnedServerKeyId === 'function' ? pinLib.getPinnedServerKeyId() : '';
      if (pinned) return pinned;
      for (const name of ['getRememberedServerKeyId', 'getRememberedServerKey']) {
        const fn = pinLib ? pinLib[name] : null;
        if (typeof fn === 'function') {
          const v = fn();
          if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) return v;
        }
      }
    } catch {
      // storage can fail, then there is nothing to check against
    }
    return '';
  };
}

// The trust on first use step for a server key whose checkpoint signature was checked.
// serverKeyTrust(id) only reads. On a first visit the key is remembered with rememberServerKey(id), so
// a later change is reported. Returns the trust word, or '' when src/lib/pin.js has no such function.
export function checkServerTrust(pinLib, serverKeyId) {
  try {
    const fn = pinLib ? pinLib.serverKeyTrust : null;
    if (typeof fn !== 'function' || typeof serverKeyId !== 'string' || !/^[0-9a-f]{64}$/.test(serverKeyId)) return '';
    const v = fn(serverKeyId);
    if (typeof v !== 'string') return '';
    if (v === 'first-visit' && typeof pinLib.rememberServerKey === 'function') {
      // Nothing was remembered when the write failed, so a later change could not be reported. Say so.
      if (pinLib.rememberServerKey(serverKeyId) === false) return 'first-visit-unsaved';
    }
    return v;
  } catch {
    return '';
  }
}

export function isTrustMismatch(trust) {
  return trust === 'pinned-mismatch' || trust === 'remembered-mismatch';
}

// Short text of a message for a quote or a reply bar (one line, cut).
export function quoteLine(text, max = 140) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max).join('') + '...' : flat;
}

// How a not yet confirmed message is described. Returns { tone, label }.
export function pendingLabel(item) {
  if (!item) return { tone: 'info', label: 'Sending' };
  if (item.status === 'failed') return { tone: 'bad', label: 'Not sent' };
  if (item.status === 'sent') return { tone: 'info', label: 'Sent' };
  return { tone: 'info', label: 'Sending' };
}

// The words for the character counter, shown only when the limit is near.
export function counterState(count, max) {
  if (!Number.isFinite(count) || !Number.isFinite(max)) return { show: false, tone: '', text: '' };
  const near = count >= Math.floor(max * 0.9);
  const over = count > max;
  return {
    show: near,
    tone: over ? 'over' : near ? 'near' : '',
    text: over ? `${count - max} over the limit (${count} / ${max})` : `${count} / ${max}`
  };
}
