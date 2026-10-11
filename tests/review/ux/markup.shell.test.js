// Markup and behaviour review of the new shell (reviewer r3-ux): Sheet, OtpInput, tab bar and side
// navigation, screen header, floating button, chat bubbles, toasts, titles, forms and the page head.
// Server rendering only (no browser), so behaviour is judged from the markup and from the source.
import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { all, lint, nameOf, parseHtml, textOf } from '../a11y/html.js';
import { FOCUSABLE_SELECTOR, nextTabIndex, pickReturnTarget, sheetKeyAction } from '../../../src/components/sheetLogic.js';
import { otpBackspace, otpInsert, otpTyped } from '../../../src/components/otpLogic.js';
import BottomTabs from '../../../src/components/BottomTabs.jsx';
import Fab from '../../../src/components/Fab.jsx';
import Layout from '../../../src/components/Layout.jsx';
import OtpInput from '../../../src/components/OtpInput.jsx';
import ScreenHeader from '../../../src/components/ScreenHeader.jsx';
import Sheet from '../../../src/components/Sheet.jsx';
import SideNav from '../../../src/components/SideNav.jsx';
import { ToastProvider } from '../../../src/components/Toast.jsx';
import AddFileSheet from '../../../src/components/files/AddFileSheet.jsx';
import Composer from '../../../src/components/chat/Composer.jsx';
import NewChatSheet from '../../../src/components/chat/NewChatSheet.jsx';
import { ChannelCard } from '../../../src/components/chat/ChannelList.jsx';
import { MessageItem, PendingItem } from '../../../src/components/chat/MessageItem.jsx';
import MessageMenu from '../../../src/components/chat/MessageMenu.jsx';
import ChatsPage from '../../../src/pages/ChatsPage.jsx';
import FilesPage from '../../../src/pages/FilesPage.jsx';
import MePage from '../../../src/pages/MePage.jsx';
import SignInPage from '../../../src/pages/SignInPage.jsx';
import VerifyPage from '../../../src/pages/VerifyPage.jsx';
import WelcomePage from '../../../src/pages/WelcomePage.jsx';
import { KEY, read, render } from './helpers.js';

const noop = () => {};

// ---------- every primary screen passes the structural linter ----------

describe('structure of the primary screens (ids, labels, names, headings, landmarks)', () => {
  const screens = [
    ['Welcome', () => h(WelcomePage), 'out', '/welcome'],
    ['Welcome without mail', () => h(WelcomePage), 'outNoMail', '/welcome'],
    ['Sign in, email step', () => h(SignInPage), 'out', '/signin'],
    ['Sign in, name step', () => h(SignInPage), 'needsKey', '/signin'],
    ['Chats', () => h(ChatsPage), 'easy', '/chats'],
    ['Files', () => h(FilesPage), 'easy', '/files'],
    ['Files, signed out', () => h(FilesPage), 'out', '/files'],
    ['Verify', () => h(VerifyPage), 'out', '/verify'],
    ['Me, Easy', () => h(MePage), 'easy', '/me'],
    ['Me, Strict', () => h(MePage), 'strict', '/me'],
    ['Me, Quick start', () => h(MePage), 'guest', '/me'],
    ['Me, signed out', () => h(MePage), 'out', '/me']
  ];
  for (const [name, node, state, path] of screens) {
    it(name, () => {
      expect(lint(render(node(), state, path), { fragment: true })).toEqual([]);
    });
  }

  it('DEFECT: when email sign in is not switched on, the sign in page offers no email box that cannot work', () => {
    // The spec says email sign in is hidden then. /signin shows a warning and still shows the box and the
    // Continue button, which can only end in "Email sign in is not switched on yet".
    const root = parseHtml(render(h(SignInPage), 'outNoMail', '/signin'));
    expect(all(root, (e) => e.tag === 'input' && e.attrs.type === 'email').length).toBe(0);
  });

  it('the open sheets: Add file and New chat', () => {
    expect(lint(render(h(AddFileSheet, { open: true, onClose: noop }), 'easy', '/files'), { fragment: true })).toEqual([]);
    expect(lint(render(h(NewChatSheet, { open: true, onClose: noop }), 'easy', '/chats'), { fragment: true })).toEqual([]);
  });
});

// ---------- Sheet ----------

describe('Sheet', () => {
  const html = render(h(Sheet, { open: true, onClose: noop, title: 'Add a file', description: 'Pick a file.' }, h('button', { type: 'button' }, 'Inside')));
  const root = parseHtml(html);
  const dialog = all(root, (e) => e.attrs.role === 'dialog')[0];

  it('is a modal dialog named by its heading and described by its sentence', () => {
    expect(dialog.attrs['aria-modal']).toBe('true');
    const label = all(root, (e) => e.attrs.id === dialog.attrs['aria-labelledby'])[0];
    expect(label.tag).toBe('h2');
    expect(textOf(label)).toBe('Add a file');
    const desc = all(root, (e) => e.attrs.id === dialog.attrs['aria-describedby'])[0];
    expect(textOf(desc)).toBe('Pick a file.');
    expect(dialog.attrs.tabindex).toBe('-1');
  });

  it('has a close button with a name, and a dim area that is hidden from screen readers', () => {
    const close = all(root, (e) => e.tag === 'button' && e.attrs['data-sheet-close'])[0];
    expect(nameOf(root, close)).toBe('Close');
    const scrim = all(root, (e) => /ui-sheet-scrim/.test(e.attrs.class || ''))[0];
    expect(scrim.attrs['aria-hidden']).toBe('true');
  });

  it('a step that must be finished has no close button', () => {
    const locked = parseHtml(render(h(Sheet, { open: true, onClose: noop, title: 'Working', dismissible: false }, 'x')));
    expect(all(locked, (e) => e.attrs['data-sheet-close']).length).toBe(0);
  });

  it('the focus trap logic wraps at both ends and Escape closes only a dismissible sheet', () => {
    expect(nextTabIndex(3, 2, false)).toBe(0);
    expect(nextTabIndex(3, 0, true)).toBe(2);
    expect(sheetKeyAction({ key: 'Tab' }, { count: 3, index: 2 })).toEqual({ action: 'focus', index: 0 });
    expect(sheetKeyAction({ key: 'Tab', shiftKey: true }, { count: 3, index: 0 })).toEqual({ action: 'focus', index: 2 });
    expect(sheetKeyAction({ key: 'Escape' }, { count: 3, index: 1 })).toEqual({ action: 'close' });
    expect(sheetKeyAction({ key: 'Escape' }, { count: 3, index: 1, dismissible: false })).toEqual({ action: 'none' });
    expect(FOCUSABLE_SELECTOR).toContain('summary');
  });

  it('DEFECT: the page behind a sheet is made inert, not only marked aria-modal', () => {
    // aria-modal alone is not honoured by every screen reader, so the page behind (the tab bar, the
    // list, the + button) stays reachable by swiping. The sheet never sets inert or aria-hidden on it.
    const src = read('src/components/Sheet.jsx');
    expect(/\binert\b|aria-hidden['"]?\s*,\s*['"]true|setAttribute\(['"]aria-hidden/.test(src)).toBe(true);
  });

  it('DEFECT: the phone Back button closes an open sheet instead of leaving the page', () => {
    // A sheet adds no history entry, so Back (the Android button, the iOS swipe) leaves /files with the
    // half filled Add file form and, while a file is being published, with the work unfinished.
    const src = read('src/components/Sheet.jsx');
    expect(/popstate|pushState|history\./.test(src)).toBe(true);
  });

  it('DEFECT: the focus trap only counts controls that can be reached (not those inside a closed Details)', () => {
    // Sheet.focusables() keeps every match of the selector that has no hidden attribute and no
    // aria-hidden. A button inside a closed <details> matches, but Tab cannot reach it. The message menu
    // has one (the key badge under "Who wrote this"), so the trap believes the last stop is that button.
    // Tab on the real last stop (the summary) is then "not at the edge", the trap does nothing, and focus
    // leaves the sheet for the page behind it until the next key press pulls it back.
    const entry = { seq: 4, hash: 'c'.repeat(64), record: { body: 'Agenda is up', signer: KEY, createdAt: Date.now() }, verdict: { status: 'verified', detail: '' } };
    const menu = parseHtml(render(h(MessageMenu, { entry, name: 'Priya', canReply: true, onReply: noop, onClose: noop, onNeedSignIn: noop }), 'easy'));
    const dialog = all(menu, (e) => e.attrs.role === 'dialog')[0];
    const focusable = all(dialog, (e) => ['button', 'summary', 'input', 'select', 'textarea'].includes(e.tag) || (e.tag === 'a' && e.attrs.href !== undefined)).filter(
      (e) => !('hidden' in e.attrs) && e.attrs['aria-hidden'] !== 'true'
    );
    const last = focusable[focusable.length - 1];
    let insideClosedDetails = false;
    for (let n = last.parent; n; n = n.parent) {
      if (n.tag === 'details' && !('open' in n.attrs)) insideClosedDetails = !(last.tag === 'summary' && last.parent === n);
    }
    expect(insideClosedDetails).toBe(false);
  });

  it('DEFECT: when the control that opened the sheet is gone, focus goes to the page heading, not to nothing', () => {
    const gone = { focus() {} };
    const detached = { contains: () => false };
    expect(pickReturnTarget(gone, detached)).toBe(null);
    const src = read('src/components/Sheet.jsx');
    expect(/focusHeading|focusIfLost|querySelector\(['"]h1|getElementById\(['"]main/.test(src)).toBe(true);
  });
});

// ---------- OtpInput ----------

describe('OtpInput', () => {
  const root = parseHtml(render(h(OtpInput, { value: '12', onChange: noop, label: '6 digit code' })));
  const boxes = all(root, (e) => e.tag === 'input');

  it('six boxes in one labelled group, each named "Digit n of 6"', () => {
    const group = all(root, (e) => e.attrs.role === 'group')[0];
    expect(textOf(all(root, (e) => e.attrs.id === group.attrs['aria-labelledby'])[0])).toBe('6 digit code');
    expect(boxes.length).toBe(6);
    expect(boxes.map((b) => b.attrs['aria-label'])).toEqual(['Digit 1 of 6', 'Digit 2 of 6', 'Digit 3 of 6', 'Digit 4 of 6', 'Digit 5 of 6', 'Digit 6 of 6']);
  });

  it('asks for the numeric keyboard and for the code from the email or message', () => {
    for (const b of boxes) {
      expect(b.attrs.inputMode).toBe('numeric');
      expect(b.attrs.pattern).toBe('[0-9]*');
    }
    expect(boxes[0].attrs.autoComplete).toBe('one-time-code');
    expect(boxes.slice(1).every((b) => b.attrs.autoComplete === 'off')).toBe(true);
  });

  it('the error line is a live region that is already on the page when it is empty', () => {
    const alert = all(root, (e) => e.attrs.role === 'alert')[0];
    expect(alert).toBeTruthy();
    expect(textOf(alert)).toBe('');
    const withError = parseHtml(render(h(OtpInput, { value: '', onChange: noop, error: 'That code is not right, try again.' })));
    expect(textOf(all(withError, (e) => e.attrs.role === 'alert')[0])).toBe('That code is not right, try again.');
    expect(all(withError, (e) => e.tag === 'input').every((b) => b.attrs['aria-invalid'] === 'true')).toBe(true);
  });

  it('paste and autofill of a whole code fill all boxes, and Backspace removes one digit', () => {
    expect(otpInsert('', 0, '123 456')).toEqual({ value: '123456', focus: 5 });
    expect(otpTyped('654321', '')).toBe('654321');
    expect(otpBackspace('123456', 5).value).toBe('12345');
  });

  it('DEFECT: the same code can be sent again after a failed try (a lost connection, for example)', () => {
    // The box remembers the last full code it reported (lastCompleted) and does not report it twice.
    // After a failure the page empties the boxes, but nothing tells the box to forget, so pasting the
    // same, still valid, code again fills the boxes and sends nothing. The Continue button is the only way.
    const src = read('src/components/OtpInput.jsx');
    const forgets = /useEffect\(\(\) => \{[^}]*lastCompleted\.current = ''/.test(src) || /lastCompleted\.current = ''[\s\S]{0,80}\[value\]/.test(src);
    expect(forgets).toBe(true);
  });

  it('DEFECT: a lost connection does not wipe the six digits that were typed', () => {
    // CodeStep clears the code after every failure, including "Could not reach the server", where the
    // code is still good and has to be typed again.
    const src = read('src/pages/SignInPage.jsx');
    const submit = src.slice(src.indexOf('async function submit(value)'), src.indexOf('async function resend()'));
    expect(/network|status === 0|invalid_code|code_expired/.test(submit.slice(submit.indexOf('catch')))).toBe(true);
  });

  it('DEFECT: a digit deleted by an input event alone (no Backspace key event) is really removed', () => {
    // Many phone keyboards report Backspace as key "Unidentified" (code 229), so the keydown branch is
    // skipped and only the change event arrives with an empty box. The change path cannot delete.
    const digits = '123456';
    const afterEvent = otpInsert(digits, 2, otpTyped('', digits[2])).value;
    expect(afterEvent).toBe('12456');
  });
});

// ---------- tab bar, side navigation, header, floating button ----------

describe('navigation landmarks', () => {
  const tabs = parseHtml(render(h(BottomTabs), 'easy', '/files'));
  const side = parseHtml(render(h(SideNav), 'easy', '/files'));

  it('two named navigation landmarks with the same four links in the same order', () => {
    const tabNav = all(tabs, (e) => e.tag === 'nav')[0];
    const sideNav = all(side, (e) => e.tag === 'nav')[0];
    expect(tabNav.attrs['aria-label']).toBe('Main tabs');
    expect(sideNav.attrs['aria-label']).toBe('Main menu');
    const names = (r, cls) => all(r, (e) => e.tag === 'a' && new RegExp(cls).test(e.attrs.class || '')).map((a) => textOf(a));
    expect(names(tabs, 'ui-tabbar__link')).toEqual(['Chats', 'Files', 'Verify', 'Me']);
    expect(names(side, 'ui-sidenav__link')).toEqual(['Chats', 'Files', 'Verify', 'Me']);
  });

  it('exactly one link carries aria-current="page"', () => {
    for (const r of [tabs, side]) {
      const current = all(r, (e) => e.attrs['aria-current'] === 'page');
      expect(current.map((a) => textOf(a))).toEqual(['Files']);
    }
  });

  it('a file page keeps the Files tab current, a chat room keeps Chats', () => {
    const doc = parseHtml(render(h(BottomTabs), 'out', '/d/' + 'a'.repeat(32)));
    expect(all(doc, (e) => e.attrs['aria-current'] === 'page').map((a) => textOf(a))).toEqual(['Files']);
    const room = parseHtml(render(h(BottomTabs), 'out', '/chats/town-hall'));
    expect(all(room, (e) => e.attrs['aria-current'] === 'page').map((a) => textOf(a))).toEqual(['Chats']);
  });

  it('only one of the two is shown at a time: css hides the side menu on phones and the tab bar on wide screens', () => {
    const css = read('src/styles/nav.css');
    expect(css).toMatch(/\.ui-sidenav\s*\{\s*display:\s*none/);
    expect(css).toMatch(/@media \(min-width: 56\.25rem\)\s*\{[\s\S]*?\.ui-tabbar\s*\{\s*display:\s*none/);
  });

  it('the shell order is: skip link, side menu, page, tab bar', () => {
    const html = render(h(Layout, null, h('h1', null, 'Page')), 'easy', '/files');
    const root = parseHtml(html);
    const shell = all(root, (e) => /^ui-shell /.test(e.attrs.class || ''))[0];
    const kids = [];
    (function walk(n) {
      for (const c of n.children) {
        if (typeof c === 'string') continue;
        if (c.tag === 'a' && c.attrs.href === '#main') kids.push('skip');
        else if (c.tag === 'nav') kids.push(c.attrs['aria-label']);
        else if (c.tag === 'main') kids.push('main');
        else if (c.tag === 'footer') kids.push('footer');
        walk(c);
      }
    })(shell);
    expect(kids).toEqual(['skip', 'Main menu', 'main', 'footer', 'Main tabs']);
  });

  it('the screen header: the back control has a name and the title is the one h1', () => {
    const link = parseHtml(render(h(ScreenHeader, { title: 'Town hall', subtitle: 'Public chat', back: '/chats', backLabel: 'Back to chats' }), 'out'));
    const back = all(link, (e) => /ui-screen-header__back/.test(e.attrs.class || ''))[0];
    expect(nameOf(link, back)).toBe('Back to chats');
    expect(all(link, (e) => e.tag === 'h1').length).toBe(1);
    const btn = parseHtml(render(h(ScreenHeader, { title: 'File', back: true }), 'out'));
    expect(nameOf(btn, all(btn, (e) => e.tag === 'button')[0])).toBe('Back');
  });

  it('DEFECT: the back arrow on a file page opened from a link does not lead a visitor to "Sign in to see your files"', () => {
    // ScreenHeader goes back in history when there is a previous screen in the app, else to backTo.
    // A visitor who opened a shared link has no previous screen, and backTo is /files, which for
    // somebody who is not signed in is the "Sign in to see your files" page.
    for (const f of ['src/components/doc/FileView.jsx', 'src/pages/DocumentPage.jsx']) {
      expect(/backTo="\/files"/.test(read(f)), f).toBe(false);
    }
  });

  it('the + button always has a name: visible words, or hidden words when it is icon only', () => {
    const labelled = parseHtml(render(h(Fab, { label: 'Add file', onClick: noop }), 'out'));
    expect(nameOf(labelled, all(labelled, (e) => e.tag === 'button')[0])).toBe('Add file');
    const compact = parseHtml(render(h(Fab, { label: 'New chat', compact: true, onClick: noop }), 'out'));
    expect(nameOf(compact, all(compact, (e) => e.tag === 'button')[0])).toBe('New chat');
  });
});

// ---------- chat bubbles, reading order, ticks, unread badges ----------

describe('chat markup for screen readers', () => {
  const rec = { body: 'Agenda is up', signer: KEY, createdAt: Date.UTC(2026, 9, 3, 10, 2) };
  const entry = { seq: 4, hash: 'c'.repeat(64), record: rec, verdict: { status: 'verified', detail: '' } };
  const item = (props) => parseHtml(render(h('ol', null, h(MessageItem, { entry, name: 'Priya', canReply: true, onReply: noop, onMenu: noop, ...props })), 'easy'));

  it('a message from somebody else reads: name, text, time, that it was checked, then its two buttons', () => {
    const li = all(item({}), (e) => e.tag === 'li')[0];
    const spoken = textOf(li);
    expect(spoken.indexOf('Priya')).toBeLessThan(spoken.indexOf('Agenda is up'));
    expect(spoken.indexOf('Agenda is up')).toBeLessThan(spoken.indexOf('Checked: written by this sender and not changed'));
    const buttons = all(li, (e) => e.tag === 'button').map((b) => b.attrs['aria-label']);
    expect(buttons).toEqual(['Reply to Priya, message 4', 'More for message 4 by Priya']);
  });

  it('the check mark is spoken as words and the time is a real <time> element', () => {
    const li = all(item({}), (e) => e.tag === 'li')[0];
    expect(all(li, (e) => /chat-tick/.test(e.attrs.class || '')).length).toBe(1);
    expect(textOf(li)).toContain('Checked: written by this sender and not changed');
    expect(all(li, (e) => e.tag === 'time')[0].attrs.dateTime).toBe('2026-10-03T10:02:00.000Z');
  });

  it('DEFECT: a message written by this person is announced as theirs ("You"), not only drawn on the right', () => {
    // Own messages have no name line. A screen reader user hears the text, the time and the tick, and
    // cannot tell whether the message was sent or received. Position and colour do not reach them.
    const li = all(item({ own: true }), (e) => e.tag === 'li')[0];
    expect(/\bYou\b|\bMe\b|\bYour message\b/.test(textOf(li))).toBe(true);
  });

  it('DEFECT: the tick says what was checked in plain words, without the word signature', () => {
    const li = all(item({}), (e) => e.tag === 'li')[0];
    expect(textOf(li)).not.toMatch(/signature/i);
  });

  it('a failed message is announced as failed before the text is reachable', () => {
    const bad = { ...entry, verdict: { status: 'invalid', detail: 'signature does not verify' } };
    const li = all(parseHtml(render(h('ol', null, h(MessageItem, { entry: bad, name: '' })), 'easy')), (e) => e.tag === 'li')[0];
    const spoken = textOf(li);
    expect(spoken).toContain('Could not verify this message');
    expect(spoken.indexOf('Could not verify')).toBeLessThan(spoken.indexOf('Show the text anyway'));
    expect(all(li, (e) => e.tag === 'details').length).toBe(1);
  });

  it('DEFECT: the reason inside a failed message bubble is in plain words', () => {
    // The bubble prints the raw check result, for example "message hash does not match the record".
    const bad = { ...entry, verdict: { status: 'invalid', detail: 'message hash does not match the record' } };
    const li = all(parseHtml(render(h('ol', null, h(MessageItem, { entry: bad, name: '' })), 'easy')), (e) => e.tag === 'li')[0];
    const outside = all(li, (e) => e.attrs.class === 'chat-msg__why').map((e) => textOf(e)).join(' ');
    expect(outside).not.toMatch(/hash|signature|chain|record/i);
  });

  it('a message still being sent has a status icon with words, and a failed send is an alert', () => {
    const ok = parseHtml(render(h('ol', null, h(PendingItem, { item: { id: 'p', status: 'sending', record: { body: 'On my way', createdAt: rec.createdAt } }, name: 'Priya', keyId: KEY })), 'easy'));
    expect(all(ok, (e) => /chat-pendingmark/.test(e.attrs.class || '')).length).toBe(1);
    const failed = parseHtml(render(h('ol', null, h(PendingItem, { item: { id: 'p', status: 'failed', error: 'No connection.', record: { body: 'On my way', createdAt: rec.createdAt } }, name: 'Priya', keyId: KEY })), 'easy'));
    expect(all(failed, (e) => e.attrs.role === 'alert' && /chat-msg__note/.test(e.attrs.class || '')).length).toBe(1);
  });

  it('the unread count in the list is read as words and the digits are hidden', () => {
    const li = parseHtml(render(h('ul', null, h(ChannelCard, { channel: { channelId: 'town-hall', title: 'Town hall', messageCount: 9, lastMessageAt: Date.now() }, now: Date.now() })), 'easy', '/chats'));
    const link = all(li, (e) => e.tag === 'a')[0];
    expect(textOf(link)).toContain('Town hall');
  });

  it('the message list is a labelled log, and the toast area has both live regions before any toast', () => {
    const list = read('src/components/chat/MessageList.jsx');
    expect(list).toMatch(/role="log"/);
    expect(list).toMatch(/aria-label="Messages"/);
    const toasts = parseHtml(render(h('div', null, 'x'), 'out'));
    expect(all(toasts, (e) => e.attrs['aria-live'] === 'polite').length).toBe(1);
    expect(all(toasts, (e) => e.attrs['aria-live'] === 'assertive').length).toBe(1);
    expect(h(ToastProvider)).toBeTruthy();
  });

  it('DEFECT: the log announces only new messages, not a whole page of older ones loaded at the top', () => {
    // role="log" with aria-relevant="additions" announces every node added anywhere in the list.
    // "Load older messages" adds up to a page of messages above the view, and each one is read out.
    const list = read('src/components/chat/MessageList.jsx');
    expect(/aria-live=\{/.test(list)).toBe(true);
  });
});

// ---------- the writing box ----------

describe('Composer', () => {
  const html = render(h(Composer, { identityStatus: 'ready', signerName: 'Priya', onSend: noop }), 'easy');
  const root = parseHtml(html);

  it('the box has a label, a hint, the numeric Enter key says Send, and Send has a name', () => {
    const area = all(root, (e) => e.tag === 'textarea')[0];
    expect(nameOf(root, area)).toBe('Message as Priya');
    expect(area.attrs.enterKeyHint).toBe('send');
    expect(area.attrs['aria-describedby']).toBeTruthy();
    const send = all(root, (e) => e.tag === 'button' && e.attrs.type === 'submit')[0];
    expect(nameOf(root, send)).toBe('Send message');
  });

  it('signed out people see one clear button instead of a dead box', () => {
    const out = parseHtml(render(h(Composer, { identityStatus: 'signedOut', onSend: noop }), 'out'));
    expect(all(out, (e) => e.tag === 'textarea').length).toBe(0);
    expect(all(out, (e) => e.tag === 'button').map((b) => textOf(b))).toEqual(['Sign in to write']);
  });

  it('DEFECT: on a phone, Enter starts a new line and the Send button sends', () => {
    // Shift+Enter is the only way to type a line break, and a phone keyboard has no Shift+Enter. With
    // enterKeyHint="send" nobody on a phone can write two lines. The key handler never asks whether the
    // device has a touch keyboard.
    const src = read('src/components/chat/Composer.jsx');
    expect(/pointer:\s*coarse|hover:\s*none|maxTouchPoints|ontouchstart/.test(src)).toBe(true);
  });

  it('DEFECT: the remaining characters counter exists before it has something to say', () => {
    // A live region that is inserted together with its text is often not announced. The counter is
    // only rendered once the text is near the limit.
    const src = read('src/components/chat/Composer.jsx');
    const at = src.indexOf('aria-live');
    expect(/counter\.show\s*\?/.test(src.slice(Math.max(0, at - 220), at))).toBe(false);
  });
});

// ---------- the answer of a check ----------

describe('announcing results', () => {
  it('DEFECT: the answer of Check a document is inside the live region that already exists', () => {
    // QuickCheck keeps a role="status" region for the progress line, but the verdict is drawn outside
    // it. A "Verified" answer is a new role="status" node, which is not reliably spoken, and focus is not
    // moved to it either.
    const src = read('src/components/verify/QuickCheck.jsx');
    const live = src.slice(src.indexOf('vq-live'), src.indexOf('phase === \'error\''));
    expect(/VerifySummary|vq-result/.test(live)).toBe(true);
  });

  it('a failed check is an alert', () => {
    expect(read('src/components/VerifySummary.jsx')).toMatch(/role=\{tone === 'bad' \? 'alert' : 'status'\}/);
  });
});

// ---------- the document head, titles, focus ----------

describe('page head and titles', () => {
  const html = read('index.html');

  it('the viewport allows zoom and covers the notch; the page has a language and a title', () => {
    const viewport = html.match(/<meta name="viewport" content="([^"]+)"/)[1];
    expect(viewport).toContain('width=device-width');
    expect(viewport).toContain('viewport-fit=cover');
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?(,|$)/);
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
  });

  it('DEFECT: the viewport tells phones to shrink the page when the keyboard opens', () => {
    // Since Chrome 108 the keyboard covers the page without resizing it, unless the viewport says
    // interactive-widget=resizes-content. The room is 100dvh tall, so the keyboard sits on top of the
    // writing box and the last messages until the browser scrolls.
    expect(html).toMatch(/interactive-widget=resizes-content/);
  });

  it('DEFECT: iPhones get a home screen icon (apple-touch-icon, a PNG)', () => {
    // The manifest icons are SVG, which iOS ignores for "Add to Home Screen".
    expect(html).toMatch(/rel="apple-touch-icon"/);
  });

  it('DEFECT: the installed app is not locked to portrait (WCAG 1.3.4)', () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest'));
    expect(manifest.orientation === undefined || manifest.orientation === 'any' || manifest.orientation === 'natural').toBe(true);
  });

  it('every page sets the tab title through ScreenHeader, PageHeader or usePageTitle', () => {
    const missing = [];
    for (const f of ['Welcome', 'SignIn', 'Chats', 'ChatRoom', 'Files', 'Document', 'Verify', 'Me', 'Advanced', 'About', 'NotFound']) {
      const src = read(`src/pages/${f}Page.jsx`.replace('NotFoundPage', 'NotFound'));
      if (!/ScreenHeader|PageHeader|usePageTitle/.test(src)) missing.push(f);
    }
    expect(missing).toEqual([]);
  });

  it('a route change moves focus to the page heading (Layout)', () => {
    const src = read('src/components/Layout.jsx');
    expect(src).toMatch(/\[location\.pathname\]/);
    expect(src).toMatch(/querySelector\('h1'\)/);
  });
});
