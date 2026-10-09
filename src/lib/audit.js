// Full ledger audit. Walks the ledger page by page and re-checks everything in the browser:
// every record, every signature, every chain link, the per document rules, and finally the
// server's signed checkpoint against the end of the ledger it just walked.
//
// It is a pure module: the page fetcher is injected, so tests need no network.
//   fetchPage({ after, limit, signal }) -> a page like GET /api/ledger
// The audit never throws. It always returns a result object, also when it was cancelled or the
// network failed halfway (then status says so and the counts cover what was checked).
import { ZERO_HASH, isHex } from '../../shared/encoding.js';
import { verifyCheckpoint } from '../../shared/checkpoint.js';
import { keyIdOf } from '../../shared/keys.js';
import { verifyLedgerPage } from '../../shared/verify.js';

export const PAGE_LIMIT = 200;
export const PROBLEM_CAP = 50;
const DEFAULT_MAX_PAGES = 20000;
const MAX_TAIL_RETRIES = 3;

const isHash = (s) => isHex(s, 64);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const messageOf = (e) => (e && typeof e.message === 'string' && e.message ? e.message : 'unknown error');

function isAbort(err, signal) {
  return (signal && signal.aborted) || (err && err.name === 'AbortError');
}

// Reads a pin. '' or nothing means not pinned. A malformed value is reported, never ignored.
function readPin(value) {
  if (value === undefined || value === null) return { pin: '', bad: false };
  if (typeof value !== 'string') return { pin: '', bad: true };
  const t = value.trim().toLowerCase();
  if (t === '') return { pin: '', bad: false };
  return isHash(t) ? { pin: t, bad: false } : { pin: '', bad: true };
}

// An earlier ledger position the caller saved: { seq, hash }. Returns null when none was given.
function readKnownPoint(value) {
  if (value === undefined || value === null) return { point: null, bad: false };
  if (isObject(value) && Number.isSafeInteger(value.seq) && value.seq >= 1 && typeof value.hash === 'string') {
    const hash = value.hash.trim().toLowerCase();
    if (isHash(hash)) return { point: { seq: value.seq, hash }, bad: false };
  }
  return { point: null, bad: true };
}

// Checks the final checkpoint against the end of the walked ledger. Adds to problems and warnings
// through the two callbacks and returns a summary for display.
async function checkFinalCheckpoint(page, ctx) {
  const { pin, lastSeq, lastHash, addProblem, addWarning } = ctx;
  const info = {
    present: false,
    signatureOk: false,
    scopeOk: false,
    seq: null,
    hash: null,
    signedAt: null,
    serverKeyId: null,
    pinMatches: pin ? false : null,
    matchesEnd: false
  };
  const cp = isObject(page) ? page.checkpoint : null;
  const server = isObject(page) ? page.server : null;

  if (!isObject(cp) || !isObject(cp.payload)) {
    addWarning('The server did not send a signed checkpoint, so the end of the ledger could not be confirmed.');
    if (pin) addProblem('A server key is pinned but the server sent no signed checkpoint.');
    return info;
  }
  info.present = true;
  info.seq = Number.isSafeInteger(cp.payload.seq) ? cp.payload.seq : null;
  info.hash = typeof cp.payload.hash === 'string' ? cp.payload.hash : null;
  info.signedAt = Number.isSafeInteger(cp.payload.signedAt) ? cp.payload.signedAt : null;

  if (!isObject(server) || !isObject(server.publicKey)) {
    addProblem('The checkpoint came without the server key needed to check it.');
    return info;
  }
  let keyId = null;
  try {
    keyId = await keyIdOf(server.publicKey);
  } catch {
    keyId = null;
  }
  if (keyId === null) {
    addProblem('The server key sent with the checkpoint is not a valid key.');
    return info;
  }
  info.serverKeyId = keyId;
  if (server.keyId !== keyId) addProblem('The server key id does not match the server key that was sent.');
  if (pin) {
    info.pinMatches = keyId === pin;
    if (!info.pinMatches) {
      addProblem(`The server key ${keyId} is NOT the pinned key ${pin}. Do not trust this server.`);
    }
  } else {
    addWarning('The server key is not pinned, so this audit cannot tell whether the server is the one you meant to check.');
  }

  info.signatureOk = await verifyCheckpoint(server.publicKey, cp);
  if (!info.signatureOk) {
    addProblem('The checkpoint signature does not verify under the server key.');
    return info;
  }
  info.scopeOk = cp.payload.scope === 'ledger';
  if (!info.scopeOk) {
    addProblem('The checkpoint is not for the ledger.');
    return info;
  }
  const seqOk = info.seq === lastSeq;
  const hashOk = info.hash === lastHash;
  info.matchesEnd = seqOk && hashOk;
  if (!seqOk) {
    addProblem(`The signed checkpoint says the ledger is at entry ${info.seq}, but the audit reached entry ${lastSeq}.`);
  } else if (!hashOk) {
    addProblem('The signed checkpoint hash differs from the last ledger hash the audit computed.');
  }
  return info;
}

// Runs the audit. Options:
//   fetchPage         required, async ({ after, limit, signal }) -> page
//   signal            AbortSignal, aborting ends the audit with status 'aborted'
//   pinnedServerKeyId 64 hex or '' (not pinned)
//   knownPoint        { seq, hash } saved from an earlier audit, the ledger must still contain it
//   limit             entries per page, default 200
//   maxPages          safety cap on the number of pages
//   onProgress        ({ phase, entries, pages, documents, problemCount, total }) called after each page
export async function auditLedger(options = {}) {
  const opts = isObject(options) ? options : {};
  const fetchPage = opts.fetchPage;
  const signal = opts.signal || null;
  const limit = Number.isSafeInteger(opts.limit) && opts.limit >= 1 && opts.limit <= 500 ? opts.limit : PAGE_LIMIT;
  const maxPages = Number.isSafeInteger(opts.maxPages) && opts.maxPages >= 1 ? opts.maxPages : DEFAULT_MAX_PAGES;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const { pin, bad: badPin } = readPin(opts.pinnedServerKeyId);
  const { point: knownPoint, bad: badKnown } = readKnownPoint(opts.knownPoint);

  const problems = [];
  let problemCount = 0;
  const warnings = new Set();
  const addProblem = (text) => {
    problemCount += 1;
    if (problems.length < PROBLEM_CAP) problems.push(text);
  };
  const addWarning = (text) => warnings.add(text);

  const docState = new Map();
  let after = 0; // seq of the last entry taken in
  let lastHash = ZERO_HASH;
  let entries = 0;
  let pages = 0;
  let total = null;
  let status = 'done';
  let error = null;
  let knownPointSeen = false;
  let checkpoint = null;

  if (badPin) addProblem('The pinned server key id is not valid (it must be 64 hex characters).');
  if (badKnown) addProblem('The saved ledger position is not valid (it needs an entry number and a 64 character hash).');
  if (typeof fetchPage !== 'function') {
    addProblem('No way to fetch the ledger was given.');
    status = 'error';
    error = 'no fetch function';
  }

  const report = (phase) => {
    if (!onProgress) return;
    try {
      onProgress({ phase, entries, pages, documents: docState.size, problemCount, total });
    } catch {
      // a broken progress callback must not stop the audit
    }
  };

  let finalPage = null;
  let tailRetries = 0;

  try {
    while (status === 'done') {
      if (signal && signal.aborted) {
        status = 'aborted';
        break;
      }
      if (pages >= maxPages) {
        status = 'incomplete';
        addProblem(`The audit stopped after ${pages} pages without reaching the end of the ledger.`);
        break;
      }
      const page = await fetchPage({ after, limit, signal });
      pages += 1;
      if (signal && signal.aborted) {
        status = 'aborted';
        break;
      }
      if (!isObject(page) || !Array.isArray(page.entries)) {
        status = 'incomplete';
        addProblem('The server sent a ledger page without an entries list.');
        break;
      }
      if (isObject(page.checkpoint) && isObject(page.checkpoint.payload) && Number.isSafeInteger(page.checkpoint.payload.seq)) {
        total = page.checkpoint.payload.seq;
      }

      if (page.entries.length === 0) {
        if (page.hasMore === true) {
          status = 'incomplete';
          addProblem('The server said there are more entries but sent none.');
          break;
        }
        // The server's head moved while we were walking: take the new entries too.
        if (total !== null && total > after && tailRetries < MAX_TAIL_RETRIES) {
          tailRetries += 1;
          continue;
        }
        finalPage = page;
        break;
      }

      const result = await verifyLedgerPage(page, { startSeq: after + 1, startPrev: lastHash, docState });
      for (const text of result.problems) addProblem(text);
      for (const text of result.warnings) addWarning(text);
      entries += page.entries.length;

      if (knownPoint && !knownPointSeen) {
        const hit = page.entries.find((e) => isObject(e) && e.seq === knownPoint.seq);
        if (hit) {
          knownPointSeen = true;
          if (hit.ledgerHash !== knownPoint.hash) {
            addProblem(`Entry ${knownPoint.seq} has a different hash than the position you saved. The history was changed.`);
          }
        }
      }

      // Carry on from what the last entry claims, so one fault is reported once and later pages
      // are still judged on their own.
      const last = page.entries[page.entries.length - 1];
      const nextAfter = isObject(last) && Number.isSafeInteger(last.seq) ? last.seq : null;
      if (nextAfter === null || nextAfter <= after) {
        status = 'incomplete';
        addProblem('The ledger page did not move forward, so the audit stopped.');
        break;
      }
      after = nextAfter;
      if (isHash(last.ledgerHash)) lastHash = last.ledgerHash;
      report('walking');
    }

    if (status === 'done') {
      report('checkpoint');
      checkpoint = await checkFinalCheckpoint(finalPage, { pin, lastSeq: after, lastHash, addProblem, addWarning });
      if (knownPoint && !knownPointSeen) {
        addProblem(`The ledger ends at entry ${after}, before the position you saved (entry ${knownPoint.seq}).`);
      }
      if (!knownPoint) {
        addWarning(
          'This audit shows the ledger agrees with itself and with the server checkpoint. ' +
            'It cannot show that nothing was left out unless you compare with a ledger position you saved earlier.'
        );
      }
    }
  } catch (err) {
    if (isAbort(err, signal)) {
      status = 'aborted';
    } else {
      status = 'error';
      error = messageOf(err);
    }
  }

  if (status !== 'done') {
    addWarning('The audit did not finish, so nothing below says the whole ledger is sound.');
  }
  report(status === 'done' ? 'done' : status);

  return {
    ok: status === 'done' && problemCount === 0,
    status,
    error,
    entries,
    documents: docState.size,
    pages,
    lastSeq: after,
    lastHash,
    problems,
    problemCount,
    warnings: Array.from(warnings),
    checkpoint,
    pinned: pin || null,
    knownPointChecked: knownPoint !== null && knownPointSeen
  };
}
