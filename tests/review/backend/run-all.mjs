// Runs every attack script in this folder against one server and prints a summary.
// node tests/review/backend/run-all.mjs http://127.0.0.1:8791 [--heavy]
// --heavy also runs blobquota.mjs (about 620 MiB of uploads). invariants.mjs always runs last.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] || 'http://127.0.0.1:8791';
const heavy = process.argv.includes('--heavy');
const scripts = ['auth', 'chain', 'ledger', 'inject', 'input', 'blobs', 'rate', 'leaks', 'channelspam', 'channelcost', 'multiisolate', 'accounts'];
if (heavy) scripts.push('blobquota');
scripts.push('invariants');

let bad = 0;
for (const name of scripts) {
  const r = spawnSync(process.execPath, [join(dir, name + '.mjs'), base], { encoding: 'utf8' });
  const lines = (r.stdout || '').split('\n');
  const fails = lines.filter((l) => l.startsWith('FAIL'));
  console.log(`${name}: exit ${r.status}, ${fails.length} FAIL`);
  for (const f of fails) console.log('  ' + f.slice(0, 220));
  if (r.status !== 0) bad++;
}
console.log(`\n${bad} of ${scripts.length} scripts found defects`);
process.exit(bad ? 1 : 0);
