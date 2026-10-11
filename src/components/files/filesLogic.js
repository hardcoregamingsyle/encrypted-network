// Pure helpers for the Files screen. No React, no DOM, no network, so they run in Node tests.
import { fileIconName, fileKind, textOf, versionLine } from '../../lib/format.js';
import { getSeenHead } from '../../lib/headStore.js';

export const TABS = Object.freeze([
  { id: 'mine', label: 'Mine' },
  { id: 'public', label: 'Public' },
  { id: 'private', label: 'Private' }
]);

// The tab comes from the address (?tab=public or ?tab=private). Anything else is Mine.
export function tabFromSearch(value) {
  return value === 'public' || value === 'private' ? value : 'mine';
}

export const UNTITLED = 'Untitled file';

// What a row is called. The label is the only name the server knows.
export function rowTitle(row) {
  const label = row && typeof row.label === 'string' ? row.label.trim() : '';
  return label === '' ? UNTITLED : label;
}

// The icon of a row, chosen by the extension at the end of its label.
export function rowIcon(row) {
  return fileIconName(fileKind(row && typeof row.label === 'string' ? row.label.trim() : ''));
}

// "Version 3, edited today". A document that this browser remembers but could not be looked up yet
// has no version, so the line says what is known instead of guessing a number.
export function rowSubtitle(row, now = Date.now()) {
  if (!row) return '';
  if (row.status === 'missing') return 'Not found on this server';
  if (row.status === 'unknown') return 'Could not check right now';
  if (row.status === 'checking' || !Number.isSafeInteger(row.version) || row.version < 1) {
    return row.status === 'checking' ? 'Checking' : 'Version not known';
  }
  const updated = Number.isFinite(row.updatedAt) ? row.updatedAt : null;
  if (updated === null) return `Version ${row.version}`;
  const line = versionLine(row.version, updated, now);
  return row.approxTime ? line.replace(', edited', ', published') : line;
}

// The line under the title on the public list: who published it, then the version line.
export function publicSubtitle(row, now = Date.now()) {
  const who = textOf(row && row.ownerName).trim();
  const line = rowSubtitle(row, now);
  return who ? `${who}, ${line}` : line;
}

// The chip at the right of a row.
//   Verified    only when this browser opened this exact version before and every check passed then
//   Withdrawn   the owner withdrew the file
//   Not checked yet   listed by the server, not checked by this browser yet (open the file to check it)
// The list comes from the server and is not signature checked, so it never claims more than that.
export function statusChip(row, seen = null) {
  const status = row && row.status;
  if (status === 'revoked') return { tone: 'warn', icon: 'x', text: 'Withdrawn', hint: 'The owner withdrew this file.' };
  if (status === 'missing') return { tone: 'warn', icon: 'warn', text: 'Not found', hint: 'The server does not have this file.' };
  if (status === 'unknown') return { tone: 'warn', icon: 'warn', text: 'Unknown', hint: 'Could not check this file right now.' };
  if (status === 'checking') return { tone: 'info', icon: 'clock', text: 'Checking', hint: '' };
  if (seen && Number.isSafeInteger(row.version) && seen.version === row.version) {
    return { tone: 'good', icon: 'shield-check', text: 'Verified', hint: 'This browser checked this version when you last opened it.' };
  }
  return { tone: 'info', icon: 'info', text: 'Not checked yet', hint: 'Listed by the server. Open the file to check it.' };
}

// The head this browser remembers for a row, or null.
export function seenFor(row) {
  try {
    return row && typeof row.docId === 'string' ? getSeenHead(row.docId) : null;
  } catch {
    return null;
  }
}

// A row of the public list (GET /api/documents). Every field comes from the server.
export function publicRow(d) {
  return {
    docId: textOf(d && d.docId),
    label: textOf(d && d.label),
    status: d && d.status === 'revoked' ? 'revoked' : 'active',
    version: d && Number.isFinite(d.headVersion) ? d.headVersion : null,
    updatedAt: d && Number.isFinite(d.updatedAt) ? d.updatedAt : null,
    approxTime: false,
    ownerKeyId: textOf(d && d.ownerKeyId),
    ownerName: textOf(d && d.ownerName),
    listed: true,
    local: false
  };
}

// A row of "my files" for an account (GET /api/me/documents). Same shape plus whether it is listed.
export function accountRow(d) {
  return { ...publicRow(d), listed: !!(d && d.listed) };
}

// Drops rows without a usable id, so a broken answer cannot make a link to nowhere.
export function usableRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && /^[0-9a-f]{32}$/.test(r.docId));
}

// The empty message for a list.
export function emptyCopy(tab, { searching = false } = {}) {
  if (tab === 'public') {
    return searching
      ? { title: 'Nothing matches that search', text: 'Try fewer or different words. Only the labels of public files are searched.' }
      : { title: 'No public files yet', text: 'When someone makes a file public it shows up here.' };
  }
  return { title: 'No files yet', text: 'Tap Add file to publish your first one. Your link is ready in a moment.' };
}

// The line a screen reader hears when a list finishes loading.
export function listSummary(count, { searching = false } = {}) {
  if (count === 0) return searching ? 'No files found' : 'No files';
  return `${count} ${count === 1 ? 'file' : 'files'} shown`;
}
