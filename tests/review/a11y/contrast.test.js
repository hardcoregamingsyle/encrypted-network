// WCAG 2.x colour contrast review. Tokens are read from src/styles/tokens.css for the light theme
// and for prefers-color-scheme: dark. Every pair below is a text colour on a background (or a
// non text colour for icons, focus rings and control borders) that the components really use.
// Text needs 4.5:1, large text and user interface parts need 3:1.
import { describe, expect, it } from 'vitest';
import { allRules, contrast, declValue, gradientStops, loadTokens, over, parseColor } from './helpers.js';

const TOKENS = loadTokens();

function colorOf(mode, name) {
  const key = '--color-' + name;
  const value = TOKENS[mode][key];
  if (!value) throw new Error(`token ${key} is missing in ${mode}`);
  return parseColor(value);
}

// layers are drawn bottom to top, the first one must be opaque.
function flatten(mode, layers) {
  let base = colorOf(mode, layers[0]);
  for (const name of layers.slice(1)) base = over(colorOf(mode, name), base);
  return base;
}

function ratio(mode, pair) {
  const bg = flatten(mode, pair.bg);
  let fg = colorOf(mode, pair.fg);
  if (pair.alpha !== undefined) fg = over({ ...fg, a: pair.alpha }, bg);
  return contrast(fg, bg);
}

const TEXT = 4.5;
const UI = 3;
const STATUS = ['good', 'warn', 'bad', 'info'];

// ---------- text pairs ----------
const pairs = [];
function add(where, fg, bg, min = TEXT, extra = {}) {
  pairs.push({ where, fg, bg: Array.isArray(bg) ? bg : [bg], min, ...extra });
}

// body and surfaces
for (const s of ['bg', 'surface', 'surface-2', 'surface-3']) add(`body text on ${s}`, 'text', s);
add('.ui-skip (text on surface)', 'text', 'surface');
add('.ui-muted, .ui-field__hint on page background', 'text-muted', 'bg');
for (const s of ['surface', 'surface-2', 'surface-3']) add(`muted text on ${s}`, 'text-muted', s);
add('.ui-footer (muted on page background)', 'text-muted', 'bg');
add('.ui-page-header__lead (muted on page background)', 'text-muted', 'bg');
add('.ui-keybadge__id (muted on accent tint over surface)', 'text-muted', ['surface', 'accent-tint']);
add('.ui-nav__chip-id (muted on header surface)', 'text-muted', 'surface');
add('.chat-msg--own meta (muted on tint over surface)', 'text-muted', ['surface', 'accent-tint']);
add('.chat-msg__meta on unverified (muted on warn bg)', 'text-muted', 'warn-bg');
add('.chat-msg__meta on invalid (muted on bad bg)', 'text-muted', 'bad-bg');
add('.chat-msg--invalid .chat-msg__body (muted on bad bg)', 'text-muted', 'bad-bg');
add('.chat-msg__reason--soft inside a pending message (muted on tint over surface)', 'text-muted', ['surface', 'accent-tint']);
add('.ui-checks__detail on a failed check (muted on bad bg)', 'text-muted', 'bad-bg');
add('.chat-quote (muted on surface-3)', 'text-muted', 'surface-3');
add('.chat-replying__quote (muted on tint over surface)', 'text-muted', ['surface', 'accent-tint']);
add('.doc-steplist__item.is-todo (muted on surface-2)', 'text-muted', 'surface-2');
add('.doc-progress__list .is-done (muted on surface)', 'text-muted', 'surface');
add('.ui-hash--empty (muted on surface)', 'text-muted', 'surface');
add('input::placeholder (muted at 0.8 opacity on surface-2)', 'text-muted', 'surface-2', TEXT, { alpha: 0.8 });
add('textarea::placeholder in a card (muted at 0.8 opacity on surface-2)', 'text-muted', 'surface-2', TEXT, { alpha: 0.8 });

// links and accent text
for (const s of ['bg', 'surface', 'surface-2']) add(`links (accent-text) on ${s}`, 'accent-text', s);
add('.ui-btn--ghost (accent-text on surface)', 'accent-text', 'surface');
add('.ui-btn--ghost:hover (accent-text on tint over surface)', 'accent-text', ['surface', 'accent-tint']);
add('.ui-btn--ghost:hover on the page background (tint over bg)', 'accent-text', ['bg', 'accent-tint']);
add('.ui-nav__link[aria-current] (accent-text on tint over surface)', 'accent-text', ['surface', 'accent-tint']);
add('.ui-nav__brand (accent-text on header surface)', 'accent-text', 'surface');
add('.verify-toc a (accent-text on surface)', 'accent-text', 'surface');
add('.vault-drop__icon (accent-text on tint over surface-2)', 'accent-text', ['surface-2', 'accent-tint'], UI);
add('.ui-btn:hover text on tint over surface', 'text', ['surface', 'accent-tint']);
add('.ui-btn:hover text on tint over bg', 'text', ['bg', 'accent-tint']);
add('.ui-keybadge__name (text on tint over surface)', 'text', ['surface', 'accent-tint']);
add('.ui-keybadge__name (text on tint over bg)', 'text', ['bg', 'accent-tint']);
add('.chat-msg--own (text on tint over surface)', 'text', ['surface', 'accent-tint']);
add('.ui-nav__link:hover (text on tint over surface)', 'text', ['surface', 'accent-tint']);

// status text on its own background: callout, badge, anchor, hints, reasons
for (const t of STATUS) {
  add(`.ui-callout--${t}, .ui-badge--${t}, .chat-anchor--${t}`, t, `${t}-bg`);
  add(`.ui-callout--${t} .ui-callout__text (body text on ${t} bg)`, 'text', `${t}-bg`);
}
add('.doc-reason (bad on bad bg)', 'bad', 'bad-bg');
add('.doc-hint (warn on warn bg)', 'warn', 'warn-bg');
add('.doc-secret__title (warn on warn bg)', 'warn', 'warn-bg');
add('.doc-secret__value (text on warn bg)', 'text', 'warn-bg');
add('.verify-offline-tag (info on info bg)', 'info', 'info-bg');
add('.ui-btn--danger (bad on bad bg)', 'bad', 'bad-bg');
add('.chat-msg--failed .chat-msg__reason (bad on warn bg)', 'bad', 'warn-bg');
add('.chat-msg--unverified .chat-msg__reason (warn on warn bg)', 'warn', 'warn-bg');
add('.chat-msg--invalid .chat-msg__reason (bad on bad bg)', 'bad', 'bad-bg');
add('.chat-msg bodies (text on warn bg)', 'text', 'warn-bg');
add('.chat-msg bodies (text on bad bg)', 'text', 'bad-bg');
add('.doc-steplist__item.is-ok (text on good bg)', 'text', 'good-bg');
add('.doc-steplist__item.is-bad (text on bad bg)', 'text', 'bad-bg');
add('.ui-checks__item.is-bad name (text on bad bg)', 'text', 'bad-bg');
add('.doc-version (text on surface-2)', 'text', 'surface-2');
add('.ui-toast__text (text on surface)', 'text', 'surface');

// status text on neutral surfaces
add('.ui-field__error (bad on surface)', 'bad', 'surface');
add('.ui-field__error inside a surface-2 box (bad on surface-2)', 'bad', 'surface-2');
add('.chat-error (bad on surface)', 'bad', 'surface');
add('.chat-compose__count.is-near (warn on surface)', 'warn', 'surface');
add('.chat-compose__count.is-over (bad on surface)', 'bad', 'surface');
add('.vault-steps__item.is-done (good on surface-2)', 'good', 'surface-2');
add('.vault-steps__item.is-error (bad on surface-2)', 'bad', 'surface-2');

// buttons on the accent gradient (both stops of the normal and the hover gradient)
for (const g of ['--gradient-accent', '--gradient-accent-hover']) {
  for (const mode of ['light', 'dark']) {
    const stops = gradientStops(TOKENS[mode][g]);
    stops.forEach((stop, i) => {
      pairs.push({
        where: `.ui-btn--primary, .ui-nav__chip--cta, .chat-newbtn text on ${g} stop ${i + 1}`,
        fg: 'on-accent',
        bg: ['@' + JSON.stringify(stop)],
        min: TEXT,
        onlyMode: mode
      });
    });
  }
}

// ---------- non text pairs (3:1) ----------
for (const s of ['bg', 'surface', 'surface-2', 'surface-3']) add(`focus ring on ${s}`, 'focus', s, UI);
add('focus ring on tint over surface (chat reply bar, hovered rows)', 'focus', ['surface', 'accent-tint'], UI);
add('text input border on its own fill (surface-2)', 'border-strong', 'surface-2', UI);
add('text input border against the card behind it (surface)', 'border-strong', 'surface', UI);
add('textarea.chat-compose__input border on surface-2', 'border-strong', 'surface-2', UI);
add('checkbox and radio accent on surface', 'accent', 'surface', UI);
add('invalid input border (bad) on surface-2', 'bad', 'surface-2', UI);
add('.vault-drop dashed border on surface-2 (the drop target outline)', 'border-strong', 'surface-2', UI);
add('input[type=file] dashed border on surface-2', 'border-strong', 'surface-2', UI);
for (const t of STATUS) add(`.ui-toast--${t} icon on surface`, t, 'surface', UI);
add('.ui-checks__item.is-ok mark (good on surface)', 'good', 'surface', UI);
add('.ui-checks__item.is-bad mark (bad on bad bg)', 'bad', 'bad-bg', UI);
add('.doc-steplist__item.is-ok mark (good on good bg)', 'good', 'good-bg', UI);
add('.vault-result__tick (good on good bg)', 'good', 'good-bg', UI);
add('.keys-strength level 1 bar (bad on surface)', 'bad', 'surface', UI);
add('.keys-strength level 2 bar (warn on surface)', 'warn', 'surface', UI);
add('.keys-strength level 3 and 4 bars (good on surface)', 'good', 'surface', UI);
add('.verify-alarm border (bad on page background)', 'bad', 'bg', UI);

function evaluate(mode) {
  const rows = [];
  for (const pair of pairs) {
    if (pair.onlyMode && pair.onlyMode !== mode) continue;
    let r;
    if (pair.bg[0].startsWith('@')) {
      const bg = JSON.parse(pair.bg[0].slice(1));
      r = contrast(colorOf(mode, pair.fg), bg);
    } else {
      r = ratio(mode, pair);
    }
    rows.push({ ...pair, mode, ratio: r });
  }
  return rows;
}

function report(rows) {
  return rows
    .filter((r) => r.ratio < r.min)
    .map((r) => `${r.mode}: ${r.ratio.toFixed(2)}:1 < ${r.min}:1  ${r.fg} on ${r.bg.join('+')}  (${r.where})`);
}

describe('token parsing', () => {
  it('finds the light and dark tokens used by the pairs', () => {
    for (const mode of ['light', 'dark']) {
      for (const name of ['bg', 'surface', 'surface-2', 'surface-3', 'text', 'text-muted', 'accent-text', 'border-strong', 'focus']) {
        expect(TOKENS[mode]['--color-' + name], `${mode} ${name}`).toBeTruthy();
      }
    }
    expect(TOKENS.dark['--color-surface']).not.toBe(TOKENS.light['--color-surface']);
  });

  it('the contrast maths agree with known values', () => {
    expect(contrast(parseColor('#000000'), parseColor('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(parseColor('#777777'), parseColor('#ffffff'))).toBeCloseTo(4.48, 1);
  });

  it('every custom property used in a stylesheet is defined in tokens.css', () => {
    const defined = new Set(Object.keys(TOKENS.light));
    const missing = [];
    for (const rule of allRules()) {
      for (const m of rule.body.matchAll(/var\((--[a-z0-9-]+)/gi)) {
        if (!defined.has(m[1])) missing.push(`${rule.file} ${rule.selector}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

for (const mode of ['light', 'dark']) {
  describe('WCAG contrast, ' + mode + ' theme', () => {
    it('text pairs pass 4.5:1 (1.4.3), including placeholder text', () => {
      expect(report(evaluate(mode).filter((r) => r.min === TEXT))).toEqual([]);
    });

    it('icons, focus rings and control borders pass 3:1 (1.4.11)', () => {
      expect(report(evaluate(mode).filter((r) => r.min === UI))).toEqual([]);
    });
  });
}

// The pairs above are written by hand, so also derive pairs from the stylesheets themselves:
// any rule that sets a colour and a background token together.
describe('pairs derived from the stylesheets', () => {
  function tokenName(value) {
    const m = value && value.match(/^var\(--color-([a-z0-9-]+)\)$/);
    return m ? m[1] : null;
  }
  it('same-rule colour and background tokens pass 4.5:1 in both themes', () => {
    const fails = [];
    let seen = 0;
    for (const rule of allRules()) {
      if (rule.media.includes('print')) continue;
      const fg = tokenName(declValue(rule.body, 'color'));
      const bg = tokenName(declValue(rule.body, 'background') || declValue(rule.body, 'background-color'));
      if (!fg || !bg || fg === 'on-accent') continue;
      seen += 1;
      for (const mode of ['light', 'dark']) {
        const layers = bg === 'accent-tint' ? ['surface', 'accent-tint'] : [bg];
        const r = contrast(colorOf(mode, fg), flatten(mode, layers));
        if (r < TEXT) fails.push(`${mode} ${r.toFixed(2)}:1 ${rule.file} ${rule.selector} ${fg} on ${bg}`);
      }
    }
    expect(seen).toBeGreaterThan(15);
    expect(fails).toEqual([]);
  });
});
