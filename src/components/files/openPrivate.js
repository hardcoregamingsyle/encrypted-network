// Opening a private file: bring the locked copy here, check it is the one the owner saved, then unlock it.
import { sha256Hex } from '../../../shared/hash.js';
import { keyIdOf, verifyRecord } from '../../../shared/keys.js';
import { unlockInWorker } from '../../lib/cipherClient.js';
import { NOT_YOURS } from './filesPasswordFlow.js';

export const NOT_SAVED_BY_YOU = 'This file is not the one you saved, so it was not opened.';
export const DAMAGED = 'This file is damaged and cannot be opened.';

// ownKeyIds are the keys of this account. publicKeyOf(keyId) gives the public key of one of them.
// api.getPrivateFile(id) gives { bytes, hash, signer, createdAt, signature }. Gives back the locked bytes only when the
// hash matches, the signer is one of the account's own keys, and that key's signature of the saved record is good.
export async function fetchChecked(id, { ownKeyIds, publicKeyOf }, { getPrivateFile }) {
  const f = await getPrivateFile(id);
  const record = { v: 2, type: 'blob.put', hash: f.hash, size: f.bytes.length, signer: f.signer, createdAt: f.createdAt };
  const jwk = ownKeyIds.includes(f.signer) ? await publicKeyOf(f.signer) : null;
  const good = jwk && (await sha256Hex(f.bytes)) === f.hash && (await keyIdOf(jwk).catch(() => '')) === f.signer && (await verifyRecord(jwk, record, f.signature));
  if (!good) throw new Error(NOT_SAVED_BY_YOU);
  return f.bytes;
}

// -> { name, data }. The bytes passed the check above, so a refusal here means the password is wrong.
export async function openLocked(bytes, lockPassword) {
  try {
    return await unlockInWorker({ bytes, password: lockPassword });
  } catch (err) {
    throw new Error(/wrong password/.test(String(err && err.message)) ? NOT_YOURS : DAMAGED);
  }
}
