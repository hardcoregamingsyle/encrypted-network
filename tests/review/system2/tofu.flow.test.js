// Review r2-trust: the real pipeline of the Verify page and the file page, from the server key
// trust state (src/lib/pin.js) through openDocument (src/lib/publish.js) to the verdict.
// The network is a stub (globalThis.fetch), storage is a fake. Nothing leaves the process.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCheckpointPayload, signCheckpoint } from '../../../shared/checkpoint.js';
import { forgetSeenHead } from '../../../src/lib/headStore.js';
import {
  forgetRememberedServerKey,
  getRememberedServerKeyId,
  loadServerTrust,
  prepareServerTrust,
  resetServerKeyCache,
  serverKeyTrust
} from '../../../src/lib/pin.js';
import { openDocument } from '../../../src/lib/publish.js';
import { verdictFor } from '../../../src/lib/trust.js';
import { roomStatus } from '../../../src/components/chat/roomLogic.js';
import { buildBundleParts, clone, createIdentity, docHeadCheckpoint } from '../../helpers/bundle.js';
import { blockedLocalStorage, fakeLocalStorage } from './_fakes.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Serves one bundle (and its locked file) for GET /api/documents/:id and /api/blobs/:hash.
function serve(state) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path) => {
      const p = String(path).split('?')[0];
      if (p.startsWith('/api/documents/')) return json(state.bundle);
      if (p.startsWith('/api/blobs/')) {
        const hash = p.split('/').pop();
        const bytes = state.blobs.get(hash);
        if (!bytes) return json({ error: 'none', code: 'not_found' }, 404);
        return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
      if (p === '/api/server-key') return json({ signing: true, publicKey: state.serverKey.publicJwk, keyId: state.serverKey.keyId });
      return json({ error: 'none', code: 'not_found' }, 404);
    })
  );
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage());
  forgetSeenHead();
  resetServerKeyCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function twoVersions() {
  const owner = await createIdentity('Priya');
  const parts = await buildBundleParts({ owner, versions: [{ label: 'v1' }, { label: 'v2' }] });
  const blobs = new Map(parts.versions.map((v) => [v.blob.hash, v.lockedBytes]));
  return { parts, blobs };
}

// What a hostile server can do: sign a fresh, valid looking answer for the OLD version.
async function olderAnswer(parts) {
  const { bundle, serverKey, docId, versions, ledger } = parts;
  const old = clone(bundle);
  old.records = old.records.slice(0, 1);
  old.document.headVersion = 1;
  old.document.headRecordHash = versions[0].recordHash;
  const first = ledger.entries[0];
  const payload = makeCheckpointPayload({
    scope: 'ledger',
    seq: first.seq,
    hash: first.ledgerHash,
    signedAt: Date.now(),
    serverKeyId: serverKey.keyId
  });
  old.checkpoint = await signCheckpoint(serverKey.privateKey, payload);
  old.headCheckpoint = await docHeadCheckpoint(serverKey, docId, 1, versions[0].recordHash);
  return old;
}

describe('HELD UP: the pipeline pins the key it remembers', () => {
  it('first visit remembers the key, the second visit is a remembered match, a new key is a mismatch', async () => {
    const { parts, blobs } = await twoVersions();
    serve({ bundle: parts.bundle, blobs, serverKey: parts.serverKey });
    const first = await loadServerTrust();
    expect(first.trust).toBe('first-visit');
    expect(getRememberedServerKeyId()).toBe(parts.serverKey.keyId);
    const open1 = await openDocument({ docId: parts.docId, pinnedServerKeyId: first.pin });
    expect(verdictFor(open1, first.trust).tone).toBe('good');

    resetServerKeyCache();
    const second = await loadServerTrust();
    expect(second.trust).toBe('remembered-match');

    // another server key signs everything (a copy of the site)
    const evil = await buildBundleParts({ owner: await createIdentity('Priya'), docId: parts.docId });
    resetServerKeyCache();
    serve({ bundle: evil.bundle, blobs: new Map(), serverKey: evil.serverKey });
    const third = await loadServerTrust();
    expect(third.trust).toBe('remembered-mismatch');
    const open3 = await openDocument({ docId: parts.docId, pinnedServerKeyId: third.pin }).catch((e) => e);
    // either the blob download or the verdict stops it, it is never green
    if (!(open3 instanceof Error)) expect(verdictFor(open3, third.trust).tone).toBe('bad');
  });
});

describe('DEFECT: rollback is detected but the verdict stays green', () => {
  it('openDocument flags rollback, verdictFor and the Verify page card still say Verified', async () => {
    const { parts, blobs } = await twoVersions();
    const { serverKey, docId } = parts;
    serve({ bundle: parts.bundle, blobs, serverKey });
    const known = await loadServerTrust();
    const latest = await openDocument({ docId, pinnedServerKeyId: known.pin });
    expect(latest.verification.ok).toBe(true);
    expect(latest.verification.anchored).toBe(true);

    // The next visit, a hostile server shows version 1 again, freshly signed.
    const old = await olderAnswer(parts);
    serve({ bundle: old, blobs, serverKey });
    resetServerKeyCache();
    const again = await loadServerTrust();
    const result = await openDocument({ docId, pinnedServerKeyId: again.pin });
    // the old answer is internally fine and tied to the server...
    expect(result.verification.ok).toBe(true);
    // ...and this browser noticed that it is older than what it saw before
    expect(result.verification.rollback).toBe(true);
    // The Verify page (QuickCheck) draws only <VerifySummary>: no rollback callout exists there.
    const verdict = verdictFor(result, again.trust);
    expect(verdict.tone, 'rollback must never be green').not.toBe('good');
  });
});

describe('DEFECT: first visit is claimed as remembered when nothing could be remembered', () => {
  it('with blocked storage the card says the key was remembered and is green', async () => {
    const { parts, blobs } = await twoVersions();
    vi.stubGlobal('localStorage', blockedLocalStorage());
    serve({ bundle: parts.bundle, blobs, serverKey: parts.serverKey });
    const known = await loadServerTrust();
    // nothing could be stored, so the word says so (it used to be a plain first visit, which claimed a memory)
    expect(known.trust).toBe('first-visit-unsaved');
    expect(getRememberedServerKeyId()).toBe(''); // nothing was stored
    const result = await openDocument({ docId: parts.docId, pinnedServerKeyId: known.pin });
    const verdict = verdictFor(result, known.trust);
    const claimsMemory = /remembered|will warn you/i.test(verdict.details.trustLine || '');
    expect(verdict.tone === 'good' && claimsMemory, 'green card says "remembered ... will warn you" with storage blocked').toBe(false);
  });

  it('the same for a chat: the key is never remembered, so a changed key is never reported', () => {
    vi.stubGlobal('localStorage', blockedLocalStorage());
    const id = 'ab'.repeat(32);
    // Nothing can be stored, so "first visit, the key is now remembered" is untrue and a second,
    // different key is also called "first visit". The word must say that nothing was remembered.
    expect(prepareServerTrust(id).trust).not.toBe('first-visit');
    expect(prepareServerTrust('cd'.repeat(32)).trust).not.toBe('first-visit');
  });
});

describe('DEFECT: the chat strip is as green for an unpinned first visit as for a pinned key', () => {
  const entries = [{ seq: 1, verdict: { status: 'verified' } }];
  const anchored = (pinned) => ({ anchored: true, pinned, pinMismatch: false, badSignature: false, serverChecked: true, headFailed: false, stale: false });

  it('roomStatus is good with the same words whether or not a server key is known', () => {
    const unpinned = roomStatus({ entries, problems: [], anchor: anchored(false) });
    const pinned = roomStatus({ entries, problems: [], anchor: anchored(true) });
    expect(unpinned.tone === pinned.tone && unpinned.text === pinned.text).toBe(false);
  });
});

describe('HELD UP: the trust words', () => {
  it('serverKeyTrust only reads, it never remembers', () => {
    const id = 'ab'.repeat(32);
    forgetRememberedServerKey();
    expect(serverKeyTrust(id)).toBe('first-visit');
    expect(getRememberedServerKeyId()).toBe('');
  });
  it('renders without throwing for every trust word', async () => {
    const owner = await createIdentity('Priya');
    const parts = await buildBundleParts({ owner });
    const result = { bundle: parts.bundle, verification: { ok: false, checks: [] } };
    const { default: VerifySummary } = await import('../../../src/components/VerifySummary.jsx');
    for (const trust of ['pinned-match', 'pinned-mismatch', 'remembered-match', 'remembered-mismatch', 'first-visit', '', undefined, 7]) {
      expect(() => renderToString(h(VerifySummary, { result, trust }))).not.toThrow();
    }
  });
});
