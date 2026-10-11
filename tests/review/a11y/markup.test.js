// Markup review: every page and the main components are rendered to HTML on the server side
// (no browser) and checked for landmarks, headings, names, labels, ids, lists and valid aria.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { all, lint, parseHtml, textOf } from './html.js';
import { read } from './helpers.js';

const ctx = vi.hoisted(() => ({ value: null }));

vi.mock('../../../src/lib/identity.jsx', () => ({
  useIdentity: () => ctx.value,
  IdentityProvider: ({ children }) => children
}));

const NOOP_ASYNC = () => Promise.resolve();
const base = {
  status: 'loading',
  identity: null,
  registration: 'unknown',
  registrationError: '',
  error: '',
  create: NOOP_ASYNC,
  restore: NOOP_ASYNC,
  forget: NOOP_ASYNC,
  register: NOOP_ASYNC,
  exportBackup: NOOP_ASYNC
};
const KEY = 'ab'.repeat(32);
const ready = {
  ...base,
  status: 'ready',
  registration: 'registered',
  identity: { keyId: KEY, displayName: 'Registry Office', createdAt: 1760000000000, sign: NOOP_ASYNC, record: {}, signature: '' }
};

const { default: App } = await import('../../../src/App.jsx');
const { default: Layout } = await import('../../../src/components/Layout.jsx');
const { default: Callout } = await import('../../../src/components/Callout.jsx');
const { default: Field } = await import('../../../src/components/Field.jsx');
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

function page(path, identity = base) {
  ctx.value = identity;
  return renderToString(h(MemoryRouter, { initialEntries: [path] }, h(App)));
}

const DOC_ID = 'c'.repeat(32);
const PAGES = [
  ['/', base],
  ['/', { ...base, status: 'none' }],
  ['/', ready],
  ['/keys', { ...base, status: 'none' }],
  ['/keys', ready],
  ['/verify', base],
  ['/chat', { ...base, status: 'none' }],
  ['/chat', ready],
  ['/chat/town-hall', ready],
  ['/chat/NOT VALID', base],
  ['/about', base],
  ['/nowhere', base],
  ['/d/not-an-id', base],
  [`/d/${DOC_ID}`, base]
];

describe('every page: structure, names and aria', () => {
  for (const [path, identity] of PAGES) {
    it(`${path} (${identity.status}) has no markup problems`, () => {
      const html = page(path, identity);
      expect(lint(html, { allowMissingMain: false })).toEqual([]);
    });
  }

  it('every page has exactly one visible h1 inside main', () => {
    for (const [path, identity] of PAGES) {
      const root = parseHtml(page(path, identity));
      const main = all(root, (e) => e.tag === 'main')[0];
      expect(main, path).toBeTruthy();
      const h1 = all(main, (e) => e.tag === 'h1');
      expect(h1.length, `${path} h1 count`).toBe(1);
    }
  });

  it('the shell has a skip link first, a header with a named nav, main, and a footer', () => {
    const root = parseHtml(page('/about'));
    const shell = all(root, (e) => e.attrs.class === 'ui-shell')[0];
    const first = shell.children.find((c) => typeof c !== 'string');
    expect(first.tag).toBe('a');
    expect(first.attrs.href).toBe('#main');
    expect(all(root, (e) => e.tag === 'header' && e.attrs.class === 'ui-header').length).toBe(1);
    expect(all(root, (e) => e.tag === 'nav')[0].attrs['aria-label']).toBe('Main');
    expect(all(root, (e) => e.tag === 'main' && e.attrs.id === 'main').length).toBe(1);
    expect(all(root, (e) => e.tag === 'footer').length).toBe(1);
  });

  it('the main navigation marks the current page', () => {
    const root = parseHtml(page('/verify'));
    const current = all(root, (e) => e.tag === 'a' && e.attrs['aria-current'] === 'page');
    expect(current.map((a) => textOf(a))).toEqual(['Verify']);
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
    expect(ok).toContain('Signature verified');
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

  it('the menu button names its action and says what it controls', () => {
    const root = parseHtml(page('/'));
    const btn = all(root, (e) => e.tag === 'button' && (e.attrs.class || '').includes('ui-nav__toggle'))[0];
    expect(btn.attrs['aria-expanded']).toBe('false');
    expect(btn.attrs['aria-controls']).toBe('main-menu');
    expect(textOf(btn)).toBe('Open menu');
  });

  it('Layout renders children inside main', () => {
    ctx.value = base;
    const html = renderToString(h(MemoryRouter, null, h(Layout, null, h('h1', null, 'T'))));
    expect(lint(html, { allowMissingMain: false })).toEqual([]);
  });
});
