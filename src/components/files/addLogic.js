// Pure helpers for the Add file sheet.
import { fileProblem, labelProblem, normalizeLabel } from '../vault/vaultLogic.js';

// One short line at a time while a file is published.
export const PROGRESS_LINES = Object.freeze({
  read: 'Reading your file',
  derive: 'Locking your file',
  lock: 'Locking your file',
  upload: 'Uploading',
  sign: 'Signing',
  publish: 'Publishing'
});

// steps is the list runPublish keeps: [{ id, status: 'pending' | 'active' | 'done' | 'error' }].
export function progressLine(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0 || list.some((s) => s.status === 'error')) return '';
  const active = list.find((s) => s.status === 'active');
  if (active) return PROGRESS_LINES[active.id] || 'Working';
  if (list.every((s) => s.status === 'done')) return 'Published';
  const next = list.find((s) => s.status === 'pending');
  const anyDone = list.some((s) => s.status === 'done');
  return anyDone && next ? PROGRESS_LINES[next.id] || 'Working' : 'Starting';
}

// The label that will be published. It starts as the file name and stays editable.
export function labelFor({ labelText, touched, fileName }) {
  return normalizeLabel(touched ? labelText : fileName);
}

// The first thing that stops the Publish button, as a sentence, or ''.
export function addProblem({ file, label }) {
  if (!file) return '';
  return fileProblem(file) || labelProblem(label) || '';
}

export function canPublish({ file, label, running }) {
  return Boolean(file) && !running && addProblem({ file, label }) === '';
}

// What the result screen says about where the file password went.
//   account  stored encrypted in the account
//   device   stored on this device only
//   none     could not be stored: the link is the only copy
export function storedNote(stored) {
  if (stored === 'account') return { tone: 'good', text: 'Your file password is saved in your account. It is also kept inside the link.' };
  if (stored === 'device') return { tone: 'info', text: 'Your file password is saved on this device only. It is also kept inside the link.' };
  return {
    tone: 'warn',
    text: 'The file password could not be saved here. It is kept inside the link, so copy the link now: it is the only copy.'
  };
}

// One short sentence for a failed publish. friendlyError and recoveryHint already give the details.
export function failureText(failure) {
  if (!failure) return '';
  const message = typeof failure.message === 'string' ? failure.message : '';
  const hint = typeof failure.hint === 'string' ? failure.hint : '';
  return hint && message !== hint ? `${message} ${hint}` : message;
}
