// Locked file storage rules: the quota is reserved before the bytes are streamed, the upload
// must start with a locked file header, and a file an operator removed cannot come back.
import { LIMITS } from '../../shared/records.js';
import { ApiError, badRequest, isUniqueConflict } from './errors.js';

export const blobKey = (hash) => 'blobs/' + hash;

// Locked file layout (see the format in src/lib/lockfile.js): 8 byte magic, 1 byte suite, 4 byte
// iteration count, then salt and nonces. The header is 53 bytes and the smallest valid file is 151.
export const LOCK_HEADER_BYTES = 53;
export const MIN_LOCKED_BYTES = 151;
const MAGIC = 'HRDLOCK3';
const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 2000000;

export const PENDING_TTL_MS = 2 * 60 * 60 * 1000; // a reserved upload that never finished is swept after this
export const MAX_PENDING_PER_SIGNER = 4; // uploads one signer may have in flight at once
export const GLOBAL_BLOB_CAP_BYTES = 10 * 1024 * 1024 * 1024; // all stored and reserved bytes together

// Returns a problem text, or null when the first 53 bytes look like a locked file header.
export function lockHeaderProblem(head) {
  if (!head || head.length < LOCK_HEADER_BYTES) return 'the file is too short to be a locked file';
  for (let i = 0; i < MAGIC.length; i++) {
    if (head[i] !== MAGIC.charCodeAt(i)) return 'the file does not start with a locked file header';
  }
  if (head[8] !== 1) return 'unsupported locked file suite';
  const iterations = ((head[9] << 24) | (head[10] << 16) | (head[11] << 8) | head[12]) >>> 0;
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return 'locked file iteration count is out of range';
  return null;
}

// A stream stage that looks at the first bytes while they pass through and fails the stream when
// they are not a locked file header. state.problem holds the reason after a failure.
export function headerCheckStage() {
  const state = { problem: null };
  const head = new Uint8Array(LOCK_HEADER_BYTES);
  let seen = 0;
  const fail = (controller, problem) => {
    state.problem = problem;
    controller.error(new Error(problem));
  };
  const stage = new TransformStream({
    transform(chunk, controller) {
      if (seen < LOCK_HEADER_BYTES) {
        const take = Math.min(chunk.length, LOCK_HEADER_BYTES - seen);
        head.set(chunk.subarray(0, take), seen);
        seen += take;
        if (seen === LOCK_HEADER_BYTES) {
          const problem = lockHeaderProblem(head);
          if (problem) return fail(controller, problem);
        }
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (seen < LOCK_HEADER_BYTES) fail(controller, lockHeaderProblem(head.subarray(0, seen)));
    }
  });
  return { stage, state };
}

// Pipes the request body through the header check into a stream R2 accepts (it needs a known
// length). Returns { readable, state, done } where done never rejects.
export function checkedBody(body, size) {
  const { stage, state } = headerCheckStage();
  const Fixed = globalThis.FixedLengthStream;
  const sink = Fixed ? new Fixed(size) : new TransformStream();
  const done = body.pipeThrough(stage).pipeTo(sink.writable).catch(() => {});
  return { readable: sink.readable, state, done };
}

async function rowFor(db, hash) {
  return db.prepare('SELECT size, uploader, pending FROM blobs WHERE hash = ?').bind(hash).first();
}

// Reserves room for one blob in a single statement, so the quota check and the new row can not be
// separated by another upload. Returns true when the row was written.
async function reserve(db, { hash, size, signer, now, pending }) {
  const res = await db
    .prepare(
      'INSERT INTO blobs (hash, size, uploader, created_at, pending) ' +
        'SELECT ?, ?, ?, ?, ? WHERE ' +
        '(SELECT COALESCE(SUM(size), 0) FROM blobs WHERE uploader = ?) + ? <= ? AND ' +
        "(SELECT bytes FROM blob_totals WHERE k = 'all') + ? <= ? AND " +
        '(SELECT COUNT(*) FROM blobs WHERE uploader = ? AND pending = 1) < ?'
    )
    .bind(
      hash, size, signer, now, pending,
      signer, size, LIMITS.SIGNER_BLOB_QUOTA_BYTES,
      size, GLOBAL_BLOB_CAP_BYTES,
      signer, MAX_PENDING_PER_SIGNER
    )
    .run();
  return Boolean(res.meta && res.meta.changes > 0);
}

// Says why a reservation was refused.
async function refuseReason(db, { size, signer }) {
  const used = await db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE uploader = ?').bind(signer).first();
  if ((used ? used.n : 0) + size > LIMITS.SIGNER_BLOB_QUOTA_BYTES) {
    return new ApiError('too_large', 'the upload quota for this identity is used up');
  }
  const total = await db.prepare("SELECT bytes FROM blob_totals WHERE k = 'all'").first();
  if ((total ? total.bytes : 0) + size > GLOBAL_BLOB_CAP_BYTES) {
    return new ApiError('too_large', 'the file store is full, try again later');
  }
  return new ApiError('rate_limited', 'too many uploads in progress for this identity, wait for one to finish', {
    headers: { 'Retry-After': 10 }
  });
}

async function reserveOrThrow(db, args) {
  try {
    if (await reserve(db, args)) return;
  } catch (err) {
    if (!isUniqueConflict(err)) throw err;
    // Someone else reserved or stored this hash a moment ago.
    throw new ApiError('conflict', 'this file is being uploaded right now, try again in a moment', {
      headers: { 'Retry-After': 5 }
    });
  }
  throw await refuseReason(db, args);
}

async function dropReservation(db, hash, signer) {
  try {
    await db.prepare('DELETE FROM blobs WHERE hash = ? AND uploader = ? AND pending = 1').bind(hash, signer).run();
  } catch {
    // The sweep removes it later.
  }
}

// Stores one blob. Returns { exists: true } or { created: true }. Throws ApiError.
// request body, hash, size and signer have been checked by the caller.
export async function storeBlob(env, { body, hash, size, signer, now }) {
  const db = env.DB;
  if (size < MIN_LOCKED_BYTES) throw badRequest('the file is too short to be a locked file');
  if (await db.prepare('SELECT 1 AS x FROM blocked_blobs WHERE hash = ?').bind(hash).first()) {
    throw new ApiError('forbidden', 'this file was removed by the operator and cannot be stored again');
  }
  // Reservations that never finished (a crash, a cut connection) stop counting after the sweep.
  await db.prepare('DELETE FROM blobs WHERE pending = 1 AND created_at < ?').bind(now - PENDING_TTL_MS).run();

  const known = await rowFor(db, hash);
  if (known) {
    if (known.size !== size) throw badRequest('a file with this hash is stored with a different size');
    if (known.pending === 1) {
      // An upload that stored its object but never finished the row (the worker stopped in between):
      // the object is complete in R2, so finish the row now instead of making everyone wait for the sweep.
      const object = await env.FILES.head(blobKey(hash));
      if (object && object.size === size) {
        await db.prepare('UPDATE blobs SET pending = 0 WHERE hash = ? AND pending = 1').bind(hash).run();
        return { exists: true };
      }
      throw new ApiError('conflict', 'this file is being uploaded right now, try again in a moment', {
        headers: { 'Retry-After': 5 }
      });
    }
    return { exists: true };
  }
  const stored = await env.FILES.head(blobKey(hash));
  if (stored) {
    // The object is there but its row is missing (an earlier upload stopped half way). Repair the row.
    if (stored.size !== size) throw badRequest('a file with this hash is stored with a different size');
    try {
      await reserveOrThrow(db, { hash, size, signer, now, pending: 0 });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') return { exists: true };
      throw err;
    }
    return { exists: true };
  }

  await reserveOrThrow(db, { hash, size, signer, now, pending: 1 });

  const { readable, state, done } = checkedBody(body, size);
  let object;
  try {
    // R2 checks the sha256 itself while it stores the bytes.
    object = await env.FILES.put(blobKey(hash), readable, { sha256: hash });
  } catch (err) {
    await done;
    await dropReservation(db, hash, signer);
    if (state.problem) throw badRequest(state.problem);
    const text = String((err && err.message) || err);
    if (/checksum|\(10037\)|sha-?256|digest/i.test(text)) throw badRequest('the file bytes do not match the hash');
    throw err;
  }
  await done;
  if (!object || object.size !== size) {
    try {
      await env.FILES.delete(blobKey(hash));
    } catch {
      // nothing more to do
    }
    await dropReservation(db, hash, signer);
    throw badRequest('the file size does not match the content length');
  }

  const fin = await db
    .prepare('UPDATE blobs SET pending = 0, created_at = ? WHERE hash = ? AND uploader = ? AND pending = 1')
    .bind(now, hash, signer)
    .run();
  if (!(fin.meta && fin.meta.changes > 0)) {
    // The reservation was swept while the upload ran. Take the room again, or give the object up.
    let ok = false;
    try {
      ok = await reserve(db, { hash, size, signer, now, pending: 0 });
    } catch (err) {
      if (!isUniqueConflict(err)) throw err;
      ok = true; // someone else holds the row for the same bytes
    }
    if (!ok) {
      try {
        await env.FILES.delete(blobKey(hash));
      } catch {
        // nothing more to do
      }
      throw await refuseReason(db, { size, signer });
    }
  }
  return { created: true };
}
