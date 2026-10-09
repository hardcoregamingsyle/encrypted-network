// What a verification result says about the server key. Read from the result of
// verifyDocumentBundle only, never from the unsigned key id text a server states about itself.
//
// The checkpoint check recomputes the key id from the server public key and compares it with the
// pin, so a passing checkpoint check that did not warn "not pinned" means the answer was signed by
// the pinned key.

function checkpointCheck(verification) {
  const checks = verification && Array.isArray(verification.checks) ? verification.checks : [];
  return checks.find((c) => c && c.id === 'checkpoint') || null;
}

// True when the whole result passed and the server checkpoint was checked against a pinned key.
export function serverKeyPinned(verification) {
  if (!verification || verification.ok !== true) return false;
  const cp = checkpointCheck(verification);
  if (!cp || cp.ok !== true) return false;
  const detail = typeof cp.detail === 'string' ? cp.detail : '';
  if (/not pinned/i.test(detail)) return false;
  const warnings = Array.isArray(verification.warnings) ? verification.warnings : [];
  return !warnings.some((w) => typeof w === 'string' && /server key was not pinned/i.test(w));
}

// True when a pin was set and the checkpoint check failed because the key is another one.
export function pinMismatch(verification) {
  const cp = checkpointCheck(verification);
  return Boolean(cp && cp.ok === false && /not the pinned key/i.test(typeof cp.detail === 'string' ? cp.detail : ''));
}
