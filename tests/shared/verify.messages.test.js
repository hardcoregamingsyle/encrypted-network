import { beforeAll, describe, expect, it } from 'vitest';
import { verifyMessages } from '../../shared/verify.js';
import { makeCheckpointPayload, signCheckpoint } from '../../shared/checkpoint.js';
import { ZERO_HASH } from '../../shared/records.js';
import { chainHash } from '../../shared/hash.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../shared/encoding.js';
import { buildChannelPage, clone, createIdentity, createServerKey } from '../helpers/bundle.js';

let alice;
let bob;
let server;
let msgs;
const flip = (sig) => {
  const b = base64UrlToBytes(sig);
  b[7] ^= 1;
  return bytesToBase64Url(b);
};
const build = (extra = {}) => buildChannelPage({ channelId: 'town-hall', title: 'Town hall', messages: msgs, serverKey: server, ...extra });

beforeAll(async () => {
  alice = await createIdentity('Alice');
  bob = await createIdentity('Bob');
  server = await createServerKey();
  msgs = [
    { author: alice, body: 'Hello everyone' },
    { author: bob, body: 'Hi Alice\nsecond line', replyTo: 0 },
    { author: alice, body: 'Meeting at noon' },
    { author: bob, body: 'See you there', replyTo: 2 },
    { author: alice, body: 'Bring the signed lease' }
  ];
});

describe('valid pages', () => {
  it('verifies a full page', async () => {
    const page = await build();
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(true);
    expect(res.chainOk).toBe(true);
    expect(res.checkpointOk).toBe(true);
    expect(res.results).toHaveLength(5);
    expect(res.results.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(res.results.every((r) => r.ok && typeof r.detail === 'string')).toBe(true);
    expect(res.warnings).toEqual([]);
  });
  it('replyTo points at the hash of an earlier message', async () => {
    const page = await build();
    expect(page.messages[1].record.replyTo).toBe(page.messages[0].hash);
  });
  it('warns when the server key is not pinned but still passes', async () => {
    const res = await verifyMessages(await build());
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => /not pinned/i.test(w))).toBe(true);
  });
  it('verifies an empty channel', async () => {
    const page = await buildChannelPage({ channelId: 'empty-one', creator: alice, serverKey: server });
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
    expect(res).toMatchObject({ ok: true, chainOk: true, checkpointOk: true, results: [] });
  });
  it('a page cut short by limit is not tied to the checkpoint, so it is not ok by default', async () => {
    const page = await build({ after: 0, limit: 2 });
    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
    expect(res).toMatchObject({ ok: false, chainOk: true, checkpointOk: false, anchored: false });
    expect(res.results.every((r) => r.ok)).toBe(true);
    expect(res.warnings.some((w) => /ahead of this page/i.test(w))).toBe(true);
  });
  it('allowUnanchored accepts a page cut short and says it is not tied to the server', async () => {
    const page = await build({ after: 0, limit: 2 });
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId, allowUnanchored: true });
    expect(res).toMatchObject({ ok: true, chainOk: true, checkpointOk: true, anchored: false });
    expect(res.warnings.some((w) => /not tied to the server/i.test(w))).toBe(true);
  });
  it('the last page of a channel is anchored', async () => {
    const page = await build({ after: 3 });
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
    expect(res).toMatchObject({ ok: true, anchored: true });
  });
  it('a conversation that never happened does not verify under a borrowed checkpoint', async () => {
    const mallory = await createIdentity('Mallory');
    const fake = await buildChannelPage({
      channelId: 'town-hall',
      messages: [{ author: mallory, body: 'one' }, { author: mallory, body: 'two' }],
      serverKey: null
    });
    const real = await build();
    fake.checkpoint = clone(real.checkpoint);
    fake.server = clone(real.server);
    const res = await verifyMessages(fake, { pinnedServerKeyId: server.keyId });
    expect(res).toMatchObject({ ok: false, checkpointOk: false, anchored: false });
  });
  it('needs an explicit channel before it accepts a checkpoint', async () => {
    const page = await build();
    delete page.channel;
    expect((await verifyMessages(page, { pinnedServerKeyId: server.keyId })).checkpointOk).toBe(false);
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId, expectedChannelId: 'town-hall' });
    expect(res).toMatchObject({ ok: true, anchored: true });
    expect((await verifyMessages(page, { pinnedServerKeyId: server.keyId, expectedChannelId: 'other-room' })).ok).toBe(false);
  });
  it('expectedChannelId must match the channel info in the page', async () => {
    const page = await build();
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId, expectedChannelId: 'other-room' });
    expect(res.ok).toBe(false);
    expect(res.checkpointOk).toBe(false);
  });
  it('flags a signed message that appears twice in the chain', async () => {
    const page = await build();
    const m = page.messages[4];
    const dup = { ...clone(m), seq: 6, prevChainHash: m.chainHash, chainHash: await chainHash(m.chainHash, m.hash) };
    page.messages.push(dup);
    page.checkpoint = await signCheckpoint(
      server.privateKey,
      makeCheckpointPayload({ scope: 'channel:town-hall', seq: 6, hash: dup.chainHash, signedAt: Date.now(), serverKeyId: server.keyId })
    );
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(false);
    expect(res.chainOk).toBe(false);
    expect(res.results[5].ok).toBe(false);
    expect(res.results[5].detail).toMatch(/more than once/);
  });
  it('a malformed pin fails closed', async () => {
    const page = await build();
    for (const pin of [12345, true, ['x'], {}, 'not a key id', 'a'.repeat(63)]) {
      const res = await verifyMessages(page, { pinnedServerKeyId: pin });
      expect(res.ok, JSON.stringify(pin)).toBe(false);
      expect(res.checkpointOk).toBe(false);
    }
  });
  it('a page after seq 0 warns that the earlier link cannot be checked', async () => {
    const page = await build({ after: 2 });
    expect(page.messages[0].seq).toBe(3);
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => /earlier messages/i.test(w))).toBe(true);
  });
  it('a tail page works the same way', async () => {
    const page = await build({ tail: 2 });
    expect(page.messages.map((m) => m.seq)).toEqual([4, 5]);
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => /earlier messages/i.test(w))).toBe(true);
  });
  it('checks the first link when the caller knows the previous chain hash', async () => {
    const full = await build();
    const page = { ...clone(full), messages: clone(full.messages.slice(2)) };
    const good = await verifyMessages(page, { pinnedServerKeyId: server.keyId, startPrev: full.messages[1].chainHash });
    expect(good.ok).toBe(true);
    expect(good.warnings).toEqual([]);
    const bad = await verifyMessages(page, { pinnedServerKeyId: server.keyId, startPrev: 'a'.repeat(64) });
    expect(bad.ok).toBe(false);
    expect(bad.chainOk).toBe(false);
  });
  it('does not change its input', async () => {
    const page = await build();
    const copy = clone(page);
    await verifyMessages(page);
    expect(page).toEqual(copy);
  });
});

describe('tampered messages', () => {
  it('detects a changed body', async () => {
    const page = await build();
    page.messages[2].record.body = 'Meeting at midnight';
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
    expect(res.ok).toBe(false);
    expect(res.results.map((r) => r.ok)).toEqual([true, true, false, true, true]);
    expect(res.results[2].detail).toMatch(/signature|hash/);
    expect(res.chainOk).toBe(false);
  });
  it('detects a bad signature', async () => {
    const page = await build();
    page.messages[0].signature = flip(page.messages[0].signature);
    const res = await verifyMessages(page);
    expect(res.results[0].ok).toBe(false);
    expect(res.results[0].detail).toMatch(/signature/);
    expect(res.chainOk).toBe(true);
    expect(res.ok).toBe(false);
  });
  it('detects a message signed by a different key', async () => {
    const page = await buildChannelPage({
      channelId: 'town-hall',
      messages: [{ author: alice, body: 'a' }, { author: alice, body: 'forged', signWith: bob }, { author: alice, body: 'c' }],
      serverKey: server
    });
    const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
    expect(res.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(res.chainOk).toBe(true);
    expect(res.ok).toBe(false);
  });
  it('detects a missing identity', async () => {
    const page = await build();
    delete page.identities[bob.keyId];
    const res = await verifyMessages(page);
    expect(res.results.map((r) => r.ok)).toEqual([true, false, true, false, true]);
    expect(res.results[1].detail).toMatch(/identity/);
  });
  it('detects a forged identity record', async () => {
    const page = await build();
    page.identities[alice.keyId].record.displayName = 'Mallory';
    const res = await verifyMessages(page);
    expect(res.results[0].ok).toBe(false);
  });
  it('detects an identity listed under the wrong key id', async () => {
    const page = await build();
    page.identities[alice.keyId] = clone(page.identities[bob.keyId]);
    const res = await verifyMessages(page);
    expect(res.results[0].ok).toBe(false);
  });
  it('detects a changed stated message hash', async () => {
    const page = await build();
    page.messages[1].hash = 'f'.repeat(64);
    const res = await verifyMessages(page);
    expect(res.results[1].ok).toBe(false);
    expect(res.results[1].detail).toMatch(/hash/);
    expect(res.ok).toBe(false);
  });
  it('detects a changed chain hash and prev chain hash', async () => {
    const a = await build();
    a.messages[2].chainHash = 'f'.repeat(64);
    expect((await verifyMessages(a)).chainOk).toBe(false);
    const b = await build();
    b.messages[2].prevChainHash = 'f'.repeat(64);
    expect((await verifyMessages(b)).chainOk).toBe(false);
  });
  it('detects a dropped message', async () => {
    const page = await build();
    page.messages.splice(2, 1);
    const res = await verifyMessages(page);
    expect(res.chainOk).toBe(false);
    expect(res.ok).toBe(false);
  });
  it('detects reordered messages', async () => {
    const page = await build();
    [page.messages[1], page.messages[2]] = [page.messages[2], page.messages[1]];
    const res = await verifyMessages(page);
    expect(res.chainOk).toBe(false);
  });
  it('detects a duplicated message', async () => {
    const page = await build();
    page.messages.splice(2, 0, clone(page.messages[1]));
    expect((await verifyMessages(page)).chainOk).toBe(false);
  });
  it('detects a first message that does not start from the zero hash', async () => {
    const page = await build();
    page.messages[0].prevChainHash = 'a'.repeat(64);
    expect((await verifyMessages(page)).chainOk).toBe(false);
  });
  it('detects a forged first link that is consistent with its own chain hash', async () => {
    const page = await build();
    const m = page.messages[0];
    m.prevChainHash = 'a'.repeat(64);
    m.chainHash = await chainHash(m.prevChainHash, m.hash);
    const res = await verifyMessages(page);
    expect(res.chainOk).toBe(false);
    expect(res.ok).toBe(false);
  });
  it('detects a message from another channel inserted with a valid signature', async () => {
    const page = await buildChannelPage({
      channelId: 'town-hall',
      messages: [{ author: alice, body: 'a' }, { author: alice, body: 'b', mutate: (r) => (r.channelId = 'elsewhere') }],
      serverKey: server
    });
    const res = await verifyMessages(page);
    expect(res.results[1].ok).toBe(false);
    expect(res.results[1].detail).toMatch(/channel/);
  });
  it('detects an invalid message record (extra field)', async () => {
    const page = await build();
    page.messages[0].record.extra = 1;
    expect((await verifyMessages(page)).results[0].ok).toBe(false);
  });
});

describe('checkpoint', () => {
  it('fails the checkpoint for a wrong pinned key', async () => {
    const other = await createServerKey();
    const res = await verifyMessages(await build(), { pinnedServerKeyId: other.keyId });
    expect(res.checkpointOk).toBe(false);
    expect(res.chainOk).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.results.every((r) => r.ok)).toBe(true);
    expect(res.warnings.some((w) => /pinned/.test(w))).toBe(true);
  });
  it('fails when the checkpoint or server is missing', async () => {
    const none = await buildChannelPage({ channelId: 'town-hall', messages: msgs, serverKey: null });
    const res = await verifyMessages(none);
    expect(res.checkpointOk).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.results.every((r) => r.ok)).toBe(true);
    expect(res.warnings.some((w) => /no server checkpoint/i.test(w))).toBe(true);
    const half = await build();
    half.server = null;
    expect((await verifyMessages(half)).checkpointOk).toBe(false);
  });
  it('fails on a bad checkpoint signature or changed payload', async () => {
    const a = await build();
    a.checkpoint.signature = flip(a.checkpoint.signature);
    expect((await verifyMessages(a)).checkpointOk).toBe(false);
    const b = await build();
    b.checkpoint.payload.seq = 99;
    expect((await verifyMessages(b)).checkpointOk).toBe(false);
  });
  it('fails for a checkpoint of another channel or the ledger', async () => {
    for (const scope of ['channel:other-room', 'ledger']) {
      const page = await build();
      page.checkpoint = await signCheckpoint(
        server.privateKey,
        makeCheckpointPayload({ scope, seq: 5, hash: page.messages[4].chainHash, signedAt: Date.now(), serverKeyId: server.keyId })
      );
      const res = await verifyMessages(page, { pinnedServerKeyId: server.keyId });
      expect(res.checkpointOk, scope).toBe(false);
    }
  });
  it('fails when the checkpoint is older than the newest message', async () => {
    const page = await build();
    page.checkpoint = await signCheckpoint(
      server.privateKey,
      makeCheckpointPayload({ scope: 'channel:town-hall', seq: 3, hash: page.messages[2].chainHash, signedAt: Date.now(), serverKeyId: server.keyId })
    );
    expect((await verifyMessages(page)).checkpointOk).toBe(false);
  });
  it('fails when the checkpoint hash differs at the same seq', async () => {
    const page = await build();
    page.checkpoint = await signCheckpoint(
      server.privateKey,
      makeCheckpointPayload({ scope: 'channel:town-hall', seq: 5, hash: 'e'.repeat(64), signedAt: Date.now(), serverKeyId: server.keyId })
    );
    expect((await verifyMessages(page)).checkpointOk).toBe(false);
  });
  it('an empty page needs a seq 0 or later checkpoint for its channel', async () => {
    const page = await buildChannelPage({ channelId: 'empty-one', creator: alice, serverKey: server });
    expect(page.checkpoint.payload).toMatchObject({ seq: 0, hash: ZERO_HASH, scope: 'channel:empty-one' });
  });
});

describe('malformed pages never throw', () => {
  it.each([undefined, null, 5, 'x', [], {}, { messages: 'x' }, { messages: [null] }, { messages: [5] }, { messages: [{}] }, { messages: [{ seq: 1, record: null }] }])('page %#', async (page) => {
    const res = await verifyMessages(page, { pinnedServerKeyId: 5 });
    expect(res.ok).toBe(false);
    expect(Array.isArray(res.results)).toBe(true);
    expect(Array.isArray(res.warnings)).toBe(true);
    expect(res.checkpointOk).toBe(false);
  });
  it('handles hostile message structures', async () => {
    const page = await build();
    page.messages[0].record = JSON.parse('{"__proto__":{"a":1},"type":"message"}');
    page.messages[1].record.body = { a: [undefined] };
    const res = await verifyMessages(page, null);
    expect(res.ok).toBe(false);
    expect(res.results[0].ok).toBe(false);
    expect(res.results[1].ok).toBe(false);
  });
});
