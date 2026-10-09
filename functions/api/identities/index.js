// POST /api/identities: register a self signed identity.
import { canonicalize } from '../../../shared/canonical.js';
import { keyIdOf, normalizePublicJwk, verifyRecord } from '../../../shared/keys.js';
import { LIMITS, validateRecord } from '../../../shared/records.js';
import { ApiError, badRequest } from '../../_lib/errors.js';
import { clientIp, json, onlyMethods, readSignedBody } from '../../_lib/http.js';
import { loadIdentity } from '../../_lib/identities.js';
import { consumeRate } from '../../_lib/rate.js';
import { assertFresh } from '../../_lib/time.js';

export async function onRequestPost({ request, env }) {
  const { record, signature } = await readSignedBody(request);
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
  const keyId = await keyIdOf(publicKey);

  // An identity that is already registered is not an error, and its age does not matter.
  if (await loadIdentity(env, keyId)) return json({ keyId, existed: true });

  const now = Date.now();
  assertFresh(record.createdAt, LIMITS.RECORD_TIME_WINDOW_MS, now, 'identity');
  await consumeRate(env, 'identity', clientIp(request), now);

  const result = await env.DB.prepare(
    'INSERT INTO identities (key_id, public_jwk, display_name, created_at, record, signature) ' +
      'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key_id) DO NOTHING'
  )
    .bind(keyId, canonicalize(publicKey), record.displayName, record.createdAt, canonicalize(record), signature)
    .run();
  // Lost a race with another registration of the same key: the first one stays.
  if (result.meta && result.meta.changes === 0) return json({ keyId, existed: true });
  return json({ keyId }, 201);
}

export const onRequest = onlyMethods('POST');
