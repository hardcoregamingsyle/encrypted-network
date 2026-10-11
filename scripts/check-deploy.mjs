// Checks a deployed (or local) site after a deploy.
//   node scripts/check-deploy.mjs https://your-site.pages.dev [--key-id <64 hex>]
// Fails (exit 1) when the API is down, when the server signing key is not set, or when the key id is
// not the one you recorded. Without a key the site still works, but nothing it serves is anchored.
//
// Database: health reports schema:false when migration 0003 was not applied (the code is live, the tables are
// not), and the check reads the chat list, which fails with 500 on a database that is behind.
//
// Accounts and email (see scripts/DEPLOY.md): the check FAILS when health reports the local only 'echo'
// mail mode on a site that is not on this machine (anyone could read the sign in codes), and prints a
// WARN line when email sign in or accounts are not switched on.
//
// Record the key id from the first run and pass it as --key-id on later runs. It is also the value
// verifiers should pin.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// True for a site address on this machine.
export function isLocalSite(origin) {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

export async function checkDeploy(base, { expectKeyId = null, fetchImpl = fetch } = {}) {
  const origin = base.replace(/\/+$/, '');
  const results = [];
  const warnings = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });
  const get = async (path, init) => {
    try {
      return await fetchImpl(origin + path, init);
    } catch (err) {
      return { status: 0, error: err.message, headers: new Headers(), json: async () => ({}) };
    }
  };

  const health = await get('/api/health');
  // health answers 503 with a body (schema:false) when the database is behind the code
  const healthBody = health.status === 200 || health.status === 503 ? await health.json().catch(() => ({})) : {};
  add('health answers', health.status === 200 && healthBody.ok === true, 'HTTP ' + health.status + (health.error ? ' ' + health.error : ''));
  add('health reports signing', healthBody.signing === true, 'signing: ' + JSON.stringify(healthBody.signing));
  add('database schema is current (run: npx wrangler d1 migrations apply DB --remote)', healthBody.schema !== false, 'health says schema: false');
  const chats = await get('/api/channels?limit=1');
  add('the chat list answers', chats.status === 200, 'GET /api/channels?limit=1 gave HTTP ' + chats.status + (chats.status === 500 ? ' (the database is probably behind the code)' : ''));

  // Accounts and email. An older server without these fields only gets a warning.
  const local = isLocalSite(origin);
  if (healthBody.ok === true) {
    if (typeof healthBody.mail !== 'string') {
      warnings.push('health does not report mail or accounts (an older version is deployed)');
    } else {
      const echoSeen = healthBody.mail === 'echo' || healthBody.mailConfigured === 'echo';
      add('the local only echo mail mode is not on a real site', local || !echoSeen, 'MAIL_PROVIDER is echo on a site that is not local');
      if (healthBody.accounts !== true) warnings.push('accounts are not switched on (set the secret ACCOUNT_MASTER_KEY)');
      else if (healthBody.mail === 'none') warnings.push('email sign in is not switched on (set MAIL_PROVIDER and its settings), only Quick start works');
      if (healthBody.accounts === true) {
        const me = await get('/api/me');
        add('account routes answer (401 without a session)', me.status === 401, 'HTTP ' + me.status);
      }
    }
  }

  const head = await get('/api/health', { method: 'HEAD' });
  add('HEAD works', head.status === 200, 'HTTP ' + head.status);

  const key = await get('/api/server-key');
  const keyBody = key.status === 200 ? await key.json().catch(() => ({})) : {};
  add('server key is set', keyBody.signing === true && /^[0-9a-f]{64}$/.test(keyBody.keyId || ''), 'signing: ' + JSON.stringify(keyBody.signing));
  if (expectKeyId) add('server key id is the expected one', keyBody.keyId === expectKeyId, 'got ' + keyBody.keyId);

  const missing = await get('/api/this-route-does-not-exist');
  add('unknown API route answers JSON 404', missing.status === 404 && (missing.headers.get('content-type') || '').includes('json'), 'HTTP ' + missing.status);
  add('API answers are not cached', /no-store/.test(health.headers.get('cache-control') || ''), health.headers.get('cache-control') || 'no header');

  const page = await get('/');
  const csp = page.headers.get('content-security-policy') || '';
  add('pages carry the content security policy', page.status === 200 && csp.includes("script-src 'self'"), 'HTTP ' + page.status);

  return { ok: results.every((r) => r.ok), keyId: keyBody.keyId || null, results, warnings };
}

async function main() {
  const args = process.argv.slice(2);
  const base = args.find((a) => !a.startsWith('--'));
  const i = args.indexOf('--key-id');
  const expectKeyId = i >= 0 ? args[i + 1] : null;
  if (!base) {
    console.error('usage: node scripts/check-deploy.mjs <site url> [--key-id <64 hex>]');
    process.exitCode = 2;
    return;
  }
  const out = await checkDeploy(base, { expectKeyId });
  for (const r of out.results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : ': ' + r.detail));
  for (const w of out.warnings) console.log('WARN ' + w);
  if (out.keyId) console.log('server key id: ' + out.keyId);
  process.exitCode = out.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
