// Tests for the frontend fixes of the trust and privacy review: how strong the verdict looks, the rollback
// case, what a sign out may throw away, which person a list belongs to, and the code boxes.
// Real WebCrypto keys and a fake server (tests/review/system2/_fakes.js). Nothing leaves the process.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { roomStatus } from '../../src/components/chat/roomLogic.js';
import { certificateData } from '../../src/components/doc/docLogic.js';
import { otpInsert } from '../../src/components/otpLogic.js';
import VerifySummary from '../../src/components/VerifySummary.jsx';
import { authErrorText, hasNonAscii } from '../../src/lib/authText.js';
import * as device from '../../src/lib/deviceKey.js';
import { createMemoryAdapter, setStorageAdapter } from '../../src/lib/keystore.js';
import { docsOwnedBy, listLocalDocs, rememberDoc } from '../../src/lib/localDocs.js';
import { FIRST_VISIT_UNSAVED } from '../../src/lib/pin.js';
import { createSessionStore } from '../../src/lib/sessionStore.js';
import { verdictFor } from '../../src/lib/trust.js';
import * as vault from '../../src/lib/vault.js';
import { createVault } from '../../src/lib/vault.js';
import { verifyDocumentBundle } from '../../shared/verify.js';
import { buildBundleParts, createIdentity } from '../helpers/bundle.js';
import { ACCOUNT_ID, DOC, DOC2, blockedLocalStorage, fakeLocalStorage, makeServer, settle } from '../review/system2/_fakes.js';

const EMAIL = 'priya@example.com';
const PW = 'ABCDE-FGHIJ-KLMNO-PQRST';

async function cleanResult({ pin = true } = {}) {
  const owner = await createIdentity('Priya');
  const parts = await buildBundleParts({ owner, versions: [{ label: 'Land record' }] });
  const verification = await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: pin ? parts.serverKey.keyId : '', expectedDocId: parts.docId });
  return { parts, verification, result: { bundle: parts.bundle, verification, blobCheck: null, plaintextCheck: null, fingerprint: null } };
}

describe('how strong the green is', () => {
  it('a key chosen on purpose, a remembered key and a first visit read differently', async () => {
    const { result } = await cleanResult();
    const pinned = verdictFor(result, 'pinned-match');
    const remembered = verdictFor(result, 'remembered-match');
    const first = verdictFor(result, 'first-visit');
    expect([pinned.tone, remembered.tone, first.tone]).toEqual(['good', 'good', 'good']);
    expect(pinned.details.strength).toBe('pinned');
    expect(remembered.details.strength).toBe('remembered');
    expect(first.details.strength).toBe('first');
    expect(new Set([pinned.line, remembered.line, first.line]).size).toBe(3);
    expect(first.headline).not.toBe('Verified');
    // a server that was never met before is said not to be known
    expect(first.line).toMatch(/not met it before/);
    // the sentence credits the server and does not claim that nobody could have changed anything
    for (const v of [pinned, remembered, first]) {
      expect(v.line).toMatch(/server/i);
      expect(v.line).not.toMatch(/nobody has changed/i);
    }
  });

  it('a first visit that could not be remembered is a warning and does not say it was remembered', async () => {
    const { result } = await cleanResult();
    const v = verdictFor(result, FIRST_VISIT_UNSAVED);
    expect(v.tone).toBe('warn');
    expect(v.details.kind).toBe('key-unsaved');
    expect(`${v.headline} ${v.line} ${v.details.trustLine}`).not.toMatch(/now remembered|will warn you if it changes/);
    expect(`${v.line} ${v.details.trustLine}`).toMatch(/cannot (save|warn)/);
  });

  it('the Verify card names the signer as a name the signer chose', async () => {
    const { result } = await cleanResult();
    const html = renderToString(h(VerifySummary, { result, trust: 'pinned-match' }));
    expect(html).toMatch(/The name is chosen by the signer and is not checked/);
  });

  it('the chat strip is green only when the server key is one this browser knows', () => {
    const entries = [{ seq: 1, verdict: { status: 'verified' } }];
    const anchor = (pinned) => ({ anchored: true, pinned, pinMismatch: false, badSignature: false });
    expect(roomStatus({ entries, problems: [], anchor: anchor(true) }).tone).toBe('good');
    const unknown = roomStatus({ entries, problems: [], anchor: anchor(false) });
    expect(unknown.tone).toBe('info');
    expect(unknown.text).toMatch(/did not know the server's key/);
  });
});

describe('an answer older than one this browser saw', () => {
  it('is red on the card, in every trust state, and is never green', async () => {
    const { result } = await cleanResult();
    const old = { ...result, verification: { ...result.verification, rollback: true } };
    for (const trust of ['pinned-match', 'remembered-match', 'first-visit', 'first-visit-unsaved', '']) {
      const v = verdictFor(old, trust);
      expect(v.tone, trust).toBe('bad');
      expect(v.details.kind).toBe('rollback');
      expect(v.headline).toBe('Older than expected');
    }
    const html = renderToString(h(VerifySummary, { result: old, trust: 'remembered-match' }));
    expect(html).toContain('vsum--bad');
    expect(html).not.toContain('vsum--good');
    expect(html).toContain('role="alert"');
  });

  it('the printed certificate says so, and a failed answer keeps its own words', async () => {
    const { parts, verification } = await cleanResult();
    const rolled = certificateData({ bundle: parts.bundle, verification: { ...verification, rollback: true }, pinnedServerKeyId: parts.serverKey.keyId });
    expect(rolled.resultText).toMatch(/NOT A CLEAN PASS/);
    expect(rolled.resultText).toMatch(/older than one this browser saw/);
    expect(rolled.rollback).toBe(true);
    const failed = certificateData({ bundle: parts.bundle, verification: { ...verification, ok: false, rollback: true } });
    expect(failed.resultText).toMatch(/^DID NOT PASS/);
    expect(failed.resultText).toMatch(/older than one this browser saw/);
    const fine = certificateData({ bundle: parts.bundle, verification, pinnedServerKeyId: parts.serverKey.keyId });
    expect(fine.resultText).not.toMatch(/older/);
  });
});

describe('the code boxes', () => {
  it('a digit typed into a filled box replaces it and keeps the rest', () => {
    expect(otpInsert('679990', 0, '1')).toEqual({ value: '179990', focus: 1 });
    expect(otpInsert('123456', 5, '9')).toEqual({ value: '123459', focus: 5 });
  });

  it('an emptied box removes that digit even when no Backspace key event came', () => {
    expect(otpInsert('123456', 2, '')).toEqual({ value: '12456', focus: 2 });
    expect(otpInsert('12', 4, '')).toEqual({ value: '12', focus: 2 });
  });

  it('a letter or a symbol is ignored, and a paste still fills from the box on', () => {
    expect(otpInsert('123456', 2, 'x')).toEqual({ value: '123456', focus: 2 });
    expect(otpInsert('12', 2, '3456')).toEqual({ value: '123456', focus: 5 });
  });
});

describe('error words', () => {
  it('a code that was right but could not be finished does not tell the person to ask for a new code', () => {
    const text = authErrorText({ code: 'finish_failed', status: 0 });
    expect(text).toMatch(/code was right/);
    expect(text).not.toMatch(/new code/);
    expect(text).toMatch(/reload|check your connection/i);
  });

  it('plain ASCII only is a rule the page can tell apart from a typo', () => {
    expect(hasNonAscii('jörg@example.com')).toBe(true);
    expect(hasNonAscii('jorg@example.com')).toBe(false);
    expect(hasNonAscii(null)).toBe(false);
  });
});

describe('whose files a browser list shows', () => {
  it('keeps the key id of the publisher, and shows only that key its entries and the old ones with no owner', () => {
    vi.stubGlobal('localStorage', fakeLocalStorage());
    const a = 'aa'.repeat(32);
    const b = 'bb'.repeat(32);
    rememberDoc({ docId: DOC, label: 'mine', createdAt: 2, owner: a });
    rememberDoc({ docId: DOC2, label: 'theirs', createdAt: 1, owner: b });
    rememberDoc({ docId: 'cc'.repeat(16), label: 'old', createdAt: 0 });
    expect(docsOwnedBy(listLocalDocs(), a).map((e) => e.label)).toEqual(['mine', 'old']);
    expect(docsOwnedBy(listLocalDocs(), b).map((e) => e.label)).toEqual(['theirs', 'old']);
    expect(docsOwnedBy(null, a)).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe('the vault', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage());
  });

  const withContext = (ctx, api = {}) => createVault({ api, getContext: () => ctx });

  it('keeps nothing when nobody is signed in, and gives nothing back', async () => {
    const v = withContext({ mode: null, strict: false, accountId: '' });
    expect(await v.saveDocPassword(DOC, PW)).toBe('none');
    expect(await v.getDocPassword(DOC)).toBe(null);
    expect(vault.localList('guest')).toEqual([]);
  });

  it('a late save goes to the person who started the publish, not to whoever is signed in by then', async () => {
    const started = { mode: 'guest', strict: false, accountId: '' };
    let now = started;
    const v = createVault({ api: {}, getContext: () => now });
    const kept = v.snapshot();
    now = { mode: null, strict: false, accountId: '' }; // signed out while the publish was running
    expect(await v.saveDocPassword(DOC, PW, kept)).toBe('device');
    expect(vault.localGet('guest', DOC)).toBe(PW);
    expect(await v.saveDocPassword(DOC2, PW)).toBe('none');
  });

  it('marks a password that could only be kept on the device, and clears the mark when it is sent', async () => {
    const api = { putSecret: async () => { throw new Error('offline'); } };
    const v = withContext({ mode: 'account', strict: false, accountId: ACCOUNT_ID }, api);
    expect(await v.saveDocPassword(DOC, PW)).toBe('device');
    expect(vault.pendingList(ACCOUNT_ID)).toEqual([{ docId: DOC, password: PW }]);
    expect(vault.clearPending(ACCOUNT_ID, DOC)).toBe(true);
    expect(vault.pendingList(ACCOUNT_ID)).toEqual([]);
    expect(vault.localGet('a:' + ACCOUNT_ID, DOC)).toBe(PW); // the password itself stays until sign out
  });

  it('a password kept on purpose (Strict, Quick start) is never marked for sending', async () => {
    const strict = withContext({ mode: 'account', strict: true, accountId: ACCOUNT_ID });
    await strict.saveDocPassword(DOC, PW);
    expect(vault.pendingList(ACCOUNT_ID)).toEqual([]);
  });

  it('says whether this browser can keep a password, without changing what is stored', () => {
    expect(vault.canKeepLocally()).toBe(true);
    vault.localSet('guest', DOC, PW);
    expect(vault.canKeepLocally()).toBe(true);
    expect(vault.localGet('guest', DOC)).toBe(PW);
    vi.stubGlobal('localStorage', blockedLocalStorage());
    expect(vault.canKeepLocally()).toBe(false);
  });
});

describe('the session store', () => {
  beforeEach(() => {
    setStorageAdapter(createMemoryAdapter());
    vi.stubGlobal('localStorage', fakeLocalStorage());
  });

  const newStore = (server, dev = device) => createSessionStore({ api: server.api, device: dev, vault });

  async function signedIn(server) {
    const store = newStore(server);
    await store.init();
    await store.requestCode(EMAIL);
    await store.verifyCode(EMAIL, server.otp);
    await store.registerName('Priya');
    return store;
  }

  it('sign out is refused while a file password exists only on this device, and offers it back', async () => {
    const server = makeServer();
    const store = await signedIn(server);
    server.failSecrets = true;
    expect(await createVault({ api: server.api }).saveDocPassword(DOC, PW)).toBe('device');
    const err = await store.signOut().catch((e) => e);
    expect(err.code).toBe('unsent_passwords');
    expect(err.passwords).toEqual([{ docId: DOC, password: PW }]);
    expect(authErrorText(err)).toMatch(/saved only on this device/);
    expect(store.getState().status).toBe('ready'); // still signed in, nothing was wiped
    expect(vault.localGet('a:' + ACCOUNT_ID, DOC)).toBe(PW);
    // the person may choose to lose it
    await store.signOut({ discardUnsent: true });
    expect(store.getState().status).toBe('signedOut');
    expect(vault.localGet('a:' + ACCOUNT_ID, DOC)).toBe(null);
  });

  it('a password kept on the device is sent to the account at the next sign in', async () => {
    const server = makeServer();
    const first = await signedIn(server);
    server.failSecrets = true;
    await createVault({ api: server.api }).saveDocPassword(DOC, PW);
    server.failSecrets = false;
    // a new page load: the session is still there, the leftover is sent in the background
    const again = newStore(server);
    await again.init();
    await settle();
    expect(server.secrets.get(DOC)).toBe(PW);
    expect(vault.pendingList(ACCOUNT_ID)).toEqual([]);
    expect(first.getState().status).toBe('ready');
  });

  it('Strict can be chosen before the key is made, and then no private key is sent', async () => {
    const server = makeServer();
    const store = newStore(server);
    await store.init();
    await store.requestCode(EMAIL);
    await store.verifyCode(EMAIL, server.otp);
    expect(store.getState().status).toBe('needsKey');
    await store.setStrict(true);
    expect(store.getState().account.strict).toBe(true);
    await store.registerName('Priya');
    const sent = server.calls.filter((c) => Array.isArray(c) && c[0] === 'postMyKey')[0][1];
    expect(sent.privateJwk).toBeUndefined();
    expect(server.keys.filter((k) => k.privateJwk)).toHaveLength(0);
  });

  it('Strict on returns how many passwords this device really kept', async () => {
    const server = makeServer();
    const store = await signedIn(server);
    await createVault({ api: server.api }).saveDocPassword(DOC, PW);
    const out = await store.setStrict(true);
    expect(out.passwords).toHaveLength(1);
    expect(out.kept).toBe(1);
  });

  it('a person who signs out leaves no file list and no read marks for the next one', async () => {
    const server = makeServer();
    const store = await signedIn(server);
    rememberDoc({ docId: DOC, label: 'Private.pdf', createdAt: 1, owner: 'ab'.repeat(32) });
    await store.signOut();
    expect(listLocalDocs()).toEqual([]);
  });
});
