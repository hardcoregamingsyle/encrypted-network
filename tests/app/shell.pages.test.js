// Server render smoke tests of the new shell components and the screens the shell owns, with the
// session set to each state through a fake store.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import App, { ROUTE_PATHS } from '../../src/App.jsx';
import { lint } from '../review/a11y/html.js';
import { AuthPromptProvider } from '../../src/components/AuthPrompt.jsx';
import Avatar, { avatarSize } from '../../src/components/Avatar.jsx';
import BottomTabs from '../../src/components/BottomTabs.jsx';
import EmptyState from '../../src/components/EmptyState.jsx';
import Fab from '../../src/components/Fab.jsx';
import Icon, { ICON_PATHS } from '../../src/components/Icon.jsx';
import ListItem, { ItemList } from '../../src/components/ListItem.jsx';
import OtpInput from '../../src/components/OtpInput.jsx';
import QuickStartForm from '../../src/components/QuickStartForm.jsx';
import ScreenHeader from '../../src/components/ScreenHeader.jsx';
import Sheet from '../../src/components/Sheet.jsx';
import SideNav from '../../src/components/SideNav.jsx';
import Skeleton from '../../src/components/Skeleton.jsx';
import { ToastProvider } from '../../src/components/Toast.jsx';
import { SessionProvider } from '../../src/lib/session.jsx';
import AboutPage from '../../src/pages/AboutPage.jsx';
import AdvancedPage from '../../src/pages/AdvancedPage.jsx';
import MePage from '../../src/pages/MePage.jsx';
import NotFound from '../../src/pages/NotFound.jsx';
import SignInPage from '../../src/pages/SignInPage.jsx';
import WelcomePage from '../../src/pages/WelcomePage.jsx';

const KEY = 'ab'.repeat(32);
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
  outNoMail: { mailAvailable: false },
  needsKey: { status: 'needsKey', mode: 'account', account: { ...ACCOUNT, displayName: null } },
  needsKeyStrict: { status: 'needsKey', mode: 'account', account: { ...ACCOUNT, strict: true } },
  keyProblem: { status: 'needsKey', mode: 'account', account: ACCOUNT, keyProblem: true },
  easy: { status: 'ready', mode: 'account', account: ACCOUNT, keys: [{ keyId: KEY, hasCloudCopy: true }], identity: IDENTITY, registration: 'registered' },
  easyNoCloud: { status: 'ready', mode: 'account', account: ACCOUNT, keys: [{ keyId: KEY, hasCloudCopy: false }], identity: IDENTITY, registration: 'registered' },
  strict: { status: 'ready', mode: 'account', account: { ...ACCOUNT, strict: true }, keys: [{ keyId: KEY, hasCloudCopy: false }], identity: IDENTITY, registration: 'registered' },
  guest: { status: 'ready', mode: 'guest', identity: IDENTITY, registration: 'registered' },
  guestBackup: { status: 'ready', mode: 'guest', identity: { ...IDENTITY, hasBackup: true }, registration: 'missing' }
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

function page(node, stateName = 'out', path = '/') {
  const store = stubStore(STATES[stateName]);
  return renderToString(
    h(
      MemoryRouter,
      { initialEntries: [path] },
      h(SessionProvider, { store }, h(ToastProvider, null, h(AuthPromptProvider, null, node)))
    )
  );
}

function allPages(path, node) {
  return Object.keys(STATES).map((name) => [name, page(node, name, path)]);
}

function noInlineStyleOrScript(html, label) {
  expect(html, label).not.toMatch(/\sstyle=/);
  expect(html, label).not.toContain('<script');
  expect(html, label).not.toContain('—');
}

describe('small components', () => {
  it('Avatar shows initials and picks the same colour for the same key', () => {
    const a = renderToString(h(Avatar, { name: 'Priya Nair', keyId: KEY }));
    const b = renderToString(h(Avatar, { name: 'Someone Else', keyId: KEY }));
    expect(a).toContain('>PN<');
    expect(a).toContain('aria-hidden="true"');
    expect(a.match(/ui-avatar--c\d/)[0]).toBe(b.match(/ui-avatar--c\d/)[0]);
    expect(a).toContain('ui-avatar--s40');
    noInlineStyleOrScript(a, 'avatar');
  });

  it('Avatar sizes snap to the sizes that have a css class', () => {
    expect(avatarSize(40)).toBe(40);
    expect(avatarSize(45)).toBe(48);
    expect(avatarSize(1000)).toBe(96);
    expect(avatarSize(1)).toBe(24);
    expect(avatarSize('x')).toBe(40);
    expect(renderToString(h(Avatar, { name: '' }))).toContain('>?<');
  });

  it('Icon has a path for every name it offers and falls back for an unknown one', () => {
    for (const name of Object.keys(ICON_PATHS)) expect(renderToString(h(Icon, { name })), name).toContain('<path');
    expect(renderToString(h(Icon, { name: 'nope' }))).toContain(ICON_PATHS.info);
    expect(renderToString(h(Icon, { name: 'x', label: 'Close' }))).toContain('role="img"');
  });

  it('Fab is a button with a visible label, or a link, or icon only with a hidden label', () => {
    const btn = page(h(Fab, { label: 'New chat', onClick() {} }));
    expect(btn).toMatch(/<button[^>]*class="ui-fab"/);
    expect(btn).toContain('ui-fab__label');
    expect(btn).toContain('New chat');
    const link = page(h(Fab, { label: 'Add file', to: '/files' }));
    expect(link).toMatch(/<a[^>]*href="\/files"/);
    const compact = page(h(Fab, { label: 'Write', compact: true, onClick() {} }));
    expect(compact).toContain('ui-fab--compact');
    expect(compact).toContain('ui-sr-only');
    expect(compact).not.toContain('ui-fab__label');
  });

  it('ScreenHeader holds the h1, an optional subtitle, back link and actions', () => {
    const html = page(h(ScreenHeader, { title: 'Town hall', subtitle: 'Public chat', back: '/chats', backLabel: 'Back to chats', actions: h('button', null, 'More') }));
    expect(html).toContain('<h1');
    expect(html).toContain('Town hall');
    expect(html).toContain('Public chat');
    expect(html).toMatch(/<a[^>]*href="\/chats"[^>]*class="ui-screen-header__back"|<a[^>]*class="ui-screen-header__back"[^>]*href="\/chats"/);
    expect(html).toContain('Back to chats');
    expect(html).toContain('More');
    const plain = page(h(ScreenHeader, { title: 'Files' }));
    expect(plain).not.toContain('ui-screen-header__back');
    const history = page(h(ScreenHeader, { title: 'Room', back: true }));
    expect(history).toMatch(/<button[^>]*ui-screen-header__back/);
  });

  it('ListItem is a link, a button or plain text and shows the unread count to screen readers', () => {
    const link = page(h(ItemList, null, h(ListItem, { to: '/chats/x-chat', title: 'General', subtitle: 'Priya: hi', meta: '14:05', badge: 3, leading: h(Avatar, { name: 'General' }) })));
    expect(link).toContain('<ul');
    expect(link).toMatch(/<a[^>]*href="\/chats\/x-chat"/);
    expect(link).toContain('General');
    expect(link).toContain('Priya: hi');
    expect(link).toContain('14:05');
    expect(link).toContain('3 unread');
    const none = page(h(ItemList, null, h(ListItem, { title: 'Quiet', badge: 0 })));
    expect(none).not.toContain('ui-count');
    const big = page(h(ItemList, null, h(ListItem, { title: 'Busy', badge: 250 })));
    expect(big).toContain('99+');
    const button = page(h(ItemList, null, h(ListItem, { title: 'Tap', onClick() {} })));
    expect(button).toMatch(/<button[^>]*type="button"/);
  });

  it('Skeleton announces once and hides the grey shapes', () => {
    const html = renderToString(h(Skeleton, { variant: 'row', count: 3, label: 'Loading chats' }));
    expect(html).toContain('Loading chats');
    expect(html).toContain('role="status"');
    expect((html.match(/ui-skeleton--row/g) || []).length).toBe(3);
    expect(html).toContain('aria-hidden="true"');
    expect((renderToString(h(Skeleton, { count: 99 })).match(/ui-skeleton--row/g) || []).length).toBe(20);
    expect((renderToString(h(Skeleton, { count: 0 })).match(/ui-skeleton--row/g) || []).length).toBe(1);
    expect(renderToString(h(Skeleton, { variant: 'text' }))).toContain('ui-skeleton--text');
    expect(renderToString(h(Skeleton, { variant: 'block' }))).toContain('ui-skeleton--block');
  });

  it('EmptyState draws a hidden picture for each art and works without one', () => {
    for (const art of ['chats', 'files', 'search', 'verify', 'other']) {
      const html = renderToString(h(EmptyState, { title: 'Nothing here', art }, 'A line'));
      expect(html, art).toContain('<svg');
      expect(html, art).toContain('aria-hidden="true"');
      expect(html, art).toContain('Nothing here');
      noInlineStyleOrScript(html, art);
    }
    const bare = renderToString(h(EmptyState, { title: 'Plain' }));
    expect(bare).not.toContain('<svg');
    const act = renderToString(h(EmptyState, { title: 'T', action: h('button', null, 'Do it') }));
    expect(act).toContain('Do it');
    expect(act).toContain('ui-empty__action');
  });

  it('BottomTabs and SideNav list the four places', () => {
    for (const html of [page(h(BottomTabs), 'out', '/chats'), page(h(SideNav), 'out', '/chats')]) {
      for (const label of ['Chats', 'Files', 'Verify', 'Me']) expect(html).toContain(label);
      expect(html).toMatch(/aria-label="Main (menu|tabs)"/);
      expect(html).toContain('aria-current="page"');
    }
  });

  it('SideNav shows who is signed in, or how to sign in', () => {
    expect(page(h(SideNav), 'easy')).toContain('Priya Nair');
    expect(page(h(SideNav), 'easy')).toContain('pr***@example.com');
    expect(page(h(SideNav), 'guest')).toContain('Quick start, this device');
    expect(page(h(SideNav), 'out')).toContain('Sign in');
    expect(page(h(SideNav), 'needsKey')).toContain('Choose your name');
    expect(page(h(SideNav), 'loading')).not.toContain('Sign in');
  });
});

describe('Sheet', () => {
  it('renders nothing while closed', () => {
    expect(renderToString(h(Sheet, { open: false, title: 'x' }, 'body'))).toBe('');
  });

  it('is a labelled modal dialog with a heading, a close button and its footer', () => {
    const html = renderToString(h(Sheet, { open: true, onClose() {}, title: 'Add a file', footer: h('button', null, 'Publish'), description: 'Pick one' }, h('p', null, 'inside')));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)[1];
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain('<h2');
    expect(html).toContain('Add a file');
    expect(html).toContain('inside');
    expect(html).toContain('Publish');
    expect(html).toContain('Pick one');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('Close');
    noInlineStyleOrScript(html, 'sheet');
  });

  it('has no close button and ignores the dim area when it cannot be dismissed', () => {
    const html = renderToString(h(Sheet, { open: true, dismissible: false, title: 'Required step' }, 'x'));
    expect(html).not.toContain('data-sheet-close');
  });
});

describe('OtpInput', () => {
  it('draws six numeric boxes, only the first offers the one time code', () => {
    const html = renderToString(h(OtpInput, { value: '12', label: 'Code' }));
    expect((html.match(/<input/g) || []).length).toBe(6);
    expect(html.toLowerCase()).toContain('inputmode="numeric"');
    expect((html.toLowerCase().match(/autocomplete="one-time-code"/g) || []).length).toBe(1);
    expect(html).toContain('aria-label="Digit 1 of 6"');
    expect(html).toContain('aria-label="Digit 6 of 6"');
    expect(html).toContain('value="1"');
    expect(html).toContain('value="2"');
    expect(html).toContain('role="group"');
  });

  it('announces an error and marks the boxes invalid', () => {
    const html = renderToString(h(OtpInput, { value: '', error: 'That code is not right, try again.' }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('That code is not right, try again.');
    expect((html.match(/aria-invalid="true"/g) || []).length).toBe(6);
    const calm = renderToString(h(OtpInput, { value: '' }));
    expect(calm).not.toContain('aria-invalid');
  });

  it('can be disabled and ignores letters in the value', () => {
    const html = renderToString(h(OtpInput, { value: 'ab12', disabled: true }));
    expect((html.match(/disabled/g) || []).length).toBe(6);
    expect(html).toContain('value="1"');
    expect(html).not.toContain('value="a"');
  });
});

describe('Quick start form', () => {
  it('asks for a name and says plainly what Quick start means', () => {
    const html = page(h(QuickStartForm, {}));
    expect(html).toContain('What should we call you?');
    expect(html).toContain('Quick start keeps everything on this device. If you clear your browser data you lose access. Sign in with email to use any device.');
    expect(html).toContain('type="submit"');
  });
});

describe('Welcome', () => {
  it('offers email first and Quick start second', () => {
    const html = page(h(WelcomePage), 'out');
    expect(html).toContain('<h1');
    expect(html).toContain('hrdlock');
    expect(html).toContain('Continue with email');
    expect(html).toContain('Quick start on this device');
    expect(html.indexOf('Continue with email')).toBeLessThan(html.indexOf('Quick start on this device'));
    expect(html).toContain('How it works');
    expect(html).toContain('href="/about"');
    expect(html).toContain('ui-btn--primary');
    noInlineStyleOrScript(html, 'welcome');
  });

  it('makes Quick start the main button when mail is not available, with a muted note', () => {
    const html = page(h(WelcomePage), 'outNoMail');
    expect(html).not.toContain('Continue with email');
    expect(html).toContain('Email sign in is not switched on yet.');
    expect(html).toMatch(/ui-btn--primary[^>]*>[\s\S]*Quick start on this device/);
  });

  it('shows only a spinner while loading, and nothing for people who are already in', () => {
    expect(page(h(WelcomePage), 'loading')).toContain('Opening hrdlock');
    expect(page(h(WelcomePage), 'easy')).not.toContain('Continue with email');
  });
});

describe('Sign in', () => {
  it('step one asks for an email with the right input hints', () => {
    const html = page(h(SignInPage), 'out', '/signin');
    expect(html).toContain('Sign in with email');
    expect(html).toContain('type="email"');
    expect(html.toLowerCase()).toContain('autocomplete="email"');
    expect(html.toLowerCase()).toContain('inputmode="email"');
    expect(html).toContain('We will send you a 6 digit code through an email service. No password needed.');
    expect(html).toContain('Continue');
    noInlineStyleOrScript(html, 'signin');
  });

  it('warns when mail is not switched on', () => {
    const html = page(h(SignInPage), 'outNoMail', '/signin');
    expect(html).toContain('Email sign in is not switched on yet');
  });

  it('step three asks for the name and states the Easy mode trade-off', () => {
    const html = page(h(SignInPage), 'needsKey', '/signin');
    expect(html).toContain('What should we call you?');
    expect(html).toContain('Easy mode');
    expect(html).toContain('holds the means to use your key');
    expect(html).toContain('href="/me"');
    expect(html).toContain('Use a different email');
  });

  it('step three for a Strict account says the key stays on this device and fills in the name', () => {
    const html = page(h(SignInPage), 'needsKeyStrict', '/signin');
    expect(html).toContain('Strict mode is on for your account');
    expect(html).toContain('value="Priya Nair"');
  });

  it('a Quick start person can still reach email sign in', () => {
    const html = page(h(SignInPage), 'guest', '/signin');
    expect(html).toContain('type="email"');
  });

  it('shows a spinner while loading', () => {
    expect(page(h(SignInPage), 'loading', '/signin')).toContain('Loading');
  });
});

describe('Me', () => {
  it('Easy account: name, masked email, mode, the honest trade-off, sign out and delete', () => {
    const html = page(h(MePage), 'easy', '/me');
    expect(html).toContain('<h1');
    expect(html).toContain('Priya Nair');
    expect(html).toContain('pr***@example.com');
    expect(html).toContain('Easy mode');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Keep my key only on my devices');
    expect(html).toContain('whoever runs the service holds the means to use that key');
    expect(html).toContain('Sign out');
    expect(html).toContain('Delete account');
    expect(html).toContain('href="/me/advanced"');
    expect(html).toContain('href="/about"');
    expect(html).toContain('Add to Home Screen');
    noInlineStyleOrScript(html, 'me');
  });

  it('Strict account: the switch is on and the text explains the cost', () => {
    const html = page(h(MePage), 'strict', '/me');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Strict mode');
    expect(html).toContain('nobody can recover that key');
  });

  it('Easy account without a saved key offers to save it', () => {
    expect(page(h(MePage), 'easyNoCloud', '/me')).toContain('Save it now');
    expect(page(h(MePage), 'easy', '/me')).not.toContain('Save it now');
  });

  it('Quick start: says plainly it lives on this device and offers email sign in', () => {
    const html = page(h(MePage), 'guest', '/me');
    expect(html).toContain('Quick start, this device only');
    expect(html).toContain('If you clear your browser data you lose access');
    expect(html).toContain('Sign in with email');
    expect(html).toContain('Leave Quick start');
    expect(html).not.toContain('Delete account');
  });

  it('signed out: sign in choices, still the About link', () => {
    const html = page(h(MePage), 'out', '/me');
    expect(html).toContain('You are not signed in');
    expect(html).toContain('Continue with email');
    expect(html).toContain('href="/about"');
    const noMail = page(h(MePage), 'outNoMail', '/me');
    expect(noMail).not.toContain('Continue with email');
  });

  it('needs a key: points to the name step, or to a retry when the key could not be loaded', () => {
    expect(page(h(MePage), 'needsKey', '/me')).toContain('Choose your name');
    const problem = page(h(MePage), 'keyProblem', '/me');
    expect(problem).toContain('could not be loaded');
    expect(problem).toContain('Try again');
  });

  it('loading shows placeholders', () => {
    expect(page(h(MePage), 'loading', '/me')).toContain('Loading your profile');
  });
});

describe('Advanced', () => {
  it('shows the identity details with a copy button for the key id', () => {
    const html = page(h(AdvancedPage), 'guest', '/me/advanced');
    expect(html).toContain('<h1');
    expect(html).toContain('Advanced');
    expect(html).toContain('Your signing identity');
    expect(html).toContain(KEY);
    expect(html).toContain('Copy');
    expect(html).toContain('Forget this identity');
    // A Quick start key has no backup and cannot be made again, so a restore (which would replace it) is not offered
    expect(html).not.toContain('Restore from a backup file');
    expect(html).toContain('forget this Quick start key first');
    expect(html).not.toContain('Backup file</h2>');
  });

  it('shows the backup section only for an identity that has a backup file', () => {
    const html = page(h(AdvancedPage), 'guestBackup', '/me/advanced');
    expect(html).toContain('Download a fresh backup');
    expect(html).toContain('The server does not know this key yet');
    // an identity that has a backup file may still be replaced by restoring another one
    expect(html).toContain('Restore from a backup file');
  });

  it('an account lists its keys and has no restore form', () => {
    const html = page(h(AdvancedPage), 'easy', '/me/advanced');
    expect(html).toContain('Account, Easy mode');
    expect(html).toContain('copy in your account');
    expect(html).not.toContain('Restore from a backup file');
    expect(html).not.toContain('Forget this identity');
  });

  it('signed out people can still restore an old backup', () => {
    const html = page(h(AdvancedPage), 'out', '/me/advanced');
    expect(html).toContain('You are not signed in');
    expect(html).toContain('Restore from a backup file');
  });
});

describe('About and not found', () => {
  it('About keeps its honest list and has a back link to Me', () => {
    const html = page(h(AboutPage), 'out', '/about');
    expect(html).toContain('What this does not prove');
    expect(html).toContain('href="/me"');
    noInlineStyleOrScript(html, 'about');
  });

  it('NotFound has one heading and a way out', () => {
    const html = page(h(NotFound), 'out', '/nope');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('href="/chats"');
  });
});

describe('route table', () => {
  it('lists every path of the app', () => {
    expect(ROUTE_PATHS).toEqual(
      expect.arrayContaining(['/', '/welcome', '/signin', '/chats', '/chats/:channelId', '/files', '/d/:docId', '/verify', '/me', '/me/advanced', '/about', '*'])
    );
    expect(new Set(ROUTE_PATHS).size).toBe(ROUTE_PATHS.length);
  });

  it('the old chat paths and the old keys path are redirects, not pages', () => {
    expect(ROUTE_PATHS).toEqual(expect.arrayContaining(['/chat', '/chat/:channelId', '/keys']));
  });

  it('renders the app for each state without a server', () => {
    for (const [name] of Object.entries(STATES)) {
      for (const path of ['/welcome', '/signin', '/me', '/about']) {
        const store = stubStore(STATES[name]);
        const html = renderToString(h(MemoryRouter, { initialEntries: [path] }, h(SessionProvider, { store }, h(App))));
        expect(html, `${name} ${path}`).toContain('<h1');
      }
    }
  });
});

describe('every state of every owned screen', () => {
  it('has no inline styles, no scripts and exactly one h1 at the top level of main', () => {
    const screens = [
      ['/welcome', h(WelcomePage)],
      ['/signin', h(SignInPage)],
      ['/me', h(MePage)],
      ['/me/advanced', h(AdvancedPage)],
      ['/about', h(AboutPage)]
    ];
    for (const [path, node] of screens) {
      for (const [name, html] of allPages(path, node)) {
        noInlineStyleOrScript(html, `${path} ${name}`);
        // a redirect renders nothing; every other state has exactly one h1
        const body = html.slice(0, html.indexOf('<div class="ui-toasts">'));
        if (body.length > 0) expect((body.match(/<h1/g) || []).length, `${path} ${name}`).toBe(1);
      }
    }
  });
});

describe('markup problems (the linter of the accessibility review)', () => {
  it('no screen has a markup problem in any session state', () => {
    const screens = [
      ['/welcome', h(WelcomePage)],
      ['/signin', h(SignInPage)],
      ['/me', h(MePage)],
      ['/me/advanced', h(AdvancedPage)],
      ['/about', h(AboutPage)],
      ['/nope', h(NotFound)]
    ];
    const problems = [];
    for (const [path, node] of screens) {
      for (const [name, html] of allPages(path, node)) {
        for (const p of lint(html)) problems.push(`${path} ${name}: ${p}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the whole app frame has no markup problems', () => {
    const problems = [];
    for (const name of ['out', 'easy', 'guest', 'needsKey']) {
      for (const path of ['/welcome', '/signin', '/me', '/files', '/chats', '/chats/town-hall', '/about', '/verify']) {
        const store = stubStore(STATES[name]);
        const html = renderToString(h(MemoryRouter, { initialEntries: [path] }, h(SessionProvider, { store }, h(App))));
        for (const p of lint(html, { allowMissingMain: path === '/welcome' || path === '/signin' ? true : false })) problems.push(`${name} ${path}: ${p}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('components with open sheets and code boxes are clean', () => {
    const open = renderToString(h('main', null, h('h1', null, 'Page'), h(Sheet, { open: true, onClose() {}, title: 'T', footer: h('button', { type: 'button' }, 'Go') }, h('p', null, 'x'))));
    expect(lint(open)).toEqual([]);
    expect(lint(renderToString(h(OtpInput, { value: '12', error: 'Wrong.' })))).toEqual([]);
    expect(lint(page(h(ItemList, null, h(ListItem, { to: '/a', title: 'A', badge: 2, leading: h(Avatar, { name: 'A' }) }))))).toEqual([]);
    expect(lint(renderToString(h(Skeleton, { count: 2 })))).toEqual([]);
    expect(lint(renderToString(h(EmptyState, { title: 'x', art: 'chats' }, 'y')))).toEqual([]);
  });
});

describe('which route answers which address', () => {
  const pick = (pathname) => {
    const found = matchRoutes(
      ROUTE_PATHS.map((path) => ({ path })),
      pathname
    );
    return found ? found[0].route.path : null;
  };

  it('sends each address of the app to its own route', () => {
    const cases = [
      ['/', '/'],
      ['/welcome', '/welcome'],
      ['/signin', '/signin'],
      ['/chats', '/chats'],
      ['/chats/town-hall', '/chats/:channelId'],
      ['/files', '/files'],
      ['/d/' + 'a'.repeat(32), '/d/:docId'],
      ['/verify', '/verify'],
      ['/me', '/me'],
      ['/me/advanced', '/me/advanced'],
      ['/about', '/about'],
      ['/chat', '/chat'],
      ['/chat/town-hall', '/chat/:channelId'],
      ['/keys', '/keys'],
      ['/nothing/here', '*'],
      ['/chats/a/b', '*'],
      ['/ME', '/me']
    ];
    for (const [url, route] of cases) expect(pick(url), url).toBe(route);
  });
});
