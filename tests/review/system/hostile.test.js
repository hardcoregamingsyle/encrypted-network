// Trust path review (r2): hostile server answers fed into openDocument, the chat session and the
// audit, plus secret handling, key handling and injection checks. All of these pass today and
// hold the line. Known defects are in findings.test.js.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signRecord } from '../../../shared/keys.js';
import { bytesToBase64Url } from '../../../shared/encoding.js';
import { lockFile } from '../../../src/lib/lockfile.js';
import { buildBundleParts, buildChannelPage, buildLedger, clone, createIdentity, createServerKey, docHeadCheckpoint, identityEntry, ledgerCheckpoint } from '../../helpers/bundle.js';

const fake = vi.hoisted(() => ({
  state: { calls: [], bundles: new Map(), blobs: new Map(), postError: null, record: [] }
}));

vi.mock('../../../src/lib/api.js', () => ({
  getDocument: async (docId) => {
    fake.state.calls.push({ fn: 'getDocument', args: [docId] });
    return structuredClone(fake.state.bundles.get(docId));
  },
  getBlob: async (hash) => {
    fake.state.calls.push({ fn: 'getBlob', args: [hash] });
    const b = fake.state.blobs.get(hash);
    if (!b) throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' });
    return b.slice();
  },
  putBlob: async (args) => {
    fake.state.calls.push({ fn: 'putBlob', args: [args.hash, args.size, args.signer, Array.from(args.bytes.slice(0, 64))] });
    const rec = { v: 2, type: 'blob.put', hash: args.hash, size: args.size, signer: args.signer, createdAt: Date.now() };
    fake.state.calls.push({ fn: 'putBlob.sig', args: [rec, await args.sign(rec)] });
    fake.state.blobs.set(args.hash, args.bytes);
    return { hash: args.hash, size: args.size };
  },
  postDocRecord: async (docId, record, signature) => {
    fake.state.calls.push({ fn: 'postDocRecord', args: [docId, record, signature] });
    if (fake.state.postError) throw fake.state.postError;
    if (fake.state.postHook) await fake.state.postHook(docId, record);
    const { recordHash } = await import('../../../shared/records.js');
    return { recordHash: await recordHash(record), ledgerSeq: 1, ledgerHash: 'f'.repeat(64), document: { docId } };
  }
}));

const { openDocument, publishNewDocument, publishNewVersion, revokeDocument } = await import('../../../src/lib/publish.js');
const { createChatSession, verifyPageEntries } = await import('../../../src/lib/chatClient.js');
const { auditLedger } = await import('../../../src/lib/audit.js');
const { ownerAccess, statusOf, verdictSentence, certificateData } = await import('../../../src/components/doc/docLogic.js');
const { fullLink, verifyLink, parseFragment } = await import('../../../src/lib/links.js');
const { parseDocInput } = await import('../../../src/components/verify/logic.js');
const keystore = await import('../../../src/lib/keystore.js');
const { MessageItem, ReplyPreview } = await import('../../../src/components/chat/MessageItem.jsx');
const { default: MessageList } = await import('../../../src/components/chat/MessageList.jsx');
const { ChannelCard } = await import('../../../src/components/chat/ChannelList.jsx');
const { default: DocTimeline } = await import('../../../src/components/doc/DocTimeline.jsx');
const { default: DocSummary } = await import('../../../src/components/doc/DocSummary.jsx');
const { default: UnlockPanel } = await import('../../../src/components/doc/UnlockPanel.jsx');

const FAST = 100000;
const PASSWORD = 'ABCD-EFGH-JKLM-NPQR-STUV';
const render = (node) => renderToString(h(MemoryRouter, null, node));
const failedIds = (v) => v.checks.filter((c) => !c.ok).map((c) => c.id);

let owner;
let other;
let serverKey;

beforeAll(async () => {
  owner = await createIdentity('Registry Office');
  other = await createIdentity('Somebody Else');
  serverKey = await createServerKey();
});

beforeEach(() => {
  Object.assign(fake.state, { calls: [], postError: null, postHook: null });
  fake.state.bundles.clear();
  fake.state.blobs.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A document whose versions hold really locked files.
async function makeDoc(texts = ['first text'], { parts = {}, mutateBundle } = {}) {
  const locks = [];
  const versions = [];
  for (let i = 0; i < texts.length; i++) {
    const lock = await lockFile({ data: new TextEncoder().encode(texts[i]), name: `act-${i + 1}.txt`, password: PASSWORD, iterations: FAST });
    locks.push(lock);
    versions.push({
      mutate: (r) => {
        r.blob = { hash: lock.blobHash, size: lock.size, suite: 1 };
        r.commitment = lock.commitment;
      }
    });
  }
  const built = await buildBundleParts({ owner, serverKey, versions, ...parts });
  if (mutateBundle) mutateBundle(built.bundle, built);
  fake.state.bundles.set(built.docId, built.bundle);
  for (const lock of locks) fake.state.blobs.set(lock.blobHash, lock.bytes);
  return { ...built, locks };
}

// ---------------------------------------------------------------------------
describe('openDocument against a hostile server', () => {
  it('records of another document spliced into the answer are rejected', async () => {
    const mine = await makeDoc(['mine']);
    const foreign = await makeDoc(['foreign']);
    const spliced = clone(mine.bundle);
    spliced.records = foreign.bundle.records;
    spliced.document = foreign.bundle.document;
    spliced.checkpoint = foreign.bundle.checkpoint;
    spliced.headCheckpoint = foreign.bundle.headCheckpoint;
    fake.state.bundles.set(mine.docId, spliced);
    const r = await openDocument({ docId: mine.docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(false);
    expect(failedIds(r.verification)).toContain('chain_links');
    expect(r.verification.head).toBeNull();
    expect(r.verification.status).toBe('invalid');
  });

  it('a bundle for the right id but with the history of two documents mixed is rejected', async () => {
    const a = await makeDoc(['a1', 'a2']);
    const b = await makeDoc(['b1']);
    const mixed = clone(a.bundle);
    mixed.records = [a.bundle.records[0], b.bundle.records[0]];
    fake.state.bundles.set(a.docId, mixed);
    const r = await openDocument({ docId: a.docId, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(false);
  });

  it('extra top level fields and extra fields on rows change nothing', async () => {
    const d = await makeDoc(['x']);
    const noisy = clone(d.bundle);
    noisy.admin = { verified: true };
    noisy.verification = { ok: true, anchored: true };
    noisy.records[0].verified = true;
    noisy.document.verified = true;
    fake.state.bundles.set(d.docId, noisy);
    const r = await openDocument({ docId: d.docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(true);
    expect(Object.keys(r.verification).sort()).toEqual(['anchored', 'checks', 'head', 'ok', 'status', 'warnings']);
  });

  it('a poisoned identities map is rejected: wrong display name, extra entry, swapped key', async () => {
    const d = await makeDoc(['x']);
    const renamed = clone(d.bundle);
    renamed.identities[owner.keyId].displayName = 'Chief Justice';
    fake.state.bundles.set(d.docId, renamed);
    const r1 = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    expect(r1.verification.ok).toBe(false);
    expect(failedIds(r1.verification)).toContain('identities_match');

    const extra = clone(d.bundle);
    extra.identities[other.keyId] = { ...identityEntry(other), keyId: owner.keyId };
    fake.state.bundles.set(d.docId, extra);
    const r2 = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    expect(r2.verification.ok).toBe(false);

    const swapped = clone(d.bundle);
    swapped.identities[owner.keyId] = { ...identityEntry(other), keyId: owner.keyId };
    fake.state.bundles.set(d.docId, swapped);
    const r3 = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    expect(r3.verification.ok).toBe(false);
  });

  it('the signer name in head comes from the signed identity record even when the outer field is missing', async () => {
    const d = await makeDoc(['x']);
    const bare = clone(d.bundle);
    delete bare.identities[owner.keyId].displayName;
    fake.state.bundles.set(d.docId, bare);
    const r = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(true);
    expect(r.verification.head.signerName).toBe('Registry Office');
  });

  it('a stale head attestation (version 1) next to a ledger that moved on is not accepted as anchored', async () => {
    const d = await makeDoc(['one', 'two']);
    const stale = clone(d.bundle);
    stale.headCheckpoint = await docHeadCheckpoint(serverKey, d.docId, 1, d.bundle.records[0].recordHash);
    // the ledger checkpoint is also ahead of the last record
    const ledger = buildLedger();
    for (const row of d.bundle.records) await ledger.append(row.record, row.signature);
    const later = await buildBundleParts({ owner: other, serverKey, ledger, versions: [{ label: 'unrelated' }] });
    void later;
    stale.checkpoint = await ledgerCheckpoint(serverKey, ledger);
    fake.state.bundles.set(d.docId, stale);
    const r = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(false);
    expect(failedIds(r.verification)).toEqual(['checkpoint']);
  });

  it('a head attestation without a ledger checkpoint at the head does not rescue a swapped last record', async () => {
    const d = await makeDoc(['one', 'two']);
    const cut = clone(d.bundle);
    cut.records = cut.records.slice(0, 1); // server hides version 2 but keeps the signed v2 attestation
    cut.document = { ...cut.document, headVersion: 1, headRecordHash: cut.records[0].recordHash };
    fake.state.bundles.set(d.docId, cut);
    const r = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(false);
  });

  it('blob substitution: the head names an old file and the server sends another one', async () => {
    const d = await makeDoc(['old text', 'new text']);
    const oldHash = d.locks[0].blobHash;
    const newHash = d.locks[1].blobHash;
    fake.state.blobs.set(newHash, fake.state.blobs.get(oldHash)); // server answers with the old file
    const r = await openDocument({ docId: d.docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(true);
    expect(r.blobCheck.ok).toBe(false);
    expect(r.file).toBeNull();
    expect(r.fingerprint).toBeNull();
    expect(r.plaintextCheck.ok).toBe(false);
  });

  it('a signed blob that was swapped for a different correctly locked file fails the commitment', async () => {
    const d = await makeDoc(['signed text']);
    const evil = await lockFile({ data: new TextEncoder().encode('evil text'), name: 'x.txt', password: PASSWORD, iterations: FAST });
    // attacker also controls the record content here (so the blob hash matches), but not the commitment
    const forged = clone(d.bundle);
    const other2 = await buildBundleParts({
      owner,
      serverKey,
      docId: d.docId,
      versions: [
        {
          mutate: (r) => {
            r.blob = { hash: evil.blobHash, size: evil.size, suite: 1 };
            r.commitment = d.locks[0].commitment; // commitment copied from the real file
          }
        }
      ]
    });
    fake.state.bundles.set(d.docId, other2.bundle);
    fake.state.blobs.set(evil.blobHash, evil.bytes);
    void forged;
    const r = await openDocument({ docId: d.docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.blobCheck.ok).toBe(true);
    expect(r.plaintextCheck.ok).toBe(false);
    expect(r.file).toBeNull();
  });

  it('the unsigned document summary cannot change the owner, the status or the head', async () => {
    const d = await makeDoc(['x', 'y']);
    for (const patch of [
      { ownerKeyId: other.keyId },
      { status: 'revoked' },
      { headVersion: 1 },
      { headRecordHash: d.bundle.records[0].recordHash },
      { docId: 'f'.repeat(32) }
    ]) {
      const b = clone(d.bundle);
      Object.assign(b.document, patch);
      fake.state.bundles.set(d.docId, b);
      const r = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
      expect(r.verification.ok, JSON.stringify(patch)).toBe(false);
      expect(r.verification.head).toBeNull();
    }
  });

  it('a server that answers 200 with nothing, a string or an array never produces ok', async () => {
    for (const body of [undefined, null, 'ok', 7, [], {}, { records: [] }, { document: {}, records: [{}] }]) {
      fake.state.bundles.set('ab'.repeat(16), body);
      const r = await openDocument({ docId: 'ab'.repeat(16), pinnedServerKeyId: serverKey.keyId });
      expect(r.verification.ok).toBe(false);
      expect(r.file).toBeNull();
    }
  });

  it('never asks the server for a file when the signed head is a revoke', async () => {
    const d = await makeDoc(['x']);
    const rev = await buildBundleParts({ owner, serverKey, docId: d.docId, versions: [{}, { revoke: true, reason: 'withdrawn' }] });
    fake.state.bundles.set(d.docId, rev.bundle);
    fake.state.calls.length = 0;
    const r = await openDocument({ docId: d.docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.status).toBe('revoked');
    expect(fake.state.calls.map((c) => c.fn)).toEqual(['getDocument']);
  });

  it('allowUnanchored is not turned on by truthy values', async () => {
    const d = await makeDoc(['x'], { parts: { serverKey: null } });
    for (const v of ['true', 1, {}, [], 'yes']) {
      const r = await openDocument({ docId: d.docId, allowUnanchored: v });
      expect(r.verification.ok, String(v)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('what the document page derives from a failed or odd verification', () => {
  it('owner tools stay hidden for the real owner when the bundle does not verify', async () => {
    const d = await makeDoc(['x', 'y']);
    const tampered = clone(d.bundle);
    tampered.records[1].record.label = 'changed by the server';
    fake.state.bundles.set(d.docId, tampered);
    const r = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    const ident = { keyId: owner.keyId };
    expect(ownerAccess({ identity: ident, bundle: r.bundle, verification: r.verification }).allowed).toBe(false);
    expect(statusOf(r.verification).label).toBe('Not verified');
    expect(verdictSentence(r.verification, { pinned: true, bundle: r.bundle }).tone).toBe('bad');
    expect(certificateData({ bundle: r.bundle, verification: r.verification }).resultText).toBe('DID NOT PASS verification');
  });

  it('owner tools take the head from the verification, not from the unsigned summary', async () => {
    const d = await makeDoc(['x', 'y']);
    const r = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    const lie = clone(r.bundle);
    lie.document.headVersion = 99;
    lie.document.headRecordHash = 'ee'.repeat(32);
    const access = ownerAccess({ identity: { keyId: owner.keyId }, bundle: lie, verification: r.verification });
    expect(access.allowed).toBe(true);
    expect(access.head).toEqual({ version: 2, recordHash: r.verification.head.recordHash });
  });

  it('a different identity never gets owner tools', async () => {
    const d = await makeDoc(['x']);
    const r = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    expect(ownerAccess({ identity: { keyId: other.keyId }, bundle: r.bundle, verification: r.verification }).allowed).toBe(false);
  });

  it('the version history says it cannot be trusted when verification failed', async () => {
    const d = await makeDoc(['x']);
    const bad = clone(d.bundle);
    bad.records[0].signature = bad.records[0].signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    const v = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    fake.state.bundles.set(d.docId, bad);
    const r = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(false);
    const html = render(h(DocTimeline, { bundle: r.bundle, verified: false }));
    expect(html).toContain('cannot be trusted');
    expect(v.verification.ok).toBe(true);
  });

  it('an unlocked file from an unverified record gets a warning and no "File checked" banner', async () => {
    const d = await makeDoc(['x'], {});
    const bad = clone(d.bundle);
    bad.document.status = 'revoked';
    fake.state.bundles.set(d.docId, bad);
    const r = await openDocument({ docId: d.docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.verification.ok).toBe(false);
    expect(r.file).not.toBeNull();
    const html = render(
      h(UnlockPanel, { result: r, verified: false, revoked: false, password: '', onPassword() {}, onUnlock() {}, busy: false, steps: [], error: '' })
    );
    expect(html).toContain('did not pass verification');
    expect(html).not.toContain('File checked');
  });
});

// ---------------------------------------------------------------------------
describe('chat verification orchestration against a hostile server', () => {
  let alice;
  let bob;
  let chanServer;

  beforeAll(async () => {
    alice = await createIdentity('Alice');
    bob = await createIdentity('Bob');
    chanServer = await createServerKey();
  });

  const mk = (messages, extra = {}) =>
    buildChannelPage({ channelId: 'town-hall', serverKey: chanServer, limit: 100, messages, ...extra });

  it('a hasMore loop is cut off after a few pages per round', async () => {
    const full = await mk([{ author: alice, body: 'one' }]);
    let requests = 0;
    const session = createChatSession({
      channelId: 'town-hall',
      getMessages: async (_id, opts) => {
        requests += 1;
        if (opts.tail !== undefined) return clone(full);
        // every poll answers with one more invalid message and hasMore:true, forever
        const page = clone(full);
        const m = clone(full.messages[0]);
        m.seq = 1 + requests;
        page.messages = [m];
        page.hasMore = true;
        return page;
      }
    });
    await session.tick();
    const before = requests;
    await session.tick();
    expect(requests - before).toBeLessThanOrEqual(5);
  });

  it('a poll that jumps ahead is reported and the new message is not tied to the old ones', async () => {
    const full = await mk([
      { author: alice, body: 'one' },
      { author: bob, body: 'two' },
      { author: alice, body: 'three' },
      { author: bob, body: 'four' }
    ]);
    const first = clone(full);
    first.messages = first.messages.slice(0, 1);
    const jump = clone(full);
    jump.messages = jump.messages.slice(3); // seq 4, 2 and 3 withheld
    const session = createChatSession({
      channelId: 'town-hall',
      getMessages: async (_id, opts) => clone(opts.tail !== undefined ? first : jump)
    });
    await session.tick();
    await session.tick();
    const s = session.getState();
    expect(s.problems.join(' ')).toMatch(/not sent by the server/);
    // A message that does not continue the chain already shown cannot be tied to it: the hole is
    // announced in problems, the new message is marked as failed and the head is not called tied.
    // (The same rule stops a real old message from being passed off as a new one behind a gap.)
    expect(s.entries.map((e) => e.seq)).toEqual([1, 4]);
    expect(s.entries[1].verdict.status).toBe('invalid');
    expect(s.anchor.anchored).toBe(false);
  });

  it('a message of another channel replayed into this channel is invalid and shows no name', async () => {
    const other = await buildChannelPage({ channelId: 'other-room', serverKey: chanServer, messages: [{ author: alice, body: 'secret plan' }] });
    const page = clone(other);
    page.channel.channelId = 'town-hall'; // the server lies about the channel
    const { entries } = await verifyPageEntries(page, { channelId: 'town-hall' });
    expect(entries[0].verdict.status).toBe('invalid');
    const html = render(h(MessageItem, { entry: entries[0], name: 'Alice' }));
    expect(html).toContain('Do not trust this message');
    expect(html).not.toContain('Signature verified');
    expect(html).not.toContain('>Alice<');
  });

  it('a reply to a message that failed verification shows none of its text or name', async () => {
    const page = await mk([
      { author: alice, body: 'the original text' },
      { author: bob, body: 'answer', replyTo: 0 }
    ]);
    const bad = clone(page);
    bad.messages[0].record.body = 'tampered text';
    const { entries } = await verifyPageEntries(bad, { channelId: 'town-hall' });
    expect(entries[0].verdict.status).toBe('invalid');
    const html = render(h(ReplyPreview, { replyTo: entries[1].record.replyTo, parent: entries[0], parentName: 'Alice' }));
    expect(html).toContain('A message that failed verification');
    expect(html).not.toContain('tampered text');
    expect(html).not.toContain('Alice');
  });

  it('hostile text in names and bodies is rendered as text', async () => {
    const evil = await createIdentity('<img src=x onerror=alert(1)>');
    const page = await mk([{ author: evil, body: '<script>alert(1)</script> [x](javascript:alert(1)) <a href="javascript:alert(1)">z</a>' }]);
    const { entries } = await verifyPageEntries(page, { channelId: 'town-hall' });
    const html = render(h(MessageList, { entries, identities: page.identities }));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<a [^>]*javascript:/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('a channel row with a hostile docId is a path under /d/, never a javascript: link', () => {
    const row = { channelId: 'town-hall', title: 'T', docId: 'javascript:alert(1)', createdBy: '', createdByName: '', messageCount: 0, lastMessageAt: null };
    const html = render(h(ChannelCard, { channel: row, now: Date.now() }));
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toMatch(/href="\/d\/javascript/);
  });

  it('a server that sends two different messages for one position keeps the first and reports it', async () => {
    const a = await mk([{ author: alice, body: 'real' }]);
    const b = await mk([{ author: bob, body: 'fake' }]);
    let n = 0;
    const session = createChatSession({
      channelId: 'town-hall',
      getMessages: async () => clone(n++ === 0 ? a : { ...b, messages: b.messages, hasMore: false })
    });
    await session.tick();
    await session.tick();
    const s = session.getState();
    expect(s.entries[0].record.body).toBe('real');
  });
});

// ---------------------------------------------------------------------------
describe('ledger audit against a hostile server', () => {
  async function ledgerWorld() {
    const ledger = buildLedger();
    const identities = {};
    for (let i = 0; i < 3; i++) {
      const o = await createIdentity('Owner ' + i);
      const p = await buildBundleParts({ owner: o, serverKey, ledger, versions: [{}, {}] });
      Object.assign(identities, p.identities);
    }
    return { ledger, identities };
  }
  const pageOf = async (w, { after = 0, limit = 200 } = {}) => ({
    ...w.ledger.page({ after, limit }),
    identities: w.identities,
    checkpoint: await ledgerCheckpoint(serverKey, w.ledger),
    server: { keyId: serverKey.keyId, publicKey: serverKey.publicJwk }
  });

  it('passes an honest ledger with the pinned key', async () => {
    const w = await ledgerWorld();
    const r = await auditLedger({ fetchPage: (o) => pageOf(w, o), pinnedServerKeyId: serverKey.keyId, limit: 4 });
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(6);
  });

  it('a server that hides the newest entries but keeps an old checkpoint is caught by the saved position', async () => {
    const w = await ledgerWorld();
    const saved = w.ledger.head();
    const hidden = { ledger: { ...w.ledger, entries: w.ledger.entries.slice(0, 3), head: () => ({ seq: 3, hash: w.ledger.entries[2].ledgerHash }), page: ({ after, limit }) => ({ entries: w.ledger.entries.slice(0, 3).filter((e) => e.seq > after).slice(0, limit), hasMore: false }) }, identities: w.identities };
    const r = await auditLedger({ fetchPage: (o) => pageOf(hidden, o), pinnedServerKeyId: serverKey.keyId, knownPoint: saved });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/before the position you saved/);
  });

  it('a tampered entry hidden in a middle page is found', async () => {
    const w = await ledgerWorld();
    const fetchPage = async (o) => {
      const p = await pageOf(w, o);
      p.entries = clone(p.entries);
      for (const e of p.entries) if (e.seq === 4) e.record.label = 'edited';
      return p;
    };
    const r = await auditLedger({ fetchPage, pinnedServerKeyId: serverKey.keyId, limit: 2 });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the document password never leaves the browser', () => {
  function makeFile(text = 'secret contents', name = 'note.txt') {
    return new File([new TextEncoder().encode(text)], name);
  }
  function stubStorage() {
    const writes = [];
    const map = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => {
        writes.push([k, String(v)]);
        map.set(k, String(v));
      },
      removeItem: (k) => void map.delete(k)
    });
    return writes;
  }
  const mkIdentity = (alice) => ({ keyId: alice.keyId, displayName: 'Alice', publicKey: alice.publicJwk, sign: (r) => signRecord(alice.privateKey, r) });
  const flat = (v) => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? Array.from(x) : x));

  it('publish: no API call, storage write, progress text or console line contains the password', async () => {
    const writes = stubStorage();
    const logs = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug']) vi.spyOn(console, m).mockImplementation((...a) => logs.push(a));
    const alice = await createIdentity('Alice');
    const steps = [];
    const out = await publishNewDocument({ file: makeFile(), identity: mkIdentity(alice), iterations: FAST, onStep: (id, t) => steps.push(id + t) });
    const pw = out.password;
    const compact = pw.replace(/-/g, '');
    expect(pw).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    for (const text of [flat(fake.state.calls), flat(writes), flat(logs), steps.join('|')]) {
      expect(text).not.toContain(pw);
      expect(text).not.toContain(compact);
    }
    // links: the password is only after the hash sign
    expect(out.links.verify).not.toContain('#');
    expect(out.links.verify).not.toContain(compact);
    expect(out.links.full.split('#')).toHaveLength(2);
    expect(out.links.full.split('#')[0]).not.toContain(compact);
    expect(out.links.full.split('#')[1]).toBe('k=' + compact);
    // the locked bytes do not contain the password or the plain text
    const put = fake.state.calls.find((c) => c.fn === 'putBlob');
    expect(put.args[3].length).toBe(64);
    const stored = fake.state.blobs.get(out.blobHash);
    const asText = new TextDecoder('latin1').decode(stored);
    expect(asText).not.toContain('secret contents');
    expect(asText).not.toContain(compact);
  });

  it('a new version and a revoke do not leak the password either, also when the post fails', async () => {
    const writes = stubStorage();
    const alice = await createIdentity('Alice');
    const identity = mkIdentity(alice);
    const head = { version: 1, recordHash: 'ab'.repeat(32) };
    fake.state.postError = Object.assign(new Error('server said no'), { status: 409, code: 'conflict' });
    await expect(publishNewVersion({ docId: 'cd'.repeat(16), head, file: makeFile(), identity, password: PASSWORD, iterations: FAST })).rejects.toThrow('server said no');
    fake.state.postError = null;
    await revokeDocument({ docId: 'cd'.repeat(16), head, reason: 'done', identity });
    const everything = flat(fake.state.calls) + flat(writes);
    expect(everything).not.toContain('ABCDEFGHJKLMNPQRSTUV');
    expect(everything).not.toContain(PASSWORD);
  });

  it('opening a document sends only the document id and the file hash, and the result never repeats the password', async () => {
    const d = await makeDoc(['hello']);
    fake.state.calls.length = 0;
    const r = await openDocument({ docId: d.docId, password: PASSWORD, pinnedServerKeyId: serverKey.keyId });
    expect(r.file).not.toBeNull();
    const sent = flat(fake.state.calls);
    expect(sent).not.toContain('ABCDEFGHJKLMNPQRSTUV');
    expect(sent).not.toContain(PASSWORD);
    const shown = flat({ verification: r.verification, blobCheck: r.blobCheck, plaintextCheck: r.plaintextCheck, fingerprint: r.fingerprint });
    expect(shown).not.toContain('ABCDEFGHJKLMNPQRSTUV');
  });

  it('a wrong password is reported without echoing it', async () => {
    const d = await makeDoc(['hello']);
    const r = await openDocument({ docId: d.docId, password: 'WRONG-PASSWORD-123', pinnedServerKeyId: serverKey.keyId });
    expect(r.plaintextCheck.ok).toBe(false);
    expect(flat(r.plaintextCheck)).not.toContain('WRONG-PASSWORD');
    expect(flat(r.plaintextCheck)).not.toContain('WRONGPASSWORD123');
  });

  it('links: the verify link has no secret, the full link carries it only after the hash, parsing is local', () => {
    expect(verifyLink('ab'.repeat(16))).toBe('/d/' + 'ab'.repeat(16));
    const full = fullLink('ab'.repeat(16), PASSWORD);
    expect(full).toBe('/d/' + 'ab'.repeat(16) + '#k=ABCDEFGHJKLMNPQRSTUV');
    expect(full.split('#')[0]).not.toContain('ABCD');
    expect(parseFragment('#k=ABCD&k=EVIL')).toBe('ABCD');
    expect(parseFragment('#x=1')).toBeNull();
    expect(parseDocInput('javascript:alert(1)').ok).toBe(false);
    expect(parseDocInput('data:text/html,<script>alert(1)</script>').ok).toBe(false);
    const p = parseDocInput('https://evil.example/d/' + 'ab'.repeat(16) + '#k=' + PASSWORD);
    expect(p.ok).toBe(true);
    expect(p.host).toBe('evil.example'); // the page tells the user the host is ignored
  });

  it('the share panel and summaries never receive a password through the bundle download', async () => {
    const d = await makeDoc(['x']);
    const { exportBundle } = await import('../../../src/components/doc/docLogic.js');
    const text = JSON.stringify(exportBundle(d.bundle, serverKey.keyId));
    expect(text).not.toContain('ABCDEFGHJKLMNPQRSTUV');
    expect(text).not.toContain('#k=');
  });
});

// ---------------------------------------------------------------------------
describe('key handling', () => {
  const PASS = 'a long enough passphrase';
  beforeEach(() => {
    keystore.setStorageAdapter(keystore.createMemoryAdapter());
  });

  it('the stored private key is not extractable, is not in the identity object and never logged', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const adapter = keystore.createMemoryAdapter();
    keystore.setStorageAdapter(adapter);
    const { identity, backupText } = await keystore.createIdentity({ displayName: 'Alice', passphrase: PASS, iterations: FAST });
    const stored = await adapter.get('identity');
    expect(stored.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('jwk', stored.privateKey)).rejects.toThrow();
    expect(Object.keys(stored).sort()).toEqual(['backupText', 'createdAt', 'displayName', 'keyId', 'privateKey', 'publicKey', 'record', 'signature']);
    const json = JSON.stringify(identity);
    expect(json).not.toMatch(/"d":/);
    expect(backupText).not.toMatch(/"d":/);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('the backup depends on the passphrase: wrong passphrase, changed bytes, changed header all fail', async () => {
    const { backupText, identity } = await keystore.createIdentity({ displayName: 'Alice', passphrase: PASS, iterations: FAST });
    keystore.setStorageAdapter(keystore.createMemoryAdapter());
    await expect(keystore.restoreIdentity(backupText, 'not the passphrase!')).rejects.toThrow(/wrong passphrase/);
    const file = JSON.parse(backupText);
    const tweak = (fn) => {
      const c = clone(file);
      fn(c);
      return JSON.stringify(c);
    };
    const bad = [
      tweak((c) => (c.kdf.iterations = c.kdf.iterations + 1)),
      tweak((c) => (c.keyId = '0'.repeat(64))),
      tweak((c) => (c.iv = bytesToBase64Url(new Uint8Array(12)))),
      tweak((c) => (c.data = c.data.slice(0, -4))),
      tweak((c) => (c.kdf.hash = 'SHA-1')),
      tweak((c) => (c.v = 3)),
      tweak((c) => (c.kind = 'other'))
    ];
    for (const text of bad) await expect(keystore.restoreIdentity(text, PASS)).rejects.toThrow();
    expect(await keystore.loadIdentity()).toBeNull();
    await keystore.restoreIdentity(backupText, PASS);
    expect((await keystore.loadIdentity()).keyId).toBe(identity.keyId);
  });

  it('iteration bounds: too few, too many, fractional, text and huge files are refused before any work', async () => {
    const { backupText } = await keystore.createIdentity({ displayName: 'Alice', passphrase: PASS, iterations: FAST });
    keystore.setStorageAdapter(keystore.createMemoryAdapter());
    const file = JSON.parse(backupText);
    for (const it2 of [0, 99999, 2000001, 1e12, 100000.5, '100000', null, -1, Infinity]) {
      const c = clone(file);
      c.kdf.iterations = it2;
      const t0 = Date.now();
      await expect(keystore.restoreIdentity(JSON.stringify(c), PASS)).rejects.toThrow('this is not a hrdlock key backup file');
      expect(Date.now() - t0).toBeLessThan(1000);
    }
    await expect(keystore.restoreIdentity('x'.repeat(70000), PASS)).rejects.toThrow('this is not a hrdlock key backup file');
    await expect(keystore.restoreIdentity({ toString: () => backupText }, PASS)).rejects.toThrow();
  });

  it('forget removes the key and the stored backup text, and the identity cannot sign any more', async () => {
    const adapter = keystore.createMemoryAdapter();
    keystore.setStorageAdapter(adapter);
    await keystore.createIdentity({ displayName: 'Alice', passphrase: PASS, iterations: FAST });
    await keystore.forgetIdentity();
    expect(await adapter.get('identity')).toBeUndefined();
    expect(await keystore.loadIdentity()).toBeNull();
    await expect(keystore.exportBackup(PASS)).rejects.toThrow(/no identity/);
  });

  it('a backup file never decrypts a key that does not match its own public key and signature', async () => {
    const { generateKeyPair, exportPrivateJwk, exportPublicJwk, keyIdOf } = await import('../../../shared/keys.js');
    const a = await generateKeyPair({ extractable: true });
    const b = await generateKeyPair({ extractable: true });
    const pubA = await exportPublicJwk(a.publicKey);
    const record = { v: 2, type: 'identity', publicKey: pubA, displayName: 'Mallory', createdAt: 1 };
    const sig = await signRecord(a.privateKey, record);
    // private part of B under the public part of A
    const payload = { privateJwk: await exportPrivateJwk(b.privateKey), publicKey: pubA, displayName: 'Mallory', createdAt: 1, record, signature: sig };
    const text = await keystore.buildBackup(await keyIdOf(pubA), payload, PASS, { iterations: FAST });
    await expect(keystore.restoreIdentity(text, PASS)).rejects.toThrow('the backup content is damaged');
  });
});

// ---------------------------------------------------------------------------
describe('source scan: injection and leakage patterns', () => {
  const ROOT = join(process.cwd(), 'src');
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(jsx?|html)$/.test(name)) files.push(p);
    }
  })(ROOT);
  const code = files.map((f) => ({ f, text: readFileSync(f, 'utf8') }));

  it('there is something to scan', () => {
    expect(code.length).toBeGreaterThan(50);
  });

  it('no dangerouslySetInnerHTML, innerHTML, outerHTML, insertAdjacentHTML, document.write, eval or Function constructor', () => {
    const re = /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]/;
    expect(code.filter((c) => re.test(c.text)).map((c) => c.f)).toEqual([]);
  });

  it('no window.open, no target=_blank, no javascript: or data: urls, no postMessage to other windows', () => {
    const re = /window\.open|target=["']_blank|javascript:|data:text|\bparent\.postMessage|window\.postMessage|top\.location/;
    expect(code.filter((c) => re.test(c.text)).map((c) => c.f.replace(ROOT, ''))).toEqual([]);
  });

  it('every href and to prop is a local path or a hash anchor, never a scheme or a bare variable', () => {
    const literal = [];
    const dynamic = [];
    const reLiteral = /\b(?:href|to)=\{?([`"'][^}\n]*)/g;
    const reDynamic = /\b(?:href|to)=\{([^`"'\s}][^}\n]*)\}/g;
    for (const c of code) {
      const name = c.f.replace(ROOT, '');
      for (const m of c.text.matchAll(reLiteral)) literal.push(name + ' ' + m[1].trim());
      for (const m of c.text.matchAll(reDynamic)) dynamic.push(name + ' ' + m[0]);
    }
    expect(literal.length).toBeGreaterThan(10);
    expect(literal.filter((l) => !/ [`"'][/#]/.test(l))).toEqual([]);
    // the only non literal targets: the router object built by documentRoute (path /d/<id>, hash)
    // and the fixed menu items in Nav.jsx
    expect(dynamic.filter((d) => !/documentRoute\(|Nav\.jsx to=\{item\.to\}/.test(d))).toEqual([]);
    expect(code.find((c) => /Nav\.jsx$/.test(c.f)).text).toMatch(/to: '\/'/);
  });

  it('the app only logs one thing: the error object of the error boundary', () => {
    const hits = [];
    for (const c of code) for (const m of c.text.matchAll(/console\.\w+\([^)]*\)/g)) hits.push(c.f.replace(ROOT, '') + ' ' + m[0]);
    expect(hits).toEqual(['\\components\\ErrorBoundary.jsx console.error(error)']);
  });

  it('browser storage holds only the pin, the local document list, the newest seen heads and the key store', () => {
    const keys = [];
    for (const c of code) for (const m of c.text.matchAll(/(?:localStorage|sessionStorage)/g)) keys.push(c.f.replace(ROOT, ''));
    expect([...new Set(keys)].sort()).toEqual(['\\lib\\headStore.js', '\\lib\\localDocs.js', '\\lib\\pin.js']);
    // ids, numbers and hashes only
    expect(code.find((c) => /headStore\.js$/.test(c.f)).text).toMatch(/passwords or file names/);
    expect(code.find((c) => /localDocs\.js$/.test(c.f)).text).toMatch(/NEVER|never/);
  });

  it('the response headers keep the strict policy and send no referrer', () => {
    const headers = readFileSync(join(process.cwd(), 'public', '_headers'), 'utf8');
    expect(headers).toMatch(/Referrer-Policy: no-referrer/);
    const csp = /Content-Security-Policy: (.*)/.exec(headers)[1];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|http:/);
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/\son\w+=/);
  });
});

// ---------------------------------------------------------------------------
describe('doc summary of a good bundle still says what it should', () => {
  it('shows the pinned state from the key the signature check used', async () => {
    const d = await makeDoc(['x']);
    const r = await openDocument({ docId: d.docId, pinnedServerKeyId: serverKey.keyId });
    const html = render(h(DocSummary, { docId: d.docId, bundle: r.bundle, verification: r.verification, pinnedServerKeyId: serverKey.keyId }));
    expect(html).toContain('Matches your pinned key');
  });
});

// ---------------------------------------------------------------------------
describe('publish flows when two actions start from the same head', () => {
  const mkIdentity = (alice) => ({ keyId: alice.keyId, displayName: 'Alice', publicKey: alice.publicJwk, sign: (r) => signRecord(alice.privateKey, r) });
  const file = () => new File([new TextEncoder().encode('new text')], 'new.txt');

  // A server that enforces the chain rule: version = head + 1 and prev = head hash.
  function chainServer(head) {
    const state = { head: { ...head }, accepted: [] };
    fake.state.postHook = async (_docId, record) => {
      if (record.version !== state.head.version + 1 || record.prev !== state.head.recordHash) {
        throw Object.assign(new Error('the record does not follow the current head'), { status: 409, code: 'conflict' });
      }
      const { recordHash } = await import('../../../shared/records.js');
      state.head = { version: record.version, recordHash: await recordHash(record) };
      state.accepted.push(record.type);
    };
    return state;
  }

  it('an update and a revoke started together: exactly one is accepted and the other one reports the conflict', async () => {
    const alice = await createIdentity('Alice');
    const identity = mkIdentity(alice);
    const head = { version: 1, recordHash: 'ab'.repeat(32) };
    const server = chainServer(head);
    const docId = 'cd'.repeat(16);
    const results = await Promise.allSettled([
      publishNewVersion({ docId, head, file: file(), identity, password: PASSWORD, iterations: FAST }),
      revokeDocument({ docId, head, reason: 'mistake', identity })
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost.reason.code).toBe('conflict');
    expect(server.accepted).toHaveLength(1);
  });

  it('a second update from the same stale head is refused, and nothing is remembered as published', async () => {
    const alice = await createIdentity('Alice');
    const identity = mkIdentity(alice);
    const head = { version: 1, recordHash: 'ab'.repeat(32) };
    chainServer(head);
    const docId = 'cd'.repeat(16);
    await publishNewVersion({ docId, head, file: file(), identity, password: PASSWORD, iterations: FAST });
    await expect(publishNewVersion({ docId, head, file: file(), identity, password: PASSWORD, iterations: FAST })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a revoke from a stale head is refused after an update', async () => {
    const alice = await createIdentity('Alice');
    const identity = mkIdentity(alice);
    const head = { version: 1, recordHash: 'ab'.repeat(32) };
    chainServer(head);
    const docId = 'cd'.repeat(16);
    await publishNewVersion({ docId, head, file: file(), identity, password: PASSWORD, iterations: FAST });
    await expect(revokeDocument({ docId, head, reason: 'late', identity })).rejects.toMatchObject({ code: 'conflict' });
  });
});
