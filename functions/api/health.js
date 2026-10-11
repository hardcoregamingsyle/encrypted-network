// GET /api/health. Checks that the database and the file store answer. signing says whether the
// server key is set, so a deploy that forgot the secret is noticed (the site works without it, but
// nothing it serves is anchored by a checkpoint).
import { headOf, json, onlyMethods } from '../_lib/http.js';
import { loadServerKey } from '../_lib/serverKey.js';
import { blobStore } from '../_lib/store.js';

export async function onRequestGet({ env }) {
  await env.DB.prepare('SELECT 1 AS ok').first();
  await blobStore(env).head('health-probe');
  const key = await loadServerKey(env);
  return json({ ok: true, signing: Boolean(key) });
}

export const onRequestHead = headOf(onRequestGet);
export const onRequest = onlyMethods('GET');
