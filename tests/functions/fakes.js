// Test doubles for the Workers bindings: a D1 look alike on node:sqlite (all migrations applied) and a
// small R2 look alike. Not a test file itself.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '../../shared/hash.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function newDatabase(upTo = null) {
  const db = new DatabaseSync(':memory:');
  for (const name of migrationFiles()) {
    if (upTo && name > upTo) break;
    db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
  }
  return db;
}

function run(db, sql, args) {
  const st = db.prepare(sql);
  if (/^\s*SELECT/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { results: st.all(...args), meta: { changes: 0 } };
  const r = st.run(...args);
  return { results: [], meta: { changes: Number(r.changes) } };
}

// D1 look alike. hooks.beforeCall (optional async function) runs before every call.
export function fakeD1(db, hooks = {}) {
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    first: async () => {
      if (hooks.beforeCall) await hooks.beforeCall(sql);
      return run(db, sql, args).results[0] || null;
    },
    all: async () => {
      if (hooks.beforeCall) await hooks.beforeCall(sql);
      return run(db, sql, args);
    },
    run: async () => {
      if (hooks.beforeCall) await hooks.beforeCall(sql);
      return run(db, sql, args);
    }
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      if (hooks.beforeCall) await hooks.beforeCall('batch');
      db.exec('BEGIN');
      try {
        const out = list.map((s) => run(db, s.sql, s.args));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  };
}

// R2 look alike. put reads the whole stream, checks the sha256 option and the stream errors.
export function fakeR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, opts = {}) {
      const chunks = [];
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.length;
      }
      if (opts.sha256 && (await sha256Hex(bytes)) !== opts.sha256) {
        throw new Error('put: The SHA-256 checksum you specified did not match what we received. (10037)');
      }
      objects.set(key, bytes);
      return { key, size: bytes.length };
    },
    async head(key) {
      const b = objects.get(key);
      return b ? { key, size: b.length } : null;
    },
    async get(key) {
      const b = objects.get(key);
      return b ? { key, size: b.length, body: new Blob([b]).stream() } : null;
    },
    async delete(key) {
      objects.delete(key);
    }
  };
}

export function streamOfBytes(bytes, chunk = 1000) {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    }
  });
}

// Random bytes with a valid locked file header on top.
export function lockedBytes(n = 300, { iterations = 600000, suite = 1, magic = 'HRDLOCK3' } = {}) {
  const b = new Uint8Array(Math.max(n, 0));
  for (let off = 0; off < b.length; off += 65536) crypto.getRandomValues(b.subarray(off, Math.min(b.length, off + 65536)));
  for (let i = 0; i < 8 && i < b.length; i++) b[i] = magic.charCodeAt(i);
  if (b.length > 12) {
    b[8] = suite;
    new DataView(b.buffer).setUint32(9, iterations, false);
  }
  return b;
}
