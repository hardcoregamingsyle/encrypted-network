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

// ---------------------------------------------------------------------------
// The plain language verdict.
//
// verdictFor(result, trust) maps what openDocument() returned, plus the state of the server key
// (see serverKeyTrust in pin.js), to { tone, headline, line, details }. It is a pure function and it
// is written so that nothing but a complete, anchored, key-checked pass can come out green:
//   tone 'good'  every check passed, the answer is tied to the server's newest record, the server key is
//                the pinned or remembered one (or this is the first visit) and no file check failed
//   tone 'warn'  nothing is wrong that we can show, but something was not fully checked
//   tone 'bad'   a check failed, the server key changed, or the file does not match
// Anything the server could influence is turned into text first, and every comparison is "=== true",
// so a truthy string or a missing field is never read as a pass.

export const CORE_CHECKS = Object.freeze([
  'identities_match',
  'record_signatures',
  'chain_links',
  'single_owner',
  'no_post_revoke',
  'ledger_links',
  'head_matches',
  'checkpoint'
]);

const PLAIN_FAILURES = {
  identities_match: 'The signer details do not match who signed.',
  record_signatures: 'A version was not signed correctly.',
  chain_links: 'The versions do not link up in order.',
  single_owner: 'Someone other than the owner signed a version.',
  no_post_revoke: 'A version was added after the owner withdrew the file.',
  ledger_links: "The server's record of this file has a gap or a change.",
  head_matches: "The newest version does not match the server's record.",
  checkpoint: "The server's proof of the newest version could not be confirmed."
};

// A failed check in plain words, never the raw detail text a server could have shaped.
export function plainFailure(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PLAIN_FAILURES, id)
    ? PLAIN_FAILURES[id]
    : 'One of the checks did not pass.';
}

const TRUST_LINES = {
  'first-visit': "First visit: this browser has now remembered the server's key and will warn you if it changes.",
  'first-visit-unsaved': "First visit: this browser could not save the server's key, so it cannot warn you if the key changes later.",
  'remembered-match': "The server's key is the same one this browser remembered from an earlier visit.",
  'pinned-match': "The server's key is the one you chose to trust on purpose."
};

const TRUST_STATE_LIST = ['pinned-match', 'pinned-mismatch', 'remembered-match', 'remembered-mismatch', 'first-visit', 'first-visit-unsaved'];

// The sentence for an answer that is older than one this browser saw before. Also used on the file page.
export const ROLLBACK_LINE =
  'This answer is older than one this browser saw earlier. The server may be showing an old copy, so a newer version could exist. Do not rely on it.';

// How strong the green is depends on what this browser knows about the server key. A key chosen on purpose
// is the only one that does not come from the server itself. A remembered key was trusted on its first
// visit. A first visit shows that the server agrees with itself and nothing more.
const VERIFIED_LINES = {
  'pinned-match': 'Not changed since it was signed. The server you chose to trust says this is the newest version.',
  'remembered-match': 'Not changed since signed. A server this browser knows says it is the newest.',
  'first-visit': 'Not changed since signed. The server says it is the newest, but this browser has not met it before.',
  '': 'Not changed since signed. The server says it is the newest version.'
};

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cleanText(v, max = 60) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// The verification object from an openDocument() result, or from a bare verification, or null.
function verificationOf(result) {
  if (!isObj(result)) return null;
  if (isObj(result.verification)) return result.verification;
  if (Array.isArray(result.checks)) return result;
  return null;
}

// How the file checks went: 'none' | 'locked-only' | 'matches' | 'bad' | 'not-opened'
export function fileState(result) {
  if (!isObj(result)) return 'none';
  const blob = isObj(result.blobCheck) ? result.blobCheck : null;
  const plain = isObj(result.plaintextCheck) ? result.plaintextCheck : null;
  if (blob && blob.ok !== true) return 'bad';
  if (plain) {
    if (plain.ok === true) return blob && blob.ok === true ? 'matches' : 'bad';
    // Unlocked but not equal to the signed commitment: the file was changed. Not unlocked at all (no
    // fingerprint): the password was wrong or the file is damaged.
    return typeof result.fingerprint === 'string' && result.fingerprint !== '' ? 'bad' : 'not-opened';
  }
  if (blob && blob.ok === true) return 'locked-only';
  return 'none';
}

function headFacts(verification) {
  const head = isObj(verification.head) ? verification.head : null;
  if (!head) return { version: null, label: '', signerName: '', signerKeyId: '' };
  return {
    version: Number.isSafeInteger(head.version) && head.version > 0 ? head.version : null,
    label: cleanText(head.label, 120),
    signerName: cleanText(head.signerName, 60),
    signerKeyId: typeof head.signer === 'string' && /^[0-9a-f]{64}$/.test(head.signer) ? head.signer : ''
  };
}

function build(tone, headline, line, details) {
  return { tone, headline, line, details };
}

// -> { tone: 'good' | 'warn' | 'bad', headline, line, details }
// details: { kind, checked, trust, trustLine, failedCheck, file, version, label, signerName, signerKeyId, status }
//   kind is a stable word for tests and styling: verified, unanchored, withdrawn, key-unchecked, partial,
//   file-not-opened, no-answer, failed, file-mismatch, key-changed
export function verdictFor(result, trust) {
  const verification = verificationOf(result);
  const trustState = typeof trust === 'string' && TRUST_STATE_LIST.includes(trust) ? trust : '';
  const base = {
    trust: trustState,
    trustLine: Object.prototype.hasOwnProperty.call(TRUST_LINES, trustState) ? TRUST_LINES[trustState] : '',
    checked: '',
    failedCheck: null,
    file: fileState(result),
    version: null,
    label: '',
    signerName: '',
    signerKeyId: '',
    status: ''
  };

  if (!verification) {
    return build('warn', 'Could not check this file', 'No usable answer came back, so nothing was verified.', {
      ...base,
      kind: 'no-answer'
    });
  }

  const status = verification.status === 'revoked' || verification.status === 'active' ? verification.status : 'invalid';
  const info = { ...base, ...headFacts(verification), status };

  // 1. The server key is not the one this browser trusts. This wins over everything else.
  if (trustState.endsWith('-mismatch') || pinMismatch(verification)) {
    let line = "This site's server key is not the key this browser expects. Do not rely on this answer until you know why.";
    if (trustState === 'pinned-mismatch') {
      line = "This site's server key is not the key you chose to trust. Do not rely on this answer until you know why.";
    } else if (trustState === 'remembered-mismatch') {
      line = "This site's server key is not the one this browser remembered. Do not rely on this answer until you know why.";
    }
    return build('bad', "The server's identity changed since your last visit.", line, { ...info, trustLine: '', kind: 'key-changed' });
  }

  const checks = Array.isArray(verification.checks) ? verification.checks.filter(isObj) : [];
  const failed = checks.filter((c) => c.ok !== true);
  const missing = CORE_CHECKS.filter((id) => !checks.some((c) => c.id === id));
  const failedCheck = failed.length > 0 ? { id: cleanText(String(failed[0].id), 40), text: plainFailure(failed[0].id) } : null;
  const okFlag = verification.ok === true;

  // The one failure that is not an attack signal: the signing and links are fine, the answer just is not
  // tied to the server's newest record. It is shown as a warning, never as green.
  const unanchoredOnly =
    !okFlag &&
    failed.length === 1 &&
    failed[0].id === 'checkpoint' &&
    typeof failed[0].detail === 'string' &&
    /not tied to the server/i.test(failed[0].detail) &&
    missing.length === 0;

  // 2. A real failure.
  if (!okFlag && !unanchoredOnly) {
    const shown = failedCheck || { id: '', text: 'The checks did not all pass.' };
    return build('bad', 'Do not trust this file.', shown.text, { ...info, failedCheck: shown, kind: 'failed' });
  }
  if (okFlag && failedCheck) {
    // The overall flag says pass but a check says otherwise: the flag is not believed.
    return build('bad', 'Do not trust this file.', failedCheck.text, { ...info, failedCheck, kind: 'failed' });
  }

  // 3. The file itself does not match what the owner signed.
  if (info.file === 'bad') {
    const text = 'The file does not match what the owner signed.';
    return build('bad', 'Do not trust this file.', text, { ...info, failedCheck: { id: 'file', text }, kind: 'file-mismatch' });
  }

  // 4. This answer is older than one this browser saw before. An old copy with a fresh, valid proof is
  // exactly what a hostile or stale server would show, so it is never green and never a quiet warning.
  if (verification.rollback === true) {
    return build('bad', 'Older than expected', ROLLBACK_LINE, { ...info, trustLine: '', kind: 'rollback' });
  }

  // 5. Fewer checks ran than a full verification runs, or the answer names no version or no known status.
  if (missing.length > 0 || (okFlag && (status === 'invalid' || info.version === null))) {
    return build(
      'warn',
      'Only some checks ran',
      'Not every check was run, so this is not shown as verified. Open the details to see which ones did.',
      { ...info, kind: 'partial' }
    );
  }

  const anchored = okFlag && verification.anchored === true;

  // 6. Withdrawn by the owner. The history itself is intact.
  if (okFlag && status === 'revoked') {
    return build(
      'warn',
      'Withdrawn',
      anchored
        ? 'The owner withdrew this file. Withdrawn files stay in the history.'
        : "The owner withdrew this file. This answer is not tied to the server's newest record. Withdrawn files stay in the history.",
      { ...info, kind: 'withdrawn' }
    );
  }

  // 7. The signing is fine but nothing ties the answer to the server's newest record.
  if (!anchored) {
    return build(
      'warn',
      'Not confirmed as the latest version',
      "The signing checks out but this answer is not tied to the server's newest record, so a newer version may exist.",
      { ...info, kind: 'unanchored' }
    );
  }

  // 8. The server key must have been compared with a key that is known. A first visit is compared with
  // the key being remembered, so the proof must still have been checked against it.
  if (!serverKeyPinned(verification)) {
    return build(
      'warn',
      "The server's key was not checked",
      "The signing and version order are fine, but the server's key was not compared with a key this browser knows, so this only shows the answer agrees with itself.",
      { ...info, trustLine: '', kind: 'key-unchecked' }
    );
  }

  // 9. This browser could not save the key it saw, so it cannot notice a change later.
  if (trustState === 'first-visit-unsaved') {
    return build(
      'warn',
      'Checked, but the server key was not saved',
      "Not changed since signed, but this browser cannot save the server's key, so a different key on a later visit would not be noticed.",
      { ...info, kind: 'key-unsaved' }
    );
  }

  // 10. A password was used but did not open the file.
  if (info.file === 'not-opened') {
    return build(
      'warn',
      'The file could not be opened',
      'The record checks out, but the password did not open the file, so the file itself was not checked.',
      { ...info, kind: 'file-not-opened' }
    );
  }

  const trustLine = info.trustLine || "The server's key was checked against a key this browser had on record.";
  const checked =
    info.file === 'matches'
      ? "Checked: who signed each version, the order of versions, the server's signed proof of the newest version, and the file itself."
      : "Checked: who signed each version, the order of versions and the server's signed proof of the newest version.";
  const known = trustState === 'pinned-match' || trustState === 'remembered-match' || trustState === 'first-visit';
  const strength = trustState === 'pinned-match' ? 'pinned' : trustState === 'remembered-match' ? 'remembered' : trustState === 'first-visit' ? 'first' : 'unknown';
  const headline = strength === 'first' ? 'Checked, first visit' : 'Verified';
  return build('good', headline, VERIFIED_LINES[known ? trustState : ''], { ...info, trustLine, checked, strength, kind: 'verified' });
}
