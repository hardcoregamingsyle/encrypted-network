// Checks a deployed (or local) site after a deploy.
//   node scripts/check-deploy.mjs https://your-site.pages.dev [--key-id <64 hex>]
// Fails (exit 1) when the API is down, when the server signing key is not set, or when the key id is
// not the one you recorded. Without a key the site still works, but nothing it serves is anchored.
//
// Record the key id from the first run and pass it as --key-id on later runs. It is also the value
// verifiers should pin.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkDeploy(base, { expectKeyId = null, fetchImpl = fetch } = {}) {
  const origin = base.replace(/\/+$/, '');
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });
  const get = async (path, init) => {
    try {
      return await fetchImpl(origin + path, init);
    } catch (err) {
      return { status: 0, error: err.message, headers: new Headers(), json: async () => ({}) };
    }
  };

  const health = await get('/api/health');
  const healthBody = health.status === 200 ? await health.json().catch(() => ({})) : {};
  add('health answers', health.status === 200 && healthBody.ok === true, 'HTTP ' + health.status + (health.error ? ' ' + health.error : ''));
  add('health reports signing', healthBody.signing === true, 'signing: ' + JSON.stringify(healthBody.signing));

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

  return { ok: results.every((r) => r.ok), keyId: keyBody.keyId || null, results };
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
  if (out.keyId) console.log('server key id: ' + out.keyId);
  process.exitCode = out.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
