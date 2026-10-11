// Server render smoke tests of the Files screen, the Add file sheet, the file page and their parts.
// The session is set to each state through a fake store, like in shell.pages.test.js.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { verifyDocumentBundle } from '../../shared/verify.js';
import { AuthPromptProvider } from '../../src/components/AuthPrompt.jsx';
import { ToastProvider } from '../../src/components/Toast.jsx';
import FileView from '../../src/components/doc/FileView.jsx';
import ManageSheet from '../../src/components/doc/ManageSheet.jsx';
import PasswordLine from '../../src/components/doc/PasswordLine.jsx';
import VersionList from '../../src/components/doc/VersionList.jsx';
import { ownerAccess } from '../../src/components/doc/docLogic.js';
import { openPlan, versionRows } from '../../src/components/doc/pageLogic.js';
import AddFileSheet from '../../src/components/files/AddFileSheet.jsx';
import FileList from '../../src/components/files/FileList.jsx';
import FileRow, { FileIcon, StatusChip } from '../../src/components/files/FileRow.jsx';
import { SessionProvider } from '../../src/lib/session.jsx';
import DocumentPage from '../../src/pages/DocumentPage.jsx';
import FilesPage, { TabSwitch } from '../../src/pages/FilesPage.jsx';
import { lint } from '../review/a11y/html.js';
import { buildBundleParts, createIdentity, createServerKey } from '../helpers/bundle.js';

const KEY = 'ab'.repeat(32);
const ID = 'c'.repeat(32);
const PW = 'ABCD-EFGH-JKLM-NPQR-STUV';
const later = async () => {};

const BASE = {
  status: 'signedOut',
  mode: null,
  account: null,
  keys: [],
  identity: null,
  mailAvailable: true,
  accountsAvailable: true,
  registration: 'unknown',
  registrationError: '',
  keyProblem: false,
  error: ''
};
const IDENTITY = { keyId: KEY, displayName: 'Priya Nair', publicKey: {}, createdAt: 1790000000000, sign: later, record: {}, signature: '', hasBackup: false };
const ACCOUNT = { id: 'f'.repeat(32), displayName: 'Priya Nair', emailMasked: 'pr***@example.com', strict: false, createdAt: 1790000000000 };

const STATES = {
  loading: { status: 'loading' },
  out: {},
  needsKey: { status: 'needsKey', mode: 'account', account: { ...ACCOUNT, displayName: null } },
  easy: { status: 'ready', mode: 'account', account: ACCOUNT, keys: [{ keyId: KEY, hasCloudCopy: true }], identity: IDENTITY, registration: 'registered' },
  strict: { status: 'ready', mode: 'account', account: { ...ACCOUNT, strict: true }, keys: [{ keyId: KEY, hasCloudCopy: false }], identity: IDENTITY, registration: 'registered' },
  guest: { status: 'ready', mode: 'guest', identity: IDENTITY, registration: 'registered' }
};

function stubStore(patch) {
  const state = Object.freeze({ ...BASE, ...patch });
  const nope = async () => {
    throw new Error('stub');
  };
  return {
    getState: () => state,
    subscribe: () => () => {},
    init: later,
    refresh: later,
    requestCode: nope,
    verifyCode: nope,
    registerName: nope,
    startGuest: nope,
    signOut: nope,
    setStrict: nope,
    deleteAccount: nope,
    identityFor: () => null,
    createLegacy: nope,
    restoreBackup: nope,
    exportBackup: nope,
    registerAgain: nope,
    forgetDevice: nope
  };
}

function page(node, stateName = 'out', path = '/files') {
  const store = stubStore(STATES[stateName]);
  return renderToString(h(MemoryRouter, { initialEntries: [path] }, h(SessionProvider, { store }, h(ToastProvider, null, h(AuthPromptProvider, null, node)))));
}

const render = (node) => renderToString(h(MemoryRouter, { initialEntries: ['/files'] }, node));

function plainText(html, label = 'html') {
  expect(html, label).not.toMatch(/\sstyle=/);
  expect(html, label).not.toContain('<script');
  expect(html, label).not.toMatch(new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']'));
  expect(html, label).not.toMatch(/\b(AI|Claude|Anthropic|GPT|OpenAI|assistant)\b/);
}

const row = (extra = {}) => ({
  docId: ID,
  label: 'Land record.pdf',
  status: 'active',
  version: 3,
  updatedAt: Date.now() - 3600 * 1000,
  approxTime: false,
  ownerKeyId: KEY,
  ownerName: 'Office',
  listed: true,
  local: false,
  ...extra
});

const baseList = { status: 'ready', items: [], error: '', hasMore: false, moreBusy: false, moreError: '', announce: '', reload() {}, loadMore() {} };
const empty = { title: 'Nothing here', text: 'Add something.' };

describe('FilesPage', () => {
  it('has one h1, the Mine and Public switch with Mine pressed, and the Add file button', () => {
    for (const name of Object.keys(STATES)) {
      const html = page(h(FilesPage), name);
      expect(html, name).toContain('<h1');
      expect(html, name).toContain('Files');
      expect(html, name).toContain('Mine');
      expect(html, name).toContain('Public');
      expect(html, name).toMatch(/aria-pressed="true"[^>]*>Mine</);
      expect(html, name).toMatch(/aria-pressed="false"[^>]*>Public</);
      expect(html, name).toContain('Add file');
      expect(html, name).toContain('ui-fab');
      plainText(html, name);
    }
  });

  it('shows loading rows while the list loads for someone who is signed in', () => {
    for (const name of ['easy', 'strict', 'guest']) {
      const html = page(h(FilesPage), name);
      expect(html, name).toContain('Loading your files');
      expect(html, name).toContain('ui-skeleton');
    }
  });

  it('asks a signed out visitor to sign in and offers nothing private', () => {
    const html = page(h(FilesPage), 'out');
    expect(html).toContain('Sign in to see your files');
    expect(html).toContain('Sign in');
    expect(html).not.toContain('Loading your files');
  });

  it('sends a signed in account without a name to choose one', () => {
    const html = page(h(FilesPage), 'needsKey');
    expect(html).toContain('One more step');
    expect(html).toContain('href="/signin"');
    expect(html).toContain('Choose your name');
  });

  it('shows a skeleton while the session loads', () => {
    expect(page(h(FilesPage), 'loading')).toContain('Loading your files');
  });

  it('shows the Public tab with a labelled search box for anyone', () => {
    for (const name of ['out', 'easy', 'guest']) {
      const html = page(h(FilesPage), name, '/files?tab=public');
      expect(html, name).toMatch(/aria-pressed="true"[^>]*>Public</);
      expect(html, name).toContain('type="search"');
      expect(html, name).toContain('role="search"');
      expect(html, name).toContain('Search public files');
      expect(html, name).toContain('Loading public files');
      plainText(html, name);
    }
  });

  it('is valid markup in every state', () => {
    for (const name of Object.keys(STATES)) {
      for (const path of ['/files', '/files?tab=public']) {
        expect(lint(page(h(FilesPage), name, path), { fragment: true }), `${name} ${path}`).toEqual([]);
      }
    }
  });

  it('the switch is three buttons', () => {
    const html = render(h(TabSwitch, { tab: 'public', onChange() {} }));
    expect((html.match(/<button/g) || []).length).toBe(3);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Which files to show"');
  });
});

describe('file rows and lists', () => {
  it('a row shows the icon, label, version line, a status chip and links to the file page', () => {
    const html = render(h('ul', null, h(FileRow, { row: row(), now: Date.now() })));
    expect(html).toContain(`href="/d/${ID}"`);
    expect(html).toContain('Land record.pdf');
    expect(html).toContain('Version 3, edited today');
    expect(html).toContain('files-icon');
    expect(html).toContain('Not checked yet');
    expect(html).toContain('aria-hidden="true"');
    plainText(html);
  });

  it('shows a withdrawn file as Withdrawn', () => {
    const html = render(h('ul', null, h(FileRow, { row: row({ status: 'revoked' }) })));
    expect(html).toContain('Withdrawn');
    expect(html).toContain('ui-badge--warn');
  });

  it('the public list names the publisher', () => {
    const html = render(h('ul', null, h(FileRow, { row: row(), showOwner: true, now: Date.now() })));
    expect(html).toContain('Office, Version 3');
  });

  it('a file that is not on the server is not a link and can be removed', () => {
    const html = render(h('ul', null, h(FileRow, { row: row({ status: 'missing', local: true }), onForget() {} })));
    expect(html).not.toContain(`href="/d/${ID}"`);
    expect(html).toContain('Not found');
    expect(html).toContain('Remove from list: Land record.pdf');
  });

  it('handles an empty label and an unknown time', () => {
    const html = render(h('ul', null, h(FileRow, { row: row({ label: '', updatedAt: null, version: null }) })));
    expect(html).toContain('Untitled file');
    expect(html).toContain('Version not known');
  });

  it('icons follow the kind of file', () => {
    expect(render(h(FileIcon, { label: 'a.pdf' }))).toContain('files-icon--pdf');
    expect(render(h(FileIcon, { label: 'a.png' }))).toContain('files-icon--image');
    expect(render(h(FileIcon, { label: 'plain' }))).toContain('files-icon--file');
  });

  it('the chip carries words and an icon, and a hint', () => {
    const html = render(h(StatusChip, { chip: { tone: 'good', icon: 'shield-check', text: 'Verified', hint: 'Checked here.' } }));
    expect(html).toContain('Verified');
    expect(html).toContain('<svg');
    expect(html).toContain('title="Checked here."');
  });

  it('shows skeletons first, then empty, error and rows', () => {
    const loading = render(h(FileList, { list: { ...baseList, status: 'loading' }, rows: [], empty }));
    expect(loading).toContain('ui-skeleton');
    const emptyHtml = render(h(FileList, { list: baseList, rows: [], empty }));
    expect(emptyHtml).toContain('Nothing here');
    expect(emptyHtml).toContain('ui-art');
    const err = render(h(FileList, { list: { ...baseList, status: 'error', error: 'Could not reach the server.' }, rows: [], empty }));
    expect(err).toContain('Could not reach the server.');
    expect(err).toContain('Try again');
    const rows = render(h(FileList, { list: baseList, rows: [row()], empty }));
    expect(rows).toContain('Land record.pdf');
    expect(rows).not.toContain('Load more');
  });

  it('keeps old rows visible while a new search loads', () => {
    const html = render(h(FileList, { list: { ...baseList, status: 'loading' }, rows: [row()], empty }));
    expect(html).toContain('files-stale');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Land record.pdf');
  });

  it('shows what the browser remembers when the server list failed', () => {
    const html = render(h(FileList, { list: { ...baseList, status: 'error', error: 'Offline.' }, rows: [row()], empty }));
    expect(html).toContain('Showing what this browser remembers');
    expect(html).toContain('Land record.pdf');
  });

  it('shows Load more and its error', () => {
    expect(render(h(FileList, { list: { ...baseList, hasMore: true }, rows: [row()], empty }))).toContain('Load more');
    const failed = render(h(FileList, { list: { ...baseList, moreError: 'Server down' }, rows: [row()], empty }));
    expect(failed).toContain('Could not load more');
    expect(failed).toContain('Server down');
  });
});

describe('AddFileSheet', () => {
  const sheet = (stateName, props = {}) => page(h(AddFileSheet, { open: true, onClose() {}, onPublished() {}, ...props }), stateName);

  it('is a dialog with a file chooser, an optional label, the public switch off and a Publish button', () => {
    const html = sheet('easy');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Add a file');
    expect(html).toContain('type="file"');
    expect(html).toContain('Drop a file here, or choose one');
    expect(html).toContain('Label (optional)');
    expect(html).toContain('Make it public');
    expect(html).toMatch(/type="checkbox"(?![^>]*checked)/);
    expect(html).toContain('Publish');
    expect(html).toContain('Cancel');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Publish/s);
    plainText(html);
  });

  it('says the label is visible to anyone with the link and that the file stays locked', () => {
    const html = sheet('guest');
    expect(html).toContain('Anyone with the link can see the label');
    expect(html).toContain('locked on this device');
  });

  it('is closed and renders nothing when it is not open', () => {
    expect(sheet('easy', { open: false })).not.toContain('role="dialog"');
  });

  it('has a progress line that is a polite live region, and no password anywhere', () => {
    const html = sheet('easy');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
    expect(html).not.toContain('#k=');
  });

  it('is valid markup', () => {
    expect(lint(sheet('easy'), { fragment: true })).toEqual([]);
  });
});

describe('the file page', () => {
  async function fixture(versions = [{ label: 'Act of 2026' }, { label: 'Act of 2026, corrected' }], owner = null) {
    const o = owner || (await createIdentity('Priya'));
    const serverKey = await createServerKey();
    const parts = await buildBundleParts({ owner: o, serverKey, versions });
    const verification = await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: serverKey.keyId, expectedDocId: parts.docId });
    return { ...parts, owner: o, serverKey, verification };
  }

  function view(f, props = {}) {
    const result = props.result || { bundle: f.bundle, verification: f.verification, blobCheck: { ok: true, detail: 'ok' }, plaintextCheck: null, file: null, fingerprint: null };
    const access = props.access || ownerAccess({ identity: null, bundle: f.bundle, verification: f.verification });
    const plan = props.plan || openPlan({ result, revoked: f.verification.status === 'revoked' });
    return render(
      h(FileView, {
        docId: f.docId,
        result,
        trust: 'first-visit',
        pinned: '',
        checkedAt: 1760000000000,
        now: Date.now() + 1000,
        access,
        plan,
        onShare() {},
        onOpen() {},
        onSubmitPassword() {},
        onManage() {},
        ...props
      })
    );
  }

  it('shows the label as the header, the plain verdict, Share and Open file, the versions and a collapsed Details', async () => {
    const f = await fixture();
    const html = view(f);
    expect(html).toContain('Act of 2026, corrected');
    expect(html).toContain('vsum--good');
    expect(html).toContain('>Checked, first visit<');
    expect(html).toContain('vsum--compact');
    expect(html).toContain('Share');
    expect(html).toContain('Open file');
    expect(html).toContain('Versions');
    expect(html).toContain('Version 2, Priya');
    expect(html).toContain('Version 1, Priya');
    expect(html).toContain('Latest');
    expect(html).toMatch(/<details class="doc-details"(?![^>]*\sopen)/);
    expect(html).toContain('Download verification bundle');
    expect(html).toContain('Print certificate');
    expect(html).toContain('Document verification report');
    // the verdict comes before the buttons, the buttons before the versions
    expect(html.indexOf('>Checked, first visit<')).toBeLessThan(html.indexOf('doc-actions'));
    expect(html.indexOf('doc-actions')).toBeLessThan(html.indexOf('Versions'));
    plainText(html);
  });

  it('a visitor sees no Manage button and no owner tools', async () => {
    const f = await fixture();
    const html = view(f);
    expect(html).not.toContain('Manage');
    expect(html).not.toContain('Withdraw');
  });

  it('the verified owner sees Manage', async () => {
    const f = await fixture();
    const access = ownerAccess({ identity: { keyId: f.owner.keyId }, bundle: f.bundle, verification: f.verification });
    expect(access.allowed).toBe(true);
    const html = view(f, { access });
    expect(html).toContain('Manage');
  });

  it('someone else who is signed in sees no Manage', async () => {
    const f = await fixture();
    const other = await createIdentity('Other');
    const access = ownerAccess({ identity: { keyId: other.keyId }, bundle: f.bundle, verification: f.verification });
    expect(view(f, { access })).not.toContain('Manage');
  });

  it('a withdrawn file says so, shows the reason and offers no Open button', async () => {
    const f = await fixture([{ label: 'Act of 2026' }, { revoke: true, reason: 'Issued by mistake' }]);
    const html = view(f);
    expect(html).toContain('Withdrawn');
    expect(html).toContain('Reason given by the owner');
    expect(html).toContain('Issued by mistake');
    expect(html).not.toContain('Open file');
    expect(html).toContain('nothing to open');
    expect(html).not.toContain('Manage');
    expect(html).toContain('Share');
  });

  it('a file that did not pass is never green and says not to trust it', async () => {
    const f = await fixture();
    const bad = { ...f.verification, ok: false, checks: [{ id: 'record_signatures', ok: false, detail: 'bad' }] };
    const html = view(f, { result: { bundle: f.bundle, verification: bad, blobCheck: { ok: true }, plaintextCheck: null, file: null } });
    expect(html).toContain('Do not trust this file.');
    expect(html).toContain('vsum--bad');
    expect(html).not.toContain('vsum--good');
  });

  it('a changed server key is a loud warning', async () => {
    const f = await fixture();
    const html = view(f, { trust: 'remembered-mismatch' });
    expect(html).toContain('identity changed since your last visit');
    expect(html).not.toContain('vsum--good');
  });

  it('an answer older than one this browser saw gets its own warning', async () => {
    const f = await fixture();
    const verification = { ...f.verification, rollback: true };
    const html = view(f, { result: { bundle: f.bundle, verification, blobCheck: { ok: true }, plaintextCheck: null, file: null } });
    expect(html).toContain('Older than expected');
    expect(html).toContain('older than one this browser saw earlier');
  });

  it('shows the one line password prompt when asked, and the reason when the password was wrong', async () => {
    const f = await fixture();
    const asked = view(f, { showAsk: true });
    expect(asked).toContain('Enter the file password or paste the full link');
    expect(asked).toContain('type="password"');
    const result = { bundle: f.bundle, verification: f.verification, blobCheck: { ok: true }, plaintextCheck: { ok: false, detail: 'x' }, file: null, fingerprint: null };
    const wrong = view(f, { result, plan: openPlan({ result }), showAsk: true });
    expect(wrong).toContain('That password did not work');
    expect(wrong).toContain('role="alert"');
  });

  it('an unlocked file shows a plain Open file, an unverified one does not', async () => {
    const f = await fixture();
    const file = { name: 'act.pdf', data: new Uint8Array(3) };
    const result = { bundle: f.bundle, verification: f.verification, blobCheck: { ok: true }, plaintextCheck: { ok: true }, file, fingerprint: 'ab'.repeat(32) };
    const ok = view(f, { result });
    expect(ok).toContain('Open file');
    expect(ok).not.toContain('not verified');
    const bad = { ...f.verification, ok: false };
    const unverified = view(f, { result: { ...result, verification: bad } });
    expect(unverified).toContain('Open anyway, not verified');
    expect(unverified).toContain('Not verified');
  });

  it('never prints the password or the link of the file', async () => {
    const f = await fixture();
    const html = view(f);
    expect(html).not.toContain('#k=');
    expect(html).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
  });

  it('is valid markup', async () => {
    const f = await fixture();
    expect(lint(view(f), { fragment: true })).toEqual([]);
  });

  it('starts in a loading state for a valid id and rejects an invalid id', () => {
    const at = (path) => page(h(Routes, null, h(Route, { path: '/d/:docId', element: h(DocumentPage) })), 'out', path);
    const loading = at('/d/' + 'a'.repeat(32));
    expect(loading).toContain('Checking the document');
    expect(loading).toContain('aria-busy="true"');
    const bad = at('/d/not-an-id');
    expect(bad).toContain('Not a document id');
    expect(bad).toContain('href="/verify"');
    expect(bad).not.toContain('Try again');
    plainText(loading);
    plainText(bad);
  });
});

describe('versions, password prompt and the Manage sheet', () => {
  it('lists the versions with a Latest mark', async () => {
    const owner = await createIdentity('Priya');
    const serverKey = await createServerKey();
    const parts = await buildBundleParts({ owner, serverKey, versions: [{ label: 'one' }, { label: 'two' }] });
    const html = render(h(VersionList, { rows: versionRows(parts.bundle) }));
    expect(html).toContain('aria-label="Versions"');
    expect(html.indexOf('Version 2')).toBeLessThan(html.indexOf('Version 1'));
    expect((html.match(/Latest/g) || []).length).toBe(1);
    expect(html).toContain('Priya');
  });

  it('says so when there are no versions', () => {
    expect(render(h(VersionList, { rows: [] }))).toContain('no versions');
    expect(render(h(VersionList, { rows: null }))).toContain('no versions');
  });

  it('the password prompt is one labelled line and shows an error as an alert', () => {
    const html = render(h(PasswordLine, { onSubmit() {}, error: 'That password did not work.' }));
    expect(html).toContain('File password');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    expect(lint(html, { fragment: true })).toEqual([]);
  });

  it('the Manage sheet opens on a menu with Update file, Withdraw file and Details', () => {
    const html = page(
      h(ManageSheet, {
        open: true,
        onClose() {},
        docId: ID,
        head: { version: 2, recordHash: 'ab'.repeat(32) },
        identity: IDENTITY,
        password: PW,
        previousLabel: 'Act',
        onUpdated() {},
        onWithdrawn() {},
        onDetails() {}
      }),
      'easy',
      '/d/' + ID
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Manage this file');
    expect(html).toContain('Update file');
    expect(html).toContain('Withdraw file');
    expect(html).toContain('Details');
    expect(html).not.toContain(PW);
    plainText(html);
    expect(lint(html, { fragment: true })).toEqual([]);
  });
});
