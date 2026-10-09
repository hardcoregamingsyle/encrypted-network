// GET /api/server-key. The public key that signs checkpoints, so clients can pin its key id.
import { headOf, json, onlyMethods } from '../_lib/http.js';
import { loadServerKey } from '../_lib/serverKey.js';

export async function onRequestGet({ env }) {
  const key = await loadServerKey(env);
  return json({ signing: Boolean(key), keyId: key ? key.keyId : null, publicKey: key ? key.publicJwk : null });
}

export const onRequestHead = headOf(onRequestGet);
export const onRequest = onlyMethods('GET');
