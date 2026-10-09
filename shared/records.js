// Record types, validators and hashes. Validators reject unknown fields so the
// signed content is exactly specified.
import { canonicalBytes, isPlainObject, isWellFormedString } from './canonical.js';
import { ZERO_HASH, bytesToHex, isHex } from './encoding.js';
import { chainHash, sha256Hex } from './hash.js';
import { normalizePublicJwkShape } from './keys.js';

export { ZERO_HASH, chainHash };

const MAX_FILE_BYTES = 52428800;

export const LIMITS = Object.freeze({
  MAX_FILE_BYTES,
  MAX_BLOB_BYTES: MAX_FILE_BYTES + 4096,
  MAX_JSON_BYTES: 64 * 1024,
  DISPLAY_NAME_MAX: 40,
  LABEL_MAX: 120,
  REASON_MAX: 500,
  TITLE_MAX: 60,
  BODY_MAX: 2000,
  RECORD_TIME_WINDOW_MS: 10 * 60 * 1000,
  BLOB_TIME_WINDOW_MS: 5 * 60 * 1000,
  SIGNER_BLOB_QUOTA_BYTES: 500 * 1024 * 1024,
  MAX_TIME_MS: 8.64e15,
  RATE: Object.freeze({
    IDENTITY_PER_HOUR_PER_IP: 10,
    MESSAGES_PER_MINUTE_PER_SIGNER: 20,
    DOC_RECORDS_PER_HOUR_PER_SIGNER: 30,
    CHANNELS_PER_HOUR_PER_SIGNER: 10,
    BLOB_PUTS_PER_HOUR_PER_SIGNER: 30
  })
});

export const RECORD_TYPES = Object.freeze([
  'identity',
  'doc.create',
  'doc.update',
  'doc.revoke',
  'channel.create',
  'message',
  'blob.put',
  'checkpoint'
]);

export const DOC_RECORD_TYPES = Object.freeze(['doc.create', 'doc.update', 'doc.revoke']);

const CHANNEL_ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
// C0 controls, DEL and C1 controls. With newline allowed, \n (0x0a) is excluded.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_NL_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
// Line and paragraph separators and bidi override/isolate controls (display spoofing).
const SPOOF_RE = new RegExp('[\u2028\u2029\u202a-\u202e\u2066-\u2069]', 'u');
// Invisible characters: default ignorable code points (zero width, soft hyphen, fillers, variation
// selectors, tag characters) plus braille blank and hangul fillers. Text made only of these shows as
// nothing, and an embedded one makes two different names look the same.
const INVISIBLE_CLASS = '\\p{Default_Ignorable_Code_Point}\\u3164\\u2800\\u115f\\u1160\\uffa0';
const INVISIBLE_RE = new RegExp('[' + INVISIBLE_CLASS + ']', 'u');
const VISIBLE_RE = new RegExp('[^\\s' + INVISIBLE_CLASS + ']', 'u');

export const isHash = (s) => isHex(s, 64);
export const isDocId = (s) => isHex(s, 32);
export const isChannelId = (s) => typeof s === 'string' && CHANNEL_ID_RE.test(s);

function isTime(n) {
  return Number.isSafeInteger(n) && n >= 0 && n <= LIMITS.MAX_TIME_MS;
}

function codePointLength(s) {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line no-unused-vars
  return n;
}

// Returns an error string or null.
// Any non empty text needs at least one visible character. strict: no invisible characters at
// all (used for names, titles and labels, where look alike text is a spoofing risk). Message
// bodies and reasons may keep joiners and variation selectors, which real text and emoji use.
function textError(name, v, min, max, { newline = false, strict = false } = {}) {
  if (typeof v !== 'string') return `${name} must be a string`;
  if (!isWellFormedString(v)) return `${name} has invalid unicode`;
  if (v !== v.normalize('NFC')) return `${name} must be unicode NFC`;
  if ((newline ? CONTROL_NL_RE : CONTROL_RE).test(v)) return `${name} has control characters`;
  if (SPOOF_RE.test(v)) return `${name} has line separator or direction override characters`;
  const len = codePointLength(v);
  if (len < min || len > max) return `${name} must be ${min} to ${max} characters`;
  if (strict && INVISIBLE_RE.test(v)) return `${name} has invisible characters`;
  if (len > 0 && !VISIBLE_RE.test(v)) return `${name} must not be blank`;
  return null;
}

function shortName(k) {
  const t = JSON.stringify(String(k));
  return t.length > 40 ? t.slice(0, 40) + '..."' : t;
}

// Exact field set check. Returns an error string or null.
function fieldsError(rec, names) {
  if (!isPlainObject(rec)) return 'record must be an object';
  for (const k of Object.keys(rec)) {
    if (!names.includes(k)) return `unexpected field ${shortName(k)}`;
  }
  for (const n of names) {
    if (!Object.prototype.hasOwnProperty.call(rec, n)) return `missing field ${n}`;
  }
  return null;
}

function header(rec, type) {
  if (rec.v !== 2) return 'v must be 2';
  if (rec.type !== type) return `type must be ${type}`;
  if (!isTime(rec.createdAt)) return 'createdAt must be an integer time in ms';
  return null;
}

function blobError(blob) {
  const e = fieldsError(blob, ['hash', 'size', 'suite']);
  if (e) return 'blob: ' + e;
  if (!isHash(blob.hash)) return 'blob.hash must be 64 hex chars';
  if (!Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > LIMITS.MAX_BLOB_BYTES) {
    return `blob.size must be an integer 1 to ${LIMITS.MAX_BLOB_BYTES}`;
  }
  if (blob.suite !== 1) return 'blob.suite must be 1';
  return null;
}

function result(error) {
  return error ? { ok: false, error } : { ok: true };
}

function first(...checks) {
  for (const c of checks) {
    const e = typeof c === 'function' ? c() : c;
    if (e) return e;
  }
  return null;
}

export function validateIdentity(r) {
  return result(
    first(
      () => fieldsError(r, ['v', 'type', 'publicKey', 'displayName', 'createdAt']),
      () => header(r, 'identity'),
      () => {
        try {
          normalizePublicJwkShape(r.publicKey);
          return null;
        } catch (err) {
          return 'publicKey: ' + err.message;
        }
      },
      () => textError('displayName', r.displayName, 1, LIMITS.DISPLAY_NAME_MAX, { strict: true })
    )
  );
}

const DOC_BASE = ['v', 'type', 'docId', 'version', 'prev', 'signer', 'createdAt'];

function docCommon(r, type) {
  return first(
    () => header(r, type),
    () => (isDocId(r.docId) ? null : 'docId must be 32 hex chars'),
    () => (isHash(r.signer) ? null : 'signer must be 64 hex chars'),
    () => (isHash(r.prev) ? null : 'prev must be 64 hex chars')
  );
}

export function validateDocCreate(r) {
  return result(
    first(
      () => fieldsError(r, [...DOC_BASE, 'label', 'listed', 'blob', 'commitment']),
      () => docCommon(r, 'doc.create'),
      () => (r.version === 1 ? null : 'version must be 1'),
      () => (r.prev === ZERO_HASH ? null : 'prev must be the zero hash'),
      () => textError('label', r.label, 0, LIMITS.LABEL_MAX, { strict: true }),
      () => (typeof r.listed === 'boolean' ? null : 'listed must be a boolean'),
      () => blobError(r.blob),
      () => (isHash(r.commitment) ? null : 'commitment must be 64 hex chars')
    )
  );
}

export function validateDocUpdate(r) {
  return result(
    first(
      () => fieldsError(r, [...DOC_BASE, 'label', 'blob', 'commitment']),
      () => docCommon(r, 'doc.update'),
      () => (Number.isSafeInteger(r.version) && r.version >= 2 ? null : 'version must be an integer of 2 or more'),
      () => (r.prev === ZERO_HASH ? 'prev must be the previous record hash' : null),
      () => textError('label', r.label, 0, LIMITS.LABEL_MAX, { strict: true }),
      () => blobError(r.blob),
      () => (isHash(r.commitment) ? null : 'commitment must be 64 hex chars')
    )
  );
}

export function validateDocRevoke(r) {
  return result(
    first(
      () => fieldsError(r, [...DOC_BASE, 'reason']),
      () => docCommon(r, 'doc.revoke'),
      () => (Number.isSafeInteger(r.version) && r.version >= 2 ? null : 'version must be an integer of 2 or more'),
      () => (r.prev === ZERO_HASH ? 'prev must be the previous record hash' : null),
      () => textError('reason', r.reason, 0, LIMITS.REASON_MAX)
    )
  );
}

export function validateChannelCreate(r) {
  return result(
    first(
      () => fieldsError(r, ['v', 'type', 'channelId', 'title', 'docId', 'signer', 'createdAt']),
      () => header(r, 'channel.create'),
      () => (isChannelId(r.channelId) ? null : 'channelId must match [a-z0-9][a-z0-9-]{2,39}'),
      () => textError('title', r.title, 1, LIMITS.TITLE_MAX, { strict: true }),
      () => (r.docId === '' || isDocId(r.docId) ? null : 'docId must be empty or 32 hex chars'),
      () => (isHash(r.signer) ? null : 'signer must be 64 hex chars')
    )
  );
}

export function validateMessage(r) {
  return result(
    first(
      () => fieldsError(r, ['v', 'type', 'channelId', 'body', 'replyTo', 'signer', 'createdAt', 'nonce']),
      () => header(r, 'message'),
      () => (isChannelId(r.channelId) ? null : 'channelId must match [a-z0-9][a-z0-9-]{2,39}'),
      () => textError('body', r.body, 1, LIMITS.BODY_MAX, { newline: true }),
      () => (r.replyTo === '' || isHash(r.replyTo) ? null : 'replyTo must be empty or 64 hex chars'),
      () => (isHash(r.signer) ? null : 'signer must be 64 hex chars'),
      () => (isHex(r.nonce, 32) ? null : 'nonce must be 32 hex chars')
    )
  );
}

export function validateBlobPut(r) {
  return result(
    first(
      () => fieldsError(r, ['v', 'type', 'hash', 'size', 'signer', 'createdAt']),
      () => header(r, 'blob.put'),
      () => (isHash(r.hash) ? null : 'hash must be 64 hex chars'),
      () =>
        Number.isSafeInteger(r.size) && r.size >= 1 && r.size <= LIMITS.MAX_BLOB_BYTES
          ? null
          : `size must be an integer 1 to ${LIMITS.MAX_BLOB_BYTES}`,
      () => (isHash(r.signer) ? null : 'signer must be 64 hex chars')
    )
  );
}

export function validateCheckpointPayload(r) {
  return result(
    first(
      () => fieldsError(r, ['v', 'type', 'scope', 'seq', 'hash', 'signedAt', 'serverKeyId']),
      () => (r.v === 2 ? null : 'v must be 2'),
      () => (r.type === 'checkpoint' ? null : 'type must be checkpoint'),
      () =>
        r.scope === 'ledger' ||
        (typeof r.scope === 'string' &&
          ((r.scope.startsWith('channel:') && isChannelId(r.scope.slice(8))) || (r.scope.startsWith('doc:') && isDocId(r.scope.slice(4)))))
          ? null
          : 'scope must be ledger, channel:<channelId> or doc:<docId>',
      // A document head attestation: seq is the head version, so it is at least 1.
      () => (typeof r.scope === 'string' && r.scope.startsWith('doc:') && r.seq < 1 ? 'seq must be 1 or more for a doc scope' : null),
      () => (Number.isSafeInteger(r.seq) && r.seq >= 0 ? null : 'seq must be an integer of 0 or more'),
      () => (isHash(r.hash) ? null : 'hash must be 64 hex chars'),
      () => (r.seq === 0 ? (r.hash === ZERO_HASH ? null : 'hash must be the zero hash when seq is 0') : null),
      () => (isTime(r.signedAt) ? null : 'signedAt must be an integer time in ms'),
      () => (isHash(r.serverKeyId) ? null : 'serverKeyId must be 64 hex chars')
    )
  );
}

const VALIDATORS = {
  identity: validateIdentity,
  'doc.create': validateDocCreate,
  'doc.update': validateDocUpdate,
  'doc.revoke': validateDocRevoke,
  'channel.create': validateChannelCreate,
  message: validateMessage,
  'blob.put': validateBlobPut,
  checkpoint: validateCheckpointPayload
};

// Dispatches on record.type. Never throws.
export function validateRecord(record) {
  try {
    if (!isPlainObject(record)) return { ok: false, error: 'record must be an object' };
    const type = record.type;
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(VALIDATORS, type)) {
      return { ok: false, error: 'unknown record type' };
    }
    return VALIDATORS[type](record);
  } catch (err) {
    return { ok: false, error: 'record could not be checked' };
  }
}

// sha256 of the canonical record. The signature is not part of the record.
export function recordHash(record) {
  return sha256Hex(canonicalBytes(record));
}

export const messageHash = recordHash;

function randomHex(nBytes) {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(nBytes)));
}

export function newDocId() {
  return randomHex(16);
}

export function newNonce() {
  return randomHex(16);
}
