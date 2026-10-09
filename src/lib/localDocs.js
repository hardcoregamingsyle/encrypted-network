// A small list of the documents published from this browser (ids and labels only).
// Passwords are never stored here. Every storage call is wrapped, so a blocked or full
// storage just means an empty list.

const KEY = 'hrdlock.localDocs';
const MAX_ENTRIES = 500;
const MAX_LABEL = 120;
const DOC_ID_RE = /^[0-9a-f]{32}$/;

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
  return { docId: entry.docId, label, createdAt };
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

// entry: { docId, label, createdAt }. Only those three fields are kept. Returns true when saved.
export function rememberDoc(entry) {
  const e = clean(entry);
  if (!e) return false;
  const list = readAll().filter((x) => x.docId !== e.docId);
  list.push(e);
  list.sort((a, b) => b.createdAt - a.createdAt);
  return writeAll(list.slice(0, MAX_ENTRIES));
}

export function forgetDoc(docId) {
  const list = readAll();
  const next = list.filter((x) => x.docId !== docId);
  if (next.length === list.length) return false;
  return writeAll(next);
}
