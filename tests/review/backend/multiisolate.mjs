// Simulates several Worker isolates writing to one database at once, to see what the retry logic does when the
// per isolate lock cannot help. It copies functions/_lib and shared/ into one folder per fake isolate (so each has its
// own lock map), runs them against one SQLite database that stands in for D1 (atomic batch, a few ms of latency per call).
// node tests/review/backend/multiisolate.mjs [isolates] [latencyMs]
// This is a model, not a measurement of Cloudflare. It shows the shape of the contention only.
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, ZERO_HASH, applyMigrations, assert, bytesToHex, check, finish, newDocId, randomBytes } from './_lib.mjs';

const N = Number(process.argv[3] || 14);
const LATENCY = Number(process.argv[4] || 6);
const scratch = join(process.env.TEMP || '.', 'hrd-multiiso-' + Date.now());
mkdirSync(scratch, { recursive: true });

const db = new DatabaseSync(':memory:');
applyMigrations(db);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeD1() {
  const exec = (sql, args) => {
    const st = db.prepare(sql);
    if (/^\s*(SELECT|INSERT[\s\S]*RETURNING)/i.test(sql)) return { results: st.all(...args), meta: {} };
    const r = st.run(...args);
    return { results: [], meta: { changes: Number(r.changes) } };
  };
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    first: async () => {
      await sleep(LATENCY);
      return exec(sql, args).results[0] || null;
    },
    all: async () => {
      await sleep(LATENCY);
      return exec(sql, args);
    },
    run: async () => {
      await sleep(LATENCY);
      return exec(sql, args);
    }
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      await sleep(LATENCY);
      db.exec('BEGIN');
      try {
        const out = list.map((s) => exec(s.sql, s.args));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  };
}
const env = { DB: fakeD1() };

const isolates = [];
for (let i = 0; i < N; i++) {
  const dir = join(scratch, 'iso' + i);
  cpSync(join(ROOT, 'functions', '_lib'), join(dir, 'functions', '_lib'), { recursive: true });
  cpSync(join(ROOT, 'shared'), join(dir, 'shared'), { recursive: true });
  isolates.push(await import(pathToFileURL(join(dir, 'functions', '_lib', 'documents.js')).href));
}

const blobHash = bytesToHex(randomBytes(32));
db.prepare('INSERT INTO blobs (hash, size, uploader, created_at) VALUES (?,?,?,?)').run(blobHash, 100, 'u', 1);

await check(`${N} isolates each appending one different document at the same moment all succeed (D1 latency ${LATENCY} ms)`, async () => {
  const jobs = isolates.map((mod, i) => {
    const rec = {
      v: 2, type: 'doc.create', docId: newDocId(), version: 1, prev: ZERO_HASH, signer: 'a'.repeat(64), createdAt: Date.now(),
      label: 'iso ' + i, listed: true, blob: { hash: blobHash, size: 100, suite: 1 }, commitment: 'b'.repeat(64)
    };
    return mod.appendDocRecord(env, rec, 'sig').then(
      () => 'ok',
      (e) => `${e.code || 'error'}: ${e.message}`
    );
  });
  const out = await Promise.all(jobs);
  const ok = out.filter((o) => o === 'ok').length;
  const stored = db.prepare('SELECT COUNT(*) n FROM ledger').get().n;
  console.log(`  succeeded ${ok} of ${N}; failed: ${[...new Set(out.filter((o) => o !== 'ok'))].join(' | ') || 'none'}; ledger rows ${stored}`);
  assert(stored === ok, 'ledger rows differ from successes');
  assert(ok === N, `${N - ok} of ${N} simultaneous writers from different isolates were told "the server is busy"`);
});

await check('the ledger written by the survivors is still a valid chain', async () => {
  const rows = db.prepare('SELECT seq, prev_ledger_hash p, ledger_hash h FROM ledger ORDER BY seq').all();
  let prev = ZERO_HASH;
  for (const r of rows) {
    assert(r.p === prev, 'broken link at seq ' + r.seq);
    prev = r.h;
  }
});

rmSync(scratch, { recursive: true, force: true });
finish();
