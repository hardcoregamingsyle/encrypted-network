// Remembers the server key id the user chose to trust (a "pin"), in localStorage.
// Every storage call is wrapped, so a browser that blocks storage just gets no pin.

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
