// Review findings from the trust path review (r2).
// Every test in this file fails against the current code on purpose: it asserts the safe outcome
// and the failure message shows what the app does today. Passing hardening tests are in
// hostile.test.js.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockFile } from '../../../src/lib/lockfile.js';
import { verifyDocumentBundle } from '../../../shared/verify.js';
import {
  buildBundleParts,
  buildChannelPage,
  buildLedger,
  clone,
  createIdentity,
  createServerKey,
  docHeadCheckpoint,
  identityEntry,
  ledgerCheckpoint
} from '../../helpers/bundle.js';

// A fake api module. The tests fill the tables in.
const fake = vi.hoisted(() => ({
  state: { bundles: new Map(), blobs: new Map(), puts: [], posts: [], failPostOnce: false }
}));

vi.mock('../../../src/lib/api.js', () => ({
  getDocument: async (docId) => structuredClone(fake.state.bundles.get(docId)),
  getBlob: async (hash) => {
    const b = fake.state.blobs.get(hash);
    if (!b) throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' });
    return b.slice();
  },
  putBlob: async ({ hash, size }) => {
    fake.state.puts.push({ hash, size });
    return { hash, size };
  },
  postDocRecord: async (docId, record) => {
    fake.state.posts.push({ docId, record });
    if (fake.state.failPostOnce) {
      fake.state.failPostOnce = false;
      throw Object.assign(new Error('the document changed, reload and try again'), { status: 409, code: 'conflict' });
    }
    return {};
  }
}));

const { openDocument, publishNewVersion } = await import('../../../src/lib/publish.js');
const { createChatSession } = await import('../../../src/lib/chatClient.js');
const { default: MessageList } = await import('../../../src/components/chat/MessageList.jsx');
const { default: DocSummary } = await import('../../../src/components/doc/DocSummary.jsx');
const { default: Certificate } = await import('../../../src/components/doc/Certificate.jsx');
const { default: VerifyResult } = await import('../../../src/components/VerifyResult.jsx');
const { ChannelCard } = await import('../../../src/components/chat/ChannelList.jsx');
const { pinStatus } = await import('../../../src/components/verify/logic.js');
const { restoreIdentity, buildBackup, setStorageAdapter, createMemoryAdapter } = await import('../../../src/lib/keystore.js');
const { getBlob: realGetBlob } = await vi.importActual('../../../src/lib/api.js');

const FAST = 100000;
const PASSWORD = 'ABCD-EFGH-JKLM-NPQR-STUV';
const render = (node) => renderToString(h(MemoryRouter, null, node));
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  Object.assign(fake.state, { puts: [], posts: [], failPostOnce: false });
  fake.state.bundles.clear();
  fake.state.blobs.clear();
});

describe('FINDING 1: a poisoned identities entry decides the name shown next to "Signature verified"', () => {
  let alice;
  let bob;
  let server;

  beforeAll(async () => {
    alice = await createIdentity('Alice Archivist');
    bob = await createIdentity('Bob');
    server = await createServerKey();
  });

  it('the name on a verified message is the name in the signer signed identity record', async () => {
    const full = await buildChannelPage({
      channelId: 'town-hall',
      serverKey: server,
      limit: 100,
      messages: [
        { author: bob, body: 'one' },
        { author: bob, body: 'two' },
        { author: alice, body: 'I am Alice' }
      ]
    });
    // Page 1: the first two messages (only Bob wrote). The server adds an entry for Alice with
    // a displayName that differs from her signed record. Nothing in the page uses it, so
    // verifyMessages never looks at it.
    const first = clone(full);
    first.messages = first.messages.slice(0, 2);
    first.hasMore = true;
    first.identities = { [bob.keyId]: identityEntry(bob), [alice.keyId]: { ...identityEntry(alice), displayName: 'Chief Justice' } };
    // Page 2: Alice's message, with her honest identity entry. It verifies.
    const second = clone(full);
    second.messages = second.messages.slice(2);
    second.identities = { [alice.keyId]: identityEntry(alice) };

    const pages = [first, second];
    const session = createChatSession({
      channelId: 'town-hall',
      getMessages: async (_id, opts) => clone(opts.tail !== undefined ? pages[0] : pages[1])
    });
    await session.tick();
    await session.tick();
    const state = session.getState();
    const aliceEntry = state.entries.find((e) => e.record.signer === alice.keyId);
    expect(aliceEntry.verdict.status).toBe('verified');

    const html = render(h(MessageList, { entries: state.entries, identities: state.identities }));
    expect(html, 'the verified message by Alice is shown under a name she never signed').not.toContain('Chief Justice');
    expect(html).toContain('Alice Archivist');
  });
});

describe('FINDING 2: "matches your pinned key" and "yes, and it matches" come from an unsigned server field', () => {
  let attacker;
  let pinnedKey;
  let fakeServer;
  let parts;
  let verification;

  beforeAll(async () => {
    attacker = await createIdentity('Land Registry');
    pinnedKey = await createServerKey(); // the real server key, the one the user pinned
    fakeServer = await createServerKey(); // the key the impostor really signs with
    parts = await buildBundleParts({ owner: attacker, serverKey: fakeServer, versions: [{ label: 'Title deed' }] });
    // The impostor only claims the pinned key id. The public key and the signatures are its own.
    parts.bundle.server.keyId = pinnedKey.keyId;
    verification = await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: pinnedKey.keyId, expectedDocId: parts.docId });
  });

  it('precondition: verification fails for the impostor', () => {
    expect(verification.ok).toBe(false);
  });

  it('DocSummary does not say "Matches your pinned key" for a failed verification', () => {
    const html = render(h(DocSummary, { docId: parts.docId, bundle: parts.bundle, verification, pinnedServerKeyId: pinnedKey.keyId }));
    expect(html).not.toContain('Matches your pinned key');
  });

  it('the printed certificate does not say the server key is pinned and matches', () => {
    const html = render(
      h(Certificate, { bundle: parts.bundle, verification, pinnedServerKeyId: pinnedKey.keyId, checkedAt: Date.now() })
    );
    expect(html).not.toContain('yes, and it matches');
  });

  it('the Verify page pin panel does not say "match" from the key id the server states about itself', () => {
    // GET /api/server-key answers { signing, keyId, publicKey }. keyId is just a string.
    const state = pinStatus(pinnedKey.keyId, {
      status: 'ready',
      data: { signing: true, keyId: pinnedKey.keyId, publicKey: fakeServer.publicJwk }
    });
    expect(state, 'the key id was not recomputed from publicKey').not.toBe('match');
  });
});

describe('FINDING 3: a bundle from a stranger gets the green headline when no key is pinned', () => {
  it('VerifyResult does not use the good tone for a bundle made entirely by an impostor with no pin', async () => {
    const impostor = await createIdentity('Ministry of Land Records');
    const ownServer = await createServerKey();
    const parts = await buildBundleParts({ owner: impostor, serverKey: ownServer, versions: [{ label: 'Transfer order 7' }] });
    // This is exactly what the offline bundle section does: no pin, no expected id.
    const result = await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: '' });
    expect(result.ok).toBe(true);
    expect(result.anchored).toBe(true);
    const html = render(h(VerifyResult, { result }));
    expect(html, 'big green banner for a document that anyone can fabricate').not.toContain('ui-callout--good');
  });
});

describe('FINDING 4: a replayed old answer gets the green headline and the words "when it answered"', () => {
  it('openDocument does not report ok for a head attestation that is three days old', async () => {
    const owner = await createIdentity('Registry Office');
    const serverKey = await createServerKey();
    const lock = await lockFile({ data: new TextEncoder().encode('text'), name: 'a.txt', password: PASSWORD, iterations: FAST });
    const parts = await buildBundleParts({
      owner,
      serverKey,
      now: Date.now() - 3 * DAY,
      versions: [
        {
          mutate: (r) => {
            r.blob = { hash: lock.blobHash, size: lock.size, suite: 1 };
            r.commitment = lock.commitment;
          }
        }
      ]
    });
    fake.state.bundles.set(parts.docId, parts.bundle);
    fake.state.blobs.set(lock.blobHash, lock.bytes);
    const r = await openDocument({ docId: parts.docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok, 'checkpoint signed 3 days ago is accepted as the live answer').toBe(false);
  });
});

describe('FINDING 5: nothing remembers the newest head, so a rollback to an older signed head is not noticed', () => {
  it('opening v2 and later a validly attested v1 of the same document gives a warning about the step back', async () => {
    const owner = await createIdentity('Registry Office');
    const serverKey = await createServerKey();
    const v2 = await buildBundleParts({ owner, serverKey, versions: [{ label: 'v1' }, { label: 'v2' }] });
    for (const v of v2.versions) fake.state.blobs.set(v.blob.hash, v.lockedBytes);

    // The same document cut back to version 1, with a fresh ledger checkpoint and a fresh head
    // attestation. This is what a server that hides version 2 would send.
    const row = v2.bundle.records[0];
    const ledger = buildLedger();
    const entry = await ledger.append(row.record, row.signature);
    const rolled = clone(v2.bundle);
    rolled.records = [{ ...clone(row), ledgerSeq: entry.seq, ledgerHash: entry.ledgerHash, prevLedgerHash: entry.prevLedgerHash }];
    rolled.document = { ...rolled.document, headVersion: 1, headRecordHash: row.recordHash, updatedAt: row.record.createdAt };
    rolled.checkpoint = await ledgerCheckpoint(serverKey, ledger);
    rolled.headCheckpoint = await docHeadCheckpoint(serverKey, v2.docId, 1, row.recordHash);

    fake.state.bundles.set(v2.docId, v2.bundle);
    const first = await openDocument({ docId: v2.docId, pinnedServerKeyId: serverKey.keyId });
    expect(first.verification.head.version).toBe(2);
    fake.state.bundles.set(v2.docId, rolled);
    const second = await openDocument({ docId: v2.docId, pinnedServerKeyId: serverKey.keyId });
    expect(second.verification.ok).toBe(true); // the rolled back answer is fully valid on its own
    const text = [...second.verification.warnings, ...second.verification.checks.map((c) => c.detail)].join(' ');
    expect(text, 'version 1 shown as latest, green, after this browser already saw version 2').toMatch(/rolled back|went back|newer version was (seen|shown)|lower version/i);
  });
});

describe('FINDING 6: a restored backup can replace the key id of the identity with a value from inside the file', () => {
  it('the restored identity keyId is the hash of its own public key', async () => {
    setStorageAdapter(createMemoryAdapter());
    const real = await createIdentity('Mallory');
    const victim = await createIdentity('Victim Official');
    const { exportPrivateJwk, generateKeyPair, exportPublicJwk } = await import('../../../shared/keys.js');
    // Build a backup that is internally consistent (so every check passes) and add one extra
    // member "keyId" naming somebody else.
    const kp = await generateKeyPair({ extractable: true });
    const publicKey = await exportPublicJwk(kp.publicKey);
    const privateJwk = await exportPrivateJwk(kp.privateKey);
    const { keyIdOf, signRecord } = await import('../../../shared/keys.js');
    const ownId = await keyIdOf(publicKey);
    const record = { v: 2, type: 'identity', publicKey, displayName: 'Mallory', createdAt: 1700000000000 };
    const signature = await signRecord(kp.privateKey, record);
    const payload = { privateJwk, publicKey, displayName: 'Mallory', createdAt: 1700000000000, record, signature, keyId: victim.keyId };
    const text = await buildBackup(ownId, payload, 'a long enough passphrase', { iterations: FAST });
    void real;
    const restored = await restoreIdentity(text, 'a long enough passphrase');
    expect(restored.keyId, 'identity now claims the key id of another person').toBe(ownId);
  });
});

describe('FINDING 7: a failed record post leaves the uploaded blob behind and every retry uploads a new one', () => {
  it('a retry of the same update does not upload a second copy of the file', async () => {
    const owner = await createIdentity('Registry Office');
    const head = { version: 1, recordHash: 'ab'.repeat(32) };
    const identity = { keyId: owner.keyId, sign: async () => 'x'.repeat(86) };
    const file = {
      name: 'a.txt',
      size: 5,
      arrayBuffer: async () => new TextEncoder().encode('hello').buffer
    };
    const args = { docId: 'cd'.repeat(16), head, file, label: 'v2', identity, password: PASSWORD, iterations: FAST };
    fake.state.failPostOnce = true;
    await expect(publishNewVersion(args)).rejects.toThrow();
    await publishNewVersion(args);
    const hashes = new Set(fake.state.puts.map((p) => p.hash));
    expect(hashes.size, 'blobs stored on the server for one logical update (each counts against the 500 MiB quota)').toBe(1);
  });
});

describe('FINDING 8: the locked file is read from the network without a size limit', () => {
  it('getBlob stops reading once the body is larger than any signed blob can be (50 MiB + 4096)', async () => {
    const LIMIT = 52428800 + 4096;
    const CHUNK = 1024 * 1024;
    let pulled = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (pulled >= 60 * CHUNK) {
          controller.close();
          return;
        }
        pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK));
      }
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(body, { status: 200 });
    try {
      await realGetBlob('a'.repeat(64)).catch(() => {});
    } finally {
      globalThis.fetch = realFetch;
    }
    // A web stream pulls one chunk ahead of the reader (queue size 1). Learning that the body is
    // over the limit needs the first chunk that crosses it, and the stream has already asked for the
    // next one by then, so no reader can stop below LIMIT + 2 chunks of this size. A real network
    // chunk is far smaller than 1 MiB. The point is that reading stops, instead of going to 60 MiB.
    expect(pulled, 'bytes the browser pulled before giving up').toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
  });
});

describe('FINDING 9: one odd field type in a server list answer blanks the whole list', () => {
  it('a channel row whose docId is not a string does not throw while rendering', () => {
    const row = { channelId: 'town-hall', title: 'Town hall', docId: 12345, createdBy: '', createdByName: '', messageCount: 1, lastMessageAt: null };
    expect(() => render(h(ChannelCard, { channel: row, now: Date.now() }))).not.toThrow();
  });
});

describe('FINDING 10: an answer that starts at or before the last known message skips the chain link check', () => {
  it('a real signed message from outside the loaded window cannot be attached to the known chain with made-up links', async () => {
    const { chainHash } = await import('../../../shared/hash.js');
    const { makeCheckpointPayload, signCheckpoint } = await import('../../../shared/checkpoint.js');
    const alice = await createIdentity('Alice');
    const bob = await createIdentity('Bob');
    const server = await createServerKey();
    const who = [alice, bob, alice, bob, alice, bob];
    const full = await buildChannelPage({
      channelId: 'town-hall',
      serverKey: server,
      limit: 100,
      messages: who.map((author, i) => ({ author, body: 'message ' + (i + 1) }))
    });

    // The browser first loads only the last two messages (seq 5 and 6).
    const initial = clone(full);
    initial.messages = initial.messages.slice(4);

    // Then the server answers a poll with: a copy of seq 6 whose chain values are made up, followed
    // by an old real message (seq 2, signed by Bob long ago) presented as the new seq 7.
    const dup = clone(full.messages[5]);
    dup.prevChainHash = 'ab'.repeat(32);
    dup.chainHash = await chainHash(dup.prevChainHash, dup.hash);
    const old = clone(full.messages[1]);
    const replayed = {
      seq: 7,
      hash: old.hash,
      prevChainHash: dup.chainHash,
      chainHash: await chainHash(dup.chainHash, old.hash),
      record: old.record,
      signature: old.signature
    };
    const poll = clone(full);
    poll.messages = [dup, replayed];
    poll.hasMore = false;
    poll.checkpoint = await signCheckpoint(
      server.privateKey,
      makeCheckpointPayload({ scope: 'channel:town-hall', seq: 7, hash: replayed.chainHash, signedAt: Date.now(), serverKeyId: server.keyId })
    );

    const session = createChatSession({
      channelId: 'town-hall',
      getMessages: async (_id, opts) => clone(opts.tail !== undefined ? initial : poll),
      getPin: () => server.keyId
    });
    await session.tick();
    await session.tick();
    const state = session.getState();
    const last = state.entries[state.entries.length - 1];
    expect(last.seq).toBe(7);
    // The known chain says message 6 ends at full.messages[5].chainHash. The new message does not
    // continue it, so it must not be shown as a verified message tied to the server head.
    expect(last.verdict.status, 'old message shown as a verified new message').not.toBe('verified');
    expect(state.anchor.anchored, 'and the head is reported as tied to the server').toBe(false);
  });
});

describe('FINDING 11: the short code shown next to every name is only 32 bits long', () => {
  it('shortKeyId is long enough that a lookalike key cannot be ground out in hours', async () => {
    const { shortKeyId } = await import('../../../src/lib/format.js');
    const id = (await createIdentity('Registry Office')).keyId;
    // KeyBadge shows exactly this value. An attacker needs about 2^(4 * length) key pairs to match it.
    expect(shortKeyId(id).length, 'hex characters shown (8 = 2^32 tries)').toBeGreaterThanOrEqual(16);
  });
});

describe('FINDING 12: after a lost answer the publish screen says nothing was published', () => {
  it('a network failure at the publish step does not claim that no record exists', async () => {
    const { runPublish } = await import('../../../src/components/vault/publishFlow.js');
    // The server stored the signed record and the answer was lost on the way back.
    const publish = async ({ onStep }) => {
      onStep('read', 'Reading the file');
      onStep('derive', 'Deriving the key');
      onStep('lock', 'File locked');
      onStep('upload', 'Uploading');
      onStep('sign', 'Signing');
      onStep('publish', 'Publishing the record');
      throw Object.assign(new Error('Could not reach the server.'), { status: 0, code: 'network' });
    };
    const out = await runPublish({ file: {}, label: 'x', listed: true, identity: {}, publish });
    expect(out.ok).toBe(false);
    expect(out.failedStep).toBe('publish');
    const text = out.message + ' ' + out.hint;
    expect(text, 'the user is told the document does not exist and to start again with a new password').not.toMatch(
      /no record was published|does not exist yet|Nothing was published/i
    );
  });

  it('the same for a server error, which can also happen after the write', async () => {
    const { runPublish } = await import('../../../src/components/vault/publishFlow.js');
    const publish = async ({ onStep }) => {
      onStep('publish', 'Publishing the record');
      throw Object.assign(new Error('server error'), { status: 500, code: 'server_error' });
    };
    const out = await runPublish({ file: {}, label: 'x', listed: false, identity: {}, publish });
    expect(out.message).not.toMatch(/Nothing was published/i);
  });
});

describe('FINDING 13: in chat a server key that is not the pinned key is a yellow note, not an alarm', () => {
  it('the head line is not just "warn" when the checkpoint key differs from the pinned key', async () => {
    const { checkAnchor, describeAnchor, verifyPageEntries } = await import('../../../src/lib/chatClient.js');
    const alice = await createIdentity('Alice');
    const impostor = await createServerKey();
    const pinned = await createServerKey();
    const page = await buildChannelPage({
      channelId: 'town-hall',
      serverKey: impostor,
      messages: [{ author: alice, body: 'hello' }]
    });
    const { entries } = await verifyPageEntries(page, { channelId: 'town-hall', pin: pinned.keyId });
    const anchor = await checkAnchor({
      headEntry: entries[entries.length - 1],
      identities: page.identities,
      page,
      channelId: 'town-hall',
      pin: pinned.keyId
    });
    expect(anchor.anchored).toBe(false);
    // Every message still carries a green "Signature verified" badge.
    expect(entries[0].verdict.status).toBe('verified');
    // The Verify page calls the same situation "STOP". Here the tone is the same as for a missing checkpoint.
    expect(describeAnchor(anchor).tone).toBe('bad');
  });
});

describe('FINDING 9b: the same for a saved bundle or document answer with an odd owner name', () => {
  it('DocResult does not throw when the unsigned owner name is not a string', async () => {
    const { default: DocResult } = await import('../../../src/components/verify/DocResult.jsx');
    const owner = 'ab'.repeat(32);
    const bundle = {
      document: { docId: 'cd'.repeat(16), ownerKeyId: owner, status: 'active', headVersion: 1 },
      records: [],
      identities: { [owner]: { keyId: owner, displayName: { x: 1 } } }
    };
    const verification = { ok: false, status: 'invalid', head: null, anchored: false, checks: [], warnings: [] };
    expect(() => render(h(DocResult, { verification, bundle }))).not.toThrow();
  });
});
