// Tests for the review fixes in the React app and its libraries: server answers that cannot be
// trusted, honest wording, size limits and small helpers.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportPrivateJwk, exportPublicJwk, generateKeyPair, keyIdOf, signRecord } from '../../shared/keys.js';
import { verifyDocumentBundle } from '../../shared/verify.js';
import { ApiError, MAX_BLOB_BYTES, MAX_JSON_BYTES, getBlob, getDocument } from '../../src/lib/api.js';
import { checkAnchor, createChatSession, describeAnchor, verifyPageEntries } from '../../src/lib/chatClient.js';
import { formatTime, formatUtc, overLimitText, shortKeyId, textOf } from '../../src/lib/format.js';
import { buildBackup, openBackup, passphraseStrength } from '../../src/lib/keystore.js';
import { outcomeUnknown } from '../../src/lib/outcome.js';
import { pinMismatch, serverKeyPinned } from '../../src/lib/trust.js';
import Callout from '../../src/components/Callout.jsx';
import KeyBadge from '../../src/components/KeyBadge.jsx';
import VerifyResult from '../../src/components/VerifyResult.jsx';
import { ChannelCard } from '../../src/components/chat/ChannelList.jsx';
import { certificateData, statusOf, verdictSentence, versionLabel } from '../../src/components/doc/docLogic.js';
import { ownedBy } from '../../src/components/vault/vaultLogic.js';
import { buildBundleParts, buildChannelPage, clone, createIdentity, createServerKey } from '../helpers/bundle.js';

const render = (node) => renderToString(h(MemoryRouter, null, node));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what a result says about the server key', () => {
  async function bundleWith(pin) {
    const owner = await createIdentity('Registry Office');
    const serverKey = await createServerKey();
    const parts = await buildBundleParts({ owner, serverKey, versions: [{ label: 'Act' }] });
    const result = await verifyDocumentBundle(parts.bundle, { expectedDocId: parts.docId, pinnedServerKeyId: pin ? serverKey.keyId : '' });
    return { parts, serverKey, result };
  }

  it('is pinned only when the checkpoint check passed against the pin', async () => {
    const pinned = await bundleWith(true);
    expect(pinned.result.ok).toBe(true);
    expect(serverKeyPinned(pinned.result)).toBe(true);
    const unpinned = await bundleWith(false);
    expect(unpinned.result.ok).toBe(true);
    expect(serverKeyPinned(unpinned.result)).toBe(false);
  });

  it('a failed result is never pinned, and a wrong pin is a mismatch', async () => {
    const { parts, serverKey } = await bundleWith(true);
    const other = await createServerKey();
    const wrong = await verifyDocumentBundle(parts.bundle, { expectedDocId: parts.docId, pinnedServerKeyId: other.keyId });
    expect(wrong.ok).toBe(false);
    expect(serverKeyPinned(wrong)).toBe(false);
    expect(pinMismatch(wrong)).toBe(true);
    expect(serverKeyPinned(null)).toBe(false);
    expect(serverKeyPinned({ ok: true, checks: [] })).toBe(false);
    void serverKey;
  });

  it('the banner, the status badge and the sentence are green only with a pin', async () => {
    const pinned = await bundleWith(true);
    const unpinned = await bundleWith(false);
    expect(render(h(VerifyResult, { result: pinned.result }))).toContain('ui-callout--good');
    const html = render(h(VerifyResult, { result: unpinned.result }));
    expect(html).not.toContain('ui-callout--good');
    expect(html).toContain('the server key is not pinned');
    expect(statusOf(pinned.result).tone).toBe('good');
    expect(statusOf(unpinned.result)).toEqual({ key: 'active', label: 'Active, server key not pinned', tone: 'warn' });
    expect(verdictSentence(pinned.result, { pinned: true, bundle: pinned.parts.bundle }).tone).toBe('good');
    expect(verdictSentence(unpinned.result, { pinned: false, bundle: unpinned.parts.bundle }).tone).toBe('warn');
  });

  it('the report line says what was checked and whether the key was pinned', async () => {
    const pinned = await bundleWith(true);
    const unpinned = await bundleWith(false);
    const a = certificateData({ bundle: pinned.parts.bundle, verification: pinned.result, pinnedServerKeyId: pinned.serverKey.keyId });
    const b = certificateData({ bundle: unpinned.parts.bundle, verification: unpinned.result, pinnedServerKeyId: '' });
    expect(a.resultText).toMatch(/^Signatures, version chain and server checkpoint passed\. Server key pinned and matched\.$/);
    expect(b.resultText).toMatch(/Server key NOT pinned/);
    expect(a.pinned).toBe(true);
    expect(b.pinned).toBe(false);
  });
});

describe('messages in a channel', () => {
  const CH = 'town-hall';

  it('a stale checkpoint does not tie the newest message to the server head', async () => {
    const alice = await createIdentity('Alice');
    const server = await createServerKey();
    const page = await buildChannelPage({ channelId: CH, serverKey: server, messages: [{ author: alice, body: 'hello' }] });
    const { entries } = await verifyPageEntries(page, { channelId: CH, pin: server.keyId });
    const head = entries[entries.length - 1];
    const args = { headEntry: head, identities: page.identities, page, channelId: CH, pin: server.keyId };
    const fresh = await checkAnchor(args);
    expect(fresh.anchored).toBe(true);
    const old = await checkAnchor({ ...args, now: Date.now() + 3 * 24 * 60 * 60 * 1000 });
    expect(old.anchored).toBe(false);
    expect(old.stale).toBe(true);
    expect(describeAnchor(old).title).toMatch(/not recent/);
    expect(describeAnchor(old).tone).toBe('warn');
  });

  it('a newest message that failed its own check is never tied to the head', async () => {
    const alice = await createIdentity('Alice');
    const server = await createServerKey();
    const page = await buildChannelPage({ channelId: CH, serverKey: server, messages: [{ author: alice, body: 'hello' }] });
    const { entries } = await verifyPageEntries(page, { channelId: CH, pin: server.keyId });
    const failed = { ...entries[0], verdict: { status: 'invalid', detail: 'x' } };
    const anchor = await checkAnchor({ headEntry: failed, identities: page.identities, page, channelId: CH, pin: server.keyId });
    expect(anchor.anchored).toBe(false);
    expect(anchor.headFailed).toBe(true);
    expect(describeAnchor(anchor).tone).toBe('bad');
  });

  it('an invalid checkpoint signature is an alarm, not the yellow note of a missing checkpoint', async () => {
    const alice = await createIdentity('Alice');
    const server = await createServerKey();
    const page = await buildChannelPage({ channelId: CH, serverKey: server, messages: [{ author: alice, body: 'hello' }] });
    const bad = clone(page);
    bad.checkpoint.payload.signedAt += 1; // the signature no longer fits
    const { entries } = await verifyPageEntries(bad, { channelId: CH });
    const anchor = await checkAnchor({ headEntry: entries[0], identities: bad.identities, page: bad, channelId: CH });
    expect(anchor.anchored).toBe(false);
    expect(anchor.badSignature).toBe(true);
    expect(describeAnchor(anchor).tone).toBe('bad');
  });

  it('a name only comes from the identity of a signer whose message was verified', async () => {
    const alice = await createIdentity('Alice');
    const bob = await createIdentity('Bob');
    const server = await createServerKey();
    const full = await buildChannelPage({ channelId: CH, serverKey: server, limit: 100, messages: [{ author: alice, body: 'one' }] });
    // the server adds an identity entry for somebody who wrote nothing
    const page = clone(full);
    page.identities[bob.keyId] = { keyId: bob.keyId, displayName: 'Chief Justice' };
    const session = createChatSession({ channelId: CH, getMessages: async () => clone(page) });
    await session.tick();
    const ids = session.getState().identities;
    expect(Object.keys(ids)).toEqual([alice.keyId]);
    expect(ids[alice.keyId].displayName).toBe('Alice');
  });
});

describe('limits on what the server may send', () => {
  function bodyOf(chunks, size) {
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= chunks * size) {
          controller.close();
          return;
        }
        sent += size;
        controller.enqueue(new Uint8Array(size));
      }
    });
  }

  it('getBlob refuses a body larger than the size the signed record states', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(100)));
    await expect(getBlob('a'.repeat(64), { maxBytes: 10 })).rejects.toMatchObject({ code: 'too_large', status: 0 });
    const ok = await getBlob('a'.repeat(64), { maxBytes: 100 });
    expect(ok.length).toBe(100);
  });

  it('getBlob checks the announced length first and cancels the body', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      }
    });
    vi.stubGlobal('fetch', async () => new Response(stream, { headers: { 'content-length': String(MAX_BLOB_BYTES + 1) } }));
    await expect(getBlob('a'.repeat(64))).rejects.toBeInstanceOf(ApiError);
    expect(cancelled).toBe(true);
  });

  it('a JSON answer larger than the cap is refused', async () => {
    vi.stubGlobal('fetch', async () => new Response(bodyOf(MAX_JSON_BYTES / 1024 + 4, 1024), { status: 200 }));
    await expect(getDocument('a'.repeat(32))).rejects.toMatchObject({ code: 'too_large' });
  });

  it('a normal JSON answer is read', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await expect(getDocument('a'.repeat(32))).resolves.toEqual({ ok: 1 });
  });
});

describe('a restored backup', () => {
  it('drops any member that is not one of the checked fields, so it cannot replace the key id', async () => {
    const kp = await generateKeyPair({ extractable: true });
    const publicKey = await exportPublicJwk(kp.publicKey);
    const privateJwk = await exportPrivateJwk(kp.privateKey);
    const ownId = await keyIdOf(publicKey);
    const record = { v: 2, type: 'identity', publicKey, displayName: 'Mallory', createdAt: 1700000000000 };
    const signature = await signRecord(kp.privateKey, record);
    const payload = { privateJwk, publicKey, displayName: 'Mallory', createdAt: 1700000000000, record, signature, keyId: 'ee'.repeat(32), extra: 1 };
    const text = await buildBackup(ownId, payload, 'a long enough passphrase', { iterations: 100000 });
    const opened = await openBackup(text, 'a long enough passphrase');
    expect(opened.keyId).toBe(ownId);
    expect(Object.keys(opened).sort()).toEqual(['createdAt', 'displayName', 'keyId', 'privateJwk', 'publicKey', 'record', 'signature']);
  });
});

describe('passphrase meter', () => {
  it('does not give a good label to repeated or very common phrases', () => {
    expect(passphraseStrength('password password password password').ok).toBe(false);
    expect(passphraseStrength('correct password staple battery').label).toMatch(/Weak/);
    expect(passphraseStrength('purple tractor quietly sings 42').label).toBe('Strong');
  });
});

describe('time and ids', () => {
  it('a time carries its zone and can be shown in UTC', () => {
    const t = Date.UTC(2026, 9, 9, 12, 30, 0);
    expect(formatTime(t)).toMatch(/[A-Za-z]{2,5}$|[+-]\d/);
    expect(formatUtc(t)).toBe('2026-10-09 12:30:00 UTC');
    expect(formatUtc(NaN)).toBe('unknown time');
  });

  it('the key tag is 16 of 64 characters', () => {
    expect(shortKeyId('ab'.repeat(32))).toBe('ab'.repeat(8));
  });

  it('textOf turns anything that is not text into an empty string', () => {
    expect(textOf('a')).toBe('a');
    for (const v of [1, null, undefined, {}, [], true]) expect(textOf(v)).toBe('');
  });

  it('a size error never contradicts itself through rounding', () => {
    const MAX = 20971520;
    const text = overLimitText(MAX + 1, MAX);
    expect(text).toContain('20,971,521 bytes');
    expect(text).toContain('1 byte over the limit of 20 MiB');
    expect(overLimitText(MAX, MAX)).toBe('');
    expect(overLimitText('x', MAX)).toBe('');
  });
});

describe('badges and cards built from server data', () => {
  it('KeyBadge shows 16 characters, a button for the whole key id, and the full name in the title', () => {
    const id = 'f0e1d2c3'.repeat(8);
    const html = renderToString(h(KeyBadge, { keyId: id, name: 'The Registry Office of the Northern District' }));
    expect(html).toContain('f0e1d2c3f0e1d2c3');
    expect(html).toContain('<button');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('title="The Registry Office of the Northern District, Key id ' + id + '"');
  });

  it('a channel card with odd types in every field still renders', () => {
    const row = { channelId: 'town-hall', title: { x: 1 }, docId: 7, createdBy: ['a'], createdByName: { y: 2 }, messageCount: 'many', lastMessageAt: 'now' };
    expect(() => render(h(ChannelCard, { channel: row, now: Date.now() }))).not.toThrow();
    const html = render(h(ChannelCard, { channel: row, now: Date.now() }));
    expect(html).toContain('town-hall');
  });

  it('a warning callout is a polite live region so a result that appears is spoken', () => {
    const html = renderToString(h(Callout, { tone: 'warn', title: 'x' }, 'y'));
    expect(html).toContain('role="status"');
    expect(renderToString(h(Callout, { tone: 'bad', title: 'x' }, 'y'))).toContain('role="alert"');
  });
});

describe('small helpers', () => {
  it('only rows that name the key as owner are shown as yours', () => {
    const rows = [{ docId: 'a', ownerKeyId: 'k1' }, { docId: 'b', ownerKeyId: 'k2' }, { docId: 'c' }, null, 'x'];
    expect(ownedBy(rows, 'k1')).toEqual([{ docId: 'a', ownerKeyId: 'k1' }]);
    expect(ownedBy(rows, '')).toEqual([]);
    expect(ownedBy(null, 'k1')).toEqual([]);
  });

  it('an empty label on a new version keeps the current label and never uses a file name', () => {
    expect(versionLabel('', 'Deed')).toBe('Deed');
    expect(versionLabel('   ', 'Deed')).toBe('Deed');
    expect(versionLabel(' New ', 'Deed')).toBe('New');
    expect(versionLabel('', undefined)).toBe('');
  });

  it('a lost answer and a conflict leave the outcome open, a clear refusal does not', () => {
    expect(outcomeUnknown({ status: 0, code: 'network' })).toBe(true);
    expect(outcomeUnknown({ status: 500, code: 'server_error' })).toBe(true);
    expect(outcomeUnknown({ status: 409, code: 'conflict' })).toBe(true);
    expect(outcomeUnknown({ status: 429, code: 'rate_limited' })).toBe(false);
    expect(outcomeUnknown({ status: 400, code: 'bad_request' })).toBe(false);
    expect(outcomeUnknown({ code: 'rate_limited' })).toBe(false);
    expect(outcomeUnknown({ outcomeKnown: true })).toBe(false);
    expect(outcomeUnknown(null)).toBe(true);
  });
});
