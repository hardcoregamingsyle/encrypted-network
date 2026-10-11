// Copy review (reviewer r3-ux): honest claims, one name for one thing, tone, and error text.
// Failing tests are written as "DEFECT: ..." and say what they expect instead.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { verifyDocumentBundle } from '../../../shared/verify.js';
import { StatusChip } from '../../../src/components/files/FileRow.jsx';
import { statusChip } from '../../../src/components/files/filesLogic.js';
import FileView from '../../../src/components/doc/FileView.jsx';
import { openPlan } from '../../../src/components/doc/pageLogic.js';
import Composer from '../../../src/components/chat/Composer.jsx';
import VerifySummary from '../../../src/components/VerifySummary.jsx';
import { authErrorText } from '../../../src/lib/authText.js';
import { verdictFor } from '../../../src/lib/trust.js';
import FilesPage from '../../../src/pages/FilesPage.jsx';
import MePage from '../../../src/pages/MePage.jsx';
import SideNav from '../../../src/components/SideNav.jsx';
import VerifyPage from '../../../src/pages/VerifyPage.jsx';
import WelcomePage from '../../../src/pages/WelcomePage.jsx';
import { buildBundleParts, createIdentity, createServerKey } from '../../helpers/bundle.js';
import { read, render, visibleText } from './helpers.js';

const noop = () => {};

async function fixture() {
  const owner = await createIdentity('Priya Nair');
  const serverKey = await createServerKey();
  const parts = await buildBundleParts({ owner, serverKey, versions: [{ label: 'Land record 2026-114.pdf' }, { label: 'Land record 2026-114.pdf' }] });
  const verification = await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: serverKey.keyId, expectedDocId: parts.docId });
  return { ...parts, verification, result: { bundle: parts.bundle, verification, blobCheck: null, plaintextCheck: null, fingerprint: null, file: null } };
}
const fx = await fixture();

function filePage() {
  return render(
    h(FileView, {
      docId: fx.docId,
      result: fx.result,
      trust: 'remembered-match',
      pinned: '',
      checkedAt: Date.now(),
      access: { allowed: false, isOwner: false },
      note: '',
      plan: openPlan({ result: fx.result, revoked: false }),
      showAsk: false,
      busy: false,
      unlockError: '',
      detailsOpen: false,
      onDetailsToggle: noop,
      onShare: noop,
      onOpen: noop,
      onSubmitPassword: noop,
      onManage: noop
    }),
    'out',
    `/d/${fx.docId}`
  );
}

describe('honest claims', () => {
  it('the verdict is green only when it says what was checked, and says so in one short line', () => {
    const v = verdictFor(fx.result, 'remembered-match');
    expect(v.tone).toBe('good');
    expect(v.details.checked).toMatch(/^Checked:/);
    expect(v.line.length).toBeLessThan(80);
  });

  it('DEFECT: "latest version" is credited to the server, not stated as a fact', () => {
    // The green line says "This is the latest version and nobody has changed it." The only evidence
    // that a version is the latest is the server's own signed statement (the About page says the server
    // "could hide a newer version"). And "nobody has changed it" is wrong in general: the owner can
    // publish a change, which is a newer version. Say what is true: not changed since it was signed,
    // and the server says it is the newest.
    const v = verdictFor(fx.result, 'remembered-match');
    expect(v.line).toMatch(/server/i);
    expect(v.line).not.toMatch(/nobody has changed/i);
  });

  it('DEFECT: the About page does not promise more than its own limits list allows', () => {
    const about = read('src/pages/AboutPage.jsx');
    const lead = about.match(/hrdlock keeps signed records[\s\S]*?changed it\./)[0].replace(/\s+/g, ' ');
    // the same page later says the server "could hide a newer version"
    expect(lead).not.toMatch(/check that it is the latest one and that nobody has changed it/);
  });

  it('DEFECT: a first visit, when the server key was only remembered and never compared, does not read the same as a known server', () => {
    // On a first visit nothing can be compared, so a server that lies on the very first visit is
    // believed. The headline is the same green word "Verified" in both cases and only a muted line
    // below differs.
    const known = verdictFor(fx.result, 'remembered-match');
    const first = verdictFor(fx.result, 'first-visit');
    expect(first.headline).not.toBe(known.headline);
  });

  it('DEFECT: no screen says a document is "real" (a signature shows who signed and that it is unchanged, not that it is true)', () => {
    const texts = [visibleText(render(h(WelcomePage), 'out', '/welcome')), visibleText(render(h(VerifyPage), 'out', '/verify'))];
    for (const t of texts) expect(t).not.toMatch(/\b(real|genuine|authentic)\b/i);
  });

  it('DEFECT: the Verified chip in a file list says where it comes from without needing a hover', () => {
    // The chip hint ("This browser checked this version when you last opened it") is only a title
    // attribute, so touch screens and screen readers get the bare word "Verified" for a status that
    // was not checked just now.
    const chip = statusChip({ status: 'active', version: 3 }, { version: 3 });
    expect(chip.text).toBe('Verified');
    const html = renderToString(h(StatusChip, { chip }));
    const around = visibleText(html) + ' ' + visibleText(html, { srOnly: true });
    expect(around).toContain(chip.hint);
  });

  it('DEFECT: a file nobody has checked yet is not called "Active" with a shield, next to a "Verified" shield', () => {
    const chip = statusChip({ status: 'active', version: 3 }, null);
    expect(chip.text).not.toBe('Active');
  });

  it('a withdrawn file says Withdrawn everywhere a person reads it, never Revoked', () => {
    const page = visibleText(filePage());
    expect(page).not.toMatch(/revok/i);
  });
});

describe('one name for one thing', () => {
  it('DEFECT: the answer on the file page calls it a file, as the rest of the page does, not a document', () => {
    // The file page says Share, Open file, Versions. The verdict box at its top says "Do not trust this
    // document" or "Could not check this file". The Files tab and the Add file sheet say file.
    const verdicts = [verdictFor(null, 'first-visit'), verdictFor({ verification: { ok: false, status: 'invalid', checks: [{ id: 'chain', ok: false }] } }, 'first-visit')];
    const words = verdicts.map((v) => v.headline + ' ' + v.line).join(' ');
    expect(words).not.toMatch(/\bdocuments?\b/i);
  });

  it('DEFECT: the same step has the same words on every screen ("Finish signing in" or "Choose your name")', () => {
    const labels = new Set();
    const surfaces = [
      render(h(FilesPage), 'needsKey', '/files'),
      render(h(MePage), 'needsKey', '/me'),
      render(h(SideNav), 'needsKey', '/files'),
      render(h(Composer, { identityStatus: 'needsKey', onSend: noop }), 'needsKey')
    ];
    for (const html of surfaces) {
      const t = visibleText(html);
      for (const l of ['Finish signing in', 'Choose your name']) if (t.includes(l)) labels.add(l);
    }
    expect(labels.size).toBe(1);
  });

  it('sign in is always "Sign in", never "Log in" or "Login"', () => {
    const shown = [
      visibleText(render(h(WelcomePage), 'out', '/welcome')),
      visibleText(render(h(MePage), 'easy', '/me')),
      visibleText(render(h(MePage), 'out', '/me')),
      visibleText(render(h(SideNav), 'out', '/files')),
      visibleText(render(h(FilesPage), 'out', '/files'))
    ].join(' ');
    expect(shown).not.toMatch(/\b(log ?in|log ?out|logout)\b/i);
    expect(shown).toMatch(/Sign out/);
  });

});

describe('tone', () => {
  const screens = () => [
    visibleText(render(h(WelcomePage), 'out', '/welcome')),
    visibleText(render(h(FilesPage), 'easy', '/files')),
    visibleText(render(h(MePage), 'easy', '/me')),
    visibleText(render(h(VerifyPage), 'out', '/verify')),
    visibleText(filePage())
  ];

  it('no shouting: no exclamation marks, no "Oops", no "Sorry", no "Awesome"', () => {
    for (const t of screens()) {
      expect(t).not.toMatch(/!/);
      expect(t).not.toMatch(/\b(oops|whoops|sorry|awesome|amazing|simply|just)\b/i);
    }
  });

  it('every sign in error says what to do next, in plain words, and none shows a code', () => {
    const codes = ['invalid_email', 'invalid_code', 'code_expired', 'too_many_attempts', 'mail_unavailable', 'mail_failed', 'accounts_unavailable', 'rate_limited', 'unauthenticated', 'strict_mode', 'key_exists', 'forbidden', 'network'];
    const bad = [];
    for (const code of codes) {
      const text = authErrorText({ code, status: 400 });
      if (!/[.]$/.test(text)) bad.push(`${code}: no full stop`);
      if (/\b(error|exception|undefined|null|http|json|api|token)\b|\b\d{3}\b/i.test(text)) bad.push(`${code}: technical word in "${text}"`);
      if (code !== 'key_exists' && !/(try|check|use|wait|ask|reload|sign in|switch)/i.test(text)) bad.push(`${code}: no next step in "${text}"`);
    }
    expect(bad).toEqual([]);
  });

  it('a Verify answer for a bad file starts with the plain instruction', () => {
    expect(verdictFor(null, 'first-visit').headline).toBe('Could not check this file');
    const html = render(h(VerifySummary, { result: null, trust: 'first-visit' }), 'out');
    expect(visibleText(html)).toContain('nothing was verified');
  });

  it('sentences use "Could not", never a contraction, so the tone is the same everywhere', () => {
    const files = ['src/lib/authText.js', 'src/components/files/addLogic.js', 'src/components/files/filesLogic.js', 'src/lib/trust.js'];
    for (const f of files) {
      const src = read(f);
      expect(src.match(/'[^']*\b(couldn't|can't|didn't|doesn't|won't|isn't|aren't)\b[^']*'/g) || [], f).toEqual([]);
    }
  });
});
