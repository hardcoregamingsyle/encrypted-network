// Identity storage and key backup.
//
// The private key lives in IndexedDB as a NON extractable CryptoKey. When an identity is
// created the key pair is made extractable once, an encrypted backup (PBKDF2 + AES-GCM)
// is built, then the private key is re-imported as non extractable for storage.
//
// A non extractable key cannot be exported again, so the encrypted backup text is stored
// beside the key. "Fresh backup" decrypts it with the passphrase and encrypts it again with a
// new salt and iv.
//
// Storage goes through a tiny adapter { get(key), set(key, value), remove(key) } so tests can
// swap in an in memory fake with setStorageAdapter().
import { base64UrlToBytes, bytesToBase64Url, concatBytes, utf8Decode, utf8Encode } from '../../shared/encoding.js';
import {
  exportPrivateJwk,
  exportPublicJwk,
  generateKeyPair,
  importPrivateJwk,
  keyIdOf,
  publicJwkFromPrivate,
  signRecord,
  verifyRecord
} from '../../shared/keys.js';
import { validateRecord } from '../../shared/records.js';

export const BACKUP_KIND = 'hrdlock-key-backup';
export const BACKUP_ITERATIONS = 600000;
export const MIN_PASSPHRASE_LENGTH = 10;
const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 2000000;
const MAX_BACKUP_BYTES = 64 * 1024;
const STORE_KEY = 'identity';

const MSG_NOT_BACKUP = 'this is not a hrdlock key backup file';
const MSG_BAD_PASSPHRASE = 'wrong passphrase, or the backup file was changed';
const MSG_DAMAGED = 'the backup content is damaged';

function subtle() {
  return globalThis.crypto.subtle;
}

// ---------------------------------------------------------------------------
// Storage adapters

const DB_NAME = 'hrdlock';
const DB_STORE = 'keystore';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('this browser cannot store keys (IndexedDB is not available)'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('could not open key storage'));
    req.onblocked = () => reject(new Error('key storage is blocked by another tab'));
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const request = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error || new Error('key storage failed'));
      tx.onabort = () => reject(tx.error || new Error('key storage failed'));
    });
  } finally {
    db.close();
  }
}

export function createIndexedDbAdapter() {
  return {
    get: (key) => withStore('readonly', (store) => store.get(key)),
    set: (key, value) => withStore('readwrite', (store) => store.put(value, key)),
    remove: (key) => withStore('readwrite', (store) => store.delete(key))
  };
}

// A simple in memory adapter, also handy for tests.
export function createMemoryAdapter() {
  const map = new Map();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    }
  };
}

let adapter = null;

export function setStorageAdapter(next) {
  adapter = next;
}

function storage() {
  if (!adapter) adapter = createIndexedDbAdapter();
  return adapter;
}

// ---------------------------------------------------------------------------
// Passphrase helpers

function codePointCount(text) {
  return Array.from(text).length;
}

function normalizePassphrase(passphrase) {
  if (typeof passphrase !== 'string') throw new Error('passphrase must be text');
  return passphrase.normalize('NFC');
}

const COMMON_WORDS = ['password', 'passw0rd', 'letmein', 'qwerty', 'abcdef', '123456', 'admin', 'welcome', 'iloveyou', 'changeme', 'secret'];

// Rough strength hint for the form. level 0..4. ok is true when the passphrase is long enough to use.
export function passphraseStrength(passphrase) {
  const text = typeof passphrase === 'string' ? passphrase : '';
  const length = codePointCount(text);
  if (length === 0) return { level: 0, label: 'Empty', ok: false };
  if (length < MIN_PASSPHRASE_LENGTH) return { level: 1, label: 'Too short', ok: false };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(text)).length;
  const distinct = new Set(Array.from(text.toLowerCase())).size;
  if (distinct < 5) return { level: 1, label: 'Too repetitive', ok: false };
  const wordList = text.trim().toLowerCase().split(/\s+/);
  // Repeating a word adds length but almost no strength, so only different words count.
  const words = new Set(wordList).size;
  if (wordList.length > 1 && words === 1) return { level: 1, label: 'Too repetitive', ok: false };
  let score = 2;
  if (length >= 14 || words >= 3) score += 1;
  if ((length >= 18 && classes >= 2) || words >= 4 || (length >= 14 && classes >= 3)) score += 1;
  // The first things an offline guesser tries.
  const lower = text.toLowerCase();
  if (COMMON_WORDS.some((w) => lower.includes(w))) {
    return { level: Math.min(score, 2), label: 'Weak, it contains a very common word', ok: true };
  }
  const labels = ['', '', 'Fair', 'Good', 'Strong'];
  return { level: score, label: labels[score], ok: true };
}

const DUMMY_KEY = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) };

// Checks a display name with the shared record rules. Returns an error text, or '' when the name is fine.
export function displayNameError(raw) {
  const name = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (!name) return 'Enter a display name.';
  const result = validateRecord({ v: 2, type: 'identity', publicKey: DUMMY_KEY, displayName: name, createdAt: 0 });
  if (result.ok) return '';
  if (result.error.startsWith('displayName')) return 'Display name ' + result.error.slice('displayName'.length).trim() + '.';
  return 'This display name cannot be used.';
}

// ---------------------------------------------------------------------------
// Backup file

async function deriveBackupKey(passphrase, salt, iterations) {
  const material = await subtle().importKey('raw', utf8Encode(normalizePassphrase(passphrase)), 'PBKDF2', false, [
    'deriveKey'
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function backupAad(keyId) {
  return concatBytes(utf8Encode('hrdlock/v2/key-backup\n'), utf8Encode(keyId));
}

export function backupFileName(keyId) {
  return `hrdlock-key-${String(keyId).slice(0, 8)}.hrdkey`;
}

// payload = { privateJwk, publicKey, displayName, createdAt, record, signature }
export async function buildBackup(keyId, payload, passphrase, { iterations = BACKUP_ITERATIONS } = {}) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt, iterations);
  const plain = utf8Encode(JSON.stringify(payload));
  const sealed = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: backupAad(keyId) }, key, plain);
  const file = {
    v: 2,
    kind: BACKUP_KIND,
    keyId,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bytesToBase64Url(salt) },
    iv: bytesToBase64Url(iv),
    data: bytesToBase64Url(new Uint8Array(sealed))
  };
  return JSON.stringify(file, null, 2) + '\n';
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function decodeFixed(text, length) {
  if (typeof text !== 'string') throw new Error(MSG_NOT_BACKUP);
  let bytes;
  try {
    bytes = base64UrlToBytes(text);
  } catch {
    throw new Error(MSG_NOT_BACKUP);
  }
  if (length !== undefined && bytes.length !== length) throw new Error(MSG_NOT_BACKUP);
  return bytes;
}

// Reads the backup text, checks the passphrase and every inner consistency rule.
// Returns { keyId, privateJwk, publicKey, displayName, createdAt, record, signature }.
export async function openBackup(backupText, passphrase) {
  if (typeof backupText !== 'string' || backupText.length > MAX_BACKUP_BYTES) throw new Error(MSG_NOT_BACKUP);
  let file;
  try {
    file = JSON.parse(backupText);
  } catch {
    throw new Error(MSG_NOT_BACKUP);
  }
  if (!isObject(file) || file.v !== 2 || file.kind !== BACKUP_KIND) throw new Error(MSG_NOT_BACKUP);
  if (typeof file.keyId !== 'string' || !/^[0-9a-f]{64}$/.test(file.keyId)) throw new Error(MSG_NOT_BACKUP);
  const kdf = file.kdf;
  if (!isObject(kdf) || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') throw new Error(MSG_NOT_BACKUP);
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < MIN_ITERATIONS || kdf.iterations > MAX_ITERATIONS) {
    throw new Error(MSG_NOT_BACKUP);
  }
  const salt = decodeFixed(kdf.salt, 16);
  const iv = decodeFixed(file.iv, 12);
  const data = decodeFixed(file.data);
  if (data.length < 17) throw new Error(MSG_NOT_BACKUP);

  let plain;
  try {
    const key = await deriveBackupKey(passphrase, salt, kdf.iterations);
    plain = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: backupAad(file.keyId) }, key, data);
  } catch {
    throw new Error(MSG_BAD_PASSPHRASE);
  }

  let inner;
  try {
    inner = JSON.parse(utf8Decode(new Uint8Array(plain)));
  } catch {
    throw new Error(MSG_DAMAGED);
  }
  await checkInner(inner, file.keyId);
  // Built from the checked fields only. Any other member of the decrypted file is dropped, so it
  // cannot replace the key id that was just verified.
  const { privateJwk, publicKey, displayName, createdAt, record, signature } = inner;
  return { privateJwk, publicKey, displayName, createdAt, record, signature, keyId: file.keyId };
}

function publicJwkOrder(jwk) {
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}

// The decrypted content must describe one consistent, correctly signed identity.
async function checkInner(inner, keyId) {
  if (!isObject(inner)) throw new Error(MSG_DAMAGED);
  const { privateJwk, publicKey, displayName, createdAt, record, signature } = inner;
  let derived;
  try {
    derived = publicJwkFromPrivate(privateJwk);
  } catch {
    throw new Error(MSG_DAMAGED);
  }
  if (!isObject(publicKey) || publicJwkOrder(publicKey) !== publicJwkOrder(derived)) throw new Error(MSG_DAMAGED);
  if ((await keyIdOf(derived)) !== keyId) throw new Error(MSG_DAMAGED);
  if (!isObject(record) || record.type !== 'identity' || !validateRecord(record).ok) throw new Error(MSG_DAMAGED);
  if (record.displayName !== displayName || record.createdAt !== createdAt) throw new Error(MSG_DAMAGED);
  if (publicJwkOrder(record.publicKey) !== publicJwkOrder(derived)) throw new Error(MSG_DAMAGED);
  if (!(await verifyRecord(derived, record, signature))) throw new Error(MSG_DAMAGED);
  // the private part must really belong to the public key: sign a probe and verify it
  try {
    const probe = { type: 'backup.check', nonce: bytesToBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16))) };
    const key = await importPrivateJwk(privateJwk, { extractable: false });
    if (!(await verifyRecord(derived, probe, await signRecord(key, probe)))) throw new Error(MSG_DAMAGED);
  } catch {
    throw new Error(MSG_DAMAGED);
  }
}

// ---------------------------------------------------------------------------
// Identity objects

function makeIdentity(stored) {
  const { privateKey } = stored;
  return {
    keyId: stored.keyId,
    displayName: stored.displayName,
    publicKey: stored.publicKey,
    createdAt: stored.createdAt,
    record: stored.record,
    signature: stored.signature,
    sign: (record) => signRecord(privateKey, record)
  };
}

// Re-imports the private key as non extractable and saves everything.
async function saveIdentity(opened, backupText) {
  const privateKey = await importPrivateJwk(opened.privateJwk, { extractable: false });
  const stored = {
    keyId: opened.keyId,
    displayName: opened.displayName,
    publicKey: opened.publicKey,
    createdAt: opened.createdAt,
    record: opened.record,
    signature: opened.signature,
    privateKey,
    backupText
  };
  await storage().set(STORE_KEY, stored);
  return makeIdentity(stored);
}

function checkNewPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || codePointCount(passphrase) < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
}

// Makes a new identity. Returns { identity, backupText, backupName }.
export async function createIdentity({ displayName, passphrase, iterations = BACKUP_ITERATIONS } = {}) {
  checkNewPassphrase(passphrase);
  const name = typeof displayName === 'string' ? displayName.normalize('NFC').trim() : '';
  const { publicKey, privateKey } = await generateKeyPair({ extractable: true });
  const publicJwk = await exportPublicJwk(publicKey);
  const keyId = await keyIdOf(publicJwk);
  const createdAt = Date.now();
  const record = { v: 2, type: 'identity', publicKey: publicJwk, displayName: name, createdAt };
  const checked = validateRecord(record);
  if (!checked.ok) throw new Error(checked.error);
  const signature = await signRecord(privateKey, record);
  const privateJwk = await exportPrivateJwk(privateKey);
  const payload = { privateJwk, publicKey: publicJwk, displayName: name, createdAt, record, signature };
  const backupText = await buildBackup(keyId, payload, passphrase, { iterations });
  const identity = await saveIdentity({ keyId, ...payload }, backupText);
  return { identity, backupText, backupName: backupFileName(keyId) };
}

// Restores an identity from backup text. Throws a plain Error on a wrong passphrase or a changed file.
export async function restoreIdentity(backupText, passphrase) {
  const opened = await openBackup(backupText, passphrase);
  return saveIdentity(opened, backupText);
}

// Returns the stored identity or null.
export async function loadIdentity() {
  const stored = await storage().get(STORE_KEY);
  if (!stored || typeof stored !== 'object' || !stored.privateKey || typeof stored.keyId !== 'string') return null;
  return makeIdentity(stored);
}

export async function forgetIdentity() {
  await storage().remove(STORE_KEY);
}

// A fresh backup file for the stored identity. Needs the passphrase that protects the stored backup.
export async function exportBackup(passphrase, { iterations = BACKUP_ITERATIONS } = {}) {
  const stored = await storage().get(STORE_KEY);
  if (!stored || typeof stored.backupText !== 'string') throw new Error('there is no identity to back up');
  const opened = await openBackup(stored.backupText, passphrase);
  const { keyId, ...payload } = opened;
  const backupText = await buildBackup(keyId, payload, passphrase, { iterations });
  return { backupText, backupName: backupFileName(keyId) };
}
