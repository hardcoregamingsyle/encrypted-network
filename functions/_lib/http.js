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

// HEAD answered like GET without a body (uptime monitors and verifiers use it).
export function headOf(getHandler) {
  return async (context) => {
    const res = await getHandler(context);
    return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
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

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

// Turns the 8 groups of an IPv6 address text into numbers, or returns null when it is not one.
function ipv6Groups(text) {
  let t = text;
  const dot = t.lastIndexOf('.');
  if (dot !== -1) {
    // an IPv4 tail such as ::ffff:192.0.2.1 stands for two groups
    const cut = t.lastIndexOf(':');
    const v4 = t.slice(cut + 1).split('.');
    if (v4.length !== 4 || v4.some((p) => !/^[0-9]{1,3}$/.test(p) || Number(p) > 255)) return null;
    const n = v4.map(Number);
    t = t.slice(0, cut + 1) + ((n[0] << 8) | n[1]).toString(16) + ':' + ((n[2] << 8) | n[3]).toString(16);
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const side = (s) => (s === '' ? [] : s.split(':'));
  const left = side(halves[0]);
  const right = halves.length === 2 ? side(halves[1]) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

// The key a client address is limited under. An IPv6 subscriber normally controls a whole /64, so
// every address inside it shares one key (the first 64 bits). An IPv4 mapped IPv6 address counts as
// the IPv4 address. Anything that does not parse is used as it is (cut to 64 characters).
export function addressKey(address) {
  let ip = String(address).trim().toLowerCase();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip.includes(':')) return ip.slice(0, 64);
  const g = ipv6Groups(ip);
  if (!g) return ip.slice(0, 64);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  }
  return 'v6:' + g.slice(0, 4).map((x) => x.toString(16)).join(':');
}

// The key for per address limits, from the address Cloudflare saw. On Cloudflare the header is always
// set. Without it the request is refused, except on a local development host where there is no edge.
export function rateKeyForRequest(request) {
  const raw = request.headers.get('CF-Connecting-IP');
  const ip = raw ? raw.trim() : '';
  if (!ip) {
    if (isLocalHost(new URL(request.url).hostname)) return 'local';
    throw new ApiError('forbidden', 'the address of this request could not be determined');
  }
  return addressKey(ip);
}

// Escapes percent, underscore and backslash for a LIKE pattern used with an ESCAPE backslash clause.
export function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => '\\' + c);
}
