// Pure helpers for the Vault page. No React, no DOM, so they can be tested in Node.
import { LIMITS, ZERO_HASH, validateRecord } from '../../../shared/records.js';
import { overLimitText } from '../../lib/format.js';
import { outcomeUnknown } from '../../lib/outcome.js';

export const MAX_FILE_BYTES = LIMITS.MAX_FILE_BYTES;
export const LABEL_MAX = LIMITS.LABEL_MAX;
export const SEARCH_MAX = 100;
export const PAGE_SIZE = 25;
export const SEARCH_DELAY_MS = 350;
export const MAX_LOCAL_HEAD_LOOKUPS = 30;

// ---------- file and label ----------

// Returns an error sentence, or '' when the file can be published.
export function fileProblem(file) {
  if (!file || typeof file.name !== 'string') return 'Choose a file first.';
  if (file.name.trim() === '') return 'The file has no name.';
  if (!Number.isFinite(file.size)) return 'The size of the file is not known.';
  if (file.size < 1) return 'The file is empty. Choose a file that has content.';
  if (file.size > MAX_FILE_BYTES) {
    return `The file is ${overLimitText(file.size, MAX_FILE_BYTES)}.`;
  }
  return '';
}

// Text of the label as it would be stored: trimmed, NFC, at most 120 code points.
export function normalizeLabel(text) {
  const s = typeof text === 'string' ? text.trim().normalize('NFC') : '';
  return Array.from(s).slice(0, LABEL_MAX).join('');
}

// The label that is published.
// labelText is what is in the label box, fileName is the chosen file.
// With hideName on, a label that is the file name is not published.
export function effectiveLabel({ labelText, fileName, hideName }) {
  const label = normalizeLabel(labelText);
  const name = normalizeLabel(fileName);
  if (hideName && (label === name || label === '')) return '';
  return label;
}

// What the label box holds when the person has not typed anything.
export function suggestedLabel({ fileName, hideName }) {
  return hideName ? '' : normalizeLabel(fileName);
}

// Asks the shared record rules whether this label is allowed. Returns '' or a sentence.
export function labelProblem(label) {
  const probe = {
    v: 2,
    type: 'doc.create',
    docId: '0'.repeat(32),
    version: 1,
    prev: ZERO_HASH,
    signer: '0'.repeat(64),
    createdAt: 1,
    label,
    listed: false,
    blob: { hash: '0'.repeat(64), size: 1, suite: 1 },
    commitment: '0'.repeat(64)
  };
  const v = validateRecord(probe);
  if (v.ok) return '';
  if (/label/.test(v.error || '')) {
    return 'The label has characters that are not allowed (for example invisible or control characters). Edit the label.';
  }
  return '';
}

export function displayLabel(label) {
  return typeof label === 'string' && label.trim() !== '' ? label : 'Untitled document';
}

// ---------- progress steps ----------

export const STEP_DEFS = Object.freeze([
  { id: 'read', label: 'Read the file' },
  { id: 'derive', label: 'Derive the key', hint: 'This takes a moment on purpose.' },
  { id: 'lock', label: 'Lock the file' },
  { id: 'upload', label: 'Upload the locked file' },
  { id: 'sign', label: 'Sign the record' },
  { id: 'publish', label: 'Publish the record' }
]);

// Events that report that a step has finished, the others report that a step has started.
const FINISHED_EVENTS = new Set(['lock']);

export function createSteps() {
  return STEP_DEFS.map((d) => ({ id: d.id, label: d.label, hint: d.hint || '', status: 'pending' }));
}

// Returns a new steps array after the event. Unknown events change nothing.
export function advanceSteps(steps, id) {
  if (id === 'done') return steps.map((s) => ({ ...s, status: 'done' }));
  const at = steps.findIndex((s) => s.id === id);
  if (at < 0) return steps;
  return steps.map((s, i) => {
    if (i < at) return { ...s, status: 'done' };
    if (i === at) return { ...s, status: FINISHED_EVENTS.has(id) ? 'done' : 'active' };
    return s;
  });
}

// Marks the step that was running as failed. If none was running, the first one not done.
export function failSteps(steps) {
  let at = steps.findIndex((s) => s.status === 'active');
  if (at < 0) at = steps.findIndex((s) => s.status !== 'done');
  if (at < 0) return steps;
  return steps.map((s, i) => (i === at ? { ...s, status: 'error' } : s));
}

export function failedStepId(steps) {
  const s = steps.find((x) => x.status === 'error');
  return s ? s.id : '';
}

export function doneCount(steps) {
  return steps.filter((s) => s.status === 'done').length;
}

// ---------- errors ----------

// A short sentence a person can act on. err can be anything that was thrown. stepId is the step that
// was running. A lost answer or a server error at the publish step does not tell whether the server
// stored the record, so those say so and never claim that nothing was published.
export function friendlyError(err, stepId = '') {
  const code = err && typeof err.code === 'string' ? err.code : '';
  const message = err && typeof err.message === 'string' && err.message ? err.message : '';
  const saving = stepId === 'sign' || stepId === 'publish';
  switch (code) {
    case 'network':
      return saving
        ? 'The connection failed while the record was being sent, so it is not known whether the server saved it.'
        : 'Could not reach the server. Check your connection and try again.';
    case 'rate_limited':
      return 'You have published or uploaded too often in the last hour. Wait a while and try again.';
    case 'expired':
      return 'The server says the time on your device is more than a few minutes off. Fix the clock on your device and try again.';
    case 'unknown_signer':
      return 'The server does not know your key yet. Register your key and try again.';
    case 'too_large':
      return 'The server refused the file because it is too large, or your upload quota is used up.';
    case 'server_error':
      return saving
        ? 'The server had a problem while the record was being sent, so it is not known whether the server saved it.'
        : 'The server had a problem. Try again in a moment.';
    default:
      return message || 'Something went wrong. Try again.';
  }
}

// True when a failure at stepId leaves it unknown whether the server stored the signed record: no
// answer or a server error after the record was sent. A clear refusal (a 4xx answer) is not unknown.
export function outcomeIsUnknown(stepId, err) {
  return (stepId === 'publish' || stepId === 'sign') && outcomeUnknown(err);
}

// Tells what state things are in after a failure at stepId. Honest about what already happened.
// Publishing again reuses the same locked file, password, document id and signed record (see
// publishNewDocument), so a retry never makes a second document.
export function recoveryHint(stepId, err) {
  switch (stepId) {
    case 'read':
    case 'derive':
    case 'lock':
      return 'The file was not sent anywhere. Fix the problem and publish again.';
    case 'upload':
      return 'The upload did not finish and no record was sent. Publish again: the same locked file and password are used.';
    case 'sign':
    case 'publish':
      if (outcomeIsUnknown(stepId, err)) {
        return 'The server may already have saved the signed record, so the document may exist. Press the button again: the same document id, password and signed record are sent, and if the first try got through the server says so and nothing is duplicated. Check your documents list afterwards.';
      }
      return 'The server refused the record, so it was not published. The locked file may already be on the server. Fix the problem and publish again: the same password is used.';
    default:
      return 'Publish again. The same password and locked file are used if they were already made.';
  }
}

export function needsRegistration(err) {
  return !!err && err.code === 'unknown_signer';
}

// ---------- search ----------

export function normalizeQuery(text) {
  if (typeof text !== 'string') return '';
  return Array.from(text.normalize('NFC').replace(/\s+/g, ' ').trim()).slice(0, SEARCH_MAX).join('');
}

// ---------- document lists ----------

// Query for GET /api/documents. before is the updatedAt of the last row already shown.
export function listParams({ owner, q, before, beforeId, limit = PAGE_SIZE } = {}) {
  const p = { limit };
  if (owner) p.owner = owner;
  const query = normalizeQuery(q);
  if (query) p.q = query;
  if (Number.isFinite(before)) {
    p.before = before;
    // the document id breaks ties between documents with the same updatedAt
    if (typeof beforeId === 'string' && /^[0-9a-f]{32}$/.test(beforeId)) p.beforeId = beforeId;
  }
  return p;
}

// Adds a page to the rows already shown, without showing a document twice.
export function appendPage(rows, page) {
  const seen = new Set(rows.map((r) => r.docId));
  const out = rows.slice();
  for (const d of Array.isArray(page) ? page : []) {
    if (!d || typeof d.docId !== 'string' || seen.has(d.docId)) continue;
    seen.add(d.docId);
    out.push(d);
  }
  return out;
}

export function nextCursor(rows) {
  if (!rows.length) return undefined;
  const last = rows[rows.length - 1];
  return Number.isFinite(last.updatedAt) ? last.updatedAt : undefined;
}

// The document id of the last row, sent together with the updatedAt from nextCursor.
export function nextCursorId(rows) {
  if (!rows.length) return undefined;
  const last = rows[rows.length - 1];
  return typeof last.docId === 'string' ? last.docId : undefined;
}

// A full page means there may be more. A short page means this was the end.
export function hasMorePage(page, limit = PAGE_SIZE) {
  return Array.isArray(page) && page.length >= limit;
}

// One row in the "Your documents" list, built from a server list entry.
function fromServer(d) {
  return {
    docId: d.docId,
    label: typeof d.label === 'string' ? d.label : '',
    status: d.status === 'revoked' ? 'revoked' : 'active',
    version: Number.isFinite(d.headVersion) ? d.headVersion : null,
    updatedAt: Number.isFinite(d.updatedAt) ? d.updatedAt : null,
    approxTime: false,
    listed: true,
    local: false
  };
}

// Rows from the server list that name this key as the owner. A server can put any document in a
// list that is filtered by owner, so the owner is checked again here.
export function ownedBy(items, keyId) {
  if (typeof keyId !== 'string' || keyId === '' || !Array.isArray(items)) return [];
  return items.filter((d) => d && typeof d === 'object' && d.ownerKeyId === keyId);
}

// heads: { [docId]: { state:'ok', head } | { state:'missing' } | { state:'error' } }
// Server rows win. Local ids that the server list does not show are filled in from the document
// head (so unlisted documents show), or marked missing or unknown.
export function mergeDocuments(serverDocs, localDocs, heads = {}) {
  const rows = [];
  const seen = new Set();
  for (const d of Array.isArray(serverDocs) ? serverDocs : []) {
    if (!d || typeof d.docId !== 'string' || seen.has(d.docId)) continue;
    seen.add(d.docId);
    rows.push(fromServer(d));
  }
  for (const l of Array.isArray(localDocs) ? localDocs : []) {
    if (!l || typeof l.docId !== 'string' || seen.has(l.docId)) continue;
    seen.add(l.docId);
    const h = heads[l.docId];
    const base = {
      docId: l.docId,
      label: l.label || '',
      version: null,
      updatedAt: Number.isFinite(l.createdAt) && l.createdAt > 0 ? l.createdAt : null,
      approxTime: true,
      listed: false,
      local: true
    };
    if (h && h.state === 'ok' && h.head) {
      rows.push({
        ...base,
        status: h.head.status === 'revoked' ? 'revoked' : 'active',
        version: Number.isFinite(h.head.headVersion) ? h.head.headVersion : null
      });
    } else if (h && h.state === 'missing') {
      rows.push({ ...base, status: 'missing' });
    } else if (h && h.state === 'error') {
      rows.push({ ...base, status: 'unknown' });
    } else {
      rows.push({ ...base, status: 'checking' });
    }
  }
  return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Local ids that still need a head lookup, newest first, at most max.
export function idsToLookUp(serverDocs, localDocs, known = {}, max = MAX_LOCAL_HEAD_LOOKUPS) {
  const onServer = new Set((serverDocs || []).map((d) => d.docId));
  const out = [];
  for (const l of localDocs || []) {
    if (onServer.has(l.docId) || known[l.docId]) continue;
    out.push(l.docId);
    if (out.length >= max) break;
  }
  return out;
}

export function statusView(status) {
  switch (status) {
    case 'active':
      return { tone: 'good', text: 'Active' };
    case 'revoked':
      return { tone: 'bad', text: 'Revoked' };
    case 'missing':
      return { tone: 'warn', text: 'Not on the server' };
    case 'unknown':
      return { tone: 'warn', text: 'Could not check' };
    case 'checking':
      return { tone: 'info', text: 'Checking' };
    default:
      return { tone: 'info', text: String(status || 'Unknown') };
  }
}

// ---------- result of a publish ----------

// Text for the "save as text file" button. Contains the password, so the person must keep it safe.
export function buildSaveText({ docId, password, fingerprint, links, label, createdAt }) {
  const lines = [
    'hrdlock document',
    '================',
    '',
    `Label: ${label ? label : '(none)'}`,
    `Document id: ${docId}`,
    `Password: ${password}`,
    `Fingerprint (SHA-256 of the original file): ${fingerprint}`,
    '',
    'Verify-only link (no password, shows the signatures and the chain):',
    links.verify,
    '',
    'Full link (includes the password after the #, anyone with it can open the file):',
    links.full,
    ''
  ];
  if (Number.isFinite(createdAt)) lines.push(`Saved: ${new Date(createdAt).toISOString()}`, '');
  lines.push(
    'Keep this file private. The password cannot be recovered. If it is lost,',
    'the file cannot be unlocked by anyone, including the people who run the server.',
    ''
  );
  return lines.join('\n');
}

export function saveFileName(docId) {
  return `hrdlock-${String(docId).slice(0, 8)}.txt`;
}

// Route target for the "open the document" button. The password goes in the hash only.
export function documentRoute(docId, fullLinkText) {
  const text = typeof fullLinkText === 'string' ? fullLinkText : '';
  const at = text.indexOf('#');
  return { pathname: `/d/${docId}`, hash: at >= 0 ? text.slice(at) : '' };
}
