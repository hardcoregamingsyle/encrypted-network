import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeCheckpointPayload, signCheckpoint } from '../../shared/checkpoint.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../shared/encoding.js';
import { verifyMessages } from '../../shared/verify.js';
import { ApiError } from '../../src/lib/api.js';
import { checkAnchor, createChatSession, describeAnchor, verifyPageEntries } from '../../src/lib/chatClient.js';
import { buildChannelPage, clone, createIdentity, createServerKey } from '../helpers/bundle.js';

const CHANNEL = 'town-hall';
let alice;
let bob;
let mallory;
let server;
let full; // the whole chain, 8 messages
const BODIES = [
  ['alice', 'Welcome'],
  ['bob', 'Hello Alice'],
  ['alice', 'Meeting at noon'],
  ['bob', 'See you there'],
  ['alice', 'Bring the lease'],
  ['bob', 'Will do'],
  ['alice', 'Thanks'],
  ['bob', 'Bye']
];

const flip = (sig) => {
  const b = base64UrlToBytes(sig);
  b[7] ^= 1;
  return bytesToBase64Url(b);
};

beforeAll(async () => {
  alice = await createIdentity('Alice');
  bob = await createIdentity('Bob');
  mallory = await createIdentity('Mallory');
  server = await createServerKey();
  const who = { alice, bob };
  full = await buildChannelPage({
    channelId: CHANNEL,
    title: 'Town hall',
    messages: BODIES.map(([a, body], i) => ({ author: who[a], body, replyTo: i === 3 ? 2 : '' })),
    serverKey: server,
    limit: 100
  });
});

// A fake server that shows the first `visible` messages of the chain and signs a checkpoint for that.
async function serverAt(visible, { sign = true } = {}) {
  const all = full.messages;
  const head = all[visible - 1];
  const cp = sign
    ? await signCheckpoint(
        server.privateKey,
        makeCheckpointPayload({
          scope: 'channel:' + CHANNEL,
          seq: visible,
          hash: head ? head.chainHash : '0'.repeat(64),
          signedAt: Date.now(),
          serverKeyId: server.keyId
        })
      )
    : null;
  const calls = [];
  const getMessages = async (id, opts = {}) => {
    calls.push({ id, ...opts });
    const seen = all.slice(0, visible);
    let shown;
    let hasMore = false;
    if (opts.tail !== undefined) shown = seen.slice(Math.max(0, seen.length - opts.tail));
    else {
      const rest = seen.filter((m) => m.seq > (opts.after || 0));
      const limit = opts.limit || 50;
      shown = rest.slice(0, limit);
      hasMore = rest.length > limit;
    }
    return clone({
      channel: { ...full.channel, messageCount: visible },
      messages: shown,
      identities: full.identities,
      checkpoint: cp,
      server: sign ? full.server : null,
      hasMore
    });
  };
  return { getMessages, calls };
}

const statuses = (entries) => entries.map((e) => e.verdict.status);

describe('verifyPageEntries', () => {
  it('marks every message of a good page as verified', async () => {
    const page = clone(full);
    const r = await verifyPageEntries(page, { channelId: CHANNEL, pin: server.keyId });
    expect(r.entries).toHaveLength(8);
    expect(statuses(r.entries).every((s) => s === 'verified')).toBe(true);
    expect(r.chainOk).toBe(true);
    expect(r.entries[0].verdict.detail).toMatch(/signature/);
    expect(r.entries.every((e) => e.record && e.seq >= 1)).toBe(true);
  });

  it('marks a tampered body as invalid and the others stay verified', async () => {
    const page = clone(full);
    page.messages[2].record.body = 'Meeting at midnight';
    const r = await verifyPageEntries(page, { channelId: CHANNEL });
    expect(r.entries[2].verdict.status).toBe('invalid');
    expect(r.entries[2].verdict.detail).toMatch(/signature|hash/);
    expect(r.entries[0].verdict.status).toBe('verified');
    expect(r.chainOk).toBe(false);
  });

  it('marks a flipped signature as invalid', async () => {
    const page = clone(full);
    page.messages[4].signature = flip(page.messages[4].signature);
    const r = await verifyPageEntries(page, { channelId: CHANNEL });
    expect(r.entries[4].verdict).toMatchObject({ status: 'invalid' });
    expect(r.entries[4].verdict.detail).toMatch(/signature does not verify/);
  });

  it('marks a message signed by the wrong key as invalid', async () => {
    const page = await buildChannelPage({
      channelId: CHANNEL,
      messages: [
        { author: alice, body: 'real' },
        { author: alice, body: 'forged', signWith: mallory }
      ],
      serverKey: server
    });
    const r = await verifyPageEntries(page, { channelId: CHANNEL });
    expect(r.entries[0].verdict.status).toBe('verified');
    expect(r.entries[1].verdict.status).toBe('invalid');
    expect(r.entries[1].verdict.detail).toMatch(/signature does not verify/);
  });

  it('marks a message from an unknown signer as invalid', async () => {
    const page = clone(full);
    delete page.identities[bob.keyId];
    const r = await verifyPageEntries(page, { channelId: CHANNEL });
    expect(r.entries[1].verdict.status).toBe('invalid');
    expect(r.entries[0].verdict.status).toBe('verified');
  });

  it('marks a replayed message in one page as invalid', async () => {
    const page = clone(full);
    const copy = clone(page.messages[0]);
    copy.seq = 9;
    copy.prevChainHash = page.messages[7].chainHash;
    page.messages.push(copy);
    const r = await verifyPageEntries(page, { channelId: CHANNEL });
    expect(r.entries[8].verdict.status).toBe('invalid');
    expect(r.entries[8].verdict.detail).toMatch(/more than once|chain link/);
    expect(r.chainOk).toBe(false);
  });

  it('marks a message that was already shown at another position as a replay', async () => {
    const page = clone(full);
    const known = new Map([[page.messages[1].hash, 99]]);
    const r = await verifyPageEntries(page, { channelId: CHANNEL, known });
    expect(r.entries[1].verdict.status).toBe('invalid');
    expect(r.entries[1].verdict.detail).toMatch(/replayed/);
    expect(r.entries[1].verdict.detail).toContain('99');
  });

  it('marks messages of another channel as invalid', async () => {
    const page = clone(full);
    const r = await verifyPageEntries(page, { channelId: 'other-channel' });
    expect(statuses(r.entries).every((s) => s === 'invalid')).toBe(true);
  });

  it('checks the link to the previous message when startPrev is given', async () => {
    const part = await buildChannelPage({
      channelId: CHANNEL,
      messages: BODIES.map(([a, body]) => ({ author: a === 'alice' ? alice : bob, body })),
      serverKey: server,
      after: 4
    });
    const good = await verifyPageEntries(part, { channelId: CHANNEL, startPrev: part.messages[0].prevChainHash });
    expect(statuses(good.entries).every((s) => s === 'verified')).toBe(true);
    const bad = await verifyPageEntries(part, { channelId: CHANNEL, startPrev: 'ee'.repeat(32) });
    expect(bad.entries[0].verdict.status).toBe('invalid');
    expect(bad.entries[0].verdict.detail).toMatch(/chain link/);
  });

  it('gives "unverified" when the check itself fails to run', async () => {
    const verify = vi.fn(async () => {
      throw new Error('worker crashed');
    });
    const r = await verifyPageEntries(clone(full), { channelId: CHANNEL, verify });
    expect(statuses(r.entries).every((s) => s === 'unverified')).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/worker crashed/);
    expect(r.ran).toBe(false);
  });

  it('never makes a failed message verified when results are missing or short', async () => {
    const verify = vi.fn(async () => ({ results: [{ seq: 1, ok: true, detail: 'fine' }], chainOk: true, warnings: [] }));
    const r = await verifyPageEntries(clone(full), { channelId: CHANNEL, verify });
    expect(r.entries[0].verdict.status).toBe('verified');
    expect(r.entries[1].verdict.status).toBe('unverified');
  });

  it('ignores entries that are not objects and copes with a missing page', async () => {
    const page = clone(full);
    page.messages.splice(1, 0, null, 5, 'x');
    const r = await verifyPageEntries(page, { channelId: CHANNEL });
    expect(r.entries).toHaveLength(8);
    expect(r.warnings.join(' ')).toMatch(/not messages/);
    const empty = await verifyPageEntries(undefined, { channelId: CHANNEL });
    expect(empty.entries).toEqual([]);
  });

  it('does not let a verdict on the input leak into the verifier', async () => {
    const seen = [];
    const verify = async (page, opts) => {
      seen.push(...page.messages.map((m) => 'verdict' in m));
      return verifyMessages(page, opts);
    };
    const page = clone(full);
    page.messages[0].verdict = { status: 'verified', detail: 'forged by the server' };
    const r = await verifyPageEntries(page, { channelId: CHANNEL, verify });
    expect(seen.some(Boolean)).toBe(false);
    expect(r.entries[0].verdict.detail).not.toMatch(/forged/);
  });
});

describe('checkAnchor', () => {
  it('is anchored when the newest message is the checkpoint position', async () => {
    const page = clone(full);
    const head = (await verifyPageEntries(page, { channelId: CHANNEL })).entries.at(-1);
    const a = await checkAnchor({ headEntry: head, identities: page.identities, page, channelId: CHANNEL, pin: server.keyId });
    expect(a.anchored).toBe(true);
    expect(a.pinned).toBe(true);
    expect(a.checkpointSeq).toBe(8);
    expect(describeAnchor(a).title).toBe('Latest messages tied to the server head');
  });

  it('is not anchored for an older page, and says so', async () => {
    const page = clone(full);
    const head = (await verifyPageEntries({ ...page, messages: page.messages.slice(0, 5) }, { channelId: CHANNEL })).entries.at(-1);
    const a = await checkAnchor({ headEntry: head, identities: page.identities, page, channelId: CHANNEL, pin: '' });
    expect(a.anchored).toBe(false);
    expect(a.headSeq).toBe(5);
    expect(describeAnchor(a).title).toBe('Not tied to the server head, older page');
  });

  it('is not anchored with the wrong pinned key', async () => {
    const page = clone(full);
    const head = (await verifyPageEntries(page, { channelId: CHANNEL })).entries.at(-1);
    const a = await checkAnchor({ headEntry: head, identities: page.identities, page, channelId: CHANNEL, pin: 'cd'.repeat(32) });
    expect(a.anchored).toBe(false);
    expect(describeAnchor(a).tone).toBe('warn');
  });

  it('is not anchored without a checkpoint', async () => {
    const page = await buildChannelPage({ channelId: CHANNEL, messages: [{ author: alice, body: 'x' }], serverKey: null });
    const head = (await verifyPageEntries(page, { channelId: CHANNEL })).entries.at(-1);
    const a = await checkAnchor({ headEntry: head, identities: page.identities, page, channelId: CHANNEL });
    expect(a.anchored).toBe(false);
    expect(a.hasCheckpoint).toBe(false);
  });

  it('is not anchored when the checkpoint is for another channel', async () => {
    const page = clone(full);
    const head = (await verifyPageEntries(page, { channelId: CHANNEL })).entries.at(-1);
    const a = await checkAnchor({ headEntry: head, identities: page.identities, page, channelId: 'other-channel' });
    expect(a.anchored).toBe(false);
  });

  it('is not anchored when the newest message was swapped but the old checkpoint stays', async () => {
    const page = clone(full);
    page.messages[7].record.body = 'changed';
    const head = (await verifyPageEntries(page, { channelId: CHANNEL })).entries.at(-1);
    const a = await checkAnchor({ headEntry: head, identities: page.identities, page, channelId: CHANNEL });
    expect(a.anchored).toBe(false);
  });

  it('anchors an empty channel with an empty checkpoint', async () => {
    const empty = await buildChannelPage({ channelId: CHANNEL, messages: [], creator: alice, serverKey: server });
    const a = await checkAnchor({ headEntry: null, identities: {}, page: empty, channelId: CHANNEL, pin: server.keyId });
    expect(a.anchored).toBe(true);
    expect(a.headSeq).toBe(0);
  });

  it('survives a verifier that throws', async () => {
    const page = clone(full);
    const a = await checkAnchor({
      headEntry: page.messages[7],
      identities: page.identities,
      page,
      channelId: CHANNEL,
      verify: async () => {
        throw new Error('boom');
      }
    });
    expect(a.anchored).toBe(false);
    expect(a.warnings.join(' ')).toMatch(/boom/);
  });
});

describe('chat session', () => {
  const make = (srv, extra = {}) =>
    createChatSession({ channelId: CHANNEL, getMessages: srv.getMessages, getPin: () => server.keyId, ...extra });

  it('loads the last 50 messages with tail=50 and verifies each one', async () => {
    const srv = await serverAt(8);
    const s = make(srv);
    expect(s.getState().phase).toBe('loading');
    await s.tick();
    expect(srv.calls[0]).toEqual({ id: CHANNEL, tail: 50 });
    const st = s.getState();
    expect(st.phase).toBe('ready');
    expect(st.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(statuses(st.entries).every((x) => x === 'verified')).toBe(true);
    expect(st.anchor.anchored).toBe(true);
    expect(st.hasOlder).toBe(false);
    expect(st.lastSeq).toBe(8);
    expect(st.problems).toEqual([]);
    expect(st.channel.channelId).toBe(CHANNEL);
    expect(Object.keys(st.identities).sort()).toEqual([alice.keyId, bob.keyId].sort());
  });

  it('offers older messages when the first loaded one is not number 1', async () => {
    const srv = await serverAt(8);
    const s = make(srv, { tail: 3 });
    await s.tick();
    const st = s.getState();
    expect(st.entries.map((e) => e.seq)).toEqual([6, 7, 8]);
    expect(st.hasOlder).toBe(true);
    expect(st.anchor.anchored).toBe(true);
    expect(statuses(st.entries).every((x) => x === 'verified')).toBe(true);
  });

  it('polls with after=<last seq> and merges new messages', async () => {
    let srv = await serverAt(5);
    const s = createChatSession({ channelId: CHANNEL, getMessages: (...a) => srv.getMessages(...a), getPin: () => server.keyId });
    await s.tick();
    expect(s.getState().lastSeq).toBe(5);
    const first = srv;
    srv = await serverAt(8);
    await s.tick();
    expect(srv.calls[0]).toEqual({ id: CHANNEL, after: 5, limit: 50 });
    expect(first.calls).toHaveLength(1);
    const st = s.getState();
    expect(st.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(statuses(st.entries).every((x) => x === 'verified')).toBe(true);
    expect(st.anchor.anchored).toBe(true);
    expect(st.anchor.checkpointSeq).toBe(8);
  });

  it('an empty poll adds nothing and keeps the head tied', async () => {
    const srv = await serverAt(8);
    const s = make(srv);
    await s.tick();
    await s.tick();
    await s.tick();
    expect(srv.calls[1]).toEqual({ id: CHANNEL, after: 8, limit: 50 });
    expect(s.getState().entries).toHaveLength(8);
    expect(s.getState().anchor.anchored).toBe(true);
  });

  it('shows a tampered new message as invalid without touching the old ones', async () => {
    const good = await serverAt(5);
    const s = createChatSession({
      channelId: CHANNEL,
      getMessages: async (id, opts) => {
        const page = await (opts.tail !== undefined ? good : bad).getMessages(id, opts);
        if (opts.tail === undefined && page.messages[0]) page.messages[0].record.body = 'rewritten by the server';
        return page;
      },
      getPin: () => server.keyId
    });
    const bad = await serverAt(8);
    await s.tick();
    await s.tick();
    const st = s.getState();
    expect(st.entries.slice(0, 5).every((e) => e.verdict.status === 'verified')).toBe(true);
    expect(st.entries[5].verdict.status).toBe('invalid');
    expect(st.entries[5].seq).toBe(6);
    expect(st.problems.length).toBeGreaterThan(0);
  });

  it('reports a gap when the server skips messages', async () => {
    const srv = await serverAt(8);
    const small = await serverAt(4);
    let current = small;
    const s2 = createChatSession({
      channelId: CHANNEL,
      getMessages: async (id, opts) => {
        const page = await current.getMessages(id, opts);
        if (opts.after === 4) page.messages = page.messages.slice(2);
        return page;
      },
      getPin: () => server.keyId
    });
    await s2.tick();
    current = srv;
    await s2.tick();
    expect(s2.getState().problems.join(' ')).toMatch(/Messages 5 to 6 were not sent/);
  });

  it('loads older messages and joins them to the newer ones', async () => {
    const srv = await serverAt(8);
    const s = make(srv, { tail: 3, pageSize: 3 });
    await s.tick();
    const added = await s.loadOlder();
    expect(added).toBe(3);
    expect(srv.calls[1]).toEqual({ id: CHANNEL, after: 2, limit: 3 });
    expect(s.getState().entries.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(s.getState().hasOlder).toBe(true);
    await s.loadOlder();
    expect(srv.calls[2]).toEqual({ id: CHANNEL, after: 0, limit: 2 });
    const st = s.getState();
    expect(st.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(st.hasOlder).toBe(false);
    expect(statuses(st.entries).every((x) => x === 'verified')).toBe(true);
    expect(st.anchor.anchored).toBe(true);
    expect(st.problems).toEqual([]);
    expect(await s.loadOlder()).toBe(0);
  });

  it('flags an older page that does not connect', async () => {
    const srv = await serverAt(8);
    const s = createChatSession({
      channelId: CHANNEL,
      getMessages: async (id, opts) => {
        const page = await srv.getMessages(id, opts);
        if (opts.tail === undefined) page.messages = page.messages.slice(0, 1); // seq 3 only, a hole before 6
        return page;
      },
      getPin: () => server.keyId,
      tail: 3,
      pageSize: 3
    });
    await s.tick();
    await s.loadOlder();
    const st = s.getState();
    expect(st.problems.join(' ')).toMatch(/does not connect/);
    expect(st.entries.find((e) => e.seq === 3).verdict.status).toBe('invalid');
  });

  it('keeps the first message when the server later sends a different one for the same seq', async () => {
    const srv = await serverAt(6);
    const other = await buildChannelPage({
      channelId: CHANNEL,
      messages: BODIES.map(([a, body]) => ({ author: a === 'alice' ? alice : bob, body })),
      serverKey: server,
      limit: 100
    });
    let phase = 0;
    const s = createChatSession({
      channelId: CHANNEL,
      getMessages: async (id, opts) => {
        const page = await srv.getMessages(id, opts);
        if (phase === 1 && opts.after !== undefined) {
          // a different message claiming seq 6 again
          page.messages = [{ ...other.messages[5], seq: 6 }];
          page.identities = other.identities;
        }
        return page;
      },
      getPin: () => server.keyId
    });
    await s.tick();
    const firstHash = s.getState().entries[5].hash;
    phase = 1;
    // after=6 would normally be empty, so force a poll that returns a competing seq 6
    const orig = s.getState().lastSeq;
    expect(orig).toBe(6);
    await s.tick();
    expect(s.getState().entries[5].hash).toBe(firstHash);
    expect(s.getState().problems.join(' ')).toMatch(/two different messages/);
  });

  it('does not run two requests at once', async () => {
    const srv = await serverAt(8);
    let release;
    const gate = new Promise((r) => (release = r));
    const getMessages = vi.fn(async (...a) => {
      await gate;
      return srv.getMessages(...a);
    });
    const s = createChatSession({ channelId: CHANNEL, getMessages, getPin: () => server.keyId });
    const a = s.tick();
    const b = s.tick();
    expect(a).toBe(b);
    release();
    await Promise.all([a, b]);
    expect(getMessages).toHaveBeenCalledTimes(1);
  });

  it('ends polling with phase missing on a 404', async () => {
    const s = createChatSession({
      channelId: CHANNEL,
      getMessages: async () => {
        throw new ApiError(404, 'not_found', 'no such channel');
      }
    });
    const r = await s.tick();
    expect(r).toEqual({ stop: true });
    expect(s.getState().phase).toBe('missing');
  });

  it('keeps the shown messages and counts failures when the network drops, then recovers', async () => {
    const srv = await serverAt(8);
    let down = false;
    const s = createChatSession({
      channelId: CHANNEL,
      getMessages: async (...a) => {
        if (down) throw new ApiError(0, 'network', 'Could not reach the server. Check your connection and try again.');
        return srv.getMessages(...a);
      },
      getPin: () => server.keyId
    });
    await s.tick();
    down = true;
    await expect(s.tick()).rejects.toThrow();
    let st = s.getState();
    expect(st.phase).toBe('ready');
    expect(st.entries).toHaveLength(8);
    expect(st.failures).toBe(1);
    expect(st.error).toMatch(/reach the server/);
    await expect(s.tick()).rejects.toThrow();
    expect(s.getState().failures).toBe(2);
    down = false;
    await s.tick();
    st = s.getState();
    expect(st.failures).toBe(0);
    expect(st.error).toBeNull();
  });

  it('shows an error phase when the very first load fails', async () => {
    const s = createChatSession({
      channelId: CHANNEL,
      getMessages: async () => {
        throw new ApiError(500, 'server_error', 'server error');
      }
    });
    await expect(s.tick()).rejects.toThrow();
    expect(s.getState().phase).toBe('error');
    expect(s.getState().entries).toEqual([]);
  });

  it('rejects an answer that is not a page', async () => {
    const s = createChatSession({ channelId: CHANNEL, getMessages: async () => ({ nope: true }) });
    await expect(s.tick()).rejects.toThrow(/could not be read/);
    expect(s.getState().phase).toBe('error');
  });

  it('uses the pinned key: a different pin means the head is not tied', async () => {
    const srv = await serverAt(8);
    const s = createChatSession({ channelId: CHANNEL, getMessages: srv.getMessages, getPin: () => 'ab'.repeat(32) });
    await s.tick();
    expect(s.getState().anchor.anchored).toBe(false);
    expect(s.getState().entries.every((e) => e.verdict.status === 'verified')).toBe(true);
  });

  it('works when the server has no signing key', async () => {
    const srv = await serverAt(8, { sign: false });
    const s = make(srv);
    await s.tick();
    const st = s.getState();
    expect(st.entries.every((e) => e.verdict.status === 'verified')).toBe(true);
    expect(st.anchor.anchored).toBe(false);
    expect(st.anchor.hasCheckpoint).toBe(false);
  });

  it('flags a page for a different channel', async () => {
    const srv = await serverAt(8);
    const s = createChatSession({ channelId: 'other-channel', getMessages: srv.getMessages, getPin: () => server.keyId });
    await s.tick();
    const st = s.getState();
    expect(st.entries.every((e) => e.verdict.status === 'invalid')).toBe(true);
    expect(st.problems.join(' ')).toMatch(/different channel/);
    expect(st.anchor.anchored).toBe(false);
  });

  it('notifies subscribers, and stops after dispose', async () => {
    const srv = await serverAt(8);
    const s = make(srv);
    const seen = [];
    const off = s.subscribe((st) => seen.push(st.phase));
    await s.tick();
    expect(seen.at(-1)).toBe('ready');
    const count = seen.length;
    off();
    await s.tick();
    expect(seen).toHaveLength(count);
    s.dispose();
    const r = await s.tick();
    expect(r).toEqual({ stop: true });
  });

  it('does not change state when disposed while a request is running', async () => {
    const srv = await serverAt(8);
    let release;
    const gate = new Promise((r) => (release = r));
    const s = createChatSession({
      channelId: CHANNEL,
      getMessages: async (...a) => {
        await gate;
        return srv.getMessages(...a);
      },
      getPin: () => server.keyId
    });
    const p = s.tick();
    s.dispose();
    release();
    await p;
    expect(s.getState().entries).toEqual([]);
  });

  it('survives a throwing pin reader', async () => {
    const srv = await serverAt(8);
    const s = createChatSession({
      channelId: CHANNEL,
      getMessages: srv.getMessages,
      getPin: () => {
        throw new Error('storage blocked');
      }
    });
    await s.tick();
    expect(s.getState().entries.every((e) => e.verdict.status === 'verified')).toBe(true);
  });

  it('keeps reply links usable: the parent hash is in the loaded entries', async () => {
    const srv = await serverAt(8);
    const s = make(srv);
    await s.tick();
    const entries = s.getState().entries;
    const reply = entries.find((e) => e.record.replyTo);
    expect(reply.seq).toBe(4);
    expect(entries.find((e) => e.hash === reply.record.replyTo).seq).toBe(3);
  });
});
