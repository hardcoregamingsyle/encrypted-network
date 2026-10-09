import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import Certificate from '../../src/components/doc/Certificate.jsx';
import DocSummary from '../../src/components/doc/DocSummary.jsx';
import DocTimeline from '../../src/components/doc/DocTimeline.jsx';
import ProgressList from '../../src/components/doc/ProgressList.jsx';
import PublishVersion from '../../src/components/doc/PublishVersion.jsx';
import RevokePanel from '../../src/components/doc/RevokePanel.jsx';
import SharePanel from '../../src/components/doc/SharePanel.jsx';
import UnlockPanel from '../../src/components/doc/UnlockPanel.jsx';
import DocumentPage from '../../src/pages/DocumentPage.jsx';
import { verifyDocumentBundle } from '../../shared/verify.js';
import { buildBundleParts, createIdentity, createServerKey } from '../helpers/bundle.js';

const PW = 'ABCD-EFGH-JKLM-NPQR-STUV';
const inRouter = (node) => h(MemoryRouter, null, node);
const render = (node) => renderToString(inRouter(node));

async function fixture(versions = [{ label: 'Act of 2026' }, { label: 'Act of 2026, corrected' }]) {
  const owner = await createIdentity('Registry Office');
  const serverKey = await createServerKey();
  const parts = await buildBundleParts({ owner, serverKey, versions });
  const verification = await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: serverKey.keyId, expectedDocId: parts.docId });
  return { ...parts, owner, serverKey, verification };
}

const noop = () => {};

describe('DocSummary', () => {
  it('shows the status, version, signer and the pinned state', async () => {
    const f = await fixture();
    const html = render(h(DocSummary, { docId: f.docId, bundle: f.bundle, verification: f.verification, pinnedServerKeyId: f.serverKey.keyId }));
    expect(html).toContain('Active');
    expect(html).toContain('Version 2');
    expect(html).toContain('Act of 2026, corrected');
    expect(html).toContain('Registry Office');
    expect(html).toContain(f.docId);
    expect(html).toContain('Matches your pinned key');
    expect(html).not.toContain('Pin the server key');
  });

  it('shows a pin hint linking to /verify when nothing is pinned', async () => {
    const f = await fixture();
    const html = render(h(DocSummary, { docId: f.docId, bundle: f.bundle, verification: f.verification, pinnedServerKeyId: '' }));
    expect(html).toContain('Pin the server key on the verify page');
    expect(html).toContain('href="/verify"');
    expect(html).toContain('Not pinned');
  });

  it('flags a pin that does not match', async () => {
    const f = await fixture();
    const html = render(h(DocSummary, { docId: f.docId, bundle: f.bundle, verification: f.verification, pinnedServerKeyId: 'ab'.repeat(32) }));
    expect(html).toContain('Does not match your pinned key');
  });

  it('shows the reason for a revoked document', async () => {
    const f = await fixture([{}, { revoke: true, reason: 'Issued by mistake' }]);
    const html = render(h(DocSummary, { docId: f.docId, bundle: f.bundle, verification: f.verification, pinnedServerKeyId: '' }));
    expect(html).toContain('Revoked');
    expect(html).toContain('Issued by mistake');
  });

  it('does not crash on empty data', () => {
    const html = render(h(DocSummary, { docId: 'x', bundle: null, verification: null, pinnedServerKeyId: '' }));
    expect(html).toContain('Not verified');
  });
});

describe('DocTimeline', () => {
  it('lists versions newest first with hashes and ledger numbers', async () => {
    const f = await fixture([{ label: 'one' }, { label: 'two' }, { label: 'three' }]);
    const html = render(h(DocTimeline, { bundle: f.bundle, verified: true }));
    expect(html.indexOf('Version 3')).toBeLessThan(html.indexOf('Version 2'));
    expect(html.indexOf('Version 2')).toBeLessThan(html.indexOf('Version 1'));
    expect(html).toContain('Created');
    expect(html).toContain('Updated');
    expect(html).toContain('Latest');
    for (const v of f.versions) {
      expect(html).toContain(v.recordHash);
      expect(html).toContain(v.record.blob.hash);
    }
    expect(html).toContain('Ledger number');
    expect(html).toContain('signed by the owner key');
  });

  it('says the list is untrusted when verification failed', async () => {
    const f = await fixture();
    const html = render(h(DocTimeline, { bundle: f.bundle, verified: false }));
    expect(html).toContain('cannot be trusted until all the checks');
  });

  it('shows a revoke entry with its reason and no file hash', async () => {
    const f = await fixture([{}, { revoke: true, reason: 'Superseded by law' }]);
    const html = render(h(DocTimeline, { bundle: f.bundle, verified: true }));
    expect(html).toContain('Revoked');
    expect(html).toContain('Superseded by law');
  });

  it('has an empty state', () => {
    expect(render(h(DocTimeline, { bundle: { records: [] }, verified: false }))).toContain('no versions');
  });
});

describe('UnlockPanel', () => {
  const base = { verified: true, revoked: false, password: '', onPassword: noop, onUnlock: noop, busy: false, steps: [], error: '' };

  it('renders a labelled password field and an unlock button before unlocking', () => {
    const html = render(h(UnlockPanel, { ...base, result: { blobCheck: { ok: true, detail: 'ok' }, plaintextCheck: null, file: null } }));
    expect(html).toContain('Document password');
    expect(html).toContain('type="password"');
    expect(html).toContain('Unlock and verify');
    expect(html).toContain('Locked file hash matches the signed record');
    expect(html).toContain('not checked yet');
    expect(html).not.toContain('Download');
  });

  it('the unlock button is disabled with an empty password and enabled with one', () => {
    const empty = render(h(UnlockPanel, { ...base, result: null }));
    expect(empty).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Unlock and verify/s);
    const filled = render(h(UnlockPanel, { ...base, password: PW, result: null }));
    expect(filled).not.toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Unlock and verify/s);
  });

  it('shows the checklist and a download button after a good unlock', () => {
    const result = {
      blobCheck: { ok: true, detail: 'ok' },
      plaintextCheck: { ok: true, detail: 'ok' },
      fingerprint: 'cd'.repeat(32),
      file: { name: 'act.txt', data: new Uint8Array(2048) }
    };
    const html = render(h(UnlockPanel, { ...base, password: PW, result }));
    expect(html).toContain('Password accepted');
    expect(html).toContain('cd'.repeat(32));
    expect(html).toContain('Download act.txt');
    expect(html).toContain('2 KiB');
    expect(html).toContain('File checked');
  });

  it('warns on the download when the bundle did not verify', () => {
    const result = {
      blobCheck: { ok: true, detail: 'ok' },
      plaintextCheck: { ok: true, detail: 'ok' },
      fingerprint: 'cd'.repeat(32),
      file: { name: 'act.txt', data: new Uint8Array(4) }
    };
    const html = render(h(UnlockPanel, { ...base, verified: false, result }));
    expect(html).toContain('did not pass verification');
    expect(html).not.toContain('File checked');
  });

  it('a wrong password shows a failed row and no download', () => {
    const result = {
      blobCheck: { ok: true, detail: 'ok' },
      plaintextCheck: { ok: false, detail: 'wrong password, or the file was changed' },
      fingerprint: null,
      file: null
    };
    const html = render(h(UnlockPanel, { ...base, password: 'nope', result }));
    expect(html).toContain('wrong password, or the file was changed');
    expect(html).toContain('is-bad');
    expect(html).not.toContain('Download');
  });

  it('a revoked document has no password form', () => {
    const html = render(h(UnlockPanel, { ...base, revoked: true, result: { blobCheck: null, plaintextCheck: null, file: null } }));
    expect(html).toContain('This document was revoked');
    expect(html).not.toContain('Document password');
    expect(html).toContain('A revoked document has no current file');
  });

  it('shows errors in an alert and progress text in a live region', () => {
    const html = render(
      h(UnlockPanel, {
        ...base,
        busy: true,
        password: PW,
        steps: [{ id: 'unlock', text: 'Deriving the key, this takes a moment' }],
        error: 'Could not reach the server. Check your connection.',
        result: null
      })
    );
    expect(html).toContain('Deriving the key, this takes a moment');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-busy="true"');
  });
});

describe('ProgressList', () => {
  it('renders nothing but a live region when empty', () => {
    const html = renderToString(h(ProgressList, { steps: [], busy: false }));
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<li');
  });

  it('marks the last step as running while busy', () => {
    const html = renderToString(h(ProgressList, { steps: [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }], busy: true }));
    expect(html).toContain('is-done');
    expect(html).toContain('is-running');
  });
});

describe('owner tools', () => {
  it('PublishVersion has the file, label and password options', async () => {
    const f = await fixture();
    const html = render(h(PublishVersion, { docId: f.docId, head: { version: 2, recordHash: f.versions[1].recordHash }, identity: { keyId: f.owner.keyId, sign: noop }, unlockedWith: '', onPublished: noop }));
    expect(html).toContain('Publish a new version');
    expect(html).toContain('type="file"');
    expect(html).toContain('Keep the current document password');
    expect(html).toContain('Use a new password');
    expect(html).toContain('Lock and publish version 3');
    expect(html).toContain('Unlock the file above first');
  });

  it('PublishVersion with a confirmed password asks only for a file', async () => {
    const f = await fixture();
    const html = render(h(PublishVersion, { docId: f.docId, head: { version: 1, recordHash: f.versions[0].recordHash }, identity: { keyId: f.owner.keyId, sign: noop }, unlockedWith: 'ABCDEFGHJKLMNPQRSTUV', onPublished: noop }));
    expect(html).not.toContain('Unlock the file above first. That confirms');
    expect(html).toContain('Choose the new file.');
  });

  it('RevokePanel explains that revoking is permanent and public and disables the button', async () => {
    const f = await fixture();
    const html = render(h(RevokePanel, { docId: f.docId, head: { version: 2, recordHash: f.versions[1].recordHash }, identity: { keyId: f.owner.keyId, sign: noop }, onRevoked: noop }));
    expect(html).toContain('permanent and public');
    expect(html).toContain('Type REVOKE to confirm');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Revoke this document/s);
    expect(html).toContain('Write the reason for the revoke.');
  });
});

describe('SharePanel', () => {
  it('shows the verify-only link and asks for a password for the full link', async () => {
    const f = await fixture();
    const html = render(h(SharePanel, { docId: f.docId, bundle: f.bundle, headVersion: 2, pinnedServerKeyId: '', password: '', confirmed: false }));
    expect(html).toContain('/d/' + f.docId);
    expect(html).not.toContain('#k=');
    expect(html).toContain('Enter the document password above');
    expect(html).toContain('Download verification bundle');
  });

  it('shows the full link with the password after the # sign when a password is known', async () => {
    const f = await fixture();
    const html = render(h(SharePanel, { docId: f.docId, bundle: f.bundle, headVersion: 2, pinnedServerKeyId: '', password: PW, confirmed: true }));
    expect(html).toContain('/d/' + f.docId + '#k=ABCDEFGHJKLMNPQRSTUV');
    expect(html).not.toContain('has not been confirmed');
  });

  it('says when the password was not confirmed', async () => {
    const f = await fixture();
    const html = render(h(SharePanel, { docId: f.docId, bundle: f.bundle, headVersion: 2, pinnedServerKeyId: '', password: PW, confirmed: false }));
    expect(html).toContain('has not been confirmed');
  });
});

describe('Certificate', () => {
  it('has the facts and the sentence about limits', async () => {
    const f = await fixture();
    const html = render(h(Certificate, { bundle: f.bundle, verification: f.verification, pinnedServerKeyId: f.serverKey.keyId, checkedAt: 1700000000000 }));
    expect(html).toContain('Document verification certificate');
    expect(html).toContain('Passed all checks');
    expect(html).toContain(f.docId);
    expect(html).toContain(f.versions[1].recordHash);
    expect(html).toContain(f.owner.keyId);
    expect(html).toContain(f.serverKey.keyId);
    expect(html).toContain('Registry Office');
    expect(html).toContain('yes, and it matches');
    expect(html).toContain('not been audited or certified');
    expect(html).toContain('Latest here means');
  });

  it('a failed document is printed as not passed', async () => {
    const f = await fixture();
    const html = render(h(Certificate, { bundle: f.bundle, verification: { ...f.verification, ok: false, checks: [{ id: 'checkpoint', ok: false, detail: 'older than the last record' }] }, pinnedServerKeyId: '', checkedAt: 5 }));
    expect(html).toContain('DID NOT PASS verification');
    expect(html).toContain('older than the last record');
    expect(html).toContain('is-bad');
  });
});

describe('DocumentPage', () => {
  const page = (path) =>
    renderToString(
      h(MemoryRouter, { initialEntries: [path] }, h(Routes, null, h(Route, { path: '/d/:docId', element: h(DocumentPage) })))
    );

  it('starts in a loading state for a valid id', () => {
    const html = page('/d/' + 'a'.repeat(32));
    expect(html).toContain('Checking the document');
    expect(html).toContain('aria-busy="true"');
  });

  it('rejects an id that is not 32 hex characters without loading', () => {
    const html = page('/d/not-an-id');
    expect(html).toContain('Not a document id');
    expect(html).toContain('href="/verify"');
    expect(html).not.toContain('Try again');
  });

  it('has no em dashes or vendor words in any rendered text', async () => {
    const f = await fixture();
    const all =
      render(h(DocSummary, { docId: f.docId, bundle: f.bundle, verification: f.verification, pinnedServerKeyId: '' })) +
      render(h(DocTimeline, { bundle: f.bundle, verified: true })) +
      render(h(Certificate, { bundle: f.bundle, verification: f.verification, pinnedServerKeyId: '', checkedAt: 5 })) +
      page('/d/' + 'a'.repeat(32));
    expect(all).not.toContain('—');
    expect(all).not.toMatch(/\bAI\b|assistant|chatgpt|openai|anthropic|claude/i);
  });
});
