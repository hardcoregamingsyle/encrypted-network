// A tiny HTML reader and an accessibility linter for the output of react-dom/server.
// It is not a browser, so it checks structure and attributes only.

const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'source', 'col', 'wbr']);

function decode(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) {
    attrs[m[1]] = m[2] === undefined ? '' : decode(m[2]);
  }
  return attrs;
}

export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:[^>"]|"[^"]*")*?)(\/?)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      let n = cur;
      while (n && n.tag !== m[1].toLowerCase()) n = n.parent;
      if (n && n.parent) cur = n.parent;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const el = { tag, attrs: parseAttrs(m[3] || ''), children: [], parent: cur };
      cur.children.push(el);
      if (!VOID.has(tag) && !m[4]) cur = el;
    } else if (m[5] !== undefined) {
      cur.children.push(decode(m[5]));
    }
  }
  return root;
}

export function walkEls(node, fn) {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    fn(child);
    walkEls(child, fn);
  }
}

export function all(root, pred) {
  const out = [];
  walkEls(root, (el) => {
    if (pred(el)) out.push(el);
  });
  return out;
}

export function isHidden(el) {
  for (let n = el; n && n.tag !== '#root'; n = n.parent) {
    if (n.attrs['aria-hidden'] === 'true' || 'hidden' in n.attrs) return true;
  }
  return false;
}

export function textOf(el, { skipHidden = true } = {}) {
  let out = '';
  for (const child of el.children) {
    if (typeof child === 'string') out += child;
    else if (skipHidden && child.attrs['aria-hidden'] === 'true') continue;
    else out += ' ' + textOf(child, { skipHidden }) + ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function byId(root, id) {
  return all(root, (e) => e.attrs.id === id)[0] || null;
}

// Accessible name, simplified: aria-labelledby, aria-label, a label element, then content.
export function nameOf(root, el) {
  if (el.attrs['aria-labelledby']) {
    return el.attrs['aria-labelledby']
      .split(/\s+/)
      .map((id) => {
        const t = byId(root, id);
        return t ? textOf(t, { skipHidden: false }) : '';
      })
      .join(' ')
      .trim();
  }
  if (el.attrs['aria-label']) return el.attrs['aria-label'].trim();
  if (['input', 'textarea', 'select'].includes(el.tag)) {
    const labels = all(root, (e) => e.tag === 'label' && e.attrs.for && e.attrs.for === el.attrs.id);
    if (labels.length) return labels.map((l) => textOf(l)).join(' ');
    for (let n = el.parent; n; n = n.parent) if (n.tag === 'label') return textOf(n);
    return '';
  }
  if (el.tag === 'svg') return el.attrs.role === 'img' ? el.attrs['aria-label'] || '' : '';
  return textOf(el);
}

const ARIA_OK = new Set([
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-expanded', 'aria-hidden',
  'aria-live', 'aria-busy', 'aria-current', 'aria-invalid', 'aria-relevant', 'aria-atomic', 'aria-pressed',
  'aria-checked', 'aria-selected', 'aria-disabled', 'aria-required', 'aria-haspopup', 'aria-modal',
  'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext', 'aria-orientation', 'aria-multiline',
  'aria-readonly', 'aria-errormessage', 'aria-owns', 'aria-details', 'aria-roledescription'
]);
const ROLES_OK = new Set([
  'status', 'alert', 'note', 'log', 'search', 'img', 'button', 'navigation', 'main', 'region', 'list',
  'listitem', 'group', 'dialog', 'alertdialog', 'tablist', 'tab', 'tabpanel', 'progressbar', 'presentation', 'none'
]);
const LIVE_OK = new Set(['off', 'polite', 'assertive']);
const CURRENT_OK = new Set(['page', 'step', 'location', 'date', 'time', 'true', 'false']);
const NAMEABLE_PLAIN = new Set(['p', 'span', 'div', 'strong', 'em', 'code', 'li', 'dd', 'dt']);

// Returns a list of problem strings for one rendered page or component.
export function lint(html, { allowMissingMain = true, fragment = false } = {}) {
  const root = parseHtml(html);
  const problems = [];
  const push = (msg) => problems.push(msg);
  const tagStr = (e) => `<${e.tag}${e.attrs.class ? ' class="' + e.attrs.class + '"' : ''}${e.attrs.id ? ' id="' + e.attrs.id + '"' : ''}>`;

  // unique ids
  const seen = new Map();
  walkEls(root, (e) => {
    if (e.attrs.id !== undefined) seen.set(e.attrs.id, (seen.get(e.attrs.id) || 0) + 1);
  });
  for (const [id, n] of seen) if (n > 1) push(`duplicate id "${id}" (${n} times)`);

  // references
  walkEls(root, (e) => {
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      if (e.attrs[attr] === undefined) continue;
      for (const id of e.attrs[attr].split(/\s+/).filter(Boolean)) {
        if (!seen.has(id)) push(`${tagStr(e)} ${attr} points to missing id "${id}"`);
      }
    }
    if (e.tag === 'label' && e.attrs.for && !seen.has(e.attrs.for)) push(`${tagStr(e)} for="${e.attrs.for}" matches nothing`);
  });

  // attribute vocabulary
  walkEls(root, (e) => {
    for (const [k, v] of Object.entries(e.attrs)) {
      if (k.startsWith('aria-') && !ARIA_OK.has(k)) push(`${tagStr(e)} unknown attribute ${k}`);
      if (k === 'aria-live' && !LIVE_OK.has(v)) push(`${tagStr(e)} aria-live="${v}" is not valid`);
      if (k === 'aria-current' && !CURRENT_OK.has(v)) push(`${tagStr(e)} aria-current="${v}" is not valid`);
      if (['aria-expanded', 'aria-hidden', 'aria-busy', 'aria-invalid'].includes(k) && !['true', 'false'].includes(v) && !(k === 'aria-invalid' && ['grammar', 'spelling'].includes(v))) {
        push(`${tagStr(e)} ${k}="${v}" is not a boolean token`);
      }
      if (k === 'role' && !ROLES_OK.has(v)) push(`${tagStr(e)} role="${v}" is not in the known set`);
      if (k === 'tabindex' && Number(v) > 0) push(`${tagStr(e)} positive tabindex`);
    }
    // naming is not allowed on generic text containers without a role
    if ((e.attrs['aria-label'] || e.attrs['aria-labelledby']) && NAMEABLE_PLAIN.has(e.tag) && !e.attrs.role) {
      push(`${tagStr(e)} has an aria name but no role, so assistive technology ignores it`);
    }
  });

  // names of controls
  walkEls(root, (e) => {
    if (isHidden(e)) return;
    if (e.tag === 'input' && e.attrs.type === 'hidden') return;
    if (['input', 'textarea', 'select'].includes(e.tag) && !nameOf(root, e)) push(`${tagStr(e)} control has no label`);
    if (e.tag === 'button' && !nameOf(root, e)) push(`${tagStr(e)} button has no name`);
    if (e.tag === 'a' && e.attrs.href !== undefined && !nameOf(root, e)) push(`${tagStr(e)} link has no name`);
    if (e.tag === 'svg' && !isHidden(e)) {
      if (e.attrs.role === 'img' && !e.attrs['aria-label']) push(`${tagStr(e)} svg role=img without a label`);
      if (e.attrs.role !== 'img') push(`${tagStr(e)} svg is neither hidden nor labelled`);
    }
    // label in name (2.5.3): when aria-label replaces visible text, it must contain that text
    if ((e.tag === 'button' || e.tag === 'a') && e.attrs['aria-label']) {
      const visible = textOf(e).toLowerCase();
      const name = e.attrs['aria-label'].toLowerCase();
      if (visible && !name.includes(visible)) push(`${tagStr(e)} aria-label "${e.attrs['aria-label']}" does not contain the visible text "${textOf(e)}"`);
    }
  });

  // headings
  const heads = all(root, (e) => /^h[1-6]$/.test(e.tag) && !isHidden(e));
  let prev = 0;
  for (const h of heads) {
    const level = Number(h.tag[1]);
    if (!fragment && prev === 0 && level !== 1) push(`first heading is ${h.tag}, not h1 ("${textOf(h)}")`);
    if (prev && level > prev + 1) push(`heading jumps from h${prev} to ${h.tag} ("${textOf(h)}")`);
    prev = level;
  }
  if (heads.filter((h) => h.tag === 'h1').length > 1) push('more than one visible h1');

  // lists and definition lists
  walkEls(root, (e) => {
    if (e.tag === 'ul' || e.tag === 'ol') {
      for (const c of e.children) if (typeof c !== 'string' && c.tag !== 'li') push(`${tagStr(e)} has a ${c.tag} child`);
    }
    if (e.tag === 'dl') {
      for (const c of e.children) {
        if (typeof c === 'string') continue;
        if (c.tag === 'div') {
          for (const g of c.children) if (typeof g !== 'string' && !['dt', 'dd'].includes(g.tag)) push(`dl > div has a ${g.tag} child`);
        } else if (!['dt', 'dd'].includes(c.tag)) push(`dl has a ${c.tag} child`);
      }
    }
  });

  // landmarks
  const mains = all(root, (e) => e.tag === 'main');
  if (mains.length > 1) push('more than one main');
  if (!allowMissingMain && mains.length === 0) push('no main');
  const navs = all(root, (e) => e.tag === 'nav');
  const navNames = navs.map((n) => n.attrs['aria-label'] || '');
  if (navs.length > 1 && new Set(navNames).size !== navNames.length) push('several nav elements share a name');
  return problems;
}
