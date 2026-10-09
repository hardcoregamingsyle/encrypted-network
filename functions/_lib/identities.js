// Identity rows: loading, shaping for responses, and checking that a record was signed by its signer.
import { verifyRecord } from '../../shared/keys.js';
import { ApiError } from './errors.js';

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
