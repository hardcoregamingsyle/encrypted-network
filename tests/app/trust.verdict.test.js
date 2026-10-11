// The plain language verdict: every branch, with real verification results and with hostile or partial ones.
import { describe, expect, it } from 'vitest';
import { verifyDocumentBundle } from '../../shared/verify.js';
import { CORE_CHECKS, fileState, plainFailure, verdictFor } from '../../src/lib/trust.js';
import { buildBundleParts, clone, createIdentity, createServerKey, ledgerCheckpoint } from '../helpers/bundle.js';

async function fixture({ versions = [{ label: 'Annual report' }], pin = true, mutateBundle, verifyOpts = {} } = {}) {
  const owner = await createIdentity('Priya');
  const serverKey = await createServerKey();
  const parts = await buildBundleParts({ owner, serverKey, versions });
  if (mutateBundle) await mutateBundle(parts);
  const verification = await verifyDocumentBundle(parts.bundle, {
    expectedDocId: parts.docId,
    pinnedServerKeyId: pin ? serverKey.keyId : '',
    ...verifyOpts
  });
  return { parts, serverKey, owner, verification, result: { bundle: parts.bundle, verification, blobCheck: null, plaintextCheck: null, fingerprint: null } };
}

async function unanchored(verifyOpts = {}) {
  return fixture({
    verifyOpts,
    async mutateBundle(parts) {
      // the ledger moved on after this document, and the server did not attest the document head
      await parts.ledger.append({ type: 'doc.update', filler: 1 }, 'sig');
      parts.bundle.checkpoint = await ledgerCheckpoint(parts.serverKey, parts.ledger);
      delete parts.bundle.headCheckpoint;
    }
  });
}

const good = { ok: true, status: 'active', anchored: true };

function synthetic(overrides = {}, failId = null) {
  const checks = CORE_CHECKS.map((id) => ({ id, ok: id !== failId, detail: id === 'checkpoint' ? 'checkpoint signature is valid for the pinned server key' : 'fine' }));
  return {
    verification: {
      ...good,
      head: { version: 2, label: 'Doc', signer: 'ab'.repeat(32), signerName: 'Priya' },
      checks,
      warnings: [],
      ...overrides
    },
    blobCheck: null,
    plaintextCheck: null,
    fingerprint: null
  };
}

describe('green: only when everything passed', () => {
  it('verified, anchored, pinned match', async () => {
    const f = await fixture();
    expect(f.verification.ok).toBe(true);
    const v = verdictFor(f.result, 'pinned-match');
    expect(v.tone).toBe('good');
    expect(v.headline).toBe('Verified');
    expect(v.line).toBe('Not changed since it was signed. The server you chose to trust says this is the newest version.');
    expect(v.details.kind).toBe('verified');
    expect(v.details.checked).toMatch(/who signed each version/);
    expect(v.details.version).toBe(1);
    expect(v.details.signerName).toBe('Priya');
    expect(v.details.label).toBe('Annual report');
    expect(v.details.trustLine).toMatch(/chose to trust/);
  });

  it('remembered match', async () => {
    const f = await fixture();
    const v = verdictFor(f.result, 'remembered-match');
    expect(v.tone).toBe('good');
    expect(v.details.trustLine).toMatch(/remembered/);
  });

  it('first visit is green with a small line saying the key is now remembered, and a weaker headline than a known key', async () => {
    const f = await fixture();
    const v = verdictFor(f.result, 'first-visit');
    expect(v.tone).toBe('good');
    expect(v.headline).toBe('Checked, first visit');
    expect(v.details.strength).toBe('first');
    expect(v.details.trustLine).toMatch(/First visit/);
    expect(v.details.trustLine).toMatch(/remembered/);
  });

  it('first visit is not green when the verifier did not check the proof against the key being remembered', async () => {
    // The first visit key is remembered AND used as the pin (see effectivePinnedKey), so a result without
    // a pin means the proof was never compared with it. That is the same as an unchecked key.
    const f = await fixture({ pin: false });
    expect(f.verification.ok).toBe(true);
    const v = verdictFor(f.result, 'first-visit');
    expect(v.tone).toBe('warn');
    expect(v.details.kind).toBe('key-unchecked');
  });

  it('no trust state, but the verifier compared the key with a pin: green', async () => {
    const f = await fixture();
    for (const t of [undefined, null, '', 'nonsense', 5, {}]) {
      expect(verdictFor(f.result, t).tone).toBe('good');
    }
  });

  it('a bare verification object works as well as a whole open result', async () => {
    const f = await fixture();
    expect(verdictFor(f.verification, 'pinned-match').tone).toBe('good');
  });

  it('a many version document is green and names the newest version', async () => {
    const f = await fixture({ versions: [{}, {}, {}] });
    const v = verdictFor(f.result, 'pinned-match');
    expect(v.tone).toBe('good');
    expect(v.details.version).toBe(3);
  });

  it('mentions the file only when the file matched', async () => {
    const f = await fixture();
    const withFile = { ...f.result, blobCheck: { ok: true }, plaintextCheck: { ok: true }, fingerprint: 'ab'.repeat(32) };
    expect(verdictFor(withFile, 'pinned-match').details.checked).toMatch(/file itself/);
    expect(verdictFor(f.result, 'pinned-match').details.checked).not.toMatch(/file itself/);
    const lockedOnly = { ...f.result, blobCheck: { ok: true } };
    const v = verdictFor(lockedOnly, 'pinned-match');
    expect(v.tone).toBe('good');
    expect(v.details.file).toBe('locked-only');
  });
});

describe('green is never given without a known server key', () => {
  it('pinned-match claimed but the verifier did not use a pin: amber', async () => {
    const f = await fixture({ pin: false });
    for (const t of ['pinned-match', 'remembered-match']) {
      const v = verdictFor(f.result, t);
      expect(v.tone).toBe('warn');
      expect(v.details.kind).toBe('key-unchecked');
    }
  });

  it('no trust state and an unpinned verification: amber', async () => {
    const f = await fixture({ pin: false });
    const v = verdictFor(f.result, undefined);
    expect(v.tone).toBe('warn');
    expect(v.details.kind).toBe('key-unchecked');
    expect(v.headline).toMatch(/key was not checked/);
  });
});

describe('red: the server key changed', () => {
  it('pinned mismatch', async () => {
    const f = await fixture();
    const v = verdictFor(f.result, 'pinned-mismatch');
    expect(v.tone).toBe('bad');
    expect(v.headline).toBe("The server's identity changed since your last visit.");
    expect(v.line).toMatch(/chose to trust/);
    expect(v.details.kind).toBe('key-changed');
  });

  it('remembered mismatch', async () => {
    const f = await fixture();
    const v = verdictFor(f.result, 'remembered-mismatch');
    expect(v.tone).toBe('bad');
    expect(v.line).toMatch(/remembered/);
  });

  it('a mismatch beats a withdrawn document and an unanchored answer', async () => {
    const w = await fixture({ versions: [{}, { revoke: true }] });
    expect(verdictFor(w.result, 'pinned-mismatch').tone).toBe('bad');
    const u = await unanchored();
    expect(verdictFor(u.result, 'remembered-mismatch').tone).toBe('bad');
  });

  it('the verifier saying the key is not the pinned one is red even without a trust state', async () => {
    const f = await fixture();
    const other = await createServerKey();
    const wrong = await verifyDocumentBundle(f.parts.bundle, { expectedDocId: f.parts.docId, pinnedServerKeyId: other.keyId });
    expect(wrong.ok).toBe(false);
    for (const t of [undefined, '', 'first-visit', 'pinned-match', 'remembered-match']) {
      const v = verdictFor({ verification: wrong }, t);
      expect(v.tone).toBe('bad');
      expect(v.details.kind).toBe('key-changed');
      expect(v.headline).toBe("The server's identity changed since your last visit.");
    }
  });
});

describe('red: a check failed', () => {
  it('a broken signature names the first failed check in plain words', async () => {
    const f = await fixture({
      versions: [{}, { signWith: await createIdentity('Mallory') }]
    });
    expect(f.verification.ok).toBe(false);
    const v = verdictFor(f.result, 'pinned-match');
    expect(v.tone).toBe('bad');
    expect(v.headline).toBe('Do not trust this file.');
    expect(v.line).toBe('A version was not signed correctly.');
    expect(v.details.failedCheck.id).toBe('record_signatures');
    expect(v.details.kind).toBe('failed');
  });

  it('a tampered record', async () => {
    const f = await fixture({
      versions: [{}, {}],
      async mutateBundle(parts) {
        parts.bundle.records[1].record.label = 'changed afterwards';
      }
    });
    expect(f.verification.ok).toBe(false);
    const v = verdictFor(f.result, 'first-visit');
    expect(v.tone).toBe('bad');
    expect(v.headline).toBe('Do not trust this file.');
  });

  it('a bundle for another document id', async () => {
    const f = await fixture();
    const wrongId = await verifyDocumentBundle(f.parts.bundle, { expectedDocId: 'ab'.repeat(16), pinnedServerKeyId: f.serverKey.keyId });
    expect(verdictFor({ verification: wrongId }, 'pinned-match').tone).toBe('bad');
  });

  it('a failure text never repeats the server supplied detail', () => {
    const r = synthetic({ ok: false, status: 'invalid', anchored: false }, 'chain_links');
    r.verification.checks.find((c) => c.id === 'chain_links').detail = '<img src=x onerror=alert(1)> trust me';
    const v = verdictFor(r, 'pinned-match');
    expect(v.tone).toBe('bad');
    expect(JSON.stringify(v)).not.toMatch(/onerror|trust me/);
    expect(v.line).toBe(plainFailure('chain_links'));
  });

  it('every known check has its own plain sentence and an unknown id gets a general one', () => {
    const seen = new Set();
    for (const id of CORE_CHECKS) {
      const s = plainFailure(id);
      expect(s).toMatch(/\.$/);
      seen.add(s);
    }
    expect(seen.size).toBe(CORE_CHECKS.length);
    for (const id of ['nope', '', null, undefined, 5, {}, '__proto__', 'constructor', 'toString']) {
      expect(plainFailure(id)).toBe('One of the checks did not pass.');
    }
  });

  it('ok false with no failed check listed still says do not trust', () => {
    const r = synthetic({ ok: false, status: 'invalid', anchored: false });
    const v = verdictFor(r, 'pinned-match');
    expect(v.tone).toBe('bad');
    expect(v.line).toBe('The checks did not all pass.');
  });

  it('ok true but a check failed is not believed', () => {
    const r = synthetic({}, 'single_owner');
    expect(r.verification.ok).toBe(true);
    const v = verdictFor(r, 'pinned-match');
    expect(v.tone).toBe('bad');
    expect(v.line).toBe(plainFailure('single_owner'));
  });

  it('the first failed check is the one named', () => {
    const r = synthetic({ ok: false, status: 'invalid', anchored: false });
    r.verification.checks[2].ok = false;
    r.verification.checks[5].ok = false;
    const v = verdictFor(r, 'pinned-match');
    expect(v.details.failedCheck.id).toBe('chain_links');
  });

  it('a file that does not match the signed hash is red even when the record is fine', async () => {
    const f = await fixture();
    const r = { ...f.result, blobCheck: { ok: false, detail: 'x' } };
    const v = verdictFor(r, 'pinned-match');
    expect(v.tone).toBe('bad');
    expect(v.line).toBe('The file does not match what the owner signed.');
    expect(v.details.kind).toBe('file-mismatch');
  });

  it('an unlocked file that is not the signed one is red', async () => {
    const f = await fixture();
    const r = { ...f.result, blobCheck: { ok: true }, plaintextCheck: { ok: false, detail: 'x' }, fingerprint: 'cd'.repeat(32) };
    expect(verdictFor(r, 'pinned-match').tone).toBe('bad');
  });
});

describe('amber: partly checked', () => {
  it('signatures fine but not tied to the newest record (allowed unanchored)', async () => {
    const f = await unanchored({ allowUnanchored: true });
    expect(f.verification.ok).toBe(true);
    expect(f.verification.anchored).toBe(false);
    const v = verdictFor(f.result, 'pinned-match');
    expect(v.tone).toBe('warn');
    expect(v.details.kind).toBe('unanchored');
    expect(v.line).toBe("The signing checks out but this answer is not tied to the server's newest record, so a newer version may exist.");
  });

  it('the same case when the verifier refuses unanchored answers is still amber, not red', async () => {
    const f = await unanchored();
    expect(f.verification.ok).toBe(false);
    expect(f.verification.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['checkpoint']);
    const v = verdictFor(f.result, 'pinned-match');
    expect(v.tone).toBe('warn');
    expect(v.details.kind).toBe('unanchored');
  });

  it('unanchored is amber for every trust state that is not a mismatch', async () => {
    const f = await unanchored({ allowUnanchored: true });
    for (const t of [undefined, '', 'first-visit', 'pinned-match', 'remembered-match', 'garbage']) {
      expect(verdictFor(f.result, t).tone).toBe('warn');
    }
  });

  it('a failed checkpoint for any other reason is red', () => {
    const r = synthetic({ ok: false, status: 'invalid', anchored: false }, 'checkpoint');
    r.verification.checks.find((c) => c.id === 'checkpoint').detail = 'the checkpoint signature is not valid for the server key';
    expect(verdictFor(r, 'first-visit').tone).toBe('bad');
  });

  it('not tied to the server plus another failed check is red', () => {
    const r = synthetic({ ok: false, status: 'invalid', anchored: false }, 'checkpoint');
    r.verification.checks.find((c) => c.id === 'checkpoint').detail = 'the records are not tied to the server: x';
    r.verification.checks[1].ok = false;
    expect(verdictFor(r, 'first-visit').tone).toBe('bad');
  });

  it('the unanchored wording for a stale checkpoint check cannot be forged by a failed other check id', () => {
    const r = synthetic({ ok: false, status: 'invalid', anchored: false }, 'chain_links');
    r.verification.checks.find((c) => c.id === 'chain_links').detail = 'not tied to the server';
    expect(verdictFor(r, 'first-visit').tone).toBe('bad');
  });

  it('withdrawn: amber with the plain sentence', async () => {
    const f = await fixture({ versions: [{}, { revoke: true }] });
    expect(f.verification.ok).toBe(true);
    expect(f.verification.status).toBe('revoked');
    const v = verdictFor(f.result, 'pinned-match');
    expect(v.tone).toBe('warn');
    expect(v.headline).toBe('Withdrawn');
    expect(v.line).toMatch(/^The owner withdrew this file./);
    expect(v.details.kind).toBe('withdrawn');
    expect(v.details.status).toBe('revoked');
  });

  it('withdrawn is never green for any trust state', async () => {
    const f = await fixture({ versions: [{}, { revoke: true }] });
    for (const t of [undefined, '', 'first-visit', 'pinned-match', 'remembered-match', 'pinned-mismatch', 'remembered-mismatch']) {
      expect(verdictFor(f.result, t).tone).not.toBe('good');
    }
  });

  it('a withdrawn answer that is also not anchored says so', () => {
    const r = synthetic({ status: 'revoked', anchored: false });
    const v = verdictFor(r, 'pinned-match');
    expect(v.tone).toBe('warn');
    expect(v.line).toMatch(/not tied/);
  });

  it('missing checks: only some checks ran', () => {
    const r = synthetic();
    r.verification.checks = r.verification.checks.slice(0, 3);
    const v = verdictFor(r, 'pinned-match');
    expect(v.tone).toBe('warn');
    expect(v.details.kind).toBe('partial');
  });

  it('ok true with no checks at all is not green', () => {
    for (const checks of [[], undefined, null, 'x', {}]) {
      const v = verdictFor({ verification: { ok: true, status: 'active', anchored: true, checks } }, 'pinned-match');
      expect(v.tone).not.toBe('good');
    }
  });

  it('the password did not open the file: amber', async () => {
    const f = await fixture();
    const r = { ...f.result, blobCheck: { ok: true }, plaintextCheck: { ok: false, detail: 'wrong password' }, fingerprint: null };
    const v = verdictFor(r, 'pinned-match');
    expect(v.tone).toBe('warn');
    expect(v.details.kind).toBe('file-not-opened');
  });

  it('no result at all is amber and never green', () => {
    for (const r of [null, undefined, 5, 'x', [], {}, { verification: null }, { verification: 'ok' }, { verification: [] }]) {
      const v = verdictFor(r, 'pinned-match');
      expect(v.tone).toBe('warn');
      expect(v.details.kind).toBe('no-answer');
    }
  });
});

describe('hostile results', () => {
  it('truthy but not true flags are not a pass', () => {
    for (const flag of ['true', 1, 'yes', {}, [], 'ok']) {
      const r = synthetic({ ok: flag });
      expect(verdictFor(r, 'pinned-match').tone).toBe('bad');
    }
  });

  it('a truthy but not true anchored flag is not anchored', () => {
    for (const flag of ['true', 1, {}, undefined, null]) {
      const r = synthetic({ anchored: flag });
      expect(verdictFor(r, 'pinned-match').tone).toBe('warn');
    }
  });

  it('check ok flags that are not true count as failed', () => {
    for (const flag of ['true', 1, null, undefined, {}]) {
      const r = synthetic();
      r.verification.checks[3].ok = flag;
      expect(verdictFor(r, 'pinned-match').tone).toBe('bad');
    }
  });

  it('garbage inside checks and head cannot make it throw or turn green', () => {
    const r = synthetic();
    r.verification.checks = [...r.verification.checks, null, 5, 'x', [], { id: 7 }];
    const v = verdictFor(r, 'pinned-match');
    expect(v.tone).toBe('bad');
    r.verification.head = 'head';
    expect(() => verdictFor(r, 'pinned-match')).not.toThrow();
    r.verification.head = { version: '2', label: { x: 1 }, signer: 5, signerName: ['a'] };
    const w = verdictFor(synthetic({ head: r.verification.head }), 'pinned-match');
    // a head without a usable version is not a verified file, whatever the flag says
    expect(w.tone).toBe('warn');
    expect(w.details.kind).toBe('partial');
    expect(w.details.version).toBeNull();
    expect(w.details.label).toBe('');
    expect(w.details.signerName).toBe('');
    expect(w.details.signerKeyId).toBe('');
  });

  it('names are turned into short single line text', () => {
    const r = synthetic({ head: { version: 1, label: 'a\nb‮c', signer: 'ab'.repeat(32), signerName: 'N'.repeat(500) + '\u0000' } });
    const v = verdictFor(r, 'pinned-match');
    expect(v.details.signerName.length).toBeLessThanOrEqual(60);
    expect(v.details.label).toBe('a b c');
    expect(v.details.signerName).not.toMatch(/[\u0000-\u001f]/);
  });

  it('a server that states it is pinned inside warnings or detail text does not change the verdict', () => {
    const r = synthetic();
    r.verification.checks.find((c) => c.id === 'checkpoint').detail = 'checkpoint signature is valid for the key the server presented (not pinned)';
    r.verification.warnings = ['The server key was not pinned, so ...'];
    expect(verdictFor(r, 'pinned-match').tone).toBe('warn');
    expect(verdictFor(r, 'first-visit').tone).toBe('warn');
  });

  it('a whole matrix of results and trust states never throws and is green only for the clean case', async () => {
    const clean = await fixture();
    const results = [
      clean.result,
      (await unanchored({ allowUnanchored: true })).result,
      (await fixture({ versions: [{}, { revoke: true }] })).result,
      (await fixture({ pin: false })).result,
      { ...clean.result, blobCheck: { ok: false } },
      { ...clean.result, blobCheck: { ok: true }, plaintextCheck: { ok: false }, fingerprint: null },
      { verification: { ...clean.verification, ok: false } },
      { verification: { ...clean.verification, anchored: false } },
      { verification: { ...clean.verification, status: 'revoked' } },
      { verification: { ...clean.verification, checks: clean.verification.checks.slice(1) } },
      null,
      {},
      'x'
    ];
    const trusts = [undefined, '', 'first-visit', 'pinned-match', 'pinned-mismatch', 'remembered-match', 'remembered-mismatch', 'junk'];
    let greens = 0;
    for (const r of results) {
      for (const t of trusts) {
        const v = verdictFor(r, t);
        expect(['good', 'warn', 'bad']).toContain(v.tone);
        expect(typeof v.headline).toBe('string');
        expect(typeof v.line).toBe('string');
        expect(v.details && typeof v.details === 'object').toBe(true);
        if (v.tone === 'good') {
          greens += 1;
          expect(r.verification.ok).toBe(true);
          expect(r.verification.anchored).toBe(true);
          expect(r.verification.status).toBe('active');
          expect(['first-visit', 'pinned-match', 'remembered-match', undefined, '', 'junk']).toContain(t);
        }
      }
    }
    expect(greens).toBeGreaterThan(0);
  });

  it('a clone of the result is judged the same (the function does not change its input)', async () => {
    const f = await fixture();
    const before = JSON.stringify(f.result);
    verdictFor(f.result, 'pinned-match');
    expect(JSON.stringify(f.result)).toBe(before);
    expect(JSON.stringify(verdictFor(clone(f.result), 'pinned-match'))).toBe(JSON.stringify(verdictFor(f.result, 'pinned-match')));
  });
});

describe('fileState', () => {
  it('reads the file checks of an open result', () => {
    expect(fileState(null)).toBe('none');
    expect(fileState({})).toBe('none');
    expect(fileState({ blobCheck: { ok: true } })).toBe('locked-only');
    expect(fileState({ blobCheck: { ok: false } })).toBe('bad');
    expect(fileState({ blobCheck: { ok: true }, plaintextCheck: { ok: true } })).toBe('matches');
    expect(fileState({ plaintextCheck: { ok: true } })).toBe('bad');
    expect(fileState({ blobCheck: { ok: true }, plaintextCheck: { ok: false }, fingerprint: null })).toBe('not-opened');
    expect(fileState({ blobCheck: { ok: true }, plaintextCheck: { ok: false }, fingerprint: 'ab' })).toBe('bad');
    expect(fileState({ blobCheck: { ok: 'true' } })).toBe('bad');
  });
});
