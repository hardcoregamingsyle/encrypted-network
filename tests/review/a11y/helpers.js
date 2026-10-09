// Shared helpers for the accessibility review tests: css reading, colour maths and file lists.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

export function walk(rel, exts) {
  const out = [];
  function go(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) go(full);
      else if (exts.some((e) => name.endsWith(e))) out.push(relative(ROOT, full).replace(/\\/g, '/'));
    }
  }
  go(join(ROOT, rel));
  return out.sort();
}

// ---------- css ----------

export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Reads `--name: value;` pairs out of a block of declarations.
function declarations(block) {
  const map = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) map[m[1]] = m[2].trim();
  return map;
}

// Returns { light, dark } maps of custom properties from tokens.css.
// dark = light with the prefers-color-scheme: dark overrides applied.
export function loadTokens() {
  const css = stripComments(read('src/styles/tokens.css'));
  const rootMatch = css.match(/^:root\s*\{([\s\S]*?)\n\}/m);
  const darkMatch = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n\s*\}\s*\}/);
  const light = declarations(rootMatch[1]);
  const dark = { ...light, ...declarations(darkMatch[1]) };
  return { light, dark };
}

// A flat list of rules: { selector, body, media } for every css file in src/styles.
export function loadRules(file) {
  const css = stripComments(read(file));
  const rules = [];
  function parse(text, media) {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open === -1) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) parse(body, head.replace(/^@media\s*/, ''));
      else if (head.startsWith('@keyframes') || head.startsWith('@font-face')) {
        // skip
      } else {
        for (const sel of head.split(',')) rules.push({ selector: sel.trim(), body, media, file });
      }
      i = j;
    }
  }
  parse(css, '');
  return rules;
}

export function allRules() {
  return walk('src/styles', ['.css']).flatMap(loadRules);
}

export function declValue(body, prop) {
  const m = body.match(new RegExp('(?:^|;|\\s)' + prop + '\\s*:\\s*([^;]+)', 'i'));
  return m ? m[1].trim() : null;
}

// ---------- colour ----------

export function parseColor(text) {
  const t = text.trim().toLowerCase();
  let m = t.match(/^#([0-9a-f]{6})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = t.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = t.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error('cannot parse colour: ' + text);
}

// Draws `top` (maybe translucent) over the opaque colour `under`.
export function over(top, under) {
  const a = top.a;
  return {
    r: top.r * a + under.r * (1 - a),
    g: top.g * a + under.g * (1 - a),
    b: top.b * a + under.b * (1 - a),
    a: 1
  };
}

function channel(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(c) {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// Colour stops of a linear-gradient(...) value.
export function gradientStops(value) {
  return [...value.matchAll(/#[0-9a-f]{6}/gi)].map((m) => parseColor(m[0]));
}
