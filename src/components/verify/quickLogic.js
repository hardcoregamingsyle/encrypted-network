// Pure helpers for the quick check on the Verify screen.
import { fileState } from '../../lib/trust.js';
import { parseDocInput } from './logic.js';

// The file checks of an openDocument() result as plain lines: [{ id, ok, text, note }].
// Empty when the file was not looked at.
export function fileLines(result) {
  if (!result || typeof result !== 'object') return [];
  const state = fileState(result);
  const lines = [];
  const blob = result.blobCheck && typeof result.blobCheck === 'object' ? result.blobCheck : null;
  const plain = result.plaintextCheck && typeof result.plaintextCheck === 'object' ? result.plaintextCheck : null;
  if (blob) {
    lines.push({
      id: 'blob',
      ok: blob.ok === true,
      text: blob.ok === true ? 'The stored file is the one the owner signed.' : 'The stored file is not the one the owner signed.',
      note: ''
    });
  }
  if (plain) {
    if (plain.ok === true && state === 'matches') {
      lines.push({ id: 'plain', ok: true, text: 'The opened file matches what the owner signed.', note: '' });
    } else if (state === 'not-opened') {
      lines.push({ id: 'plain', ok: false, text: 'The password did not open the file.', note: 'The file itself was not checked.' });
    } else {
      lines.push({ id: 'plain', ok: false, text: 'The opened file does not match what the owner signed.', note: '' });
    }
  } else if (state === 'locked-only') {
    lines.push({
      id: 'plain',
      ok: true,
      // nothing was checked here, so it is drawn as a note and not as a passed check
      neutral: true,
      text: 'The file was not opened.',
      note: 'The link has no password, so only the stored file was matched to the signed record.'
    });
  }
  return lines;
}

// One quick check, without any screen. Reads the link or id, learns the server key state, opens the
// document with the effective pin and returns what the screen needs.
//   deps.loadTrust()  -> { trust, pin }       (loadServerTrust from lib/pin.js)
//   deps.open(args)   -> openDocument result  (openDocument from lib/publish.js)
// Returns { ok: false, error } for a bad input, or { ok: true, docId, trust, result, stale: false }.
// Network and server errors from open() are thrown. When isStale() turns true after an await the
// function returns { ok: true, stale: true } and the screen ignores it.
export async function quickCheck(input, deps, { onStep, isStale = () => false } = {}) {
  const p = parseDocInput(input);
  if (!p.ok) return { ok: false, error: p.error };
  const known = await deps.loadTrust();
  if (isStale()) return { ok: true, stale: true };
  const open = await deps.open({
    docId: p.docId,
    password: p.password,
    pinnedServerKeyId: known && typeof known.pin === 'string' ? known.pin : '',
    onStep
  });
  if (isStale()) return { ok: true, stale: true };
  const result = {
    verification: open.verification,
    bundle: open.bundle,
    blobCheck: open.blobCheck,
    plaintextCheck: open.plaintextCheck,
    fingerprint: open.fingerprint,
    file: open.file ? { name: open.file.name, size: open.file.data.length } : null
  };
  return { ok: true, stale: false, docId: p.docId, trust: known && typeof known.trust === 'string' ? known.trust : '', result };
}
