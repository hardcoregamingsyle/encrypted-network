// Pure helpers for the file page (route /d/:docId). No React, no DOM, no network, so they run in Node tests.
// The checks themselves live in docLogic.js and shared/verify.js. This file only decides what to show.
import { isHex } from '../../../shared/encoding.js';
import { formatClock, formatShortDate, relativeDay, textOf } from '../../lib/format.js';
import { fullLink, parseFragment, verifyLink } from '../../lib/links.js';
import { ROLLBACK_LINE } from '../../lib/trust.js';
import { REASON_MAX, hasPassword, tidyPassword, timelineOf } from './docLogic.js';

// ---------- title and state ----------

// The name of the file: the label of the newest version that has one. A withdrawn file keeps its last label.
export function fileTitle(bundle, verification) {
  const head = verification && verification.head ? verification.head : null;
  if (head && typeof head.label === 'string' && head.label.trim() !== '') return head.label.trim();
  for (const item of timelineOf(bundle)) {
    if (item.label.trim() !== '') return item.label.trim();
  }
  return 'File';
}

// 'withdrawn' | 'verified' | 'unverified'. Only the checks decide, the server's word about the status does not.
export function fileState(verification) {
  if (!verification || verification.ok !== true) return 'unverified';
  return verification.status === 'revoked' ? 'withdrawn' : 'verified';
}

// A warning for the top of the page when this answer is older than one this browser saw before.
export function rollbackNote(verification) {
  if (!verification || verification.rollback !== true) return '';
  return ROLLBACK_LINE;
}

// ---------- versions ----------

// "today 10:02", "yesterday 18:30", "9 Oct, 10:02"
export function versionStamp(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return 'time unknown';
  const day = relativeDay(ms, now);
  const clock = formatClock(ms);
  if (day === 'today' || day === 'yesterday') return `${day} ${clock}`;
  return `${formatShortDate(ms, now)}, ${clock}`;
}

// The versions list, newest first: "Version 2, Priya, today 10:02".
export function versionRows(bundle, now = Date.now()) {
  return timelineOf(bundle).map((item) => {
    const withdrawn = item.type === 'doc.revoke';
    const who = textOf(item.signerName).trim() || 'Unknown signer';
    const title = withdrawn ? 'Withdrawn' : `Version ${item.version}`;
    return {
      key: `${item.version}:${item.recordHash}`,
      version: item.version,
      withdrawn,
      isHead: item.isHead,
      title,
      who,
      when: versionStamp(item.createdAt, now),
      line: `${title}, ${who}, ${versionStamp(item.createdAt, now)}`,
      label: item.label,
      reason: item.reason
    };
  });
}

// ---------- the file password and the Open button ----------

// The password text from a box or a pasted link, or '' when there is none.
export function passwordFromInput(text) {
  const clean = tidyPassword(text);
  return hasPassword(clean) ? clean : '';
}

// A sentence when the one line prompt cannot be used yet, else ''.
export function promptProblem(text) {
  return passwordFromInput(text) === '' ? 'Enter the file password or paste the full link.' : '';
}

// What the Open file button does.
//   none      nothing to open (withdrawn, or no locked file was found)
//   ready     the file is unlocked and checked, open it
//   ask       ask for the password (or fetch the owner's from the vault)
//   wrong     a password was tried and did not work
//   broken    the locked file does not match what the owner signed, so it is not unlocked
export function openPlan({ result, revoked = false }) {
  if (revoked) return { kind: 'none', text: 'This file was withdrawn, so there is nothing to open.' };
  if (!result) return { kind: 'none', text: '' };
  if (result.file) return { kind: 'ready', text: '' };
  const blob = result.blobCheck;
  if (!blob) return { kind: 'none', text: 'The locked file could not be found.' };
  if (blob.ok !== true) return { kind: 'broken', text: 'The locked file does not match what the owner signed, so it was not opened.' };
  const pt = result.plaintextCheck;
  if (pt && pt.ok !== true) {
    return typeof result.fingerprint === 'string' && result.fingerprint !== ''
      ? { kind: 'broken', text: 'The file does not match what the owner signed, so it was not opened.' }
      : { kind: 'wrong', text: 'That password did not work. Check it and try again.' };
  }
  return { kind: 'ask', text: '' };
}

// The words on the Open button. A file that did not pass the checks is never offered plainly.
export function openLabel({ verified, kind }) {
  if (kind === 'ready') return verified ? 'Open file' : 'Open anyway, not verified';
  return 'Open file';
}

// ---------- sharing ----------

// The link to share. With a password it also opens the file, without one it only lets people check it.
export function sharePlan({ docId, password }) {
  const pw = hasPassword(password) ? password : '';
  return { link: pw ? fullLink(docId, pw) : verifyLink(docId), withPassword: pw !== '' };
}

// ---------- owner tools ----------

// A line for someone signed in whose account owns the file through another key.
// keys is session.keys: [{ keyId }]. access is the result of ownerAccess().
export function ownerNote({ identity, keys, bundle, access }) {
  if (access && access.isOwner) return '';
  const owner = bundle && bundle.document && typeof bundle.document.ownerKeyId === 'string' ? bundle.document.ownerKeyId : '';
  const mine = Array.isArray(keys) ? keys.some((k) => k && k.keyId === owner) : false;
  const own = identity && typeof identity.keyId === 'string' ? identity.keyId : '';
  if (owner && mine && own !== owner) {
    return 'This file belongs to another key of your account. You can only update or withdraw it on the device that holds that key.';
  }
  return '';
}

// Why the update form cannot go yet, else ''. password is what will lock the new file.
export function updateProblem({ file, password }) {
  if (!file) return 'Choose the new file.';
  if (!Number.isFinite(file.size) || file.size < 1) return 'The file is empty.';
  if (!hasPassword(password)) return 'Enter the file password or paste the full link.';
  return '';
}

// Why the withdraw form cannot go yet, else ''.
export function withdrawProblem({ reason, confirmed }) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text === '') return 'Write a short reason. Everyone who opens the file can read it.';
  if (Array.from(text).length > REASON_MAX) return `The reason is too long (${REASON_MAX} characters at most).`;
  if (confirmed !== true) return 'Tick the box to confirm.';
  return '';
}

// The next head to publish after, only when it is a usable one.
export function validHead(head) {
  return Boolean(head) && Number.isSafeInteger(head.version) && head.version >= 1 && isHex(head.recordHash, 64);
}

// ---------- which password to try ----------

// The password for the first load. A password in the link wins. Without one, a signed in person's own
// saved copy is tried (the vault gives null for a file that is not theirs). A failing vault is ignored,
// the file then simply asks for the password. Returns '' when there is none.
//   fragment    the part of the address after the #
//   signedIn    only a signed in person has a saved copy
//   getStored   async (docId) -> password or null
export async function initialPassword({ docId, fragment, signedIn, getStored }) {
  const fromLink = parseFragment(fragment) || '';
  if (fromLink) return { password: tidyPassword(fromLink), fromLink: true };
  if (!signedIn || typeof getStored !== 'function') return { password: '', fromLink: false };
  try {
    const stored = await getStored(docId);
    return { password: typeof stored === 'string' && stored ? tidyPassword(stored) : '', fromLink: false };
  } catch {
    return { password: '', fromLink: false };
  }
}

// The password a shared link should carry: the one that opened the file here, or for the owner their own
// saved copy. A visitor who never unlocked the file shares the verify-only link.
export async function sharePassword({ docId, unlockedWith, isOwner, getStored }) {
  if (typeof unlockedWith === 'string' && unlockedWith) return unlockedWith;
  if (!isOwner || typeof getStored !== 'function') return '';
  try {
    const stored = await getStored(docId);
    return typeof stored === 'string' ? stored : '';
  } catch {
    return '';
  }
}

// The toast after an update was accepted. info is { version, fresh, stored } from the update form.
// A password that could not be saved is a warning, because the link is then the only copy.
export function updateToast(info) {
  const version = info && Number.isInteger(info.version) ? info.version : 0;
  const text = version > 0 ? `Version ${version} is published.` : 'The new version is published.';
  if (info && info.stored === 'none') {
    return { tone: 'warn', text: text + ' The password could not be saved here, so copy the link from Share now.' };
  }
  return { tone: 'good', text: text + (info && info.fresh ? ' The file now uses a new password.' : '') };
}
