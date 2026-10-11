// The plain language summary and the new Verify screen parts, rendered to HTML.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyDocumentBundle } from '../../shared/verify.js';
import VerifySummary from '../../src/components/VerifySummary.jsx';
import QuickCheck from '../../src/components/verify/QuickCheck.jsx';
import RememberedSection from '../../src/components/verify/RememberedSection.jsx';
import { fileLines, quickCheck } from '../../src/components/verify/quickLogic.js';
import { buildBundleParts, createIdentity, createServerKey, ledgerCheckpoint } from '../helpers/bundle.js';

const render = (node) => renderToString(h(MemoryRouter, { initialEntries: ['/verify'] }, node));

afterEach(() => {
  vi.unstubAllGlobals();
});

async function open({ versions = [{ label: 'Annual report' }], pin = true, unanchored = false, other = false } = {}) {
  const owner = await createIdentity('Priya');
  const serverKey = await createServerKey();
  const parts = await buildBundleParts({ owner, serverKey, versions });
  if (unanchored) {
    await parts.ledger.append({ type: 'doc.update', filler: 1 }, 'sig');
    parts.bundle.checkpoint = await ledgerCheckpoint(serverKey, parts.ledger);
    delete parts.bundle.headCheckpoint;
  }
  const pinId = other ? (await createServerKey()).keyId : serverKey.keyId;
  const verification = await verifyDocumentBundle(parts.bundle, {
    expectedDocId: parts.docId,
    pinnedServerKeyId: pin ? pinId : '',
    allowUnanchored: unanchored
  });
  return { bundle: parts.bundle, verification, blobCheck: null, plaintextCheck: null, fingerprint: null };
}

describe('VerifySummary', () => {
  it('green: Verified with the plain sentence, who signed, and a collapsed Details', async () => {
    const result = await open();
    const html = render(h(VerifySummary, { result, trust: 'pinned-match' }));
    expect(html).toContain('vsum--good');
    expect(html).toContain('Verified');
    expect(html).toContain('The server you chose to trust says this is the newest version.');
    expect(html).toContain('Version 1, signed by Priya');
    expect(html).toContain('Annual report');
    expect(html).toContain('<details class="vsum__details"><summary>Details</summary>');
    expect(html).not.toContain('<details class="vsum__details" open');
    expect(html).toContain('role="status"');
  });

  it('the Details hold the existing checklist', async () => {
    const result = await open();
    const html = render(h(VerifySummary, { result, trust: 'pinned-match' }));
    expect(html).toContain('Signatures on every version');
    expect(html).toContain('Server checkpoint');
  });

  it('first visit shows the small remembered line', async () => {
    const result = await open();
    const full = render(h(VerifySummary, { result, trust: 'first-visit' }));
    expect(full).toContain('vsum--good');
    expect(full).toContain('First visit');
    const compact = render(h(VerifySummary, { result, trust: 'first-visit', compact: true }));
    expect(compact).toContain('vsum--compact');
    expect(compact).toContain('First visit, server key remembered.');
  });

  it('compact leaves out the extra lines but keeps the headline and Details', async () => {
    const result = await open();
    const html = render(h(VerifySummary, { result, trust: 'pinned-match', compact: true }));
    expect(html).toContain('Verified');
    expect(html).not.toContain('vsum__checked');
    expect(html).not.toContain('vsum__fact');
    expect(html).toContain('<summary>Details</summary>');
  });

  it('amber: not the newest record', async () => {
    const result = await open({ unanchored: true });
    const html = render(h(VerifySummary, { result, trust: 'pinned-match' }));
    expect(html).toContain('vsum--warn');
    expect(html).not.toContain('vsum--good');
    expect(html).toContain('a newer version may exist');
  });

  it('amber: withdrawn', async () => {
    const result = await open({ versions: [{}, { revoke: true }] });
    const html = render(h(VerifySummary, { result, trust: 'pinned-match' }));
    expect(html).toContain('vsum--warn');
    expect(html).toContain('Withdrawn');
    expect(html).toContain('The owner withdrew this file.');
    expect(html).toContain(', withdrawn');
  });

  it('red: key changed, as an alert', async () => {
    const result = await open();
    const html = render(h(VerifySummary, { result, trust: 'remembered-mismatch' }));
    expect(html).toContain('vsum--bad');
    expect(html).toContain("The server&#x27;s identity changed since your last visit.");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('vsum--good');
  });

  it('red: the verifier found the key is not the pinned one, whatever the caller said', async () => {
    const result = await open({ other: true });
    expect(result.verification.ok).toBe(false);
    const html = render(h(VerifySummary, { result }));
    expect(html).toContain('vsum--bad');
    expect(html).toContain('identity changed');
  });

  it('red: a failed check says do not trust and names it in plain words', async () => {
    const owner = await createIdentity('Priya');
    const parts = await buildBundleParts({ owner, versions: [{}, { signWith: await createIdentity('Eve') }] });
    const serverKey = parts.serverKey;
    const verification = await verifyDocumentBundle(parts.bundle, { expectedDocId: parts.docId, pinnedServerKeyId: serverKey.keyId });
    const html = render(h(VerifySummary, { result: { verification, bundle: parts.bundle }, trust: 'pinned-match' }));
    expect(html).toContain('vsum--bad');
    expect(html).toContain('Do not trust this file.');
    expect(html).toContain('A version was not signed correctly.');
    expect(html).toContain('Verification failed');
  });

  it('always has Details, even without a usable result', () => {
    for (const result of [null, undefined, {}, 'x', { verification: 5 }]) {
      const html = render(h(VerifySummary, { result, trust: 'pinned-match' }));
      expect(html).toContain('<summary>Details</summary>');
      expect(html).toContain('There are no check results to show.');
      expect(html).not.toContain('vsum--good');
    }
  });

  it('shows hostile names as text, never as markup', async () => {
    const owner = await createIdentity('<img src=x onerror=alert(1)>');
    const parts = await buildBundleParts({ owner, versions: [{ label: '<script>alert(1)</script>' }] });
    const verification = await verifyDocumentBundle(parts.bundle, { expectedDocId: parts.docId, pinnedServerKeyId: parts.serverKey.keyId });
    const html = render(h(VerifySummary, { result: { verification, bundle: parts.bundle }, trust: 'pinned-match' }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('has no emoji, no em dash and no inline style in its markup', async () => {
    const result = await open();
    const html = render(h(VerifySummary, { result, trust: 'first-visit' })) + render(h(VerifySummary, { result: null }));
    expect(html).not.toContain('—');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(html).not.toMatch(/ style="/);
  });
});

describe('fileLines', () => {
  it('is empty when the file was not looked at', () => {
    expect(fileLines(null)).toEqual([]);
    expect(fileLines({})).toEqual([]);
    expect(fileLines({ verification: {} })).toEqual([]);
  });

  it('no password: the stored file matched, the file was not opened', () => {
    const lines = fileLines({ blobCheck: { ok: true } });
    expect(lines.map((l) => [l.id, l.ok])).toEqual([['blob', true], ['plain', true]]);
    expect(lines[1].text).toBe('The file was not opened.');
  });

  it('password worked', () => {
    const lines = fileLines({ blobCheck: { ok: true }, plaintextCheck: { ok: true }, fingerprint: 'ab'.repeat(32) });
    expect(lines.every((l) => l.ok)).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it('password did not open the file, or the stored file is wrong', () => {
    const wrongPw = fileLines({ blobCheck: { ok: true }, plaintextCheck: { ok: false }, fingerprint: null });
    expect(wrongPw[1]).toMatchObject({ ok: false, text: 'The password did not open the file.' });
    const wrongBlob = fileLines({ blobCheck: { ok: false } });
    expect(wrongBlob[0]).toMatchObject({ ok: false });
    const changed = fileLines({ blobCheck: { ok: true }, plaintextCheck: { ok: false }, fingerprint: 'cd'.repeat(32) });
    expect(changed[1]).toMatchObject({ ok: false, text: 'The opened file does not match what the owner signed.' });
  });
});

describe('QuickCheck', () => {
  it('shows one big input, a Check button and nothing else before a check', () => {
    const html = render(h(QuickCheck));
    expect(html).toContain('Check a document');
    expect(html).toContain('Paste a link or ID');
    expect(html).toContain('>Check<');
    expect(html).toContain('type="text"');
    expect(html).toContain('for="');
    expect(html).not.toContain('vsum');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/\bpassword\b.*<input/i);
  });
});

describe('RememberedSection', () => {
  it('says nothing is remembered yet', () => {
    const html = render(h(RememberedSection, { pinned: '' }));
    expect(html).toContain('Remembered server key');
    expect(html).toContain('Nothing is remembered yet');
    expect(html).not.toContain('Forget the remembered key');
  });

  it('with a remembered key it shows it and offers to forget it', () => {
    const map = new Map([['hrdlock.rememberedServerKeyId', 'ab'.repeat(32)]]);
    vi.stubGlobal('localStorage', { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) });
    const html = render(h(RememberedSection, { pinned: '' }));
    expect(html).toContain('ab'.repeat(32));
    expect(html).toContain('Forget the remembered key');
  });

  it('says a pinned key is used instead', () => {
    const html = render(h(RememberedSection, { pinned: 'cd'.repeat(32) }));
    expect(html).toContain('You pinned a key');
  });
});

describe('the new files follow the text rules', () => {
  const root = join(import.meta.dirname, '..', '..');
  for (const file of ['src/components/verify/QuickCheck.jsx', 'src/components/verify/quickLogic.js', 'src/components/verify/RememberedSection.jsx']) {
    it(`${file}: no em dash, no emoji, no mention of AI, no inline style`, () => {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text).not.toContain('—');
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\bAI\b|OpenAI|Anthropic|Claude|GPT|assistant/i);
      expect(text).not.toContain('dangerouslySetInnerHTML');
      expect(text).not.toMatch(/style=["'{]/);
    });
  }
});

describe('quickCheck (the flow behind the Check button)', () => {
  const DOC = '0123456789abcdef0123456789abcdef';
  const PIN = 'a1'.repeat(32);

  function deps(over = {}) {
    const calls = [];
    return {
      calls,
      loadTrust: vi.fn(async () => ({ trust: 'first-visit', pin: PIN })),
      open: vi.fn(async (args) => {
        calls.push(args);
        return { verification: { ok: true }, bundle: { b: 1 }, blobCheck: null, plaintextCheck: null, fingerprint: null, file: null };
      }),
      ...over
    };
  }

  it('rejects input that is not a document link or id without touching the network', async () => {
    const d = deps();
    for (const bad of ['', '   ', 'hello', 'a'.repeat(64), 5, null, undefined]) {
      const out = await quickCheck(bad, d);
      expect(out.ok).toBe(false);
      expect(typeof out.error).toBe('string');
    }
    expect(d.loadTrust).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
  });

  it('opens the document with the effective pin and passes the trust state on', async () => {
    const d = deps();
    const out = await quickCheck(DOC, d);
    expect(out).toMatchObject({ ok: true, stale: false, docId: DOC, trust: 'first-visit' });
    expect(d.calls[0].docId).toBe(DOC);
    expect(d.calls[0].pinnedServerKeyId).toBe(PIN);
    expect(d.calls[0].password).toBe('');
  });

  it('takes the file password from the link and the document id from a full link', async () => {
    const d = deps();
    const out = await quickCheck(`https://example.test/d/${DOC.toUpperCase()}#k=ABCD-EFGH`, d);
    expect(out.docId).toBe(DOC);
    expect(d.calls[0].password).toBe('ABCDEFGH');
  });

  it('turns the file into a name and a size only, never the bytes', async () => {
    const d = deps({
      open: vi.fn(async () => ({
        verification: { ok: true },
        bundle: {},
        blobCheck: { ok: true },
        plaintextCheck: { ok: true },
        fingerprint: 'ab',
        file: { name: 'a.txt', data: new Uint8Array(5) }
      }))
    });
    const out = await quickCheck(DOC, d);
    expect(out.result.file).toEqual({ name: 'a.txt', size: 5 });
  });

  it('an unknown trust state and a missing pin become empty strings', async () => {
    const d = deps({ loadTrust: async () => ({ trust: 5, pin: null }) });
    const out = await quickCheck(DOC, d);
    expect(out.trust).toBe('');
    expect(d.calls[0].pinnedServerKeyId).toBe('');
  });

  it('lets network errors through and drops a stale answer', async () => {
    const boom = deps({ open: async () => { throw new Error('offline'); } });
    await expect(quickCheck(DOC, boom)).rejects.toThrow('offline');
    const d = deps();
    expect(await quickCheck(DOC, d, { isStale: () => true })).toEqual({ ok: true, stale: true });
    expect(d.open).not.toHaveBeenCalled();
    let n = 0;
    const d2 = deps();
    expect(await quickCheck(DOC, d2, { isStale: () => ++n > 1 })).toEqual({ ok: true, stale: true });
  });
});
