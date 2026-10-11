// Review r2-trust: can the verdict (src/lib/trust.js, src/components/VerifySummary.jsx) say something
// false? Real bundles from tests/helpers/bundle.js, real verifyDocumentBundle, hostile variations.
//
// Tests under "HELD UP" pass today and guard behaviour that is right.
// Tests under "DEFECT" assert the correct behaviour and FAIL today: each one is the proof of a finding.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeCheckpointPayload, signCheckpoint } from '../../../shared/checkpoint.js';
import { verifyDocumentBundle } from '../../../shared/verify.js';
import VerifySummary from '../../../src/components/VerifySummary.jsx';
import { certificateData } from '../../../src/components/doc/docLogic.js';
import { serverKeyPinned, verdictFor } from '../../../src/lib/trust.js';
import { buildBundleParts, clone, createIdentity, docHeadCheckpoint, ledgerCheckpoint } from '../../helpers/bundle.js';

async function good({ names = 'Priya', versions, pin = true } = {}) {
  const owner = await createIdentity(names);
  const parts = await buildBundleParts({ owner, versions: versions || [{ label: 'Land record' }] });
  const verification = await verifyDocumentBundle(parts.bundle, {
    pinnedServerKeyId: pin ? parts.serverKey.keyId : '',
    expectedDocId: parts.docId
  });
  return { owner, parts, verification, result: { bundle: parts.bundle, verification, blobCheck: null, plaintextCheck: null, fingerprint: null } };
}

describe('HELD UP: verdictFor never turns a failure into green', () => {
  it('a clean pinned answer is green, and only then', async () => {
    const { result, verification } = await good();
    expect(verification.ok).toBe(true);
    expect(verification.anchored).toBe(true);
    expect(serverKeyPinned(verification)).toBe(true);
    for (const trust of ['pinned-match', 'remembered-match']) expect(verdictFor(result, trust).tone).toBe('good');
  });

  it('an answer checked without any pin is not green when the browser says it knows the key', async () => {
    const { result, verification } = await good({ pin: false });
    expect(verification.ok).toBe(true);
    expect(serverKeyPinned(verification)).toBe(false);
    for (const trust of ['pinned-match', 'remembered-match', '']) {
      const v = verdictFor(result, trust);
      expect(v.tone).toBe('warn');
      expect(v.details.kind).toBe('key-unchecked');
    }
  });

  it('a different server key is bad whatever the trust word says', async () => {
    const owner = await createIdentity('Priya');
    const parts = await buildBundleParts({ owner });
    const other = await createIdentity('x');
    const wrongPin = other.keyId; // any other 64 hex id
    const verification = await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: wrongPin, expectedDocId: parts.docId });
    const result = { bundle: parts.bundle, verification };
    for (const trust of ['', 'first-visit', 'pinned-match', 'remembered-match']) {
      const v = verdictFor(result, trust);
      expect(v.tone, trust).toBe('bad');
      expect(v.details.kind).toBe('key-changed');
    }
    for (const trust of ['pinned-mismatch', 'remembered-mismatch']) {
      const v = verdictFor({ bundle: parts.bundle, verification: await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: parts.serverKey.keyId, expectedDocId: parts.docId }) }, trust);
      expect(v.tone).toBe('bad');
    }
  });

  it('a swapped document id (the server answers with another document) is bad', async () => {
    const a = await good();
    const b = await good();
    const swapped = await verifyDocumentBundle(b.parts.bundle, { pinnedServerKeyId: b.parts.serverKey.keyId, expectedDocId: a.parts.docId });
    expect(swapped.ok).toBe(false);
    const v = verdictFor({ bundle: b.parts.bundle, verification: swapped }, 'remembered-match');
    expect(v.tone).toBe('bad');
    expect(v.headline).toBe('Do not trust this file.');
  });

  it('a stale (replayed) bundle is bad', async () => {
    const { parts } = await good();
    const old = await verifyDocumentBundle(parts.bundle, {
      pinnedServerKeyId: parts.serverKey.keyId,
      expectedDocId: parts.docId,
      now: Date.now() + 11 * 60 * 1000,
      maxCheckpointAgeMs: 10 * 60 * 1000
    });
    expect(old.ok).toBe(false);
    expect(verdictFor({ bundle: parts.bundle, verification: old }, 'pinned-match').tone).toBe('bad');
  });

  it('an answer that is not tied to the server newest record is a warning, never green', async () => {
    const owner = await createIdentity('Priya');
    const parts = await buildBundleParts({ owner });
    // the ledger moved on and the server does not attest this document's head
    const extra = await createIdentity('Other');
    await parts.ledger.append({ v: 2, type: 'identity', publicKey: extra.publicJwk, displayName: 'Other', createdAt: Date.now() }, extra.identitySignature);
    const bundle = clone(parts.bundle);
    bundle.checkpoint = await ledgerCheckpoint(parts.serverKey, parts.ledger);
    delete bundle.headCheckpoint;
    const verification = await verifyDocumentBundle(bundle, { pinnedServerKeyId: parts.serverKey.keyId, expectedDocId: parts.docId });
    expect(verification.ok).toBe(false);
    const v = verdictFor({ bundle, verification }, 'pinned-match');
    expect(v.tone).toBe('warn');
    expect(v.details.kind).toBe('unanchored');
  });

  it('a withdrawn document is a warning with the word Withdrawn, never green', async () => {
    const { result, verification } = await good({ versions: [{ label: 'a' }, { revoke: true, reason: 'wrong file' }] });
    expect(verification.status).toBe('revoked');
    const v = verdictFor(result, 'pinned-match');
    expect(v.tone).toBe('warn');
    expect(v.headline).toBe('Withdrawn');
  });

  it('a result that is missing, empty or not an object never gives a verdict above warn', () => {
    for (const bad of [undefined, null, 0, 'ok', [], {}, { verification: null }, { verification: [] }, { verification: { ok: true } }, { checks: 'x' }]) {
      for (const trust of ['', 'pinned-match', 'first-visit', 'remembered-match']) {
        expect(['warn', 'bad'], JSON.stringify(bad) + ' ' + trust).toContain(verdictFor(bad, trust).tone);
      }
    }
  });

  it('odd field types never produce green', async () => {
    const { verification } = await good();
    const variants = [];
    const make = (fn) => {
      const v = clone(verification);
      fn(v);
      variants.push(v);
    };
    make((v) => (v.ok = 'true'));
    make((v) => (v.ok = 1));
    make((v) => (v.ok = {}));
    make((v) => (v.anchored = 'yes'));
    make((v) => (v.anchored = 1));
    make((v) => delete v.anchored);
    make((v) => (v.checks = null));
    make((v) => (v.checks = {}));
    make((v) => (v.checks = 'all good'));
    make((v) => (v.checks = [null, 1, 'x']));
    make((v) => (v.checks = []));
    for (const id of v0ids(verification)) {
      make((v) => (v.checks = v.checks.filter((c) => c.id !== id)));
      make((v) => (v.checks.find((c) => c.id === id).ok = 'true'));
      make((v) => (v.checks.find((c) => c.id === id).ok = 1));
      make((v) => delete v.checks.find((c) => c.id === id).ok);
      make((v) => (v.checks.find((c) => c.id === id).ok = false));
    }
    for (const v of variants) {
      for (const trust of ['pinned-match', 'remembered-match', 'first-visit', '']) {
        expect(verdictFor({ verification: v }, trust).tone, JSON.stringify(v).slice(0, 80)).not.toBe('good');
      }
    }
  });

  it('file checks: a mismatching or unopened file is never green', async () => {
    const { verification, parts } = await good();
    const base = { bundle: parts.bundle, verification };
    const cases = [
      { blobCheck: { ok: false } },
      { blobCheck: { ok: 'true' } },
      { blobCheck: { ok: true }, plaintextCheck: { ok: false }, fingerprint: 'ab'.repeat(32) },
      { blobCheck: { ok: true }, plaintextCheck: { ok: false }, fingerprint: null },
      { blobCheck: null, plaintextCheck: { ok: true } },
      { blobCheck: { ok: true }, plaintextCheck: { ok: 'true' }, fingerprint: 'ab'.repeat(32) }
    ];
    for (const extra of cases) {
      expect(verdictFor({ ...base, ...extra }, 'pinned-match').tone, JSON.stringify(extra)).not.toBe('good');
    }
  });

  it('hostile text in a name or label is stripped of control and direction characters and is escaped when drawn', async () => {
    const name = 'Reg<img src=x onerror=alert(1)>‮istry\u0007';
    const { result } = await good({ names: 'Plain' });
    const hostile = clone(result);
    hostile.verification.head.signerName = name;
    hostile.verification.head.label = '<script>alert(1)</script>⁦x';
    const v = verdictFor(hostile, 'pinned-match');
    expect(v.details.signerName).not.toMatch(/[‮\u0007]/);
    expect(v.details.label).not.toMatch(/⁦/);
    const html = renderToString(h(VerifySummary, { result: hostile, trust: 'pinned-match' }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
  });

  it('the pin wording that trust.js reads matches what shared/verify.js writes', async () => {
    const pinned = await good();
    expect(serverKeyPinned(pinned.verification)).toBe(true);
    const unpinned = await good({ pin: false });
    expect(unpinned.verification.warnings.some((w) => /server key was not pinned/i.test(w))).toBe(true);
    expect(serverKeyPinned(unpinned.verification)).toBe(false);
  });
});

describe('DEFECT: green is shown when it should not be', () => {
  it('first visit must not look as strong as a key pinned out of band', async () => {
    const { result } = await good();
    const first = verdictFor(result, 'first-visit');
    const pinned = verdictFor(result, 'pinned-match');
    // Today both are tone good with the same headline "Verified" and the same sentence "...nobody has
    // changed it". Only a small muted line differs. The first visit answer proves the server agrees
    // with itself, nothing more.
    expect(first.tone === pinned.tone && first.headline === pinned.headline && first.line === pinned.line).toBe(false);
  });

  it('a remembered key from an earlier visit is also not the same strength as an out of band pin', async () => {
    const { result } = await good();
    const remembered = verdictFor(result, 'remembered-match');
    const pinned = verdictFor(result, 'pinned-match');
    expect(remembered.line === pinned.line && remembered.headline === pinned.headline && remembered.tone === pinned.tone).toBe(false);
  });

  it('an answer that is OLDER than one this browser saw (rollback) is never green', async () => {
    const { result, verification } = await good();
    // openDocument() marks this in noteSeenHead (src/lib/publish.js line 335 to 338)
    const rolledBack = clone(result);
    rolledBack.verification.rollback = true;
    rolledBack.verification.warnings.unshift('This answer is older than one this browser saw earlier.');
    expect(verification.ok).toBe(true);
    for (const trust of ['pinned-match', 'remembered-match', 'first-visit']) {
      expect(verdictFor(rolledBack, trust).tone, trust).not.toBe('good');
    }
  });

  it('the printed certificate of a rolled back answer does not read as a clean pass', async () => {
    const { result, parts } = await good();
    const rolledBack = clone(result);
    rolledBack.verification.rollback = true;
    rolledBack.verification.warnings.unshift('This answer is older than one this browser saw earlier.');
    const cert = certificateData({ bundle: parts.bundle, verification: rolledBack.verification, pinnedServerKeyId: parts.serverKey.keyId });
    // src/components/doc/Certificate.jsx prints resultText and "What this means"; neither mentions the rollback
    expect(cert.resultText).toMatch(/older|rolled back|rollback|saw earlier|not the latest/i);
  });

  it('a success flag with an unknown status or without a head is not Verified', async () => {
    const { result } = await good();
    const noStatus = clone(result);
    noStatus.verification.status = 'invalid';
    expect(verdictFor(noStatus, 'pinned-match').tone).not.toBe('good');
    const noHead = clone(result);
    noHead.verification.head = null;
    expect(verdictFor(noHead, 'pinned-match').tone).not.toBe('good');
  });

  it('first visit with a result that was NOT checked against the key being remembered is not green', async () => {
    const { result, verification } = await good({ pin: false });
    expect(serverKeyPinned(verification)).toBe(false);
    // trust says first-visit, the result carries the warning "server key was not pinned"
    expect(verdictFor(result, 'first-visit').tone).not.toBe('good');
  });

  it('the green card shows "signed by <name>" without saying that the name is the signer\'s own choice', async () => {
    const { result } = await good({ names: 'Official Land Registry Office' });
    const html = renderToString(h(VerifySummary, { result, trust: 'pinned-match' }));
    expect(html).toContain('Official Land Registry Office');
    // About says: "Nobody has checked who the person behind a name really is." The card has no such line.
    expect(html).toMatch(/name (is|was) (chosen|picked|typed|set) by|name is not checked|not checked who|not been checked/i);
  });

  it('the green sentence claims "the latest version" although the About page says the server can hide a newer one', async () => {
    const { result } = await good();
    const v = verdictFor(result, 'pinned-match');
    expect(v.tone).toBe('good');
    // an unqualified "This is the latest version" contradicts the About limits
    expect(/this is the latest version/i.test(v.line) && !/server/i.test(v.line)).toBe(false);
  });
});

function v0ids(verification) {
  return verification.checks.map((c) => c.id);
}

describe('helper sanity', () => {
  it('docHeadCheckpoint and makeCheckpointPayload are importable (used by the rollback test file)', () => {
    expect(typeof docHeadCheckpoint).toBe('function');
    expect(typeof makeCheckpointPayload).toBe('function');
    expect(typeof signCheckpoint).toBe('function');
  });
});
