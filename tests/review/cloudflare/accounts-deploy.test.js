// Review r5: deployability of the accounts code on Cloudflare Pages (free plan in mind).
// Checks that run without a Cloudflare account. A test written with it.fails demonstrates a problem
// that is still open: it passes while the problem exists and starts failing when it is fixed, then
// it should become a normal test (see the r5 report for each one).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../../../shared/encoding.js';
import { atRest } from '../../../functions/_lib/atRest.js';
import { meDocumentsSql } from '../../../functions/api/me/documents.js';
import { clearCookie, cookiePlan, readSessionToken, requireSameOrigin, sessionCookie } from '../../../functions/_lib/session.js';
import { Jar, accountEnv, callApi, makeKey, randomDocId, signIn } from '../../functions/fakes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const MIGRATION = read('migrations/0003_accounts.sql');

// ---------------------------------------------------------------------------------------------
describe('migration 0003 can be applied to the live database', () => {
  const statements = MIGRATION.replace(/--.*$/gm, '')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

  it('is only additive: no statement reads or rewrites rows that already exist', () => {
    // CREATE TABLE / CREATE INDEX on a table made in the same file / CREATE TRIGGER / ALTER TABLE ADD COLUMN.
    const madeHere = new Set(statements.filter((s) => /^CREATE TABLE/i.test(s)).map((s) => /^CREATE TABLE (\w+)/i.exec(s)[1]));
    for (const s of statements) {
      expect(s, s).not.toMatch(/^(UPDATE|DELETE|INSERT|DROP|REPLACE|VACUUM|REINDEX|ANALYZE)\b/i);
      if (/^CREATE (UNIQUE )?INDEX/i.test(s)) expect(madeHere.has(/ ON (\w+)/i.exec(s)[1]), s).toBe(true);
      if (/^ALTER TABLE/i.test(s)) {
        // a constant default means SQLite does not touch the existing rows
        expect(s).toMatch(/^ALTER TABLE channels ADD COLUMN \w+ TEXT NOT NULL DEFAULT ''$/i);
      }
    }
  });

  it('puts tables before the indexes and triggers that use them, and the ALTERs last', () => {
    const at = (re) => statements.findIndex((s) => re.test(s));
    expect(at(/CREATE TABLE account_keys/)).toBeLessThan(at(/CREATE UNIQUE INDEX account_keys_one_copy/));
    expect(at(/CREATE TABLE account_keys/)).toBeLessThan(at(/CREATE TRIGGER account_keys_max/));
    expect(at(/CREATE TABLE sessions/)).toBeLessThan(at(/CREATE INDEX sessions_account/));
    const firstAlter = at(/^ALTER TABLE/i);
    expect(statements.slice(firstAlter).every((s) => /^ALTER TABLE/i.test(s))).toBe(true);
  });

  // The local D1 runner of wrangler is the same SQLite engine as D1. This runs 0001, 0002, data, 0003
  // on node:sqlite with the same statements the runner sends, and checks the trigger and the partial index.
  it('works with triggers present: ALTER ADD COLUMN, the key limit trigger, the one copy index', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(read('migrations/0001_init.sql'));
    db.exec(read('migrations/0002_hardening.sql'));
    db.prepare("INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES ('h', 10, 'u', 1, 0)").run();
    db.prepare("INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, record, signature) VALUES ('c1', 't', '', 'k', 1, '{}', 's')").run();
    db.exec(MIGRATION);
    expect(db.prepare('SELECT bytes FROM blob_totals').get().bytes).toBe(10); // the old triggers still work
    const ch = db.prepare('SELECT last_text, last_signer_name FROM channels').get();
    expect({ ...ch }).toEqual({ last_text: '', last_signer_name: '' });
    const add = (k, a, w) => db.prepare('INSERT INTO account_keys (key_id, account_id, wrapped_private, created_at) VALUES (?, ?, ?, 1)').run(k, a, w);
    for (let i = 1; i <= 5; i++) add('k' + i, 'acct', null);
    expect(() => add('k6', 'acct', null)).toThrow(/too many keys/);
    add('c1', 'acct2', 'AAA');
    expect(() => add('c2', 'acct2', 'BBB')).toThrow(/UNIQUE constraint failed: account_keys\.account_id/);
    add('c3', 'acct2', null);
    // a second run of the same file is refused (the runner records the file name, so it does not happen)
    expect(() => db.exec(MIGRATION)).toThrow(/already exists/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('query plans of the new queries (indexes used, rows read)', () => {
  const db = accountEnv().db;
  // the planner needs some rows to choose like it does on the live site (no ANALYZE statistics there)
  db.exec('BEGIN');
  const insDoc = db.prepare('INSERT INTO documents (doc_id, owner_key_id, status, listed, head_version, head_record_hash, label, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 3000; i++) insDoc.run(i.toString(16).padStart(32, '0'), (i % 1000).toString(16).padStart(64, '0'), 'active', 1, 1, 'e'.repeat(64), 'doc', i, i);
  db.exec('COMMIT');
  const plan = (sql, ...args) =>
    db
      .prepare('EXPLAIN QUERY PLAN ' + sql)
      .all(...args)
      .map((r) => r.detail)
      .join(' | ');
  // a plan that scans a whole table (SCAN x without USING INDEX / COVERING INDEX)
  const fullScan = (p) => /SCAN \w+( \w+)?(?! USING)(?= \||$)/.test(p.replace(/SCAN \w+( \w+)? USING (COVERING )?INDEX/g, 'USEDINDEX'));

  const Q = {
    session: ['SELECT s.expires_at, s.last_seen_at, a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?', 'x'],
    keys: ['SELECT key_id, wrapped_private, created_at FROM account_keys WHERE account_id = ? ORDER BY created_at ASC, key_id ASC', 'x'],
    meDocumentsFirst: [meDocumentsSql('none'), 'x', 50],
    meDocumentsTime: [meDocumentsSql('time'), 'x', 1, 50],
    meDocumentsCursor: [meDocumentsSql('timeId'), 'x', 1, 1, 'a', 50],
    keyGet: ['SELECT k.key_id FROM account_keys k JOIN identities i ON i.key_id = k.key_id WHERE k.account_id = ? AND k.wrapped_private IS NOT NULL LIMIT 1', 'x'],
    secretGet: ['SELECT wrapped FROM account_secrets WHERE account_id = ? AND doc_id = ?', 'a', 'd'],
    secretList: ['SELECT doc_id, wrapped FROM account_secrets WHERE account_id = ? AND doc_id > ? ORDER BY doc_id ASC LIMIT ?', 'a', '', 101],
    sessionList: ['SELECT token_hash, created_at, last_seen_at, expires_at FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY created_at DESC, token_hash ASC LIMIT 50', 'a', 1],
    otpRead: ['SELECT created_at FROM otp_codes WHERE email_hash = ?', 'e'],
    otpCount: ['UPDATE otp_codes SET attempts = attempts + 1 WHERE email_hash = ? AND attempts < ? AND expires_at > ? RETURNING code_hash, attempts', 'e', 5, 1],
    otpSweep: ['DELETE FROM otp_codes WHERE expires_at < ?', 1],
    accountByEmail: ['SELECT * FROM accounts WHERE email_hash = ?', 'e'],
    sessionsOfAccount: ['DELETE FROM sessions WHERE account_id = ?', 'a'],
    channelList: [
      'SELECT c.channel_id, c.last_text FROM channels c LEFT JOIN identities i ON i.key_id = c.created_by LEFT JOIN documents d ON d.doc_id = c.doc_id ORDER BY c.received_at DESC, c.channel_id DESC LIMIT ?',
      201
    ]
  };
  for (const [name, [sql, ...args]] of Object.entries(Q)) {
    it(`${name} uses an index`, () => {
      expect(fullScan(plan(sql, ...args)), plan(sql, ...args)).toBe(false);
    });
  }

  // Page two of GET /api/me/documents. With the account keys in an IN (...) SQLite answered the OR cursor
  // with a scan of the whole documents table, so D1 would count every document as a row read (free plan:
  // 5 million rows read a day) and the time grew with the size of the site. The query of the code is now
  // driven from account_keys. Measured: node tests/review/cloudflare/plan-scale.mjs 200000.
  it('the cursor page of /api/me/documents does not scan the documents table', () => {
    for (const kind of ['none', 'time', 'timeId']) {
      const args = kind === 'none' ? ['x', 50] : kind === 'time' ? ['x', 1, 50] : ['x', 1, 1, 'a', 50];
      const p = plan(meDocumentsSql(kind), ...args);
      expect(p, kind).not.toMatch(/SCAN d(?! USING)/);
      expect(p, kind).toMatch(/SEARCH k USING INDEX account_keys_account/);
      expect(p, kind).toMatch(/SEARCH d USING (COVERING )?INDEX idx_documents_owner_updated/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('subrequest budget (free plan: 50 database or fetch calls per request)', () => {
  it('sign in, key and listing requests stay far below the limit', async () => {
    let n = 0;
    const ctx = accountEnv({ hooks: { beforeCall: () => void n++ } });
    n = 0;
    const asked = await callApi(ctx.env, 'POST', '/api/auth/request', { json: { email: 'budget@example.test' } });
    expect(asked.status).toBe(200);
    const requestCalls = n;
    n = 0;
    const verified = await callApi(ctx.env, 'POST', '/api/auth/verify', { jar: new Jar(), json: { email: 'budget@example.test', code: asked.json.debugCode } });
    expect(verified.status).toBe(200);
    const verifyCalls = n;
    const jar = new Jar();
    jar.absorb(verified.res);
    const k = await makeKey('Budget');
    n = 0;
    const post = await callApi(ctx.env, 'POST', '/api/me/key', { jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } });
    expect(post.status).toBe(201);
    const keyCalls = n;
    n = 0;
    expect((await callApi(ctx.env, 'GET', '/api/me/documents', { jar })).status).toBe(200);
    const listCalls = n;
    expect([requestCalls, verifyCalls, keyCalls, listCalls].every((c) => c > 0 && c <= 15), JSON.stringify({ requestCalls, verifyCalls, keyCalls, listCalls })).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Worker CPU: work that grows with stored data inside one request', () => {
  // POST /api/me/strict used to open every stored password one after the other in ONE request (up to 10000).
  // It now hands them over in pages of 100, so one request opens at most 100.
  // In a local workerd run it took 22 ms for 100 passwords, 30 ms for 400 and 46 ms for 1500, wall time
  // including the database; about 17 to 25 microseconds per password. The free plan stops a request at
  // 10 ms of CPU, so an account with a few hundred stored passwords would hit the limit after the
  // account was already flipped to strict and before anything was returned or deleted.
  it('opens a bounded number of stored passwords per request', async () => {
    const ctx = accountEnv();
    const s = await signIn(ctx.env);
    const k = await makeKey('Many Files');
    await callApi(ctx.env, 'POST', '/api/me/key', { jar: s.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } });
    const ar = await atRest(ctx.env);
    const ins = ctx.db.prepare('INSERT INTO account_secrets (account_id, doc_id, wrapped, created_at) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 600; i++) {
      const id = randomDocId();
      ins.run(s.account.id, id, await ar.wrap(utf8Encode('abcd-efgh-ijkl-mnop-qrst'), 'secret', s.account.id, id), i);
    }
    const subtle = globalThis.crypto.subtle;
    const real = subtle.decrypt.bind(subtle);
    let opened = 0;
    subtle.decrypt = (...a) => (opened++, real(...a));
    try {
      const res = await callApi(ctx.env, 'POST', '/api/me/strict', { jar: s.jar, json: { enabled: true } });
      expect(res.status).toBe(200);
    } finally {
      subtle.decrypt = real;
    }
    // about 200 opens is 5 ms of CPU at the measured cost, a safe share of the 10 ms free plan limit
    expect(opened).toBeLessThanOrEqual(200);
    expect(opened).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------------------------
describe('health and the deploy check against a database without migration 0003', () => {
  it('the chat list and sign in answer 500 on a database that is behind the code', async () => {
    const ctx = accountEnv({ upTo: '0002_hardening.sql' });
    expect((await callApi(ctx.env, 'GET', '/api/channels')).status).toBe(500);
    expect((await callApi(ctx.env, 'POST', '/api/auth/request', { json: { email: 'a@example.test' } })).status).toBe(500);
  });
  it('health reports not ok (503, schema false) when the schema is behind the code', async () => {
    const ctx = accountEnv({ upTo: '0002_hardening.sql' });
    const health = await callApi(ctx.env, 'GET', '/api/health');
    expect(health.json.ok === true && health.status === 200).toBe(false);
    expect(health.status).toBe(503);
    expect(health.json).toMatchObject({ ok: false, schema: false });
    expect(health.text).not.toMatch(/no such (table|column)|last_text|otp_codes/); // no database text in the answer
  });
  it('health is ok on a database with every migration', async () => {
    const ctx = accountEnv();
    const health = await callApi(ctx.env, 'GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ ok: true, schema: true });
  });
  it('HEAD health says the same with no body', async () => {
    const ctx = accountEnv({ upTo: '0002_hardening.sql' });
    const head = await callApi(ctx.env, 'HEAD', '/api/health');
    expect(head.status).toBe(503);
    expect(head.text).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
describe('cookies and origin on pages.dev, previews and custom domains', () => {
  const req = (url, headers = {}) => new Request(url, { headers });
  for (const host of ['hrdlock.pages.dev', 'abc1234.hrdlock.pages.dev', 'feature-x.hrdlock.pages.dev', 'files.example.org']) {
    it(`https://${host} gets a __Host- cookie that browsers accept`, () => {
      const c = sessionCookie(req(`https://${host}/api/auth/verify`), 'T'.repeat(43));
      expect(c.startsWith('__Host-hrd_session=')).toBe(true);
      expect(c).toMatch(/; Path=\//);
      expect(c).toMatch(/; Secure/);
      expect(c).toMatch(/; HttpOnly/);
      expect(c).toMatch(/; SameSite=Lax/);
      expect(c).not.toMatch(/Domain=/i); // __Host- forbids Domain, so a preview cookie can not leak to its siblings
      expect(clearCookie(req(`https://${host}/`))).toMatch(/^__Host-hrd_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax; Secure$/);
    });
  }
  it('plain http is only for local hosts; a real host over http is refused before a code is used up', () => {
    expect(cookiePlan(req('http://localhost:8788/')).secure).toBe(false);
    expect(cookiePlan(req('http://127.0.0.1:8803/')).secure).toBe(false);
    expect(() => cookiePlan(req('http://hrdlock.pages.dev/'))).toThrow(/secure/);
  });
  it('a plain cookie set by another site is not read on https', () => {
    const r = req('https://hrdlock.pages.dev/api/me', { Cookie: 'hrd_session=' + 'A'.repeat(43) });
    expect(readSessionToken(r)).toBeNull();
    const ok = req('https://hrdlock.pages.dev/api/me', { Cookie: 'x=1; __Host-hrd_session=' + 'A'.repeat(43) });
    expect(readSessionToken(ok)).toBe('A'.repeat(43));
  });
  it('origin must equal the origin of the request URL, which behind Cloudflare is the public host', () => {
    const post = (url, origin) => new Request(url, { method: 'POST', headers: origin === undefined ? {} : { Origin: origin } });
    expect(() => requireSameOrigin(post('https://abc1234.hrdlock.pages.dev/api/auth/request', 'https://abc1234.hrdlock.pages.dev'))).not.toThrow();
    // a preview page calling the production host, or the production page calling a preview, is a different origin
    expect(() => requireSameOrigin(post('https://hrdlock.pages.dev/api/auth/request', 'https://abc1234.hrdlock.pages.dev'))).toThrow(/this site/);
    expect(() => requireSameOrigin(post('https://hrdlock.pages.dev/api/auth/request', 'null'))).toThrow();
    expect(() => requireSameOrigin(post('https://hrdlock.pages.dev/api/auth/request', undefined))).toThrow();
    expect(() => requireSameOrigin(post('https://hrdlock.pages.dev/api/auth/request', 'http://hrdlock.pages.dev'))).toThrow();
  });
  it('a preview deployment without the account secrets has accounts off and says so plainly', async () => {
    const ctx = accountEnv({ env: { ACCOUNT_MASTER_KEY: undefined, MAIL_PROVIDER: undefined } });
    const base = 'https://abc1234.hrdlock.pages.dev';
    const health = await callApi(ctx.env, 'GET', '/api/health', { base, ip: '203.0.113.9' });
    expect(health.json).toMatchObject({ accounts: false, mail: 'none' });
    const me = await callApi(ctx.env, 'GET', '/api/me', { base, ip: '203.0.113.9' });
    expect(me.status).toBe(503);
    expect(me.json.code).toBe('accounts_unavailable');
    const asked = await callApi(ctx.env, 'POST', '/api/auth/request', { base, ip: '203.0.113.9', json: { email: 'a@example.test' } });
    expect(asked.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------------------------
describe('static hosting of the new shell', () => {
  const headers = read('public/_headers');
  const csp = /Content-Security-Policy: (.*)/.exec(headers)[1];
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  const html = read('index.html');

  it('the manifest is linked, valid and allowed by the CSP (manifest-src falls back to default-src)', () => {
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest">/);
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/manifest-src/);
    expect(manifest).toMatchObject({ name: 'hrdlock', short_name: 'hrdlock', display: 'standalone', start_url: '/', scope: '/' });
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    for (const icon of manifest.icons) expect(() => read('public' + icon.src)).not.toThrow();
  });
  it('has theme-color metas for light and dark', () => {
    expect(html).toMatch(/name="theme-color" content="#4f46e5" media="\(prefers-color-scheme: light\)"/);
    expect(html).toMatch(/name="theme-color" content="#0e1118" media="\(prefers-color-scheme: dark\)"/);
  });
  it('only /api/* goes to functions, and only hashed assets are cached for a year', () => {
    expect(JSON.parse(read('public/_routes.json'))).toEqual({ version: 1, include: ['/api/*'], exclude: [] });
    const blocks = headers.split(/\r?\n(?=\S)/);
    expect(blocks.filter((b) => /immutable/.test(b)).map((b) => b.split(/\r?\n/)[0])).toEqual(['/assets/*']);
    expect(headers).not.toMatch(/\/index\.html|\/manifest/);
  });
  it('every route of the app is served by the single page fallback (no 404.html, no _redirects)', () => {
    const files = readdirSync(join(ROOT, 'public')).join(' ');
    expect(files).not.toMatch(/404\.html|_redirects/);
  });
  // The icons are SVG only. Chrome wants PNG icons of 192 and 512 pixels to offer "install", and iOS
  // ignores SVG for the home screen icon (it needs an apple-touch-icon PNG). Not checked in a browser here.
  it('offers PNG icons for installing the app on a phone', () => {
    expect(manifest.icons.some((i) => /png$/.test(i.src) && /192/.test(i.sizes))).toBe(true);
    expect(manifest.icons.some((i) => /png$/.test(i.src) && /512/.test(i.sizes))).toBe(true);
    expect(html).toMatch(/rel="apple-touch-icon"/);
  });
  it('does not lock the installed app to one screen orientation (WCAG 1.3.4)', () => {
    expect(['any', undefined]).toContain(manifest.orientation);
  });
});

// ---------------------------------------------------------------------------------------------
describe('operator scripts and notes', () => {
  const ignore = read('.gitignore');
  const deploy = read('scripts/DEPLOY.md');
  const masterSection = deploy.slice(deploy.indexOf('### The master key'), deploy.indexOf('### What the server stores'));

  it('the signing key file names are git ignored', () => {
    expect(ignore).toMatch(/^server-key\*\.json$/m);
  });
  // make-master-key.mjs writes wherever it is told. The notes say "outside the repository" but a name
  // inside the repository is not ignored, so a careless git add would publish the master key.
  it('a master key file written next to the code is git ignored', () => {
    expect(ignore).toMatch(/master-key/);
  });
  // The owner works in PowerShell, where the "<" redirect is a parse error.
  it('the master key steps also give the PowerShell form', () => {
    expect(masterSection).toMatch(/Get-Content/);
  });
  // DEPLOY.md calls every mail setting a secret. MAIL_PROVIDER and MAIL_FROM are plain values: with a
  // wrangler.toml the dashboard can not edit variables, so they belong in [vars] there (or as secrets).
  it('the notes say where the plain variables MAIL_PROVIDER and MAIL_FROM go', () => {
    expect(deploy.includes('[vars]')).toBe(true);
  });
});
