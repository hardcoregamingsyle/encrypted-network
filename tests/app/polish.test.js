// The final polish round: the file page decides its trust state once per page view, a double press does
// one thing, an account that already has a name is never asked for one, the code boxes take a pasted code
// from any box, and the small layout and copy fixes. Server rendering and plain code only, no browser.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyDocumentBundle } from '../../shared/verify.js';
import { AuthPromptProvider } from '../../src/components/AuthPrompt.jsx';
import Layout from '../../src/components/Layout.jsx';
import SideNav from '../../src/components/SideNav.jsx';
import VerifySummary, { SERVER_REPORT_LINE } from '../../src/components/VerifySummary.jsx';
import Composer from '../../src/components/chat/Composer.jsx';
import { updateToast } from '../../src/components/doc/pageLogic.js';
import { openLabel } from '../../src/components/doc/pageLogic.js';
import { SessionRow } from '../../src/pages/MePage.jsx';
import { digitsOnly, otpPaste } from '../../src/components/otpLogic.js';
import { ToastProvider } from '../../src/components/Toast.jsx';
import { createBusyGuard } from '../../src/components/useBusyAction.js';
import { NEEDS_KEY_COPY, maskEmail, needsKeyKind } from '../../src/lib/authText.js';
import * as device from '../../src/lib/deviceKey.js';
import { createMemoryAdapter, setStorageAdapter } from '../../src/lib/keystore.js';
import {
  forgetRememberedServerKey,
  getRememberedServerKeyId,
  loadServerTrustOnce,
  resetServerKeyCache,
  resetViewTrust
} from '../../src/lib/pin.js';
import { SessionProvider } from '../../src/lib/session.jsx';
import { createSessionStore } from '../../src/lib/sessionStore.js';
import * as vault from '../../src/lib/vault.js';
import FilesPage from '../../src/pages/FilesPage.jsx';
import SignInPage from '../../src/pages/SignInPage.jsx';
import { buildBundleParts, createIdentity, createServerKey } from '../helpers/bundle.js';
import { CODE, EMAIL, fakeLocalStorage, makeAccountServer } from './_accountFake.js';

const root = join(__dirname, '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage());
  resetServerKeyCache();
  resetViewTrust();
  forgetRememberedServerKey();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('the trust state is decided once per page view', () => {
  const opts = (id) => ({ fetchId: async () => id, now: 1000 });

  it('a double load in one view (double effects, or a load followed by a refresh) is a first visit both times', async () => {
    const first = await loadServerTrustOnce('view-1', opts(KEY_A));
    const second = await loadServerTrustOnce('view-1', opts(KEY_A));
    expect(first.trust).toBe('first-visit');
    expect(second.trust).toBe('first-visit');
    expect(second.pin).toBe(KEY_A);
    // the key was remembered, once, by the first decision
    expect(getRememberedServerKeyId()).toBe(KEY_A);
  });

  it('two loads that overlap decide once', async () => {
    const both = await Promise.all([loadServerTrustOnce('view-2', opts(KEY_A)), loadServerTrustOnce('view-2', opts(KEY_A))]);
    expect(both.map((x) => x.trust)).toEqual(['first-visit', 'first-visit']);
  });

  it('the next page view is a visit to a key this browser remembers', async () => {
    await loadServerTrustOnce('view-1', opts(KEY_A));
    const next = await loadServerTrustOnce('view-2', opts(KEY_A));
    expect(next.trust).toBe('remembered-match');
  });

  it('a different server key inside the same view is still reported', async () => {
    await loadServerTrustOnce('view-1', opts(KEY_A));
    resetServerKeyCache();
    const swapped = await loadServerTrustOnce('view-1', opts(KEY_B));
    expect(swapped.trust).toBe('remembered-mismatch');
  });

  it('a view with no name is never reused', async () => {
    const a = await loadServerTrustOnce('', opts(KEY_A));
    const b = await loadServerTrustOnce('', opts(KEY_A));
    expect(a.trust).toBe('first-visit');
    expect(b.trust).toBe('remembered-match');
  });

  it('the file page uses it with the router location as the view, and a link opened while the session starts loads once', () => {
    const src = read('src/pages/DocumentPage.jsx');
    expect(src).toContain('loadServerTrustOnce(viewRef.current)');
    expect(src).toMatch(/viewRef\.current = location\.key/);
    // the address the page was opened with is already owned by the first load
    expect(src).toMatch(/useRef\(location\.key \+ '\|' \+ location\.hash\)/);
    // a new fragment on the same page (typed in the address bar) is read
    expect(src).toContain("window.addEventListener('hashchange'");
  });
});

// ---------------------------------------------------------------------------

describe('a double press does one thing', () => {
  it('ignores a second press while the first runs, and for the hold time after it', () => {
    vi.useFakeTimers();
    try {
      const changes = [];
      const guard = createBusyGuard(1000, (on) => changes.push(on));
      expect(guard.enter()).toBe(true);
      expect(guard.enter()).toBe(false); // second click while running
      guard.leave();
      expect(guard.enter()).toBe(false); // second click of a double click, the action is already done
      vi.advanceTimersByTime(999);
      expect(guard.enter()).toBe(false);
      vi.advanceTimersByTime(2);
      expect(guard.enter()).toBe(true);
      expect(changes).toEqual([true, false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no hold it opens again as soon as the action ends', () => {
    const guard = createBusyGuard(0);
    expect(guard.enter()).toBe(true);
    guard.leave();
    expect(guard.enter()).toBe(true);
  });

  it('Open file, Share, Download anyway and Copy link all go through the guard', () => {
    expect(read('src/pages/DocumentPage.jsx')).toMatch(/useBusyAction\(openNow/);
    expect(read('src/pages/DocumentPage.jsx')).toMatch(/useBusyAction\(shareNow/);
    expect(read('src/components/doc/UnlockPanel.jsx')).toMatch(/useBusyAction\(/);
    expect(read('src/components/files/AddFileSheet.jsx')).toMatch(/useBusyAction\(copyLinkNow/);
    expect(read('src/components/files/AddFileSheet.jsx')).toMatch(/useBusyAction\(shareNow/);
  });

  it('a pending button stays focusable and says it is busy', () => {
    const src = read('src/components/Button.jsx');
    expect(src).toContain('pending');
    expect(src).toContain('aria-disabled');
  });
});

// ---------------------------------------------------------------------------

const ACCOUNT = { id: 'f'.repeat(32), displayName: 'Priya Nair', emailMasked: 'pr***@example.com', strict: false, createdAt: 1790000000000 };
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
  error: '',
  notice: ''
};

function stubStore(patch) {
  const state = Object.freeze({ ...BASE, ...patch });
  const nope = async () => {
    throw new Error('stub');
  };
  return {
    getState: () => state,
    subscribe: () => () => {},
    init: async () => {},
    refresh: async () => {},
    requestCode: nope,
    verifyCode: nope,
    registerName: nope,
    unlockKey: nope,
    startGuest: nope,
    signOut: nope,
    setStrict: nope,
    deleteAccount: nope,
    dismissNotice: () => {},
    identityFor: () => null
  };
}

function page(node, patch, path = '/files') {
  return renderToString(
    h(MemoryRouter, { initialEntries: [path] }, h(SessionProvider, { store: stubStore(patch) }, h(ToastProvider, null, h(AuthPromptProvider, null, node))))
  );
}

// An Easy account that already has a name and a stored key, on a device with no key, with a session older than 15 minutes.
const OLD_SESSION = {
  status: 'needsKey',
  mode: 'account',
  account: ACCOUNT,
  keys: [{ keyId: KEY_A, hasCloudCopy: true }],
  keyProblem: 'reauth'
};
const NEW_ACCOUNT = { status: 'needsKey', mode: 'account', account: { ...ACCOUNT, displayName: null }, keys: [] };
const KEY_LOST = { status: 'needsKey', mode: 'account', account: ACCOUNT, keys: [{ keyId: KEY_A, hasCloudCopy: true }], keyProblem: true };

describe('an Easy account on a new device with an old session', () => {
  it('is told to confirm it is them, never to choose a name', () => {
    expect(needsKeyKind(OLD_SESSION)).toBe('confirm');
    expect(needsKeyKind(NEW_ACCOUNT)).toBe('name');
    expect(needsKeyKind(KEY_LOST)).toBe('retry');
    // an Easy account that has a name and a stored key is not asked for a name even without the reauth flag
    expect(needsKeyKind({ account: ACCOUNT, keys: [{ keyId: KEY_A, hasCloudCopy: true }], keyProblem: false })).toBe('confirm');
    expect(needsKeyKind(undefined)).toBe('name');
  });

  it('every prompt says "Confirm it is you": Files, the side menu, the top banner and the chat box', () => {
    const surfaces = [
      page(h(FilesPage), OLD_SESSION, '/files'),
      page(h(SideNav), OLD_SESSION, '/files'),
      page(h(Layout, null, h('p', null, 'x')), OLD_SESSION, '/files'),
      page(h(Composer, { identityStatus: 'needsKey' }), OLD_SESSION, '/chats/x')
    ];
    for (const html of surfaces) {
      const t = text(html);
      expect(t).toContain('Confirm it is you');
      expect(t).not.toContain('Choose your name');
      expect(t).not.toContain('Pick the name');
    }
  });

  it('a new account is still asked for a name, on the same surfaces', () => {
    const surfaces = [
      page(h(FilesPage), NEW_ACCOUNT, '/files'),
      page(h(SideNav), NEW_ACCOUNT, '/files'),
      page(h(Layout, null, h('p', null, 'x')), NEW_ACCOUNT, '/files'),
      page(h(Composer, { identityStatus: 'needsKey' }), NEW_ACCOUNT, '/chats/x')
    ];
    for (const html of surfaces) expect(text(html)).toContain('Choose your name');
  });

  it('a key that could not be loaded says so and offers Try again', () => {
    for (const html of [page(h(FilesPage), KEY_LOST, '/files'), page(h(SideNav), KEY_LOST, '/files'), page(h(Layout, null, h('p', null, 'x')), KEY_LOST, '/files')]) {
      const t = text(html);
      expect(t).toContain('Try again');
      expect(t).not.toContain('Choose your name');
    }
  });

  it('the sign in page opens on the confirm step, with no name field', () => {
    const html = page(h(SignInPage), OLD_SESSION, '/signin');
    const t = text(html);
    expect(t).toContain('Confirm it is you');
    expect(t).not.toContain('What should we call you');
    expect(html).not.toContain('autoComplete="nickname"');
    expect(html).not.toContain('autocomplete="nickname"');
    const retry = text(page(h(SignInPage), KEY_LOST, '/signin'));
    expect(retry).toContain('Try again');
    expect(retry).not.toContain('What should we call you');
    expect(text(page(h(SignInPage), NEW_ACCOUNT, '/signin'))).toContain('What should we call you');
  });

  it('the same words are used on every surface', () => {
    expect(NEEDS_KEY_COPY.confirm.action).toBe('Confirm it is you');
    expect(NEEDS_KEY_COPY.name.action).toBe('Choose your name');
  });

  it('with the real store: the account has a name, the state asks for a confirmation, and a code restores the key', async () => {
    vi.stubGlobal('sessionStorage', fakeLocalStorage());
    setStorageAdapter(createMemoryAdapter());
    const server = makeAccountServer();
    const first = createSessionStore({ api: server.api, device, vault });
    await first.init();
    await first.verifyCode(EMAIL, CODE);
    await first.registerName('Priya');
    expect(first.getState().status).toBe('ready');

    setStorageAdapter(createMemoryAdapter()); // a new device: no key yet, the old session cookie still works
    server.fresh = false;
    const store = createSessionStore({ api: server.api, device, vault });
    await store.init();
    const state = store.getState();
    expect(state.status).toBe('needsKey');
    expect(state.account.displayName).toBe('Priya');
    expect(needsKeyKind(state)).toBe('confirm');
    // the screens rendered from this very state do not ask for a name
    const html = page(h(FilesPage), { status: state.status, mode: state.mode, account: state.account, keys: state.keys, keyProblem: state.keyProblem }, '/files');
    expect(text(html)).toContain('Confirm it is you');
    expect(text(html)).not.toContain('Choose your name');

    store.setReauthHandler(async (req) => {
      if (!req.sent) await req.sendCode(req.email || EMAIL);
      await req.verify(req.email || EMAIL, CODE);
      return true;
    });
    await store.unlockKey();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().identity.displayName).toBe('Priya');
    expect(server.keys).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('the code boxes', () => {
  it('a pasted code fills the boxes from the first one, whichever box had focus', () => {
    expect(otpPaste('', 2, '127527').value).toBe('127527');
    expect(otpPaste('12', 2, '12 75-27').value).toBe('127527');
    expect(otpPaste('1', 3, ' 4 5 6 7 8 9').value).toBe('456789');
    expect(otpPaste('123456', 5, '9876543').value).toBe('987654');
  });

  it('one pasted digit is like typing it', () => {
    expect(otpPaste('12', 2, '9').value).toBe('129');
    expect(otpPaste('12', 0, 'x').value).toBe('12');
  });

  it('Enter sends a complete code', () => {
    const src = read('src/components/OtpInput.jsx');
    expect(src).toMatch(/key === 'Enter'/);
    expect(src).toMatch(/otpComplete\(digits, length\)/);
    expect(src).toContain('otpPaste(digits, index, text, length)');
    expect(digitsOnly('12 75-27')).toBe('127527');
  });

  it('the leave and delete confirmation is a form, so Enter confirms; focus stays on the card after signing out other devices', () => {
    const src = read('src/pages/MePage.jsx');
    expect(src).toMatch(/<form\s+className="ui-stack"\s+noValidate\s+onSubmit=\{\(event\) => \{\s+event\.preventDefault\(\);\s+confirm\(\);/);
    expect(src).toContain('focusCard()');
    expect(src).toMatch(/id="me-sessions" tabIndex=\{-1\}/);
  });
});

// ---------------------------------------------------------------------------

describe('a first visit stays honest', () => {
  async function good(first) {
    const owner = await createIdentity('Priya');
    const serverKey = await createServerKey();
    const parts = await buildBundleParts({ owner, serverKey, versions: [{ label: 'Report' }] });
    const verification = await verifyDocumentBundle(parts.bundle, { expectedDocId: parts.docId, pinnedServerKeyId: serverKey.keyId });
    return { result: { bundle: parts.bundle, verification, blobCheck: null, plaintextCheck: null, fingerprint: null }, trust: first ? 'first-visit' : 'remembered-match' };
  }

  it('a green verdict says it reflects what the server reports, compact and full', async () => {
    for (const first of [true, false]) {
      const { result, trust } = await good(first);
      for (const compact of [true, false]) {
        const html = renderToString(h(VerifySummary, { result, trust, compact }));
        expect(html).toContain('vsum--good');
        expect(text(html)).toContain(SERVER_REPORT_LINE);
      }
    }
    expect(SERVER_REPORT_LINE).toMatch(/server reports/);
    expect(SERVER_REPORT_LINE).toMatch(/See Details/);
  });

  it('the line is not shown when the verdict is not green', async () => {
    const { result } = await good(false);
    const mismatch = renderToString(h(VerifySummary, { result, trust: 'remembered-mismatch', compact: true }));
    expect(mismatch).toContain('vsum--bad');
    expect(text(mismatch)).not.toContain(SERVER_REPORT_LINE);
    const none = renderToString(h(VerifySummary, { result: null, trust: 'first-visit' }));
    expect(text(none)).not.toContain(SERVER_REPORT_LINE);
  });

  it('Details explains what a server can keep back', async () => {
    const { result, trust } = await good(true);
    expect(text(renderToString(h(VerifySummary, { result, trust }))).toLowerCase()).toContain('could hide a newer version');
  });

  it('the Open button of a red verdict says it is not verified', async () => {
    const { result } = await good(false);
    const src = read('src/components/doc/FileView.jsx');
    expect(src).toContain("verdictFor(result, trust).tone !== 'bad'");
    expect(openLabel({ verified: false, kind: 'ready' })).toBe('Open anyway, not verified');
    expect(openLabel({ verified: true, kind: 'ready' })).toBe('Open file');
    expect(result).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('layout and small copy fixes', () => {
  const css = (p) => read(p);
  it('the message list is the one scroll area: its hidden helper spans are placed inside it', () => {
    const chat = css('src/styles/chat.css');
    const block = chat.slice(chat.indexOf('.chat-scroll {'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toMatch(/position:\s*relative/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it('full height rules use the dynamic viewport height with a vh fallback', () => {
    for (const [file, selector] of [
      ['src/styles/base.css', 'body {'],
      ['src/styles/base.css', '#root {'],
      ['src/styles/chat.css', '.chat-room {'],
      ['src/styles/nav.css', '.ui-shell {']
    ]) {
      const c = css(file);
      const at = c.indexOf(selector);
      const rule = c.slice(at, c.indexOf('}', at));
      expect(rule, file + ' ' + selector).toMatch(/min-height:\s*100vh;[\s\S]*min-height:\s*100dvh/);
    }
    const nav = css('src/styles/nav.css');
    expect(nav).toMatch(/height:\s*100vh;\s*height:\s*100dvh/);
  });

  it('the masked email is lower case, like the one the service shows', () => {
    expect(maskEmail('QA.Two@Example.COM')).toBe('qa***@example.com');
    expect(maskEmail('priya@example.com')).toBe('pr***@example.com');
  });

  it('this device is shown as in use, not "last used 19 minutes ago"', () => {
    const now = 10 * 60 * 60 * 1000;
    const here = renderToString(h(SessionRow, { session: { id: 'a'.repeat(16), createdAt: now - 3600000, lastSeenAt: now - 19 * 60000, expiresAt: now + 1, current: true }, now, busy: false, onEnd: () => {} }));
    expect(text(here)).toContain('In use now');
    expect(text(here)).not.toContain('Last used');
  });

  it('name fields stop at 40 characters, the limit of a name', () => {
    expect(read('src/pages/SignInPage.jsx')).toMatch(/autoComplete="nickname" maxLength=\{40\}/);
    expect(read('src/components/QuickStartForm.jsx')).toMatch(/autoComplete="nickname" maxLength=\{40\}/);
  });

  it('a long file name is cut to the label limit in the box, not silently later', () => {
    expect(read('src/components/files/AddFileSheet.jsx')).toContain('normalizeLabel(fileName)');
  });

  it('after the account is deleted the welcome page says so', () => {
    expect(read('src/pages/MePage.jsx')).toMatch(/state: \{ notice: isAccount \? 'Your account was deleted/);
    expect(read('src/pages/WelcomePage.jsx')).toContain('location.state.notice');
    const html = renderToString(
      h(MemoryRouter, { initialEntries: [{ pathname: '/welcome', state: { notice: 'Your account was deleted. What you signed stays in the public history.' } }] }, h(SessionProvider, { store: stubStore({}) }, h(WelcomePageLazy)))
    );
    expect(text(html)).toContain('Your account was deleted.');
  });

  it('the update toast names the version, and warns when the password was not saved', () => {
    expect(updateToast({ version: 3, fresh: false, stored: 'kept' })).toEqual({ tone: 'good', text: 'Version 3 is published.' });
    expect(updateToast({ version: 3, fresh: true, stored: 'account' }).text).toContain('new password');
    const warn = updateToast({ version: 2, fresh: true, stored: 'none' });
    expect(warn.tone).toBe('warn');
    expect(warn.text).toContain('copy the link from Share');
    expect(updateToast(null).text).toBe('The new version is published.');
    // the sheet closes and the page is refreshed
    const src = read('src/pages/DocumentPage.jsx');
    expect(src).toMatch(/setManageOpen\(false\);\s+toast\.push\(updateToast\(info\)\);\s+await reload\(clean\);/);
  });
});

import WelcomePageLazy from '../../src/pages/WelcomePage.jsx';
