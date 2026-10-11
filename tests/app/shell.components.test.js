import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import App from '../../src/App.jsx';
import Button from '../../src/components/Button.jsx';
import Callout from '../../src/components/Callout.jsx';
import CopyButton from '../../src/components/CopyButton.jsx';
import EmptyState from '../../src/components/EmptyState.jsx';
import ErrorBoundary from '../../src/components/ErrorBoundary.jsx';
import Field from '../../src/components/Field.jsx';
import HashText from '../../src/components/HashText.jsx';
import KeyBadge from '../../src/components/KeyBadge.jsx';
import Layout from '../../src/components/Layout.jsx';
import Nav from '../../src/components/Nav.jsx';
import PageHeader from '../../src/components/PageHeader.jsx';
import Spinner from '../../src/components/Spinner.jsx';
import { ToastProvider, useToast } from '../../src/components/Toast.jsx';
import VerifyResult from '../../src/components/VerifyResult.jsx';
import * as barrel from '../../src/components/index.js';
import { IdentityProvider, useIdentity } from '../../src/lib/identity.jsx';
import { SessionProvider } from '../../src/lib/session.jsx';
import AboutPage from '../../src/pages/AboutPage.jsx';
import AdvancedPage from '../../src/pages/AdvancedPage.jsx';
import NotFound from '../../src/pages/NotFound.jsx';

const inRouter = (node, path = '/') => h(MemoryRouter, { initialEntries: [path] }, node);
const render = (node, path) => renderToString(inRouter(node, path));

// The visible text of every link marked aria-current=page.
function currentLabels(html) {
  const out = [];
  for (const part of html.split('<a ').slice(1)) {
    const tag = part.slice(0, part.indexOf('>'));
    if (!tag.includes('aria-current="page"')) continue;
    const inner = part.slice(part.indexOf('>') + 1, part.indexOf('</a>'));
    out.push(inner.split('<').map((x) => x.slice(x.indexOf('>') + 1)).join('').trim());
  }
  return out;
}

describe('basic components', () => {
  it('renders a Button with variants, type and a loading state', () => {
    const primary = renderToString(h(Button, { variant: 'primary' }, 'Save'));
    expect(primary).toContain('ui-btn--primary');
    expect(primary).toContain('type="button"');
    expect(primary).toContain('Save');

    const loading = renderToString(h(Button, { variant: 'danger', loading: true }, 'Delete'));
    expect(loading).toContain('disabled');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('ui-spinner');
    expect(loading).toContain('Delete');

    expect(renderToString(h(Button, { type: 'submit' }, 'Go'))).toContain('type="submit"');
    expect(renderToString(h(Button, { disabled: true }, 'Go'))).toContain('disabled');
  });

  it('renders Callout tones with a role and a title', () => {
    const bad = renderToString(h(Callout, { tone: 'bad', title: 'Broken' }, 'Details here'));
    expect(bad).toContain('ui-callout--bad');
    expect(bad).toContain('role="alert"');
    expect(bad).toContain('Broken');
    expect(bad).toContain('Details here');
    expect(renderToString(h(Callout, { tone: 'good' }, 'ok'))).toContain('ui-callout--good');
    expect(renderToString(h(Callout, { tone: 'nonsense' }, 'x'))).toContain('ui-callout--info');
  });

  it('ties a Field label to its control with hint and error', () => {
    const html = renderToString(
      h(Field, { label: 'Email', hint: 'We never send mail', error: 'Required' }, h('input', { type: 'text' }))
    );
    const id = /for="([^"]+)"/.exec(html)[1];
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`id="${id}-hint"`);
    expect(html).toContain(`id="${id}-error"`);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(`aria-describedby="${id}-hint ${id}-error"`);
    expect(html).toContain('Email');
  });

  it('keeps a given id and supports a render function', () => {
    const own = renderToString(h(Field, { label: 'Name' }, h('input', { id: 'my-id' })));
    expect(own).toContain('for="my-id"');
    expect(own).not.toContain('aria-invalid');
    const fn = renderToString(h(Field, { label: 'Pick' }, (p) => h('select', p, h('option', null, 'a'))));
    const id = /for="([^"]+)"/.exec(fn)[1];
    expect(fn).toContain(`<select id="${id}"`);
  });

  it('renders Spinner, EmptyState and PageHeader', () => {
    expect(renderToString(h(Spinner))).toContain('Loading');
    expect(renderToString(h(Spinner, { label: null }))).not.toContain('role="status"');
    const empty = renderToString(h(EmptyState, { title: 'Nothing yet' }, 'Add a file'));
    expect(empty).toContain('Nothing yet');
    expect(empty).toContain('Add a file');
    const header = renderToString(h(PageHeader, { title: 'Vault', lead: 'Your files', actions: h('button', null, 'New') }));
    expect(header).toContain('<h1');
    expect(header).toContain('Vault');
    expect(header).toContain('Your files');
    expect(header).toContain('New');
  });

  it('renders HashText short and full', () => {
    const hash = 'ab12'.repeat(16);
    const full = renderToString(h(HashText, { value: hash }));
    expect(full).toContain(hash);
    const short = renderToString(h(HashText, { value: hash, short: true }));
    expect(short).toContain('ab12ab12...');
    expect(short).toContain(`title="${hash}"`);
    expect(renderToString(h(HashText, { value: '' }))).toContain('none');
    expect(renderToString(h(HashText, {}))).toContain('none');
  });

  it('renders KeyBadge with a name and short key id', () => {
    const id = 'f0e1d2c3'.repeat(8);
    const html = renderToString(h(KeyBadge, { keyId: id, name: 'Asha' }));
    expect(html).toContain('Asha');
    expect(html).toContain('f0e1d2c3');
    expect(html).toContain(`Key id ${id}`);
    expect(renderToString(h(KeyBadge, {}))).toContain('unknown signer');
  });

  it('renders CopyButton with a label and accessible name', () => {
    const html = renderToString(h(CopyButton, { text: 'abc', label: 'Copy', describe: 'key id' }));
    expect(html).toContain('Copy');
    expect(html).toContain('aria-label="Copy key id"');
    expect(html).toContain('role="status"');
  });

  it('shows the toast live regions and a safe default for useToast', () => {
    function Probe() {
      const toast = useToast();
      return h('p', null, typeof toast.push);
    }
    expect(renderToString(h(Probe))).toContain('function');
    const html = renderToString(h(ToastProvider, null, h(Probe)));
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-live="assertive"');
  });

  it('ErrorBoundary renders its children when nothing fails', () => {
    expect(renderToString(h(ErrorBoundary, null, h('p', null, 'fine')))).toContain('fine');
  });

  it('exports every component from the barrel file', () => {
    for (const name of [
      'Layout',
      'Nav',
      'SideNav',
      'BottomTabs',
      'ScreenHeader',
      'Sheet',
      'Fab',
      'Avatar',
      'ListItem',
      'OtpInput',
      'Skeleton',
      'ErrorBoundary',
      'Button',
      'CopyButton',
      'Field',
      'Callout',
      'Spinner',
      'EmptyState',
      'PageHeader',
      'KeyBadge',
      'HashText',
      'VerifyResult',
      'ToastProvider',
      'useToast'
    ]) {
      expect(barrel[name], name).toBeTruthy();
    }
  });
});

describe('Nav and Layout', () => {
  it('marks the active tab with aria-current in the side navigation and the bottom tabs', () => {
    const side = render(h(SideNavForTest), '/verify');
    expect(currentLabels(side)).toEqual(['Verify']);
    expect(side).toContain('aria-label="Main menu"');
    for (const label of ['Chats', 'Files', 'Verify', 'Me']) expect(side).toContain(label);
    const tabs = render(h(barrel.BottomTabs), '/files');
    expect(currentLabels(tabs)).toEqual(['Files']);
  });

  it('a file page belongs to the Files tab', () => {
    const doc = render(h(barrel.BottomTabs), '/d/' + 'a'.repeat(32));
    expect(currentLabels(doc)).toEqual(['Files']);
  });

  it('shows who is using the app', () => {
    function Probe() {
      const { status } = useIdentity();
      return h('span', null, status);
    }
    const html = render(h(IdentityProvider, null, h(Probe)));
    expect(html).toContain('loading');
  });

  it('Layout has a skip link, a main landmark and the navigation', () => {
    const html = render(h(SessionProvider, null, h(Layout, null, h('p', null, 'page body'))), '/files');
    expect(html).toContain('href="#main"');
    expect(html).toContain('Skip to content');
    expect(html).toMatch(/<main[^>]*id="main"[^>]*tabindex="-1"/);
    expect(html).toContain('page body');
    expect(html).toContain('ui-sidenav');
    expect(html).toContain('ui-tabbar');
    // the prototype note sits under every page that has the tab bar
    expect(html).toContain('<footer');
    expect(html).toContain('has not been audited or certified');
  });

  it('Layout leaves out the navigation on welcome and sign in, and the tabs inside a chat', () => {
    const welcome = render(h(SessionProvider, null, h(Layout, null, h('p', null, 'x'))), '/welcome');
    expect(welcome).not.toContain('ui-sidenav');
    expect(welcome).not.toContain('ui-tabbar');
    expect(welcome).not.toContain('<footer');
    const room = render(h(SessionProvider, null, h(Layout, null, h('p', null, 'x'))), '/chats/town-hall');
    expect(room).toContain('ui-sidenav');
    expect(room).not.toContain('ui-tabbar');
  });
});

function SideNavForTest() {
  return h(SessionProvider, null, h(barrel.SideNav));
}

describe('routes', () => {
  it('renders every route inside the app', () => {
    const cases = [
      ['/welcome', 'hrdlock'],
      ['/signin', 'Sign in'],
      ['/chats', 'Chats'],
      ['/chats/general-room', 'general-room'],
      ['/files', 'Files'],
      ['/d/' + 'a'.repeat(32), 'Checking the document'],
      ['/verify', 'Verify'],
      ['/me', 'Me'],
      ['/me/advanced', 'Advanced'],
      ['/about', 'How this works'],
      ['/no/such/page', 'Page not found']
    ];
    for (const [path, heading] of cases) {
      const html = render(h(App), path);
      expect(html, path).toContain('<h1');
      expect(html, path).toContain(heading);
      expect(html, path).toContain('ui-shell');
    }
  });

  it('AdvancedPage shows a loading state before the identity is read', () => {
    const html = render(h(IdentityProvider, null, h(AdvancedPage)));
    expect(html).toContain('Loading your identity');
    expect(html).toContain('Advanced');
  });

  it('AboutPage is honest about the limits', () => {
    const html = render(h(AboutPage));
    expect(html).toContain('What this does not prove');
    expect(html).toContain('AES-256-GCM');
    expect(html).toContain('has not been independently reviewed');
    expect(html).toContain('not from a trusted timestamp authority');
    expect(html).toContain('not a certified system');
    expect(html).toContain('hide a newer version');
    // the old wording said the identity is only a key; the new page says a name is only a name
    expect(html).toContain('Nobody has checked who the person behind a name really is');
  });

  it('AboutPage explains accounts and Easy mode without hiding the trade-off', () => {
    const html = render(h(AboutPage));
    expect(html).toContain('Easy mode');
    expect(html).toContain('Strict mode');
    expect(html).toContain('Quick start');
    expect(html).toContain('whoever runs the service holds the means to use your key');
    expect(html).toContain('Chats are public');
  });

  it('NotFound explains itself', () => {
    expect(render(h(NotFound))).toContain('Page not found');
  });
});

describe('VerifyResult', () => {
  const checks = [
    { id: 'identities_match', ok: true, detail: '1 signer identities are self signed' },
    { id: 'chain_links', ok: true, detail: 'versions 1 to 2 link' },
    { id: 'checkpoint', ok: true, detail: 'checkpoint matches' }
  ];
  const head = {
    docId: 'a'.repeat(32),
    version: 2,
    recordHash: 'c'.repeat(64),
    blobHash: 'd'.repeat(64),
    label: 'Land record',
    signer: 'e'.repeat(64),
    signerName: 'Asha',
    createdAt: 1790000000000
  };

  it('shows a good banner, the checks and the warnings', () => {
    const html = renderToString(
      h(VerifyResult, { result: { ok: true, status: 'active', anchored: true, head, checks, warnings: ['Latest means latest as of now.'] } })
    );
    expect(html).toContain('ui-callout--good');
    expect(html).toContain('Land record');
    expect(html).toContain('Asha');
    expect(html).toContain('Version chain');
    expect(html).toContain(': passed');
    expect(html).toContain('Latest means latest as of now.');
    expect(html).toContain('c'.repeat(64));
  });

  it('shows a bad banner and marks failed checks', () => {
    const html = renderToString(
      h(VerifyResult, {
        result: { ok: false, status: 'invalid', head: null, checks: [{ id: 'record_signatures', ok: false, detail: 'record 2: signature does not verify' }], warnings: [] }
      })
    );
    expect(html).toContain('ui-callout--bad');
    expect(html).toContain('Verification failed');
    expect(html).toContain('is-bad');
    expect(html).toContain(': failed');
    expect(html).toContain('record 2: signature does not verify');
  });

  it('shows revoked and unanchored results as warnings, not as plain success', () => {
    const revoked = renderToString(h(VerifyResult, { result: { ok: true, status: 'revoked', anchored: true, head, checks, warnings: [] } }));
    expect(revoked).toContain('ui-callout--warn');
    expect(revoked).toContain('revoked');
    const loose = renderToString(h(VerifyResult, { result: { ok: true, status: 'active', anchored: false, head, checks, warnings: [] } }));
    expect(loose).toContain('ui-callout--warn');
    expect(loose).toContain('not confirmed');
  });

  it('copes with missing or odd results', () => {
    expect(renderToString(h(VerifyResult, { result: null }))).toBe('');
    expect(renderToString(h(VerifyResult, {}))).toBe('');
    const odd = renderToString(h(VerifyResult, { result: { ok: false, checks: 'x', warnings: 5, head: null } }));
    expect(odd).toContain('Verification failed');
    const unknownCheck = renderToString(h(VerifyResult, { result: { ok: true, status: 'active', anchored: true, checks: [{ id: 'some_new_check', ok: true }], warnings: [] } }));
    expect(unknownCheck).toContain('some new check');
  });
});

describe('style rules', () => {
  it('uses no inline style attributes in rendered markup', () => {
    const html = render(h(App), '/about') + render(h(App), '/me/advanced');
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toContain('<script');
  });
});
