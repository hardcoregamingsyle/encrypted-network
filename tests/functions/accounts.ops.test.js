// Operator side of accounts: health fields, the deploy check, the dev setup file, the master key script,
// and a scan for words and characters that must not appear.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMasterKey } from '../../functions/_lib/atRest.js';
import { checkDeploy, isLocalSite } from '../../scripts/check-deploy.mjs';
import { newMasterKeyText, writeMasterKeyFile } from '../../scripts/make-master-key.mjs';
import { ensureDevVarsAt } from '../../scripts/setup-dev.mjs';
import { accountEnv, callApi, masterKeyText } from './fakes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('GET /api/health', () => {
  const RESEND = { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', MAIL_FROM: 'a@example.test' };

  it('reports signing, mail and accounts', async () => {
    const off = accountEnv({ env: { ACCOUNT_MASTER_KEY: undefined, MAIL_PROVIDER: undefined } });
    expect((await callApi(off.env, 'GET', '/api/health')).json).toEqual({ ok: true, schema: true, signing: false, mail: 'none', mailConfigured: 'none', accounts: false });
    const on = accountEnv({ env: RESEND });
    expect((await callApi(on.env, 'GET', '/api/health', { base: 'https://hrdlock.example' })).json).toEqual({
      ok: true,
      schema: true,
      signing: false,
      mail: 'resend',
      mailConfigured: 'resend',
      accounts: true
    });
  });

  it('mail is none when accounts are off, even if a provider is set (no code could be used)', async () => {
    const { env } = accountEnv({ env: { ...RESEND, ACCOUNT_MASTER_KEY: undefined } });
    const body = (await callApi(env, 'GET', '/api/health')).json;
    expect(body.accounts).toBe(false);
    expect(body.mail).toBe('none');
    expect(body.mailConfigured).toBe('resend');
  });

  it('echo shows as echo on a local request and as none (but configured) anywhere else', async () => {
    const { env } = accountEnv();
    const local = (await callApi(env, 'GET', '/api/health')).json;
    expect(local).toMatchObject({ mail: 'echo', mailConfigured: 'echo', accounts: true });
    const remote = (await callApi(env, 'GET', '/api/health', { base: 'https://hrdlock.example', ip: '203.0.113.9' })).json;
    expect(remote).toMatchObject({ mail: 'none', mailConfigured: 'echo', accounts: true });
    const viaEdge = (await callApi(env, 'GET', '/api/health', { ip: '203.0.113.9' })).json;
    expect(viaEdge.mail).toBe('none');
  });

  it('never carries a secret', async () => {
    const { env } = accountEnv({ env: { ...RESEND, RESEND_API_KEY: 're_super_secret_key', MAIL_FROM: 'secret-sender@example.test' } });
    const res = await callApi(env, 'GET', '/api/health');
    expect(res.text).not.toMatch(/re_super_secret_key|secret-sender|ACCOUNT_MASTER/);
    expect(res.text).not.toContain(env.ACCOUNT_MASTER_KEY);
  });

  it('HEAD works', async () => {
    const { env } = accountEnv();
    const res = await callApi(env, 'HEAD', '/api/health');
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
  });
});

describe('deploy check, accounts part', () => {
  function site(health, { me = 401, extra = {} } = {}) {
    return async (url, init = {}) => {
      const path = new URL(url).pathname;
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      if (path === '/api/health') return init.method === 'HEAD' ? new Response(null, { status: 200 }) : json({ ok: true, signing: true, ...health });
      if (path === '/api/server-key') return json({ signing: true, keyId: 'c'.repeat(64), publicKey: {} });
      if (path === '/api/me') return json({ error: 'sign in first', code: 'unauthenticated' }, me);
      if (path === '/') return new Response('<html></html>', { status: 200, headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'" } });
      if (extra[path]) return extra[path]();
      if (path === '/api/channels') return json({ channels: [] });
      return json({ error: 'no such API route', code: 'not_found' }, 404);
    };
  }
  const names = (out) => out.results.filter((r) => !r.ok).map((r) => r.name);

  it('FAILS when the database is behind the code (health says schema false, the chat list answers 500)', async () => {
    const behind = site({ mail: 'resend', mailConfigured: 'resend', accounts: true, schema: false });
    const out = await checkDeploy('https://hrdlock.example', { fetchImpl: behind });
    expect(out.ok).toBe(false);
    expect(names(out)).toContain('database schema is current (run: npx wrangler d1 migrations apply DB --remote)');
    const chats500 = site({ mail: 'resend', mailConfigured: 'resend', accounts: true }, { extra: { '/api/channels': () => new Response('{"code":"server_error"}', { status: 500, headers: { 'Content-Type': 'application/json' } }) } });
    const out2 = await checkDeploy('https://hrdlock.example', { fetchImpl: chats500 });
    expect(out2.ok).toBe(false);
    expect(names(out2)).toContain('the chat list answers');
  });

  it('passes with email and accounts on, and has no warning', async () => {
    const out = await checkDeploy('https://hrdlock.example', { fetchImpl: site({ mail: 'resend', mailConfigured: 'resend', accounts: true }) });
    expect(out.ok).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  it('FAILS when mail is echo on a site that is not local, also when only the setting says echo', async () => {
    for (const health of [
      { mail: 'echo', mailConfigured: 'echo', accounts: true },
      { mail: 'none', mailConfigured: 'echo', accounts: true },
      { mail: 'echo', accounts: true }
    ]) {
      const out = await checkDeploy('https://hrdlock.example', { fetchImpl: site(health) });
      expect(out.ok, JSON.stringify(health)).toBe(false);
      expect(names(out)).toContain('the local only echo mail mode is not on a real site');
    }
    const out = await checkDeploy('https://hrdlock.pages.dev', { fetchImpl: site({ mail: 'echo', mailConfigured: 'echo', accounts: true }) });
    expect(out.ok).toBe(false);
  });

  it('passes echo on this machine', async () => {
    for (const base of ['http://localhost:8800', 'http://127.0.0.1:8800', 'http://[::1]:8800']) {
      const out = await checkDeploy(base, { fetchImpl: site({ mail: 'echo', mailConfigured: 'echo', accounts: true }) });
      expect(names(out), base).not.toContain('the local only echo mail mode is not on a real site');
    }
    expect(isLocalSite('http://localhost:1')).toBe(true);
    expect(isLocalSite('https://localhost.evil.test')).toBe(false);
    expect(isLocalSite('https://hrdlock.example')).toBe(false);
    expect(isLocalSite('not a url')).toBe(false);
  });

  it('WARNS when mail is none or accounts are off, without failing', async () => {
    const none = await checkDeploy('https://hrdlock.example', { fetchImpl: site({ mail: 'none', mailConfigured: 'none', accounts: true }) });
    expect(none.ok).toBe(true);
    expect(none.warnings.join(' ')).toMatch(/email sign in is not switched on/);
    const off = await checkDeploy('https://hrdlock.example', { fetchImpl: site({ mail: 'none', mailConfigured: 'resend', accounts: false }, { me: 503 }) });
    expect(off.ok).toBe(true);
    expect(off.warnings.join(' ')).toMatch(/accounts are not switched on/);
  });

  it('WARNS (does not fail) on an older server without the new fields', async () => {
    const out = await checkDeploy('https://hrdlock.example', { fetchImpl: site({}) });
    expect(out.ok).toBe(true);
    expect(out.warnings.join(' ')).toMatch(/older version/);
  });

  it('fails when accounts are on but the account routes do not answer 401', async () => {
    for (const me of [200, 404, 500]) {
      const out = await checkDeploy('https://hrdlock.example', { fetchImpl: site({ mail: 'resend', mailConfigured: 'resend', accounts: true }, { me }) });
      expect(out.ok, String(me)).toBe(false);
      expect(names(out)).toContain('account routes answer (401 without a session)');
    }
  });
});

describe('.dev.vars setup', () => {
  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'hrdvars-'));
    return { dir, file: join(dir, '.dev.vars') };
  }
  const quiet = () => {};

  it('creates the three variables in a missing file, and the master key is a valid key', async () => {
    const { dir, file } = scratch();
    try {
      const out = await ensureDevVarsAt(file, quiet);
      expect(out.created).toEqual(['SERVER_SIGNING_JWK', 'ACCOUNT_MASTER_KEY', 'MAIL_PROVIDER']);
      const text = readFileSync(file, 'utf8');
      expect(text).toMatch(/^SERVER_SIGNING_JWK='\{.*\}'$/m);
      expect(text).toMatch(/^MAIL_PROVIDER=echo$/m);
      const master = text.match(/^ACCOUNT_MASTER_KEY=(.*)$/m)[1];
      expect(parseMasterKey(master)).toHaveLength(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds only what is missing and never changes a value that is there', async () => {
    const { dir, file } = scratch();
    try {
      const mine = masterKeyText();
      const original = `SERVER_SIGNING_JWK='{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"}'\nACCOUNT_MASTER_KEY=${mine}\nMAIL_PROVIDER=resend\nRESEND_API_KEY=abc\n`;
      writeFileSync(file, original);
      const out = await ensureDevVarsAt(file, quiet);
      expect(out.created).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe(original);

      writeFileSync(file, `ACCOUNT_MASTER_KEY=${mine}\nOTHER=1`);
      const second = await ensureDevVarsAt(file, quiet);
      expect(second.created).toEqual(['SERVER_SIGNING_JWK', 'MAIL_PROVIDER']);
      const text = readFileSync(file, 'utf8');
      expect(text.startsWith(`ACCOUNT_MASTER_KEY=${mine}\nOTHER=1\n`)).toBe(true);
      // running again changes nothing
      const again = await ensureDevVarsAt(file, quiet);
      expect(again.created).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite a master key that is empty or malformed, but says so without printing it', async () => {
    const { dir, file } = scratch();
    try {
      writeFileSync(file, 'ACCOUNT_MASTER_KEY=not-a-real-key-value-123\nMAIL_PROVIDER=\n');
      const lines = [];
      await ensureDevVarsAt(file, (l) => lines.push(l));
      expect(readFileSync(file, 'utf8')).toMatch(/^ACCOUNT_MASTER_KEY=not-a-real-key-value-123$/m);
      expect(readFileSync(file, 'utf8')).toMatch(/^MAIL_PROVIDER=$/m);
      expect(lines.join('\n')).toMatch(/not base64 of 32 bytes/);
      expect(lines.join('\n')).not.toContain('not-a-real-key-value-123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints no secret while creating', async () => {
    const { dir, file } = scratch();
    try {
      const lines = [];
      await ensureDevVarsAt(file, (l) => lines.push(l));
      const text = readFileSync(file, 'utf8');
      const secrets = [text.match(/^ACCOUNT_MASTER_KEY=(.*)$/m)[1], JSON.parse(text.match(/^SERVER_SIGNING_JWK='(.*)'$/m)[1]).d];
      for (const s of secrets) expect(lines.join('\n')).not.toContain(s);
      expect(lines.join('\n')).toMatch(/MAIL_PROVIDER=echo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the script itself, run with --no-migrate on a scratch file, writes the file and prints no secret', () => {
    const { dir, file } = scratch();
    try {
      const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'setup-dev.mjs'), '--no-migrate'], { encoding: 'utf8', env: { ...process.env, HRD_DEV_VARS: file } });
      expect(run.status).toBe(0);
      const text = readFileSync(file, 'utf8');
      const master = text.match(/^ACCOUNT_MASTER_KEY=(.*)$/m)[1];
      expect(run.stdout + run.stderr).not.toContain(master);
      expect(run.stdout).toMatch(/created ACCOUNT_MASTER_KEY/);
      const second = spawnSync(process.execPath, [join(ROOT, 'scripts', 'setup-dev.mjs'), '--no-migrate'], { encoding: 'utf8', env: { ...process.env, HRD_DEV_VARS: file } });
      expect(second.stdout).toMatch(/ACCOUNT_MASTER_KEY already present/);
      expect(readFileSync(file, 'utf8')).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('make-master-key script', () => {
  it('writes base64 of 32 random bytes once and refuses to overwrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hrdmk-'));
    try {
      const file = join(dir, 'master.txt');
      const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-master-key.mjs'), ...args], { encoding: 'utf8' });
      const first = run('--write-production-key', file);
      expect(first.status).toBe(0);
      const key = readFileSync(file, 'utf8');
      expect(parseMasterKey(key)).toHaveLength(32);
      expect(key.trim()).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      // nothing secret is printed
      expect(first.stdout + first.stderr).not.toContain(key.trim());
      expect(first.stdout).toMatch(/wrote the account master key/);
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
      const second = run('--write-production-key', file);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toMatch(/already exists/);
      expect(readFileSync(file, 'utf8')).toBe(key);
      // two runs make two different keys
      const other = join(dir, 'other.txt');
      expect(run('--write-production-key', other).status).toBe(0);
      expect(readFileSync(other, 'utf8')).not.toBe(key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('needs exactly the flag and a file name', () => {
    const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-master-key.mjs'), ...args], { encoding: 'utf8' });
    for (const args of [[], ['--write-production-key'], ['--print-production-key'], ['file.txt'], ['--write-production-key', '--other'], ['--write-production-key', 'a', 'b']]) {
      const r = run(...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stdout).toBe('');
    }
    expect(existsSync(join(ROOT, 'file.txt'))).toBe(false);
  });

  it('writeMasterKeyFile throws a plain error when the file exists or the folder is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hrdmk-'));
    try {
      const file = join(dir, 'k.txt');
      writeMasterKeyFile(file);
      expect(() => writeMasterKeyFile(file)).toThrow(/already exists/);
      expect(() => writeMasterKeyFile(join(dir, 'missing', 'k.txt'))).toThrow(/could not write/);
      mkdirSync(join(dir, 'sub'));
      expect(newMasterKeyText()).not.toBe(newMasterKeyText());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('deploy notes, accounts section', () => {
  const notes = readFileSync(join(ROOT, 'scripts', 'DEPLOY.md'), 'utf8');
  it('name every setting and the rules an operator must know', () => {
    for (const word of ['ACCOUNT_MASTER_KEY', 'MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'BREVO_API_KEY', 'CF_ACCOUNT_ID', 'CF_EMAIL_TOKEN', 'make-master-key', 'echo', 'Easy', 'Strict', 'mail_unavailable', 'x-hrd-test-now', 'Origin']) {
      expect(notes, word).toContain(word);
    }
    expect(notes).toMatch(/NEVER set\s+`echo`/);
    expect(notes).toMatch(/not stored/i);
  });
});

describe('hygiene of the account code', () => {
  // built from pieces so that this file does not hold the words either
  const banned = new RegExp('\\b(' + ['A' + 'I', 'assist' + 'ant', 'Cl' + 'aude', 'Anthr' + 'opic', 'Open' + 'A' + 'I', 'G' + 'PT', 'L' + 'LM'].join('|') + ')\\b');
  const dash = new RegExp(String.fromCodePoint(0x2014) + '|' + String.fromCodePoint(0x2013));
  const emoji = /\p{Extended_Pictographic}/u;

  function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(js|mjs|sql|md)$/.test(name)) out.push(full);
    }
    return out;
  }

  const files = [
    ...walk(join(ROOT, 'functions')),
    join(ROOT, 'migrations', '0003_accounts.sql'),
    join(ROOT, 'scripts', 'make-master-key.mjs'),
    join(ROOT, 'scripts', 'setup-dev.mjs'),
    join(ROOT, 'scripts', 'check-deploy.mjs'),
    join(ROOT, 'scripts', 'e2e.mjs'),
    join(ROOT, 'scripts', 'DEPLOY.md')
  ];

  it('no long dashes, no emojis, no tool or vendor names in code, comments or notes', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(dash);
      expect(text, f).not.toMatch(emoji);
      expect(text, f).not.toMatch(banned);
    }
  });

  it('no secret is logged: the account code never passes a code, key, token or address to console', () => {
    for (const f of walk(join(ROOT, 'functions'))) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/console\.(log|error|warn|info|debug)\(([^;]*)\)/g)) {
        expect(m[2], f + ': ' + m[0]).not.toMatch(/\b(code|token|email|password|privateJwk|key|body|record)\b(?!\s*could|\s*is)/i);
      }
    }
  });

  it('bindings and settings come from wrangler.toml and the environment only (no remote calls except the mail providers)', () => {
    for (const f of walk(join(ROOT, 'functions'))) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/https?:\/\/[a-z0-9.-]+/gi)) {
        expect(['https://api.resend.com', 'https://api.brevo.com', 'https://api.cloudflare.com'], f + ' ' + m[0]).toContain(m[0]);
      }
    }
  });
});
