// Remembers the server key id the user chose to trust (a "pin"), in localStorage.
// Every storage call is wrapped, so a browser that blocks storage just gets no pin.
// It also holds the trust on first use helpers: the server key a browser saw first is remembered.

import { keyIdOf } from '../../shared/keys.js';
import { getServerKey } from './api.js';

const KEY = 'hrdlock.pinnedServerKeyId';
const HASH_RE = /^[0-9a-f]{64}$/;

function store() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

// Returns the pinned key id, or '' when nothing is pinned or storage is not usable.
export function getPinnedServerKeyId() {
  try {
    const s = store();
    if (!s) return '';
    const v = s.getItem(KEY);
    return typeof v === 'string' && HASH_RE.test(v) ? v : '';
  } catch {
    return '';
  }
}

// Saves a pin. The id must be 64 hex characters (case and outer spaces are fixed).
// An empty id clears the pin. Returns true when the stored state matches the request.
export function setPinnedServerKeyId(id) {
  try {
    const v = typeof id === 'string' ? id.trim().toLowerCase() : null;
    if (v === null) return false;
    if (v === '') return clearPin();
    if (!HASH_RE.test(v)) return false;
    const s = store();
    if (!s) return false;
    s.setItem(KEY, v);
    return true;
  } catch {
    return false;
  }
}

// Removes the pin. Returns true when it is gone.
export function clearPin() {
  try {
    const s = store();
    if (!s) return false;
    s.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Trust on first use.
//
// The first time this browser sees a server key it remembers the key id. When the key later changes,
// that is a loud warning. A key the person pinned on purpose (Verify > Advanced) always wins over a
// remembered one. The remembered key lives in its own storage entry, so clearing a pin never touches
// it and remembering never overwrites a pin.

const REMEMBERED_KEY = 'hrdlock.rememberedServerKeyId';

export const TRUST_STATES = Object.freeze([
  'pinned-match',
  'pinned-mismatch',
  'remembered-match',
  'remembered-mismatch',
  'first-visit'
]);

function validId(v) {
  return typeof v === 'string' && HASH_RE.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : '';
}

// Returns the remembered key id, or '' when nothing is remembered or storage is not usable.
export function getRememberedServerKeyId() {
  try {
    const s = store();
    if (!s) return '';
    const v = s.getItem(REMEMBERED_KEY);
    return typeof v === 'string' && HASH_RE.test(v) ? v : '';
  } catch {
    return '';
  }
}

// Remembers a server key id (64 hex). Returns true when it is stored. A remembered key is replaced only
// by the person asking for it (forgetServerKey, then a new first visit), so a changed key stays a warning.
export function rememberServerKey(id) {
  try {
    const v = validId(id);
    if (!v) return false;
    const s = store();
    if (!s) return false;
    s.setItem(REMEMBERED_KEY, v);
    return s.getItem(REMEMBERED_KEY) === v;
  } catch {
    return false;
  }
}

// Forgets the remembered key, so the next visit is a first visit again. Returns true when it is gone.
export function forgetRememberedServerKey() {
  try {
    const s = store();
    if (!s) return false;
    s.removeItem(REMEMBERED_KEY);
    return true;
  } catch {
    return false;
  }
}

// Pure: the trust state for three known values. A current key that is missing or malformed never counts
// as a match.
export function classifyServerKey({ pinned = '', remembered = '', current = '' } = {}) {
  const p = validId(pinned);
  const r = validId(remembered);
  const c = validId(current);
  if (p) return c && c === p ? 'pinned-match' : 'pinned-mismatch';
  if (r) return c && c === r ? 'remembered-match' : 'remembered-mismatch';
  return 'first-visit';
}

// Pure: which key id verification should be pinned to, and whether the current key is to be remembered.
// Order: the explicit pin, then the remembered key, then the current key (first visit), else nothing.
export function chooseEffectiveKey({ pinned = '', remembered = '', current = '' } = {}) {
  const p = validId(pinned);
  if (p) return { key: p, remember: false };
  const r = validId(remembered);
  if (r) return { key: r, remember: false };
  const c = validId(current);
  if (c) return { key: c, remember: true };
  return { key: '', remember: false };
}

// 'pinned-match' | 'pinned-mismatch' | 'remembered-match' | 'remembered-mismatch' | 'first-visit'
// Reads storage only. It never remembers anything.
export function serverKeyTrust(currentServerKeyId) {
  return classifyServerKey({
    pinned: getPinnedServerKeyId(),
    remembered: getRememberedServerKeyId(),
    current: currentServerKeyId
  });
}

// Works out the key to verify against and whether a first visit key could really be saved. -> { key, remember, saved }
function effectiveChoice(currentServerKeyId) {
  const choice = chooseEffectiveKey({
    pinned: getPinnedServerKeyId(),
    remembered: getRememberedServerKeyId(),
    current: currentServerKeyId
  });
  const saved = choice.remember ? rememberServerKey(choice.key) : true;
  return { ...choice, saved };
}

// The key id to pass as pinnedServerKeyId when verifying: the pinned key, else the remembered key, else the
// current key on a first visit (which is then remembered). '' when none of them is known.
// Compute serverKeyTrust(current) BEFORE calling this on the same visit, because this remembers the key.
export function effectivePinnedKey(currentServerKeyId) {
  return effectiveChoice(currentServerKeyId).key;
}

// The word for a first visit whose key could not be written to storage. Nothing was remembered, so the
// screens must not say it was, and a changed key on a later visit cannot be reported.
export const FIRST_VISIT_UNSAVED = 'first-visit-unsaved';

// Both answers from one read, in the right order: { trust, pin }. Use this when the trust state is also shown.
// trust is 'first-visit-unsaved' when this was a first visit but the key could not be saved.
export function prepareServerTrust(currentServerKeyId) {
  let trust = serverKeyTrust(currentServerKeyId);
  const choice = effectiveChoice(currentServerKeyId);
  if (trust === 'first-visit' && choice.remember && !choice.saved) trust = FIRST_VISIT_UNSAVED;
  return { trust, pin: choice.key };
}

// ---------------------------------------------------------------------------
// The key the server uses now. The key id is worked out from the public key the server sends, never
// taken from the id the server states about itself.

const CURRENT_TTL_MS = 60 * 1000;
let currentCache = { at: 0, id: '' };

export function resetServerKeyCache() {
  currentCache = { at: 0, id: '' };
}

async function fetchCurrentServerKeyId() {
  const raw = await getServerKey();
  if (!raw || raw.signing !== true || !raw.publicKey) return '';
  return validId(await keyIdOf(raw.publicKey));
}

// -> the key id the server signs with now, or '' when it cannot be learned (network, not signing, bad key).
// fetchId and now can be replaced in tests.
export async function currentServerKeyId({ fetchId = fetchCurrentServerKeyId, now = Date.now() } = {}) {
  if (currentCache.id && now - currentCache.at >= 0 && now - currentCache.at < CURRENT_TTL_MS) return currentCache.id;
  try {
    const id = validId(await fetchId());
    if (id) currentCache = { at: now, id };
    return id;
  } catch {
    return '';
  }
}

// One call for screens that verify: learns the current server key, then returns { trust, pin, current }.
// When the current key cannot be learned, trust is '' (unknown, the summary then relies on the check
// against the pin alone) and pin is the pinned or remembered key, or '' on a first visit.
export async function loadServerTrust(opts) {
  const current = await currentServerKeyId(opts);
  if (!current) return { trust: '', pin: effectivePinnedKey(''), current: '' };
  return { ...prepareServerTrust(current), current };
}

// ---------------------------------------------------------------------------
// One trust decision per page view.
//
// Working out the trust state remembers a first visit key, so a second call in the same page view would
// read the key it just saved and call a first visit "remembered from an earlier visit". A page that loads
// twice in one view (double effects, a load followed by a refresh) must reuse the first decision. A view is
// named by the caller (the router location key): a new navigation is a new view and reads storage again.

const VIEW_DECISIONS_MAX = 20;
const viewDecisions = new Map();

export function resetViewTrust() {
  viewDecisions.clear();
}

// Like loadServerTrust, but the answer for (view, current key) is decided once and reused.
// A key that changed within the same view is decided again, so a swap is still reported.
export async function loadServerTrustOnce(view, opts) {
  const current = await currentServerKeyId(opts);
  if (!current) return { trust: '', pin: effectivePinnedKey(''), current: '' };
  const name = typeof view === 'string' && view !== '' ? `${view}|${current}` : '';
  // Nothing awaits between this lookup and the decision below, so two overlapping loads cannot both decide.
  if (name && viewDecisions.has(name)) return { ...viewDecisions.get(name) };
  const decision = { ...prepareServerTrust(current), current };
  if (name) {
    viewDecisions.set(name, decision);
    if (viewDecisions.size > VIEW_DECISIONS_MAX) viewDecisions.delete(viewDecisions.keys().next().value);
  }
  return { ...decision };
}
