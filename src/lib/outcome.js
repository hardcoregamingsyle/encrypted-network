// After a failed request that sends something to the server: do we know the server did not keep it?
// A clear refusal (the server answered and said no) means it was not kept. No answer at all, a server
// error, or a conflict (which is also what a repeat of something already kept gives) leaves it open.

const REFUSALS = new Set([
  'rate_limited',
  'bad_request',
  'bad_signature',
  'unknown_signer',
  'not_owner',
  'forbidden',
  'expired',
  'too_large',
  'not_found'
]);

export function outcomeUnknown(err) {
  if (err && err.outcomeKnown === true) return false;
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (REFUSALS.has(code)) return false;
  const status = err && Number.isFinite(err.status) ? err.status : 0;
  return status === 0 || status === 408 || status === 409 || status >= 500;
}
