// Remembers the newest head of each document this browser has opened and verified, so a later
// rollback can be noticed (see shared/headMemory.js). Ids, numbers and hashes only, never
// passwords or file names. Every storage call is wrapped. When storage is blocked the values are
// kept in memory for the life of the page, so the check still works inside one visit.

import { cleanSeenHead } from '../../shared/headMemory.js';

const KEY = 'hrdlock.seenHeads';
const MAX_ENTRIES = 500;
const memory = new Map();

function store() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readAll() {
  const out = new Map(memory);
  try {
    const s = store();
    const text = s ? s.getItem(KEY) : null;
    if (text) {
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const id of Object.keys(data)) {
          const e = cleanSeenHead(data[id]);
          if (e && e.docId === id) out.set(id, e);
        }
      }
    }
  } catch {
    // unreadable storage: use what is in memory
  }
  return out;
}

function writeAll(map) {
  // Keep the newest entries only (insertion order, oldest first).
  const ids = Array.from(map.keys());
  const keep = ids.slice(Math.max(0, ids.length - MAX_ENTRIES));
  const obj = {};
  memory.clear();
  for (const id of keep) {
    obj[id] = map.get(id);
    memory.set(id, map.get(id));
  }
  try {
    const s = store();
    if (s) s.setItem(KEY, JSON.stringify(obj));
  } catch {
    // full or blocked storage: the in-memory copy still works
  }
}

// Returns the remembered head of a document, or null.
export function getSeenHead(docId) {
  const e = readAll().get(docId);
  return e || null;
}

// Saves a head (replaces any earlier one for the same document).
export function setSeenHead(head) {
  const clean = cleanSeenHead(head);
  if (!clean) return false;
  const all = readAll();
  all.delete(clean.docId);
  all.set(clean.docId, clean);
  writeAll(all);
  return true;
}

// Forgets one document, or every document when no id is given.
export function forgetSeenHead(docId) {
  if (docId === undefined) {
    memory.clear();
    try {
      const s = store();
      if (s) s.removeItem(KEY);
    } catch {
      // ignore
    }
    return;
  }
  const all = readAll();
  all.delete(docId);
  writeAll(all);
}
