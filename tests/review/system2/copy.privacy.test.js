// Review r2-trust: honest words, privacy, injection. Static scans of src/ plus a few renders.
// "HELD UP" tests pass today. "DEFECT" tests assert the honest behaviour and FAIL today.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelCard } from '../../../src/components/chat/ChannelList.jsx';
import LinkedFileCard from '../../../src/components/chat/LinkedFileCard.jsx';
import { mergeDocuments, ownedBy } from '../../../src/components/vault/vaultLogic.js';
import { safeNextPath } from '../../../src/lib/format.js';
import { listLocalDocs, rememberDoc } from '../../../src/lib/localDocs.js';
import * as device from '../../../src/lib/deviceKey.js';
import { createMemoryAdapter, setStorageAdapter } from '../../../src/lib/keystore.js';
import { createSessionStore } from '../../../src/lib/sessionStore.js';
import * as vault from '../../../src/lib/vault.js';
import { DOC, fakeLocalStorage, makeServer } from './_fakes.js';

const ROOT = new URL('../../../', import.meta.url);
const SRC = new URL('src/', ROOT).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const files = walk(decodeURIComponent(SRC)).filter((f) => /\.(jsx?|css|html)$/.test(f));
const rel = (f) => relative(decodeURIComponent(SRC), f).replace(/\\/g, '/');
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const sources = files.map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }));

function hits(re, { jsOnly = false } = {}) {
  const out = [];
  for (const { file, text } of sources) {
    if (jsOnly && !/\.jsx?$/.test(file)) continue;
    text.split('\n').forEach((line, i) => {
      if (re.test(line)) out.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return out;
}

describe('HELD UP: words and code that must not appear', () => {
  it('has none of the banned marketing words', () => {
    const banned = /tamper[- ]?proof|unbreakable|guaranteed|\b100 ?(%|percent)|military|completely secure|impossible to forge|unhackable|bulletproof|foolproof/i;
    expect(hits(banned, { jsOnly: true })).toEqual([]);
  });

  it('never calls anything "secure" or "safe" in text a person reads', () => {
    // identifiers such as safeFileName and the helper safe() are code, not text
    const re = /(^|[^A-Za-z_.])(secure|securely|safe|safely)([^A-Za-z_(]|$)/i;
    const bad = hits(re, { jsOnly: true }).filter((l) => !/^\S+:\d+:\s*(\/\/|\*|import)/.test(l));
    expect(bad).toEqual([]);
  });

  it('has no em dash, no en dash and no emoji', () => {
    // written with escapes, so this file itself holds no banned character
    const re = /[\u2013\u2014\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{FE0F}]/u;
    expect(hits(re)).toEqual([]);
  });

  it('has no mention of any such product or vendor (names built from pieces)', () => {
    // the names are cut in two, so this file itself holds none of them
    const names = ['clau' + 'de', 'anthro' + 'pic', 'open' + 'ai', 'chat' + 'gpt', 'gp' + 't-?\\d', 'gem' + 'ini', 'copi' + 'lot', 'l' + 'lm', 'artificial intelli' + 'gence', 'a' + 'i assis' + 'tant'];
    const re = new RegExp('\\b(' + names.join('|') + ')\\b', 'i');
    expect(hits(re)).toEqual([]);
  });

  it('uses no way to inject markup, run strings as code or open windows', () => {
    const re = /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(|window\.open|javascript:|sendBeacon/;
    expect(hits(re, { jsOnly: true })).toEqual([]);
  });

  it('puts the file password in no query string and no title', () => {
    const re = /[?&](k|pw|pass|password)=|document\.title\s*=.*(pass|pw|secret)/i;
    expect(hits(re, { jsOnly: true })).toEqual([]);
  });

  it('keeps every browser storage key in one known list', () => {
    const keys = new Set();
    for (const { text } of sources) for (const m of text.matchAll(/['"`](hrdlock\.[A-Za-z0-9_.]+)['"`]/g)) keys.add(m[1]);
    expect([...keys].sort()).toEqual([
      'hrdlock.lastSeen.v1',
      'hrdlock.localDocs',
      'hrdlock.pinnedServerKeyId',
      'hrdlock.rememberedServerKeyId',
      'hrdlock.seenHeads',
      // the address typed at sign in, in sessionStorage: this tab only, cleared at sign out (src/lib/sessionStore.js)
      'hrdlock.signin.email',
      'hrdlock.vault.v1'
    ]);
  });
});

describe('HELD UP: redirects, escaping, email', () => {
  it('safeNextPath only lets an in app path through', () => {
    const bad = [
      '//evil.example', '/\\evil.example', '/\\/evil', 'https://evil.example', 'http://evil.example/x', 'javascript:alert(1)',
      ' /chats', '/signin', '/signin?next=/me', '/welcome', '/\u0000x', '/a\nb', '', null, undefined, 42, {}, ['/chats'], '/' + 'a'.repeat(400)
    ];
    for (const v of bad) expect(safeNextPath(v), JSON.stringify(v)).toBe('/chats');
    for (const ok of ['/chats', '/me', '/d/' + DOC, '/files?tab=public']) expect(safeNextPath(ok)).toBe(ok);
  });

  it('a hostile chat list row is drawn as text', () => {
    const channel = {
      channelId: 'x"><script>alert(1)</script>',
      title: '<img src=x onerror=alert(1)>',
      lastText: '<b onmouseover=alert(1)>hi</b>',
      lastSignerName: '"><svg onload=alert(1)>',
      docId: 'javascript:alert(1)',
      messageCount: 3,
      lastMessageAt: Date.now()
    };
    const html = renderToString(h(MemoryRouter, null, h(ChannelCard, { channel, now: Date.now() })));
    expect(html).not.toMatch(/<img|<script|<b |<svg onload/i);
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it('a hostile linked file id gives no link', () => {
    for (const docId of ['javascript:alert(1)', '../../x', '', 5, null, 'AB'.repeat(16)]) {
      expect(renderToString(h(MemoryRouter, null, h(LinkedFileCard, { docId })))).toBe('');
    }
  });

  it('the email is kept in no storage and no state after a full sign in', async () => {
    setStorageAdapter(createMemoryAdapter());
    const ls = fakeLocalStorage();
    vi.stubGlobal('localStorage', ls);
    const server = makeServer();
    const store = createSessionStore({ api: server.api, device, vault });
    await store.init();
    await store.requestCode('priya.nair@example.com');
    await store.verifyCode('priya.nair@example.com', server.otp);
    await store.registerName('Priya');
    await vault.saveDocPassword(DOC, 'ABCDE-FGHIJ');
    const everything = JSON.stringify(store.getState()) + JSON.stringify([...ls.map]);
    expect(everything).not.toMatch(/priya\.nair|nair@/);
    expect(JSON.stringify(store.getState().account)).toContain('pr***@example.com');
  });
});

describe('DEFECT: another person on the same browser sees the previous person\'s files', () => {
  beforeEach(() => {
    setStorageAdapter(createMemoryAdapter());
    vi.stubGlobal('localStorage', fakeLocalStorage());
  });

  it('after an Easy account signs out, a Quick start person gets the labels under Mine', async () => {
    const server = makeServer();
    const a = createSessionStore({ api: server.api, device, vault });
    await a.init();
    await a.requestCode('a@example.com');
    await a.verifyCode('a@example.com', server.otp);
    await a.registerName('Priya');
    // publishNewDocument calls rememberDoc for every publish, account or not (src/lib/publish.js line 219)
    rememberDoc({ docId: DOC, label: 'Divorce settlement 2026.pdf', createdAt: Date.now() });
    await a.signOut();

    const b = createSessionStore({ api: makeServer().api, device, vault });
    await b.init();
    await b.startGuest('Somebody else');
    // exactly what src/components/files/useMineFiles.js computes for a Quick start person
    const mine = mergeDocuments(ownedBy([], b.getState().identity.keyId), listLocalDocs(), {});
    expect(mine.map((r) => r.label)).toEqual([]);
  });
});

describe('DEFECT: copy that says more or less than is true', () => {
  it('Welcome does not say that everything you publish stays in the browser', () => {
    const text = read('src/pages/WelcomePage.jsx');
    // the signed record, the label and the locked file are on the server and the record is in the public ledger
    expect(text).not.toMatch(/so does everything you publish/);
  });

  it('Welcome and Verify do not say a signature lets anyone check that a file "is real"', () => {
    expect(read('src/pages/WelcomePage.jsx')).not.toMatch(/check it is real/);
    expect(read('src/pages/VerifyPage.jsx')).not.toMatch(/document is real and/);
  });

  it('the Add file switch does not say that only people with the link can find an unlisted file', () => {
    const add = read('src/components/files/AddFileSheet.jsx');
    const about = read('src/pages/AboutPage.jsx');
    // About: "anyone who reads the whole ledger can see the id, label, file hash and times of every file, listed or not"
    expect(about).toMatch(/listed or not/);
    expect(add).not.toMatch(/only people with your link can find it/);
  });

  it('Delete account says that files can no longer be updated or withdrawn and that the passwords on this device go too', () => {
    const me = read('src/pages/MePage.jsx');
    const start = me.indexOf('function DeleteSheet');
    const sheet = me.slice(start, me.indexOf('function Profile'));
    const accountBranch = sheet.slice(sheet.indexOf('isAccount ? ('), sheet.indexOf(') : ('));
    expect(accountBranch).toMatch(/update or withdraw|withdraw or update/i);
  });

  it('Strict mode says that the service already held the key and what turning it on cannot undo', () => {
    const me = read('src/pages/MePage.jsx');
    const sheet = me.slice(me.indexOf('function StrictSheet'), me.indexOf('function DeleteSheet'));
    const text = me.slice(0, me.indexOf('function Row')) + sheet;
    // The key and the passwords were already sent to the operator in Easy mode (registerName sends privateJwk at
    // sign up) and the account has no Strict choice before that. "The service deletes its copy" is all it says.
    expect(text).toMatch(/already|earlier copies|backups?|stays? the same key|was held/i);
  });

  it('sign in says that the address passes through an email service', () => {
    const about = read('src/pages/AboutPage.jsx');
    const signin = read('src/pages/SignInPage.jsx');
    expect(about + signin).toMatch(/email (service|provider)|mail (service|provider)|sent through/i);
  });

  it('Me tells a Strict or Quick start person what stays on this computer after sign out', () => {
    const me = read('src/pages/MePage.jsx');
    expect(me).toMatch(/after you sign out|when you sign out|shared computer/i);
  });
});
