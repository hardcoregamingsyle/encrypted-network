// Blob quota (500 MiB per signer) and its race. Heavy: writes up to 10 x 50 MiB into the local R2 store.
// node tests/review/backend/blobquota.mjs <baseUrl>
// Set HRD_STATE_DIR to the server's persist folder to also check the database rows.
import { LIMITS } from '../../../shared/records.js';
import { assert, check, eq, finish, newPerson, openDb, putBlob, randomBytes, sha256Hex, stampLockHeader } from './_lib.mjs';

const MIB = 1024 * 1024;
const SIZE = 50 * MIB; // 52428800, the largest plaintext, 10 of them are exactly the quota
const PARALLEL = 13;
const QUOTA_FILES = LIMITS.SIGNER_BLOB_QUOTA_BYTES / SIZE;

const who = await newPerson('QuotaRace');

async function bigBlob() {
  const bytes = stampLockHeader(randomBytes(SIZE));
  return { bytes, hash: await sha256Hex(bytes), size: SIZE };
}

async function storedFor(keyId, pendingOnly = false) {
  for (let i = 0; i < 20; i++) {
    try {
      const db = await openDb();
      if (!db) return null;
      const sql = `SELECT COALESCE(SUM(size),0) s FROM blobs WHERE uploader = ?${pendingOnly ? ' AND pending = 1' : ''}`;
      return db.prepare(sql).get(keyId).s;
    } catch {
      await new Promise((r) => setTimeout(r, 100)); // the server holds the file for a moment
    }
  }
  return null;
}

let accepted = 0;

await check(`${PARALLEL} parallel 50 MiB uploads by one signer stay within the ${LIMITS.SIGNER_BLOB_QUOTA_BYTES / MIB} MiB quota`, async () => {
  const blobs = [];
  for (let i = 0; i < PARALLEL; i++) blobs.push(await bigBlob());
  const results = await Promise.all(blobs.map((b) => putBlob(who, b)));
  accepted = results.filter((r) => r.status === 201).length;
  const other = results.filter((r) => r.status !== 201).map((r) => r.status + ' ' + (r.json && r.json.code));
  const stored = await storedFor(who.keyId);
  console.log(`  uploads accepted: ${accepted}, others: ${other.join(', ') || 'none'}, stored bytes for this signer: ${stored === null ? '?' : stored / MIB + ' MiB'}`);
  assert(accepted <= QUOTA_FILES, `${accepted} uploads of 50 MiB were accepted (${accepted * 50} MiB) against a ${LIMITS.SIGNER_BLOB_QUOTA_BYTES / MIB} MiB quota`);
  for (const r of results) {
    if (r.status === 201) continue;
    assert([413, 429].includes(r.status), 'unexpected status ' + r.status + ' ' + (r.json && r.json.code));
  }
  if (stored !== null) assert(stored <= LIMITS.SIGNER_BLOB_QUOTA_BYTES, `stored ${stored / MIB} MiB`);
});

await check('no reservation is left behind once the uploads have ended', async () => {
  const pending = await storedFor(who.keyId, true);
  if (pending === null) return console.log('  (no database access, skipped)');
  eq(pending, 0, 'pending bytes');
});

await check('uploading one at a time fills the quota exactly and then the next upload is refused with 413', async () => {
  for (let i = 0; i < QUOTA_FILES - accepted; i++) {
    const res = await putBlob(who, await bigBlob());
    assert(res.status === 201, `upload ${i} while room is left: HTTP ${res.status} ${res.json && res.json.code}`);
  }
  const res = await putBlob(who, await bigBlob());
  eq(res.status, 413, 'status');
  eq(res.json.code, 'too_large', 'code');
  const stored = await storedFor(who.keyId);
  if (stored !== null) eq(stored, LIMITS.SIGNER_BLOB_QUOTA_BYTES, 'stored bytes');
});

finish();
