export async function onRequestGet({ env }) {
  const row = await env.DB.prepare('SELECT 1 AS ok').first();
  await env.FILES.head('does-not-exist');
  return Response.json({ ok: row.ok === 1 });
}
