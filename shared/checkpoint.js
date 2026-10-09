// Server signed checkpoints: "the chain is at seq/hash as of signedAt".
import { keyIdOf, signRecord, verifyRecord } from './keys.js';
import { ZERO_HASH, validateCheckpointPayload } from './records.js';
import { isPlainObject } from './canonical.js';

export { validateCheckpointPayload };

// Builds a checkpoint payload. Empty chains use seq 0 and the zero hash.
export function makeCheckpointPayload({ scope, seq, hash, signedAt, serverKeyId }) {
  return {
    v: 2,
    type: 'checkpoint',
    scope,
    seq: seq || 0,
    hash: seq ? hash : ZERO_HASH,
    signedAt,
    serverKeyId
  };
}

// Document head attestation: a checkpoint with scope 'doc:<docId>', seq = head version and
// hash = head record hash. The server signs it for the document it serves, so a bundle can be
// tied to the server (a ledger checkpoint alone only says where the whole ledger is).
export function makeDocHeadPayload({ docId, headVersion, headRecordHash, signedAt, serverKeyId }) {
  return {
    v: 2,
    type: 'checkpoint',
    scope: 'doc:' + docId,
    seq: headVersion,
    hash: headRecordHash,
    signedAt,
    serverKeyId
  };
}

// Returns { payload, signature }. Throws if the payload is not valid.
export async function signCheckpoint(serverPrivateKey, payload) {
  const v = validateCheckpointPayload(payload);
  if (!v.ok) throw new Error('bad checkpoint: ' + v.error);
  const signature = await signRecord(serverPrivateKey, payload);
  return { payload, signature };
}

// Never throws. Also checks payload.serverKeyId matches the key.
export async function verifyCheckpoint(serverPublicJwk, cp) {
  try {
    if (!isPlainObject(cp) || !isPlainObject(cp.payload) || typeof cp.signature !== 'string') return false;
    if (!validateCheckpointPayload(cp.payload).ok) return false;
    if (cp.payload.serverKeyId !== (await keyIdOf(serverPublicJwk))) return false;
    return await verifyRecord(serverPublicJwk, cp.payload, cp.signature);
  } catch {
    return false;
  }
}
