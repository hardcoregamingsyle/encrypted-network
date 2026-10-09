// Publishing and opening documents in the browser.
// The file is locked here, the server only ever sees the locked bytes. Records are signed here
// with the identity key. Opening a document re-checks everything locally (signatures, chain,
// file hash, fingerprint) and never trusts the server's word.
import { isHex } from '../../shared/encoding.js';
import { newDocId, recordHash as hashRecord, validateRecord, ZERO_HASH } from '../../shared/records.js';
import { verifyBlobBytes, verifyDocumentBundle, verifyPlaintext } from '../../shared/verify.js';
import { getBlob, getDocument, postDocRecord, putBlob } from './api.js';
import { lockInWorker, unlockInWorker } from './cipherClient.js';
import { fullLink, verifyLink } from './links.js';
import { rememberDoc } from './localDocs.js';
import { generatePassword, normalizePassword } from './lockfile.js';

const MAX_FILE_BYTES = 52428800;
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

// Reads and validates the chosen file. Returns { name, data }.
async function readFile(file, onStep) {
  if (!file || typeof file.name !== 'string' || typeof file.arrayBuffer !== 'function') {
    throw new Error('choose a file first');
  }
  const name = file.name.trim();
  if (name === '') throw new Error('the file has no name');
  if (Number.isFinite(file.size)) {
    if (file.size < 1) throw new Error('the file is empty');
    if (file.size > MAX_FILE_BYTES) throw new Error('file is too large (50 MiB limit)');
  }
  step(onStep, 'read', 'Reading the file');
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length < 1) throw new Error('the file is empty');
  if (data.length > MAX_FILE_BYTES) throw new Error('file is too large (50 MiB limit)');
  return { name, data };
}

// Locks the file in the worker. Returns { locked, name }.
async function lockStage({ file, password, iterations, onStep }) {
  const { name, data } = await readFile(file, onStep);
  step(onStep, 'derive', 'Deriving the key, this takes a moment');
  const args = { data, name, password };
  if (iterations !== undefined) args.iterations = iterations;
  const locked = await lockInWorker(args);
  step(onStep, 'lock', 'File locked');
  return { locked, name };
}

// Uploads the locked file, then builds, signs and posts the record. makeRecord(createdAt) must
// return the unsigned record. It is built twice: once to fail early before a big upload, and
// again after the upload so its time stamp is fresh for the server's time window.
async function uploadSignPost({ docId, locked, identity, makeRecord, onStep }) {
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

  return signAndPost({ docId, identity, record: makeRecord(Date.now()), onStep });
}

async function signAndPost({ docId, identity, record, onStep }) {
  checkRecord(record);
  step(onStep, 'sign', 'Signing the record');
  const signature = await identity.sign(record);
  const hash = await hashRecord(record);

  step(onStep, 'publish', 'Publishing the record');
  const res = await postDocRecord(docId, record, signature);
  if (res && typeof res.recordHash === 'string' && res.recordHash !== hash) {
    throw new Error('the server returned a different record hash than the one signed');
  }
  return { record, recordHash: hash, response: res };
}

// file: File. Returns { docId, password, fingerprint, blobHash, recordHash, version:1, links }.
// iterations is only for tests (fast key derivation).
export async function publishNewDocument({ file, label, listed, identity, password, onStep, iterations } = {}) {
  needIdentity(identity);
  const pw = password === undefined || password === null ? generatePassword() : password;
  if (typeof pw !== 'string' || normalizePassword(pw) === '') throw new Error('password is empty');

  const { locked, name } = await lockStage({ file, password: pw, iterations, onStep });
  const docId = newDocId();
  const text = label === undefined || label === null ? defaultLabel(name) : tidyText(label);

  const out = await uploadSignPost({
    docId,
    locked,
    identity,
    onStep,
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

  rememberDoc({ docId, label: text, createdAt: out.record.createdAt });
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

  const { locked, name } = await lockStage({ file, password, iterations, onStep });
  const version = head.version + 1;
  const text = label === undefined || label === null ? defaultLabel(name) : tidyText(label);

  const out = await uploadSignPost({
    docId,
    locked,
    identity,
    onStep,
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

  step(onStep, 'done', 'Published');
  return { version, recordHash: out.recordHash, fingerprint: locked.fileHash, blobHash: locked.blobHash };
}

// Ends the document. The old versions stay visible, but nothing newer can follow.
export async function revokeDocument({ docId, head, reason, identity, onStep } = {}) {
  needIdentity(identity);
  needDocId(docId);
  needHead(head);
  const version = head.version + 1;
  const record = {
    v: 2,
    type: 'doc.revoke',
    docId,
    version,
    prev: head.recordHash,
    signer: identity.keyId,
    createdAt: Date.now(),
    reason: tidyText(reason)
  };
  const out = await signAndPost({ docId, identity, record, onStep });
  step(onStep, 'done', 'Revoked');
  return { version, recordHash: out.recordHash };
}

// Fetches a document and checks it. A failed check is reported in the result, it never throws.
// Network and server errors (ApiError) do throw.
// Returns { bundle, verification, blobCheck, file, plaintextCheck, fingerprint }.
export async function openDocument({ docId, password, pinnedServerKeyId, allowUnanchored = false, onStep } = {}) {
  needDocId(docId);

  step(onStep, 'fetch', 'Fetching the document');
  const bundle = await getDocument(docId);

  step(onStep, 'verify', 'Checking signatures and the chain');
  const verification = await verifyDocumentBundle(bundle, {
    pinnedServerKeyId: pinnedServerKeyId || '',
    expectedDocId: docId,
    allowUnanchored: allowUnanchored === true
  });

  const result = { bundle, verification, blobCheck: null, file: null, plaintextCheck: null, fingerprint: null };

  const rows = bundle && Array.isArray(bundle.records) ? bundle.records : [];
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  const head = last && last.record && typeof last.record === 'object' ? last.record : null;
  const hasBlob = head !== null && head.type !== 'doc.revoke' && head.blob && typeof head.blob.hash === 'string';

  if (!hasBlob) {
    step(onStep, 'done', head && head.type === 'doc.revoke' ? 'This document was revoked' : 'Checks finished');
    return result;
  }

  step(onStep, 'download', 'Downloading the locked file');
  const bytes = await getBlob(head.blob.hash);

  step(onStep, 'blob', 'Checking the file against the signed hash');
  result.blobCheck = await verifyBlobBytes(bytes, head);

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
