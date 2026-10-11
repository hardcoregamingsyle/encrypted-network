// The sending steps: signing, optimistic state, delivery, retry, re-sign, rate limit.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { deliverItem, prepareItem, refreshItem } from '../../src/components/chat/sendFlow.js';
import { RESEND_WINDOW_MS, canResend } from '../../src/lib/chatClient.js';
import { signRecord } from '../../shared/keys.js';
import { validateRecord } from '../../shared/records.js';
import { createIdentity } from '../helpers/bundle.js';

let alice;
let identity;

beforeAll(async () => {
  alice = await createIdentity('Alice');
  identity = {
    keyId: alice.keyId,
    displayName: 'Alice',
    sign: (record) => signRecord(alice.privateKey, record)
  };
});

// A tiny stand-in for the pending list: patch(id, change) merges into one item.
function makeStore(item) {
  const log = [];
  const state = { ...item };
  return {
    state,
    log,
    patch(id, change) {
      expect(id).toBe(item.id);
      Object.assign(state, change);
      log.push({ ...state });
    }
  };
}

describe('prepareItem', () => {
  it('builds a signed pending item with a valid record', async () => {
    const item = await prepareItem({ channelId: 'town-hall', body: '  hello  ', parent: null, identity });
    expect(item.status).toBe('sending');
    expect(item.record.body).toBe('hello');
    expect(item.record.signer).toBe(alice.keyId);
    expect(item.record.replyTo).toBe('');
    expect(item.id).toBe(item.hash);
    expect(validateRecord(item.record).ok).toBe(true);
    expect(item.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it('keeps the hash of the message being answered', async () => {
    const parent = { hash: 'ab'.repeat(32) };
    const item = await prepareItem({ channelId: 'town-hall', body: 'yes', parent, identity });
    expect(item.record.replyTo).toBe(parent.hash);
  });

  it('refuses empty and too long text with a reason', async () => {
    await expect(prepareItem({ channelId: 'town-hall', body: '   ', parent: null, identity })).rejects.toThrow();
    await expect(prepareItem({ channelId: 'town-hall', body: 'x'.repeat(2001), parent: null, identity })).rejects.toThrow();
  });

  it('gives two messages with the same text two different ids', async () => {
    const a = await prepareItem({ channelId: 'town-hall', body: 'same', parent: null, identity });
    const b = await prepareItem({ channelId: 'town-hall', body: 'same', parent: null, identity });
    expect(a.id).not.toBe(b.id);
  });
});

describe('deliverItem', () => {
  it('goes sending -> sent and asks the poller to look now', async () => {
    const item = await prepareItem({ channelId: 'room-one', body: 'hi', parent: null, identity });
    const store = makeStore(item);
    const post = vi.fn(async () => ({ seq: 1 }));
    const kick = vi.fn();
    const result = await deliverItem(item, { channelId: 'room-one', post, patch: store.patch, kick });
    expect(result).toBe('sent');
    expect(post).toHaveBeenCalledWith('room-one', item.record, item.signature);
    expect(store.log.map((s) => s.status)).toEqual(['sending', 'sent']);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('shows the rate limit in plain words and offers a retry state', async () => {
    const item = await prepareItem({ channelId: 'room-one', body: 'hi', parent: null, identity });
    const store = makeStore(item);
    const post = async () => {
      throw Object.assign(new Error('slow down'), { status: 429, code: 'rate_limited' });
    };
    const result = await deliverItem(item, { channelId: 'room-one', post, patch: store.patch });
    expect(result).toBe('failed');
    expect(store.state.status).toBe('failed');
    expect(store.state.error).toMatch(/too fast/);
    expect(store.state.error).toMatch(/20 per minute/);
  });

  it('reports a lost connection', async () => {
    const item = await prepareItem({ channelId: 'room-one', body: 'hi', parent: null, identity });
    const store = makeStore(item);
    const post = async () => {
      throw Object.assign(new Error('offline'), { status: 0, code: 'network' });
    };
    await deliverItem(item, { channelId: 'room-one', post, patch: store.patch });
    expect(store.state.status).toBe('failed');
    expect(store.state.error).toMatch(/Could not reach the server/);
  });

  it('counts a repeat the server already has (409) as delivered only on a retry', async () => {
    const item = await prepareItem({ channelId: 'room-one', body: 'hi', parent: null, identity });
    const conflict = async () => {
      throw Object.assign(new Error('exists'), { status: 409, code: 'exists' });
    };
    const first = makeStore(item);
    expect(await deliverItem(item, { channelId: 'room-one', post: conflict, patch: first.patch })).toBe('failed');
    const again = makeStore(item);
    const kick = vi.fn();
    expect(await deliverItem(item, { channelId: 'room-one', post: conflict, patch: again.patch, retry: true, kick })).toBe('sent');
    expect(again.state.status).toBe('sent');
    expect(kick).toHaveBeenCalled();
  });

  it('registers the key once more when the server does not know it, then sends again', async () => {
    const item = await prepareItem({ channelId: 'room-one', body: 'hi', parent: null, identity });
    const store = makeStore(item);
    let calls = 0;
    const post = async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('unknown'), { status: 400, code: 'unknown_signer' });
      return { seq: 2 };
    };
    const registerAgain = vi.fn(async () => {});
    expect(await deliverItem(item, { channelId: 'room-one', post, patch: store.patch, registerAgain })).toBe('sent');
    expect(registerAgain).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it('gives up after one registration and explains it', async () => {
    const item = await prepareItem({ channelId: 'room-one', body: 'hi', parent: null, identity });
    const store = makeStore(item);
    const post = vi.fn(async () => {
      throw Object.assign(new Error('unknown'), { status: 400, code: 'unknown_signer' });
    });
    const registerAgain = vi.fn(async () => {});
    expect(await deliverItem(item, { channelId: 'room-one', post, patch: store.patch, registerAgain })).toBe('failed');
    expect(post).toHaveBeenCalledTimes(2);
    expect(registerAgain).toHaveBeenCalledTimes(1);
    expect(store.state.error).toMatch(/does not know your key/);
    expect(store.state.error).not.toMatch(/Identity page/);
  });

  it('fails plainly when registering again fails', async () => {
    const item = await prepareItem({ channelId: 'room-one', body: 'hi', parent: null, identity });
    const store = makeStore(item);
    const post = vi.fn(async () => {
      throw Object.assign(new Error('unknown'), { status: 400, code: 'unknown_signer' });
    });
    const registerAgain = vi.fn(async () => {
      throw new Error('no network');
    });
    expect(await deliverItem(item, { channelId: 'room-one', post, patch: store.patch, registerAgain })).toBe('failed');
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('refreshItem and the resend window', () => {
  it('signs the same text again with a new time, a new nonce and a new id', async () => {
    const item = await prepareItem({ channelId: 'room-one', body: 'late', parent: { hash: 'cd'.repeat(32) }, identity });
    const old = { ...item, record: { ...item.record, createdAt: Date.now() - 20 * 60 * 1000 } };
    expect(canResend(old)).toBe(false);
    const next = await refreshItem({ channelId: 'room-one', item: old, identity });
    expect(next.record.body).toBe('late');
    expect(next.record.replyTo).toBe('cd'.repeat(32));
    expect(next.record.nonce).not.toBe(old.record.nonce);
    expect(next.id).not.toBe(old.id);
    expect(canResend(next)).toBe(true);
  });

  it('allows a resend of the same record only while it is fresh', () => {
    const rec = (age) => ({ record: { createdAt: Date.now() - age } });
    expect(canResend(rec(1000))).toBe(true);
    expect(canResend(rec(RESEND_WINDOW_MS + 5000))).toBe(false);
  });
});
