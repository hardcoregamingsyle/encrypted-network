// Error type and mapping to JSON responses. Handlers throw ApiError, the middleware turns
// anything thrown into a response. Unknown errors never leak details.

export const STATUS_BY_CODE = Object.freeze({
  bad_request: 400,
  bad_signature: 400,
  unknown_signer: 403,
  not_owner: 403,
  exists: 409,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  too_large: 413,
  expired: 400,
  forbidden: 403,
  server_error: 500
});

export class ApiError extends Error {
  // status defaults from the code. headers is an optional plain object of extra headers.
  constructor(code, message, { status, headers } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status || STATUS_BY_CODE[code] || 500;
    this.headers = headers || null;
  }
}

export const badRequest = (message) => new ApiError('bad_request', message);
export const notFound = (message = 'not found') => new ApiError('not_found', message);

// Body for an error response.
export function errorBody(err) {
  if (err instanceof ApiError) return { error: err.message, code: err.code };
  return { error: 'server error', code: 'server_error' };
}

// Builds the JSON Response for any thrown value.
export function errorResponse(err) {
  const known = err instanceof ApiError;
  const status = known ? err.status : 500;
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (known && err.headers) {
    for (const [k, v] of Object.entries(err.headers)) headers.set(k, String(v));
  }
  return new Response(JSON.stringify(errorBody(err)), { status, headers });
}

// True when a database error is a UNIQUE or PRIMARY KEY constraint failure.
export function isUniqueConflict(err) {
  const text = String((err && err.message) || err || '');
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(text);
}
