// Local setup.
//   node scripts/setup-dev.mjs [--persist-to <dir>]   make .dev.vars (if needed) and apply local migrations
//   node scripts/setup-dev.mjs --print-production-key  print a fresh private key JSON (stdout only)
//
// For production keep the printed key out of files and set it as a secret:
//   node scripts/setup-dev.mjs --print-production-key | npx wrangler pages secret put SERVER_SIGNING_JWK
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPrivateJwk, generateKeyPair, keyIdOf, publicJwkFromPrivate } from '../shared/keys.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VARS_FILE = join(ROOT, '.dev.vars');
const VAR_NAME = 'SERVER_SIGNING_JWK';

async function freshPrivateJwk() {
  const { privateKey } = await generateKeyPair({ extractable: true });
  return exportPrivateJwk(privateKey);
}

function parseArgs(argv) {
  const out = { persistTo: null, printKey: false, noMigrate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--persist-to') {
      out.persistTo = argv[++i];
      if (!out.persistTo) throw new Error('--persist-to needs a directory');
    } else if (a === '--print-production-key') {
      out.printKey = true;
    } else if (a === '--no-migrate') {
      out.noMigrate = true;
    } else {
      throw new Error('unknown argument ' + a);
    }
  }
  return out;
}

// Finds the value of the variable in the text of a .dev.vars file, or null.
function readVar(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(new RegExp('^\\s*(?:export\\s+)?' + name + '\\s*=\\s*(.*)$'));
    if (!m) continue;
    let value = m[1].trim();
    if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
}

async function ensureDevVars() {
  let text = existsSync(VARS_FILE) ? readFileSync(VARS_FILE, 'utf8') : '';
  let value = readVar(text, VAR_NAME);
  if (value === null) {
    const jwk = await freshPrivateJwk();
    value = JSON.stringify(jwk);
    // Single quotes keep the JSON on one line exactly as written.
    const line = `${VAR_NAME}='${value}'\n`;
    text = text === '' || text.endsWith('\n') ? text + line : text + '\n' + line;
    writeFileSync(VARS_FILE, text, 'utf8');
    console.log('created ' + VAR_NAME + ' in .dev.vars');
  } else {
    console.log(VAR_NAME + ' already present in .dev.vars, left as it is');
  }
  return value;
}

function applyMigrations(persistTo) {
  const wrangler = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const args = [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local'];
  if (persistTo) args.push('--persist-to', persistTo);
  const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CI: '1' } });
  if (run.status !== 0) throw new Error('applying migrations failed');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.printKey) {
    process.stdout.write(JSON.stringify(await freshPrivateJwk()) + '\n');
    return;
  }
  const value = await ensureDevVars();
  try {
    const keyId = await keyIdOf(publicJwkFromPrivate(JSON.parse(value)));
    console.log('server key id: ' + keyId);
  } catch {
    console.log('warning: ' + VAR_NAME + ' in .dev.vars is not a usable private key');
  }
  if (!opts.noMigrate) applyMigrations(opts.persistTo);
}

main().catch((err) => {
  console.error('setup failed: ' + err.message);
  process.exit(1);
});
