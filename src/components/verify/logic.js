// Pure helpers for the Verify page: reading links, fingerprints, saved bundles, and comparing a
// local file with a document. No DOM and no network here, so all of it is tested in Node.
import { isHex } from '../../../shared/encoding.js';
import { sha256Hex } from '../../../shared/hash.js';
import { parseFragment } from '../../lib/links.js';

export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
export const MAX_COMPARE_BYTES = 512 * 1024 * 1024;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const messageOf = (e) => (e && typeof e.message === 'string' && e.message ? e.message : 'unknown error');

// ---------------------------------------------------------------------------
// Document id or link

// Reads a document id or a document link. Accepts:
//   9f2c...(32 hex)            a bare id
//   /d/9f2c...                 a path
//   https://host/d/9f2c...#k=ABCD-EFGH...   a full link, the password after #k= is returned too
// Returns { ok:true, docId, password, host } or { ok:false, error }. host is the host of a full
// link ('' for a bare id), so the page can say that only this site is asked.
export function parseDocInput(input) {
  if (typeof input !== 'string') return { ok: false, error: 'Enter a document id or a link.' };
  const text = input.trim().replace(/^[<"'(]+/, '').replace(/[>"'),;.]+$/, '');
  if (text === '') return { ok: false, error: 'Enter a document id or a link.' };
  if (text.length > 2048) return { ok: false, error: 'That is too long to be a document id or a link.' };

  const hashAt = text.indexOf('#');
  const beforeHash = hashAt >= 0 ? text.slice(0, hashAt) : text;
  const fragment = hashAt >= 0 ? text.slice(hashAt) : '';

  let host = '';
  let path = beforeHash;
  const full = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)(.*)$/i.exec(beforeHash);
  if (full) {
    host = full[1];
    path = full[2];
  }
  path = path.split('?')[0];

  let id = null;
  const inPath = /(?:^|\/)d\/([0-9a-fA-F]{32})\/?$/.exec(path);
  if (inPath) id = inPath[1];
  else {
    const bare = /^\/?([0-9a-fA-F]{32})\/?$/.exec(path);
    if (bare) id = bare[1];
  }
  if (id === null) {
    if (/^\/?[0-9a-fA-F]{64}\/?$/.test(path)) {
      return {
        ok: false,
        error: 'That is 64 characters long, so it is a hash and not a document id. A document id has 32 characters.'
      };
    }
    return {
      ok: false,
      error: 'No document id found. A document id is 32 letters and numbers (0-9, a-f), or a link that contains /d/ and the id.'
    };
  }
  const password = parseFragment(fragment);
  return { ok: true, docId: id.toLowerCase(), password: password || '', host };
}

// ---------------------------------------------------------------------------
// Fingerprints

// Cleans a pasted fingerprint: spaces, dashes and colons are dropped, case does not matter.
// Returns { state:'empty' } | { state:'invalid' } | { state:'ok', value }.
export function parseFingerprint(text) {
  if (typeof text !== 'string') return { state: 'empty' };
  const value = text.replace(/[\s:-]/g, '').toLowerCase();
  if (value === '') return { state: 'empty' };
  return isHex(value, 64) ? { state: 'ok', value } : { state: 'invalid' };
}

// actual is the fingerprint of the local file (64 lowercase hex). pasted is what the person typed.
// state: 'none' (nothing pasted), 'invalid', 'match' or 'different'.
export function compareFingerprint(actual, pasted) {
  const p = parseFingerprint(pasted);
  if (p.state === 'empty') return { state: 'none' };
  if (p.state === 'invalid') return { state: 'invalid' };
  return { state: isHex(actual, 64) && actual === p.value ? 'match' : 'different' };
}

// Groups of 8 characters, easier to read and to read out aloud.
export function spacedFingerprint(hex) {
  return typeof hex === 'string' ? hex.replace(/(.{8})(?=.)/g, '$1 ') : '';
}

// SHA-256 of a local File or Blob, as 64 lowercase hex. Throws a readable Error on a file that is
// too large or cannot be read.
export async function fingerprintOfFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('No file was chosen.');
  if (typeof file.size === 'number' && file.size > MAX_COMPARE_BYTES) {
    throw new Error('This file is too large to check in the browser (the limit is 512 MiB).');
  }
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new Error('The file could not be read. Choose it again.');
  }
  return sha256Hex(new Uint8Array(buffer));
}

// ---------------------------------------------------------------------------
// Saved bundle

// Reads the text of a saved bundle file. Accepts the bundle itself or a wrapper { bundle }.
// Returns { ok:true, bundle } or { ok:false, error }.
export function readBundleText(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'The file is empty.' };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not valid JSON, so it is not a saved verification bundle.' };
  }
  if (isObject(value) && !Array.isArray(value.records) && isObject(value.bundle)) value = value.bundle;
  if (!isObject(value) || !Array.isArray(value.records) || !isObject(value.document)) {
    return { ok: false, error: 'This JSON file does not look like a saved verification bundle (no document and records).' };
  }
  return { ok: true, bundle: value };
}

// When the server last signed anything in this bundle (ms), or null. Only informative: the
// verification result says whether the checkpoint itself is genuine.
export function bundleAttestedAt(bundle) {
  if (!isObject(bundle)) return null;
  const times = [];
  for (const key of ['headCheckpoint', 'checkpoint']) {
    const cp = bundle[key];
    if (isObject(cp) && isObject(cp.payload) && Number.isSafeInteger(cp.payload.signedAt)) times.push(cp.payload.signedAt);
  }
  return times.length > 0 ? Math.max(...times) : null;
}

// ---------------------------------------------------------------------------
// Comparing a local file with a document

// open is the result of openDocument. localHash is the SHA-256 of the local file.
// state:
//   'same'          the local bytes equal the unlocked file of the latest version
//   'different'     they are not equal
//   'no_file'       the document has no current file (revoked, or no records)
//   'not_unlocked'  the latest file could not be unlocked or did not match its signed entry
// verified says whether the signatures and chain of the document checked out.
export function compareWithHead(localHash, open) {
  const verified = !!(open && open.verification && open.verification.ok);
  const head = open && open.verification && open.verification.head ? open.verification.head : null;
  const version = head ? head.version : null;
  const base = { verified, version };
  if (!isHex(localHash, 64)) return { ...base, state: 'not_unlocked', detail: 'The local file has no fingerprint yet.' };
  if (!open || !open.bundle) return { ...base, state: 'not_unlocked', detail: 'The document was not opened.' };
  if (open.verification && open.verification.status === 'revoked') {
    return { ...base, state: 'no_file', detail: 'The owner revoked this document, so there is no current file to compare with.' };
  }
  if (!open.blobCheck) return { ...base, state: 'no_file', detail: 'This document has no current file to compare with.' };
  if (!open.blobCheck.ok) {
    return { ...base, state: 'not_unlocked', detail: 'The stored file does not match its signed hash: ' + open.blobCheck.detail };
  }
  if (!open.plaintextCheck) {
    return { ...base, state: 'not_unlocked', detail: 'No password was given, so the stored file was not unlocked.' };
  }
  if (!open.plaintextCheck.ok || !isHex(open.fingerprint, 64)) {
    return { ...base, state: 'not_unlocked', detail: 'The stored file could not be unlocked and checked: ' + open.plaintextCheck.detail };
  }
  return { ...base, state: open.fingerprint === localHash ? 'same' : 'different', detail: '' };
}

// Tries the older versions of a document, newest first, to see whether the local file equals one
// of them. This is only possible for versions that unlock with the same password, so every
// version ends in one of three states:
//   'same'        unlocked, checked against the signed commitment, and equal to the local file
//   'different'   unlocked, checked against the signed commitment, and not equal
//   'unreadable'  could not be downloaded, did not match its signed hash, or did not unlock
// deps: { getBlob(hash), unlock({ bytes, password }), verifyBlob(bytes, record), verifyPlaintext(parts, record) }
// shouldStop() lets the caller cancel. onVersion(entry) reports each result as it arrives.
export async function compareWithOlder({ localHash, records, password, deps, shouldStop, onVersion }) {
  const results = [];
  const rows = Array.isArray(records) ? records : [];
  const older = [];
  for (let i = rows.length - 2; i >= 0; i--) {
    const rec = rows[i] && rows[i].record;
    if (isObject(rec) && isObject(rec.blob) && typeof rec.blob.hash === 'string' && Number.isSafeInteger(rec.version)) {
      older.push(rec);
    }
  }
  let stopped = false;
  for (const rec of older) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      stopped = true;
      break;
    }
    let entry;
    try {
      const bytes = await deps.getBlob(rec.blob.hash);
      const blobCheck = await deps.verifyBlob(bytes, rec);
      if (!blobCheck.ok) {
        entry = { version: rec.version, state: 'unreadable', detail: 'The stored file does not match its signed hash.' };
      } else {
        let unlocked = null;
        try {
          unlocked = await deps.unlock({ bytes, password });
        } catch {
          unlocked = null;
        }
        if (!unlocked) {
          entry = {
            version: rec.version,
            state: 'unreadable',
            detail: 'Does not unlock with this password (this version may use a different one).'
          };
        } else {
          const plain = await deps.verifyPlaintext({ fileHash: unlocked.fileHash, commitSalt: unlocked.commitSalt }, rec);
          if (!plain.ok) {
            entry = { version: rec.version, state: 'unreadable', detail: 'The unlocked file does not match its signed commitment.' };
          } else {
            entry = {
              version: rec.version,
              state: unlocked.fileHash === localHash ? 'same' : 'different',
              detail: ''
            };
          }
        }
      }
    } catch (err) {
      entry = { version: rec.version, state: 'unreadable', detail: 'Could not be checked: ' + messageOf(err) };
    }
    results.push(entry);
    if (typeof onVersion === 'function') {
      try {
        onVersion(entry);
      } catch {
        // ignore a broken callback
      }
    }
    if (entry.state === 'same') break;
  }
  const match = results.find((r) => r.state === 'same') || null;
  return { results, match, stopped, total: older.length };
}

// Plain sentences for the result of compareWithOlder. Says only what was proven.
export function describeOlderComparison(outcome) {
  if (!outcome) return '';
  if (outcome.match) {
    return `The file is identical to version ${outcome.match.version}, which is not the latest version.`;
  }
  const unreadable = outcome.results.filter((r) => r.state === 'unreadable').length;
  const different = outcome.results.filter((r) => r.state === 'different').length;
  if (outcome.total === 0) return 'There are no older versions to compare with.';
  const parts = [];
  parts.push(
    different === 0
      ? 'No older version was shown to be the same as this file.'
      : `The file is not identical to ${different} older ${different === 1 ? 'version' : 'versions'} that could be unlocked.`
  );
  if (unreadable > 0) {
    parts.push(
      `${unreadable} older ${unreadable === 1 ? 'version' : 'versions'} could not be unlocked with this password, so ${
        unreadable === 1 ? 'it was' : 'they were'
      } not compared and the file might still match ${unreadable === 1 ? 'it' : 'one of them'}.`
    );
  }
  if (outcome.stopped) parts.push('The check was stopped before every version was tried.');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Server key pin

const KEY_RE = /^[0-9a-f]{64}$/;

// Reads text typed into the pin box. Returns { state:'empty' } | { state:'invalid' } | { state:'ok', value }.
export function parseKeyIdInput(text) {
  if (typeof text !== 'string') return { state: 'empty' };
  const value = text.replace(/[\s:-]/g, '').toLowerCase();
  if (value === '') return { state: 'empty' };
  return KEY_RE.test(value) ? { state: 'ok', value } : { state: 'invalid' };
}

// How the pin compares with the key the server is using now. server is
// { status:'loading'|'ready'|'error', data:{ signing, keyId } }.
//   'none'        nothing pinned
//   'checking'    pinned, the server key is still loading
//   'unknown'     pinned, the server key could not be fetched
//   'no_signing'  pinned, but the server has no signing key
//   'match'       pinned and the server uses that key
//   'different'   pinned and the server uses another key
export function pinStatus(pinned, server) {
  if (!pinned) return 'none';
  if (!server || server.status === 'loading') return 'checking';
  if (server.status !== 'ready' || !server.data) return 'unknown';
  if (!server.data.signing || typeof server.data.keyId !== 'string' || server.data.keyId === '') return 'no_signing';
  return server.data.keyId === pinned ? 'match' : 'different';
}
