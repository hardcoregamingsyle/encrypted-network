// Rollback and fork memory. Pure logic only: the caller keeps the stored value.
// A "seen head" is { docId, headVersion, headRecordHash, ledgerSeq, checkpointSeq }: ids, numbers and
// hashes only. After a good open the caller stores it. On the next open, compareWithSeen tells
// whether the server now shows less than this browser already saw. This is a cheap local check. It
// cannot catch a rollback the browser never saw, and it is not a replacement for a full ledger audit.

const HASH_RE = /^[0-9a-f]{64}$/;
const DOC_ID_RE = /^[0-9a-f]{32}$/;

function isObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isCount(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

// Returns a clean seen head, or null when the value is not usable.
export function cleanSeenHead(value) {
  if (!isObj(value)) return null;
  const { docId, headVersion, headRecordHash, ledgerSeq, checkpointSeq } = value;
  if (typeof docId !== 'string' || !DOC_ID_RE.test(docId)) return null;
  if (!Number.isSafeInteger(headVersion) || headVersion < 1) return null;
  if (typeof headRecordHash !== 'string' || !HASH_RE.test(headRecordHash)) return null;
  if (!isCount(ledgerSeq)) return null;
  return {
    docId,
    headVersion,
    headRecordHash,
    ledgerSeq,
    checkpointSeq: isCount(checkpointSeq) ? checkpointSeq : 0
  };
}

// Reads the head position out of a document bundle. Returns null when the bundle has no usable head.
// Nothing is trusted here, the caller only uses it together with a verification result.
export function headFromBundle(bundle, docId) {
  if (!isObj(bundle) || !Array.isArray(bundle.records) || bundle.records.length === 0) return null;
  const rows = bundle.records;
  const last = rows[rows.length - 1];
  if (!isObj(last) || !isObj(last.record)) return null;
  const hashes = {};
  for (const row of rows) {
    if (isObj(row) && isObj(row.record) && Number.isSafeInteger(row.record.version) && typeof row.recordHash === 'string') {
      hashes[row.record.version] = row.recordHash;
    }
  }
  const cp = isObj(bundle.checkpoint) && isObj(bundle.checkpoint.payload) ? bundle.checkpoint.payload : null;
  const head = cleanSeenHead({
    docId,
    headVersion: last.record.version,
    headRecordHash: last.recordHash,
    ledgerSeq: last.ledgerSeq,
    checkpointSeq: cp && isCount(cp.seq) ? cp.seq : 0
  });
  if (!head) return null;
  return { head, hashes };
}

// Compares what the server shows now with the head seen earlier.
// Returns { rollback:boolean, warnings:[string] }. No stored value means no warning.
export function compareWithSeen(seen, bundle, docId) {
  const old = cleanSeenHead(seen);
  if (!old || old.docId !== docId) return { rollback: false, warnings: [] };
  const now = headFromBundle(bundle, docId);
  if (!now) return { rollback: false, warnings: [] };
  const warnings = [];
  const tail =
    ' Do not treat this as the latest version until you know why. If you cleared your records on purpose, forget the remembered position and open the document again.';

  if (now.head.headVersion < old.headVersion) {
    warnings.push(
      'The document went back: this browser saw version ' +
        old.headVersion +
        ' earlier, but the server now shows version ' +
        now.head.headVersion +
        ' as the latest. A newer version may have been hidden or removed.' +
        tail
    );
  } else if (now.hashes[old.headVersion] !== old.headRecordHash) {
    warnings.push(
      'The history changed: the version ' +
        old.headVersion +
        ' this browser saw earlier is not the same signed record as the version ' +
        old.headVersion +
        ' the server shows now. The document may have been forked or rolled back.' +
        tail
    );
  }
  if (now.head.checkpointSeq > 0 && old.checkpointSeq > 0 && now.head.checkpointSeq < old.checkpointSeq) {
    warnings.push(
      'The server ledger went back: this browser saw the ledger at position ' +
        old.checkpointSeq +
        ' earlier, and it is now at ' +
        now.head.checkpointSeq +
        '. A ledger only grows, so entries may have been removed.' +
        tail
    );
  }
  return { rollback: warnings.length > 0, warnings };
}

// The value to store after an open. A head that went back or forked never replaces the one already
// remembered, so the warning keeps showing until the person clears it. Returns null when nothing should be stored.
export function nextSeenHead(seen, bundle, docId, comparison) {
  const now = headFromBundle(bundle, docId);
  if (!now) return null;
  const old = cleanSeenHead(seen);
  if (!old || old.docId !== docId) return now.head;
  if (comparison && comparison.rollback) return null;
  return {
    ...now.head,
    checkpointSeq: Math.max(now.head.checkpointSeq, old.checkpointSeq)
  };
}
