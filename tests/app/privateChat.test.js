// Private chats in the browser: locking messages with the group password, and what the screens show.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64Url } from '../../shared/encoding.js';
import { isChannelId, validateRecord } from '../../shared/records.js';
import { ToastProvider } from '../../src/components/Toast.jsx';
import { ChannelCard } from '../../src/components/chat/ChannelList.jsx';
import MessageList from '../../src/components/chat/MessageList.jsx';
import RoomDetails from '../../src/components/chat/RoomDetails.jsx';
import { emailsFrom, newChannelId, randomHex } from '../../src/lib/chatClient.js';
import { addChannelMembers, createChannel, getChannelKey } from '../../src/lib/api.js';
import { PRIVATE_TEXT_MAX_BYTES, loadGroupKey, openText, sealText } from '../../src/lib/privateChat.js';

const CHAT = 'study-group-1a2b';
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

let fetchMock;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function groupKey(bytes = new Uint8Array(32).fill(7)) {
  fetchMock.mockImplementation(async () => json({ key: bytesToBase64Url(bytes) }));
  return loadGroupKey(CHAT);
}

describe('locking messages', () => {
  it('a message locks and unlocks, and the locked text is not the message', async () => {
    const key = await groupKey();
    const locked = await sealText(key, CHAT, 'see you at six');
    expect(locked).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(locked).not.toContain('see you');
    expect(await openText(key, CHAT, locked)).toBe('see you at six');
    expect(await sealText(key, CHAT, 'see you at six')).not.toBe(locked); // a new start value every time
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/channels/${CHAT}/key`);
  });

  it('does not unlock with another password, in another chat, or when changed; text with accents and emoji survives', async () => {
    const key = await groupKey();
    const other = await groupKey(new Uint8Array(32).fill(9));
    const accents = 'caf' + String.fromCharCode(0xe9) + ' ' + String.fromCharCode(0x2615);
    const locked = await sealText(key, CHAT, accents);
    expect(await openText(key, CHAT, locked)).toBe(accents);
    expect(await openText(other, CHAT, locked)).toBeNull();
    expect(await openText(key, 'another-chat-9z', locked)).toBeNull();
    const changed = locked.slice(0, -3) + (locked.endsWith('AAA') ? 'BBB' : 'AAA');
    expect(await openText(key, CHAT, changed)).toBeNull();
    for (const bad of ['', 'short', '!!!!', 'a'.repeat(40)]) expect(await openText(key, CHAT, bad)).toBeNull();
  });

  it('the longest allowed text still fits the message body limit and passes the record rules', async () => {
    const key = await groupKey();
    const longest = 'a'.repeat(PRIVATE_TEXT_MAX_BYTES);
    const wide = String.fromCharCode(0xe9).repeat(PRIVATE_TEXT_MAX_BYTES / 2); // two bytes each
    for (const body of [longest, wide]) {
      const locked = await sealText(key, CHAT, body);
      expect(locked.length).toBeLessThanOrEqual(2000);
      const record = { v: 2, type: 'message', channelId: CHAT, body: locked, replyTo: '', signer: 'a'.repeat(64), createdAt: Date.now(), nonce: '0'.repeat(32) };
      expect(validateRecord(record)).toEqual({ ok: true });
    }
  });
});

describe('api calls', () => {
  it('createChannel sends members only for a private chat; adding people and reading the key use their own routes', async () => {
    fetchMock.mockImplementation(async () => json({ ok: true }));
    await createChannel({ a: 1 }, 'sig');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ record: { a: 1 }, signature: 'sig' });
    await createChannel({ a: 1 }, 'sig', ['b@example.test']);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ record: { a: 1 }, signature: 'sig', members: ['b@example.test'] });
    await addChannelMembers(CHAT, ['c@example.test']);
    expect(fetchMock.mock.calls[2][0]).toBe(`/api/channels/${CHAT}/members`);
    expect(fetchMock.mock.calls[2][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ members: ['c@example.test'] });
    await getChannelKey(CHAT);
    expect(fetchMock.mock.calls[3][0]).toBe(`/api/channels/${CHAT}/key`);
  });
});

describe('private chat ids', () => {
  it('are long and random, so nobody can guess one from a name, and still valid chat ids', () => {
    const id = newChannelId('', () => randomHex(32));
    expect(id).toMatch(/^chat-[0-9a-f]{32}$/);
    expect(isChannelId(id)).toBe(true);
    expect(newChannelId('', () => randomHex(32))).not.toBe(id);
    expect(newChannelId('Study group')).toMatch(/^study-group-[0-9a-f]{4}$/); // a public chat keeps its readable id
  });
});

describe('emailsFrom', () => {
  it('splits at commas, semicolons, spaces and new lines, drops empty parts and repeats', () => {
    expect(emailsFrom('a@x.test, b@x.test;c@x.test  d@x.test\ne@x.test,, a@x.test')).toEqual(['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test', 'e@x.test']);
    expect(emailsFrom('')).toEqual([]);
    expect(emailsFrom(null)).toEqual([]);
    expect(emailsFrom(' , ; ')).toEqual([]);
  });
});

describe('what the person sees', () => {
  const page = (node) => renderToString(h(MemoryRouter, null, h(ToastProvider, null, node)));
  const channel = { channelId: CHAT, title: 'Study group', docId: '', messageCount: 3, lastMessageAt: Date.now(), lastText: '', lastSignerName: '' };

  it('the chat list says which chats are private', () => {
    const priv = text(page(h(ChannelCard, { channel: { ...channel, private: true }, now: Date.now() })));
    expect(priv).toContain('Private chat. 3 messages');
    const open = text(page(h(ChannelCard, { channel, now: Date.now() })));
    expect(open).toContain('3 messages');
    expect(open).not.toContain('Private chat');
  });

  it('the details of a private chat let a member add people; a public chat does not', () => {
    const view = { channel, entries: [], problems: [], anchor: null };
    const props = { open: true, onClose() {}, channelId: CHAT, view, poll: { status: 'running', delay: 0 }, trust: '' };
    const priv = page(h(RoomDetails, { ...props, isPrivate: true }));
    expect(priv).toContain('Add people');
    expect(priv).toContain('separated by commas');
    expect(page(h(RoomDetails, props))).not.toContain('Add people');
  });

  it('an empty private chat says who can read it', () => {
    const empty = (isPrivate) => text(page(h(MessageList, { entries: [], pending: [], identities: {}, isPrivate })));
    expect(empty(true)).toContain('Only the people in this chat can read it');
    expect(empty(false)).toContain('Everyone can read this chat');
  });

  it('uses plain words only', () => {
    const view = { channel, entries: [], problems: [], anchor: null };
    const all = text(
      page(h(RoomDetails, { open: true, onClose() {}, channelId: CHAT, view, poll: { status: 'running', delay: 0 }, trust: '', isPrivate: true })) +
        page(h(ChannelCard, { channel: { ...channel, private: true }, now: Date.now() }))
    );
    expect(all).not.toMatch(/AES|GCM|ciphertext|HKDF|sealed|end[- ]to[- ]end/i);
    expect(all).not.toMatch(new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']'));
  });
});
