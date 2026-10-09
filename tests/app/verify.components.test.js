import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { verifyDocumentBundle } from '../../shared/verify.js';
import App from '../../src/App.jsx';
import AuditSection from '../../src/components/verify/AuditSection.jsx';
import AuditSummary from '../../src/components/verify/AuditSummary.jsx';
import BundleSection from '../../src/components/verify/BundleSection.jsx';
import DocResult from '../../src/components/verify/DocResult.jsx';
import DocumentSection from '../../src/components/verify/DocumentSection.jsx';
import FileSection from '../../src/components/verify/FileSection.jsx';
import PinSection from '../../src/components/verify/PinSection.jsx';
import Section from '../../src/components/verify/Section.jsx';
import VerifyPage from '../../src/pages/VerifyPage.jsx';
import { buildBundle, createIdentity, createServerKey } from '../helpers/bundle.js';

const render = (node, path = '/verify') => renderToString(h(MemoryRouter, { initialEntries: [path] }, node));

describe('VerifyPage', () => {
  it('renders all five sections and says no account is needed', () => {
    const html = render(h(VerifyPage));
    expect(html).toContain('This page needs no account');
    for (const id of ['verify-pin', 'verify-document', 'verify-bundle', 'verify-file', 'verify-audit']) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
    expect(html).toContain('1. Server key pin');
    expect(html).toContain('2. Verify a document');
    expect(html).toContain('3. Verify a saved bundle');
    expect(html).toContain('4. Check a file');
    expect(html).toContain('5. Full ledger audit');
    expect(html).toContain('<h1');
  });

  it('every input has a label and every section is a labelled region', () => {
    const html = render(h(VerifyPage));
    const inputs = html.match(/<input [^>]*>/g) || [];
    expect(inputs.length).toBeGreaterThan(5);
    for (const tag of inputs) {
      const id = /id="([^"]+)"/.exec(tag);
      expect(id, tag).not.toBeNull();
      expect(html).toContain(`for="${id[1]}"`);
    }
    expect((html.match(/aria-labelledby="verify-[a-z]+-title"/g) || []).length).toBe(5);
  });

  it('is served on the /verify route', () => {
    const html = render(h(App), '/verify');
    expect(html).toContain('This page needs no account');
  });

  it('the intro of each section is one plain sentence', () => {
    const html = render(h(VerifyPage));
    const intros = html.match(/class="verify-section__intro">[^<]+</g) || [];
    expect(intros).toHaveLength(5);
  });
});

describe('sections', () => {
  const pin = 'a'.repeat(64);

  it('PinSection: loading state, why pinning matters, input and save button', () => {
    const html = render(h(PinSection, { pinned: '', onPinChange() {} }));
    expect(html).toContain('Loading the server key');
    expect(html).toContain('Why pinning matters');
    expect(html).toContain('Expected server key id');
    expect(html).toContain('Save pin');
    expect(html).toContain('Not pinned');
    expect(html).not.toContain('Clear pin');
  });

  it('PinSection: a pin shows the clear button and the pinned id', () => {
    const html = render(h(PinSection, { pinned: pin, onPinChange() {} }));
    expect(html).toContain('Clear pin');
    expect(html).toContain(pin);
    expect(html).toContain('Pinned, checking the server key');
  });

  it('DocumentSection, BundleSection, FileSection and AuditSection render their controls', () => {
    const doc = render(h(DocumentSection, { pinned: '' }));
    expect(doc).toContain('Document id or link');
    expect(doc).toContain('Verify document');
    const bundle = render(h(BundleSection, { pinned: '' }));
    expect(bundle).toContain('type="file"');
    expect(bundle).toContain('not uploaded');
    const file = render(h(FileSection, { pinned: '' }));
    expect(file).toContain('Fingerprint to compare');
    expect(file).toContain('Unlock and compare');
    expect(file).toContain('never uploaded');
    const audit = render(h(AuditSection, { pinned: '' }));
    expect(audit).toContain('Start the full audit');
    expect(audit).not.toContain('Cancel');
  });

  it('Section wraps content with a heading and intro', () => {
    const html = render(h(Section, { id: 'x', title: 'Title', intro: 'Intro.' }, h('p', null, 'body')));
    expect(html).toContain('id="x-title"');
    expect(html).toContain('Intro.');
    expect(html).toContain('body');
  });
});

describe('DocResult', () => {
  async function verified(versions = [{}, {}], opts = {}) {
    const owner = await createIdentity('Registry Office');
    const serverKey = await createServerKey();
    const bundle = await buildBundle({ owner, versions, serverKey });
    const verification = await verifyDocumentBundle(bundle, { pinnedServerKeyId: opts.unpinned ? '' : serverKey.keyId });
    return { owner, serverKey, bundle, verification };
  }

  it('online result without a password says the file was not opened', async () => {
    const { bundle, verification } = await verified();
    const html = render(h(DocResult, { verification, bundle, blobCheck: { ok: true, detail: 'matches' }, passwordGiven: false }));
    expect(html).toContain('Signatures, version chain and server checkpoint all check out');
    expect(html).toContain('Locked file matches the signed hash');
    expect(html).toContain('No password was given');
    expect(html).toContain(`/d/${bundle.document.docId}`);
    expect(html).toContain('Registry Office');
    expect(html).not.toContain('Checked offline');
  });

  it('with a password it shows the fingerprint and the file name', async () => {
    const { bundle, verification } = await verified();
    const fp = 'ab'.repeat(32);
    const html = render(
      h(DocResult, {
        verification,
        bundle,
        blobCheck: { ok: true, detail: 'ok' },
        plaintextCheck: { ok: true, detail: 'ok' },
        fingerprint: fp,
        file: { name: 'act.txt', size: 2048 },
        passwordGiven: true
      })
    );
    expect(html).toContain('Unlocked file matches the signed commitment');
    expect(html).toContain('act.txt');
    expect(html).toContain('2 KiB');
    expect(html).toContain(fp.slice(0, 8) + ' ' + fp.slice(8, 16));
  });

  it('a failed file check is marked failed', async () => {
    const { bundle, verification } = await verified();
    const html = render(
      h(DocResult, { verification, bundle, blobCheck: { ok: false, detail: 'file hash differs from the signed hash' }, passwordGiven: true })
    );
    expect(html).toContain('is-bad');
    expect(html).toContain('file hash differs from the signed hash');
  });

  it('an offline result is clearly labelled and explains what latest means', async () => {
    const { bundle, verification } = await verified();
    const html = render(h(DocResult, { verification, bundle, offline: true, attestedAt: bundle.checkpoint.payload.signedAt }));
    expect(html).toContain('Checked offline');
    expect(html).toContain('Nothing was sent anywhere');
    expect(html).toContain('A newer version may have been published since');
    expect(html).not.toContain('No password was given');
  });

  it('a tampered bundle shows the failure banner', async () => {
    const { bundle } = await verified();
    bundle.records[0].record.label = 'changed';
    const verification = await verifyDocumentBundle(bundle);
    const html = render(h(DocResult, { verification, bundle, offline: true }));
    expect(html).toContain('Verification failed');
    expect(html).toContain('is-bad');
  });

  it('a revoked document is shown as revoked', async () => {
    const { bundle, verification } = await verified([{}, { revoke: true, reason: 'withdrawn' }]);
    const html = render(h(DocResult, { verification, bundle, offline: true }));
    expect(html).toContain('Revoked by the owner');
  });

  it('renders nothing without a result', () => {
    expect(render(h(DocResult, {}))).toBe('');
  });
});

describe('AuditSummary', () => {
  const base = {
    ok: true,
    status: 'done',
    error: null,
    entries: 1200,
    documents: 80,
    pages: 7,
    lastSeq: 1200,
    lastHash: 'c'.repeat(64),
    problems: [],
    problemCount: 0,
    warnings: ['The server key is not pinned.'],
    checkpoint: { present: true, signatureOk: true, scopeOk: true, seq: 1200, hash: 'c'.repeat(64), signedAt: 1_700_000_000_000, serverKeyId: 'd'.repeat(64), pinMatches: null, matchesEnd: true },
    pinned: null,
    knownPointChecked: false
  };

  it('a clean audit passes and offers the position to keep', () => {
    const html = render(h(AuditSummary, { result: base }));
    expect(html).toContain('Ledger audit passed');
    expect(html).toContain('1200');
    expect(html).toContain('80');
    expect(html).toContain('Ledger position to keep');
    expect(html).toContain('The server key is not pinned.');
    expect(html).toContain('Not pinned');
  });

  it('shows only the first 50 problems and how many were left out', () => {
    const problems = Array.from({ length: 50 }, (_, i) => `entry ${i + 1}: signature does not verify`);
    const html = render(h(AuditSummary, { result: { ...base, ok: false, problems, problemCount: 173 } }));
    expect(html).toContain('Problems found: 173 problems');
    expect(html).toContain('first 50 of 173');
    expect(html).toContain('and 123 more problems not listed');
    expect((html.match(/signature does not verify/g) || []).length).toBe(50);
    expect(html).not.toContain('Ledger position to keep');
  });

  it('cancelled and failed audits do not claim success', () => {
    const aborted = render(h(AuditSummary, { result: { ...base, ok: false, status: 'aborted', entries: 400, checkpoint: null } }));
    expect(aborted).toContain('Audit cancelled');
    expect(aborted).not.toContain('Ledger audit passed');
    expect(aborted).not.toContain('Ledger position to keep');
    const failed = render(
      h(AuditSummary, { result: { ...base, ok: false, status: 'error', error: 'Could not reach the server.', entries: 400, checkpoint: null } })
    );
    expect(failed).toContain('Audit could not finish');
    expect(failed).toContain('Could not reach the server.');
  });

  it('a pin mismatch is spelled out', () => {
    const result = {
      ...base,
      ok: false,
      pinned: 'e'.repeat(64),
      problems: ['The server key is NOT the pinned key'],
      problemCount: 1,
      checkpoint: { ...base.checkpoint, pinMatches: false }
    };
    const html = render(h(AuditSummary, { result }));
    expect(html).toContain('NO, the server key differs from your pin');
    expect(html).toContain('Problems found: 1 problem');
  });

  it('a consistent ledger without a checkpoint is not called confirmed', () => {
    const html = render(
      h(AuditSummary, { result: { ...base, checkpoint: { present: false, signatureOk: false, matchesEnd: false, pinMatches: null } } })
    );
    expect(html).toContain('its end is not confirmed');
    expect(html).not.toContain('Ledger audit passed');
  });

  it('renders nothing without a result', () => {
    expect(render(h(AuditSummary, {}))).toBe('');
  });
});

describe('text rules for the files of this page', () => {
  const root = join(import.meta.dirname, '..', '..');
  const files = [
    'src/pages/VerifyPage.jsx',
    'src/lib/audit.js',
    'src/styles/verify.css',
    ...readdirSync(join(root, 'src/components/verify')).map((f) => `src/components/verify/${f}`)
  ];

  for (const file of files) {
    it(`${file}: no em dash, no emoji, no mention of AI`, () => {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text).not.toContain('—');
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\bAI\b|OpenAI|Anthropic|Claude|GPT|assistant/i);
    });
  }

  for (const file of files.filter((f) => f.endsWith('.jsx'))) {
    it(`${file}: no inline script, no dangerouslySetInnerHTML, no style attribute strings`, () => {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text).not.toContain('dangerouslySetInnerHTML');
      expect(text).not.toMatch(/style=["'{]/);
      expect(text).not.toContain('eval(');
    });
  }
});
