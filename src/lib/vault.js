// The owner's file passwords.
//
// A file is locked with a generated password. The share link carries it after the #, and the owner's
// copy is kept here so the owner can open their own files later without the link:
//   Easy account    the account holds it, encrypted (PUT and GET /api/me/secrets). If the account cannot
//                   be reached the password is kept on this device as a fallback.
//   Strict account  the account keeps nothing, passwords stay on this device only.
//   Quick start     passwords stay on this device only.
// Every call tolerates failures: the link still carries the password, so nothing here may block a publish.
import * as realApi from './api.js';

const STORAGE_KEY = 'hrdlock.vault.v1';
const MAX_ENTRIES_PER_SCOPE = 2000;
const DOC_ID_RE = /^[0-9a-f]{32}$/;

// What the vault needs to know about the person right now: { mode, strict, accountId }.
// The session sets this whenever it changes.
let context = () => ({ mode: null, strict: false, accountId: '' });

export function setVaultContext(fn) {
  context = typeof fn === 'function' ? fn : () => ({ mode: null, strict: false, accountId: '' });
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readAll(store) {
  try {
    const text = store.getItem(STORAGE_KEY);
    const data = text ? JSON.parse(text) : {};
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeAll(store, data) {
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

const scopeOf = (ctx) => (ctx.mode === 'account' && ctx.accountId ? 'a:' + ctx.accountId : 'guest');

// A scope is an object of docId -> password. A damaged entry of any other shape (an array, a string) is
// replaced, so a save that says it was kept really is.
const isScope = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// The local vault (this browser only)

export function localGet(scope, docId) {
  const store = storage();
  if (!store || !DOC_ID_RE.test(String(docId))) return null;
  const entry = readAll(store)[scope];
  const value = isScope(entry) ? entry[docId] : null;
  return typeof value === 'string' && value ? value : null;
}

export function localSet(scope, docId, password) {
  const store = storage();
  if (!store || !DOC_ID_RE.test(String(docId)) || typeof password !== 'string' || !password) return false;
  const all = readAll(store);
  const entry = isScope(all[scope]) ? all[scope] : {};
  entry[docId] = password;
  const ids = Object.keys(entry);
  // never grow without limit: the oldest inserted entries go first
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES_PER_SCOPE))) delete entry[id];
  all[scope] = entry;
  return writeAll(store, all);
}

// Removes everything kept for one scope ('guest' or 'a:<accountId>'), or everything when scope is omitted.
export function localClear(scope) {
  const store = storage();
  if (!store) return false;
  try {
    if (scope === undefined) {
      store.removeItem(STORAGE_KEY);
      return true;
    }
    const all = readAll(store);
    delete all[scope];
    return writeAll(store, all);
  } catch {
    return false;
  }
}

// True when this browser can really keep a password: writes a probe and reads it back.
export function canKeepLocally() {
  const store = storage();
  if (!store) return false;
  // Writes back what is there (or an empty vault): nothing changes if it works, and it throws if it cannot.
  return writeAll(store, readAll(store));
}

// ---------------------------------------------------------------------------
// The hand over to this device when Strict mode is switched on
//
// The service hands the passwords over in pages and deletes a page only after it is told that the page is stored.
// So a page must be written in one go, without the size limit that applies to everyday saving (nothing that was
// handed over may be pushed out by the next page), and then read back to be sure it is really there.

// Writes the list to the scope in one write and reads the storage again. Returns how many passwords are really
// there afterwards (0 when the write did not work). Entries that are not a docId with a password are ignored.
export function keepAll(scope, list) {
  const store = storage();
  if (!store) return 0;
  const items = (Array.isArray(list) ? list : []).filter(
    (item) => item && DOC_ID_RE.test(String(item.docId)) && typeof item.password === 'string' && item.password
  );
  if (items.length === 0) return 0;
  const all = readAll(store);
  const entry = isScope(all[scope]) ? all[scope] : {};
  for (const item of items) entry[item.docId] = item.password;
  all[scope] = entry;
  if (!writeAll(store, all)) return 0;
  const back = readAll(store)[scope];
  if (!isScope(back)) return 0;
  let count = 0;
  for (const item of items) if (back[item.docId] === item.password) count += 1;
  return count;
}

const RUN_LIVE_MS = 24 * 60 * 60 * 1000; // the service keeps what was not confirmed for 24 hours
const runScope = (accountId) => 'r:' + accountId;

// A switch to Strict mode started for this account and has not been finished on this device. It is remembered
// (inside the vault entry, as { at: time }) so that a retry or a later visit can finish handing the passwords over.
// Returns false when it could not be saved.
export function markStrictRun(accountId, now = Date.now()) {
  const store = storage();
  if (!store || typeof accountId !== 'string' || !accountId) return false;
  const all = readAll(store);
  all[runScope(accountId)] = { at: now };
  return writeAll(store, all);
}

// True while a started switch is unfinished and the service may still hold passwords for it (24 hours).
export function strictRunOpen(accountId, now = Date.now()) {
  const store = storage();
  if (!store || typeof accountId !== 'string' || !accountId) return false;
  const entry = readAll(store)[runScope(accountId)];
  return isScope(entry) && Number.isFinite(entry.at) && now - entry.at < RUN_LIVE_MS;
}

export function clearStrictRun(accountId) {
  const store = storage();
  if (!store) return false;
  const all = readAll(store);
  if (!(runScope(accountId) in all)) return true;
  delete all[runScope(accountId)];
  return writeAll(store, all);
}

// Passwords that were kept on this device only because the account could not be reached when the file was
// published. They are kept in the scope 'a:<accountId>' like any other, and listed here so they can be sent
// to the account later. A password kept on purpose (Strict mode) is never in this list.
const pendingScope = (accountId) => 'u:' + accountId;

export function markPending(accountId, docId) {
  return localSet(pendingScope(accountId), docId, '1');
}

export function pendingList(accountId) {
  return localList(pendingScope(accountId))
    .map((item) => ({ docId: item.docId, password: localGet('a:' + accountId, item.docId) }))
    .filter((item) => typeof item.password === 'string' && item.password);
}

export function clearPending(accountId, docId) {
  if (docId === undefined) return localClear(pendingScope(accountId));
  const store = storage();
  if (!store) return false;
  const all = readAll(store);
  const entry = all[pendingScope(accountId)];
  if (!isScope(entry)) return true;
  delete entry[docId];
  return writeAll(store, all);
}

// [{ docId, password }] kept on this device for a scope.
export function localList(scope) {
  const store = storage();
  if (!store) return [];
  const entry = readAll(store)[scope];
  if (!isScope(entry)) return [];
  return Object.entries(entry)
    .filter(([id, pw]) => DOC_ID_RE.test(id) && typeof pw === 'string' && pw)
    .map(([docId, password]) => ({ docId, password }));
}

// ---------------------------------------------------------------------------
// The vault

// api and the context can be replaced, so the logic is testable without a server.
export function createVault({ api = realApi, getContext = () => context() } = {}) {
  // Returns where the password ended up: 'account', 'device' or 'none'. Never throws.
  // ctx is the context captured when the publish started (see snapshot). Without it the live one is used.
  // Nobody signed in means nothing is kept: a password dropped into a shared scope would be handed to the
  // next person who starts on this browser.
  async function saveDocPassword(docId, password, ctx = null) {
    try {
      if (!DOC_ID_RE.test(String(docId)) || typeof password !== 'string' || !password) return 'none';
      ctx = ctx || getContext();
      if (!ctx.mode) return 'none';
      const scope = scopeOf(ctx);
      if (ctx.mode === 'account' && !ctx.strict) {
        try {
          await api.putSecret(docId, password);
          return 'account';
        } catch {
          if (!localSet(scope, docId, password)) return 'none';
          markPending(ctx.accountId, docId);
          return 'device';
        }
      }
      return localSet(scope, docId, password) ? 'device' : 'none';
    } catch {
      return 'none';
    }
  }

  // The password, or null when none is known. Never throws.
  async function getDocPassword(docId) {
    try {
      if (!DOC_ID_RE.test(String(docId))) return null;
      const ctx = getContext();
      if (!ctx.mode) return null;
      const scope = scopeOf(ctx);
      if (ctx.mode === 'account' && !ctx.strict) {
        try {
          const answer = await api.getSecret(docId);
          if (answer && typeof answer.password === 'string' && answer.password) return answer.password;
        } catch {
          // fall through to the copy on this device
        }
      }
      return localGet(scope, docId);
    } catch {
      return null;
    }
  }

  // Keeps passwords on this device, for example after the account stops holding them (Strict mode).
  function rememberOnDevice(list) {
    const ctx = getContext();
    const scope = scopeOf(ctx);
    let count = 0;
    for (const item of Array.isArray(list) ? list : []) {
      if (item && localSet(scope, item.docId, item.password)) count += 1;
    }
    return count;
  }

  // Keeps a page of handed over passwords for the person who is signed in and returns how many are really stored
  // (read back). See keepAll.
  function keepHandedOver(list) {
    return keepAll(scopeOf(getContext()), list);
  }

  // Who is signed in right now, as a plain copy. A publish takes it when it starts, so a late save lands with
  // the person who started it, not with whoever is signed in when it ends.
  function snapshot() {
    return { ...getContext() };
  }

  return { saveDocPassword, getDocPassword, rememberOnDevice, keepHandedOver, snapshot };
}

const defaultVault = createVault();

export const saveDocPassword = defaultVault.saveDocPassword;
export const getDocPassword = defaultVault.getDocPassword;
export const rememberOnDevice = defaultVault.rememberOnDevice;
export const keepHandedOver = defaultVault.keepHandedOver;
export const snapshotVaultContext = defaultVault.snapshot;

// Plain text for a downloaded file of passwords: one line per file.
export function passwordsFileText(list) {
  const lines = ['hrdlock file passwords', 'Keep this file private. Each line is a file id and its password.', ''];
  for (const item of Array.isArray(list) ? list : []) {
    if (item && typeof item.docId === 'string' && typeof item.password === 'string') lines.push(`${item.docId}  ${item.password}`);
  }
  return lines.join('\n') + '\n';
}
