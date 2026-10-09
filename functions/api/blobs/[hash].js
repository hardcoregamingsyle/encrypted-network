// Locked file storage in R2, addressed by the sha256 of the locked bytes.
//   PUT  /api/blobs/:hash   signed upload (headers x-hrd-key, x-hrd-time, x-hrd-sig)
//   GET  /api/blobs/:hash   raw bytes, cached for good because the address is the hash
//   HEAD /api/blobs/:hash
import { LIMITS, isHash, validateRecord } from '../../../shared/records.js';
import { ApiError, badRequest, notFound } from '../../_lib/errors.js';
import { blobKey, storeBlob } from '../../_lib/blobs.js';
import { json, onlyMethods } from '../../_lib/http.js';
import { requireSigner } from '../../_lib/identities.js';
import { consumeRate } from '../../_lib/rate.js';
import { assertFresh } from '../../_lib/time.js';

function hashParam(params) {
  const hash = params.hash;
  if (typeof hash !== 'string' || !isHash(hash)) throw badRequest('hash must be 64 lowercase hex characters');
  return hash;
}

// Reads and checks the signed upload headers. Returns the blob.put record and its signature.
function uploadAuth(request, hash) {
  const h = request.headers;
  const signer = h.get('x-hrd-key');
  const time = h.get('x-hrd-time');
  const signature = h.get('x-hrd-sig');
  if (!signer || !time || !signature) throw badRequest('x-hrd-key, x-hrd-time and x-hrd-sig headers are required');
  if (!isHash(signer)) throw badRequest('x-hrd-key must be 64 lowercase hex characters');
  if (!/^[0-9]{1,16}$/.test(time)) throw badRequest('x-hrd-time must be a time in milliseconds');

  const length = h.get('content-length');
  if (length === null) throw new ApiError('bad_request', 'content-length is required', { status: 411 });
  if (!/^[0-9]{1,15}$/.test(length)) throw badRequest('bad content-length');
  const size = Number(length);
  if (size > LIMITS.MAX_BLOB_BYTES) throw new ApiError('too_large', 'the file is too large');
  if (size < 1 || !request.body) throw badRequest('the file is empty');

  const record = { v: 2, type: 'blob.put', hash, size, signer, createdAt: Number(time) };
  const valid = validateRecord(record);
  if (!valid.ok) throw badRequest(valid.error);
  return { record, signature };
}

export async function onRequestPut({ request, env, params }) {
  const hash = hashParam(params);
  const { record, signature } = uploadAuth(request, hash);
  const size = record.size;
  const now = Date.now();
  assertFresh(record.createdAt, LIMITS.BLOB_TIME_WINDOW_MS, now, 'upload');
  await requireSigner(env, record, signature);
  await consumeRate(env, 'blob', record.signer, now);

  const result = await storeBlob(env, { body: request.body, hash, size, signer: record.signer, now });
  if (result.exists) return json({ exists: true, hash });
  return json({ hash, size }, 201);
}

function blobHeaders(object, hash) {
  const h = new Headers();
  h.set('Content-Type', 'application/octet-stream');
  h.set('Content-Disposition', `attachment; filename="${hash}.hrdlock"`);
  h.set('Cache-Control', 'public, max-age=31536000, immutable');
  h.set('ETag', `"${hash}"`);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Length', String(object.size));
  return h;
}

function notModified(request, hash) {
  const inm = request.headers.get('If-None-Match');
  if (!inm) return false;
  return inm
    .split(',')
    .map((s) => s.trim().replace(/^W\//, ''))
    .some((t) => t === `"${hash}"` || t === '*');
}

export async function onRequestGet({ request, env, params }) {
  const hash = hashParam(params);
  if (notModified(request, hash) && (await env.FILES.head(blobKey(hash)))) {
    return new Response(null, {
      status: 304,
      headers: { ETag: `"${hash}"`, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }
    });
  }
  const object = await env.FILES.get(blobKey(hash));
  if (!object) throw notFound('file not found');
  return new Response(object.body, { status: 200, headers: blobHeaders(object, hash) });
}

export async function onRequestHead({ env, params }) {
  const hash = hashParam(params);
  const object = await env.FILES.head(blobKey(hash));
  if (!object) throw notFound('file not found');
  return new Response(null, { status: 200, headers: blobHeaders(object, hash) });
}

export const onRequest = onlyMethods('GET', 'HEAD', 'PUT');
