// Builds and reads the links of a document.
// With a window the links are absolute (origin + path), without one they are relative paths.
// The password only ever goes after the # so it is never sent to a server.
import { normalizePassword } from './lockfile.js';

const MAX_PASSWORD_CHARS = 256;

function origin() {
  try {
    const o = globalThis.window && globalThis.window.location && globalThis.window.location.origin;
    return typeof o === 'string' && o !== '' && o !== 'null' ? o : '';
  } catch {
    return '';
  }
}

// Link that opens the document and verifies it, no password.
export function verifyLink(docId) {
  return origin() + '/d/' + encodeURIComponent(String(docId));
}

// Link that also carries the password after the # (shown without dashes).
export function fullLink(docId, password) {
  const pw = normalizePassword(password);
  if (!pw) return verifyLink(docId);
  return verifyLink(docId) + '#k=' + encodeURIComponent(pw);
}

// Reads the password from a location hash such as '#k=ABCD-EFGH'. Dashes, spaces and case do not
// matter. Returns the normalised password (upper case, no dashes) or null.
export function parseFragment(hash) {
  try {
    if (typeof hash !== 'string') return null;
    const text = hash.startsWith('#') ? hash.slice(1) : hash;
    if (text.length === 0 || text.length > MAX_PASSWORD_CHARS * 4) return null;
    let raw = null;
    for (const part of text.split('&')) {
      const eq = part.indexOf('=');
      if (eq > 0 && part.slice(0, eq) === 'k') {
        raw = part.slice(eq + 1);
        break;
      }
    }
    if (raw === null) return null;
    const pw = normalizePassword(decodeURIComponent(raw));
    if (pw.length === 0 || pw.length > MAX_PASSWORD_CHARS) return null;
    return pw;
  } catch {
    return null;
  }
}
