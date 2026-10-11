// WCAG colour contrast of the new shell (reviewer r3-ux). tests/review/a11y/contrast.test.js has the old
// list of pairs; this file adds the pairs of the chat app screens and does not edit that file.
// Tokens come from src/styles/tokens.css, light and dark. Text needs 4.5:1, user interface parts and
// the marks that show a state need 3:1 (1.4.3, 1.4.11). Each pair says where it is used.
import { describe, expect, it } from 'vitest';
import { allRules, contrast, declValue, gradientStops, loadTokens, over, parseColor } from '../a11y/helpers.js';

const TOKENS = loadTokens();
const TEXT = 4.5;
const UI = 3;

function color(mode, name) {
  const value = TOKENS[mode]['--color-' + name];
  if (!value) throw new Error(`token --color-${name} is missing in ${mode}`);
  return parseColor(value);
}

// layers are drawn bottom to top, the first one is opaque
function flatten(mode, layers) {
  let base = color(mode, layers[0]);
  for (const name of layers.slice(1)) base = over(color(mode, name), base);
  return base;
}

// white at an alpha over a layer stack (the quote chip inside an own bubble)
function white(alpha, mode, layers) {
  return over({ r: 255, g: 255, b: 255, a: alpha }, flatten(mode, layers));
}

const pairs = [];
// opts.alpha: the foreground is drawn at this opacity. opts.fg: a function (mode, bg) -> colour.
function add(where, fg, bg, min = TEXT, opts = {}) {
  pairs.push({ where, fg, bg: Array.isArray(bg) ? bg : [bg], min, ...opts });
}

// ---------- message bubbles ----------
add('own bubble text', 'bubble-own-text', 'bubble-own');
add('own bubble time, tick and sending mark', 'bubble-own-meta', 'bubble-own');
add('other bubble text', 'bubble-other-text', 'bubble-other');
add('other bubble sender name (accent-text)', 'accent-text', 'bubble-other');
add('other bubble time (muted)', 'text-muted', 'bubble-other');
add('verified tick in an other bubble (good, it is an icon with hidden words)', 'good', 'bubble-other', UI);
add('quote chip inside an other bubble: muted text on surface-3', 'text-muted', 'surface-3');
add('quote chip inside an other bubble: sender name on surface-3', 'text', 'surface-3');
add('quote chip inside an own bubble: white text on 12 percent white over the bubble', 'bubble-own-text', 'bubble-own', TEXT, {
  fgBg: (mode) => ({ fg: color(mode, 'bubble-own-text'), bg: white(0.12, mode, ['bubble-own']) })
});
add('quote chip left bar inside an own bubble', 'bubble-own-meta', 'bubble-own', UI);
add('quote chip left bar inside an other bubble (accent)', 'accent', 'surface-3', UI);
add('not checked bubble: reason (warn) on warn background', 'warn', 'warn-bg');
add('failed check bubble: reason (bad) on bad background', 'bad', 'bad-bg');
add('failed check bubble: text on bad background', 'text', 'bad-bg');
add('"Show the text anyway" summary on warn background', 'text', 'warn-bg');
add('muted raw text inside a failed bubble', 'text-muted', 'bad-bg');
add('muted raw text inside a not checked bubble', 'text-muted', 'warn-bg');
add('red outline of a message that could not be sent (bad) on the wallpaper', 'bad', 'chat-bg', UI);

// ---------- the room ----------
add('date separator and notes on the wallpaper', 'text-muted', 'chat-bg');
add('"Unread messages" marker on the wallpaper', 'accent-text', 'chat-bg');
add('sending note under an own bubble (muted on wallpaper)', 'text-muted', 'chat-bg');
add('failed send note (bad) on the wallpaper', 'bad', 'chat-bg');
add('reply and more buttons next to a bubble: icon (muted) on the wallpaper', 'text-muted', 'chat-bg', UI);
add('reply and more buttons on hover: accent-text on tint over the wallpaper', 'accent-text', ['chat-bg', 'accent-tint']);
add('status strip (muted) on surface', 'text-muted', 'surface');
add('status strip, good icon', 'good', 'surface', UI);
add('status strip, warn icon', 'warn', 'surface', UI);
add('status strip, failed (bad on bad background)', 'bad', 'bad-bg');
add('"Details" link in the strip (accent-text) on surface', 'accent-text', 'surface');
add('scroll to newest button icon (text) on surface', 'text', 'surface', UI);
add('composer: placeholder at full opacity (muted on surface-2)', 'text-muted', 'surface-2');
add('composer: counter near the limit (warn on surface)', 'warn', 'surface');
add('composer: counter over the limit (bad on surface)', 'bad', 'surface');
add('composer: reply bar label (accent-text on tint over surface)', 'accent-text', ['surface', 'accent-tint']);
add('composer: reply bar quote (muted on tint over surface)', 'text-muted', ['surface', 'accent-tint']);
add('linked file card: icon on tint', 'accent-text', ['surface', 'accent-tint'], UI);
add('linked file card: second line (muted on surface)', 'text-muted', 'surface');

// ---------- tab bar, side navigation, header, + button ----------
add('tab bar, idle label', 'tab-idle', 'tab-bg');
add('tab bar, current label', 'tab-active', 'tab-bg');
add('tab bar, current marker bar (3 px) against the bar', 'tab-active', 'tab-bg', UI);
add('tab bar, idle icon', 'tab-idle', 'tab-bg', UI);
add('tab bar, hover label', 'text', 'tab-bg');
add('side navigation link', 'text', 'surface');
add('side navigation, current link (accent-text on tint over surface)', 'accent-text', ['surface', 'accent-tint']);
add('side navigation, hover link', 'text', ['surface', 'accent-tint']);
add('side navigation, "Sign in" call to action', 'accent-text', 'surface');
add('side navigation, second line under the name (muted, small)', 'text-muted', 'surface');
add('side navigation brand', 'accent-text', 'surface');
add('screen header title', 'text', 'surface');
add('screen header second line ("Public chat")', 'text-muted', 'surface');
add('screen header back arrow on hover tint', 'text', ['surface', 'accent-tint'], UI);
add('banner "One more step" text', 'text', 'info-bg');
add('banner link', 'accent-text', 'info-bg');
add('unread count badge', 'badge-text', 'badge-bg');

// ---------- sheets, toasts, code boxes ----------
add('sheet title', 'text', 'surface');
add('sheet description', 'text-muted', 'surface');
add('sheet close icon', 'text', 'surface', UI);
add('sheet close icon on hover (surface-3)', 'text', 'surface-3', UI);
add('sheet grip against the sheet', 'border-strong', 'surface', UI);
add('sheet text on hover rows (tint)', 'text', ['surface', 'accent-tint']);
add('code box digit', 'text', 'surface-2');
add('code box border', 'border-strong', 'surface-2', UI);
add('code box border against the card behind it', 'border-strong', 'surface', UI);
add('code box border in the error state (bad) against its fill', 'bad', 'surface-2', UI);
add('code box error line', 'bad', 'surface');
add('field error line in a sheet', 'bad', 'surface');
add('field hint in a sheet', 'text-muted', 'surface');
add('welcome lead (muted on page background)', 'text-muted', 'bg');
add('welcome note under Quick start (muted on page background)', 'text-muted', 'bg');
add('welcome links (accent-text on page background)', 'accent-text', 'bg');
add('sign in card hint', 'text-muted', 'surface');
for (const tone of ['good', 'warn', 'bad', 'info']) {
  add(`toast ${tone} icon`, tone, 'surface', UI);
  add(`toast ${tone} text`, 'text', 'surface');
}
add('toast close icon', 'text', 'surface', UI);
add('toast border (strong) against the page it floats on', 'border-strong', 'bg', UI);

// ---------- files, chips, empty states, Me ----------
add('file list row title', 'text', 'surface');
add('file list row second line', 'text-muted', 'surface');
add('file list row time', 'text-muted', 'surface');
add('file row hovered: second line on tint over surface', 'text-muted', ['surface', 'accent-tint']);
add('file icon, default (muted on surface-3)', 'text-muted', 'surface-3', UI);
add('file icon, pdf (bad on bad background)', 'bad', 'bad-bg', UI);
add('file icon, image or document (info on info background)', 'info', 'info-bg', UI);
add('file icon, sheet (good on good background)', 'good', 'good-bg', UI);
add('file icon, slides (warn on warn background)', 'warn', 'warn-bg', UI);
add('file icon, audio or video (accent-text on tint over surface)', 'accent-text', ['surface', 'accent-tint'], UI);
for (const tone of ['good', 'warn', 'bad', 'info']) add(`status chip ${tone}`, tone, `${tone}-bg`);
add('Mine or Public switch, idle label (muted on surface-3)', 'text-muted', 'surface-3');
add('Mine or Public switch, selected label (accent-text on surface)', 'accent-text', 'surface');
add('empty state text', 'text-muted', 'bg');
add('"Published." tick on good background', 'good', 'good-bg', UI);
add('Me page: profile line (muted on page background)', 'text-muted', 'bg');
add('Me page: row second line (muted on surface)', 'text-muted', 'surface');
add('Me page: row icon (accent-text on surface)', 'accent-text', 'surface', UI);
add('Me page: switch state text (muted on surface)', 'text-muted', 'surface');
add('Me page: switch border when off against the card', 'border-strong', 'surface', UI);
add('Me page: switch when on against the card', 'accent', 'surface', UI);
add('Me page: switch thumb when off against its track', 'text-muted', 'surface-3', UI);
add('Me page: switch thumb when on against its track', 'surface', 'accent', UI);
add('inputs on the Verify page sit on the page background: border against it', 'border-strong', 'bg', UI);
add('inputs on the Verify page: border against the fill', 'border-strong', 'surface-2', UI);
add('Verify answer: good headline on good background', 'good', 'good-bg');
add('Verify answer: warn headline on warn background', 'warn', 'warn-bg');
add('Verify answer: bad headline on bad background', 'bad', 'bad-bg');
add('Verify answer: second line and trust line on good background', 'text-muted', 'good-bg');
add('Verify answer: trust line on warn background', 'text-muted', 'warn-bg');
add('Verify answer: trust line on bad background', 'text-muted', 'bad-bg');

// ---------- focus ring on every surface a control sits on ----------
for (const s of ['bg', 'surface', 'surface-2', 'surface-3', 'chat-bg', 'tab-bg', 'bubble-other', 'info-bg', 'warn-bg', 'bad-bg', 'good-bg']) {
  add(`focus ring on ${s}`, 'focus', s, UI);
}
add('focus ring on tint over surface (hovered list rows)', 'focus', ['surface', 'accent-tint'], UI);
add('focus ring on tint over the wallpaper', 'focus', ['chat-bg', 'accent-tint'], UI);

// ---------- the + button and primary buttons: white on both gradient stops, both themes ----------
for (const g of ['--gradient-accent', '--gradient-accent-hover']) {
  for (const mode of ['light', 'dark']) {
    gradientStops(TOKENS[mode][g]).forEach((stop, i) => {
      pairs.push({ where: `.ui-fab, .chat-send, .ui-btn--primary on ${g} stop ${i + 1}`, fg: 'on-accent', bg: ['@'], min: TEXT, onlyMode: mode, fixedBg: stop });
    });
  }
}

function evaluate(mode) {
  const rows = [];
  for (const pair of pairs) {
    if (pair.onlyMode && pair.onlyMode !== mode) continue;
    let fg;
    let bg;
    if (pair.fixedBg) {
      fg = color(mode, pair.fg);
      bg = pair.fixedBg;
    } else if (pair.fgBg) {
      ({ fg, bg } = pair.fgBg(mode));
    } else {
      bg = flatten(mode, pair.bg);
      fg = color(mode, pair.fg);
    }
    rows.push({ ...pair, mode, ratio: contrast(fg, bg) });
  }
  return rows;
}

function failures(rows) {
  return rows.filter((r) => r.ratio < r.min).map((r) => `${r.mode} ${r.ratio.toFixed(2)}:1 < ${r.min}:1  ${r.where}`);
}

for (const mode of ['light', 'dark']) {
  describe(`shell colours, ${mode} theme`, () => {
    it('text pairs reach 4.5:1', () => {
      expect(failures(evaluate(mode).filter((r) => r.min === TEXT))).toEqual([]);
    });
    it('icons, borders and focus rings reach 3:1', () => {
      expect(failures(evaluate(mode).filter((r) => r.min === UI))).toEqual([]);
    });
  });
}

// ---------- every text colour on every surface of the shell ----------

describe('colour matrix', () => {
  const NEUTRAL_TEXT = ['text', 'text-muted', 'accent-text'];
  const STATUS_TEXT = ['good', 'warn', 'bad', 'info'];
  const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3', 'chat-bg', 'tab-bg', 'bubble-other', 'good-bg', 'warn-bg', 'bad-bg', 'info-bg'];
  const NEUTRAL_SURFACES = ['bg', 'surface', 'surface-2', 'surface-3', 'chat-bg', 'tab-bg', 'bubble-other'];

  it('body, muted and link colours read on every surface, tinted or not, in both themes', () => {
    const fails = [];
    for (const mode of ['light', 'dark']) {
      for (const fg of NEUTRAL_TEXT) {
        for (const s of SURFACES) {
          for (const tint of [false, true]) {
            const layers = tint ? [s, 'accent-tint'] : [s];
            if (tint && s.endsWith('-bg') && s !== 'bg' && s !== 'chat-bg') continue;
            const r = contrast(color(mode, fg), flatten(mode, layers));
            if (r < TEXT) fails.push(`${mode} ${r.toFixed(2)}:1 ${fg} on ${layers.join('+')}`);
          }
        }
      }
    }
    expect(fails).toEqual([]);
  });

  it('good, warn, bad and info text read on the neutral surfaces and on their own background', () => {
    const fails = [];
    for (const mode of ['light', 'dark']) {
      for (const fg of STATUS_TEXT) {
        for (const s of [...NEUTRAL_SURFACES, `${fg}-bg`]) {
          const r = contrast(color(mode, fg), flatten(mode, [s]));
          if (r < TEXT) fails.push(`${mode} ${r.toFixed(2)}:1 ${fg} on ${s}`);
        }
      }
    }
    expect(fails).toEqual([]);
  });

  it('the stylesheets of the shell use only text tokens this matrix covers', () => {
    const files = ['nav.css', 'sheet.css', 'otp.css', 'chat.css', 'files.css', 'me.css', 'welcome.css', 'components.css', 'verify.css'];
    const known = new Set([...NEUTRAL_TEXT, ...STATUS_TEXT, 'on-accent', 'on-avatar', 'bubble-own-text', 'bubble-own-meta', 'bubble-other-text', 'tab-idle', 'tab-active', 'badge-text', 'surface']);
    const unknown = [];
    for (const rule of allRules()) {
      if (!files.some((f) => rule.file.endsWith(f)) || rule.media.includes('print')) continue;
      const m = (declValue(rule.body, 'color') || '').match(/^var\(--color-([a-z0-9-]+)\)$/);
      if (m && !known.has(m[1])) unknown.push(`${rule.file} ${rule.selector}: ${m[1]}`);
    }
    expect(unknown).toEqual([]);
  });
});

// ---------- marks that show a state (1.4.11 asks 3:1 for them) ----------

describe('state marks', () => {
  function ratioOf(mode, a, b) {
    return contrast(flatten(mode, a), flatten(mode, b));
  }

  it('the current tab is shown by a marker bar that reaches 3:1 (not by colour alone)', () => {
    for (const mode of ['light', 'dark']) expect(ratioOf(mode, ['tab-active'], ['tab-bg'])).toBeGreaterThanOrEqual(UI);
  });

  // The colour of the line a rule draws to show a state: a box-shadow, outline or border that uses a token.
  // null when the rule draws none. Tokens only, so the ratio can be worked out.
  function markColour(selector, file) {
    const rule = allRules().find((r) => r.file.endsWith(file) && r.selector === selector && !r.media);
    if (!rule) return null;
    const m = rule.body.match(/(?:box-shadow|outline|border(?:-left)?):[^;]*var\(--color-([a-z-]+)\)/);
    return m ? m[1] : null;
  }

  it('DEFECT: the current page in the side navigation is told apart from the others by 3:1 or more', () => {
    // The colour change (accent-text against text) and the 9 percent tint do not reach 3:1 by themselves,
    // so the current link also draws a 3 px bar in the tab bar colour (nav.css). The bar is what counts.
    const bar = markColour(".ui-sidenav__link[aria-current='page']", 'nav.css');
    expect(bar, 'the current link draws no bar, outline or border').toBeTruthy();
    const fails = [];
    for (const mode of ['light', 'dark']) {
      const colourChange = ratioOf(mode, ['accent-text'], ['text']);
      const tint = ratioOf(mode, ['surface', 'accent-tint'], ['surface']);
      const barAgainstRow = ratioOf(mode, [bar], ['surface', 'accent-tint']);
      if (Math.max(colourChange, tint, barAgainstRow) < UI) fails.push(`${mode}: text change ${colourChange.toFixed(2)}:1, tint ${tint.toFixed(2)}:1, bar ${barAgainstRow.toFixed(2)}:1`);
    }
    expect(fails).toEqual([]);
  });

  it('DEFECT: the chosen side of the Mine or Public switch is told apart from the other by 3:1 or more', () => {
    // The surface pill on the surface-3 track and the label colour do not reach 3:1 by themselves, so the
    // chosen side also draws a 2 px line in the accent colour (files.css). The line is what counts.
    const line = markColour('.files-seg__btn.is-on', 'files.css');
    expect(line, 'the chosen side draws no line').toBeTruthy();
    const fails = [];
    for (const mode of ['light', 'dark']) {
      const pill = ratioOf(mode, ['surface'], ['surface-3']);
      const label = ratioOf(mode, ['accent-text'], ['text-muted']);
      const edge = ratioOf(mode, [line], ['surface-3']);
      if (Math.max(pill, label, edge) < UI) fails.push(`${mode}: pill ${pill.toFixed(2)}:1, label ${label.toFixed(2)}:1, line ${edge.toFixed(2)}:1`);
    }
    expect(fails).toEqual([]);
  });
});

// ---------- opacity ----------

describe('opacity on text', () => {
  function opacityOf(file, selector) {
    const rule = allRules().find((r) => r.file.endsWith(file) && r.selector === selector && !r.media);
    const v = rule && declValue(rule.body, 'opacity');
    return v === null || v === undefined ? 1 : Number(v);
  }

  it('DEFECT: a list that is being refreshed (.files-stale) keeps its text readable', () => {
    // FileList puts files-stale (opacity 0.6) on the whole list while it reloads. Muted second lines
    // fall to about 3:1 and links to about 3:1, below 4.5:1, in both themes. It lasts a moment, but it
    // happens on every tab switch and every Load more.
    const opacity = opacityOf('files.css', '.files-stale');
    const fails = [];
    for (const mode of ['light', 'dark']) {
      for (const fg of ['text-muted', 'accent-text']) {
        const bg = flatten(mode, ['surface']);
        const shown = over({ ...color(mode, fg), a: opacity }, bg);
        const r = contrast(shown, bg);
        if (r < TEXT) fails.push(`${mode} ${fg} at ${opacity}: ${r.toFixed(2)}:1`);
      }
    }
    expect(fails).toEqual([]);
  });

  it('disabled controls are exempt from the rule, and the main disabled buttons stay recognisable (informational)', () => {
    // .ui-btn:disabled is drawn at 0.55 opacity. WCAG 1.4.3 exempts inactive components, so this is
    // a note, not a failure: a disabled primary button is about 2.5:1 in the light theme.
    expect(opacityOf('components.css', '.ui-btn:disabled')).toBe(0.55);
  });
});
