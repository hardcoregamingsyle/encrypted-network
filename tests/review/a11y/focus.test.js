// Focus and announcement review. There is no browser here, so these read the component source
// and check that the code which removes or swaps the control a person just used also puts
// focus somewhere sensible or announces the result. Pure helpers (the sheet key rules, the focus
// helpers) are run for real. Each failing test names the line.
//
// The old top bar, Nav.jsx, PageHeader and KeysPage were replaced on purpose by the side menu, the
// bottom tabs, ScreenHeader, Sheet and the pages WelcomePage, SignInPage, MePage, AdvancedPage,
// FilesPage, ChatsPage and ChatRoomPage. These tests protect the same things on the new interface.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FOCUSABLE_SELECTOR, createScrollLock, nextTabIndex, pickReturnTarget, sheetKeyAction } from '../../../src/components/sheetLogic.js';
import { focusHeading, focusIfLost, focusIsLost } from '../../../src/lib/focus.js';
import { ROOT, read } from './helpers.js';

function lineOf(src, needle) {
  const idx = src.indexOf(needle);
  return idx === -1 ? -1 : src.slice(0, idx).split('\n').length;
}

// The text of one top level function of a source file, from its "function name(" line to the next
// line that starts with "}" at column zero.
function fnText(src, name) {
  const start = src.search(new RegExp(`^(export default )?function ${name}\\(`, 'm'));
  expect(start, `function ${name} exists`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end === -1 ? src.length : end + 2);
}

const PAGE_FILES = readdirSync(join(ROOT, 'src', 'pages')).filter((f) => f.endsWith('.jsx')).sort();

describe('route changes (these work)', () => {
  const layout = read('src/components/Layout.jsx');

  it('moves focus to the page heading after a route change and scrolls to the top', () => {
    expect(layout).toMatch(/querySelector\('h1'\)/);
    expect(layout).toMatch(/\.focus\(\{ preventScroll: true \}\)/);
    expect(layout).toMatch(/\[location\.pathname\]/);
    expect(layout).toMatch(/window\.scrollTo\(0, 0\)/);
  });

  it('the first render does not steal focus (a person who just arrived keeps the browser default)', () => {
    expect(layout).toMatch(/first\.current = false;\s*return;/);
  });

  it('the skip link moves focus into main, which can take focus', () => {
    expect(layout).toMatch(/function skip\(event\)[\s\S]*mainRef\.current\.focus\(\)/);
    expect(layout).toMatch(/<main id="main"[^>]*tabIndex=\{-1\}/);
  });

  it('the page list is the one this review knows (a new page must be added to the checks below)', () => {
    expect(PAGE_FILES).toEqual([
      'AboutPage.jsx',
      'AdvancedPage.jsx',
      'ChatRoomPage.jsx',
      'ChatsPage.jsx',
      'DocumentPage.jsx',
      'FilesPage.jsx',
      'MePage.jsx',
      'NotFound.jsx',
      'SignInPage.jsx',
      'VerifyPage.jsx',
      'WelcomePage.jsx'
    ]);
  });

  it('every page renders its h1 through ScreenHeader (which sets the tab title), or sets the tab title itself', () => {
    const header = read('src/components/ScreenHeader.jsx');
    expect(header).toMatch(/usePageTitle\(/);
    expect(header).toMatch(/<h1 className="ui-screen-header__title">/);
    expect(read('src/components/PageHeader.jsx')).toMatch(/document\.title = `\$\{title\} - \$\{SITE_NAME\}`/);
    // pages that draw their own card instead of a header bar
    const own = new Set(['SignInPage.jsx', 'WelcomePage.jsx']);
    // DocumentPage and ChatRoomPage hand the heading to FileView and ChannelView
    const delegated = { 'DocumentPage.jsx': 'src/components/doc/FileView.jsx', 'ChatRoomPage.jsx': 'src/components/chat/ChannelView.jsx' };
    for (const file of PAGE_FILES) {
      const src = read(`src/pages/${file}`);
      if (own.has(file)) {
        expect(src, file).toMatch(/<h1 /);
        expect(src, file).toMatch(/usePageTitle\(/);
      } else {
        expect(src, file).toMatch(/<ScreenHeader/);
      }
      if (delegated[file]) expect(read(delegated[file]), delegated[file]).toMatch(/<ScreenHeader/);
    }
  });

  it('a page that shows a loading splash still has its h1 in it, so the heading focus lands somewhere', () => {
    for (const file of ['WelcomePage.jsx', 'SignInPage.jsx']) {
      expect(read(`src/pages/${file}`), file).toMatch(/<div className="ui-splash">\s*<h1 className="ui-sr-only">/);
    }
    expect(read('src/App.jsx')).toMatch(/<div className="ui-splash">\s*<h1 className="ui-sr-only">/);
  });
});

describe('the sheet: keyboard rules and where focus goes', () => {
  it('Escape closes a sheet that may be dismissed and does nothing in a step that must be finished', () => {
    expect(sheetKeyAction({ key: 'Escape' }, { count: 3, index: 0, dismissible: true })).toEqual({ action: 'close' });
    expect(sheetKeyAction({ key: 'Escape' }, { count: 3, index: 0, dismissible: false })).toEqual({ action: 'none' });
  });

  it('Tab wraps at both ends, and Tab from outside the sheet comes back in', () => {
    expect(sheetKeyAction({ key: 'Tab' }, { count: 3, index: 2 })).toEqual({ action: 'focus', index: 0 });
    expect(sheetKeyAction({ key: 'Tab', shiftKey: true }, { count: 3, index: 0 })).toEqual({ action: 'focus', index: 2 });
    expect(sheetKeyAction({ key: 'Tab' }, { count: 3, index: 1 })).toEqual({ action: 'none' });
    expect(sheetKeyAction({ key: 'Tab' }, { count: 3, index: -1 })).toEqual({ action: 'focus', index: 0 });
    expect(sheetKeyAction({ key: 'Tab', shiftKey: true }, { count: 3, index: -1 })).toEqual({ action: 'focus', index: 2 });
    expect(sheetKeyAction({ key: 'Tab' }, { count: 0, index: -1 })).toEqual({ action: 'focus', index: -1 });
    expect(nextTabIndex(0, 0, false)).toBe(-1);
  });

  it('the focusable list covers links, buttons, fields, summaries and tabindex 0, and skips disabled ones', () => {
    for (const part of ['a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])', 'textarea:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])']) {
      expect(FOCUSABLE_SELECTOR).toContain(part);
    }
  });

  it('the page behind does not scroll while a sheet is open, and scrolls again only when the last one closes', () => {
    const classes = new Set();
    const doc = { body: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } } };
    const lock = createScrollLock(doc);
    lock.lock();
    lock.lock();
    expect(classes.has('ui-scroll-locked')).toBe(true);
    lock.unlock();
    expect(classes.has('ui-scroll-locked')).toBe(true);
    lock.unlock();
    expect(classes.has('ui-scroll-locked')).toBe(false);
    lock.unlock();
    expect(lock.count()).toBe(0);
  });

  it('closing a sheet gives focus back to the control that opened it, when that control is still on the page', () => {
    const opener = { focus() {} };
    expect(pickReturnTarget(opener, { contains: () => true })).toBe(opener);
    const src = read('src/components/Sheet.jsx');
    expect(src).toMatch(/openerRef\.current = document\.activeElement/);
    expect(src).toMatch(/const target = pickReturnTarget\(openerRef\.current, document\);\s*if \(target\) target\.focus/);
  });

  it('Escape, the close button and the dim area all call the same onClose, and only the top sheet listens', () => {
    const src = read('src/components/Sheet.jsx');
    expect(src).toMatch(/openStack\[openStack\.length - 1\] !== token/);
    expect(src).toMatch(/step\.action === 'close'[\s\S]*onCloseRef\.current\(\)/);
    expect(src).toMatch(/onClick=\{dismissible \? \(\) => onCloseRef\.current/);
    expect(src).toMatch(/data-sheet-close="true" onClick=\{\(\) => onCloseRef\.current/);
  });

  it('a sheet takes focus when it opens (a marked control, the first control, or the panel itself)', () => {
    const src = read('src/components/Sheet.jsx');
    expect(src).toMatch(/\[data-autofocus\]/);
    expect(src).toMatch(/\|\| panel;/);
    expect(src).toMatch(/first\.focus\(\{ preventScroll: true \}\)/);
    expect(src).toMatch(/role="dialog"[\s\S]*aria-modal="true"/);
  });

  it('DEFECT: closing a sheet whose opener has left the page still puts focus somewhere (not on the document)', () => {
    // pickReturnTarget answers null when the opener is gone, and the Sheet then does nothing.
    // Real case: a signed out visitor presses "Sign in to write" (Composer.jsx line 44), picks Quick
    // start in the sheet, the session turns ready, the composer swaps the button for the text box and
    // the sheet closes. The opener is gone, so focus falls to the top of the document.
    const gone = { focus() {} };
    expect(pickReturnTarget(gone, { contains: () => false })).toBe(null);
    const src = read('src/components/Sheet.jsx');
    const cleanup = src.slice(src.indexOf('const target = pickReturnTarget'), src.indexOf('// initialFocus is read once'));
    expect(cleanup, 'Sheet.jsx line ' + lineOf(src, 'const target = pickReturnTarget') + ' only focuses when the opener is still there').toMatch(
      /getElementById\('main'\)|focusHeading|focusIfLost|querySelector\('h1'\)/
    );
  });
});

describe('focus helpers', () => {
  const saved = globalThis.document;
  afterEach(() => {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  });

  function fakeDocument(active) {
    const body = { tagName: 'BODY' };
    const documentElement = { tagName: 'HTML' };
    const doc = { body, documentElement, activeElement: active === 'body' ? body : active, getElementById: () => null };
    globalThis.document = doc;
    return doc;
  }
  function el(tagName, onFocus) {
    const attrs = {};
    return {
      tagName,
      hasAttribute: (n) => n in attrs,
      setAttribute: (n, v) => {
        attrs[n] = v;
      },
      attrs,
      focus() {
        onFocus();
      }
    };
  }

  it('focus counts as lost only when nothing but the page itself has it', () => {
    fakeDocument('body');
    expect(focusIsLost()).toBe(true);
    fakeDocument({ tagName: 'BUTTON' });
    expect(focusIsLost()).toBe(false);
  });

  it('focusIfLost moves focus when it was lost, makes a non form element focusable, and leaves a person who moved on alone', () => {
    let moved = 0;
    const heading = el('H1', () => moved++);
    fakeDocument('body');
    expect(focusIfLost(heading)).toBe(true);
    expect(moved).toBe(1);
    expect(heading.attrs.tabindex).toBe('-1');
    const input = el('INPUT', () => moved++);
    expect(focusIfLost(input)).toBe(true);
    expect(input.attrs.tabindex).toBeUndefined();
    fakeDocument({ tagName: 'A' });
    expect(focusIfLost(el('H1', () => moved++))).toBe(false);
    expect(moved).toBe(2);
    expect(focusIfLost(null)).toBe(false);
  });

  it('focusHeading goes to the h1 of the page, or the h2 of what is shown now', () => {
    let at = '';
    const h1 = el('H1', () => (at = 'h1'));
    const h2 = el('H2', () => (at = 'h2'));
    fakeDocument('body');
    expect(focusHeading({ querySelector: (q) => (q === 'h1' ? h1 : null) })).toBe(true);
    expect(at).toBe('h1');
    fakeDocument('body');
    expect(focusHeading({ querySelector: (q) => (q === 'h2' ? h2 : null) })).toBe(true);
    expect(at).toBe('h2');
    expect(focusHeading({ querySelector: () => null })).toBe(false);
  });
});

describe('focus is not dropped when the pressed control disappears', () => {
  it('AdvancedPage moves focus when it swaps the button the person pressed (backup and forget)', () => {
    const src = read('src/pages/AdvancedPage.jsx');
    // "Download a fresh backup" -> form, "Cancel" -> button  (FreshBackup, setOpen)
    // "Forget this identity" -> form, "Cancel" -> button      (ForgetIdentity, setOpen)
    expect(lineOf(src, 'setOpen(true)')).toBeGreaterThan(0);
    for (const name of ['FreshBackup', 'ForgetIdentity']) {
      const body = fnText(src, name);
      expect(body, name).toMatch(/useToggleFocus\(open, \w+Ref, openRef\)/);
      expect(body, name).toMatch(/<Button ref=\{openRef\}/);
      expect(body, name).toMatch(/<input\s+ref=\{\w+Ref\}/);
    }
    expect(read('src/lib/focus.js')).toMatch(/export function useToggleFocus/);
  });

  it('the sign in steps move focus to the new screen (heading) or to the first code box', () => {
    const src = read('src/pages/SignInPage.jsx');
    expect(src).toMatch(/if \(shown !== 'code' && headingRef\.current\) headingRef\.current\.focus/);
    expect(src).toMatch(/<h1 className="signin__title" tabIndex=\{-1\} ref=\{headingRef\}/);
    expect(src).toMatch(/<OtpInput [^>]*autoFocus/);
    const otp = read('src/components/OtpInput.jsx');
    // a wrong code empties the boxes and the cursor goes back to the first one
    expect(otp).toMatch(/if \(error && refs\.current\[0\] && !disabled\) refs\.current\[0\]\.focus\(\)/);
    expect(otp).toMatch(/role="alert"/);
  });

  it('DocumentPage keeps focus when the loading view is replaced by the result', () => {
    const src = read('src/pages/DocumentPage.jsx');
    // The loading view is a different element tree from the result, so the focused h1 is destroyed.
    expect(lineOf(src, "if (phase === 'loading')")).toBeGreaterThan(0);
    expect(src).toMatch(/if \(phase === 'loading' \|\| !focusIsLost\(\)\) return;[\s\S]*querySelector\('#main h1'\)[\s\S]*\.focus\(/);
  });

  it('cancelling a reply puts focus back in the message box, and so does starting one from the menu', () => {
    const src = read('src/components/chat/ChannelView.jsx');
    const m = src.match(/onCancelReply=\{([^\n]*)\}/);
    expect(m, 'onCancelReply handler').toBeTruthy();
    // The Cancel button is inside the reply bar, which is removed as soon as replyTo is cleared.
    expect(/focus/.test(m[1]), 'onCancelReply is ' + m[1]).toBe(true);
    expect(src).toMatch(/const startReply = useCallback\(\(entry\) => \{[\s\S]*setMenuEntry\(null\);[\s\S]*inputRef\.current\.focus\(\)/);
  });

  it('the Add file sheet moves focus to the result when it replaces the form', () => {
    expect(read('src/components/files/AddFileSheet.jsx')).toMatch(/if \(phase === 'done' && doneRef\.current\) doneRef\.current\.focus\(\)/);
  });

  it('the Manage sheet moves focus into the next view when the pressed choice is replaced', () => {
    const src = read('src/components/doc/ManageSheet.jsx');
    expect(src).toMatch(/if \(open && bodyRef\.current\) bodyRef\.current\.focus\(\{ preventScroll: true \}\)/);
    expect(src).toMatch(/\}, \[view\]\)/);
    expect(src).toMatch(/ref=\{bodyRef\} tabIndex=\{-1\}/);
  });

  it('withdrawing a file moves focus to the heading, because the owner tools disappear with it', () => {
    const src = read('src/pages/DocumentPage.jsx');
    expect(src).toMatch(/if \(revoked\) focusHeading\(\)/);
  });

  it('DEFECT: the Strict mode sheet moves focus (or announces) when the question is replaced by the result', () => {
    // Pressing "Turn on Strict mode" removes the footer buttons and swaps the body for the result
    // ("Strict mode is on", with the one last chance to download the file passwords). It is the same
    // Sheet instance, so the open/close focus code does not run again, and nothing in StrictSheet
    // moves focus or sets a live region. Focus falls to the document and a screen reader says nothing.
    const src = read('src/pages/MePage.jsx');
    const body = fnText(src, 'StrictSheet');
    expect(lineOf(src, 'setResult(out)')).toBeGreaterThan(0);
    expect(body, 'MePage.jsx StrictSheet (line ' + lineOf(src, 'function StrictSheet') + ') never moves focus or announces the result').toMatch(
      /\.focus\(|useToggleFocus|focusHeading|focusIfLost|initialFocus|role="status"|aria-live/
    );
  });

  it('removing a file from the drop zone returns focus to the file input (works)', () => {
    expect(read('src/components/vault/DropZone.jsx')).toMatch(/inputRef\.current\.focus\(\)/);
  });

  it('a finished publish in the older publish view moves focus to the result heading (works)', () => {
    expect(read('src/components/vault/PublishResult.jsx')).toMatch(/headRef\.current\.focus\(\)/);
  });

  it('sending a chat message returns focus to the box (works)', () => {
    expect(read('src/components/chat/Composer.jsx')).toMatch(/ref\.current\.focus\(\)/);
  });
});

describe('the outcome of an irreversible action is announced', () => {
  it('revoking a document says that it worked', () => {
    const src = read('src/components/doc/RevokePanel.jsx');
    // On success onRevoked() reloads the page data. The revoke panel is then removed because the
    // document is revoked, taking the focused button with it. The success text goes to the toast area,
    // which stays on the page, and DocumentPage moves focus to the heading.
    const page = read('src/pages/DocumentPage.jsx');
    const announces = /toast\.push\(\{ tone: 'good'/.test(src);
    expect(announces, 'no success message after "Withdraw"').toBe(true);
    expect(read('src/components/Toast.jsx')).toMatch(/role="status" aria-live="polite"/);
    expect(page).toMatch(/onWithdrawn=\{async \(\) => \{\s*setManageOpen\(false\);/);
  });

  it('publishing a new version says that it worked', () => {
    // The toast text comes from updateToast() in pageLogic.js (it names the version and warns when the password was not saved).
    expect(read('src/pages/DocumentPage.jsx')).toMatch(/toast\.push\(updateToast\(info\)\)/);
    expect(read('src/components/doc/pageLogic.js')).toMatch(/tone: 'good', text: text \+/);
    expect(read('src/components/doc/pageLogic.js')).toMatch(/is published\./);
  });

  it('adding a file ends with a visible "is published" line inside a status region', () => {
    expect(read('src/components/files/AddFileSheet.jsx')).toMatch(/role="status">[\s\S]*is published\./);
  });

  it('the progress line of a running publish is a polite live region', () => {
    expect(read('src/components/files/AddFileSheet.jsx')).toMatch(/className="files-add__progress" role="status" aria-live="polite"/);
  });

  it('a wrong sign in code is announced as an alert, and a resend says so in a status line', () => {
    const otp = read('src/components/OtpInput.jsx');
    expect(otp).toMatch(/<p className="ui-otp__error" id=\{errorId\} role="alert">/);
    expect(read('src/pages/SignInPage.jsx')).toMatch(/<p className="ui-muted" role="status">\s*\{notice\}/);
  });
});

describe('timing', () => {
  it('toasts that carry errors or warnings stay long enough (9 s) and can be dismissed', () => {
    const src = read('src/components/Toast.jsx');
    expect(src).toMatch(/tone === 'bad' \|\| tone === 'warn' \? 9000 : 5000/);
    expect(src).toMatch(/aria-label="Dismiss message"/);
  });

  it('errors and warnings go to the assertive region, everything else to the polite one', () => {
    const src = read('src/components/Toast.jsx');
    expect(src).toMatch(/const urgent = items\.filter\(\(item\) => item\.tone === 'bad' \|\| item\.tone === 'warn'\)/);
    expect(src).toMatch(/<div role="alert" aria-live="assertive">/);
  });

  it('DEFECT: no toast with an error or warning tone is pushed anywhere (so nothing important disappears by itself)', () => {
    // A toast goes away after 9 seconds. A failure that is the only feedback ("Could not save the
    // file", a failed sign out, a failed key save, "Could not copy the link") must stay on the page,
    // as a callout or an inline error, until the person acts. The older checked files were
    // KeysPage, PublishVersion and RevokePanel; KeysPage is now MePage and AdvancedPage.
    const hits = [];
    const files = [];
    (function walk(dir) {
      for (const name of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (name.isDirectory()) walk(`${dir}/${name.name}`);
        else if (/\.jsx?$/.test(name.name)) files.push(`${dir}/${name.name}`);
      }
    })('src');
    for (const file of files) {
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (/push\(.*tone:\s*'(bad|warn)'/.test(line)) hits.push(`${file}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
