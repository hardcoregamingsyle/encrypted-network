// Identity rows: loading, shaping for responses, and checking that a record was signed by its signer.
import { keyIdOf, normalizePublicJwk, verifyRecord } from '../../shared/keys.js';
import { validateRecord } from '../../shared/records.js';
import { ApiError, badRequest } from './errors.js';

// Row from the identities table to the response shape.
export function identityFromRow(row) {
  return {
    keyId: row.key_id,
    publicKey: JSON.parse(row.public_jwk),
    displayName: row.display_name,
    createdAt: row.created_at,
    record: JSON.parse(row.record),
    signature: row.signature
  };
}

export function identityMapFromRows(rows) {
  const out = {};
  for (const row of rows) out[row.key_id] = identityFromRow(row);
  return out;
}

export async function loadIdentity(env, keyId) {
  const row = await env.DB.prepare('SELECT * FROM identities WHERE key_id = ?').bind(keyId).first();
  return row ? identityFromRow(row) : null;
}

// The signer of a record must be registered and the signature must verify. Returns the identity.
export async function requireSigner(env, record, signature) {
  const identity = await loadIdentity(env, record.signer);
  if (!identity) throw new ApiError('unknown_signer', 'the signer is not a registered identity');
  if (!(await verifyRecord(identity.publicKey, record, signature))) {
    throw new ApiError('bad_signature', 'the signature does not match the record');
  }
  return identity;
}

// Checks a submitted identity record: shape, key, and the signature made by that same key. Returns
// { publicKey, keyId }. Throws 400 bad_request or bad_signature. Shared by the open registration
// (POST /api/identities) and the account key registration (POST /api/me/key).
export async function checkIdentityRecord(record, signature) {
  const valid = validateRecord(record);
  if (!valid.ok) throw badRequest(valid.error);
  if (record.type !== 'identity') throw badRequest('record type must be identity');
  let publicKey;
  try {
    publicKey = await normalizePublicJwk(record.publicKey);
  } catch (err) {
    throw badRequest('publicKey: ' + err.message);
  }
  if (!(await verifyRecord(publicKey, record, signature))) {
    throw new ApiError('bad_signature', 'the identity is not signed by its own key');
  }
  return { publicKey, keyId: await keyIdOf(publicKey) };
}
