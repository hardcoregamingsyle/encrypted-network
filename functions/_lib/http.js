// Small HTTP helpers: JSON responses, bounded body reading, query parsing.
import { utf8Decode } from '../../shared/encoding.js';
import { ApiError, badRequest } from './errors.js';

export const MAX_JSON_BYTES = 64 * 1024;

export function json(data, status = 200, headers = null) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (headers) for (const [k, v] of Object.entries(headers)) h.set(k, String(v));
  return new Response(JSON.stringify(data), { status, headers: h });
}

// 405 for a route that does not take this method.
export function methodNotAllowed(allowed) {
  return new ApiError('bad_request', 'method not allowed', { status: 405, headers: { Allow: allowed.join(', ') } });
}

// Handler for the catch-all method slot of a route file.
export function onlyMethods(...allowed) {
  return () => {
    throw methodNotAllowed(allowed);
  };
}

// Checks a Content-Length header value against a cap. Returns the number or null if absent.
export function parseContentLength(value, maxBytes) {
  if (value === null || value === undefined || value === '') return null;
  if (!/^[0-9]{1,15}$/.test(value)) throw badRequest('bad content-length');
  const n = Number(value);
  if (n > maxBytes) throw new ApiError('too_large', 'request body is too large');
  return n;
}

// Reads the whole body but never more than maxBytes. Works with or without Content-Length.
export async function readBodyBytes(request, maxBytes = MAX_JSON_BYTES) {
  parseContentLength(request.headers.get('content-length'), maxBytes);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new ApiError('too_large', 'request body is too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Reads a JSON object body (max 64 KiB). Throws ApiError on any problem.
export async function readJson(request, maxBytes = MAX_JSON_BYTES) {
  const bytes = await readBodyBytes(request, maxBytes);
  if (bytes.length === 0) throw badRequest('a JSON body is required');
  let value;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch {
    throw badRequest('body is not valid JSON');
  }
  if (!isObject(value)) throw badRequest('body must be a JSON object');
  return value;
}

// Reads { record, signature } from a JSON body.
export async function readSignedBody(request) {
  const body = await readJson(request);
  if (!isObject(body.record)) throw badRequest('record must be an object');
  if (typeof body.signature !== 'string') throw badRequest('signature must be a string');
  return { record: body.record, signature: body.signature };
}

// Integer query parameter. Missing gives the default. Anything else out of range is a 400.
export function intParam(url, name, { min, max, def }) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return def;
  if (!/^[0-9]{1,15}$/.test(raw)) throw badRequest(`${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw badRequest(`${name} must be ${min} to ${max}`);
  return n;
}

// The client address as seen by Cloudflare. Local dev has none, so it falls back to 'local'.
export function clientIp(request) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return 'local';
  return ip.trim().slice(0, 64) || 'local';
}

// Escapes percent, underscore and backslash for a LIKE pattern used with an ESCAPE backslash clause.
export function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => '\\' + c);
}
