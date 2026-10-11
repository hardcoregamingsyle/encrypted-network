// A small list of the documents published from this browser (ids and labels only).
// Passwords are never stored here. Every storage call is wrapped, so a blocked or full
// storage just means an empty list.

const KEY = 'hrdlock.localDocs';
const MAX_ENTRIES = 500;
const MAX_LABEL = 120;
const DOC_ID_RE = /^[0-9a-f]{32}$/;
const OWNER_RE = /^[0-9a-f]{64}$/;

function store() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function clean(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.docId !== 'string' || !DOC_ID_RE.test(entry.docId)) return null;
  const label = typeof entry.label === 'string' ? Array.from(entry.label).slice(0, MAX_LABEL).join('') : '';
  const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : 0;
  // The key id of the person who published it, so a list is never shown to somebody else on the same browser.
  const owner = typeof entry.owner === 'string' && OWNER_RE.test(entry.owner) ? entry.owner : '';
  return owner ? { docId: entry.docId, label, createdAt, owner } : { docId: entry.docId, label, createdAt };
}

function readAll() {
  try {
    const s = store();
    if (!s) return [];
    const text = s.getItem(KEY);
    if (!text) return [];
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    const seen = new Set();
    const out = [];
    for (const item of data) {
      const e = clean(item);
      if (e && !seen.has(e.docId)) {
        seen.add(e.docId);
        out.push(e);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(list) {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

// Newest first.
export function listLocalDocs() {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

// entry: { docId, label, createdAt, owner }. Only those fields are kept. Returns true when saved.
export function rememberDoc(entry) {
  const e = clean(entry);
  if (!e) return false;
  const list = readAll().filter((x) => x.docId !== e.docId);
  list.push(e);
  list.sort((a, b) => b.createdAt - a.createdAt);
  return writeAll(list.slice(0, MAX_ENTRIES));
}

// The entries that belong to one key: those it published, and old ones that name no owner.
export function docsOwnedBy(list, keyId) {
  return (Array.isArray(list) ? list : []).filter((e) => e && (!e.owner || e.owner === keyId));
}

// Forgets the whole list. Used when the person using this browser changes (sign out, delete, leave).
export function clearLocalDocs() {
  try {
    const s = store();
    if (s) s.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

export function forgetDoc(docId) {
  const list = readAll();
  const next = list.filter((x) => x.docId !== docId);
  if (next.length === list.length) return false;
  return writeAll(next);
}
