// POST /api/identities: register a self signed identity.
import { canonicalize } from '../../../shared/canonical.js';
import { LIMITS } from '../../../shared/records.js';
import { json, onlyMethods, rateKeyForRequest, readSignedBody } from '../../_lib/http.js';
import { checkIdentityRecord, loadIdentity } from '../../_lib/identities.js';
import { consumeRate } from '../../_lib/rate.js';
import { assertFresh } from '../../_lib/time.js';

export async function onRequestPost({ request, env }) {
  const { record, signature } = await readSignedBody(request);
  const { publicKey, keyId } = await checkIdentityRecord(record, signature);

  // An identity that is already registered is not an error, and its age does not matter.
  if (await loadIdentity(env, keyId)) return json({ keyId, existed: true });

  const now = Date.now();
  assertFresh(record.createdAt, LIMITS.RECORD_TIME_WINDOW_MS, now, 'identity');
  // Limited per address (an IPv6 /64 counts as one address) and then for the whole service.
  await consumeRate(env, 'identity', rateKeyForRequest(request), now);
  await consumeRate(env, 'identityAll', 'all', now);

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
