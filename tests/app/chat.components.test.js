// Chat components rendered to HTML in Node: bubbles, list, composer, sheets and the two pages.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import AnchorStatus from '../../src/components/chat/AnchorStatus.jsx';
import { ChannelCard } from '../../src/components/chat/ChannelList.jsx';
import Composer from '../../src/components/chat/Composer.jsx';
import LinkedFileCard from '../../src/components/chat/LinkedFileCard.jsx';
import MessageList from '../../src/components/chat/MessageList.jsx';
import MessageMenu from '../../src/components/chat/MessageMenu.jsx';
import { MessageItem, PendingItem, ReplyPreview, quoteText } from '../../src/components/chat/MessageItem.jsx';
import NewChatSheet from '../../src/components/chat/NewChatSheet.jsx';
import RoomDetails from '../../src/components/chat/RoomDetails.jsx';
import VerifyBadge, { badgeState } from '../../src/components/chat/VerifyBadge.jsx';
import { checkAnchor, verifyPageEntries } from '../../src/lib/chatClient.js';
import { DEFAULT_SESSION, SessionContext } from '../../src/lib/session.jsx';
import ChatRoomPage from '../../src/pages/ChatRoomPage.jsx';
import ChatsPage from '../../src/pages/ChatsPage.jsx';
import { buildChannelPage, clone, createIdentity, createServerKey } from '../helpers/bundle.js';

const render = (node, path = '/') => renderToString(h(MemoryRouter, { initialEntries: [path] }, node));
const withSession = (value, node) => h(SessionContext.Provider, { value: { ...DEFAULT_SESSION, ...value } }, node);
const SR_TICK = 'class="ui-sr-only">Checked: written by this sender and not changed<';

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

describe('MessageItem (bubbles)', () => {
  it('shows a verified message with name, time, a hidden-text check mark and a reply button', () => {
    const html = render(h('ol', null, h(MessageItem, { entry: entries[0], name: 'Alice', canReply: true, onReply: () => {}, onMenu: () => {} })));
    expect(html).toContain('chat-msg--verified');
    expect(html).toContain('chat-msg--other');
    expect(html).toContain('chat-tick');
    expect(html).toContain(SR_TICK);
    expect(html).toContain('>Alice<');
    expect(html).toContain(`Key id ${alice.keyId}`);
    expect(html).toContain('Meeting at noon');
    expect(html).toContain('<time');
    expect(html).toContain('aria-label="Reply to Alice, message 1"');
    expect(html).toContain('aria-label="More for message 1 by Alice"');
    expect(html).not.toContain('Do not trust');
    expect(html).not.toContain('Could not verify');
  });

  it('puts own messages on the right and leaves out the sender line', () => {
    const html = render(h('ol', null, h(MessageItem, { entry: entries[0], name: 'Alice', own: true })));
    expect(html).toContain('chat-msg--own');
    expect(html).not.toContain('chat-msg__name');
    expect(html).not.toContain('ui-avatar');
  });

  it('repeats neither name nor avatar inside a group', () => {
    const html = render(h('ol', null, h(MessageItem, { entry: entries[0], name: 'Alice', grouped: true })));
    expect(html).toContain('chat-msg--grouped');
    expect(html).not.toContain('chat-msg__name');
    expect(html).not.toContain('ui-avatar');
  });

  it('shows a failed message as a red bubble, with no tick, no name and no reply button', () => {
    expect(tampered[0].verdict.status).toBe('invalid');
    const html = render(h('ol', null, h(MessageItem, { entry: tampered[0], name: 'Alice', canReply: true, onReply: () => {}, onMenu: () => {} })));
    expect(html).toContain('chat-msg--invalid');
    expect(html).toContain('Could not verify this message');
    expect(html).toContain('Failed verification');
    expect(html).toContain('Do not trust this message.');
    expect(html).not.toContain('chat-tick');
    expect(html).not.toContain('chat-msg--verified');
    expect(html).not.toContain('chat-msg__actions');
    expect(html).not.toContain('>Alice<');
    // the text sits behind a disclosure and is labelled as unverified
    expect(html).toContain('Show the text anyway');
    expect(html).toContain('Unverified text');
  });

  it('shows an unchecked message as not verified', () => {
    const html = render(h('ol', null, h(MessageItem, { entry: unverified[0], name: 'Alice' })));
    expect(html).toContain('chat-msg--unverified');
    expect(html).toContain('This message was not checked');
    expect(html).toContain('Not verified');
    expect(html).not.toContain('chat-tick');
  });

  it('treats an entry with no verdict as not verified', () => {
    const { verdict, ...bare } = entries[0]; // eslint-disable-line no-unused-vars
    const html = render(h('ol', null, h(MessageItem, { entry: bare, name: 'Alice' })));
    expect(html).not.toContain('chat-tick');
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
    expect(html).toContain('Unknown sender');
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
    expect(sending).toContain('Sending');
    expect(sending).toContain('chat-pendingmark');
    expect(sending).not.toContain('Try again');
    const sent = render(h('ol', null, h(PendingItem, { item: { status: 'sent', record }, name: 'Alice', keyId: alice.keyId })));
    expect(sent).toContain('Waiting for it to come back');
    const failed = render(
      h('ol', null, h(PendingItem, { item: { status: 'failed', record, error: 'You are sending too fast' }, name: 'Alice', keyId: alice.keyId }))
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('You are sending too fast');
    expect(failed).toContain('Try again');
    expect(failed).toContain('Discard');
    expect(failed).toContain('chat-msg--failed');
    expect(failed).not.toContain('Checked: written by this sender');
    expect(failed).not.toContain('chat-tick');
  });
});

describe('MessageList', () => {
  it('renders messages in order inside a log region, with one date separator', () => {
    const html = render(h(MessageList, { entries, identities: page.identities, ownKeyId: alice.keyId, canReply: true, now: entries[0].record.createdAt }));
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-label="Messages"');
    expect(html.indexOf('Meeting at noon')).toBeLessThan(html.indexOf('See you'));
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).toContain('chat-msg--own');
    expect((html.match(new RegExp(SR_TICK, 'g')) || []).length).toBe(3);
    expect((html.match(/class="chat-day"/g) || []).length).toBe(1);
    expect(html).toContain('Today');
  });

  it('groups consecutive messages of one sender', () => {
    const html = render(h(MessageList, { entries: [entries[0], { ...entries[0], seq: 2, hash: 'ee'.repeat(32) }], identities: page.identities }));
    expect((html.match(/chat-msg--grouped/g) || []).length).toBe(1);
    expect((html.match(/chat-msg__name/g) || []).length).toBe(1);
  });

  it('shows an empty state', () => {
    const html = render(h(MessageList, { entries: [] }));
    expect(html).toContain('No messages yet');
  });

  it('shows the load older button only when older messages exist', () => {
    expect(render(h(MessageList, { entries, hasOlder: true, onLoadOlder: () => {} }))).toContain('Load older messages');
    expect(render(h(MessageList, { entries, hasOlder: false }))).not.toContain('Load older messages');
  });

  it('mixes verified and failed messages without a tick on the failed one', () => {
    const mixed = [tampered[0], entries[1], entries[2]];
    const html = render(h(MessageList, { entries: mixed, identities: page.identities }));
    expect((html.match(/class="chat-tick"/g) || []).length).toBe(2);
    expect((html.match(/Could not verify this message/g) || []).length).toBe(1);
  });

  it('renders pending items after the server messages', () => {
    const pending = [{ id: 'p1', status: 'sending', record: { createdAt: 1, body: 'queued text' } }];
    const html = render(h(MessageList, { entries, pending, identities: page.identities }));
    expect(html.indexOf('queued text')).toBeGreaterThan(html.indexOf('Meeting at noon'));
  });

  it('marks the first unread message', () => {
    const html = render(h(MessageList, { entries, identities: page.identities, firstUnread: 2 }));
    expect(html).toContain('Unread messages');
    expect(html.indexOf('Unread messages')).toBeGreaterThan(html.indexOf('Meeting at noon'));
    expect(html.indexOf('Unread messages')).toBeLessThan(html.indexOf('See you'));
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
  it('shows a Sign in to write button when signed out, and no text box', () => {
    const html = render(h(Composer, { identityStatus: 'none' }));
    expect(html).toContain('Sign in to write');
    expect(html).not.toContain('<textarea');
  });

  it('asks for a name when the sign in is not finished', () => {
    const html = render(h(Composer, { identityStatus: 'needsKey' }));
    expect(html).toContain('Choose your name to write here');
    expect(html).toContain('Choose your name');
    expect(html).not.toContain('<textarea');
  });

  it('shows a loading bar while the session loads', () => {
    expect(render(h(Composer, { identityStatus: 'loading' }))).toContain('Checking if you are signed in');
  });

  it('renders a labelled textarea and a send button, and no counter far from the limit', () => {
    const html = render(h(Composer, { identityStatus: 'ready', signerName: 'Alice', onSend: async () => ({ ok: true }) }));
    expect(html).toContain('<textarea');
    expect(html).toContain('Message as Alice');
    expect(html).toContain('Enter sends, Shift+Enter starts a new line.');
    expect(html).toContain('aria-label="Send message"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/);
    expect(html).not.toContain('/ 2000');
  });

  it('shows who is being answered', () => {
    const html = render(h(Composer, { identityStatus: 'ready', replyTo: entries[0], replyName: 'Alice', onSend: async () => ({ ok: true }) }));
    expect(html).toContain('Replying to Alice');
    expect(html).toContain('Meeting at noon');
    expect(html).toContain('aria-label="Cancel the reply"');
  });
});

describe('MessageMenu, RoomDetails, NewChatSheet and LinkedFileCard', () => {
  it('offers Reply and Copy for a signed in person', () => {
    const html = render(h(MessageMenu, { entry: entries[0], name: 'Alice', canReply: true, onReply: () => {}, onClose: () => {} }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Reply');
    expect(html).toContain('Copy text');
    expect(html).toContain('Meeting at noon');
    expect(html).toContain('Who wrote this');
  });

  it('offers a sign in instead of Reply when signed out', () => {
    const html = render(h(MessageMenu, { entry: entries[0], name: 'Alice', canReply: false, onClose: () => {}, onNeedSignIn: () => {} }));
    expect(html).toContain('Sign in to reply');
    expect(html).not.toContain('>Reply<');
  });

  it('renders nothing when no message is chosen', () => {
    expect(render(h(MessageMenu, { entry: null, onClose: () => {} }))).toBe('');
  });

  it('keeps what the server says apart from what the device checked', async () => {
    const anchor = await checkAnchor({ headEntry: entries[2], identities: page.identities, page, channelId: 'town-hall' });
    const view = { channel: page.channel, entries, problems: [], anchor };
    const html = render(h(RoomDetails, { open: true, onClose: () => {}, channelId: 'town-hall', view, poll: { status: 'waiting', delay: 3000 }, trust: 'first-visit' }));
    expect(html).toContain('What the server says');
    expect(html).toContain('not signature checked');
    expect(html).toContain('What your device checked');
    expect(html).toContain('3 of 3 shown messages have a verified signature');
    expect(html).toContain('Latest messages tied to the server head');
    expect(html).toContain('First visit');
    expect(html).toContain('every 3 seconds');
  });

  it('shows a loud note when the server key changed', () => {
    const view = { channel: page.channel, entries: [], problems: ['x problem'], anchor: null };
    const html = render(h(RoomDetails, { open: true, onClose: () => {}, channelId: 'town-hall', view, poll: { status: 'retrying', delay: 6000 }, trust: 'remembered-mismatch' }));
    expect(html).toContain("The server&#x27;s identity changed since your last visit");
    expect(html).toContain('x problem');
    expect(html).toContain('Trying again in 6 seconds');
  });

  it('the new chat sheet asks for a name and an optional file', () => {
    const html = render(h(NewChatSheet, { open: true, onClose: () => {} }));
    expect(html).toContain('New chat');
    expect(html).toContain('Chat name');
    expect(html).toContain('Linked file (optional)');
    expect(html).toContain('Create chat');
    expect(html).not.toContain('Channel id');
  });

  it('the linked file card only links a real file id', () => {
    expect(render(h(LinkedFileCard, { docId: 'ab'.repeat(16) }))).toContain(`href="/d/${'ab'.repeat(16)}"`);
    for (const bad of ['javascript:alert(1)', '', 7, null, 'AB'.repeat(16)]) {
      expect(render(h(LinkedFileCard, { docId: bad }))).toBe('');
    }
  });
});

describe('chat list rows', () => {
  const channel = {
    channelId: 'town-hall',
    title: 'Town hall',
    docId: 'ab'.repeat(16),
    createdBy: 'cd'.repeat(32),
    createdByName: 'Carol',
    createdAt: 1700000000000,
    messageCount: 1,
    lastMessageAt: 1700000100000,
    lastText: 'See you\nat noon',
    lastSignerName: 'Priya'
  };

  it('shows title, "Name: text" preview, time and the linked file', () => {
    const html = render(h('ul', null, h(ChannelCard, { channel, now: 1700000160000 })));
    expect(html).toContain('href="/chats/town-hall"');
    expect(html).toContain('Town hall');
    expect(html).toContain('Priya: See you at noon');
    expect(html).toContain('ui-avatar');
    expect(html).toContain(`href="/d/${'ab'.repeat(16)}"`);
    expect(html).toContain('aria-label="Open the file linked to Town hall"');
  });

  it('falls back to the message count when the server sent no preview', () => {
    const html = render(h('ul', null, h(ChannelCard, { channel: { ...channel, lastText: '', lastSignerName: '' } })));
    expect(html).toContain('1 message');
    expect(html).not.toContain('1 messages');
  });

  it('shows a chat with no messages and no file', () => {
    const html = render(h('ul', null, h(ChannelCard, { channel: { ...channel, docId: '', messageCount: 0, lastMessageAt: null, lastText: '', lastSignerName: '' } })));
    expect(html).toContain('No messages yet');
    expect(html).not.toContain('/d/');
  });
});

describe('pages', () => {
  const routes = h(
    Routes,
    null,
    h(Route, { path: '/chats', element: h(ChatsPage) }),
    h(Route, { path: '/chats/:channelId', element: h(ChatRoomPage) })
  );

  it('renders the chat list page in its loading state with search and the New chat button', () => {
    const html = render(routes, '/chats');
    expect(html).toContain('<h1');
    expect(html).toContain('Chats');
    expect(html).toContain('Search chats');
    expect(html).toContain('Loading chats');
    expect(html).toContain('New chat');
    expect(html).toContain('Anyone can read these chats');
  });

  it('renders a room in its loading state, with the header saying Public chat', () => {
    const html = render(withSession({ status: 'signedOut' }, routes), '/chats/town-hall');
    expect(html).toContain('town-hall');
    expect(html).toContain('Public chat');
    expect(html).toContain('Back to chats');
    expect(html).toContain('Chat details');
    expect(html).toContain('Loading messages');
  });

  it('a signed out visitor gets Sign in to write in the room', () => {
    const html = render(withSession({ status: 'signedOut' }, routes), '/chats/town-hall');
    expect(html).toContain('Sign in to write');
    expect(html).not.toContain('<textarea');
  });

  it('a signed in person gets the writing box', () => {
    const identity = { keyId: alice.keyId, displayName: 'Alice', publicKey: alice.publicJwk, sign: async () => 'sig' };
    const html = render(withSession({ status: 'ready', mode: 'guest', identity }, routes), '/chats/town-hall');
    expect(html).toContain('<textarea');
    expect(html).toContain('Message as Alice');
    expect(html).not.toContain('Sign in to write');
  });

  it('rejects a bad chat address without asking the server', () => {
    const html = render(routes, '/chats/NOT%20VALID');
    expect(html).toContain('not a chat address');
    expect(html).not.toContain('Loading and checking');
  });
});
