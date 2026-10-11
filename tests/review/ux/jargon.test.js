// Jargon scan (reviewer r3-ux). The main screens are for ordinary people. Words like key id, hash,
// fingerprint, checkpoint, ledger, commitment, JWK, signature, pin and bundle belong inside a Details or
// Advanced area, or in visually hidden text that explains a tick. Two scans:
//   1. the screens are rendered to HTML and the text a person sees is searched
//   2. the text of states that a server render cannot reach (loading, errors, results, the code step of
//      sign in) is read from the source files of the primary screens
// Each failing test names the exact phrase, so the wording can be fixed.
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyDocumentBundle } from '../../../shared/verify.js';
import AddFileSheet from '../../../src/components/files/AddFileSheet.jsx';
import FileRow from '../../../src/components/files/FileRow.jsx';
import ChannelView from '../../../src/components/chat/ChannelView.jsx';
import { ChannelCard } from '../../../src/components/chat/ChannelList.jsx';
import Composer from '../../../src/components/chat/Composer.jsx';
import { MessageItem, PendingItem } from '../../../src/components/chat/MessageItem.jsx';
import MessageMenu from '../../../src/components/chat/MessageMenu.jsx';
import FileView from '../../../src/components/doc/FileView.jsx';
import ManageSheet from '../../../src/components/doc/ManageSheet.jsx';
import { openPlan } from '../../../src/components/doc/pageLogic.js';
import QuickCheck from '../../../src/components/verify/QuickCheck.jsx';
import VerifySummary from '../../../src/components/VerifySummary.jsx';
import ChatsPage from '../../../src/pages/ChatsPage.jsx';
import FilesPage from '../../../src/pages/FilesPage.jsx';
import MePage from '../../../src/pages/MePage.jsx';
import SignInPage from '../../../src/pages/SignInPage.jsx';
import VerifyPage from '../../../src/pages/VerifyPage.jsx';
import WelcomePage from '../../../src/pages/WelcomePage.jsx';
import { buildBundleParts, createIdentity, createServerKey } from '../../helpers/bundle.js';
import { IDENTITY, KEY, ROOT, jargonIn, read, render, visibleText } from './helpers.js';

const noop = () => {};

function check(html) {
  return jargonIn(visibleText(html));
}

// A real signed file, so the file page and the verdicts are rendered from true data.
async function fixture(versions = [{ label: 'Land record 2026-114.pdf' }, { label: 'Land record 2026-114.pdf' }]) {
  const owner = await createIdentity('Priya Nair');
  const serverKey = await createServerKey();
  const parts = await buildBundleParts({ owner, serverKey, versions });
  const verification = await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: serverKey.keyId, expectedDocId: parts.docId });
  const result = { bundle: parts.bundle, verification, blobCheck: null, plaintextCheck: null, fingerprint: null, file: null };
  return { ...parts, owner, serverKey, verification, result };
}

const fx = await fixture();
const fxRevoked = await fixture([{ label: 'Notice.pdf' }, { revoke: true, reason: 'Issued by mistake' }]);

function fileView(f, extra = {}) {
  const revoked = f.verification.status === 'revoked';
  return h(FileView, {
    docId: f.docId,
    result: f.result,
    trust: 'remembered-match',
    pinned: '',
    checkedAt: Date.now(),
    access: { allowed: false, isOwner: false },
    note: '',
    plan: openPlan({ result: f.result, revoked }),
    showAsk: false,
    busy: false,
    unlockError: '',
    detailsOpen: false,
    onDetailsToggle: noop,
    onShare: noop,
    onOpen: noop,
    onSubmitPassword: noop,
    onManage: noop,
    ...extra
  });
}

// ---------- 1. rendered screens ----------

describe('jargon on rendered screens (outside Details and Advanced)', () => {
  it('Welcome, with and without email sign in', () => {
    expect(check(render(h(WelcomePage), 'out', '/welcome'))).toEqual([]);
    expect(check(render(h(WelcomePage), 'outNoMail', '/welcome'))).toEqual([]);
  });

  it('Sign in: the email step and the name step', () => {
    expect(check(render(h(SignInPage), 'out', '/signin'))).toEqual([]);
    expect(check(render(h(SignInPage), 'needsKey', '/signin'))).toEqual([]);
  });

  it('Chats: the page and a row', () => {
    expect(check(render(h(ChatsPage), 'out', '/chats'))).toEqual([]);
    const row = h('ul', null, h(ChannelCard, { channel: { channelId: 'town-hall', title: 'Town hall', messageCount: 3, lastMessageAt: Date.now(), lastText: 'Agenda is up', lastSignerName: 'Priya' }, now: Date.now() }));
    expect(check(render(row, 'out', '/chats'))).toEqual([]);
  });

  it('A chat room, while it loads', () => {
    expect(check(render(h(ChannelView, { channelId: 'town-hall' }), 'easy', '/chats/town-hall'))).toEqual([]);
  });

  it('Chat messages: own, other, not checked, failed, still sending', () => {
    const base = { seq: 4, hash: 'c'.repeat(64), record: { body: 'Agenda is up', signer: KEY, createdAt: Date.now() } };
    const list = (entry, extra = {}) => h('ol', null, h(MessageItem, { entry, name: 'Priya', canReply: true, onReply: noop, onMenu: noop, ...extra }));
    expect(check(render(list({ ...base, verdict: { status: 'verified', detail: '' } }), 'easy'))).toEqual([]);
    expect(check(render(list({ ...base, verdict: { status: 'verified', detail: '' } }, { own: true }), 'easy'))).toEqual([]);
    // the detail strings below are the ones the app really produces (src/lib/chatClient.js:381, shared/verify.js:632 and 633)
    expect(check(render(list({ ...base, verdict: { status: 'unverified', detail: 'This message could not be checked.' } }), 'easy'))).toEqual([]);
    expect(check(render(list({ ...base, verdict: { status: 'invalid', detail: 'signature does not verify' } }), 'easy'))).toEqual([]);
    expect(check(render(list({ ...base, verdict: { status: 'invalid', detail: 'message hash does not match the record' } }), 'easy'))).toEqual([]);
    const pending = h('ol', null, h(PendingItem, { item: { id: 'p1', status: 'sent', record: { body: 'On my way', createdAt: Date.now() } }, name: 'Priya', keyId: KEY }));
    expect(check(render(pending, 'easy'))).toEqual([]);
  });

  it('The writing box, signed in and signed out', () => {
    expect(check(render(h(Composer, { identityStatus: 'ready', signerName: 'Priya', onSend: noop }), 'easy'))).toEqual([]);
    expect(check(render(h(Composer, { identityStatus: 'signedOut', onSend: noop }), 'out'))).toEqual([]);
  });

  it('The message menu', () => {
    const entry = { seq: 4, hash: 'c'.repeat(64), record: { body: 'Agenda is up', signer: KEY, createdAt: Date.now() }, verdict: { status: 'verified', detail: '' } };
    expect(check(render(h(MessageMenu, { entry, name: 'Priya', canReply: true, onReply: noop, onClose: noop, onNeedSignIn: noop }), 'easy'))).toEqual([]);
  });

  it('Files: the page and a row', () => {
    expect(check(render(h(FilesPage), 'easy', '/files'))).toEqual([]);
    expect(check(render(h(FilesPage), 'out', '/files'))).toEqual([]);
    const row = { docId: 'a'.repeat(32), label: 'Land record 2026-114.pdf', status: 'active', version: 3, updatedAt: Date.now(), approxTime: false };
    expect(check(render(h('ul', null, h(FileRow, { row, now: Date.now() })), 'easy'))).toEqual([]);
  });

  it('The Add file sheet', () => {
    expect(check(render(h(AddFileSheet, { open: true, onClose: noop }), 'easy', '/files'))).toEqual([]);
  });

  it('The file page for a visitor, and for a withdrawn file', () => {
    expect(check(render(fileView(fx), 'out', `/d/${fx.docId}`))).toEqual([]);
    expect(check(render(fileView(fxRevoked), 'out', `/d/${fxRevoked.docId}`))).toEqual([]);
  });

  it('The Manage menu of the file owner', () => {
    const html = render(h(ManageSheet, { open: true, onClose: noop, docId: fx.docId, head: { version: 2, recordHash: 'd'.repeat(64) }, identity: IDENTITY, password: '', previousLabel: '', onUpdated: noop, onWithdrawn: noop, onReload: noop, onDetails: noop }), 'easy');
    expect(check(html)).toEqual([]);
  });

  it('Verify: the page as a visitor sees it', () => {
    expect(check(render(h(VerifyPage), 'out', '/verify'))).toEqual([]);
    expect(check(render(h(QuickCheck), 'out', '/verify'))).toEqual([]);
  });

  it('Verify: the answers (verified, only some checks, not the latest)', () => {
    for (const trust of ['remembered-match', 'first-visit', 'pinned-mismatch']) {
      expect(check(render(h(VerifySummary, { result: fx.result, trust }), 'out')), trust).toEqual([]);
    }
    expect(check(render(h(VerifySummary, { result: null, trust: 'first-visit' }), 'out'))).toEqual([]);
  });

  it('Me: signed in with email (Easy and Strict), Quick start, and signed out', () => {
    for (const name of ['easy', 'strict', 'guest', 'out', 'needsKey']) {
      expect(check(render(h(MePage), name, '/me')), name).toEqual([]);
    }
  });
});

// ---------- 2. text that a server render cannot reach ----------

// Strings and text in a source file, with the line they are on. Comments are dropped. Only strings of
// three words or more count, so code names such as 'hash' as a key never match.
function literals(file) {
  const src = readFileSync(`${ROOT}/${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const out = [];
  const lineOf = (index) => src.slice(0, index).split('\n').length;
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    const s = m[1] ?? m[2] ?? m[3] ?? '';
    if (s.trim().split(/\s+/).length >= 3 && /[a-z]/i.test(s) && !/^[\w$./@#:-]+$/.test(s)) out.push({ line: lineOf(m.index), text: s.replace(/\s+/g, ' ').trim() });
  }
  for (const m of src.matchAll(/>([^<>{}=]*[A-Za-z][^<>{}=]*)</g)) {
    const s = m[1].replace(/\s+/g, ' ').trim();
    if (s.split(/\s+/).length >= 3) out.push({ line: lineOf(m.index), text: s });
  }
  return out;
}

// Files whose text is on a main screen. Text that sits inside a <details> or a Details sheet is listed in ALLOW.
const PRIMARY = [
  'src/pages/WelcomePage.jsx',
  'src/pages/SignInPage.jsx',
  'src/pages/ChatsPage.jsx',
  'src/pages/FilesPage.jsx',
  'src/pages/DocumentPage.jsx',
  'src/pages/VerifyPage.jsx',
  'src/pages/MePage.jsx',
  'src/lib/authText.js',
  'src/components/AuthPrompt.jsx',
  'src/components/QuickStartForm.jsx',
  'src/components/VerifySummary.jsx',
  'src/components/chat/ChannelList.jsx',
  'src/components/chat/ChannelView.jsx',
  'src/components/chat/Composer.jsx',
  'src/components/chat/MessageItem.jsx',
  'src/components/chat/MessageList.jsx',
  'src/components/chat/NewChatSheet.jsx',
  'src/components/chat/LinkedFileCard.jsx',
  'src/components/chat/roomLogic.js',
  'src/components/files/AddFileSheet.jsx',
  'src/components/files/addLogic.js',
  'src/components/files/filesLogic.js',
  'src/components/files/shareLogic.js',
  'src/components/doc/FileView.jsx',
  'src/components/doc/ManageSheet.jsx',
  'src/components/doc/PasswordLine.jsx',
  'src/components/doc/PublishVersion.jsx',
  'src/components/doc/RevokePanel.jsx',
  'src/components/doc/pageLogic.js',
  'src/components/verify/QuickCheck.jsx',
  'src/components/verify/quickLogic.js',
  'src/lib/trust.js'
];

// Text that is shown only after opening a Details or Advanced disclosure, as a hover tooltip, or in
// visually hidden text that explains a tick. [file, pattern]
const ALLOW = [
  ['src/pages/VerifyPage.jsx', /^(Server key pin|Remembered server key|Verify a saved bundle|Full ledger audit)$/],
  ['src/pages/VerifyPage.jsx', /^For people who want to see the details/], // inside the closed Advanced disclosure
  ['src/components/chat/MessageItem.jsx', /^Signature verified/], // the tick, its tooltip and its hidden text
  ['src/components/chat/MessageItem.jsx', /^Key id \$\{/] // tooltip on a sender name, shown on hover only
];

describe('jargon in text a server render cannot reach (source of the primary screens)', () => {
  for (const file of PRIMARY) {
    it(file, () => {
      const hits = [];
      for (const { line, text } of literals(file)) {
        if (ALLOW.some(([f, re]) => f === file && re.test(text))) continue;
        for (const hit of jargonIn(text)) hits.push(`${file}:${line} ${hit}`);
      }
      expect(hits).toEqual([]);
    });
  }
});
