import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import AnchorStatus from '../../src/components/chat/AnchorStatus.jsx';
import { ChannelCard } from '../../src/components/chat/ChannelList.jsx';
import Composer from '../../src/components/chat/Composer.jsx';
import MessageList from '../../src/components/chat/MessageList.jsx';
import { MessageItem, PendingItem, ReplyPreview, quoteText } from '../../src/components/chat/MessageItem.jsx';
import VerifyBadge, { badgeState } from '../../src/components/chat/VerifyBadge.jsx';
import { checkAnchor, verifyPageEntries } from '../../src/lib/chatClient.js';
import ChatPage from '../../src/pages/ChatPage.jsx';
import { buildChannelPage, clone, createIdentity, createServerKey } from '../helpers/bundle.js';

const render = (node, path = '/') => renderToString(h(MemoryRouter, { initialEntries: [path] }, node));

let alice;
let bob;
let page;
let entries;
let tampered;
let unverified;

beforeAll(async () => {
  alice = await createIdentity('Alice');
  bob = await createIdentity('Bob');
  const server = await createServerKey();
  page = await buildChannelPage({
    channelId: 'town-hall',
    title: 'Town hall',
    serverKey: server,
    messages: [
      { author: alice, body: 'Meeting at noon' },
      { author: bob, body: 'See you <b>there</b>\nsecond line', replyTo: 0 },
      { author: alice, body: 'Reply to a message that is not loaded', replyTo: 'ab'.repeat(32) }
    ]
  });
  entries = (await verifyPageEntries(page, { channelId: 'town-hall', pin: server.keyId })).entries;
  const bad = clone(page);
  bad.messages[0].record.body = 'Meeting at midnight';
  tampered = (await verifyPageEntries(bad, { channelId: 'town-hall' })).entries;
  unverified = (
    await verifyPageEntries(clone(page), {
      channelId: 'town-hall',
      verify: async () => {
        throw new Error('no worker');
      }
    })
  ).entries;
});

describe('VerifyBadge', () => {
  it('is green only for a verified message', () => {
    const ok = renderToString(h(VerifyBadge, { status: 'verified', detail: 'signature, signer key id and message hash verify' }));
    expect(ok).toContain('ui-badge--good');
    expect(ok).toContain('Signature verified');
    expect(ok).toContain('title="signature, signer key id and message hash verify"');

    for (const status of ['invalid', 'unverified', 'pending', 'something-else', undefined]) {
      const html = renderToString(h(VerifyBadge, { status, detail: 'why' }));
      expect(html).not.toContain('ui-badge--good');
      expect(html).not.toContain('Signature verified');
    }
    expect(badgeState('nonsense').tone).toBe('warn');
  });

  it('puts the reason in text for screen readers', () => {
    const html = renderToString(h(VerifyBadge, { status: 'invalid', detail: 'signature does not verify' }));
    expect(html).toContain('ui-badge--bad');
    expect(html).toContain('Failed verification');
    expect(html).toMatch(/class="ui-sr-only">: signature does not verify</);
  });
});

describe('MessageItem', () => {
  it('shows a verified message with name, short key id, time and a reply button', () => {
    const html = render(
      h('ol', null, h(MessageItem, { entry: entries[0], name: 'Alice', canReply: true, onReply: () => {} }))
    );
    expect(html).toContain('chat-msg--verified');
    expect(html).toContain('Signature verified');
    expect(html).toContain('Alice');
    expect(html).toContain(alice.keyId.slice(0, 8));
    expect(html).toContain('Meeting at noon');
    expect(html).toContain('<time');
    expect(html).toContain('#1');
    expect(html).toContain('Reply');
    expect(html).not.toContain('Do not trust');
  });

  it('shows a failed message as failed, with the reason in plain text, and no green mark', () => {
    expect(tampered[0].verdict.status).toBe('invalid');
    const html = render(h('ol', null, h(MessageItem, { entry: tampered[0], name: 'Alice', canReply: true, onReply: () => {} })));
    expect(html).toContain('chat-msg--invalid');
    expect(html).toContain('Failed verification');
    expect(html).toContain('Do not trust this message.');
    expect(html).toContain('ui-badge--bad');
    expect(html).not.toContain('ui-badge--good');
    expect(html).not.toContain('chat-msg--verified');
    // no reply button and no trusted display name for a failed message
    expect(html).not.toContain('>Reply<');
    expect(html).not.toContain('>Alice<');
    expect(html).toContain('Unverified text');
  });

  it('shows an unchecked message as not verified', () => {
    const html = render(h('ol', null, h(MessageItem, { entry: unverified[0], name: 'Alice' })));
    expect(html).toContain('Not verified');
    expect(html).toContain('ui-badge--warn');
    expect(html).not.toContain('ui-badge--good');
    expect(html).toContain('This message was not checked.');
  });

  it('treats an entry with no verdict as not verified', () => {
    const { verdict, ...bare } = entries[0]; // eslint-disable-line no-unused-vars
    const html = render(h('ol', null, h(MessageItem, { entry: bare, name: 'Alice' })));
    expect(html).not.toContain('ui-badge--good');
    expect(html).toContain('Not verified');
  });

  it('escapes message text instead of treating it as markup', () => {
    const html = render(h('ol', null, h(MessageItem, { entry: entries[1], name: 'Bob', parent: entries[0], parentName: 'Alice' })));
    expect(html).toContain('See you &lt;b&gt;there&lt;/b&gt;');
    expect(html).not.toContain('<b>there</b>');
  });

  it('shows the quoted parent of a reply', () => {
    const html = render(h('ol', null, h(MessageItem, { entry: entries[1], name: 'Bob', parent: entries[0], parentName: 'Alice' })));
    expect(html).toContain('chat-quote');
    expect(html).toContain('Meeting at noon');
    expect(html).toContain('Alice');
  });

  it('says so when the parent is not loaded', () => {
    const html = render(h('ol', null, h(MessageItem, { entry: entries[2], name: 'Alice' })));
    expect(html).toContain('chat-quote--missing');
    expect(html).toContain('not loaded');
  });

  it('does not quote the text of a parent that failed verification', () => {
    const html = renderToString(h(ReplyPreview, { replyTo: 'ab'.repeat(32), parent: tampered[0], parentName: 'Alice' }));
    expect(html).toContain('failed verification');
    expect(html).not.toContain('Meeting at midnight');
    expect(html).not.toContain('>Alice<');
  });

  it('survives a malformed entry', () => {
    const html = render(h('ol', null, h(MessageItem, { entry: { seq: 4, verdict: { status: 'invalid', detail: 'bad' }, record: null } })));
    expect(html).toContain('Failed verification');
    expect(html).toContain('unknown signer');
  });

  it('cuts a very long body for display', () => {
    const long = { ...entries[0], record: { ...entries[0].record, body: 'x'.repeat(9000) } };
    const html = render(h('ol', null, h(MessageItem, { entry: long })));
    expect(html.length).toBeLessThan(9000);
  });

  it('shortens long quotes', () => {
    expect(quoteText('a  b\n c')).toBe('a b c');
    expect(quoteText('x'.repeat(300)).length).toBe(143);
    expect(quoteText(5)).toBe('');
  });
});

describe('PendingItem', () => {
  const record = { createdAt: 1700000000000, body: 'on its way' };
  it('shows sending, sent and failed states', () => {
    const sending = render(h('ol', null, h(PendingItem, { item: { status: 'sending', record }, name: 'Alice', keyId: alice.keyId })));
    expect(sending).toContain('Sending...');
    expect(sending).not.toContain('Try again');
    const sent = render(h('ol', null, h(PendingItem, { item: { status: 'sent', record }, name: 'Alice', keyId: alice.keyId })));
    expect(sent).toContain('Waiting for it to appear');
    const failed = render(
      h('ol', null, h(PendingItem, { item: { status: 'failed', record, error: 'You are sending too fast' }, name: 'Alice', keyId: alice.keyId }))
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('You are sending too fast');
    expect(failed).toContain('Try again');
    expect(failed).toContain('Discard');
    expect(failed).not.toContain('Signature verified');
  });
});

describe('MessageList', () => {
  it('renders messages in order inside a log region', () => {
    const html = render(h(MessageList, { entries, identities: page.identities, ownKeyId: alice.keyId, canReply: true }));
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-label="Messages"');
    expect(html.indexOf('Meeting at noon')).toBeLessThan(html.indexOf('See you'));
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).toContain('chat-msg--own');
    expect((html.match(/Signature verified/g) || []).length).toBe(3);
  });

  it('shows an empty state', () => {
    const html = render(h(MessageList, { entries: [] }));
    expect(html).toContain('No messages yet');
  });

  it('shows the load older button only when older messages exist', () => {
    expect(render(h(MessageList, { entries, hasOlder: true, onLoadOlder: () => {} }))).toContain('Load older messages');
    expect(render(h(MessageList, { entries, hasOlder: false }))).not.toContain('Load older messages');
  });

  it('mixes verified and failed messages without a green mark on the failed one', () => {
    const mixed = [tampered[0], entries[1], entries[2]];
    const html = render(h(MessageList, { entries: mixed, identities: page.identities }));
    expect((html.match(/ui-badge--good/g) || []).length).toBe(2);
    expect((html.match(/ui-badge--bad/g) || []).length).toBe(1);
  });

  it('renders pending items after the server messages', () => {
    const pending = [{ id: 'p1', status: 'sending', record: { createdAt: 1, body: 'queued text' } }];
    const html = render(h(MessageList, { entries, pending, identities: page.identities }));
    expect(html.indexOf('queued text')).toBeGreaterThan(html.indexOf('Meeting at noon'));
  });
});

describe('AnchorStatus', () => {
  it('shows the tied state and the older page state', async () => {
    const head = entries[2];
    const tied = await checkAnchor({ headEntry: head, identities: page.identities, page, channelId: 'town-hall' });
    const html = render(h(AnchorStatus, { anchor: tied }));
    expect(html).toContain('Latest messages tied to the server head');
    expect(html).toContain('role="status"');
    expect(html).toContain('chat-anchor--good');

    const older = await checkAnchor({ headEntry: entries[0], identities: page.identities, page, channelId: 'town-hall' });
    const html2 = render(h(AnchorStatus, { anchor: older }));
    expect(html2).toContain('Not tied to the server head, older page');
    expect(html2).toContain('chat-anchor--warn');
    expect(html2).not.toContain('chat-anchor--good');
  });

  it('shows a neutral state before the first check', () => {
    const html = render(h(AnchorStatus, { anchor: null, checking: true }));
    expect(html).toContain('Checking the server head');
    expect(html).toContain('chat-anchor--info');
  });
});

describe('Composer', () => {
  it('asks for an identity when there is none', () => {
    const html = render(h(Composer, { identityStatus: 'none' }));
    expect(html).toContain('You need an identity to write here');
    expect(html).toContain('href="/keys"');
    expect(html).not.toContain('<textarea');
  });

  it('shows a loading note while the identity loads', () => {
    expect(render(h(Composer, { identityStatus: 'loading' }))).toContain('Checking for your identity');
  });

  it('renders a labelled textarea with a counter and a send button', () => {
    const html = render(h(Composer, { identityStatus: 'ready', signerName: 'Alice', onSend: async () => ({ ok: true }) }));
    expect(html).toContain('<textarea');
    expect(html).toContain('Message as Alice');
    expect(html).toContain('0 / 2000');
    expect(html).toContain('Enter sends, Shift+Enter starts a new line.');
    expect(html).toContain('>Send<');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/);
  });

  it('shows who is being answered', () => {
    const html = render(h(Composer, { identityStatus: 'ready', replyTo: entries[0], replyName: 'Alice', onSend: async () => ({ ok: true }) }));
    expect(html).toContain('Replying to Alice');
    expect(html).toContain('Meeting at noon');
    expect(html).toContain('Cancel');
  });
});

describe('channel list and pages', () => {
  const channel = {
    channelId: 'town-hall',
    title: 'Town hall',
    docId: 'ab'.repeat(16),
    createdBy: 'cd'.repeat(32),
    createdByName: 'Carol',
    createdAt: 1700000000000,
    messageCount: 1,
    lastMessageAt: 1700000100000
  };

  it('shows a channel with count, last activity and the linked document', () => {
    const html = render(h('ul', null, h(ChannelCard, { channel, now: 1700000160000 })));
    expect(html).toContain('href="/chat/town-hall"');
    expect(html).toContain('Town hall');
    expect(html).toContain('1 message');
    expect(html).not.toContain('1 messages');
    expect(html).toContain('last message');
    expect(html).toContain(`href="/d/${'ab'.repeat(16)}"`);
    expect(html).toContain('Carol');
  });

  it('shows a channel with no messages and no document', () => {
    const html = render(h('ul', null, h(ChannelCard, { channel: { ...channel, docId: '', messageCount: 0, lastMessageAt: null } })));
    expect(html).toContain('0 messages');
    expect(html).toContain('no messages yet');
    expect(html).not.toContain('/d/');
  });

  const routes = h(Routes, null, h(Route, { path: '/chat', element: h(ChatPage) }), h(Route, { path: '/chat/:channelId', element: h(ChatPage) }));

  it('renders the channel list page in its loading state with the create form', () => {
    const html = render(routes, '/chat');
    expect(html).toContain('<h1');
    expect(html).toContain('Chat');
    expect(html).toContain('Channels');
    expect(html).toContain('Loading channels');
    expect(html).toContain('Start a channel');
  });

  it('renders a channel page in its loading state', () => {
    const html = render(routes, '/chat/town-hall');
    expect(html).toContain('town-hall');
    expect(html).toContain('Loading and checking messages');
    expect(html).toContain('All channels');
  });

  it('rejects a bad channel id without fetching', () => {
    const html = render(routes, '/chat/NOT%20VALID');
    expect(html).toContain('not a valid channel id');
    expect(html).not.toContain('Loading and checking');
  });
});
