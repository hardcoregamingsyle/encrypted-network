// Publishing and opening documents in the browser.
// The file is locked here, the server only ever sees the locked bytes. Records are signed here
// with the identity key. Opening a document re-checks everything locally (signatures, chain,
// file hash, fingerprint) and never trusts the server's word.
import { hexToBytes, isHex } from '../../shared/encoding.js';
import { PUBLIC_COMMIT_SALT, sha256Hex } from '../../shared/hash.js';
import { compareWithSeen, nextSeenHead } from '../../shared/headMemory.js';
import { newDocId, recordHash as hashRecord, validateRecord, ZERO_HASH } from '../../shared/records.js';
import { verifyBlobBytes, verifyDocumentBundle, verifyPlaintext } from '../../shared/verify.js';
import { getBlob, getDocument, getViewable, postDocRecord, putBlob } from './api.js';
import { lockInWorker, unlockInWorker } from './cipherClient.js';
import { getSeenHead, setSeenHead } from './headStore.js';
import { fullLink, verifyLink } from './links.js';
import { forgetDoc, rememberDoc } from './localDocs.js';
import { outcomeUnknown } from './outcome.js';
import { generatePassword, normalizePassword } from './lockfile.js';

const MAX_FILE_BYTES = 20971520;
const MAX_LABEL = 120;

function step(onStep, id, text) {
  if (typeof onStep !== 'function') return;
  try {
    onStep(id, text);
  } catch {
    // a broken progress callback must not stop a publish
  }
}

function needIdentity(identity) {
  if (!identity || typeof identity.keyId !== 'string' || typeof identity.sign !== 'function') {
    throw new Error('create or restore an identity first');
  }
}

function needHead(head) {
  if (!head || !Number.isSafeInteger(head.version) || head.version < 1 || !isHex(head.recordHash, 64)) {
    throw new Error('the current version of the document is not known');
  }
}

function needDocId(docId) {
  if (!isHex(docId, 32)) throw new Error('document id is not valid');
}

function tidyText(text) {
  return typeof text === 'string' ? text.trim().normalize('NFC') : '';
}

function defaultLabel(name) {
  return Array.from(name.normalize('NFC')).slice(0, MAX_LABEL).join('');
}

function checkRecord(record) {
  const v = validateRecord(record);
  if (!v.ok) throw new Error('record is not valid: ' + v.error);
}

// The password of a file its owner opened for everyone ("viewable"), or '' when it is not.
async function viewablePassword(docId) {
  try {
    const v = await getViewable(docId);
    return v && v.viewable === true && typeof v.password === 'string' ? v.password : '';
  } catch {
    return '';
  }
}

// Reads and validates the chosen file. Returns { name, data }.
async function readFile(file, onStep) {
  if (!file || typeof file.name !== 'string' || typeof file.arrayBuffer !== 'function') {
    throw new Error('choose a file first');
  }
  const name = file.name.trim();
  if (name === '') throw new Error('the file has no name');
  if (Number.isFinite(file.size)) {
    if (file.size < 1) throw new Error('the file is empty');
    if (file.size > MAX_FILE_BYTES) throw new Error('file is too large (20 MiB limit)');
  }
  step(onStep, 'read', 'Reading the file');
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length < 1) throw new Error('the file is empty');
  if (data.length > MAX_FILE_BYTES) throw new Error('file is too large (20 MiB limit)');
  return { name, data };
}

// A failed attempt is remembered for a retry. Without it every retry would lock the file again
// (new salt, so a new blob hash and another full copy on the server, counted against the upload
// quota) and, for a new document, would start over with a new document id and a new password.
// Only the last failed attempt of each kind is kept, in memory, for the life of the page.
let pendingCreate = null;
let pendingVersion = null;
let pendingRevoke = null;

// Forgets the remembered attempts (used by tests).
export function forgetPendingPublish() {
  pendingCreate = null;
  pendingVersion = null;
  pendingRevoke = null;
}

// A signed record stays usable for a retry a little less than the 10 minutes the server accepts.
const RESEND_WINDOW_MS = 8 * 60 * 1000;

// Reads the file and fingerprints it, so a retry is only treated as the same attempt when the same
// file is chosen again.
async function readStage({ file, onStep }) {
  const { name, data } = await readFile(file, onStep);
  const fileHash = await sha256Hex(data); // before the worker takes the buffer
  return { name, data, fileHash };
}

// Locks the file in the worker, or hands back the file locked by the last failed attempt.
async function lockStage({ read, password, iterations, onStep, cached }) {
  if (cached) {
    step(onStep, 'derive', 'Using the file locked in the last attempt');
    step(onStep, 'lock', 'File locked');
    return cached;
  }
  step(onStep, 'derive', 'Deriving the key, this takes a moment');
  // Published files use the public commit salt, so the plain file can be checked against the record by anyone.
  const args = { data: read.data, name: read.name, password, commitSalt: hexToBytes(PUBLIC_COMMIT_SALT) };
  if (iterations !== undefined) args.iterations = iterations;
  const locked = await lockInWorker(args);
  step(onStep, 'lock', 'File locked');
  return locked;
}

// Asks the server whether this exact signed record is already stored. A false answer or a failed
// request means "not shown", never "not stored".
async function recordLanded(docId, hash, signature) {
  try {
    const bundle = await getDocument(docId);
    const rows = bundle && Array.isArray(bundle.records) ? bundle.records : [];
    for (const row of rows) {
      if (row && row.recordHash === hash && row.signature === signature && row.record && (await hashRecord(row.record)) === hash) return true;
    }
  } catch {
    // unknown
  }
  return false;
}

// Uploads the locked file, then builds, signs and posts the record. makeRecord(createdAt) must
// return the unsigned record. It is built twice: once to fail early before a big upload, and
// again after the upload so its time stamp is fresh for the server's time window. pending (when
// given) keeps the signed record, so a retry sends the same one while the server still accepts it.
async function uploadSignPost({ docId, locked, identity, makeRecord, onStep, pending, onSigned }) {
  checkRecord(makeRecord(Date.now()));

  step(onStep, 'upload', 'Uploading the locked file');
  const up = await putBlob({
    hash: locked.blobHash,
    size: locked.size,
    bytes: locked.bytes,
    signer: identity.keyId,
    sign: identity.sign
  });
  if (up && typeof up.hash === 'string' && up.hash !== locked.blobHash) {
    throw new Error('the server stored a different file than the one sent');
  }

  return signAndPost({ docId, identity, makeRecord, onStep, pending, onSigned });
}

async function signAndPost({ docId, identity, makeRecord, onStep, pending, onSigned }) {
  let signed = pending && pending.signed && Date.now() - pending.signed.record.createdAt < RESEND_WINDOW_MS ? pending.signed : null;
  if (!signed) {
    const rec = makeRecord(Date.now());
    checkRecord(rec);
    step(onStep, 'sign', 'Signing the record');
    const signature = await identity.sign(rec);
    signed = { record: rec, signature, hash: await hashRecord(rec) };
    if (pending) pending.signed = signed;
  } else {
    step(onStep, 'sign', 'Using the record signed in the last attempt');
  }
  if (typeof onSigned === 'function') onSigned(signed.record);

  step(onStep, 'publish', 'Publishing the record');
  let res;
  try {
    res = await postDocRecord(docId, signed.record, signed.signature);
  } catch (err) {
    // The answer may have been lost after the server stored the record. Look before giving up.
    if (outcomeUnknown(err) && (await recordLanded(docId, signed.hash, signed.signature))) {
      res = { recordHash: signed.hash };
    } else {
      // A clear refusal means this signed record is spent, so the next attempt signs a new one.
      if (!outcomeUnknown(err) && pending) pending.signed = null;
      throw err;
    }
  }
  if (res && typeof res.recordHash === 'string' && res.recordHash !== signed.hash) {
    throw Object.assign(new Error('the server returned a different record hash than the one signed'), { outcomeKnown: true });
  }
  return { record: signed.record, recordHash: signed.hash, response: res };
}

// file: File. Returns { docId, password, fingerprint, blobHash, recordHash, version:1, links }.
// iterations is only for tests (fast key derivation).
// If an attempt fails, the next call with the same file, label and choice reuses its document id,
// password, locked file and signed record, so nothing is duplicated on the server.
export async function publishNewDocument({ file, label, listed, identity, password, onStep, iterations } = {}) {
  needIdentity(identity);
  const explicit = password !== undefined && password !== null;
  if (explicit && (typeof password !== 'string' || normalizePassword(password) === '')) throw new Error('password is empty');

  const read = await readStage({ file, onStep });
  const text = label === undefined || label === null ? defaultLabel(read.name) : tidyText(label);
  const key = [read.name, read.fileHash, identity.keyId, text, listed === true ? 1 : 0, iterations === undefined ? '' : iterations].join('|');
  const same = pendingCreate && pendingCreate.key === key && (!explicit || pendingCreate.password === password);
  const pending = same ? pendingCreate : null;
  const pw = pending ? pending.password : explicit ? password : generatePassword();

  const locked = await lockStage({ read, password: pw, iterations, onStep, cached: pending ? pending.locked : null });
  const attempt = pending || { key, docId: newDocId(), password: pw, locked, signed: null };
  pendingCreate = attempt;
  const docId = attempt.docId;

  let out;
  try {
    out = await uploadSignPost({
      docId,
      locked,
      identity,
      onStep,
      pending: attempt,
      // The id is kept in this browser before the record is sent, so a document whose answer was lost is still listed.
      onSigned: (record) => rememberDoc({ docId, label: text, createdAt: record.createdAt, owner: identity.keyId }),
      makeRecord: (createdAt) => ({
        v: 2,
        type: 'doc.create',
        docId,
        version: 1,
        prev: ZERO_HASH,
        signer: identity.keyId,
        createdAt,
        label: text,
        listed: listed === true,
        blob: { hash: locked.blobHash, size: locked.size, suite: 1 },
        commitment: locked.commitment
      })
    });
  } catch (err) {
    // A clear refusal means no document exists under this id, so it is not kept in the list.
    if (!outcomeUnknown(err)) forgetDoc(docId);
    throw err;
  }

  pendingCreate = null;
  step(onStep, 'done', 'Published');
  return {
    docId,
    password: pw,
    fingerprint: locked.fileHash,
    blobHash: locked.blobHash,
    recordHash: out.recordHash,
    version: 1,
    links: { verify: verifyLink(docId), full: fullLink(docId, pw) }
  };
}

// head: { version, recordHash } of the current latest version. password locks the new file.
export async function publishNewVersion({ docId, head, file, label, identity, password, onStep, iterations } = {}) {
  needIdentity(identity);
  needDocId(docId);
  needHead(head);
  if (typeof password !== 'string' || normalizePassword(password) === '') throw new Error('password is empty');

  const read = await readStage({ file, onStep });
  const text = label === undefined || label === null ? defaultLabel(read.name) : tidyText(label);
  const pwKey = await sha256Hex('hrdlock/pending|' + normalizePassword(password));
  const key = [docId, head.recordHash, read.name, read.fileHash, text, pwKey, iterations === undefined ? '' : iterations].join('|');
  const pending = pendingVersion && pendingVersion.key === key ? pendingVersion : null;

  const locked = await lockStage({ read, password, iterations, onStep, cached: pending ? pending.locked : null });
  const attempt = pending || { key, locked, signed: null };
  pendingVersion = attempt;
  const version = head.version + 1;

  const out = await uploadSignPost({
    docId,
    locked,
    identity,
    onStep,
    pending: attempt,
    makeRecord: (createdAt) => ({
      v: 2,
      type: 'doc.update',
      docId,
      version,
      prev: head.recordHash,
      signer: identity.keyId,
      createdAt,
      label: text,
      blob: { hash: locked.blobHash, size: locked.size, suite: 1 },
      commitment: locked.commitment
    })
  });

  pendingVersion = null;
  step(onStep, 'done', 'Published');
  return { version, recordHash: out.recordHash, fingerprint: locked.fileHash, blobHash: locked.blobHash };
}

// Ends the document. The old versions stay visible, but nothing newer can follow.
export async function revokeDocument({ docId, head, reason, identity, onStep } = {}) {
  needIdentity(identity);
  needDocId(docId);
  needHead(head);
  const version = head.version + 1;
  const why = tidyText(reason);
  const key = [docId, head.recordHash, why].join('|');
  const pending = pendingRevoke && pendingRevoke.key === key ? pendingRevoke : { key, signed: null };
  pendingRevoke = pending;
  const out = await signAndPost({
    docId,
    identity,
    pending,
    onStep,
    makeRecord: (createdAt) => ({
      v: 2,
      type: 'doc.revoke',
      docId,
      version,
      prev: head.recordHash,
      signer: identity.keyId,
      createdAt,
      reason: why
    })
  });
  pendingRevoke = null;
  step(onStep, 'done', 'Revoked');
  return { version, recordHash: out.recordHash };
}

// Compares the head with the newest one this browser saw before (version, record hash, ledger
// position). A step back or a changed history adds a warning at the top. After a good, anchored
// check the head is remembered, but a head that went back never replaces the remembered one.
function noteSeenHead(docId, bundle, verification) {
  try {
    if (!verification || !Array.isArray(verification.warnings)) return;
    const seen = getSeenHead(docId);
    const cmp = compareWithSeen(seen, bundle, docId);
    if (cmp.rollback) {
      verification.rollback = true;
      verification.warnings.unshift(...cmp.warnings);
    }
    if (verification.ok === true && verification.anchored === true) {
      const next = nextSeenHead(seen, bundle, docId, cmp);
      if (next) setSeenHead(next);
    }
  } catch {
    // the memory is a convenience, never let it break an open
  }
}

// A live answer is freshly signed on every request, so a checkpoint older than this is a replay from
// a cache or an old copy, not the server answering now.
export const MAX_CHECKPOINT_AGE_MS = 10 * 60 * 1000;

// Fetches a document and checks it. A failed check is reported in the result, it never throws.
// Network and server errors (ApiError) do throw.
// Returns { bundle, verification, blobCheck, file, plaintextCheck, fingerprint }.
export async function openDocument({
  docId,
  password,
  pinnedServerKeyId,
  allowUnanchored = false,
  maxCheckpointAgeMs = MAX_CHECKPOINT_AGE_MS,
  onStep
} = {}) {
  needDocId(docId);

  step(onStep, 'fetch', 'Fetching the document');
  const bundle = await getDocument(docId);

  step(onStep, 'verify', 'Checking signatures and the chain');
  const verification = await verifyDocumentBundle(bundle, {
    pinnedServerKeyId: pinnedServerKeyId || '',
    expectedDocId: docId,
    allowUnanchored: allowUnanchored === true,
    maxCheckpointAgeMs
  });

  const result = { bundle, verification, blobCheck: null, file: null, plaintextCheck: null, fingerprint: null };
  noteSeenHead(docId, bundle, verification);

  const rows = bundle && Array.isArray(bundle.records) ? bundle.records : [];
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  const head = last && last.record && typeof last.record === 'object' ? last.record : null;
  const hasBlob = head !== null && head.type !== 'doc.revoke' && head.blob && typeof head.blob.hash === 'string';

  if (!hasBlob) {
    step(onStep, 'done', head && head.type === 'doc.revoke' ? 'This document was revoked' : 'Checks finished');
    return result;
  }

  step(onStep, 'download', 'Downloading the locked file');
  let bytes;
  try {
    bytes = await getBlob(head.blob.hash, { maxBytes: head.blob.size });
  } catch (err) {
    // A body larger than the signed size is a failed check, not a network problem.
    if (!(err && err.code === 'too_large' && err.status === 0)) throw err;
    result.blobCheck = { ok: false, detail: 'the server sent more data than the signed record allows, so the download was stopped' };
    step(onStep, 'done', 'Checks finished');
    return result;
  }

  step(onStep, 'blob', 'Checking the file against the signed hash');
  result.blobCheck = await verifyBlobBytes(bytes, head);
  if (!(typeof password === 'string' && normalizePassword(password) !== '') && result.blobCheck.ok) password = await viewablePassword(docId);

  if (typeof password === 'string' && normalizePassword(password) !== '') {
    if (!result.blobCheck.ok) {
      result.plaintextCheck = { ok: false, detail: 'the file was not unlocked because it does not match the signed hash' };
    } else {
      step(onStep, 'unlock', 'Deriving the key, this takes a moment');
      let unlocked = null;
      try {
        unlocked = await unlockInWorker({ bytes, password });
      } catch (err) {
        result.plaintextCheck = { ok: false, detail: err && err.message ? err.message : 'file is damaged' };
      }
      if (unlocked) {
        step(onStep, 'plaintext', 'Checking the fingerprint against the signed commitment');
        result.fingerprint = unlocked.fileHash;
        result.plaintextCheck = await verifyPlaintext(
          { fileHash: unlocked.fileHash, commitSalt: unlocked.commitSalt },
          head
        );
        if (result.plaintextCheck.ok) result.file = { name: unlocked.name, data: unlocked.data };
      }
    }
  }

  step(onStep, 'done', 'Checks finished');
  return result;
}
