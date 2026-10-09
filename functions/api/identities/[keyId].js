// GET /api/identities/:keyId
import { isHash } from '../../../shared/records.js';
import { badRequest, notFound } from '../../_lib/errors.js';
import { json, onlyMethods } from '../../_lib/http.js';
import { loadIdentity } from '../../_lib/identities.js';

export async function onRequestGet({ env, params }) {
  const keyId = params.keyId;
  if (!isHash(keyId)) throw badRequest('keyId must be 64 lowercase hex characters');
  const identity = await loadIdentity(env, keyId);
  if (!identity) throw notFound('identity not found');
  return json(identity);
}

export const onRequest = onlyMethods('GET');
