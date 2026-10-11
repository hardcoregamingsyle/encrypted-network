// Shared helpers for the ux review (reviewer r3-ux): server rendering of the shell with a fake session,
// the text a person actually sees, and a small css reader that resolves media queries.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AuthPromptProvider } from '../../../src/components/AuthPrompt.jsx';
import { ToastProvider } from '../../../src/components/Toast.jsx';
import { SessionProvider } from '../../../src/lib/session.jsx';
import { parseHtml } from '../a11y/html.js';

export { ROOT, read, walk } from '../a11y/helpers.js';

export const KEY = 'ab'.repeat(32);
const later = async () => {};
const nope = async () => {
  throw new Error('stub');
};

export const BASE = {
  status: 'signedOut',
  mode: null,
  account: null,
  keys: [],
  identity: null,
  mailAvailable: true,
  accountsAvailable: true,
  registration: 'unknown',
  registrationError: '',
  keyProblem: false,
  notice: '',
  error: ''
};

export const IDENTITY = { keyId: KEY, displayName: 'Priya Nair', publicKey: {}, createdAt: 1790000000000, sign: later, record: {}, signature: '', hasBackup: false };
export const ACCOUNT = { id: 'f'.repeat(32), displayName: 'Priya Nair', emailMasked: 'pr***@example.com', strict: false, createdAt: 1790000000000 };

export const STATES = {
  loading: { status: 'loading' },
  out: {},
  outNoMail: { mailAvailable: false },
  needsKey: { status: 'needsKey', mode: 'account', account: { ...ACCOUNT, displayName: null } },
  easy: { status: 'ready', mode: 'account', account: ACCOUNT, keys: [{ keyId: KEY, hasCloudCopy: true }], identity: IDENTITY, registration: 'registered' },
  strict: { status: 'ready', mode: 'account', account: { ...ACCOUNT, strict: true }, keys: [{ keyId: KEY, hasCloudCopy: false }], identity: IDENTITY, registration: 'registered' },
  guest: { status: 'ready', mode: 'guest', identity: IDENTITY, registration: 'registered' }
};

export function stubStore(patch) {
  const state = Object.freeze({ ...BASE, ...patch });
  return {
    getState: () => state,
    subscribe: () => () => {},
    init: later,
    refresh: later,
    requestCode: nope,
    verifyCode: nope,
    registerName: nope,
    startGuest: nope,
    signOut: nope,
    setStrict: nope,
    strictUnfinished: () => false,
    deleteAccount: nope,
    requireFresh: (action) => action(),
    setReauthHandler: () => {},
    unlockKey: nope,
    listSessions: nope,
    endOtherSessions: nope,
    endSession: nope,
    dismissNotice: () => {},
    identityFor: () => null,
    createLegacy: nope,
    restoreBackup: nope,
    exportBackup: nope,
    registerAgain: nope,
    forgetDevice: nope
  };
}

// Server renders a node inside the router, the fake session, the toasts and the sign in sheet.
export function render(node, stateName = 'out', path = '/') {
  const store = stubStore(STATES[stateName]);
  return renderToString(h(MemoryRouter, { initialEntries: [path] }, h(SessionProvider, { store }, h(ToastProvider, null, h(AuthPromptProvider, null, node)))));
}

// ---------- what a person sees ----------

const SKIP_TAGS = new Set(['script', 'style', 'svg', 'template', 'noscript']);

// The text on the screen. Left out: visually hidden text (ui-sr-only), aria-hidden parts, the printed
// certificate (hidden on screen by css) and the inside of a closed <details> (only its <summary> shows).
// With srOnly: true the visually hidden text is the only thing returned.
export function visibleText(html, { srOnly = false } = {}) {
  const root = parseHtml(html);
  const out = [];
  function walk(node, hiddenSr) {
    for (const child of node.children) {
      if (typeof child === 'string') {
        if (!srOnly || hiddenSr) out.push(child);
        continue;
      }
      if (child.attrs['aria-hidden'] === 'true' || 'hidden' in child.attrs || SKIP_TAGS.has(child.tag)) continue;
      const cls = child.attrs.class || '';
      if (/\bdoc-cert\b/.test(cls)) continue;
      const sr = /\bui-sr-only\b/.test(cls);
      if (sr && !srOnly) continue;
      if (child.tag === 'details' && !('open' in child.attrs)) {
        for (const part of child.children) if (typeof part !== 'string' && part.tag === 'summary') walk(part, hiddenSr || sr);
        continue;
      }
      out.push(' ');
      walk(child, hiddenSr || sr);
      out.push(' ');
    }
  }
  walk(root, false);
  return out.join('').replace(/\s+/g, ' ').trim();
}

// Words the main screens must not show outside a Details or Advanced area. "pin" is the verb for fixing
// a server key, a technical idea that has no place on the main path.
export const JARGON = [
  ['key id', /\bkey[ -]?ids?\b/i],
  ['keyId', /\bkeyId\b/],
  ['hash', /\bhash(es|ed|ing)?\b/i],
  ['fingerprint', /\bfingerprints?\b/i],
  ['checkpoint', /\bcheckpoints?\b/i],
  ['ledger', /\bledgers?\b/i],
  ['commitment', /\bcommitments?\b/i],
  ['JWK', /\bJWKs?\b/],
  ['signature', /\bsignatures?\b/i],
  ['pin', /\bpin(s|ned|ning)?\b/i],
  ['bundle', /\bbundles?\b/i]
];

export function jargonIn(text) {
  const hits = [];
  for (const [name, re] of JARGON) {
    const m = text.match(re);
    if (m) {
      const at = Math.max(0, m.index - 30);
      hits.push(`${name}: "...${text.slice(at, m.index + m[0].length + 30).trim()}..."`);
    }
  }
  return hits;
}

// ---------- css with media queries resolved ----------

// Rules whose @media condition holds at a given viewport width in rem (16px per rem). Only min-width and
// max-width are understood. print and reduced motion rules never apply.
export function mediaApplies(media, widthRem) {
  if (!media) return true;
  if (/print|prefers-reduced-motion|prefers-color-scheme|hover:\s*none|pointer/.test(media)) return false;
  const min = media.match(/min-width:\s*([\d.]+)rem/);
  const max = media.match(/max-width:\s*([\d.]+)rem/);
  if (min && widthRem < Number(min[1])) return false;
  if (max && widthRem > Number(max[1])) return false;
  return true;
}

// The value of a property for a selector at a width: the last matching rule wins (same specificity).
export function valueAt(rules, selector, prop, widthRem) {
  let value = null;
  for (const r of rules) {
    if (r.selector !== selector || !mediaApplies(r.media, widthRem)) continue;
    const m = r.body.match(new RegExp('(?:^|;|\\s)' + prop + '\\s*:\\s*([^;]+)', 'i'));
    if (m) value = m[1].trim();
  }
  return value;
}

export function px(value, tokens = {}) {
  if (!value) return null;
  const v = value.match(/^var\((--[a-z0-9-]+)\)$/);
  if (v) return tokens[v[1]] === undefined ? null : tokens[v[1]];
  const m = value.match(/^([\d.]+)(rem|px)$/);
  if (!m) return null;
  return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
}
