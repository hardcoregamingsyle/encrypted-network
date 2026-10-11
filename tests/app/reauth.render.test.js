// Smoke tests (server rendering) for the "Confirm it is you" sheet, the "Where you are signed in" section, the
// unfinished Strict callout, the session ended notice and the key step that needs a new code.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AuthPromptProvider } from '../../src/components/AuthPrompt.jsx';
import Layout from '../../src/components/Layout.jsx';
import ReauthSheet, { REAUTH_TITLE } from '../../src/components/ReauthSheet.jsx';
import { actionErrorText } from '../../src/components/actionText.js';
import { ToastProvider } from '../../src/components/Toast.jsx';
import { SessionProvider } from '../../src/lib/session.jsx';
import MePage, { SessionRow, strictProgressText } from '../../src/pages/MePage.jsx';
import SignInPage from '../../src/pages/SignInPage.jsx';
import { ApiError } from '../../src/lib/api.js';
import { ACCOUNT, IDENTITY, KEY, jargonIn, stubStore, visibleText } from '../review/ux/helpers.js';

const noop = () => {};

function page(node, patch = {}, path = '/me', storePatch = {}) {
  const store = { ...stubStore(patch), ...storePatch };
  return renderToString(h(MemoryRouter, { initialEntries: [path] }, h(SessionProvider, { store }, h(ToastProvider, null, h(AuthPromptProvider, null, node)))));
}

const EASY = { status: 'ready', mode: 'account', account: ACCOUNT, keys: [{ keyId: KEY, hasCloudCopy: true }], identity: IDENTITY, registration: 'registered' };

function sheet(request) {
  return renderToString(h(ReauthSheet, { request, onFinish: noop }));
}

const base = { email: '', emailMasked: 'pr***@example.com', sent: false, cooldown: 0, debugCode: '', sendError: null, sendCode: noop, verify: noop };

describe('the Confirm it is you sheet', () => {
  it('with a known address: a dialog with six boxes for the code, a Continue and a Cancel button', () => {
    const html = sheet({ ...base, email: 'priya@example.com', sent: true, cooldown: 30 });
    const text = visibleText(html);
    expect(text).toContain(REAUTH_TITLE);
    expect(text).toContain('pr***@example.com');
    expect(text).toContain('Enter the 6 digit code we sent to');
    expect(text).toMatch(/Continue/);
    expect(text).toMatch(/Cancel/);
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect((html.match(/class="ui-otp__box"/g) || []).length).toBe(6);
    expect(html).toMatch(/autoComplete="one-time-code"|autocomplete="one-time-code"/);
    // the full address is never printed, only its masked form
    expect(html).not.toContain('priya@example.com');
  });

  it('says plainly what happens and that nothing changes before the code is entered', () => {
    const text = visibleText(sheet({ ...base, email: 'priya@example.com', sent: true }));
    expect(text).toMatch(/new 6 digit code to your email/);
    expect(text).toMatch(/Nothing changes until you enter it/);
  });

  it('with no address known: asks for it, shows the masked form as a hint, and sends nothing yet', () => {
    const html = sheet(base);
    const text = visibleText(html);
    expect(text).toContain('The email address of this account');
    expect(text).toContain('It looks like pr***@example.com.');
    expect(text).toContain('Send me a code');
    expect(html).toMatch(/type="email"/);
    expect(html).not.toMatch(/class="ui-otp__box"/);
  });

  it('shows why the code could not be sent, in plain words', () => {
    const err = new ApiError(500, 'mail_failed', 'x');
    const text = visibleText(sheet({ ...base, email: 'priya@example.com', sendError: err }));
    expect(text).toContain("We could not send the email. Try again in a minute.");
  });

  it('a code that was sent a moment ago is a notice (it still works), with the timer for a new one', () => {
    const err = new ApiError(429, 'rate_limited', 'wait', 12);
    const text = visibleText(sheet({ ...base, email: 'priya@example.com', sendError: err }));
    expect(text).toContain('A code was sent a moment ago. Enter it here');
    expect(text).toMatch(/Send a new code in [0-9]+ s/);
    expect(text).not.toContain('Please wait');
  });

  it('too many codes for the hour is still an error, and says so', () => {
    const err = new ApiError(429, 'rate_limited', 'too many sign in codes requested for this email, try again later');
    const text = visibleText(sheet({ ...base, email: 'priya@example.com', sendError: err }));
    expect(text).toContain('Too many tries for now. Wait a little and try again.');
  });

  it('local test mode fills the code in and says so', () => {
    const text = visibleText(sheet({ ...base, email: 'priya@example.com', sent: true, debugCode: '123456' }));
    expect(text).toContain('Local test mode');
  });

  it('uses no technical words', () => {
    for (const request of [base, { ...base, email: 'priya@example.com', sent: true }]) expect(jargonIn(visibleText(sheet(request)))).toEqual([]);
  });
});

describe('plain words for the errors of these actions', () => {
  it('uses the sentence of the error for the ones the session code makes itself', () => {
    for (const code of ['cancelled', 'reauth_failed', 'wrong_account', 'strict_unfinished', 'strict_answer']) {
      expect(actionErrorText(new ApiError(0, code, 'A plain sentence.'))).toBe('A plain sentence.');
    }
  });

  it('uses the usual words for the rest, and never the network sentence for our own errors', () => {
    expect(actionErrorText(new ApiError(400, 'invalid_code', 'x'))).toBe('That code is not right, try again.');
    expect(actionErrorText(new ApiError(0, 'network', 'x'))).toMatch(/Could not reach the server/);
    expect(actionErrorText(new ApiError(0, 'cancelled', 'Cancelled. Nothing was changed.'))).not.toMatch(/reach the server/);
    expect(actionErrorText(new Error('Plain error.'))).toBe('Plain error.');
    expect(actionErrorText(null)).toBe('Something went wrong. Try again.');
  });
});

describe('Me: where you are signed in', () => {
  it('an account sees the section with both buttons', () => {
    const html = page(h(MePage), EASY);
    const text = visibleText(html);
    expect(text).toContain('Where you are signed in');
    expect(text).toContain('Sign out everywhere');
    expect(text).toMatch(/30 days after you last used it/);
    expect(text).toMatch(/90 days/);
    expect(jargonIn(text)).toEqual([]);
  });

  it('a Quick start person and a signed out visitor do not see it', () => {
    expect(visibleText(page(h(MePage), { status: 'ready', mode: 'guest', identity: IDENTITY, registration: 'registered' }))).not.toContain('Where you are signed in');
    expect(visibleText(page(h(MePage), {}))).not.toContain('Where you are signed in');
  });

  it('this device is marked and other devices have a Sign out button with a name that says which one', () => {
    const now = 10 * 60 * 60 * 1000;
    const here = renderToString(h(SessionRow, { session: { id: 'a'.repeat(16), createdAt: now - 3600000, lastSeenAt: now - 60000, expiresAt: now + 1, current: true }, now, busy: false, onEnd: noop }));
    expect(visibleText(here)).toContain('This device');
    expect(visibleText(here)).toContain('Current');
    expect(here).not.toMatch(/<button/);
    const other = renderToString(h(SessionRow, { session: { id: 'b'.repeat(16), createdAt: now - 3 * 86400000, lastSeenAt: now - 2 * 86400000, expiresAt: now + 1, current: false }, now, busy: false, onEnd: noop }));
    const text = visibleText(other);
    expect(text).toContain('Another device');
    expect(text).toContain('Last used 2 days ago');
    expect(text).toContain('Signed in 3 days ago');
    expect(other).toMatch(/aria-label="Sign out the device last used 2 days ago"/);
  });
});

describe('Me: Strict mode that was started and not finished', () => {
  it('is shown as not finished with a button to finish, not as Strict mode', () => {
    const state = { ...EASY, account: { ...ACCOUNT, strict: true }, keys: [{ keyId: KEY, hasCloudCopy: false }] };
    const text = visibleText(page(h(MePage), state, '/me', { strictUnfinished: () => true }));
    expect(text).toContain('Strict mode is not finished');
    expect(text).toContain('Finish saving them');
    expect(text).toMatch(/24 hours/);
  });

  it('a finished Strict account shows no such callout', () => {
    const state = { ...EASY, account: { ...ACCOUNT, strict: true }, keys: [{ keyId: KEY, hasCloudCopy: false }] };
    const text = visibleText(page(h(MePage), state, '/me', { strictUnfinished: () => false }));
    expect(text).not.toContain('not finished');
    expect(text).toContain('Strict mode is on');
  });

  it('the progress line says what has been saved so far, and does not claim a total it does not know', () => {
    expect(strictProgressText(null)).toMatch(/Asking the service/);
    expect(strictProgressText({ saved: 120, done: false })).toBe('Saving your file passwords to this device, 120 saved so far.');
    expect(strictProgressText({ saved: 250, done: true })).toBe('Saved 250 file passwords to this device.');
    expect(strictProgressText({ saved: 1, done: true })).toBe('Saved 1 file password to this device.');
  });
});

describe('a key that needs a new code', () => {
  const state = { status: 'needsKey', mode: 'account', account: { ...ACCOUNT, displayName: null }, keyProblem: 'reauth' };

  it('Me offers Confirm it is you instead of Try again', () => {
    const text = visibleText(page(h(MePage), state));
    expect(text).toContain('Confirm it is you');
    expect(text).toMatch(/new email code/);
    expect(text).not.toContain('Try again');
  });

  it('the sign in page shows the same step instead of the name form', () => {
    const html = page(h(SignInPage), state, '/signin');
    const text = visibleText(html);
    expect(text).toContain('Confirm it is you');
    expect(text).not.toContain('What should we call you?');
  });
});

describe('the session ended notice', () => {
  it('is shown on top of the page with a way to sign in and a way to close it', () => {
    const html = page(h(Layout, null, h('p', null, 'page')), { notice: 'Your sign in ended. Sign in again to continue.' }, '/chats');
    const text = visibleText(html);
    expect(text).toContain('Your sign in ended. Sign in again to continue.');
    expect(text).toContain('Dismiss');
    expect(html).toMatch(/href="\/signin"/);
  });

  it('is not shown when there is nothing to say', () => {
    const text = visibleText(page(h(Layout, null, h('p', null, 'page')), {}, '/chats'));
    expect(text).not.toContain('Dismiss');
  });
});

describe('source rules for the files of this change', () => {
  const files = [
    'src/components/ReauthSheet.jsx',
    'src/components/actionText.js',
    'src/components/useCountdown.js',
    'src/pages/MePage.jsx',
    'src/pages/SignInPage.jsx',
    'src/lib/sessionStore.js',
    'src/lib/session.jsx',
    'src/lib/api.js',
    'src/lib/vault.js'
  ];
  const read = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');

  it('no em dash, no emoji, and no mention of an AI product anywhere', () => {
    for (const f of files) {
      const text = read(f);
      expect(text, f).not.toMatch(/—/);
      expect(text, f).not.toMatch(/[\u{1F300}-\u{1FAFF}☀-➿]/u);
      expect(text, f).not.toMatch(/\b(Claude|Anthropic|OpenAI|ChatGPT|GPT|Gemini|LLM)\b/);
    }
  });

  it('the address is never put in a link: no address in any url the store builds', () => {
    const store = read('src/lib/sessionStore.js');
    const api = read('src/lib/api.js');
    expect(store).not.toMatch(/location\.(search|hash)|history\.(push|replace)State|encodeURIComponent\(\s*(mail|email)/);
    expect(api).not.toMatch(/queryString\(\{[^}]*email/);
  });
});

describe('the sixth digit sends the code by itself, and a Continue button stays for keyboards', () => {
  const read = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');

  it('sign in and the Confirm it is you sheet both send on the sixth digit', () => {
    const signin = read('src/pages/SignInPage.jsx');
    const reauth = read('src/components/ReauthSheet.jsx');
    expect(signin).toMatch(/onComplete=\{submit\}/);
    expect(reauth).toMatch(/onComplete=\{submitCode\}/);
    // a second send while one is running is ignored
    expect(signin).toMatch(/if \(busy\) return;/);
    expect(reauth).toMatch(/if \(busy\) return;/);
  });

  it('both keep a Continue button that is available once six digits are in', () => {
    const signin = read('src/pages/SignInPage.jsx');
    const reauth = read('src/components/ReauthSheet.jsx');
    expect(signin).toMatch(/disabled=\{code\.length !== 6\} onClick=\{\(\) => submit\(code\)\}/);
    expect(reauth).toMatch(/disabled=\{code\.length !== 6\} onClick=\{\(\) => submitCode\(code\)\}/);
  });
});
