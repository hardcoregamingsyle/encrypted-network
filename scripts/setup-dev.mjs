// Local setup.
//   node scripts/setup-dev.mjs [--persist-to <dir>]   make .dev.vars (if needed) and apply local migrations
//   node scripts/setup-dev.mjs --write-production-key <file>   make a production signing key and save it to <file>
//   node scripts/setup-dev.mjs --print-production-key          print a fresh private key JSON (stdout only)
//
// The server signing key can not be read back once it is stored as a Cloudflare secret, and a new key
// has a new key id, which breaks every verifier that pinned the old one. So make the key once, into a
// file, keep that file offline (a password manager, an encrypted drive), and only then store the secret:
//   node scripts/setup-dev.mjs --write-production-key server-key.json
//   npx wrangler pages secret put SERVER_SIGNING_JWK --project-name <project> < server-key.json
//   node scripts/check-deploy.mjs https://<site> --key-id <the id printed above>
//
// Accounts (sign in with email): the first run also adds ACCOUNT_MASTER_KEY (a random 32 byte key, base64)
// and MAIL_PROVIDER=echo to .dev.vars when they are missing. Values that are already there are never
// changed, and no secret is printed. echo sends no email: the code comes back in the API answer, and only
// on localhost. For a real site make the master key with scripts/make-master-key.mjs (see DEPLOY.md).
//
// Do the secret for the Preview environment too if you use preview deployments (secrets are per
// environment). Do not commit the file. Piping --print-production-key straight into wrangler leaves no copy.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPrivateJwk, generateKeyPair, keyIdOf, publicJwkFromPrivate } from '../shared/keys.js';
import { parseMasterKey } from '../functions/_lib/atRest.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// HRD_DEV_VARS lets a test point this script at a scratch file instead of the real .dev.vars.
const VARS_FILE = process.env.HRD_DEV_VARS ? resolve(process.env.HRD_DEV_VARS) : join(ROOT, '.dev.vars');
const VAR_NAME = 'SERVER_SIGNING_JWK';

async function freshPrivateJwk() {
  const { privateKey } = await generateKeyPair({ extractable: true });
  return exportPrivateJwk(privateKey);
}

function parseArgs(argv) {
  const out = { persistTo: null, printKey: false, keyFile: null, noMigrate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--persist-to') {
      out.persistTo = argv[++i];
      if (!out.persistTo) throw new Error('--persist-to needs a directory');
    } else if (a === '--write-production-key') {
      out.keyFile = argv[++i];
      if (!out.keyFile) throw new Error('--write-production-key needs a file name');
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

function appendLine(text, line) {
  const eol = '\n';
  return text === '' || text.endsWith(eol) ? text + line + eol : text + eol + line + eol;
}

function freshMasterKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Makes sure the file at `file` has the three local variables. Existing values are never touched and
// nothing secret is printed. Returns { value, created } where value is the server signing key text.
export async function ensureDevVarsAt(file, log = console.log) {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const created = [];

  let value = readVar(text, VAR_NAME);
  if (value === null) {
    const jwk = await freshPrivateJwk();
    value = JSON.stringify(jwk);
    // Single quotes keep the JSON on one line exactly as written.
    text = appendLine(text, `${VAR_NAME}='${value}'`);
    created.push(VAR_NAME);
    log('created ' + VAR_NAME + ' in .dev.vars');
  } else {
    log(VAR_NAME + ' already present in .dev.vars, left as it is');
  }

  const master = readVar(text, 'ACCOUNT_MASTER_KEY');
  if (master === null) {
    text = appendLine(text, 'ACCOUNT_MASTER_KEY=' + freshMasterKey());
    created.push('ACCOUNT_MASTER_KEY');
    log('created ACCOUNT_MASTER_KEY in .dev.vars');
  } else {
    log('ACCOUNT_MASTER_KEY already present in .dev.vars, left as it is');
    if (parseMasterKey(master) === null) log('warning: ACCOUNT_MASTER_KEY in .dev.vars is not base64 of 32 bytes (or looks like a placeholder), accounts will be off');
  }

  if (readVar(text, 'MAIL_PROVIDER') === null) {
    text = appendLine(text, 'MAIL_PROVIDER=echo');
    created.push('MAIL_PROVIDER');
    log('set MAIL_PROVIDER=echo in .dev.vars (local development only: no email is sent, the code is returned by the API)');
  } else {
    log('MAIL_PROVIDER already present in .dev.vars, left as it is');
  }

  if (created.length > 0) writeFileSync(file, text, 'utf8');
  return { value, created };
}

async function ensureDevVars() {
  return (await ensureDevVarsAt(VARS_FILE)).value;
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
  if (opts.keyFile) {
    // wx: fail when the file exists, so an old key is never overwritten by accident. mode 600: owner only.
    const jwk = await freshPrivateJwk();
    try {
      writeFileSync(resolve(opts.keyFile), JSON.stringify(jwk) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err && err.code === 'EEXIST') throw new Error(opts.keyFile + ' already exists, it was not changed');
      throw err;
    }
    const keyId = await keyIdOf(publicJwkFromPrivate(jwk));
    console.log('wrote the private key to ' + opts.keyFile);
    console.log('server key id: ' + keyId);
    console.log('Keep a copy of the file somewhere safe and offline. It is the only copy: stored secrets can not be read back.');
    console.log('Next, in bash:       npx wrangler pages secret put SERVER_SIGNING_JWK --project-name <project> < ' + opts.keyFile);
    console.log('Next, in PowerShell: Get-Content ' + opts.keyFile + ' -Raw | npx wrangler pages secret put SERVER_SIGNING_JWK --project-name <project>');
    return;
  }
  if (opts.printKey) {
    console.error('note: this prints the private key and keeps no copy. Use --write-production-key <file> to keep one.');
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('setup failed: ' + err.message);
    process.exit(1);
  });
}
