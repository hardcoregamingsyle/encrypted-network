// GET  /api/me/files   the private files of the signed in account
// POST /api/me/files   store one: the body is the locked file, the headers say what it is
//   x-file-label (url encoded name for the list), x-blob-sha256, x-hrd-key (one of the account's keys),
//   x-hrd-time and x-hrd-sig (that key's signature of the blob.put record for these bytes)
// The signature is kept so the owner's browser can check the bytes again when it gets them back.
import { LIMITS, isHash, newDocId, validateRecord } from '../../../../shared/records.js';
import { authJson } from '../../../_lib/accounts.js';
import { GLOBAL_BLOB_CAP_BYTES, MIN_LOCKED_BYTES, checkedBody } from '../../../_lib/blobs.js';
import { ApiError, badRequest } from '../../../_lib/errors.js';
import { onlyMethods } from '../../../_lib/http.js';
import { requireSigner } from '../../../_lib/identities.js';
import { consumeRate } from '../../../_lib/rate.js';
import { requireAuth, requireSameOrigin } from '../../../_lib/session.js';
import { blobStore } from '../../../_lib/store.js';
import { assertFresh } from '../../../_lib/time.js';

export const PRIVATE_QUOTA_BYTES = 100 * 1024 * 1024; // per account
export const PRIVATE_MAX_FILES = 200; // per account, the list shows this many
const LABEL_MAX = 120;
// Ranges (as numbers) of control, invisible and direction changing characters, which a name must not contain.
const BAD_CHARS = [[0, 31], [127, 159], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const hasBadChar = (s) => Array.from(s).some((ch) => BAD_CHARS.some(([a, b]) => ch.codePointAt(0) >= a && ch.codePointAt(0) <= b));

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(env, request);
  const { results } = await env.DB.prepare(
    'SELECT id, label, size, created_at FROM private_files WHERE account_id = ? ORDER BY created_at DESC LIMIT 200'
  ).bind(auth.row.id).all();
  return authJson(auth, { files: results.map((r) => ({ id: r.id, label: r.label, size: r.size, createdAt: r.created_at })) });
}

export async function onRequestPost({ request, env }) {
  requireSameOrigin(request);
  const auth = await requireAuth(env, request);
  const h = request.headers;
  const hash = h.get('x-blob-sha256');
  const signer = h.get('x-hrd-key');
  const time = h.get('x-hrd-time');
  const signature = h.get('x-hrd-sig');
  if (!isHash(hash) || !isHash(signer) || !/^[0-9]{1,16}$/.test(time || '') || !signature) throw badRequest('missing or bad upload headers');
  let label = '';
  try {
    label = decodeURIComponent(h.get('x-file-label') || '').trim();
  } catch {
    // a label that is not valid text is refused below
  }
  if (!label || Array.from(label).length > LABEL_MAX || hasBadChar(label)) throw badRequest('the name must be 1 to 120 plain characters');
  const length = h.get('content-length');
  if (!/^[0-9]{1,15}$/.test(length || '')) throw new ApiError('bad_request', 'content-length is required', { status: 411 });
  const size = Number(length);
  if (size < MIN_LOCKED_BYTES || size > LIMITS.MAX_BLOB_BYTES || !request.body) throw badRequest('the file size is not allowed');

  const record = { v: 2, type: 'blob.put', hash, size, signer, createdAt: Number(time) };
  const valid = validateRecord(record);
  if (!valid.ok) throw badRequest(valid.error);
  assertFresh(record.createdAt, LIMITS.BLOB_TIME_WINDOW_MS, auth.now, 'upload');
  await requireSigner(env, record, signature);
  const own = await env.DB.prepare('SELECT 1 AS x FROM account_keys WHERE key_id = ? AND account_id = ?').bind(signer, auth.row.id).first();
  if (!own) throw new ApiError('not_owner', 'that key does not belong to your account');
  await consumeRate(env, 'blob', signer, auth.now);

  // The room is taken and the row written in one statement, so parallel uploads can not pass the quota together.
  const id = newDocId();
  const taken = await env.DB.prepare(
    'INSERT INTO private_files (id, account_id, label, size, blob_hash, signer, signed_at, signature, created_at) ' +
      'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ' +
      '(SELECT COALESCE(SUM(size), 0) FROM private_files WHERE account_id = ?) + ? <= ? AND ' +
      '(SELECT COUNT(*) FROM private_files WHERE account_id = ?) < ? AND ' +
      "(SELECT COALESCE(SUM(size), 0) FROM private_files) + (SELECT COALESCE(bytes, 0) FROM blob_totals WHERE k = 'all') + ? <= ?"
  )
    .bind(id, auth.row.id, label, size, hash, signer, record.createdAt, signature, auth.now, auth.row.id, size, PRIVATE_QUOTA_BYTES, auth.row.id, PRIVATE_MAX_FILES, size, GLOBAL_BLOB_CAP_BYTES)
    .run();
  if (!taken.meta || taken.meta.changes < 1) throw new ApiError('too_large', 'your private files are full (size or number) or the file store is full');

  const { readable, state, done } = checkedBody(request.body, size);
  try {
    await blobStore(env).put('private/' + id, readable, { sha256: hash, size });
  } catch (err) {
    await done;
    await env.DB.prepare('DELETE FROM private_files WHERE id = ?').bind(id).run();
    if (state.problem) throw badRequest(state.problem);
    if (/checksum|\(10037\)|sha-?256|digest/i.test(String((err && err.message) || err))) throw badRequest('the file bytes do not match the hash');
    throw err;
  }
  await done;
  // The owner may have deleted the file while it was still arriving: the bytes must not stay behind.
  if (!(await env.DB.prepare('SELECT 1 AS x FROM private_files WHERE id = ?').bind(id).first())) {
    await blobStore(env).delete('private/' + id);
    throw new ApiError('not_found', 'the file was removed while it was being uploaded');
  }
  return authJson(auth, { id, size }, 201);
}

export const onRequest = onlyMethods('GET', 'POST');
