// Focus and announcement review. There is no browser here, so these read the component source
// and check that the code which removes or swaps the control a person just used also puts
// focus somewhere sensible or announces the result. Each failing test names the line.
import { describe, expect, it } from 'vitest';
import { read } from './helpers.js';

function lineOf(src, needle) {
  const idx = src.indexOf(needle);
  return idx === -1 ? -1 : src.slice(0, idx).split('\n').length;
}

describe('route changes (these work)', () => {
  const layout = read('src/components/Layout.jsx');

  it('moves focus to the page heading after a route change and scrolls to the top', () => {
    expect(layout).toMatch(/querySelector\('h1'\)/);
    expect(layout).toMatch(/\.focus\(\{ preventScroll: true \}\)/);
    expect(layout).toMatch(/\[location\.pathname\]/);
  });

  it('every page renders its h1 through PageHeader, which also sets the tab title', () => {
    const header = read('src/components/PageHeader.jsx');
    expect(header).toMatch(/document\.title = `\$\{title\} - \$\{SITE_NAME\}`/);
    for (const page of ['AboutPage', 'ChatPage', 'DocumentPage', 'KeysPage', 'NotFound', 'VaultPage', 'VerifyPage']) {
      expect(read(`src/pages/${page}.jsx`), page).toMatch(/<PageHeader/);
    }
  });
});

describe('focus is not dropped when the pressed control disappears', () => {
  it('DEFECT: KeysPage moves focus when it swaps the button the person pressed', () => {
    const src = read('src/pages/KeysPage.jsx');
    // These all unmount the focused control and render something else in its place:
    //   create -> BackupStep (the form is removed)            line of "onCreated"
    //   "Skip the backup" / "Go back" / "I have saved the backup, continue"
    //   "Download a fresh backup" -> form, "Cancel" -> button  (FreshBackup, setOpen)
    //   "Forget this identity" -> form, "Cancel" -> button      (ForgetIdentity, setOpen)
    expect(lineOf(src, 'setSkipping(true)')).toBeGreaterThan(0);
    expect(lineOf(src, 'setOpen(true)')).toBeGreaterThan(0);
    expect(/\.focus\(/.test(src), 'KeysPage.jsx never calls focus(), so keyboard focus falls back to the top of the page').toBe(true);
  });

  it('DEFECT: DocumentPage keeps focus when the loading view is replaced by the result', () => {
    const src = read('src/pages/DocumentPage.jsx');
    // Layout focuses the h1 of the "Checking the document" view. When the load ends, a different
    // element tree is returned (phase ready or error), the focused h1 is destroyed and focus is lost.
    expect(lineOf(src, "if (phase === 'loading')")).toBeGreaterThan(0);
    expect(/\.focus\(/.test(src), 'DocumentPage.jsx never calls focus() after the load ends').toBe(true);
  });

  it('DEFECT: cancelling a reply puts focus back in the message box', () => {
    const src = read('src/components/chat/ChannelView.jsx');
    const m = src.match(/onCancelReply=\{([^\n]*)\}/);
    expect(m, 'onCancelReply handler').toBeTruthy();
    // The Cancel button is inside the reply bar, which is removed as soon as replyTo is cleared.
    expect(/focus/.test(m[1]), 'onCancelReply is ' + m[1]).toBe(true);
  });

  it('DEFECT: closing the mobile menu with Escape returns focus to the menu button', () => {
    const src = read('src/components/Nav.jsx');
    const handler = src.slice(src.indexOf('function onKey'), src.indexOf('document.addEventListener'));
    // Focus can be on a link inside the menu. display:none removes it and focus is lost.
    expect(/focus/.test(handler), 'the Escape handler only calls setOpen(false)').toBe(true);
  });

  it('removing a file from the drop zone returns focus to the file input (works)', () => {
    expect(read('src/components/vault/DropZone.jsx')).toMatch(/inputRef\.current\.focus\(\)/);
  });

  it('a finished publish moves focus to the result heading (works)', () => {
    expect(read('src/components/vault/PublishResult.jsx')).toMatch(/headRef\.current\.focus\(\)/);
  });

  it('sending a chat message returns focus to the box (works)', () => {
    expect(read('src/components/chat/Composer.jsx')).toMatch(/ref\.current\.focus\(\)/);
  });
});

describe('the outcome of an irreversible action is announced', () => {
  it('DEFECT: revoking a document says that it worked', () => {
    const src = read('src/components/doc/RevokePanel.jsx');
    // On success onRevoked() reloads the page data. The revoke panel is then removed because the
    // document is revoked (DocumentPage: access.allowed is false), taking the focused button with
    // it. Nothing in RevokePanel or DocumentPage reports success: no toast, no status text, no focus.
    const page = read('src/pages/DocumentPage.jsx');
    const announces = /useToast|toast\.push|role="status"|role="alert"|aria-live/.test(src) || /useToast|toast\.push/.test(page);
    expect(announces, 'no success message or focus move after "Revoke this document"').toBe(true);
  });

  it('publishing a new version shows a success callout (works)', () => {
    expect(read('src/components/doc/PublishVersion.jsx')).toMatch(/Version \$\{done\.version\} is published/);
  });
});

describe('timing', () => {
  it('toasts that carry errors or warnings stay long enough (9 s) and can be dismissed', () => {
    const src = read('src/components/Toast.jsx');
    expect(src).toMatch(/tone === 'bad' \|\| tone === 'warn' \? 9000 : 5000/);
    expect(src).toMatch(/aria-label="Dismiss message"/);
  });

  it('no toast with an error or warning tone is pushed anywhere (so nothing important disappears by itself)', () => {
    for (const file of ['src/pages/KeysPage.jsx', 'src/components/doc/PublishVersion.jsx', 'src/components/doc/RevokePanel.jsx']) {
      expect(read(file), file).not.toMatch(/push\(\{\s*tone:\s*'(bad|warn)'/);
    }
  });
});
