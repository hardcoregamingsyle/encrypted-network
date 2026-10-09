// Stylesheet review: focus rings, motion, units, touch targets, print, and long strings.
import { describe, expect, it } from 'vitest';
import { allRules, declValue, read, walk } from './helpers.js';

const rules = allRules();
const css = (rel) => read(rel);

function remValue(text) {
  if (!text) return null;
  const m = text.match(/^([\d.]+)(rem|px)$/);
  if (!m) return null;
  return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
}

const TOKEN_REM = {
  '--tap-size': 2.75
};

function sizeOf(text) {
  const v = text && text.match(/^var\((--[a-z-]+)\)$/);
  if (v && TOKEN_REM[v[1]]) return TOKEN_REM[v[1]] * 16;
  return remValue(text);
}

describe('focus', () => {
  it('there is a global visible focus ring that uses the focus token', () => {
    const rule = rules.find((r) => r.selector === ':focus-visible' && r.file.endsWith('base.css'));
    expect(rule).toBeTruthy();
    expect(declValue(rule.body, 'outline')).toMatch(/^3px solid var\(--color-focus\)$/);
  });

  it('outline is only removed on elements that receive focus from script, never on controls', () => {
    const removed = rules.filter((r) => /^none$|^0$/.test(declValue(r.body, 'outline') || '')).map((r) => r.selector);
    expect(removed.sort()).toEqual(['.vault-result__head h2:focus', 'h1:focus', 'main:focus']);
  });

  it('the skip link is hidden off screen and shown on focus', () => {
    const hidden = rules.find((r) => r.selector === '.ui-skip' && !r.media);
    const shown = rules.find((r) => r.selector === '.ui-skip:focus');
    expect(declValue(hidden.body, 'transform')).toMatch(/translateY\(-/);
    expect(declValue(shown.body, 'transform')).toBe('none');
  });

  it('the sticky header does not cover focused or linked content', () => {
    const html = rules.find((r) => r.selector === 'html' && r.file.endsWith('base.css'));
    expect(declValue(html.body, 'scroll-padding-top')).toMatch(/nav-height/);
  });
});

describe('motion', () => {
  it('prefers-reduced-motion switches off every animation and transition', () => {
    const rule = rules.find((r) => r.media.includes('prefers-reduced-motion') && r.selector === '*');
    expect(rule).toBeTruthy();
    expect(rule.body).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(rule.body).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
    expect(rule.body).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(rule.body).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it('nothing sets scroll-behavior: smooth', () => {
    for (const file of walk('src/styles', ['.css'])) expect(css(file)).not.toMatch(/scroll-behavior:\s*smooth/);
  });
});

describe('units and zoom', () => {
  const files = walk('src/styles', ['.css']);

  it('font sizes and media queries are in rem, not px', () => {
    for (const file of files) {
      const text = css(file);
      expect(text, file).not.toMatch(/font-size:\s*[\d.]+px/);
      expect(text, file).not.toMatch(/@media[^{]*\(\s*(min|max)-width:\s*[\d.]+px/);
    }
  });

  it('no fixed height can clip text: heights on text containers are min-height or scroll areas', () => {
    const risky = [];
    for (const r of rules) {
      const height = declValue(r.body, 'height');
      const overflow = declValue(r.body, 'overflow') || declValue(r.body, 'overflow-y');
      if (!height || !/rem|px|%|vh/.test(height)) continue;
      const decorative = /(skel|bars|bar|ring|dot|tick|icon|toggle|close|spinner|mark|bars span|checkbox|radio|sr-only)/i.test(r.selector);
      if (decorative) continue;
      if (/overflow/.test(r.body) && /auto|scroll/.test(overflow || '')) continue;
      risky.push(`${r.file} ${r.selector} height: ${height}`);
    }
    expect(risky).toEqual([]);
  });

  it('the page text size follows the browser setting (no font-size on html or body in px)', () => {
    const html = rules.filter((r) => r.selector === 'html' || r.selector === 'body');
    for (const r of html) expect(declValue(r.body, 'font-size') || '').not.toMatch(/px/);
  });
});

describe('touch targets', () => {
  const buttons = [
    ['.ui-btn', 'min-height'],
    ['.ui-btn--sm', 'min-height'],
    ['.ui-nav__toggle', 'height'],
    ['.ui-nav__link', 'min-height'],
    ['.ui-nav__chip', 'min-height'],
    ['.ui-toast__close', 'height'],
    ['.chat-newbtn', 'min-height'],
    ['.verify-toc a', 'min-height'],
    ['.verify-details-toggle > summary', 'min-height']
  ];

  it('every control is at least 24 px high (WCAG 2.2, 2.5.8)', () => {
    const small = [];
    for (const [selector, prop] of buttons) {
      const found = rules.filter((r) => r.selector === selector && !r.media);
      expect(found.length, selector).toBeGreaterThan(0);
      const px = sizeOf(declValue(found[0].body, prop));
      if (px === null || px < 24) small.push(`${selector} ${prop} ${px}`);
    }
    expect(small).toEqual([]);
  });

  it('the main controls reach the 44 px recommendation, and the known smaller ones are listed here', () => {
    const below = [];
    for (const [selector, prop] of buttons) {
      const r = rules.find((x) => x.selector === selector && !x.media);
      const px = sizeOf(declValue(r.body, prop));
      if (px < 44) below.push(`${selector}=${px}`);
    }
    // These are small on purpose (compact buttons). If a new one appears, decide if it is fine.
    expect(below.sort()).toEqual(['.chat-newbtn=36', '.ui-btn--sm=36', '.ui-toast__close=32']);
  });
});

describe('disclosure widgets', () => {
  it('DEFECT: a styled <summary> still shows that it opens (marker kept or replaced)', () => {
    // display:flex on summary turns off its list-item marker, so the triangle disappears. Nothing
    // draws a replacement, so the closed section looks like a plain heading with no hint to open it.
    const summaryRules = rules.filter((r) => /summary/.test(r.selector) && !/\[open\]/.test(r.selector));
    const hidesMarker = summaryRules.some((r) => /^(flex|grid|block|inline-flex)$/.test(declValue(r.body, 'display') || ''));
    const restores = rules.some((r) => /summary(::before|::after|::marker|::-webkit-details-marker)/.test(r.selector));
    expect(hidesMarker && !restores).toBe(false);
  });
});

describe('print', () => {
  it('the certificate is hidden on screen and the screen view is hidden in print', () => {
    const screen = rules.find((r) => r.selector === '.doc-cert' && !r.media);
    expect(declValue(screen.body, 'display')).toBe('none');
    const printCert = rules.find((r) => r.selector === '.doc-cert' && r.media.includes('print'));
    expect(declValue(printCert.body, 'display')).toBe('block');
    const printScreen = rules.find((r) => r.selector === '.doc-screen' && r.media.includes('print'));
    expect(declValue(printScreen.body, 'display')).toMatch(/none/);
  });

  it('print forces black on white and hides navigation, buttons and toasts', () => {
    const root = rules.find((r) => r.selector === ':root' && r.media.includes('print'));
    expect(declValue(root.body, '--color-text')).toBe('#000000');
    expect(declValue(root.body, 'color-scheme')).toBe('light');
    const hide = rules.filter((r) => r.media.includes('print') && /none/.test(declValue(r.body, 'display') || '')).map((r) => r.selector);
    for (const s of ['.ui-header', '.ui-footer', '.ui-skip', '.ui-toasts', '.ui-btn', 'button']) expect(hide).toContain(s);
  });

  it('print keeps status colours dark enough on white even when the system is in dark mode', () => {
    // Dark mode redefines the status colours as pale tints. If a printed page used them it would be
    // unreadable. The certificate sets its own colours, so it must not use the status tokens.
    const certRules = rules.filter((r) => r.media.includes('print') && r.selector.startsWith('.doc-cert'));
    for (const r of certRules) expect(r.body).not.toMatch(/--color-(good|warn|bad|info|accent)/);
  });

  it('certificate rows do not split across pages', () => {
    const row = rules.find((r) => r.selector === '.doc-cert__row');
    expect(declValue(row.body, 'break-inside')).toBe('avoid');
  });
});

describe('long unbroken strings and narrow screens', () => {
  it('DEFECT: single column grids use minmax(0, 1fr) so a long word cannot widen the page', () => {
    // 1fr means minmax(auto, 1fr). The body only has overflow-wrap: break-word, which does not
    // shrink the minimum size of a grid item, so one 40 letter channel id pushes the whole column
    // wider than a 320 px screen.
    const bad = rules
      .filter((r) => /^(\.ui-grid|\.keys-columns|\.chat-home|\.vault-layout)$/.test(r.selector) && !r.media)
      .filter((r) => /^1fr$/.test(declValue(r.body, 'grid-template-columns') || ''))
      .map((r) => r.selector);
    expect(bad).toEqual([]);
  });

  it('DEFECT: the channel id on a channel card can break anywhere', () => {
    const rule = rules.find((r) => r.selector === '.chat-channel__id');
    expect(declValue(rule.body, 'overflow-wrap') || declValue(rule.body, 'word-break') || '').toMatch(/anywhere|break-all/);
  });

  it('hashes, links and passwords wrap', () => {
    const must = [
      '.ui-hash--full',
      '.vault-result__link',
      '.vault-result__pw code',
      '.doc-secret__value',
      '.doc-linkline',
      '.doc-steplist__detail',
      '.verify-fp',
      '.verify-section .ui-hash',
      '.vault-doc__name',
      '.chat-msg__body',
      '.chat-quote__text'
    ];
    for (const selector of must) {
      const r = rules.find((x) => x.selector === selector);
      expect(r, selector).toBeTruthy();
      expect(declValue(r.body, 'overflow-wrap') || declValue(r.body, 'word-break') || '', selector).toMatch(/anywhere|break-all/);
    }
  });

  it('flex and grid children that hold text can shrink (min-width: 0)', () => {
    const must = [
      '.ui-page-header__text',
      '.ui-callout__body',
      '.vault-col',
      '.vault-doc__main',
      '.vault-result__value',
      '.chat-anchor__text',
      '.ui-kv dd',
      '.doc-card',
      '.verify-section__body'
    ];
    for (const selector of must) {
      const r = rules.find((x) => x.selector === selector);
      expect(r, selector).toBeTruthy();
      expect(declValue(r.body, 'min-width'), selector).toBe('0');
    }
  });

  it('the page has no fixed minimum width', () => {
    for (const r of rules) {
      const w = declValue(r.body, 'min-width');
      if (!w || r.media.includes('print')) continue;
      if (r.selector === '.ui-table-wrap table') continue; // scrolls inside its own wrapper
      expect(w, `${r.selector}`).toMatch(/^(0|auto|100%|min-content)$/);
    }
  });
});
