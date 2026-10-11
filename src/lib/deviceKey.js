// The signing key of this device.
//
// Account (Easy): the key pair is made once, extractable, so the private half can be sent to the
// account over TLS. After that it is imported again as a NON extractable key and only that copy is
// kept in this browser. A new device downloads the private half and imports it the same way.
// Account (Strict): every device makes its own key and nothing is sent anywhere.
// Quick start (guest): a non extractable key, no passphrase and no backup file.
//
// Where things live (IndexedDB, through the keystore adapter):
//   'identity'          the guest key, or an identity restored from an old .hrdkey backup
//   'acct:<accountId>'  { active: keyId, keys: { keyId: storedKey } } the keys of one account on this device
import { exportPrivateJwk, exportPublicJwk, generateKeyPair, keyIdOf, signRecord } from '../../shared/keys.js';
import { validateRecord } from '../../shared/records.js';
import * as keystore from './keystore.js';

export const MAX_ACCOUNT_KEYS = 5;

const accountSlot = (accountId) => 'acct:' + String(accountId);

// Makes a key pair and the signed identity record for it. With extractable the private jwk is returned
// too (the caller sends it to the account, then drops it). The private key object here is only for the
// first signature, it is not what gets stored.
export async function makeKeyMaterial(displayName, { extractable = false, now = Date.now } = {}) {
  const name = typeof displayName === 'string' ? displayName.normalize('NFC').trim() : '';
  const problem = keystore.displayNameError(name);
  if (problem) throw new Error(problem);
  const { publicKey, privateKey } = await generateKeyPair({ extractable });
  const publicJwk = await exportPublicJwk(publicKey);
  const keyId = await keyIdOf(publicJwk);
  const createdAt = now();
  const record = { v: 2, type: 'identity', publicKey: publicJwk, displayName: name, createdAt };
  const checked = validateRecord(record);
  if (!checked.ok) throw new Error(checked.error);
  const signature = await signRecord(privateKey, record);
  const material = { keyId, displayName: name, publicKey: publicJwk, createdAt, record, signature };
  if (extractable) material.privateJwk = await exportPrivateJwk(privateKey);
  else material.privateKey = privateKey;
  return material;
}

// The record kept on this device. The private key is always the non extractable copy.
export async function toStored(material) {
  if (material.privateKey && !material.privateJwk) {
    const { privateKey, keyId, displayName, publicKey, createdAt, record, signature } = material;
    return { keyId, displayName, publicKey, createdAt, record, signature, privateKey };
  }
  return keystore.storedFromOpened(material);
}

// What the account sends back on a new device -> the same stored record, after every consistency check.
export async function storedFromCloud(payload) {
  const opened = await keystore.openIdentityPayload({
    privateJwk: payload && payload.privateJwk,
    record: payload && payload.record,
    signature: payload && payload.signature
  });
  return keystore.storedFromOpened(opened);
}

export function identityOf(stored) {
  return keystore.identityFromStored(stored);
}

// ---------------------------------------------------------------------------
// Account keys on this device

async function readAccount(accountId) {
  const entry = await keystore.storageGet(accountSlot(accountId));
  if (!entry || typeof entry !== 'object' || !entry.keys || typeof entry.keys !== 'object') return { active: '', keys: {} };
  return { active: typeof entry.active === 'string' ? entry.active : '', keys: { ...entry.keys } };
}

// Every usable identity this device holds for the account: { active: identity|null, all: {keyId: identity} }.
export async function loadAccountKeys(accountId, allowedKeyIds = null) {
  const entry = await readAccount(accountId);
  const all = {};
  for (const [keyId, stored] of Object.entries(entry.keys)) {
    if (allowedKeyIds && !allowedKeyIds.includes(keyId)) continue;
    const identity = identityOf(stored);
    if (identity && identity.keyId === keyId) all[keyId] = identity;
  }
  let active = entry.active && all[entry.active] ? all[entry.active] : null;
  if (!active) {
    const first = Object.keys(all)[0];
    active = first ? all[first] : null;
  }
  return { active, all };
}

// Keeps the key on this device. The newest key becomes the active one.
export async function saveAccountKey(accountId, stored, { makeActive = true } = {}) {
  const entry = await readAccount(accountId);
  entry.keys[stored.keyId] = stored;
  if (makeActive || !entry.active) entry.active = stored.keyId;
  await keystore.storageSet(accountSlot(accountId), entry);
}

export async function removeAccountKeys(accountId) {
  await keystore.storageRemove(accountSlot(accountId));
}

// ---------------------------------------------------------------------------
// Guest key (and identities restored from an old backup file)

export async function loadGuest() {
  return keystore.loadIdentity();
}

export async function saveGuest(stored) {
  await keystore.storageSet('identity', stored);
  return identityOf(stored);
}

export async function forgetGuest() {
  await keystore.forgetIdentity();
}
