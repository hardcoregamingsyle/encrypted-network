// Adversarial review of verifyLedgerPage and verifyMessages.
import { describe, expect, it } from 'vitest';
import { verifyLedgerPage, verifyMessages } from '../../../shared/verify.js';
import { signRecord } from '../../../shared/keys.js';
import { ZERO_HASH, newDocId } from '../../../shared/records.js';
import {
  buildBundleParts,
  buildChannelPage,
  buildLedger,
  clone,
  createIdentity,
  createServerKey,
  identityEntry,
  serverInfo
} from '../../helpers/bundle.js';
import { chainHash } from '../../../shared/hash.js';
import { recordHash } from '../../../shared/records.js';
import { getAt, leafPaths, pathText, replacements, withChange } from './fuzz.js';

async function signedUpdateOnly(owner) {
  // A ledger that starts at seq 1 with a doc.update. No create ever appears.
  const ledger = buildLedger();
  const record = {
    v: 2,
    type: 'doc.update',
    docId: newDocId(),
    version: 2,
    prev: 'a'.repeat(64),
    signer: owner.keyId,
    createdAt: Date.now(),
    label: 'x',
    blob: { hash: 'b'.repeat(64), size: 10, suite: 1 },
    commitment: 'c'.repeat(64)
  };
  await ledger.append(record, await signRecord(owner.privateKey, record));
  return { ...ledger.page(), identities: { [owner.keyId]: identityEntry(owner) } };
}

describe('FINDING: a ledger audit from genesis accepts an update with no create', () => {
  it('seq 1 from the zero hash must start with a create', async () => {
    const alice = await createIdentity('Alice');
    const page = await signedUpdateOnly(alice);
    const r = await verifyLedgerPage(page); // defaults: startSeq 1, startPrev ZERO_HASH
    expect(r.ok, JSON.stringify(r.warnings)).toBe(false);
  });

  it('same when the page is one of several, carried docState is empty at seq 1', async () => {
    const alice = await createIdentity('Alice');
    const page = await signedUpdateOnly(alice);
    const r = await verifyLedgerPage(page, { startSeq: 1, startPrev: ZERO_HASH, docState: new Map() });
    expect(r.ok).toBe(false);
  });
});

describe('held up: ledger pages', () => {
  async function makeLedger(n = 3) {
    const alice = await createIdentity('Alice');
    const server = await createServerKey();
    const ledger = buildLedger();
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(await buildBundleParts({ owner: alice, serverKey: server, ledger, versions: [{}, {}] }));
    return { alice, ledger, page: { ...ledger.page(), identities: { [alice.keyId]: identityEntry(alice) } } };
  }

  it('a clean page verifies', async () => {
    const { page } = await makeLedger();
    const r = await verifyLedgerPage(page);
    expect(r.ok).toBe(true);
    expect(r.lastSeq).toBe(6);
  });

  it('the same record repeated at two seqs is caught', async () => {
    const { page, ledger } = await makeLedger(1);
    const e = clone(page.entries[0]);
    const prev = page.entries[page.entries.length - 1];
    const dup = { ...e, seq: prev.seq + 1, prevLedgerHash: prev.ledgerHash, ledgerHash: await chainHash(prev.ledgerHash, e.recordHash) };
    page.entries.push(dup);
    expect((await verifyLedgerPage(page)).ok).toBe(false);
    expect(ledger.entries.length).toBe(2);
  });

  it('a wrong startPrev for a mid chain page is caught', async () => {
    const { page } = await makeLedger();
    const later = { ...page, entries: page.entries.slice(2) };
    expect((await verifyLedgerPage(later, { startSeq: 3, startPrev: 'e'.repeat(64) })).ok).toBe(false);
    expect((await verifyLedgerPage(later, { startSeq: 3, startPrev: page.entries[1].ledgerHash })).ok).toBe(true);
  });

  it('carried docState with a wrong signer is caught', async () => {
    const { page, alice } = await makeLedger(1);
    const mallory = await createIdentity('Mallory');
    const state = new Map();
    const first = await verifyLedgerPage({ ...page, entries: page.entries.slice(0, 1) }, { docState: state });
    expect(first.ok).toBe(true);
    const only = state.keys().next().value;
    state.get(only).signer = mallory.keyId;
    const second = await verifyLedgerPage(
      { ...page, entries: page.entries.slice(1) },
      { startSeq: 2, startPrev: page.entries[0].ledgerHash, docState: state }
    );
    expect(second.ok).toBe(false);
    expect(alice.keyId).not.toBe(mallory.keyId);
  });

  it('a page where every entry is individually fine but seq numbers are relabelled is caught', async () => {
    const { page } = await makeLedger();
    const relabelled = clone(page);
    for (const e of relabelled.entries) e.seq += 5;
    expect((await verifyLedgerPage(relabelled)).ok).toBe(false);
  });

  it('mutation fuzz: any change to a ledger page is detected', async () => {
    const { page } = await makeLedger(2);
    const surprising = [];
    for (const path of leafPaths(page)) {
      if (path[0] === 'hasMore') continue;
      for (const rep of replacements(getAt(page, path))) {
        const r = await verifyLedgerPage(withChange(page, path, rep));
        const allowed = /^identities\.[0-9a-f]{64}\.(publicKey\..*|displayName|createdAt)$/.test(pathText(path));
        if (r.ok && !allowed) surprising.push(pathText(path) + ' -> ' + (typeof rep === 'symbol' ? 'deleted' : JSON.stringify(rep)));
      }
    }
    expect(surprising).toEqual([]);
  }, 120000);
});

async function realChannel(n = 6) {
  const server = await createServerKey();
  const alice = await createIdentity('Alice');
  const messages = Array.from({ length: n }, (_, i) => ({ author: alice, body: 'real message ' + i }));
  const page = await buildChannelPage({ channelId: 'general', messages, serverKey: server });
  return { server, alice, page };
}

describe('FINDING: a channel checkpoint is not bound to the messages', () => {
  it('a conversation that never happened must not verify under the pinned server key', async () => {
    const { server, page: real } = await realChannel(6);
    const mallory = await createIdentity('Mallory');
    const fake = await buildChannelPage({
      channelId: 'general',
      messages: [
        { author: mallory, body: 'I approve the transfer.' },
        { author: mallory, body: 'Signed, Mallory.' }
      ],
      serverKey: null
    });
    // Borrow a genuine checkpoint of the real channel (seq 6, newer than the fake chain).
    fake.checkpoint = clone(real.checkpoint);
    fake.server = serverInfo(server);
    const r = await verifyMessages(fake, { pinnedServerKeyId: server.keyId });
    expect(r.ok, JSON.stringify(r)).toBe(false);
  });
});

describe('FINDING: a ledger scope checkpoint is accepted for a channel page when the channel is unknown', () => {
  it('an empty page with no channel info must not accept a ledger checkpoint', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const parts = await buildBundleParts({ owner: alice, serverKey: server, versions: [{}] });
    const page = { messages: [], identities: {}, checkpoint: parts.bundle.checkpoint, server: parts.bundle.server };
    const r = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
    expect(r.checkpointOk).toBe(false);
  });
});

describe('FINDING: a replayed message is accepted twice in one chain', () => {
  it('the same signed message at two seqs must be flagged', async () => {
    const { server, alice, page } = await realChannel(2);
    const m = page.messages[1];
    const last = page.messages[1];
    const copy = {
      ...clone(m),
      seq: last.seq + 1,
      prevChainHash: last.chainHash,
      chainHash: await chainHash(last.chainHash, m.hash)
    };
    const replayed = clone(page);
    replayed.messages.push(copy);
    const payload = replayed.checkpoint.payload;
    expect(payload.seq).toBe(2);
    // re-sign a checkpoint for the extended chain, as a hostile server could
    const { signCheckpoint, makeCheckpointPayload } = await import('../../../shared/checkpoint.js');
    replayed.checkpoint = await signCheckpoint(
      server.privateKey,
      makeCheckpointPayload({ scope: 'channel:general', seq: 3, hash: copy.chainHash, signedAt: payload.signedAt, serverKeyId: server.keyId })
    );
    const r = await verifyMessages(replayed, { pinnedServerKeyId: server.keyId });
    expect(alice.keyId).toBeTruthy();
    expect(r.ok).toBe(false);
  });
});

describe('held up: chat pages', () => {
  it('a clean page verifies', async () => {
    const { server, page } = await realChannel(4);
    const r = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
    expect(r.ok).toBe(true);
  });

  it('a message moved to another channel is caught', async () => {
    const { server, page } = await realChannel(3);
    const moved = clone(page);
    moved.channel.channelId = 'other-room';
    moved.checkpoint = clone(page.checkpoint);
    const r = await verifyMessages(moved, { pinnedServerKeyId: server.keyId });
    expect(r.ok).toBe(false);
  });

  it('a wrong pinned server key fails closed', async () => {
    const { page } = await realChannel(3);
    const other = await createServerKey();
    const r = await verifyMessages(page, { pinnedServerKeyId: other.keyId });
    expect(r.ok).toBe(false);
    expect(r.checkpointOk).toBe(false);
  });

  it('seq relabelled on a full page from seq 1 is caught', async () => {
    const { server, page } = await realChannel(3);
    const p = clone(page);
    p.messages.forEach((m) => (m.seq += 1));
    expect((await verifyMessages(p, { pinnedServerKeyId: server.keyId })).ok).toBe(false);
  });

  it('mutation fuzz: any change to a full chat page is detected', async () => {
    const { server, page } = await realChannel(3);
    const surprising = [];
    for (const path of leafPaths(page)) {
      const original = getAt(page, path);
      for (const rep of replacements(original)) {
        if (rep === original) continue;
        const r = await verifyMessages(withChange(page, path, rep), { pinnedServerKeyId: server.keyId });
        const text = pathText(path);
        // deleting channel.channelId just falls back to the channel named by the signed messages
        if (text === 'channel.channelId' && typeof rep === 'symbol') continue;
        const unsignedDisplay = /^(hasMore|channel\.(title|docId|createdBy|createdByName|createdAt|messageCount|lastMessageAt))$/.test(text);
        const optionalDup = /^identities\.[0-9a-f]{64}\.(publicKey\..*|displayName|createdAt)$/.test(text) || text === 'server.keyId';
        if (r.ok && !unsignedDisplay && !optionalDup) surprising.push(text + ' -> ' + (typeof rep === 'symbol' ? 'deleted' : JSON.stringify(rep)));
      }
    }
    expect(surprising).toEqual([]);
  }, 120000);
});

// keep imports used
void ZERO_HASH;
void recordHash;
