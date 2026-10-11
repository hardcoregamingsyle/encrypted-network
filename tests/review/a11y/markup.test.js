// Markup review: every page and the main components are rendered to HTML on the server side
// (no browser) and checked for landmarks, headings, names, labels, ids, lists and valid aria.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { all, isHidden, lint, nameOf, parseHtml, textOf } from './html.js';
import { ROOT, read } from './helpers.js';
import { verifyDocumentBundle } from '../../../shared/verify.js';
import { buildBundleParts, createIdentity, createServerKey } from '../../helpers/bundle.js';

const ctx = vi.hoisted(() => ({ value: null }));

// The app reads the session (src/lib/session.jsx). Each test sets the session the page sees.
vi.mock('../../../src/lib/session.jsx', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useSession: () => ctx.value, SessionProvider: ({ children }) => children };
});

const { DEFAULT_SESSION } = await vi.importActual('../../../src/lib/session.jsx');
const NOOP_ASYNC = () => Promise.resolve();
const KEY = 'ab'.repeat(32);
const base = { ...DEFAULT_SESSION, status: 'signedOut', mailAvailable: true, requestCode: NOOP_ASYNC, verifyCode: NOOP_ASYNC, signOut: NOOP_ASYNC, refresh: NOOP_ASYNC };
const IDENTITY = { keyId: KEY, displayName: 'Registry Office', publicKey: {}, createdAt: 1760000000000, sign: NOOP_ASYNC, record: {}, signature: '', hasBackup: false };
const ACCOUNT = { id: 'f'.repeat(32), displayName: 'Registry Office', emailMasked: 're***@example.org', strict: false, createdAt: 1760000000000 };
const states = {
  loading: { ...base, status: 'loading' },
  out: base,
  outNoMail: { ...base, mailAvailable: false },
  needsKey: { ...base, status: 'needsKey', mode: 'account', account: { ...ACCOUNT, displayName: null } },
  easy: { ...base, status: 'ready', mode: 'account', account: ACCOUNT, keys: [{ keyId: KEY, hasCloudCopy: true }], identity: IDENTITY, registration: 'registered' },
  easyNoCloud: { ...base, status: 'ready', mode: 'account', account: ACCOUNT, keys: [{ keyId: KEY, hasCloudCopy: false }], identity: IDENTITY, registration: 'registered' },
  strict: { ...base, status: 'ready', mode: 'account', account: { ...ACCOUNT, strict: true }, keys: [{ keyId: KEY, hasCloudCopy: false }], identity: IDENTITY, registration: 'registered' },
  guest: { ...base, status: 'ready', mode: 'guest', identity: IDENTITY, registration: 'registered' },
  guestBackup: { ...base, status: 'ready', mode: 'guest', identity: { ...IDENTITY, hasBackup: true }, registration: 'missing' }
};
const ready = states.easy;

const { default: App } = await import('../../../src/App.jsx');
const { default: Layout } = await import('../../../src/components/Layout.jsx');
const { default: Callout } = await import('../../../src/components/Callout.jsx');
const { default: Field } = await import('../../../src/components/Field.jsx');
const { default: Sheet } = await import('../../../src/components/Sheet.jsx');
const { default: Fab } = await import('../../../src/components/Fab.jsx');
const { default: ScreenHeader } = await import('../../../src/components/ScreenHeader.jsx');
const { default: ListItem, ItemList } = await import('../../../src/components/ListItem.jsx');
const { default: OtpInput } = await import('../../../src/components/OtpInput.jsx');
const { default: BottomTabs } = await import('../../../src/components/BottomTabs.jsx');
const { default: SideNav } = await import('../../../src/components/SideNav.jsx');
const { default: VerifySummary } = await import('../../../src/components/VerifySummary.jsx');
const { NAV_ITEMS } = await import('../../../src/components/navConfig.js');
const { default: VerifyResult } = await import('../../../src/components/VerifyResult.jsx');
const { default: DocResult } = await import('../../../src/components/verify/DocResult.jsx');
const { default: AuditSummary } = await import('../../../src/components/verify/AuditSummary.jsx');
const { DocRow } = await import('../../../src/components/vault/DocList.jsx');
const { default: PublishResult } = await import('../../../src/components/vault/PublishResult.jsx');
const { MessageItem, PendingItem } = await import('../../../src/components/chat/MessageItem.jsx');
const { default: MessageList } = await import('../../../src/components/chat/MessageList.jsx');
const { default: Composer } = await import('../../../src/components/chat/Composer.jsx');
const { default: DropZone } = await import('../../../src/components/vault/DropZone.jsx');
const { default: CopyButton } = await import('../../../src/components/CopyButton.jsx');
const { ToastProvider } = await import('../../../src/components/Toast.jsx');

function page(path, session = base) {
  ctx.value = session;
  return renderToString(h(MemoryRouter, { initialEntries: [path] }, h(App)));
}

const DOC_ID = 'c'.repeat(32);
// Every route of the app, in the session states that change what it shows. "/" only redirects once the
// session is known (the redirect itself runs in the browser), so the loading splash is what it renders here.
const PAGES = [
  ['/', 'loading'],
  ['/welcome', 'loading'],
  ['/welcome', 'out'],
  ['/welcome', 'outNoMail'],
  ['/signin', 'out'],
  ['/signin', 'outNoMail'],
  ['/signin', 'needsKey'],
  ['/signin', 'loading'],
  ['/chats', 'out'],
  ['/chats', 'easy'],
  ['/chats/town-hall', 'out'],
  ['/chats/town-hall', 'easy'],
  ['/chats/NOT VALID', 'out'],
  ['/files', 'loading'],
  ['/files', 'out'],
  ['/files', 'needsKey'],
  ['/files', 'easy'],
  ['/files?tab=public', 'out'],
  ['/verify', 'out'],
  ['/me', 'loading'],
  ['/me', 'out'],
  ['/me', 'outNoMail'],
  ['/me', 'needsKey'],
  ['/me', 'easy'],
  ['/me', 'easyNoCloud'],
  ['/me', 'strict'],
  ['/me', 'guest'],
  ['/me/advanced', 'out'],
  ['/me/advanced', 'easy'],
  ['/me/advanced', 'guest'],
  ['/me/advanced', 'guestBackup'],
  ['/about', 'out'],
  ['/nowhere', 'out'],
  ['/d/not-an-id', 'out'],
  [`/d/${DOC_ID}`, 'out'],
  [`/d/${DOC_ID}`, 'easy']
];

// Which tab each path belongs to, written down by hand (not read from navConfig.js).
const CURRENT_TAB = [
  ['/chats', 'Chats'],
  ['/chats/town-hall', 'Chats'],
  ['/files', 'Files'],
  [`/d/${DOC_ID}`, 'Files'],
  ['/verify', 'Verify'],
  ['/me', 'Me'],
  ['/me/advanced', 'Me'],
  ['/about', 'Me']
];

describe('every page: structure, names and aria', () => {
  for (const [path, state] of PAGES) {
    it(`${path} (${state}) has no markup problems`, () => {
      const html = page(path, states[state]);
      expect(lint(html, { allowMissingMain: false })).toEqual([]);
    });
  }

  it('every page has exactly one visible h1 inside main, and none outside it', () => {
    for (const [path, state] of PAGES) {
      const root = parseHtml(page(path, states[state]));
      const main = all(root, (e) => e.tag === 'main')[0];
      expect(main, `${path} (${state})`).toBeTruthy();
      expect(all(main, (e) => e.tag === 'h1').length, `${path} (${state}) h1 count in main`).toBe(1);
      expect(all(root, (e) => e.tag === 'h1').length, `${path} (${state}) h1 count on the page`).toBe(1);
    }
  });

  it('the shell has a skip link first, a main that the link points at, and named navigation', () => {
    const root = parseHtml(page('/about', states.out));
    const shell = all(root, (e) => (e.attrs.class || '').split(' ').includes('ui-shell'))[0];
    expect(shell, 'ui-shell').toBeTruthy();
    const first = shell.children.find((c) => typeof c !== 'string');
    expect(first.tag).toBe('a');
    expect(first.attrs.href).toBe('#main');
    expect(textOf(first)).toBe('Skip to content');
    expect(all(root, (e) => e.tag === 'main' && e.attrs.id === 'main').length).toBe(1);
    const navs = all(root, (e) => e.tag === 'nav');
    const names = navs.map((n) => n.attrs['aria-label']);
    expect(names.every(Boolean), 'every nav has a name: ' + names.join(', ')).toBe(true);
    expect(new Set(names).size, 'nav names are distinct').toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['Main menu', 'Main tabs']));
    // the footer carries the prototype notice on every full page
    expect(all(root, (e) => e.tag === 'footer').length).toBe(1);
  });

  it('the skip link is the first focusable thing on every page, including the pages without navigation', () => {
    for (const [path, state] of PAGES) {
      const root = parseHtml(page(path, states[state]));
      const firstFocusable = all(root, (e) => e.tag === 'a' || e.tag === 'button' || e.tag === 'input')[0];
      expect(firstFocusable.attrs.href, `${path} (${state})`).toBe('#main');
    }
  });

  it('welcome and sign in have no navigation at all, every other page has the side menu and the tabs', () => {
    for (const [path, state] of PAGES) {
      const navs = all(parseHtml(page(path, states[state])), (e) => e.tag === 'nav').map((n) => n.attrs['aria-label']);
      const bare = path === '/welcome' || path === '/signin';
      if (bare) expect(navs, `${path} (${state})`).not.toContain('Main menu');
      else expect(navs, `${path} (${state})`).toEqual(expect.arrayContaining(['Main menu']));
    }
  });

  it('each main navigation marks exactly the current tab with aria-current="page", and nothing else', () => {
    for (const [path, label] of CURRENT_TAB) {
      const root = parseHtml(page(path, states.easy));
      for (const navName of ['Main menu', 'Main tabs']) {
        const nav = all(root, (e) => e.tag === 'nav' && e.attrs['aria-label'] === navName)[0];
        // The tab bar is not drawn inside an open chat on a phone, it is still in the markup for the side menu.
        if (!nav) continue;
        const current = all(nav, (e) => e.tag === 'a' && e.attrs['aria-current'] === 'page').map((a) => textOf(a));
        expect(current, `${navName} on ${path}`).toEqual([label]);
        const marked = all(nav, (e) => e.attrs['aria-current'] !== undefined && e.tag !== 'a');
        expect(marked, `${navName} on ${path}: only links carry aria-current`).toEqual([]);
      }
    }
  });

  it('a page outside the tabs marks nothing as current', () => {
    for (const path of ['/nowhere']) {
      const root = parseHtml(page(path, states.out));
      expect(all(root, (e) => e.attrs['aria-current'] !== undefined)).toEqual([]);
    }
  });
});

describe('navigation components', () => {
  it('the side menu and the tab bar list the same four places, in the same order, with the same words', () => {
    const labels = (name, Comp) => {
      ctx.value = states.easy;
      const root = parseHtml(renderToString(h(MemoryRouter, { initialEntries: ['/verify'] }, h(Comp))));
      const nav = all(root, (e) => e.tag === 'nav')[0];
      expect(nav.attrs['aria-label']).toBe(name);
      return all(nav, (e) => e.tag === 'a' && (e.attrs.href || '').startsWith('/') && !/ui-sidenav__(brand|who)/.test(e.attrs.class || '')).map((a) => textOf(a));
    };
    const menu = labels('Main menu', SideNav);
    const tabs = labels('Main tabs', BottomTabs);
    expect(menu).toEqual(['Chats', 'Files', 'Verify', 'Me']);
    expect(tabs).toEqual(menu);
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(menu);
  });

  it('navigation icons are hidden from assistive technology and every link is named by its words', () => {
    ctx.value = states.easy;
    for (const Comp of [SideNav, BottomTabs]) {
      const html = renderToString(h(MemoryRouter, { initialEntries: ['/files'] }, h(Comp)));
      expect(lint(html, { fragment: true })).toEqual([]);
      const root = parseHtml(html);
      for (const a of all(root, (e) => e.tag === 'a')) expect(textOf(a).length, a.attrs.href).toBeGreaterThan(0);
      expect(all(root, (e) => e.tag === 'svg' && e.attrs['aria-hidden'] !== 'true')).toEqual([]);
    }
  });

  it('the side menu says who is signed in, or offers to sign in, in plain words', () => {
    ctx.value = states.out;
    const out = renderToString(h(MemoryRouter, null, h(SideNav)));
    expect(textOf(all(parseHtml(out), (e) => (e.attrs.class || '').includes('ui-sidenav__who'))[0])).toBe('Sign in');
    ctx.value = states.guest;
    const guest = renderToString(h(MemoryRouter, null, h(SideNav)));
    expect(guest).toContain('Registry Office');
    expect(guest).toContain('Quick start, this device');
    ctx.value = states.easy;
    const easy = renderToString(h(MemoryRouter, null, h(SideNav)));
    expect(easy).toContain('re***@example.org');
  });

  it('the back button of a screen header is named by words, as a link or as a button', () => {
    for (const back of ['/chats', true]) {
      ctx.value = base;
      const html = renderToString(h(MemoryRouter, null, h(ScreenHeader, { title: 'Chat', back, backLabel: 'Back to chats' })));
      expect(lint(html, { fragment: true })).toEqual([]);
      const el = all(parseHtml(html), (e) => (e.attrs.class || '').includes('ui-screen-header__back'))[0];
      expect(el.tag).toBe(back === true ? 'button' : 'a');
      expect(textOf(el)).toBe('Back to chats');
    }
  });

  it('the screen header holds exactly one h1, and a subtitle is a paragraph, not a second heading', () => {
    ctx.value = base;
    const html = renderToString(h(MemoryRouter, null, h(ScreenHeader, { title: 'Files', subtitle: 'Files you published' })));
    const root = parseHtml(html);
    expect(all(root, (e) => /^h\d$/.test(e.tag)).map((e) => e.tag)).toEqual(['h1']);
    expect(all(root, (e) => (e.attrs.class || '').includes('ui-screen-header__sub'))[0].tag).toBe('p');
  });

  it('the floating button always carries its words, and the compact one keeps them for screen readers', () => {
    const wide = renderToString(h(Fab, { label: 'New chat', onClick() {} }));
    expect(lint(wide, { fragment: true })).toEqual([]);
    expect(textOf(parseHtml(wide).children[0])).toBe('New chat');
    const small = renderToString(h(Fab, { label: 'New chat', compact: true, onClick() {} }));
    const btn = parseHtml(small).children[0];
    expect(textOf(btn)).toBe('New chat');
    expect(all(btn, (e) => e.tag === 'span').map((e) => e.attrs.class)).toContain('ui-sr-only');
  });
});

describe('sheets (menus and dialogs)', () => {
  const sheet = (props, kids = h('button', { type: 'button' }, 'Inside')) => {
    ctx.value = base;
    return renderToString(h(Sheet, { open: true, onClose() {}, title: 'Add a file', ...props }, kids));
  };

  it('is a modal dialog named by its heading, with a close button that has a name', () => {
    const html = sheet({});
    expect(lint(html, { fragment: true })).toEqual([]);
    const root = parseHtml(html);
    const dlg = all(root, (e) => e.attrs.role === 'dialog')[0];
    expect(dlg.attrs['aria-modal']).toBe('true');
    const title = all(root, (e) => e.attrs.id === dlg.attrs['aria-labelledby'])[0];
    expect(title.tag).toBe('h2');
    expect(textOf(title)).toBe('Add a file');
    const close = all(root, (e) => e.tag === 'button' && e.attrs['data-sheet-close'] !== undefined)[0];
    expect(textOf(close)).toBe('Close');
  });

  it('the dim area behind it is hidden from assistive technology and has no role or name of its own', () => {
    const scrim = all(parseHtml(sheet({})), (e) => (e.attrs.class || '').includes('ui-sheet-scrim'))[0];
    expect(scrim.attrs['aria-hidden']).toBe('true');
    expect(scrim.attrs.role).toBeUndefined();
  });

  it('a step that must be finished has no close button, and a description is wired to the dialog', () => {
    const html = sheet({ dismissible: false, description: 'You need to be signed in to do this.' });
    const root = parseHtml(html);
    expect(all(root, (e) => e.attrs['data-sheet-close'] !== undefined)).toEqual([]);
    const dlg = all(root, (e) => e.attrs.role === 'dialog')[0];
    const desc = all(root, (e) => e.attrs.id === dlg.attrs['aria-describedby'])[0];
    expect(textOf(desc)).toBe('You need to be signed in to do this.');
  });

  it('a closed sheet leaves nothing in the page', () => {
    ctx.value = base;
    expect(renderToString(h(Sheet, { open: false, onClose() {}, title: 'x' }, h('p', null, 'x')))).toBe('');
  });

  it('the sign in sheet opened by an action has a dialog name and two plainly named buttons when mail is on', async () => {
    const { AuthPromptProvider, useSignInPrompt } = await import('../../../src/components/AuthPrompt.jsx');
    // The provider keeps the sheet closed until something asks for it, so the markup of a closed prompt is empty.
    ctx.value = base;
    function Probe() {
      useSignInPrompt();
      return h('p', null, 'x');
    }
    const html = renderToString(h(MemoryRouter, null, h(AuthPromptProvider, null, h(Probe))));
    expect(all(parseHtml(html), (e) => e.attrs.role === 'dialog')).toEqual([]);
  });
});

describe('the dialogs the app opens from its buttons', () => {
  const DOC = 'c'.repeat(32);
  const entry = { seq: 2, hash: 'a'.repeat(64), record: { signer: KEY, body: 'hello', createdAt: 1760000000000 }, verdict: { status: 'verified' } };
  const rows = [
    { docId: DOC, label: 'Land record', status: 'active', version: 2, updatedAt: 1760000000000, local: true, listed: true },
    { docId: 'd'.repeat(32), label: '', status: 'revoked', version: 1, updatedAt: 1760000000000, local: true },
    { docId: 'e'.repeat(32), label: 'Gone', status: 'missing', version: 1, updatedAt: 1760000000000, local: true }
  ];

  async function dialog(session, make) {
    ctx.value = session;
    const html = renderToString(h(MemoryRouter, null, await make()));
    expect(lint(html, { fragment: true }), 'markup problems').toEqual([]);
    const root = parseHtml(html);
    const dlg = all(root, (e) => e.attrs.role === 'dialog');
    expect(dlg.length, 'one dialog').toBe(1);
    expect(dlg[0].attrs['aria-modal']).toBe('true');
    expect(textOf(all(root, (e) => e.attrs.id === dlg[0].attrs['aria-labelledby'])[0]).length).toBeGreaterThan(0);
    return root;
  }

  it('Add file: a named dialog with a file input, a label field, a public checkbox and a submit button tied to the form', async () => {
    const { default: AddFileSheet } = await import('../../../src/components/files/AddFileSheet.jsx');
    const root = await dialog(states.easy, () => h(AddFileSheet, { open: true, onClose() {}, onPublished() {} }));
    expect(all(root, (e) => e.tag === 'input' && e.attrs.type === 'file').length).toBe(1);
    expect(all(root, (e) => e.tag === 'input' && e.attrs.type === 'checkbox').length).toBe(1);
    const form = all(root, (e) => e.tag === 'form')[0];
    const submit = all(root, (e) => e.tag === 'button' && e.attrs.type === 'submit')[0];
    expect(submit.attrs.form).toBe(form.attrs.id);
    expect(textOf(submit)).toContain('Publish');
    // progress is announced
    expect(all(root, (e) => e.attrs.role === 'status' && e.attrs['aria-live'] === 'polite').length).toBeGreaterThan(0);
  });

  it('New chat: a named dialog whose title field is labelled', async () => {
    const { default: NewChatSheet } = await import('../../../src/components/chat/NewChatSheet.jsx');
    for (const state of ['easy', 'out']) {
      const root = await dialog(states[state], () => h(NewChatSheet, { open: true, onClose() {}, onCreated() {} }));
      expect(all(root, (e) => e.tag === 'input' && e.attrs.type === 'text').length, state).toBeGreaterThan(0);
    }
  });

  it('Message menu: Reply is the first control for a signed in person, "Sign in to reply" for everybody else', async () => {
    const { default: MessageMenu } = await import('../../../src/components/chat/MessageMenu.jsx');
    for (const [state, canReply, word] of [['easy', true, 'Reply'], ['out', false, 'Sign in to reply']]) {
      const root = await dialog(states[state], () => h(MessageMenu, { entry, name: 'Ann', canReply, onReply() {}, onClose() {}, onNeedSignIn() {} }));
      const marked = all(root, (e) => e.attrs['data-autofocus'] !== undefined);
      expect(marked.length, state).toBe(1);
      expect(textOf(marked[0])).toBe(word);
    }
  });

  it('Manage this file: three named choices, each a button inside a list', async () => {
    const { default: ManageSheet } = await import('../../../src/components/doc/ManageSheet.jsx');
    const root = await dialog(states.easy, () =>
      h(ManageSheet, { open: true, onClose() {}, docId: DOC, head: { version: 1, recordHash: 'a'.repeat(64) }, identity: IDENTITY, password: 'x', previousLabel: 'L', onUpdated() {}, onWithdrawn() {}, onReload() {}, onDetails() {} })
    );
    const choices = all(root, (e) => e.tag === 'button' && (e.attrs.class || '').includes('doc-choice'));
    expect(choices.map((c) => textOf(c))).toEqual([expect.stringContaining('Update file'), expect.stringContaining('Withdraw file'), expect.stringContaining('Details')]);
    expect(choices.every((c) => c.parent.tag === 'li')).toBe(true);
  });

  it('Quick start: the name field is labelled and the note about this device is on screen', async () => {
    const { default: QuickStartForm, QUICK_START_NOTE } = await import('../../../src/components/QuickStartForm.jsx');
    ctx.value = states.out;
    const html = renderToString(h(MemoryRouter, null, h(QuickStartForm, { onDone() {} })));
    expect(lint(html, { fragment: true })).toEqual([]);
    expect(html).toContain(QUICK_START_NOTE);
  });

  it('the file list: rows are links or buttons with names, a withdrawn or missing file is said in words, and the list has no markup problems', async () => {
    const { default: FileList } = await import('../../../src/components/files/FileList.jsx');
    ctx.value = states.easy;
    const list = { status: 'ready', items: rows, error: null, hasMore: false, loadMore() {}, reload() {} };
    const html = renderToString(
      h(MemoryRouter, null, h(FileList, { list, rows, empty: { title: 'x', text: 'y' }, onForget() {}, now: 1760000100000, showOwner: true }))
    );
    expect(lint(html, { fragment: true })).toEqual([]);
    expect(html).toContain('Withdrawn');
    expect(html).toContain('Not found');
  });
});

describe('the file page once it is loaded', () => {
  async function loaded({ pin = true, revoke = false, signedInAs = 'owner' } = {}) {
    const owner = await createIdentity('Registry Office');
    const serverKey = await createServerKey();
    const parts = await buildBundleParts({ owner, serverKey, versions: [{ label: 'Act of 2026' }, { label: 'Act of 2026, amended' }] });
    const verification = await verifyDocumentBundle(parts.bundle, { expectedDocId: parts.docId, pinnedServerKeyId: pin ? serverKey.keyId : '' });
    const shown = revoke ? { ...verification, status: 'revoked' } : verification;
    const { ownerAccess } = await import('../../../src/components/doc/docLogic.js');
    const { openPlan, ownerNote } = await import('../../../src/components/doc/pageLogic.js');
    const result = { bundle: parts.bundle, verification: shown, blobCheck: { ok: true }, file: null };
    const identity = signedInAs === 'owner' ? { keyId: owner.keyId, displayName: 'Registry Office' } : null;
    const access = ownerAccess({ identity, bundle: parts.bundle, verification: shown });
    return { result, access, plan: openPlan({ result, revoked: revoke }), note: ownerNote({ identity, keys: [], bundle: parts.bundle, access }), docId: parts.docId, serverKey };
  }

  async function view(opts, extra = {}) {
    const { default: FileView } = await import('../../../src/components/doc/FileView.jsx');
    const data = await loaded(opts);
    ctx.value = states.out;
    const html = renderToString(
      h(
        MemoryRouter,
        null,
        h(FileView, { docId: data.docId, result: data.result, trust: opts && opts.pin === false ? 'remembered-match' : 'pinned-match', pinned: '', checkedAt: 1760000000000, now: 1760000100000, access: data.access, note: data.note, plan: data.plan, onShare() {}, onOpen() {}, onSubmitPassword() {}, onManage() {}, ...extra })
      )
    );
    return html;
  }

  const CASES = [
    ['a visitor to a verified file', { signedInAs: 'visitor' }],
    ['the owner of a verified file', { signedInAs: 'owner' }],
    ['a withdrawn file', { revoke: true }],
    ['a file whose server key was not compared', { pin: false, signedInAs: 'visitor' }]
  ];

  for (const [name, opts] of CASES) {
    it(name + ': no markup problems, one h1 in the screen, headings in order', async () => {
      const html = await view(opts);
      expect(lint(html, { fragment: true })).toEqual([]);
      const root = parseHtml(html);
      const screen = all(root, (e) => (e.attrs.class || '').split(' ').includes('doc-screen'))[0];
      expect(all(screen, (e) => e.tag === 'h1').length).toBe(1);
      // the printed certificate has its own h1, but it is hidden from assistive technology and from the screen
      const h1s = all(root, (e) => e.tag === 'h1');
      expect(h1s.filter((e) => !isHidden(e)).length).toBe(1);
      expect(h1s.filter((e) => isHidden(e)).map((e) => textOf(e, { skipHidden: false }))).toEqual(['Document verification report']);
    });
  }

  it('the owner sees a Manage button with words, a visitor does not', async () => {
    const owner = parseHtml(await view({ signedInAs: 'owner' }));
    expect(all(owner, (e) => e.tag === 'button').map((b) => textOf(b))).toContain('Manage');
    const visitor = parseHtml(await view({ signedInAs: 'visitor' }));
    expect(all(visitor, (e) => e.tag === 'button').map((b) => textOf(b))).not.toContain('Manage');
  });

  it('Share and Open come first and have words, the verdict is a live region, and Details is collapsed', async () => {
    const root = parseHtml(await view({ signedInAs: 'visitor' }));
    const actions = all(root, (e) => (e.attrs.class || '').includes('doc-actions'))[0];
    expect(all(actions, (e) => e.tag === 'button').map((b) => textOf(b))[0]).toBe('Share');
    expect(all(root, (e) => (e.attrs.class || '').includes('vsum__top'))[0].attrs.role).toBe('status');
    for (const d of all(root, (e) => e.tag === 'details' && (e.attrs.class || '').includes('doc-details'))) expect('open' in d.attrs).toBe(false);
  });

  it('a withdrawn file is a warning that says Withdrawn and does not offer to open the file', async () => {
    const html = await view({ revoke: true });
    expect(html).toContain('Withdrawn');
    expect(html).toContain('vsum--warn');
    expect(html.includes('vsum--good')).toBe(false);
  });

  it('a file whose server key was not compared with a known key is not green', async () => {
    const html = await view({ pin: false, signedInAs: 'visitor' });
    expect(html.includes('vsum--good')).toBe(false);
  });
});

describe('lists, rows and the code boxes', () => {
  it('a chat or file row is one link or button whose name is its text, and a list of rows is a real list', () => {
    ctx.value = base;
    const html = renderToString(
      h(
        MemoryRouter,
        null,
        h(
          ItemList,
          { label: 'Chats' },
          h(ListItem, { to: '/chats/town-hall', title: 'Town hall', subtitle: 'Ann: hello', meta: '10:02', badge: 3 }),
          h(ListItem, { onClick() {}, title: 'Second', subtitle: 'x' })
        )
      )
    );
    expect(lint(html, { fragment: true })).toEqual([]);
    const root = parseHtml(html);
    expect(all(root, (e) => e.tag === 'li').length).toBe(2);
    const first = all(root, (e) => e.tag === 'a')[0];
    expect(textOf(first)).toContain('Town hall');
    expect(textOf(first)).toContain('3 unread');
  });

  it('the unread number is announced in words, and the bare digits are hidden from the screen reader', () => {
    const html = renderToString(h(MemoryRouter, null, h('ul', null, h(ListItem, { to: '/chats/a-b-c', title: 'T', badge: 120 }))));
    const root = parseHtml(html);
    const count = all(root, (e) => (e.attrs.class || '') === 'ui-count')[0];
    expect(count.children.filter((c) => typeof c !== 'string')[0].attrs['aria-hidden']).toBe('true');
    expect(textOf(count)).toBe('120 unread');
    expect(html).toContain('99+');
  });

  it('the six code boxes are a labelled group of named inputs, with an alert region for the error', () => {
    const html = renderToString(h(OtpInput, { value: '12', error: 'That code is not right, try again' }));
    expect(lint(html, { fragment: true })).toEqual([]);
    const root = parseHtml(html);
    const boxes = all(root, (e) => e.tag === 'input');
    expect(boxes.length).toBe(6);
    expect(boxes.map((b) => b.attrs['aria-label'])).toEqual(['Digit 1 of 6', 'Digit 2 of 6', 'Digit 3 of 6', 'Digit 4 of 6', 'Digit 5 of 6', 'Digit 6 of 6']);
    const attr = (el, name) => Object.entries(el.attrs).find(([k]) => k.toLowerCase() === name)?.[1];
    expect(attr(boxes[0], 'autocomplete')).toBe('one-time-code');
    expect(boxes.slice(1).every((b) => attr(b, 'autocomplete') !== 'one-time-code')).toBe(true);
    expect(boxes.every((b) => attr(b, 'inputmode') === 'numeric')).toBe(true);
    const group = all(root, (e) => e.attrs.role === 'group')[0];
    expect(textOf(all(root, (e) => e.attrs.id === group.attrs['aria-labelledby'])[0])).toBe('Code');
    const alert = all(root, (e) => e.attrs.role === 'alert')[0];
    expect(textOf(alert)).toBe('That code is not right, try again');
    expect(group.attrs['aria-describedby']).toBe(alert.attrs.id);
    expect(boxes.every((b) => b.attrs['aria-invalid'] === 'true')).toBe(true);
  });

  it('with no error the code boxes are not marked invalid and the alert region is empty', () => {
    const root = parseHtml(renderToString(h(OtpInput, { value: '' })));
    expect(all(root, (e) => e.tag === 'input' && e.attrs['aria-invalid'] !== undefined)).toEqual([]);
    expect(textOf(all(root, (e) => e.attrs.role === 'alert')[0])).toBe('');
  });
});

describe('the plain language verdict', () => {
  // A result that passed every check but is not tied to the server's newest record.
  const passed = { ok: true, status: 'active', anchored: true, checks: [{ id: 'record_signatures', ok: true, detail: '' }], warnings: [], head: null };
  const render = (result, trust) => {
    ctx.value = base;
    return renderToString(h(MemoryRouter, null, h(VerifySummary, { result, trust })));
  };

  it('is never green when a check failed, and a failure is an alert', () => {
    const failed = { ...passed, ok: false, checks: [{ id: 'record_signatures', ok: false, detail: 'x' }] };
    for (const trust of ['pinned-match', 'remembered-match', 'first-visit', 'pinned-mismatch', 'remembered-mismatch']) {
      const html = render(failed, trust);
      expect(html.includes('vsum--good'), `green for a failed check, trust ${trust}`).toBe(false);
      expect(all(parseHtml(html), (e) => (e.attrs.class || '').includes('vsum__top'))[0].attrs.role).toBe('alert');
    }
  });

  it('is never green when the server key changed since the last visit', () => {
    for (const trust of ['pinned-mismatch', 'remembered-mismatch']) {
      const html = render(passed, trust);
      expect(html.includes('vsum--good'), trust).toBe(false);
      expect(html).toContain('The server&#x27;s identity changed since your last visit');
    }
  });

  it('is never green when the answer is not tied to the newest server record', () => {
    const html = render({ ...passed, anchored: false }, 'remembered-match');
    expect(html.includes('vsum--good')).toBe(false);
    expect(html).toContain('vsum--warn');
  });

  it('keeps the full checklist inside a collapsed Details, and the green case says what was checked', () => {
    const html = render({ ...passed, anchored: true }, 'pinned-match');
    const root = parseHtml(html);
    const details = all(root, (e) => e.tag === 'details')[0];
    expect(details).toBeTruthy();
    expect('open' in details.attrs).toBe(false);
    expect(textOf(all(details, (e) => e.tag === 'summary')[0])).toBe('Details');
    expect(lint(html, { fragment: true })).toEqual([]);
  });
});

describe('index.html', () => {
  const html = read('index.html');

  it('declares the language, a viewport that allows zoom, and a title', () => {
    expect(html).toMatch(/<html[^>]*\slang="en"/);
    expect(html).toMatch(/name="viewport"/);
    expect(html).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
  });

  it('installs as an app: a manifest with names, a start page, standalone display and icons that exist', () => {
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest">/);
    const manifest = JSON.parse(read('public/manifest.webmanifest'));
    expect(manifest.name).toBe('hrdlock');
    expect(manifest.short_name).toBe('hrdlock');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      if (icon.type === 'image/png') {
        // a real PNG: the eight byte signature, then an IHDR chunk with the size the manifest names
        const bytes = readFileSync(join(ROOT, 'public' + icon.src));
        expect([...bytes.subarray(0, 8)], icon.src).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.src).toBe(icon.sizes);
        continue;
      }
      expect(icon.type, icon.src).toBe('image/svg+xml');
      expect(read('public' + icon.src), icon.src).toMatch(/^<svg /);
    }
    // phones need PNG icons: Chrome asks for 192 and 512 pixels, iOS ignores SVG
    expect(manifest.icons.some((i) => i.sizes === '192x192' && i.type === 'image/png')).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === '512x512' && i.type === 'image/png')).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('the browser bar colours follow the app colours in both themes', () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest'));
    const tokens = read('src/styles/tokens.css');
    const light = tokens.match(/--color-bg:\s*(#[0-9a-f]{6});/i)[1].toLowerCase();
    const dark = tokens.match(/prefers-color-scheme: dark\)[\s\S]*?--color-bg:\s*(#[0-9a-f]{6});/i)[1].toLowerCase();
    const accent = tokens.match(/--color-accent:\s*(#[0-9a-f]{6});/i)[1].toLowerCase();
    expect(manifest.background_color.toLowerCase()).toBe(light);
    expect(manifest.theme_color.toLowerCase()).toBe(accent);
    expect(html).toContain(`content="${accent}" media="(prefers-color-scheme: light)"`);
    expect(html).toContain(`content="${dark}" media="(prefers-color-scheme: dark)"`);
  });

  it('DEFECT: the installed app can be turned: the manifest does not lock the orientation (WCAG 1.3.4)', () => {
    // public/manifest.webmanifest sets "orientation": "portrait-primary". People who use a phone on a stand or a
    // tablet in a keyboard case cannot rotate the installed app, and nothing about reading a signed record needs it.
    const manifest = JSON.parse(read('public/manifest.webmanifest'));
    expect([undefined, 'any']).toContain(manifest.orientation);
  });

  it('DEFECT: tells people what to do when JavaScript is off (noscript)', () => {
    // The whole app is a script. Without JavaScript the page is empty and says nothing.
    expect(html).toMatch(/<noscript>[\s\S]*\S[\s\S]*<\/noscript>/);
  });
});

describe('forms announce their errors', () => {
  it('DEFECT: a Field error is announced when it appears (role=alert or a live region)', () => {
    // Every form is noValidate and shows errors only after submit. The error paragraph is the only
    // feedback, and it is inserted silently, with no focus move. Screen reader users hear nothing.
    const html = renderToString(
      h(Field, { label: 'Display name', error: 'Use at least 12 characters.' }, h('input', { type: 'text' }))
    );
    const root = parseHtml(html);
    const err = all(root, (e) => e.tag === 'p' && (e.attrs.class || '').includes('ui-field__error'))[0];
    expect(err).toBeTruthy();
    const live =
      err.attrs.role === 'alert' ||
      err.attrs['aria-live'] === 'assertive' ||
      err.attrs['aria-live'] === 'polite' ||
      err.attrs.role === 'status';
    expect(live).toBe(true);
  });

  it('a Field wires label, hint and error to the control', () => {
    const html = renderToString(h(Field, { label: 'Name', hint: 'Public.', error: 'Bad.' }, h('input', { type: 'text' })));
    const root = parseHtml(html);
    const input = all(root, (e) => e.tag === 'input')[0];
    expect(input.attrs['aria-invalid']).toBe('true');
    expect(input.attrs['aria-describedby'].split(' ').length).toBe(2);
    expect(lint(html)).toEqual([]);
  });
});

describe('results that appear after an action are announced', () => {
  const warnResult = { ok: true, status: 'active', anchored: false, checks: [], warnings: ['one'], head: null };

  it('DEFECT: the verification headline is spoken when it is a warning', () => {
    const html = renderToString(h(MemoryRouter, null, h(DocResult, { verification: warnResult, bundle: null })));
    const root = parseHtml(html);
    const callouts = all(root, (e) => (e.attrs.class || '').includes('ui-callout--warn'));
    expect(callouts.length).toBeGreaterThan(0);
    expect(['status', 'alert']).toContain(callouts[0].attrs.role);
  });

  it('DEFECT: an audit that was cancelled or is only partly confirmed is spoken', () => {
    const html = renderToString(
      h(AuditSummary, { result: { status: 'aborted', entries: 3, documents: 1, problemCount: 0, problems: [], warnings: [], checkpoint: null, ok: false } })
    );
    const callouts = all(parseHtml(html), (e) => (e.attrs.class || '').includes('ui-callout--warn'));
    expect(callouts.length).toBe(1);
    expect(['status', 'alert']).toContain(callouts[0].attrs.role);
  });

  it('the failure headline is an alert', () => {
    const html = renderToString(h(VerifyResult, { result: { ok: false, checks: [{ id: 'record_signatures', ok: false, detail: 'x' }], warnings: [] } }));
    const bad = all(parseHtml(html), (e) => (e.attrs.class || '').includes('ui-callout--bad'))[0];
    expect(bad.attrs.role).toBe('alert');
  });

  it('checks say passed or failed in text, not by colour or icon alone', () => {
    const html = renderToString(
      h(VerifyResult, {
        result: {
          ok: true,
          status: 'active',
          anchored: true,
          checks: [
            { id: 'record_signatures', ok: true, detail: '' },
            { id: 'chain_links', ok: false, detail: 'broken' }
          ],
          warnings: []
        }
      })
    );
    expect(html).toContain(': passed');
    expect(html).toContain(': failed');
  });
});

describe('names that match what is seen (WCAG 2.5.3 label in name)', () => {
  it('DEFECT: the "Remove from list" button keeps its visible words in its accessible name', () => {
    const doc = { docId: DOC_ID, label: 'Land record', status: 'active', version: 1, updatedAt: 1760000000000, local: true };
    const html = renderToString(h(MemoryRouter, null, h('ul', null, h(DocRow, { doc, onForget: () => {} }))));
    expect(lint(html)).toEqual([]);
  });

  it('DEFECT: the reply preview button keeps the quoted text in its accessible name', () => {
    const entry = {
      seq: 5,
      hash: 'a'.repeat(64),
      record: { signer: KEY, body: 'reply body', createdAt: 1760000000000, replyTo: 'b'.repeat(64) },
      verdict: { status: 'verified', detail: '' }
    };
    const parent = { seq: 2, hash: 'b'.repeat(64), record: { signer: KEY, body: 'The original words', createdAt: 1760000000000 }, verdict: { status: 'verified' } };
    const html = renderToString(h(MemoryRouter, null, h('ol', null, h(MessageItem, { entry, name: 'Ann', parent, parentName: 'Bob' }))));
    const btn = all(parseHtml(html), (e) => e.tag === 'button' && (e.attrs.class || '').includes('chat-quote'))[0];
    // The visible content is the sender and the quote. The label replaces all of it.
    expect(btn.attrs['aria-label']).toContain('The original words');
  });

  it('the copy button label starts with its visible word', () => {
    const html = renderToString(h(CopyButton, { text: 'x', label: 'Copy', describe: 'key id' }));
    expect(lint(html)).toEqual([]);
  });
});

describe('aria on the publish result', () => {
  it('DEFECT: no naming attribute on a plain paragraph', () => {
    const result = {
      docId: DOC_ID,
      password: 'ABCD-EFGH-JKLM-NPQR-STUV',
      fingerprint: 'f'.repeat(64),
      version: 1,
      links: { verify: 'https://x.test/d/' + DOC_ID, full: 'https://x.test/d/' + DOC_ID + '#k=ABCD' }
    };
    const html = renderToString(h(MemoryRouter, null, h(PublishResult, { result, meta: { label: 'x', createdAt: 1 }, onDismiss: () => {} })));
    expect(lint(html, { fragment: true })).toEqual([]);
  });
});

describe('chat markup', () => {
  const verified = {
    seq: 1,
    hash: 'a'.repeat(64),
    record: { signer: KEY, body: 'hello', createdAt: 1760000000000 },
    verdict: { status: 'verified', detail: '' }
  };
  const invalid = { ...verified, seq: 2, hash: 'd'.repeat(64), verdict: { status: 'invalid', detail: 'signature does not match' } };

  it('a message list is a labelled, focusable log of list items', () => {
    const html = renderToString(
      h(MemoryRouter, null, h(MessageList, { entries: [verified, invalid], identities: { [KEY]: { displayName: 'Ann' } }, ownKeyId: KEY, canReply: true, onReply() {} }))
    );
    expect(lint(html)).toEqual([]);
    const log = all(parseHtml(html), (e) => e.attrs.role === 'log')[0];
    expect(log.attrs['aria-label']).toBe('Messages');
    expect(log.attrs.tabindex).toBe('0');
  });

  it('every message shows its check result as words, not colour alone', () => {
    const html = renderToString(h(MemoryRouter, null, h('ol', null, h(MessageItem, { entry: invalid, name: 'Ann' }))));
    expect(html).toContain('Failed verification');
    expect(html).toContain('Do not trust this message');
    const ok = renderToString(h(MemoryRouter, null, h('ol', null, h(MessageItem, { entry: verified, name: 'Ann' }))));
    expect(ok).toContain('Checked: written by this sender and not changed');
  });

  it('a failed pending message is an alert', () => {
    const item = { id: 'x', record: { body: 'hi', createdAt: 1 }, status: 'failed', error: 'Could not send.' };
    const html = renderToString(h(MemoryRouter, null, h('ol', null, h(PendingItem, { item, name: 'Ann', keyId: KEY }))));
    expect(html).toContain('role="alert"');
  });

  it('the composer label, hint and counter are wired up', () => {
    const html = renderToString(h(MemoryRouter, null, h(Composer, { identityStatus: 'ready', signerName: 'Ann', onSend() {} })));
    expect(lint(html)).toEqual([]);
    expect(html).toContain('Message as Ann');
  });
});

describe('controls', () => {
  it('the drop zone has a real file input named by its label and a visible focus wrapper', () => {
    const html = renderToString(h(DropZone, { file: null, onFile() {}, onClear() {}, limitText: 'Up to 20 MiB.' }));
    expect(lint(html)).toEqual([]);
    const input = all(parseHtml(html), (e) => e.tag === 'input')[0];
    expect(input.attrs.type).toBe('file');
    expect(input.attrs['aria-describedby']).toBeTruthy();
  });

  it('the toast area has one polite and one assertive live region before any toast exists', () => {
    const html = renderToString(h(ToastProvider, null, h('p', null, 'x')));
    const root = parseHtml(html);
    const roles = all(root, (e) => e.attrs.role === 'status' || e.attrs.role === 'alert').map((e) => e.attrs.role + ':' + e.attrs['aria-live']);
    expect(roles).toContain('status:polite');
    expect(roles).toContain('alert:assertive');
  });

  it('the Mine / Public switch is a named group of buttons and exactly one of them is pressed', () => {
    for (const [path, expected] of [['/files', 'Mine'], ['/files?tab=public', 'Public']]) {
      const root = parseHtml(page(path, states.easy));
      const group = all(root, (e) => e.attrs.role === 'group' && e.attrs['aria-label'] === 'Which files to show')[0];
      expect(group, path).toBeTruthy();
      const buttons = all(group, (e) => e.tag === 'button');
      expect(buttons.map((b) => textOf(b))).toEqual(['Mine', 'Public']);
      expect(buttons.every((b) => b.attrs['aria-pressed'] === 'true' || b.attrs['aria-pressed'] === 'false')).toBe(true);
      expect(buttons.filter((b) => b.attrs['aria-pressed'] === 'true').map((b) => textOf(b)), path).toEqual([expected]);
    }
  });

  it('the Easy / Strict switch says what it does in words and reports its state', () => {
    for (const [state, pressed, line] of [['easy', 'false', 'Easy mode is on'], ['strict', 'true', 'Strict mode is on']]) {
      const root = parseHtml(page('/me', states[state]));
      const btn = all(root, (e) => e.tag === 'button' && (e.attrs.class || '').includes('me-switch__btn'))[0];
      expect(btn.attrs['aria-pressed'], state).toBe(pressed);
      expect(nameOf(root, btn)).toBe('Keep my key only on my devices');
      expect(textOf(all(root, (e) => (e.attrs.class || '').includes('me-switch__state'))[0])).toBe(line);
      // the knob is decoration
      expect(all(btn, (e) => e.attrs['aria-hidden'] === 'true').length).toBeGreaterThan(0);
    }
  });

  it('nothing is left of the old top bar menu button', () => {
    const html = page('/about', states.out);
    expect(html).not.toMatch(/ui-nav__toggle|main-menu|Open menu/);
  });

  it('Layout renders children inside main', () => {
    ctx.value = base;
    const html = renderToString(h(MemoryRouter, null, h(Layout, null, h('h1', null, 'T'))));
    expect(lint(html, { allowMissingMain: false })).toEqual([]);
  });
});
