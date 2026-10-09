// GET /api/health. Checks that the database and the file store answer.
import { json, onlyMethods } from '../_lib/http.js';

export async function onRequestGet({ env }) {
  await env.DB.prepare('SELECT 1 AS ok').first();
  await env.FILES.head('health-probe');
  return json({ ok: true });
}

export const onRequest = onlyMethods('GET');
