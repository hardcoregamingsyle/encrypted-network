// Blob storage rules: header check, quota reserved before the bytes are streamed, cleanup, caps, takedown.
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_BLOB_CAP_BYTES,
  LOCK_HEADER_BYTES,
  MAX_PENDING_PER_SIGNER,
  MIN_LOCKED_BYTES,
  PENDING_TTL_MS,
  headerCheckStage,
  lockHeaderProblem,
  storeBlob
} from '../../functions/_lib/blobs.js';
import { ApiError } from '../../functions/_lib/errors.js';
import { sha256Hex } from '../../shared/hash.js';
import { LIMITS } from '../../shared/records.js';
import { fakeD1, fakeKV, fakeR2, lockedBytes, newDatabase, streamOfBytes } from './fakes.js';

const SIGNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

// the same tests run on R2 (default) and on KV (tests/functions/*.kv.test.js sets the kind first)
const newStore = () => (globalThis.__STORE_KIND === "kv" ? { BLOBS: fakeKV() } : { FILES: fakeR2() });
const objectsOf = (env) => (env.FILES || env.BLOBS).objects;

function setup(hooks) {
  const db = newDatabase();
  return { db, env: { DB: fakeD1(db, hooks), ...newStore() } };
}

async function upload(env, bytes, { signer = SIGNER, now = Date.now(), hash = null, chunk = 1000 } = {}) {
  return storeBlob(env, {
    body: streamOfBytes(bytes, chunk),
    hash: hash || (await sha256Hex(bytes)),
    size: bytes.length,
    signer,
    now
  });
}

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a failure');
}

const rows = (db, sql = 'SELECT * FROM blobs') => db.prepare(sql).all();

describe('locked file header check', () => {
  it('accepts the header of a locked file and the limits of the iteration range', () => {
    expect(lockHeaderProblem(lockedBytes(LOCK_HEADER_BYTES))).toBeNull();
    expect(lockHeaderProblem(lockedBytes(LOCK_HEADER_BYTES, { iterations: 100000 }))).toBeNull();
    expect(lockHeaderProblem(lockedBytes(LOCK_HEADER_BYTES, { iterations: 2000000 }))).toBeNull();
  });

  it('refuses a wrong magic, suite, iteration count or a short header', () => {
    expect(lockHeaderProblem(lockedBytes(80, { magic: 'HRDLOCK2' }))).toMatch(/header/);
    expect(lockHeaderProblem(lockedBytes(80, { magic: 'hrdlock3' }))).toMatch(/header/);
    expect(lockHeaderProblem(lockedBytes(80, { suite: 0 }))).toMatch(/suite/);
    expect(lockHeaderProblem(lockedBytes(80, { suite: 2 }))).toMatch(/suite/);
    expect(lockHeaderProblem(lockedBytes(80, { iterations: 99999 }))).toMatch(/iteration/);
    expect(lockHeaderProblem(lockedBytes(80, { iterations: 2000001 }))).toMatch(/iteration/);
    expect(lockHeaderProblem(lockedBytes(80, { iterations: 0xffffffff }))).toMatch(/iteration/);
    expect(lockHeaderProblem(lockedBytes(LOCK_HEADER_BYTES - 1))).toMatch(/short/);
    expect(lockHeaderProblem(null)).toMatch(/short/);
  });

  async function pipe(bytes, chunk) {
    const { stage, state } = headerCheckStage();
    const out = [];
    let error = null;
    try {
      const reader = streamOfBytes(bytes, chunk).pipeThrough(stage).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(value);
      }
    } catch (err) {
      error = err;
    }
    return { out, error, state };
  }

  it('passes every byte through unchanged, whatever the chunk size (even one byte at a time)', async () => {
    const bytes = lockedBytes(500);
    for (const chunk of [1, 7, 53, 54, 500, 4096]) {
      const r = await pipe(bytes, chunk);
      expect(r.error).toBeNull();
      const joined = new Uint8Array(r.out.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of r.out) {
        joined.set(c, at);
        at += c.length;
      }
      expect(joined).toEqual(bytes);
    }
  });

  it('fails the stream as soon as the header is wrong, in any chunking, and says why', async () => {
    for (const chunk of [1, 10, 53, 400]) {
      const r = await pipe(lockedBytes(400, { magic: 'NOTALOCK' }), chunk);
      expect(r.error).toBeTruthy();
      expect(r.state.problem).toMatch(/header/);
    }
    const r = await pipe(lockedBytes(400, { iterations: 5 }), 100);
    expect(r.state.problem).toMatch(/iteration/);
  });

  it('fails a stream that ends inside the header', async () => {
    const r = await pipe(lockedBytes(30), 10);
    expect(r.error).toBeTruthy();
    expect(r.state.problem).toMatch(/short/);
  });
});

describe('storeBlob', () => {
  it('stores a locked file, leaves a finished row and counts the bytes', async () => {
    const { db, env } = setup();
    const bytes = lockedBytes(400);
    expect(await upload(env, bytes)).toEqual({ created: true });
    const r = rows(db);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ size: 400, uploader: SIGNER, pending: 0 });
    expect(db.prepare("SELECT bytes FROM blob_totals WHERE k = 'all'").get().bytes).toBe(400);
    expect(objectsOf(env).size).toBe(1);
  });

  it('answers exists for a second upload of the same file and keeps one row', async () => {
    const { db, env } = setup();
    const bytes = lockedBytes(400);
    await upload(env, bytes);
    expect(await upload(env, bytes, { signer: OTHER })).toEqual({ exists: true });
    expect(rows(db)).toHaveLength(1);
  });

  it('refuses bytes that do not start like a locked file and stores nothing', async () => {
    const { db, env } = setup();
    const bytes = lockedBytes(400, { magic: 'PLAINTXT' });
    const err = await failure(upload(env, bytes));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('bad_request');
    expect(objectsOf(env).size).toBe(0);
    expect(rows(db)).toHaveLength(0);
    expect(db.prepare("SELECT bytes FROM blob_totals WHERE k = 'all'").get().bytes).toBe(0);
  });

  it('refuses files shorter than the smallest locked file', async () => {
    const { env } = setup();
    const err = await failure(upload(env, lockedBytes(MIN_LOCKED_BYTES - 1)));
    expect(err.code).toBe('bad_request');
    expect(await upload(env, lockedBytes(MIN_LOCKED_BYTES))).toEqual({ created: true });
  });

  it('removes the reservation when the bytes do not match the hash, and a retry works', async () => {
    const { db, env } = setup();
    const bytes = lockedBytes(400);
    const hash = await sha256Hex(bytes);
    const err = await failure(upload(env, lockedBytes(400), { hash }));
    expect(err.code).toBe('bad_request');
    expect(err.message).toMatch(/hash/);
    expect(rows(db)).toHaveLength(0);
    expect(await upload(env, bytes)).toEqual({ created: true });
  });

  it('removes the reservation when the stream breaks half way', async () => {
    const { db, env } = setup();
    const bytes = lockedBytes(4000);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice(0, 1500));
      },
      pull(c) {
        c.error(new Error('connection reset'));
      }
    });
    const err = await failure(storeBlob(env, { body, hash: await sha256Hex(bytes), size: bytes.length, signer: SIGNER, now: Date.now() }));
    expect(err.message).toBe('connection reset');
    expect(rows(db)).toHaveLength(0);
    expect(db.prepare("SELECT bytes FROM blob_totals WHERE k = 'all'").get().bytes).toBe(0);
  });

  it('refuses a size that differs from what is stored under the same hash', async () => {
    const { env } = setup();
    const bytes = lockedBytes(400);
    await upload(env, bytes);
    const err = await failure(storeBlob(env, { body: streamOfBytes(bytes), hash: await sha256Hex(bytes), size: 401, signer: SIGNER, now: Date.now() }));
    expect(err.code).toBe('bad_request');
  });

  it('refuses a file an operator blocked, before reading any bytes', async () => {
    const { db, env } = setup();
    const bytes = lockedBytes(400);
    db.prepare('INSERT INTO blocked_blobs (hash, reason, created_at) VALUES (?, ?, ?)').run(await sha256Hex(bytes), 'takedown', 1);
    const err = await failure(upload(env, bytes));
    expect(err.code).toBe('forbidden');
    expect(err.status).toBe(403);
    expect(objectsOf(env).size).toBe(0);
  });

  it('repairs a missing row when the object is already stored', async () => {
    const { db, env } = setup();
    const bytes = lockedBytes(400);
    const hash = await sha256Hex(bytes);
    objectsOf(env).set('blobs/' + hash, bytes);
    expect(await upload(env, bytes)).toEqual({ exists: true });
    expect(rows(db)[0]).toMatchObject({ hash, pending: 0, uploader: SIGNER });
  });
});

describe('quota is reserved before streaming', () => {
  // Uploads whose bodies the test releases by hand, so they overlap like parallel requests.
  function gated(bytes) {
    let release;
    const gate = new Promise((r) => (release = r));
    const body = new ReadableStream({
      async pull(controller) {
        await gate;
        controller.enqueue(bytes);
        controller.close();
      }
    });
    return { body, release };
  }

  it('parallel uploads of one signer can never hold more than the quota together', async () => {
    const { db, env } = setup();
    const size = 48 * 1024 * 1024; // five of these are over the 200 MiB quota
    // The quota is checked against the declared size, so the bytes themselves can stay small in this test:
    // the upload fails later on a size mismatch, but only after the reservation was taken.
    const jobs = [];
    const gates = [];
    for (let i = 0; i < 6; i++) {
      const g = gated(lockedBytes(300));
      gates.push(g);
      jobs.push(
        storeBlob(env, { body: g.body, hash: (i + 1).toString(16).padStart(64, '0'), size, signer: SIGNER, now: Date.now() }).then(
          () => 'stored',
          (err) => err.code
        )
      );
    }
    // Let every call run up to the point where it waits for its bytes.
    await new Promise((r) => setTimeout(r, 50));
    const reserved = db.prepare('SELECT COALESCE(SUM(size), 0) AS s, COUNT(*) AS n FROM blobs WHERE uploader = ?').get(SIGNER);
    expect(reserved.s).toBeLessThanOrEqual(LIMITS.SIGNER_BLOB_QUOTA_BYTES);
    expect(reserved.n).toBeLessThanOrEqual(4);
    for (const g of gates) g.release();
    const out = await Promise.all(jobs);
    // 4 fit under the quota (192 MiB) and the others were refused while they ran.
    expect(out.filter((o) => o === 'too_large' || o === 'rate_limited').length).toBeGreaterThanOrEqual(2);
    // Nothing is left: every stored attempt failed on the size check, which drops its reservation.
    expect(db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n).toBe(0);
    expect(db.prepare("SELECT bytes FROM blob_totals WHERE k = 'all'").get().bytes).toBe(0);
  });

  it('refuses with too_large once the signer total would pass the quota, counting reserved rows', async () => {
    const { db, env } = setup();
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, ?, ?, ?, ?)').run('c'.repeat(64), LIMITS.SIGNER_BLOB_QUOTA_BYTES - 300, SIGNER, Date.now(), 1);
    const err = await failure(upload(env, lockedBytes(301)));
    expect(err.code).toBe('too_large');
    expect(err.message).toMatch(/quota/);
    expect(await upload(env, lockedBytes(300))).toEqual({ created: true });
    // another signer is not affected
    expect(await upload(env, lockedBytes(400), { signer: OTHER })).toEqual({ created: true });
  });

  it('limits how many uploads one signer can have in flight', async () => {
    const { db, env } = setup();
    for (let i = 0; i < MAX_PENDING_PER_SIGNER; i++) {
      db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, ?, ?, ?, 1)').run(String(i).padStart(64, '0'), 300, SIGNER, Date.now());
    }
    const err = await failure(upload(env, lockedBytes(300)));
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(err.headers['Retry-After']).toBeGreaterThan(0);
    expect(await upload(env, lockedBytes(300), { signer: OTHER })).toEqual({ created: true });
  });

  it('keeps all stored and reserved bytes under the global cap', async () => {
    const { db, env } = setup();
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, ?, ?, ?, 0)').run('d'.repeat(64), GLOBAL_BLOB_CAP_BYTES - 500, OTHER, 1);
    const err = await failure(upload(env, lockedBytes(501)));
    expect(err.code).toBe('too_large');
    expect(err.message).toMatch(/full/);
    expect(await upload(env, lockedBytes(500))).toEqual({ created: true });
  });

  it('answers conflict while the same file is being uploaded by someone else', async () => {
    const { db, env } = setup();
    const bytes = lockedBytes(400);
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, ?, ?, ?, 1)').run(await sha256Hex(bytes), 400, OTHER, Date.now());
    const err = await failure(upload(env, bytes));
    expect(err.code).toBe('conflict');
    expect(err.headers['Retry-After']).toBeGreaterThan(0);
  });

  it('finishes the row of an upload whose object is already stored (the worker stopped before the last step)', async () => {
    const { db, env } = setup();
    const bytes = lockedBytes(400);
    const hash = await sha256Hex(bytes);
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, 400, ?, ?, 1)').run(hash, OTHER, Date.now());
    objectsOf(env).set('blobs/' + hash, bytes);
    expect(await upload(env, bytes)).toEqual({ exists: true });
    expect(rows(db)[0]).toMatchObject({ pending: 0, uploader: OTHER });
  });

  it('sweeps reservations older than the time to live, so a crashed upload does not hold quota for ever', async () => {
    const { db, env } = setup();
    const now = Date.now();
    const bytes = lockedBytes(400);
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, ?, ?, ?, 1)').run(await sha256Hex(bytes), 400, OTHER, now - PENDING_TTL_MS - 1000);
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, ?, ?, ?, 1)').run('e'.repeat(64), 77, OTHER, now - 1000);
    expect(await upload(env, bytes, { now })).toEqual({ created: true });
    const left = rows(db).map((r) => r.hash);
    expect(left).toContain('e'.repeat(64)); // a young reservation stays
    expect(rows(db, 'SELECT * FROM blobs WHERE pending = 1')).toHaveLength(1);
    expect(db.prepare("SELECT bytes FROM blob_totals WHERE k = 'all'").get().bytes).toBe(400 + 77);
  });

  it('a reservation swept during a long upload is taken again at the end', async () => {
    const { db, env } = setup();
    const bytes = lockedBytes(400);
    const hash = await sha256Hex(bytes);
    const body = new ReadableStream({
      pull(controller) {
        // another request sweeps the reservation while the bytes are still arriving
        db.prepare('DELETE FROM blobs WHERE hash = ?').run(hash);
        controller.enqueue(bytes);
        controller.close();
      }
    });
    expect(await storeBlob(env, { body, hash, size: 400, signer: SIGNER, now: Date.now() })).toEqual({ created: true });
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ pending: 0, uploader: SIGNER });
  });
});
