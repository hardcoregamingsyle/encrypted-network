// Review r5 helper (not a vitest file). Builds an in memory database from the real migrations, fills it
// with many documents, and times the account document list: first page and cursor pages.
// Usage: node tests/review/cloudflare/plan-scale.mjs [documents]
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const N = Number(process.argv[2] || 100000);
const db = new DatabaseSync(':memory:');
for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
const hex = (n, w) => n.toString(16).padStart(w, '0');
db.exec('BEGIN');
const insD = db.prepare('INSERT INTO documents (doc_id, owner_key_id, status, listed, head_version, head_record_hash, label, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
const OWNERS = Math.floor(N / 3);
for (let i = 0; i < N; i++) insD.run(hex(i, 32), hex(i % OWNERS, 64), 'active', 1, 1, hex(i, 64), 'doc ' + i, 1000 + i, 1000 + ((i * 7919) % N));
db.prepare("INSERT INTO accounts (id,email_hash,email_masked,display_name,strict,created_at,last_login_at) VALUES ('acct','eh','ab***@x.com','A',0,1,1)").run();
// a heavy owner: one account with 120 documents on a single key
db.prepare("INSERT INTO account_keys (key_id,account_id,wrapped_private,created_at) VALUES (?, 'acct', NULL, 1)").run(hex(5, 64));
for (let a = 0; a < 20000; a++) db.prepare('INSERT INTO account_keys (key_id,account_id,wrapped_private,created_at) VALUES (?,?,NULL,1)').run(hex(1000000 + a, 64), 'other' + a);
db.exec('COMMIT');
const base =
  'SELECT d.doc_id, d.label, d.owner_key_id, d.listed, i.display_name AS owner_name, d.status, d.head_version, d.created_at, d.updated_at FROM documents d LEFT JOIN identities i ON i.key_id = d.owner_key_id WHERE d.owner_key_id IN (SELECT key_id FROM account_keys WHERE account_id = ?)';
const page1 = base + ' ORDER BY d.updated_at DESC, d.doc_id DESC LIMIT ?';
const page2 = base + ' AND (d.updated_at < ? OR (d.updated_at = ? AND d.doc_id < ?)) ORDER BY d.updated_at DESC, d.doc_id DESC LIMIT ?';
const FIXED =
  'SELECT d.doc_id, d.label, d.owner_key_id, d.listed, i.display_name AS owner_name, d.status, d.head_version, d.created_at, d.updated_at ' +
  'FROM account_keys k CROSS JOIN documents d ON d.owner_key_id = k.key_id LEFT JOIN identities i ON i.key_id = d.owner_key_id ' +
  'WHERE k.account_id = ? AND (d.updated_at < ? OR (d.updated_at = ? AND d.doc_id < ?)) ORDER BY d.updated_at DESC, d.doc_id DESC LIMIT ?';
const time = (sql, ...a) => {
  const s = db.prepare(sql);
  s.all(...a);
  const t = performance.now();
  for (let k = 0; k < 5; k++) s.all(...a);
  return ((performance.now() - t) / 5).toFixed(2);
};
const plan = (sql, ...a) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...a).map((r) => r.detail).join(' | ');
console.log('documents', N);
console.log('page 1  ms', time(page1, 'acct', 50), '|', plan(page1, 'acct', 50));
console.log('page 2  ms', time(page2, 'acct', 500, 500, 'f'.repeat(32), 50), '|', plan(page2, 'acct', 500, 500, 'f'.repeat(32), 50));
console.log('rewrite page 2 (no ANALYZE) ms', time(FIXED, 'acct', 500, 500, 'f'.repeat(32), 50), '|', plan(FIXED, 'acct', 500, 500, 'f'.repeat(32), 50));
db.exec('ANALYZE');
console.log('after ANALYZE');
console.log('page 1  ms', time(page1, 'acct', 50), '|', plan(page1, 'acct', 50));
console.log('page 2  ms', time(page2, 'acct', 500, 500, 'f'.repeat(32), 50), '|', plan(page2, 'acct', 500, 500, 'f'.repeat(32), 50));

// Proposed rewrite: drive the query from the account's keys, so only documents of those keys are touched.
console.log('rewrite page 2 (after ANALYZE) ms', time(FIXED, 'acct', 500, 500, 'f'.repeat(32), 50), '|', plan(FIXED, 'acct', 500, 500, 'f'.repeat(32), 50));
