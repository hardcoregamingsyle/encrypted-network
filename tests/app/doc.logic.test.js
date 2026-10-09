import { describe, expect, it } from 'vitest';
import {
  BUNDLE_KIND,
  LATEST_MEANING,
  LIMITS_SENTENCE,
  REVOKE_WORD,
  certificateData,
  checkpointTime,
  cleanDocId,
  describeLoadError,
  docIdProblem,
  exportBundle,
  exportBundleName,
  failedChecks,
  hasPassword,
  ownerAccess,
  passwordFileText,
  revokeProblem,
  revokeReason,
  safeFileName,
  statusOf,
  tidyPassword,
  timelineOf,
  unlockSteps,
  verdictSentence,
  versionProblem
} from '../../src/components/doc/docLogic.js';
import { verifyDocumentBundle } from '../../shared/verify.js';
import { buildBundleParts, clone, createIdentity, createServerKey } from '../helpers/bundle.js';

const PW = 'ABCD-EFGH-JKLM-NPQR-STUV';

async function makeVerified(options = {}) {
  const owner = options.owner || (await createIdentity('Registry Office'));
  const serverKey = await createServerKey();
  const parts = await buildBundleParts({ owner, serverKey, versions: options.versions || [{}, {}] });
  const verification = await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: serverKey.keyId, expectedDocId: parts.docId });
  return { ...parts, verification, owner, serverKey };
}

describe('document ids', () => {
  it('cleans and checks ids', () => {
    expect(cleanDocId('  ABCDEF0123456789ABCDEF0123456789 ')).toBe('abcdef0123456789abcdef0123456789');
    expect(cleanDocId(undefined)).toBe('');
    expect(docIdProblem('abcdef0123456789abcdef0123456789')).toBe('');
    expect(docIdProblem('abc')).not.toBe('');
    expect(docIdProblem('')).not.toBe('');
    expect(docIdProblem('g'.repeat(32))).not.toBe('');
    expect(docIdProblem('a'.repeat(33))).not.toBe('');
  });
});

describe('describeLoadError', () => {
  it('maps the api errors to plain text', () => {
    expect(describeLoadError({ status: 404, code: 'not_found', message: 'x' }).kind).toBe('notfound');
    expect(describeLoadError({ status: 404, code: 'not_found' }, 'download').kind).toBe('blob_missing');
    expect(describeLoadError({ status: 0, code: 'network', message: 'Could not reach the server.' }).kind).toBe('network');
    expect(describeLoadError({ status: 429, code: 'rate_limited' }).kind).toBe('rate');
    expect(describeLoadError({ status: 500, code: 'server_error', message: 'server error' }).kind).toBe('server');
    expect(describeLoadError(new Error('odd')).kind).toBe('other');
    expect(describeLoadError(null).kind).toBe('other');
    expect(describeLoadError(undefined).text.length).toBeGreaterThan(0);
  });

  it('never uses em dashes', () => {
    for (const e of [{ status: 404 }, { code: 'network' }, { status: 500 }, {}]) {
      const d = describeLoadError(e);
      expect(d.title + d.text).not.toContain('—');
    }
  });
});

describe('timeline', () => {
  it('lists versions newest first with names and hashes', async () => {
    const { bundle, owner } = await makeVerified({ versions: [{ label: 'first' }, { label: 'second' }, { revoke: true, reason: 'withdrawn by owner' }] });
    const items = timelineOf(bundle);
    expect(items.map((i) => i.version)).toEqual([3, 2, 1]);
    expect(items.map((i) => i.typeLabel)).toEqual(['Revoked', 'Updated', 'Created']);
    expect(items[0].isHead).toBe(true);
    expect(items[1].isHead).toBe(false);
    expect(items[0].reason).toBe('withdrawn by owner');
    expect(items[0].blobHash).toBe('');
    expect(items[1].blobHash).toMatch(/^[0-9a-f]{64}$/);
    expect(items[1].signerName).toBe('Registry Office');
    expect(items[1].signer).toBe(owner.keyId);
    expect(items[2].ledgerSeq).toBe(1);
    expect(items.every((i) => /^[0-9a-f]{64}$/.test(i.recordHash))).toBe(true);
  });

  it('survives malformed bundles', () => {
    expect(timelineOf(null)).toEqual([]);
    expect(timelineOf({})).toEqual([]);
    expect(timelineOf({ records: 'x' })).toEqual([]);
    expect(timelineOf({ records: [null, 5, { record: null }, { record: { type: 'weird' } }] })).toHaveLength(1);
    const odd = timelineOf({ records: [{ record: { type: 'weird', version: 'x', label: 4 } }] })[0];
    expect(odd.typeLabel).toBe('Unknown');
    expect(odd.version).toBe(0);
    expect(odd.label).toBe('');
    expect(odd.signerName).toBe('');
  });

  it('does not read names through the prototype', () => {
    const bundle = { records: [{ record: { type: 'doc.create', version: 1, signer: 'constructor' } }], identities: {} };
    expect(timelineOf(bundle)[0].signerName).toBe('');
  });
});

describe('status, reason and checkpoint time', () => {
  it('reports active and revoked with the confirmed wording', async () => {
    const active = await makeVerified();
    expect(statusOf(active.verification)).toEqual({ key: 'active', label: 'Active', tone: 'good' });
    const revoked = await makeVerified({ versions: [{}, { revoke: true, reason: 'wrong file' }] });
    expect(statusOf(revoked.verification).key).toBe('revoked');
    expect(statusOf(revoked.verification).tone).toBe('warn');
    expect(revokeReason(revoked.bundle)).toBe('wrong file');
    expect(revokeReason(active.bundle)).toBe('');
  });

  it('never shows a plain green status for a failed result', () => {
    expect(statusOf({ ok: false, status: 'active' })).toEqual({ key: 'active', label: 'Active, not confirmed', tone: 'warn' });
    expect(statusOf({ ok: false, status: 'revoked' }).tone).toBe('bad');
    expect(statusOf({ ok: false, status: 'invalid' }).tone).toBe('bad');
    expect(statusOf(null).label).toBe('Not verified');
    expect(statusOf(undefined).tone).toBe('bad');
  });

  it('finds the checkpoint time', async () => {
    const { bundle } = await makeVerified();
    expect(Number.isFinite(checkpointTime(bundle))).toBe(true);
    expect(checkpointTime(null)).toBeNull();
    expect(checkpointTime({})).toBeNull();
    expect(checkpointTime({ checkpoint: { payload: { signedAt: 5 } } })).toBe(5);
  });
});

describe('verdict sentence', () => {
  it('good result says what latest means and mentions pinning', async () => {
    const { verification, bundle } = await makeVerified();
    const pinned = verdictSentence(verification, { pinned: true, bundle });
    expect(pinned.tone).toBe('good');
    expect(pinned.text).toContain(LATEST_MEANING);
    expect(pinned.text).toContain('you pinned');
    const unpinned = verdictSentence(verification, { pinned: false, bundle });
    expect(unpinned.text).toContain('not pinned');
    expect(unpinned.text).toContain('version 2');
  });

  it('a failed result is bad and names the failed checks', async () => {
    const { bundle, serverKey, docId } = await makeVerified();
    const bad = clone(bundle);
    bad.records[0].record.label = 'changed';
    const verification = await verifyDocumentBundle(bad, { pinnedServerKeyId: serverKey.keyId, expectedDocId: docId });
    expect(verification.ok).toBe(false);
    expect(failedChecks(verification).length).toBeGreaterThan(0);
    const v = verdictSentence(verification, { pinned: true, bundle: bad });
    expect(v.tone).toBe('bad');
    expect(v.text).toContain('did not pass');
    expect(v.text).toContain('signatures');
  });

  it('a revoked result is a warning, not green', async () => {
    const { verification, bundle } = await makeVerified({ versions: [{}, { revoke: true }] });
    expect(verdictSentence(verification, { pinned: true, bundle }).tone).toBe('warn');
  });

  it('handles missing input and has no em dashes', async () => {
    expect(verdictSentence(null).tone).toBe('bad');
    expect(verdictSentence('x').tone).toBe('bad');
    const { verification, bundle } = await makeVerified();
    expect(verdictSentence(verification, { bundle }).text).not.toContain('—');
    expect(LATEST_MEANING + LIMITS_SENTENCE).not.toContain('—');
  });

  it('an unanchored passing result is a warning', () => {
    const v = verdictSentence({ ok: true, status: 'active', anchored: false, head: { version: 1 } }, {});
    expect(v.tone).toBe('warn');
    expect(v.text).toContain('not tied to the server head');
  });
});

describe('unlock checklist', () => {
  const ok = { ok: true, detail: 'fine' };
  it('shows todo rows before anything is checked', () => {
    const rows = unlockSteps(null);
    expect(rows.map((r) => r.state)).toEqual(['todo', 'todo', 'todo', 'todo']);
    expect(rows.map((r) => r.id)).toEqual(['blob', 'password', 'fingerprint', 'commitment']);
  });

  it('blob checked, no password yet', () => {
    const rows = unlockSteps({ blobCheck: ok, plaintextCheck: null, fingerprint: null });
    expect(rows.map((r) => r.state)).toEqual(['ok', 'todo', 'todo', 'todo']);
  });

  it('everything good', () => {
    const rows = unlockSteps({ blobCheck: ok, plaintextCheck: ok, fingerprint: 'ab'.repeat(32) });
    expect(rows.map((r) => r.state)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(rows[2].detail).toBe('ab'.repeat(32));
  });

  it('wrong password fails the password row and skips the rest', () => {
    const rows = unlockSteps({
      blobCheck: ok,
      plaintextCheck: { ok: false, detail: 'wrong password, or the file was changed' },
      fingerprint: null
    });
    expect(rows.map((r) => r.state)).toEqual(['ok', 'bad', 'skip', 'skip']);
    expect(rows[1].detail).toBe('wrong password, or the file was changed');
  });

  it('commitment mismatch fails only the last row', () => {
    const rows = unlockSteps({
      blobCheck: ok,
      plaintextCheck: { ok: false, detail: 'the commitment does not match' },
      fingerprint: 'cd'.repeat(32)
    });
    expect(rows.map((r) => r.state)).toEqual(['ok', 'ok', 'ok', 'bad']);
  });

  it('hash mismatch fails the first row and skips the password', () => {
    const rows = unlockSteps({
      blobCheck: { ok: false, detail: 'hash differs' },
      plaintextCheck: { ok: false, detail: 'not unlocked' },
      fingerprint: null
    });
    expect(rows.map((r) => r.state)).toEqual(['bad', 'skip', 'skip', 'skip']);
  });

  it('revoked documents skip the file rows', () => {
    const rows = unlockSteps({ blobCheck: null, plaintextCheck: null }, { revoked: true });
    expect(rows[0].state).toBe('skip');
  });
});

describe('ownerAccess', () => {
  it('grants tools to the owner of a verified active document', async () => {
    const { bundle, verification, owner, versions } = await makeVerified();
    const a = ownerAccess({ identity: { keyId: owner.keyId }, bundle, verification });
    expect(a.allowed).toBe(true);
    expect(a.head.version).toBe(2);
    expect(a.head.recordHash).toBe(versions[1].recordHash);
  });

  it('gives nothing to other people or when signed out', async () => {
    const { bundle, verification } = await makeVerified();
    const other = await createIdentity('Someone');
    expect(ownerAccess({ identity: { keyId: other.keyId }, bundle, verification })).toEqual({ isOwner: false, allowed: false, reason: '' });
    expect(ownerAccess({ identity: null, bundle, verification }).isOwner).toBe(false);
    expect(ownerAccess({ identity: { keyId: '' }, bundle, verification }).isOwner).toBe(false);
    expect(ownerAccess({}).allowed).toBe(false);
  });

  it('blocks the owner when verification failed or the document is revoked', async () => {
    const { bundle, owner, serverKey, docId } = await makeVerified();
    const bad = clone(bundle);
    bad.records[1].record.label = 'x';
    const failed = await verifyDocumentBundle(bad, { pinnedServerKeyId: serverKey.keyId, expectedDocId: docId });
    const a = ownerAccess({ identity: { keyId: owner.keyId }, bundle: bad, verification: failed });
    expect(a.isOwner).toBe(true);
    expect(a.allowed).toBe(false);
    expect(a.reason).toMatch(/did not pass/);

    const rev = await makeVerified({ owner, versions: [{}, { revoke: true }] });
    const b = ownerAccess({ identity: { keyId: owner.keyId }, bundle: rev.bundle, verification: rev.verification });
    expect(b.allowed).toBe(false);
    expect(b.reason).toMatch(/revoked/);
  });
});

describe('form checks', () => {
  const file = { name: 'a.pdf', size: 100 };

  it('versionProblem', () => {
    expect(versionProblem({ file: null, label: '', mode: 'reuse', reusePassword: PW })).toMatch(/Choose/);
    expect(versionProblem({ file: { name: 'a', size: 0 }, label: '', mode: 'reuse', reusePassword: PW })).toMatch(/empty/);
    expect(versionProblem({ file: { name: 'a', size: 52428801 }, label: '', mode: 'reuse', reusePassword: PW })).toMatch(/too large/);
    expect(versionProblem({ file: { name: ' ', size: 5 }, label: '', mode: 'reuse', reusePassword: PW })).toMatch(/no name/);
    expect(versionProblem({ file, label: 'x'.repeat(121), mode: 'reuse', reusePassword: PW })).toMatch(/too long/);
    expect(versionProblem({ file, label: '', mode: 'reuse', reusePassword: '' })).toMatch(/Unlock the file/);
    expect(versionProblem({ file, label: '', mode: 'fresh', freshSaved: false })).toMatch(/saved/);
    expect(versionProblem({ file, label: '', mode: 'fresh', freshSaved: true })).toBe('');
    expect(versionProblem({ file, label: 'x'.repeat(120), mode: 'reuse', reusePassword: PW })).toBe('');
  });

  it('revokeProblem needs a reason and the typed word', () => {
    expect(revokeProblem({ reason: '', typed: REVOKE_WORD })).toMatch(/reason/);
    expect(revokeProblem({ reason: '   ', typed: REVOKE_WORD })).toMatch(/reason/);
    expect(revokeProblem({ reason: 'x'.repeat(501), typed: REVOKE_WORD })).toMatch(/too long/);
    expect(revokeProblem({ reason: 'wrong file', typed: 'revoke' })).toMatch(/Type REVOKE/);
    expect(revokeProblem({ reason: 'wrong file', typed: '' })).toMatch(/Type REVOKE/);
    expect(revokeProblem({ reason: 'wrong file' })).toMatch(/Type REVOKE/);
    expect(revokeProblem({ reason: 'wrong file', typed: ' REVOKE ' })).toBe('');
    expect(revokeProblem({ reason: 'x'.repeat(500), typed: REVOKE_WORD })).toBe('');
  });

  it('counts characters, not UTF-16 units', () => {
    expect(revokeProblem({ reason: '\u{1F600}'.repeat(500), typed: REVOKE_WORD })).toBe('');
  });
});

describe('passwords', () => {
  it('groups a standard password and reads links', () => {
    expect(tidyPassword('abcdefghjklmnpqrstuv')).toBe(PW);
    expect(tidyPassword(' abcd efgh  jklm-npqr stuv\n')).toBe(PW);
    expect(tidyPassword('https://x.example/d/' + 'a'.repeat(32) + '#k=ABCDEFGHJKLMNPQRSTUV')).toBe(PW);
    expect(tidyPassword('#k=abcd-efgh-jklm-npqr-stuv&x=1')).toBe(PW);
  });

  it('leaves odd passwords normalised but not grouped, and tolerates bad input', () => {
    expect(tidyPassword('hello world')).toBe('HELLOWORLD');
    expect(tidyPassword('#k=')).toBe('');
    expect(tidyPassword(null)).toBe('');
    expect(tidyPassword(42)).toBe('');
    expect(tidyPassword('')).toBe('');
  });

  it('hasPassword', () => {
    expect(hasPassword('')).toBe(false);
    expect(hasPassword(' - - ')).toBe(false);
    expect(hasPassword(null)).toBe(false);
    expect(hasPassword('a')).toBe(true);
  });

  it('password text file names the document', () => {
    const t = passwordFileText('a'.repeat(32), PW);
    expect(t).toContain('a'.repeat(32));
    expect(t).toContain(PW);
    expect(t).not.toContain('—');
  });
});

describe('safeFileName', () => {
  it('removes path parts, control and bidi characters and dots at the edges', () => {
    expect(safeFileName('report.pdf')).toBe('report.pdf');
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('a\\b:c*d?.txt')).toBe('a_b_c_d_.txt');
    expect(safeFileName('x\u0000y‮z.exe')).toBe('xyz.exe');
    expect(safeFileName('  ..hidden  ')).toBe('hidden');
    expect(safeFileName('')).toBe('document');
    expect(safeFileName('...')).toBe('document');
    expect(safeFileName(null)).toBe('document');
    expect(safeFileName(undefined)).toBe('document');
    expect(Array.from(safeFileName('n'.repeat(500))).length).toBe(120);
  });
});

describe('export bundle', () => {
  it('wraps the bundle with the pinned key and a time', async () => {
    const { bundle, serverKey } = await makeVerified();
    const out = exportBundle(bundle, serverKey.keyId, 1700000000000);
    expect(out.kind).toBe(BUNDLE_KIND);
    expect(out.v).toBe(1);
    expect(out.savedAt).toBe(1700000000000);
    expect(out.savedAtText).toBe('2023-11-14T22:13:20.000Z');
    expect(out.pinnedServerKeyId).toBe(serverKey.keyId);
    expect(out.bundle).toBe(bundle);
    expect(exportBundle(bundle, '', 5).pinnedServerKeyId).toBeNull();
    expect(JSON.parse(JSON.stringify(out)).bundle.document.docId).toBe(bundle.document.docId);
  });

  it('can be re-verified after a round trip through JSON', async () => {
    const { bundle, serverKey, docId } = await makeVerified();
    const text = JSON.stringify(exportBundle(bundle, serverKey.keyId));
    const back = JSON.parse(text);
    const v = await verifyDocumentBundle(back.bundle, { pinnedServerKeyId: back.pinnedServerKeyId, expectedDocId: docId });
    expect(v.ok).toBe(true);
  });

  it('file names', () => {
    expect(exportBundleName('a'.repeat(32), 3)).toBe('hrdlock-aaaaaaaaaaaa-v3.json');
    expect(exportBundleName(undefined, undefined)).toBe('hrdlock-document-v0.json');
  });
});

describe('certificateData', () => {
  it('collects the facts for a good document', async () => {
    const { bundle, verification, serverKey, docId, owner } = await makeVerified();
    const c = certificateData({ bundle, verification, pinnedServerKeyId: serverKey.keyId, now: 1700000000000 });
    expect(c.docId).toBe(docId);
    expect(c.status).toBe('Active');
    expect(c.headVersion).toBe(2);
    expect(c.signerName).toBe('Registry Office');
    expect(c.signerKeyId).toBe(owner.keyId);
    expect(c.serverKeyId).toBe(serverKey.keyId);
    expect(c.pinned).toBe(true);
    expect(c.ok).toBe(true);
    expect(c.anchored).toBe(true);
    expect(c.resultText).toBe('Signatures, version chain and server checkpoint passed. Server key pinned and matched.');
    expect(c.ledgerCheckpoint.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.headCheckpoint.seq).toBe(2);
    expect(c.checkedAt).toBe(1700000000000);
    expect(c.limits).toContain('not been audited');
    expect(c.failed).toEqual([]);
  });

  it('a failed document says so and lists the failed checks', async () => {
    const { bundle, serverKey, docId } = await makeVerified();
    const bad = clone(bundle);
    bad.records[1].record.label = 'changed';
    const verification = await verifyDocumentBundle(bad, { pinnedServerKeyId: serverKey.keyId, expectedDocId: docId });
    const c = certificateData({ bundle: bad, verification, pinnedServerKeyId: serverKey.keyId });
    expect(c.ok).toBe(false);
    expect(c.resultText).toBe('DID NOT PASS verification');
    expect(c.failed.length).toBeGreaterThan(0);
  });

  it('a wrong pin is not reported as pinned', async () => {
    const { bundle, verification } = await makeVerified();
    const c = certificateData({ bundle, verification, pinnedServerKeyId: 'ab'.repeat(32) });
    expect(c.pinned).toBe(false);
    expect(c.pinnedServerKeyId).toBe('ab'.repeat(32));
  });

  it('survives empty input', () => {
    const c = certificateData({});
    expect(c.docId).toBe('');
    expect(c.ok).toBe(false);
    expect(c.headVersion).toBeNull();
    expect(certificateData({ bundle: null, verification: null }).status).toBe('Not verified');
  });
});
