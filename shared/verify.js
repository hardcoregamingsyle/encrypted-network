// Independent verification of bundles, files, ledger pages and chat pages.
// Nothing here trusts the server: every hash and signature is recomputed.
// None of the exported functions throw on malformed input.
import { canonicalize, isPlainObject } from './canonical.js';
import { ZERO_HASH, isHex, timingSafeEqual } from './encoding.js';
import { chainHash, computeCommitment, sha256Hex } from './hash.js';
import { keyIdOf, normalizePublicJwkShape, verifyRecord } from './keys.js';
import { verifyCheckpoint } from './checkpoint.js';
import { DOC_RECORD_TYPES, recordHash, validateRecord } from './records.js';

const LATEST_WARNING =
  'Latest means latest as of the checkpoint time. The server could only hide a newer version by not ' +
  'publishing it, which a full ledger audit by the caller can detect if they hold an older pinned checkpoint.';

const LATE_SKEW_MS = 10 * 60 * 1000;

const CHECK_IDS = [
  'identities_match',
  'record_signatures',
  'chain_links',
  'single_owner',
  'no_post_revoke',
  'ledger_links',
  'head_matches',
  'checkpoint'
];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isHash = (s) => isHex(s, 64);
const msg = (e) => (e && e.message ? e.message : 'unknown error');
const pass = (detail) => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });

function problemsToResult(problems, okDetail) {
  if (problems.length === 0) return pass(okDetail);
  const shown = problems.slice(0, 3).join('; ');
  return fail(problems.length > 3 ? `${shown}; and ${problems.length - 3} more` : shown);
}

// Reads the pinned server key id. undefined, null and an empty string mean "not pinned".
// Anything else must be a 64 hex key id, otherwise the pin is malformed and checks fail closed
// (a mistyped pin must never turn into "not pinned").
function readPin(value) {
  if (value === undefined || value === null) return { pinned: null, bad: false };
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t === '') return { pinned: null, bad: false };
    if (isHash(t)) return { pinned: t, bad: false };
  }
  return { pinned: null, bad: true };
}

// Reads one option from any object without throwing (a throwing getter counts as missing).
function readOption(opts, key) {
  try {
    return opts !== null && typeof opts === 'object' ? opts[key] : undefined;
  } catch {
    return undefined;
  }
}

// Checks one identity entry: keyId matches the key, self signature verifies, outer fields agree.
// Returns an error string or null.
async function identityError(entry, mapKey) {
  if (!isPlainObject(entry)) return 'identity entry is not an object';
  const rec = entry.record;
  const v = validateRecord(rec);
  if (!v.ok || rec.type !== 'identity') return 'identity record is invalid';
  let id;
  try {
    id = await keyIdOf(rec.publicKey);
  } catch {
    return 'identity public key is invalid';
  }
  if (entry.keyId !== id) return 'identity keyId does not match its public key';
  if (mapKey !== undefined && mapKey !== id) return 'identity is listed under the wrong key id';
  if (has(entry, 'publicKey')) {
    try {
      if (canonicalize(normalizePublicJwkShape(entry.publicKey)) !== canonicalize(rec.publicKey)) {
        return 'identity publicKey differs from its signed record';
      }
    } catch {
      return 'identity publicKey is invalid';
    }
  }
  if (has(entry, 'displayName') && entry.displayName !== rec.displayName) return 'identity displayName differs from its signed record';
  if (has(entry, 'createdAt') && entry.createdAt !== rec.createdAt) return 'identity createdAt differs from its signed record';
  if (!(await verifyRecord(rec.publicKey, rec, entry.signature))) return 'identity self signature does not verify';
  return null;
}

// Caches identity checks for one verification run.
function identityChecker(identities) {
  const cache = new Map();
  const map = isPlainObject(identities) ? identities : {};
  return {
    map,
    lookup(keyId) {
      return typeof keyId === 'string' && has(map, keyId) ? map[keyId] : null;
    },
    check(keyId) {
      if (cache.has(keyId)) return cache.get(keyId);
      const entry = this.lookup(keyId);
      const p = entry ? identityError(entry, keyId) : Promise.resolve('signer has no identity');
      cache.set(keyId, p);
      return p;
    }
  };
}

function shortId(h) {
  return typeof h === 'string' ? h.slice(0, 8) : '?';
}

// ---------------------------------------------------------------------------
// Document bundle

export async function verifyDocumentBundle(bundle, opts = {}) {
  const pin = readPin(readOption(opts, 'pinnedServerKeyId'));
  const pinned = pin.pinned;
  const nowOpt = readOption(opts, 'now');
  const now = Number.isFinite(nowOpt) ? nowOpt : Date.now();
  const expectedDocId = readOption(opts, 'expectedDocId');
  const maxAgeOpt = readOption(opts, 'maxCheckpointAgeMs');
  const maxAge = Number.isFinite(maxAgeOpt) && maxAgeOpt >= 0 ? maxAgeOpt : null;
  const allowUnanchored = readOption(opts, 'allowUnanchored') === true;
  const warnings = [];
  const results = new Map();
  let anchored = false;

  try {
    const doc = isPlainObject(bundle) && isPlainObject(bundle.document) ? bundle.document : null;
    const rows = isPlainObject(bundle) && Array.isArray(bundle.records) ? bundle.records : [];
    const idCheck = identityChecker(isPlainObject(bundle) ? bundle.identities : null);

    // Per record facts that several checks share.
    const recs = [];
    for (const row of rows) {
      const info = { row, record: null, hash: null, validType: false };
      if (isPlainObject(row) && isPlainObject(row.record)) {
        info.record = row.record;
        info.validType = validateRecord(row.record).ok && DOC_RECORD_TYPES.includes(row.record.type);
        if (info.validType) {
          try {
            info.hash = await recordHash(row.record);
          } catch {
            info.validType = false;
          }
        }
      }
      recs.push(info);
    }

    const run = async (id, fn) => {
      try {
        results.set(id, await fn());
      } catch (err) {
        results.set(id, fail('check could not run: ' + msg(err)));
      }
    };

    await run('identities_match', async () => {
      const keys = isPlainObject(bundle && bundle.identities) ? Object.keys(bundle.identities) : [];
      if (!isPlainObject(bundle && bundle.identities)) return fail('identities are missing');
      const problems = [];
      for (const k of keys) {
        const e = await idCheck.check(k);
        if (e) problems.push(`${shortId(k)}: ${e}`);
      }
      return problemsToResult(problems, `${keys.length} signer identities are self signed and match their key ids`);
    });

    await run('record_signatures', async () => {
      if (rows.length === 0) return fail('the bundle has no records');
      const problems = [];
      for (let i = 0; i < recs.length; i++) {
        const { row, record, hash, validType } = recs[i];
        const label = `record ${i + 1}`;
        if (!validType) {
          const v = record ? validateRecord(record) : null;
          problems.push(`${label}: not a valid document record${v && !v.ok ? ' (' + v.error + ')' : ''}`);
          continue;
        }
        const entry = idCheck.lookup(record.signer);
        if (!entry || !isPlainObject(entry.record)) {
          problems.push(`${label}: signer ${shortId(record.signer)} has no identity in the bundle`);
          continue;
        }
        let signerId = null;
        try {
          signerId = await keyIdOf(entry.record.publicKey);
        } catch {
          // handled below
        }
        if (signerId !== record.signer) {
          problems.push(`${label}: signer key id does not match the identity key`);
          continue;
        }
        if (!(await verifyRecord(entry.record.publicKey, record, row.signature))) {
          problems.push(`${label}: signature does not verify`);
          continue;
        }
        if (row.recordHash !== hash) problems.push(`${label}: stated record hash does not match the record`);
      }
      return problemsToResult(problems, `${recs.length} record signatures verify and every record hash matches`);
    });

    await run('chain_links', async () => {
      if (recs.length === 0) return fail('the bundle has no records');
      const problems = [];
      if (expectedDocId !== undefined && !isHex(expectedDocId, 32)) problems.push('the expected document id is malformed');
      let prevHash = ZERO_HASH;
      for (let i = 0; i < recs.length; i++) {
        const { record, hash, validType } = recs[i];
        if (!validType) {
          problems.push(`record ${i + 1}: not a valid document record`);
          prevHash = null;
          continue;
        }
        if (record.version !== i + 1) problems.push(`record ${i + 1}: has version ${record.version}, expected ${i + 1}`);
        if (prevHash !== null && record.prev !== prevHash) {
          problems.push(`record ${i + 1}: prev does not match the previous record`);
        }
        if (recs[0].validType && record.docId !== recs[0].record.docId) problems.push(`record ${i + 1}: different document id`);
        if (doc && typeof doc.docId === 'string' && record.docId !== doc.docId) {
          problems.push(`record ${i + 1}: document id differs from the document summary`);
        }
        if (typeof expectedDocId === 'string' && record.docId !== expectedDocId) {
          problems.push(`record ${i + 1}: document id is not the one that was asked for`);
        }
        prevHash = hash;
      }
      return problemsToResult(problems, `versions 1 to ${recs.length} are linked by hash from the first record`);
    });

    await run('single_owner', async () => {
      const signers = new Set();
      for (const r of recs) if (r.record) signers.add(r.record.signer);
      if (recs.length === 0) return fail('the bundle has no records');
      if (signers.size !== 1) return fail('records are signed by more than one key');
      return pass(`every record is signed by ${shortId([...signers][0])}`);
    });

    await run('no_post_revoke', async () => {
      const problems = [];
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i].record;
        if (!r) continue;
        if (r.type === 'doc.revoke' && i !== recs.length - 1) problems.push(`record ${i + 1}: a record follows a revoke`);
        if (r.type === 'doc.create' && i !== 0) problems.push(`record ${i + 1}: create is not the first record`);
        if (i > 0 && recs[i - 1].record && r.createdAt < recs[i - 1].record.createdAt) {
          problems.push(`record ${i + 1}: createdAt goes backwards`);
        }
      }
      if (recs.length > 0 && recs[0].record && recs[0].record.type !== 'doc.create') problems.push('the first record is not a create');
      return problemsToResult(problems, 'nothing follows a revoke and time never goes backwards');
    });

    await run('ledger_links', async () => {
      if (recs.length === 0) return fail('the bundle has no records');
      const problems = [];
      let prev = null;
      for (let i = 0; i < recs.length; i++) {
        const { row, hash, validType } = recs[i];
        const label = `record ${i + 1}`;
        if (!isPlainObject(row)) {
          problems.push(`${label}: missing ledger fields`);
          prev = null;
          continue;
        }
        if (!Number.isSafeInteger(row.ledgerSeq) || row.ledgerSeq < 1 || !isHash(row.ledgerHash) || !isHash(row.prevLedgerHash)) {
          problems.push(`${label}: ledger fields are malformed`);
          prev = null;
          continue;
        }
        if (prev && row.ledgerSeq <= prev.ledgerSeq) problems.push(`${label}: ledgerSeq does not increase`);
        if (prev && row.ledgerSeq === prev.ledgerSeq + 1 && row.prevLedgerHash !== prev.ledgerHash) {
          problems.push(`${label}: prevLedgerHash does not match the previous ledger hash`);
        }
        if (row.ledgerSeq === 1 && row.prevLedgerHash !== ZERO_HASH) problems.push(`${label}: first ledger entry must start from the zero hash`);
        if (validType && (await chainHash(row.prevLedgerHash, hash)) !== row.ledgerHash) {
          problems.push(`${label}: ledger hash does not match the record`);
        }
        prev = row;
      }
      return problemsToResult(problems, 'ledger positions increase and every ledger hash recomputes');
    });

    await run('head_matches', async () => {
      if (!doc) return fail('the document summary is missing');
      const last = recs[recs.length - 1];
      if (!last || !last.validType) return fail('the last record is missing or invalid');
      const problems = [];
      if (typeof doc.docId !== 'string') problems.push('the document summary has no docId');
      else if (doc.docId !== last.record.docId) problems.push('docId does not match the records');
      if (doc.headVersion !== last.record.version) problems.push('headVersion does not match the last record');
      if (doc.headRecordHash !== last.hash) problems.push('headRecordHash does not match the last record');
      if (doc.ownerKeyId !== last.record.signer) problems.push('ownerKeyId does not match the signer');
      const expectStatus = last.record.type === 'doc.revoke' ? 'revoked' : 'active';
      if (doc.status !== expectStatus) problems.push(`status should be ${expectStatus}`);
      const first = recs[0];
      if (first.validType && first.record.type === 'doc.create' && typeof doc.listed === 'boolean' && doc.listed !== first.record.listed) {
        warnings.push('The listed flag in the summary differs from the signed create record. The signed record wins.');
      }
      return problemsToResult(problems, `head is version ${last.record.version} and matches the last signed record`);
    });

    await run('checkpoint', async () => {
      const cp = bundle && bundle.checkpoint;
      const server = bundle && bundle.server;
      if (!isPlainObject(cp)) return fail('no checkpoint is present');
      if (!isPlainObject(server)) return fail('no server key is present');
      if (pin.bad) return fail('the pinned server key id is malformed, it must be 64 lowercase hex characters');
      let serverKeyId;
      try {
        serverKeyId = await keyIdOf(server.publicKey);
      } catch {
        return fail('the server public key is invalid');
      }
      if (has(server, 'keyId') && server.keyId !== serverKeyId) return fail('the stated server key id does not match the server key');
      if (!(await verifyCheckpoint(server.publicKey, cp))) return fail('the checkpoint signature is not valid for the server key');
      if (cp.payload.scope !== 'ledger') return fail('the checkpoint is not a ledger checkpoint');
      if (pinned !== null && serverKeyId !== pinned) return fail('the server key is not the pinned key');
      let lastSeq = 0;
      let lastLedgerHash = null;
      for (const r of recs) {
        if (r.row && Number.isSafeInteger(r.row.ledgerSeq) && r.row.ledgerSeq >= lastSeq) {
          lastSeq = r.row.ledgerSeq;
          lastLedgerHash = r.row.ledgerHash;
        }
      }
      if (cp.payload.seq < lastSeq) return fail(`the checkpoint (seq ${cp.payload.seq}) is older than the last record (seq ${lastSeq})`);
      if (cp.payload.seq === lastSeq && cp.payload.hash !== lastLedgerHash) {
        return fail('the checkpoint hash does not match the last ledger hash');
      }

      // Anchoring: tie the records to the server. Two ways. The checkpoint is exactly at the last
      // record (its hash then contains the record hash, which cannot be faked). Or the server signed
      // an attestation of this document's head (scope doc:<docId>).
      const lastRec = recs[recs.length - 1];
      const att = bundle.headCheckpoint;
      let attested = false;
      if (att !== undefined && att !== null) {
        if (!(await verifyCheckpoint(server.publicKey, att))) return fail('the document head attestation is not valid for the server key');
        if (!lastRec || !lastRec.validType) return fail('the last record is missing or invalid');
        const p = att.payload;
        if (p.scope !== 'doc:' + lastRec.record.docId || p.seq !== lastRec.record.version || p.hash !== lastRec.hash) {
          return fail('the document head attestation does not match the last record');
        }
        attested = true;
      }
      const atHead = lastSeq >= 1 && cp.payload.seq === lastSeq && cp.payload.hash === lastLedgerHash;
      anchored = attested || atHead;
      if (!anchored && !allowUnanchored) {
        return fail(
          'the records are not tied to the server: the checkpoint is ahead of this document and the server did not attest the document head'
        );
      }

      if (maxAge !== null) {
        for (const p of attested ? [cp.payload, att.payload] : [cp.payload]) {
          const age = now - p.signedAt;
          if (age > maxAge) return fail(`the checkpoint is ${describeAge(age)} old, the limit is ${describeAge(maxAge)}`);
          if (age < -LATE_SKEW_MS) return fail('the checkpoint is dated in the future compared with this device clock');
        }
      }
      if (!anchored) {
        warnings.push('The records are not tied to the server. The checkpoint only shows where the ledger was, not that this document is in it.');
      }
      if (pinned !== null) return pass('checkpoint signature is valid for the pinned server key');
      warnings.push('The server key was not pinned, so this does not prove the checkpoint came from the server you expect. Pin its key id to check that.');
      return pass('checkpoint signature is valid for the key the server presented (not pinned)');
    });

    const checks = CHECK_IDS.map((id) => ({ id, ok: results.get(id).ok, detail: results.get(id).detail }));
    const ok = checks.every((c) => c.ok);

    const cp = bundle && bundle.checkpoint;
    if (ok && isPlainObject(cp) && isPlainObject(cp.payload) && Number.isFinite(cp.payload.signedAt)) {
      const ageMs = now - cp.payload.signedAt;
      if (ageMs < -LATE_SKEW_MS) warnings.push('The checkpoint is dated in the future compared with this device clock.');
      else warnings.push(`The checkpoint was signed ${describeAge(ageMs)} before this check.`);
    }
    warnings.push(LATEST_WARNING);

    let head = null;
    let status = 'invalid';
    if (ok) {
      const last = recs[recs.length - 1].record;
      let labelRec = null;
      for (let i = recs.length - 1; i >= 0; i--) {
        if (has(recs[i].record, 'label')) {
          labelRec = recs[i].record;
          break;
        }
      }
      const idEntry = idCheck.lookup(last.signer);
      status = last.type === 'doc.revoke' ? 'revoked' : 'active';
      head = {
        docId: last.docId,
        version: last.version,
        recordHash: recs[recs.length - 1].hash,
        blobHash: last.type === 'doc.revoke' ? null : last.blob.hash,
        label: labelRec ? labelRec.label : '',
        signer: last.signer,
        signerName: idEntry.record.displayName,
        createdAt: last.createdAt
      };
    }
    return { ok, status, head, anchored: ok && anchored, checks, warnings };
  } catch (err) {
    return {
      ok: false,
      status: 'invalid',
      head: null,
      anchored: false,
      checks: CHECK_IDS.map((id) => ({ id, ok: false, detail: 'bundle could not be checked: ' + msg(err) })),
      warnings: [LATEST_WARNING]
    };
  }
}

function describeAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

// ---------------------------------------------------------------------------
// Files

// Checks the downloaded (still locked) bytes against the signed blob entry.
export async function verifyBlobBytes(bytes, record) {
  try {
    let b = bytes;
    if (b instanceof ArrayBuffer) b = new Uint8Array(b);
    if (!(b instanceof Uint8Array)) return { ok: false, detail: 'file bytes are missing' };
    if (!isPlainObject(record) || !isPlainObject(record.blob) || !isHash(record.blob.hash) || !Number.isSafeInteger(record.blob.size)) {
      return { ok: false, detail: 'the record has no file entry' };
    }
    if (b.length !== record.blob.size) {
      return { ok: false, detail: `file size ${b.length} differs from the signed size ${record.blob.size}` };
    }
    const h = await sha256Hex(b);
    if (!timingSafeEqual(h, record.blob.hash)) return { ok: false, detail: 'file hash differs from the signed hash' };
    return { ok: true, detail: 'file bytes match the signed size and sha256 hash' };
  } catch (err) {
    return { ok: false, detail: 'file could not be checked: ' + msg(err) };
  }
}

// Checks the unlocked file's fingerprint and salt against the signed commitment.
export async function verifyPlaintext(input, record) {
  try {
    if (!isPlainObject(input) || !isHex(input.fileHash, 64) || !isHex(input.commitSalt, 32)) {
      return { ok: false, detail: 'fileHash or commitSalt is malformed' };
    }
    if (!isPlainObject(record) || !isHash(record.commitment)) return { ok: false, detail: 'the record has no commitment' };
    const c = await computeCommitment({ fileHash: input.fileHash, commitSalt: input.commitSalt });
    if (!timingSafeEqual(c, record.commitment)) return { ok: false, detail: 'unlocked file does not match the signed commitment' };
    return { ok: true, detail: 'unlocked file fingerprint matches the signed commitment' };
  } catch (err) {
    return { ok: false, detail: 'file could not be checked: ' + msg(err) };
  }
}

// ---------------------------------------------------------------------------
// Ledger pages

// page = { entries:[{ seq, recordHash, prevLedgerHash, ledgerHash, record, signature }], identities }
// options.docState (optional Map) carries per document state between pages for a full audit.
// options.allowMidChain: true lets a document appear without its create record (the page is a slice
// that does not start at the genesis). Without it that is a problem, and from the genesis
// (startSeq 1, startPrev ZERO_HASH) it is always a problem.
export async function verifyLedgerPage(page, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const startPrev = opts.startPrev === undefined ? ZERO_HASH : opts.startPrev;
  const startSeq = opts.startSeq === undefined ? 1 : opts.startSeq;
  const docState = opts.docState instanceof Map ? opts.docState : new Map();
  const fromGenesis = startSeq === 1 && startPrev === ZERO_HASH;
  const allowMidChain = opts.allowMidChain === true && !fromGenesis;
  const problems = [];
  const warnings = [];
  let lastSeq = Number.isSafeInteger(startSeq) ? startSeq - 1 : 0;
  let lastHash = isHash(startPrev) ? startPrev : ZERO_HASH;
  try {
    if (!isPlainObject(page) || !Array.isArray(page.entries)) {
      return { ok: false, lastSeq, lastHash, problems: ['the page has no entries list'], warnings, docState };
    }
    if (!Number.isSafeInteger(startSeq) || startSeq < 1 || !isHash(startPrev)) {
      return { ok: false, lastSeq, lastHash, problems: ['startSeq or startPrev is malformed'], warnings, docState };
    }
    const idCheck = identityChecker(page.identities);
    let expectSeq = startSeq;
    let expectPrev = startPrev;
    let linked = true; // true while every entry so far verified
    const midChain = new Set();

    for (const entry of page.entries) {
      const before = problems.length;
      const label = `entry ${isPlainObject(entry) && Number.isSafeInteger(entry.seq) ? entry.seq : '?'}`;
      if (!isPlainObject(entry)) {
        problems.push(`${label}: not an object`);
        linked = false;
        continue;
      }
      if (entry.seq !== expectSeq) problems.push(`${label}: expected seq ${expectSeq}`);
      if (entry.prevLedgerHash !== expectPrev) problems.push(`${label}: prevLedgerHash does not link to the previous entry`);
      const rec = entry.record;
      const v = validateRecord(rec);
      let hash = null;
      if (!v.ok || !DOC_RECORD_TYPES.includes(rec.type)) {
        problems.push(`${label}: not a valid document record`);
      } else {
        hash = await recordHash(rec);
        if (entry.recordHash !== hash) problems.push(`${label}: recordHash does not match the record`);
        if (isHash(entry.prevLedgerHash) && (await chainHash(entry.prevLedgerHash, hash)) !== entry.ledgerHash) {
          problems.push(`${label}: ledgerHash does not match`);
        }
        const idEntry = idCheck.lookup(rec.signer);
        const idErr = await idCheck.check(rec.signer);
        if (idErr) problems.push(`${label}: ${idErr}`);
        else if (!(await verifyRecord(idEntry.record.publicKey, rec, entry.signature))) {
          problems.push(`${label}: signature does not verify`);
        }
        // Per document rules.
        const st = docState.get(rec.docId);
        if (rec.version === 1) {
          if (st) problems.push(`${label}: document ${shortId(rec.docId)} is created twice`);
        } else if (!st) {
          if (allowMidChain) midChain.add(rec.docId);
          else if (fromGenesis) problems.push(`${label}: document ${shortId(rec.docId)} has no create record before it`);
          else problems.push(`${label}: document ${shortId(rec.docId)} has no earlier record in the state that was passed in`);
        } else {
          if (st.revoked) problems.push(`${label}: record after a revoke`);
          if (rec.version !== st.version + 1) problems.push(`${label}: version ${rec.version} does not follow ${st.version}`);
          if (rec.prev !== st.recordHash) problems.push(`${label}: prev does not match the previous record`);
          if (rec.signer !== st.signer) problems.push(`${label}: signer differs from the document owner`);
          if (rec.createdAt < st.createdAt) problems.push(`${label}: createdAt goes backwards`);
        }
        docState.set(rec.docId, {
          version: rec.version,
          recordHash: hash,
          signer: rec.signer,
          createdAt: rec.createdAt,
          revoked: rec.type === 'doc.revoke'
        });
      }
      const good = problems.length === before;
      if (good && linked) {
        lastSeq = entry.seq;
        lastHash = entry.ledgerHash;
      } else {
        linked = false;
      }
      // Keep going from what the entry claims so one fault does not hide others.
      expectSeq = Number.isSafeInteger(entry.seq) ? entry.seq + 1 : expectSeq + 1;
      expectPrev = isHash(entry.ledgerHash) ? entry.ledgerHash : expectPrev;
    }
    if (midChain.size > 0) {
      warnings.push(`${midChain.size} documents started before this page, so their earlier versions were not checked here.`);
    }
    return { ok: problems.length === 0, lastSeq, lastHash, problems, warnings, docState };
  } catch (err) {
    problems.push('the page could not be checked: ' + msg(err));
    return { ok: false, lastSeq, lastHash, problems, warnings, docState };
  }
}

// ---------------------------------------------------------------------------
// Chat pages

// page = { channel, messages:[{ seq, hash, prevChainHash, chainHash, record, signature }], identities, checkpoint, server }
// options: pinnedServerKeyId, startPrev (chain hash before the first message, if the caller knows it).
export async function verifyMessages(page, options = {}) {
  const opts = options;
  const pin = readPin(readOption(opts, 'pinnedServerKeyId'));
  const pinned = pin.pinned;
  const startPrev = readOption(opts, 'startPrev');
  const expectedChannelId = readOption(opts, 'expectedChannelId');
  const allowUnanchored = readOption(opts, 'allowUnanchored') === true;
  const warnings = [];
  const results = [];
  const seenHashes = new Set();
  try {
    if (!isPlainObject(page) || !Array.isArray(page.messages)) {
      return { ok: false, results, chainOk: false, checkpointOk: false, anchored: false, warnings: ['the page has no message list'] };
    }
    const idCheck = identityChecker(page.identities);
    const pageChannelId = isPlainObject(page.channel) && typeof page.channel.channelId === 'string' ? page.channel.channelId : null;
    const expected = typeof expectedChannelId === 'string' ? expectedChannelId : null;
    // The channel the page must belong to. Only an explicit channel (from the page or the caller)
    // lets a checkpoint count, so a checkpoint of some other scope cannot be borrowed.
    const channelId = expected !== null ? expected : pageChannelId;
    let channelMismatch = expectedChannelId !== undefined && expected === null;
    if (expected !== null && pageChannelId !== null && expected !== pageChannelId) channelMismatch = true;
    if (channelMismatch) warnings.push('The page is for a different channel than the one that was asked for.');
    let chainOk = true;
    let prev = null; // previous message in this page
    let lastSeq = 0;
    let lastChain = ZERO_HASH;
    let seenChannel = channelId;

    for (let i = 0; i < page.messages.length; i++) {
      const m = page.messages[i];
      const problems = [];
      const seq = isPlainObject(m) && Number.isSafeInteger(m.seq) ? m.seq : -1;
      if (!isPlainObject(m)) {
        results.push({ seq, ok: false, detail: 'not an object' });
        chainOk = false;
        prev = null;
        continue;
      }
      const rec = m.record;
      const v = validateRecord(rec);
      let hash = null;
      if (!v.ok || rec.type !== 'message') {
        problems.push('not a valid message record');
      } else {
        hash = await recordHash(rec);
        if (m.hash !== hash) problems.push('message hash does not match the record');
        if (seenHashes.has(hash)) problems.push('the same signed message appears more than once');
        seenHashes.add(hash);
        if (seenChannel === null) seenChannel = rec.channelId;
        if (rec.channelId !== seenChannel) problems.push('message belongs to a different channel');
        const idEntry = idCheck.lookup(rec.signer);
        const idErr = await idCheck.check(rec.signer);
        if (idErr) problems.push(idErr);
        else if (!(await verifyRecord(idEntry.record.publicKey, rec, m.signature))) problems.push('signature does not verify');
      }
      results.push({
        seq,
        ok: problems.length === 0,
        detail: problems.length === 0 ? 'signature, signer key id and message hash verify' : problems.join('; ')
      });

      // Chain links.
      let linkOk = Number.isSafeInteger(m.seq) && m.seq >= 1 && isHash(m.prevChainHash) && isHash(m.chainHash);
      if (linkOk && hash !== null) {
        linkOk = (await chainHash(m.prevChainHash, hash)) === m.chainHash;
      } else {
        linkOk = false;
      }
      if (linkOk && prev) {
        if (m.seq !== prev.seq + 1 || m.prevChainHash !== prev.chainHash) linkOk = false;
      }
      if (linkOk && !prev) {
        if (m.seq === 1 && m.prevChainHash !== ZERO_HASH) linkOk = false;
        if (isHash(startPrev) && m.prevChainHash !== startPrev) linkOk = false;
      }
      if (!linkOk || problems.includes('the same signed message appears more than once')) {
        chainOk = false;
        results[results.length - 1].ok = false;
        if (!linkOk) results[results.length - 1].detail += (problems.length ? '; ' : '') + 'chain link is broken';
      }
      prev = Number.isSafeInteger(m.seq) && isHash(m.chainHash) ? { seq: m.seq, chainHash: m.chainHash } : null;
      if (Number.isSafeInteger(m.seq) && isHash(m.chainHash)) {
        lastSeq = m.seq;
        lastChain = m.chainHash;
      }
    }

    const first = page.messages[0];
    if (isPlainObject(first) && first.seq !== 1 && !isHash(startPrev)) {
      warnings.push('This page starts after the first message, so the link to earlier messages was not checked. Verify the earlier pages to check the whole chain.');
    }

    // Checkpoint. It only counts when the page is tied to it: the newest message in the page is
    // exactly the checkpoint's position and hash (an empty chain is seq 0 and the zero hash).
    // A checkpoint that is ahead of the page proves nothing about these messages.
    let checkpointOk = false;
    let anchored = false;
    const cp = page.checkpoint;
    const server = page.server;
    if (!isPlainObject(cp) || !isPlainObject(server)) {
      warnings.push('No server checkpoint was provided, so the position of the chain is not attested by the server.');
    } else if (pin.bad) {
      warnings.push('The pinned server key id is malformed, it must be 64 lowercase hex characters.');
    } else {
      try {
        const serverKeyId = await keyIdOf(server.publicKey);
        const sigOk = await verifyCheckpoint(server.publicKey, cp);
        if (!sigOk) {
          warnings.push('The checkpoint signature is not valid for the server key.');
        } else if (channelMismatch) {
          warnings.push('The checkpoint was not accepted because the channel does not match.');
        } else if (channelId === null) {
          warnings.push('The channel is not known (no channel info in the page and no expectedChannelId), so the checkpoint was not accepted.');
        } else if (cp.payload.scope !== 'channel:' + channelId) {
          warnings.push('The checkpoint is for a different channel.');
        } else if (pinned !== null && serverKeyId !== pinned) {
          warnings.push('The server key is not the pinned key.');
        } else if (cp.payload.seq < lastSeq) {
          warnings.push('The checkpoint is older than the newest message in this page.');
        } else if (cp.payload.seq === lastSeq) {
          if (cp.payload.hash !== lastChain) {
            warnings.push('The checkpoint hash does not match the newest message chain hash.');
          } else {
            anchored = true;
            checkpointOk = true;
          }
        } else if (allowUnanchored) {
          checkpointOk = true;
          warnings.push('The checkpoint is ahead of this page, so these messages are not tied to the server. Only their signatures and links were checked.');
        } else {
          warnings.push('The checkpoint is ahead of this page, so these messages are not tied to the server. Load the rest of the channel to check it.');
        }
        if (checkpointOk && pinned === null) {
          warnings.push('The server key was not pinned, so the checkpoint only proves the key the server presented.');
        }
      } catch {
        warnings.push('The server key is invalid.');
      }
    }
    if (pinned !== null && !checkpointOk && !warnings.some((w) => w.includes('pinned key'))) {
      warnings.push('The pinned server key could not be matched.');
    }
    const ok = results.every((r) => r.ok) && chainOk && checkpointOk;
    return { ok, results, chainOk, checkpointOk, anchored: ok && anchored, warnings };
  } catch (err) {
    return { ok: false, results, chainOk: false, checkpointOk: false, anchored: false, warnings: [...warnings, 'the page could not be checked: ' + msg(err)] };
  }
}
