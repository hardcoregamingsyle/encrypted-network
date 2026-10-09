// Runs for every request that reaches a function. Adds security headers, turns thrown errors
// into JSON, and makes sure an unknown /api route answers with a JSON 404 instead of the app page.
import { ApiError, errorResponse } from './_lib/errors.js';

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
});

export function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

// Copies the response so its headers can be changed, then adds the common headers.
export function withHeaders(response, api) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (api && !headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function looksLikePage(response) {
  const type = response.headers.get('Content-Type') || '';
  return type.includes('text/html');
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const api = isApiPath(url.pathname);
  let response;
  try {
    response = await context.next();
    // An /api path that no function handled falls through to the static files, which would
    // answer with the app page. Replace that with a JSON 404.
    if (api && looksLikePage(response)) {
      response = errorResponse(new ApiError('not_found', 'no such API route'));
    }
  } catch (err) {
    if (!(err instanceof ApiError)) console.error('unhandled error: ' + (err && err.stack ? err.stack : err));
    response = errorResponse(err);
  }
  return withHeaders(response, api);
}
