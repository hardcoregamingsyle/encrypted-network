// Operator takedown of one stored locked file.
//   node scripts/takedown.mjs <blobHash> --reason "text" --remote
//   node scripts/takedown.mjs <blobHash> --reason "text" --local [--persist-to <dir>]
//   add --dry-run to print the commands without running them
//
// What it does, in this order:
//   1. records the hash in blocked_blobs, so the same bytes can not be uploaded again
//   2. removes the blobs row (the stored byte count goes down with it)
//   3. deletes the stored file from the KV namespace (binding BLOBS)
// What it does NOT do: it never touches the ledger or any document record. Records are signed
// history. A document that pointed at this file keeps its record, but the file can no longer be
// fetched, so "unlock and verify the file" will fail for it. Say so to the people concerned.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function parse(argv) {
  const out = { hash: '', reason: '', remote: false, local: false, persistTo: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reason') out.reason = argv[++i] || '';
    else if (a === '--remote') out.remote = true;
    else if (a === '--local') out.local = true;
    else if (a === '--persist-to') out.persistTo = argv[++i] || '';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else if (!out.hash) out.hash = a;
    else throw new Error('unexpected argument ' + a);
  }
  return out;
}

// Builds the three wrangler argument lists. Pure, so it can be tested.
export function planTakedown({ hash, reason, remote, local, persistTo }) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('the hash must be 64 lowercase hex characters');
  if (remote === local) throw new Error('say exactly one of --remote or --local');
  const text = String(reason || '').trim();
  if (!text) throw new Error('--reason is required');
  if (text.length > 200) throw new Error('--reason is at most 200 characters');
  // Printable ASCII only, quotes doubled. The value goes into one SQL string literal.
  if (!/^[\x20-\x7e]+$/.test(text)) throw new Error('--reason may only use plain printable characters');
  const quoted = text.replace(/'/g, "''");
  const target = remote ? ['--remote'] : ['--local', ...(persistTo ? ['--persist-to', persistTo] : [])];
  const sql = (command) => ['d1', 'execute', 'DB', ...target, '--command', command];
  return [
    sql(`INSERT OR REPLACE INTO blocked_blobs (hash, reason, created_at) VALUES ('${hash}', '${quoted}', ${Date.now()})`),
    sql(`DELETE FROM blobs WHERE hash = '${hash}'`),
    ['kv', 'key', 'delete', `blobs/${hash}`, '--binding', 'BLOBS', ...target]
  ];
}

function main() {
  const opts = parse(process.argv.slice(2));
  const steps = planTakedown(opts);
  for (const args of steps) {
    console.log('wrangler ' + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '));
    if (opts.dryRun) continue;
    const run = spawnSync(process.execPath, [WRANGLER, ...args], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CI: '1' } });
    if (run.status !== 0) throw new Error('step failed, stop here and look at the message above');
  }
  console.log(opts.dryRun ? 'dry run only, nothing was changed' : 'done: the file is gone and can not be uploaded again');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error('takedown failed: ' + err.message);
    process.exit(1);
  }
}
