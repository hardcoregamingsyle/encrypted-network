// GET /api/health. Checks that the database and the file store answer.
//   signing   whether the server key is set (the site works without it, but nothing it serves is anchored)
//   mail      how sign in codes go out for THIS request: none, resend, brevo, cloudflare or echo (local only).
//             It is none when accounts are not switched on, because then no code can be used.
//   mailConfigured  what MAIL_PROVIDER asks for, before the echo guard (so a deploy check can notice an
//             echo setting on a real host, where mail itself reads none)
//   accounts  whether ACCOUNT_MASTER_KEY is set and well formed
//   schema    whether the database has every table and column the code reads (all migrations applied).
//             When it has not, ok is false and the answer is 503: the code is live but the migration is
//             not, and the chat list and sign in would fail with 500 while everything else looked fine.
import { accountsConfigured } from '../_lib/atRest.js';
import { headOf, json, onlyMethods } from '../_lib/http.js';
import { configuredProvider, mailMode } from '../_lib/mail.js';
import { loadServerKey } from '../_lib/serverKey.js';
import { blobStore } from '../_lib/store.js';

// One cheap read of each thing the migrations 0003 to 0006 added, in one round trip. Each reads at most one row.
export const SCHEMA_PROBES = Object.freeze([
  'SELECT last_text, last_signer_name FROM channels LIMIT 1',
  'SELECT email_hash, code_hash, expires_at, attempts, created_at FROM otp_codes LIMIT 1',
  'SELECT token_hash, account_id, created_at, expires_at, last_seen_at FROM sessions LIMIT 1',
  'SELECT id, email_hash, email_masked, display_name, strict FROM accounts LIMIT 1',
  'SELECT key_id, account_id, wrapped_private FROM account_keys LIMIT 1',
  'SELECT account_id, doc_id, wrapped FROM account_secrets LIMIT 1',
  'SELECT id, account_id, label, size, blob_hash, signer, signed_at, signature FROM private_files LIMIT 1',
  'SELECT files_check FROM accounts LIMIT 1',
  'SELECT viewable FROM documents LIMIT 1',
  'SELECT sealed FROM channels LIMIT 1',
  'SELECT channel_id, account_id FROM channel_members LIMIT 1'
]);

async function schemaIsCurrent(env) {
  try {
    await env.DB.batch(SCHEMA_PROBES.map((sql) => env.DB.prepare(sql)));
    return true;
  } catch {
    return false;
  }
}

export async function onRequestGet({ env, request }) {
  await env.DB.prepare('SELECT 1 AS ok').first();
  const schema = await schemaIsCurrent(env);
  await blobStore(env).head('health-probe');
  const key = await loadServerKey(env);
  const accounts = accountsConfigured(env);
  return json(
    {
      ok: schema,
      schema,
      signing: Boolean(key),
      mail: accounts ? mailMode(env, request) : 'none',
      mailConfigured: configuredProvider(env),
      accounts
    },
    schema ? 200 : 503
  );
}

export const onRequestHead = headOf(onRequestGet);
export const onRequest = onlyMethods('GET');
