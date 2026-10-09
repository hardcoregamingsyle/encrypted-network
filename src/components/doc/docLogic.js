// Pure logic for the document page. No DOM and no network, so it can be tested in Node.
import { isHex } from '../../../shared/encoding.js';
import { formatBytes, formatTime } from '../../lib/format.js';
import { parseFragment } from '../../lib/links.js';
import { normalizePassword } from '../../lib/lockfile.js';

export const REVOKE_WORD = 'REVOKE';
export const REASON_MAX = 500;
export const LABEL_MAX = 120;
export const MAX_FILE_BYTES = 52428800;
export const BUNDLE_KIND = 'hrdlock-verification-bundle';

const PASSWORD_ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{20}$/;

export const LATEST_MEANING =
  'Latest here means the newest version the server knew about at the checkpoint time shown. A server could ' +
  'hide a newer version by simply not publishing it. Only a full ledger audit, compared with a checkpoint you ' +
  'saved earlier, can catch that.';

export const LIMITS_SENTENCE =
  'This page checks signatures, the order of versions and the file fingerprint. It does not prove that the ' +
  'content is true or lawful, or who the signer is in real life (the name is chosen by the key holder). ' +
  'This is a prototype and has not been audited or certified.';

const CHECK_NAMES = {
  identities_match: 'signer identities',
  record_signatures: 'signatures',
  chain_links: 'version chain',
  single_owner: 'one owner',
  no_post_revoke: 'nothing after a revoke',
  ledger_links: 'server ledger links',
  head_matches: 'latest version match',
  checkpoint: 'server checkpoint'
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function codePoints(text) {
  return Array.from(typeof text === 'string' ? text : '').length;
}

// ---------- ids and errors ----------

// Document ids are 32 lower case hex characters. Upper case is accepted and lowered.
export function cleanDocId(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export function docIdProblem(docId) {
  return isHex(docId, 32) ? '' : 'This is not a valid document id. A document id is 32 letters and digits (0-9, a-f).';
}

// Turns an error from the api into { kind, title, text }. stepId is the last step that was running.
export function describeLoadError(err, stepId = '') {
  const status = err && typeof err.status === 'number' ? err.status : 0;
  const code = err && typeof err.code === 'string' ? err.code : '';
  const message = err && typeof err.message === 'string' && err.message ? err.message : '';
  if (code === 'network') {
    return {
      kind: 'network',
      title: 'Could not reach the server',
      text: message || 'Check your connection and try again.'
    };
  }
  if (status === 404 || code === 'not_found') {
    if (stepId === 'download') {
      return {
        kind: 'blob_missing',
        title: 'The locked file is missing on the server',
        text: 'The signed record exists, but the server could not give the locked file for it. Try again later.'
      };
    }
    return {
      kind: 'notfound',
      title: 'Document not found',
      text: 'No document with this id exists on this server. Check the id or the link you were given.'
    };
  }
  if (status === 429 || code === 'rate_limited') {
    return { kind: 'rate', title: 'Too many requests', text: 'Wait a minute and try again.' };
  }
  if (status >= 500 || code === 'server_error') {
    return {
      kind: 'server',
      title: 'The server had a problem',
      text: message || 'Try again in a moment.'
    };
  }
  return {
    kind: 'other',
    title: 'Could not open the document',
    text: message || 'Something went wrong. Try again.'
  };
}

// ---------- reading the bundle ----------

function rowsOf(bundle) {
  const rows = bundle && Array.isArray(bundle.records) ? bundle.records : [];
  return rows.filter((row) => isObject(row) && isObject(row.record));
}

function nameOf(bundle, keyId) {
  const ids = bundle && isObject(bundle.identities) ? bundle.identities : {};
  const entry = typeof keyId === 'string' && Object.prototype.hasOwnProperty.call(ids, keyId) ? ids[keyId] : null;
  return entry && typeof entry.displayName === 'string' ? entry.displayName : '';
}

const TYPE_LABELS = { 'doc.create': 'Created', 'doc.update': 'Updated', 'doc.revoke': 'Revoked' };

// Newest first. Each item is plain data for display.
export function timelineOf(bundle) {
  const rows = rowsOf(bundle);
  const items = rows.map((row, index) => {
    const r = row.record;
    return {
      version: Number.isSafeInteger(r.version) ? r.version : 0,
      type: typeof r.type === 'string' ? r.type : '',
      typeLabel: TYPE_LABELS[r.type] || 'Unknown',
      label: typeof r.label === 'string' ? r.label : '',
      reason: typeof r.reason === 'string' ? r.reason : '',
      signer: typeof r.signer === 'string' ? r.signer : '',
      signerName: nameOf(bundle, r.signer),
      createdAt: Number.isFinite(r.createdAt) ? r.createdAt : null,
      recordHash: typeof row.recordHash === 'string' ? row.recordHash : '',
      blobHash: isObject(r.blob) && typeof r.blob.hash === 'string' ? r.blob.hash : '',
      blobSize: isObject(r.blob) && Number.isFinite(r.blob.size) ? r.blob.size : null,
      ledgerSeq: Number.isSafeInteger(row.ledgerSeq) ? row.ledgerSeq : null,
      ledgerHash: typeof row.ledgerHash === 'string' ? row.ledgerHash : '',
      isHead: index === rows.length - 1
    };
  });
  return items.reverse();
}

// The revoke reason when the last signed entry is a revoke, else ''.
export function revokeReason(bundle) {
  const rows = rowsOf(bundle);
  const last = rows.length > 0 ? rows[rows.length - 1].record : null;
  return last && last.type === 'doc.revoke' && typeof last.reason === 'string' ? last.reason : '';
}

// The time the server signed the checkpoint that anchors this answer, or null.
export function checkpointTime(bundle) {
  if (!bundle) return null;
  const a = isObject(bundle.headCheckpoint) && isObject(bundle.headCheckpoint.payload) ? bundle.headCheckpoint.payload.signedAt : null;
  const b = isObject(bundle.checkpoint) && isObject(bundle.checkpoint.payload) ? bundle.checkpoint.payload.signedAt : null;
  if (Number.isFinite(a)) return a;
  if (Number.isFinite(b)) return b;
  return null;
}

export function failedChecks(verification) {
  const checks = verification && Array.isArray(verification.checks) ? verification.checks : [];
  return checks.filter((c) => c && c.ok === false);
}

// Status badge: { key, label, tone }. The wording says when the status is not confirmed.
export function statusOf(verification) {
  const status = verification && verification.status;
  const ok = verification && verification.ok === true;
  if (status === 'active') {
    return ok
      ? { key: 'active', label: 'Active', tone: 'good' }
      : { key: 'active', label: 'Active, not confirmed', tone: 'warn' };
  }
  if (status === 'revoked') {
    return ok
      ? { key: 'revoked', label: 'Revoked', tone: 'warn' }
      : { key: 'revoked', label: 'Revoked, not confirmed', tone: 'bad' };
  }
  return { key: 'invalid', label: 'Not verified', tone: 'bad' };
}

// A plain sentence about the result, shown under the verification banner.
// Returns { tone, text }.
export function verdictSentence(verification, { pinned = false, bundle = null } = {}) {
  if (!verification || typeof verification !== 'object') {
    return { tone: 'bad', text: 'No verification result is available.' };
  }
  const failed = failedChecks(verification);
  const when = checkpointTime(bundle);
  const whenText = when === null ? 'the time of its checkpoint' : formatTime(when);
  const head = verification.head;
  const version = head && Number.isFinite(head.version) ? head.version : null;

  if (verification.ok !== true) {
    const names = failed.map((c) => CHECK_NAMES[c.id] || String(c.id).replace(/_/g, ' '));
    const list = names.length > 0 ? ' Failed: ' + names.join(', ') + '.' : '';
    return {
      tone: 'bad',
      text:
        'This document did not pass verification.' +
        list +
        ' Do not treat what is shown here as the latest signed version. ' +
        LATEST_MEANING
    };
  }
  const pinText = pinned
    ? ' The checkpoint was checked against the server key you pinned.'
    : ' The server key is not pinned, so this does not prove the answer came from the server you expect.';
  if (verification.status === 'revoked') {
    return {
      tone: 'warn',
      text:
        'The owner revoked this document. The signatures and version chain check out, and nothing can follow the revoke.' +
        pinText +
        ' ' +
        LATEST_MEANING
    };
  }
  if (verification.anchored === false) {
    return {
      tone: 'warn',
      text:
        'Signatures and the version chain check out, but these records are not tied to the server head, so a newer version could exist. ' +
        LATEST_MEANING
    };
  }
  return {
    tone: 'good',
    text:
      'Checked in this browser: every version is signed by the owner key, the versions link in order' +
      (version === null ? '' : `, and the server confirmed version ${version} as the latest at ${whenText}`) +
      '.' +
      pinText +
      ' ' +
      LATEST_MEANING
  };
}

// ---------- unlock checklist ----------

// Rows for the "unlock and verify" checklist. state: ok, bad, todo or skip.
export function unlockSteps(result, { revoked = false } = {}) {
  const blob = result && result.blobCheck ? result.blobCheck : null;
  const pt = result && result.plaintextCheck ? result.plaintextCheck : null;
  const fingerprint = result && typeof result.fingerprint === 'string' ? result.fingerprint : '';
  const rows = [];

  if (blob) {
    rows.push({
      id: 'blob',
      label: 'Locked file hash matches the signed record',
      state: blob.ok ? 'ok' : 'bad',
      detail: blob.detail || ''
    });
  } else {
    rows.push({
      id: 'blob',
      label: 'Locked file hash matches the signed record',
      state: revoked ? 'skip' : 'todo',
      detail: revoked ? 'A revoked document has no current file.' : ''
    });
  }

  if (fingerprint) {
    rows.push({ id: 'password', label: 'Password accepted', state: 'ok', detail: '' });
  } else if (pt && blob && blob.ok) {
    rows.push({ id: 'password', label: 'Password accepted', state: 'bad', detail: pt.detail || 'the password was not accepted' });
  } else if (pt) {
    rows.push({ id: 'password', label: 'Password accepted', state: 'skip', detail: 'Not tried, the file did not match the signed hash.' });
  } else {
    rows.push({ id: 'password', label: 'Password accepted', state: 'todo', detail: '' });
  }

  if (fingerprint) {
    rows.push({ id: 'fingerprint', label: 'Fingerprint of the original file (SHA-256)', state: 'ok', detail: fingerprint });
  } else {
    rows.push({ id: 'fingerprint', label: 'Fingerprint of the original file (SHA-256)', state: pt ? 'skip' : 'todo', detail: '' });
  }

  if (fingerprint && pt) {
    rows.push({
      id: 'commitment',
      label: 'Fingerprint matches the commitment in the signed record',
      state: pt.ok ? 'ok' : 'bad',
      detail: pt.detail || ''
    });
  } else {
    rows.push({
      id: 'commitment',
      label: 'Fingerprint matches the commitment in the signed record',
      state: pt ? 'skip' : 'todo',
      detail: ''
    });
  }
  return rows;
}

// ---------- owner ----------

// Owner tools need the key to be the owner, a verified bundle and an active document.
export function ownerAccess({ identity, bundle, verification }) {
  const keyId = identity && typeof identity.keyId === 'string' ? identity.keyId : '';
  const owner = bundle && isObject(bundle.document) && typeof bundle.document.ownerKeyId === 'string' ? bundle.document.ownerKeyId : '';
  const signer = verification && verification.head && typeof verification.head.signer === 'string' ? verification.head.signer : '';
  const isOwner = keyId !== '' && keyId === owner && (signer === '' || signer === owner);
  if (!isOwner) return { isOwner: false, allowed: false, reason: '' };
  if (!verification || verification.ok !== true) {
    return { isOwner: true, allowed: false, reason: 'The document did not pass verification, so new versions cannot be added from here.' };
  }
  if (verification.status !== 'active') {
    return { isOwner: true, allowed: false, reason: 'This document is revoked. Nothing can be added after a revoke.' };
  }
  const head = verification.head;
  if (!head || !Number.isSafeInteger(head.version) || !isHex(head.recordHash, 64)) {
    return { isOwner: true, allowed: false, reason: 'The current version could not be read.' };
  }
  return { isOwner: true, allowed: true, reason: '', head: { version: head.version, recordHash: head.recordHash } };
}

// Returns a message when the new version form is not ready, else ''.
export function versionProblem({ file, label, mode, reusePassword, freshSaved }) {
  if (!file) return 'Choose the new file.';
  if (!Number.isFinite(file.size) || file.size < 1) return 'The file is empty.';
  if (file.size > MAX_FILE_BYTES) return `The file is too large (${formatBytes(file.size)}). The limit is 50 MiB.`;
  if (typeof file.name !== 'string' || file.name.trim() === '') return 'The file has no name.';
  if (codePoints(label) > LABEL_MAX) return `The label is too long (${LABEL_MAX} characters at most).`;
  if (mode === 'fresh') {
    if (!freshSaved) return 'Confirm that you saved the new password.';
  } else if (!reusePassword) {
    return 'Unlock the file above first so the document password is confirmed, or choose a new password.';
  }
  return '';
}

// Returns a message when the revoke form is not ready, else ''.
export function revokeProblem({ reason, typed }) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text === '') return 'Write the reason for the revoke.';
  if (codePoints(text) > REASON_MAX) return `The reason is too long (${REASON_MAX} characters at most).`;
  if (typeof typed !== 'string' || typed.trim() !== REVOKE_WORD) return `Type ${REVOKE_WORD} to confirm.`;
  return '';
}

// ---------- passwords and links ----------

function group(normalized) {
  return PASSWORD_ALPHABET.test(normalized) ? normalized.match(/.{4}/g).join('-') : normalized;
}

// Cleans pasted or typed text into a password: a full link is read for its #k= part, spaces, dashes
// and case are dropped, and a standard 20 character password is shown in groups of four.
export function tidyPassword(text) {
  if (typeof text !== 'string') return '';
  const at = text.indexOf('#k=');
  if (at >= 0) {
    // a link without a usable password gives nothing, never the link text itself
    const fromLink = parseFragment(text.slice(at));
    return fromLink ? group(fromLink) : '';
  }
  return group(normalizePassword(text));
}

export function hasPassword(text) {
  return typeof text === 'string' && normalizePassword(text) !== '';
}

// Makes a name from inside a locked file safe to use as a download name.
export function safeFileName(name) {
  let text = typeof name === 'string' ? name.normalize('NFC') : '';
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '');
  text = text.replace(/[\\/:*?"<>|]/g, '_');
  text = text.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  const chars = Array.from(text);
  if (chars.length > 120) text = chars.slice(0, 120).join('');
  return text === '' ? 'document' : text;
}

// ---------- export and certificate ----------

export function exportBundle(bundle, pinnedServerKeyId, now = Date.now()) {
  return {
    kind: BUNDLE_KIND,
    v: 1,
    savedAt: now,
    savedAtText: new Date(now).toISOString(),
    pinnedServerKeyId: pinnedServerKeyId ? pinnedServerKeyId : null,
    bundle
  };
}

export function exportBundleName(docId, headVersion) {
  const id = typeof docId === 'string' ? docId.slice(0, 12) : 'document';
  return `hrdlock-${id}-v${Number.isFinite(headVersion) ? headVersion : 0}.json`;
}

export function passwordFileText(docId, password) {
  return [
    'hrdlock document password',
    '',
    `Document id: ${docId}`,
    `Password: ${password}`,
    '',
    'Keep this file private. Anyone with the password and the locked file can read the document.',
    ''
  ].join('\n');
}

// Everything the printed certificate shows, as plain data.
export function certificateData({ bundle, verification, pinnedServerKeyId = '', now = Date.now() }) {
  const doc = bundle && isObject(bundle.document) ? bundle.document : {};
  const head = verification && verification.head ? verification.head : null;
  const server = bundle && isObject(bundle.server) ? bundle.server : null;
  const cp = bundle && isObject(bundle.checkpoint) && isObject(bundle.checkpoint.payload) ? bundle.checkpoint.payload : null;
  const hcp = bundle && isObject(bundle.headCheckpoint) && isObject(bundle.headCheckpoint.payload) ? bundle.headCheckpoint.payload : null;
  const status = statusOf(verification);
  const failed = failedChecks(verification).map((c) => ({ id: c.id, detail: c.detail || '' }));
  const ok = !!verification && verification.ok === true;
  return {
    docId: typeof doc.docId === 'string' ? doc.docId : '',
    status: status.label,
    reason: revokeReason(bundle),
    headVersion: head ? head.version : null,
    headRecordHash: head ? head.recordHash : '',
    headBlobHash: head && head.blobHash ? head.blobHash : '',
    label: head ? head.label || '' : '',
    signerName: head ? head.signerName || '' : '',
    signerKeyId: head ? head.signer || '' : '',
    signedAt: head ? head.createdAt : null,
    serverKeyId: server && typeof server.keyId === 'string' ? server.keyId : '',
    pinned: !!pinnedServerKeyId && !!server && server.keyId === pinnedServerKeyId,
    pinnedServerKeyId: pinnedServerKeyId || '',
    ledgerCheckpoint: cp ? { seq: cp.seq, hash: cp.hash, signedAt: cp.signedAt } : null,
    headCheckpoint: hcp ? { seq: hcp.seq, hash: hcp.hash, signedAt: hcp.signedAt } : null,
    anchored: !!verification && verification.anchored === true,
    ok,
    resultText: ok ? 'Passed all checks' : 'DID NOT PASS verification',
    failed,
    checkedAt: now,
    limits: LIMITS_SENTENCE,
    latest: LATEST_MEANING
  };
}
