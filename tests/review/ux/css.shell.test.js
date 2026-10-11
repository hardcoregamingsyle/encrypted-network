// Stylesheet review of the new shell (reviewer r3-ux): touch targets at phone width, safe areas, focus
// rings that can be clipped, long words at 360 px, reduced motion and the printed certificate.
// The css is read as text; media queries are resolved for a given width.
import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { all, parseHtml } from '../a11y/html.js';
import ScreenHeader from '../../../src/components/ScreenHeader.jsx';
import { allRules, declValue, read, walk } from '../a11y/helpers.js';
import { px, render, valueAt } from './helpers.js';

const rules = allRules();
const TOKENS = { '--tap-size': 44, '--tabs-height': 64, '--nav-height': 56 };
const PHONE = 22.5; // 360 px
const DESKTOP = 70; // 1120 px

function size(selector, prop, width) {
  return px(valueAt(rules, selector, prop, width), TOKENS);
}

describe('touch targets at 360 px (44 px asked for the main controls, 24 px is the floor)', () => {
  // [selector, property, why it matters]
  const MAIN = [
    ['.ui-btn', 'min-height', 'every button'],
    ['.ui-btn--sm', 'min-height', 'Send a new code, Remove, Try again'],
    ['.ui-tabbar__link', 'min-height', 'the four tabs'],
    ['.ui-fab', 'min-height', 'the + button'],
    ['.ui-screen-header__back', 'min-height', 'back arrow'],
    ['.ui-screen-header__back', 'width', 'back arrow'],
    ['.ui-sheet__close', 'min-height', 'close a sheet'],
    ['.ui-sheet__close', 'width', 'close a sheet'],
    ['.chat-iconbtn', 'min-height', 'reply and more next to a bubble'],
    ['.chat-iconbtn', 'width', 'reply and more next to a bubble'],
    ['.chat-send', 'min-height', 'send'],
    ['.chat-send', 'width', 'send'],
    ['.chat-newbtn', 'min-height', 'scroll to the newest message'],
    ['.chat-newbtn', 'width', 'scroll to the newest message'],
    ['.chat-strip__more', 'min-height', 'Details in the room'],
    ['.me-switch__btn', 'min-height', 'Easy or Strict switch'],
    ['.me-switch__btn', 'width', 'Easy or Strict switch'],
    ['.files-seg__btn', 'min-height', 'Mine or Public'],
    ['.ui-item', 'min-height', 'rows of chats and files'],
    ['.ui-toast__close', 'width', 'dismiss a toast'],
    ['.ui-toast__close', 'height', 'dismiss a toast'],
    ['.ui-banner__link', 'min-height', 'Finish signing in'],
    ['.signin__back', 'min-height', 'back on the sign in card'],
    ['.welcome__links a', 'min-height', 'links on the welcome screen'],
    ['.ui-otp__box', 'min-height', 'code boxes'],
    ['.doc-details > summary', 'min-height', 'Details on the file page'],
    ['.vsum__details > summary', 'min-height', 'Details in the answer'],
    ['.verify-advanced__summary', 'min-height', 'Advanced on Verify'],
    ['.chat-msg__raw > summary', 'min-height', 'Show the text anyway'],
    ['.chat-menu__who > summary', 'min-height', 'Who wrote this']
  ];

  it('every main control is 44 px or more on a phone', () => {
    const small = [];
    for (const [selector, prop, why] of MAIN) {
      let value = size(selector, prop, PHONE);
      if (selector === '.chat-newbtn' && prop === 'width') value = size(selector, 'width', PHONE);
      if (value === null || value < 44) small.push(`${selector} ${prop}=${value} (${why})`);
    }
    expect(small).toEqual([]);
  });

  it('on a wide screen nothing drops below 24 px', () => {
    const tiny = [];
    for (const [selector, prop, why] of MAIN) {
      const value = size(selector, prop, DESKTOP);
      if (value === null || value < 24) tiny.push(`${selector} ${prop}=${value} (${why})`);
    }
    expect(tiny).toEqual([]);
  });

  it('DEFECT: a tick box row (Make it public, I understand, Show the password) is 44 px high', () => {
    // .ui-check has no min-height, so the row is as tall as one line of text, about 25 px. The box
    // itself is 20 px. People with a thumb miss it, and these are the boxes that confirm a withdrawal.
    const value = size('.ui-check', 'min-height', PHONE);
    expect(value ?? 0).toBeGreaterThanOrEqual(44);
  });

  it('the six code boxes still fit on a 320 px screen and keep 24 px or more of width', () => {
    // sign in card: 16 px page padding and 16 px card padding on both sides, 1 px border, 8 px gaps
    const inner = 320 - 2 * 16 - 2 * 16 - 2;
    const each = (inner - 5 * 8) / 6;
    expect(each).toBeGreaterThanOrEqual(24);
    expect(px(valueAt(rules, '.ui-otp__box', 'max-width', PHONE))).toBeGreaterThanOrEqual(each);
  });
});

describe('safe areas and the keyboard', () => {
  const INSET = /env\(safe-area-inset-bottom/;
  function usesInset(selector) {
    return rules.some((r) => r.selector === selector && INSET.test(r.body));
  }

  it('everything fixed to the bottom keeps clear of the home bar', () => {
    for (const selector of ['.ui-tabbar', '.ui-main', '.ui-footer', '.ui-fab', '.ui-toasts', '.ui-sheet', '.chat-compose', '.chat-compose--signin']) {
      expect(usesInset(selector), selector).toBe(true);
    }
  });

  it('the page is tall enough for the keyboard: the room and the sheet use dvh (not vh) last', () => {
    const body = (selector) => rules.find((r) => r.selector === selector && !r.media).body;
    expect(body('.chat-room')).toMatch(/max-height:\s*100vh;[\s\S]*max-height:\s*100dvh/);
    expect(body('.ui-sheet')).toMatch(/max-height:\s*92vh;[\s\S]*max-height:\s*92dvh/);
  });

  it('DEFECT: full width bars keep clear of a notch when the phone is turned sideways', () => {
    // The viewport says viewport-fit=cover, so the page reaches under the notch in landscape. No rule
    // uses safe-area-inset-left or -right, so the first letters of the tab bar, the header and the
    // writing box can sit behind it.
    const css = walk('src/styles', ['.css']).map((f) => read(f)).join('\n');
    expect(/safe-area-inset-(left|right)/.test(css)).toBe(true);
  });
});

describe('focus rings that can be cut off', () => {
  it('DEFECT: rows inside a box with overflow hidden draw their focus ring inside the row', () => {
    // .files-list and .me-rows have overflow: hidden (for the rounded corners). The global ring is
    // drawn 2 px outside the row, so the box cuts it off at the left, the right and the ends. With a
    // single file in the list, a keyboard user sees no ring at all.
    const clipping = rules.filter((r) => /overflow:\s*hidden/.test(r.body) && /^(\.files-list|\.me-rows)$/.test(r.selector)).map((r) => r.selector);
    expect(clipping.sort()).toEqual(['.files-list', '.me-rows']);
    const inset = rules.filter(
      (r) => /(ui-item|me-row)[^,]*:focus-visible/.test(r.selector) && /outline-offset:\s*-/.test(r.body)
    );
    expect(inset.length).toBeGreaterThan(0);
  });

  it('no control removes its own outline', () => {
    const removed = rules.filter((r) => /^(none|0)$/.test(declValue(r.body, 'outline') || '')).map((r) => r.selector);
    expect(removed.sort()).toEqual(['.vault-result__head h2:focus', 'h1:focus', 'main:focus']);
  });
});

describe('long words at 360 px', () => {
  // Children of a row that holds names, labels or ids must be allowed to shrink, or one long word
  // pushes the page wider than the screen.
  const SHRINK = [
    '.ui-shell__body',
    '.ui-screen-header__text',
    '.ui-item__body',
    '.chat-row__link',
    '.chat-msg',
    '.chat-msg__col',
    '.chat-bubble',
    '.chat-filecard__text',
    '.chat-strip__text',
    '.chat-replying__text',
    '.me-profile__text',
    '.me-row__text',
    '.me-switch__text',
    '.files-done__text',
    '.files-body',
    '.doc-choice__text',
    '.doc-versions__text',
    '.vsum__text',
    '.ui-sidenav__who-text'
  ];
  it('row children that hold text can shrink (min-width: 0)', () => {
    const missing = SHRINK.filter((s) => !rules.some((r) => r.selector === s && declValue(r.body, 'min-width') === '0'));
    expect(missing).toEqual([]);
  });

  const WRAP = [
    '.chat-msg__body',
    '.chat-quote__text',
    '.chat-menu__quote',
    '.me-profile__name',
    '.me-profile__line',
    '.files-done__text',
    '.vsum__headline',
    '.vsum__line',
    '.doc-versions__line',
    '.doc-versions__sub',
    '.chat-channel__id',
    '.ui-keybadge__name'
  ];
  it('text people write or that comes from the server breaks inside a long word', () => {
    const missing = WRAP.filter((s) => !rules.some((r) => r.selector === s && /anywhere|break-all|break-word/.test(declValue(r.body, 'overflow-wrap') || declValue(r.body, 'word-break') || '')));
    expect(missing).toEqual([]);
  });

  it('single line titles end with an ellipsis instead of widening the row', () => {
    for (const s of ['.ui-item__title', '.ui-item__sub', '.chat-msg__name', '.ui-screen-header__title', '.ui-screen-header__sub', '.ui-sidenav__who-name']) {
      const r = rules.find((x) => x.selector === s);
      expect(declValue(r.body, 'text-overflow'), s).toBe('ellipsis');
      expect(declValue(r.body, 'overflow'), s).toBe('hidden');
    }
  });

  it('DEFECT: a screen title that is cut off with an ellipsis can still be read in full', () => {
    // The file page puts the file label in the h1 only, and the h1 is one line with an ellipsis, so
    // a label of about 16 characters is already cut at 360 px next to the Manage button. A title
    // attribute is the least that lets a mouse user read it; text wrapping to two lines would be better.
    const html = render(h(ScreenHeader, { title: 'Land record 2026-114 annex B.pdf', back: true }), 'out');
    const title = all(parseHtml(html), (e) => e.tag === 'h1')[0];
    const wraps = /white-space:\s*normal/.test(rules.find((r) => r.selector === '.ui-screen-header__title').body);
    expect(Boolean(title.attrs.title) || wraps).toBe(true);
  });
});

describe('motion', () => {
  it('the global reduced motion rule still switches off animation and transitions', () => {
    const rule = rules.find((r) => r.media.includes('prefers-reduced-motion') && r.selector === '*');
    expect(rule.body).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(rule.body).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
  });

  it('no script asks for smooth scrolling', () => {
    const bad = walk('src', ['.js', '.jsx']).filter((f) => /behavior:\s*['"]smooth/.test(read(f)));
    expect(bad).toEqual([]);
  });

  it('the spinner still says "Loading" in words when its ring stops turning', () => {
    expect(read('src/components/Spinner.jsx')).toMatch(/ui-sr-only/);
  });
});

describe('printing the certificate from the new shell', () => {
  const hiddenInPrint = rules.filter((r) => r.media.includes('print') && /display:\s*none/.test(r.body)).map((r) => r.selector);

  it('all the new navigation and floating parts are hidden in print', () => {
    for (const s of ['.ui-sidenav', '.ui-tabbar', '.ui-fab', '.ui-screen-header', '.ui-banner', '.ui-sheet-root', '.ui-toasts', '.ui-skip', '.ui-footer', 'button']) {
      expect(hiddenInPrint, s).toContain(s);
    }
  });

  it('the screen view of the file page is hidden and the certificate is shown', () => {
    const screen = rules.find((r) => r.selector === '.doc-screen' && r.media.includes('print'));
    expect(declValue(screen.body, 'display')).toMatch(/none/);
    const cert = rules.find((r) => r.selector === '.doc-cert' && r.media.includes('print'));
    expect(declValue(cert.body, 'display')).toBe('block');
    const onScreen = rules.find((r) => r.selector === '.doc-cert' && !r.media);
    expect(declValue(onScreen.body, 'display')).toBe('none');
  });

  it('the page frame adds no padding or height in print, so the certificate starts at the top of page one', () => {
    const main = rules.find((r) => r.selector === '.ui-main' && r.media.includes('print'));
    expect(declValue(main.body, 'padding')).toBe('0');
    const body = rules.find((r) => r.selector === 'body' && r.media.includes('print'));
    expect(declValue(body.body, 'background')).toBe('#ffffff');
  });
});

describe('live regions that start empty', () => {
  it('DEFECT: no live region is taken out of the page with display: none while it is empty', () => {
    // A role="alert" or role="status" element that is display: none when empty is not in the page for a
    // screen reader, so text that arrives later is often not announced. The sign in page has the right
    // pattern for its own notes (clip, keep in the page). The code box error line uses display: none.
    const hidden = rules.filter((r) => /:empty$/.test(r.selector) && /display:\s*none/.test(r.body)).map((r) => r.selector);
    const alerts = ['ui-otp__error'];
    const bad = hidden.filter((s) => alerts.some((a) => s.includes(a)));
    expect(bad).toEqual([]);
  });
});
