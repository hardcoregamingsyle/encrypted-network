import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSignInPrompt } from '../AuthPrompt.jsx';
import Avatar from '../Avatar.jsx';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import EmptyState from '../EmptyState.jsx';
import Icon from '../Icon.jsx';
import ScreenHeader from '../ScreenHeader.jsx';
import Spinner from '../Spinner.jsx';
import Composer from './Composer.jsx';
import LinkedFileCard from './LinkedFileCard.jsx';
import MessageList from './MessageList.jsx';
import MessageMenu from './MessageMenu.jsx';
import RoomDetails from './RoomDetails.jsx';
import { deliverItem, prepareItem, refreshItem } from './sendFlow.js';
import { PRIVATE_TEXT_MAX_BYTES, loadGroupKey, openText, sealText } from '../../lib/privateChat.js';
import { checkServerTrust, composerStatus, firstUnreadSeq, isTrustMismatch, pinGetter, roomStatus } from './roomLogic.js';
import { getMessages, postMessage } from '../../lib/api.js';
import { canResend, createChatSession, createPoller, describeApiError, dropDelivered } from '../../lib/chatClient.js';
import { textOf } from '../../lib/format.js';
import * as pinLib from '../../lib/pin.js';
import { useSession } from '../../lib/session.jsx';
import { getLastSeen, markSeen } from '../../lib/unread.js';

const INITIAL = Object.freeze({
  phase: 'loading',
  channel: null,
  entries: [],
  identities: {},
  problems: [],
  anchor: null,
  hasOlder: false,
  lastSeq: 0,
  error: null,
  failures: 0
});

const STRIP_ICON = { good: 'check', info: 'info', warn: 'warn', bad: 'x' };

// One open chat: header, messages (each one checked in this browser), the writing box.
// The checking rules are in chatClient.js: every message is verified with the channel id of the route,
// only the newest page can be tied to the server's signed checkpoint, polling is 3 seconds, paused
// while the tab is hidden, with back off and never two requests at once.
export default function ChannelView({ channelId }) {
  const session = useSession();
  const identity = session.identity;
  const idStatus = composerStatus(session);
  const prompt = useSignInPrompt();
  const [view, setView] = useState(INITIAL);
  const [poll, setPoll] = useState({ status: 'running', delay: 0 });
  const [pending, setPending] = useState([]);
  const [replyTo, setReplyTo] = useState(null);
  const [menuEntry, setMenuEntry] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [trust, setTrust] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  const [groupKey, setGroupKey] = useState(null); // private chats: the key that unlocks the messages
  const [keyTry, setKeyTry] = useState({ n: 0, failed: false });
  const [plain, setPlain] = useState({}); // message hash -> unlocked text (null when it does not unlock)
  const [openedSeen] = useState(() => getLastSeen(channelId));
  const sessionRef = useRef(null);
  const pollerRef = useRef(null);
  const inputRef = useRef(null);
  const sendLock = useRef(false);
  const trustedFor = useRef('');
  const live = useRef({ atBottom: true, lastSeq: 0 });
  const authRef = useRef(session);
  authRef.current = session;
  live.current = { atBottom, lastSeq: view.lastSeq };

  // One session and one poller per chat. Cleanup stops both and cancels requests.
  useEffect(() => {
    const ctl = new AbortController();
    const chat = createChatSession({
      channelId,
      getMessages: (id, opts) => getMessages(id, { ...opts, signal: ctl.signal }),
      getPin: pinGetter(pinLib)
    });
    const poller = createPoller({
      run: () => chat.tick(),
      isHidden: () => typeof document !== 'undefined' && document.hidden === true,
      onStatus: (status, delay) => setPoll({ status, delay })
    });
    sessionRef.current = chat;
    pollerRef.current = poller;
    setView(INITIAL);
    setPending([]);
    setReplyTo(null);
    setOlderError('');
    const unsub = chat.subscribe(setView);
    const onVisible = () => {
      if (document.hidden) return;
      poller.resume();
      const { atBottom: bottom, lastSeq } = live.current;
      if (bottom && lastSeq > 0) markSeen(channelId, lastSeq);
    };
    const onOnline = () => poller.kick();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    poller.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      poller.stop();
      ctl.abort();
      unsub();
      chat.dispose();
      sessionRef.current = null;
      pollerRef.current = null;
    };
  }, [channelId]);

  // Messages that now appear in the server list replace the pending copy.
  useEffect(() => {
    setPending((list) => {
      const next = dropDelivered(list, view.entries);
      return next.length === list.length ? list : next;
    });
  }, [view.entries]);

  // The newest message counts as read once it is on screen in a visible tab.
  useEffect(() => {
    if (!atBottom || view.lastSeq <= 0) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    markSeen(channelId, view.lastSeq);
  }, [atBottom, view.lastSeq, channelId]);

  // First visit remembers the server key, a changed key is reported (src/lib/pin.js).
  useEffect(() => {
    const a = view.anchor;
    if (!a || !a.serverChecked || !a.serverKeyId || trustedFor.current === a.serverKeyId) return;
    trustedFor.current = a.serverKeyId;
    const t = checkServerTrust(pinLib, a.serverKeyId);
    if (t) setTrust(t);
  }, [view.anchor]);

  const isPrivate = Boolean(view.channel && view.channel.private);
  useEffect(() => {
    setGroupKey(null);
    setPlain({});
    if (!isPrivate) return undefined;
    let live = true;
    loadGroupKey(channelId).then(
      (key) => live && setGroupKey(key),
      () => live && setKeyTry((t) => ({ ...t, failed: true }))
    );
    return () => {
      live = false;
    };
  }, [channelId, isPrivate, keyTry.n]);

  // Unlocks the messages for display. What was signed and checked stays the locked text.
  useEffect(() => {
    if (!groupKey) return undefined;
    let live = true;
    (async () => {
      const add = {};
      for (const e of [...view.entries, ...pending]) {
        if (plain[e.hash] === undefined) add[e.hash] = await openText(groupKey, channelId, e.record.body);
      }
      if (live && Object.keys(add).length > 0) setPlain((p) => ({ ...p, ...add }));
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey, view.entries, pending]);

  const kick = useCallback(() => {
    if (pollerRef.current) pollerRef.current.kick();
  }, []);

  const patchPending = useCallback((id, patch) => {
    setPending((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  // The sending steps are in sendFlow.js. A repeat of a record the server already has counts as
  // delivered, and a key the server does not know yet is registered once more and tried again.
  const deliver = useCallback(
    (item, { retry = false } = {}) =>
      deliverItem(item, {
        channelId,
        post: postMessage,
        patch: patchPending,
        kick,
        retry,
        registerAgain: authRef.current ? authRef.current.registerAgain : undefined
      }),
    [channelId, kick, patchPending]
  );

  // Signs the message, shows it at once as pending, and sends it in the background, so the next
  // message can be written while this one is on its way.
  const send = useCallback(
    async (body, parent) => {
      if (!identity) return { ok: false, error: 'You need to be signed in to write.' };
      if (sendLock.current) return { ok: false, error: 'The previous message is still being signed.' };
      if (!view.channel) return { ok: false, error: 'This chat is still loading. Try again in a moment.' };
      if (isPrivate && !groupKey) return { ok: false, error: 'This chat is still unlocking. Try again in a moment.' };
      if (isPrivate && new TextEncoder().encode(body).length > PRIVATE_TEXT_MAX_BYTES) return { ok: false, error: 'That message is too long for a private chat. Shorten it a little.' };
      sendLock.current = true;
      let item;
      try {
        item = await prepareItem({ channelId, body: isPrivate ? await sealText(groupKey, channelId, body) : body, parent, identity });
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : 'Could not sign the message.' };
      } finally {
        sendLock.current = false;
      }
      setPending((list) => (list.some((p) => p.id === item.id) ? list : [...list, item]));
      setReplyTo(null);
      deliver(item);
      return { ok: true };
    },
    [channelId, identity, deliver, isPrivate, groupKey, view.channel]
  );

  const retry = useCallback(
    async (item) => {
      if (canResend(item)) {
        await deliver(item, { retry: true });
        return;
      }
      // Too old for the server to accept: sign the same text again with a fresh time.
      try {
        const next = await refreshItem({ channelId, item, identity });
        setPending((list) => list.map((p) => (p.id === item.id ? next : p)));
        await deliver(next);
      } catch (err) {
        patchPending(item.id, { status: 'failed', error: err && err.message ? err.message : 'Could not sign the message.' });
      }
    },
    [channelId, identity, deliver, patchPending]
  );

  const discard = useCallback((item) => setPending((list) => list.filter((p) => p.id !== item.id)), []);

  const loadOlder = useCallback(async () => {
    const chat = sessionRef.current;
    if (!chat || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError('');
    try {
      await chat.loadOlder();
    } catch (err) {
      setOlderError(describeApiError(err, 'load older messages').message);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder]);

  const startReply = useCallback((entry) => {
    setReplyTo(entry);
    setMenuEntry(null);
    // wait one tick: a closing menu gives focus back to its button first
    setTimeout(() => {
      if (inputRef.current) inputRef.current.focus();
    }, 0);
  }, []);

  const nameOf = useCallback(
    (keyId) => {
      const id = view.identities[keyId];
      return id && typeof id.displayName === 'string' ? id.displayName : '';
    },
    [view.identities]
  );

  const channel = view.channel;
  // The channel summary is not signature checked, so every field is coerced before it is shown.
  const title = (channel && textOf(channel.title)) || channelId;
  const aboutDoc = channel ? textOf(channel.docId) : '';
  const ownKeyId = identity ? identity.keyId : '';
  const firstUnread = useMemo(() => firstUnreadSeq(view.entries, openedSeen, ownKeyId), [view.entries, openedSeen, ownKeyId]);
  const status = roomStatus(view, poll);
  // In a private chat the list shows the unlocked text, and never the locked text while it is still being unlocked.
  const unlocked = (e) => (isPrivate ? { ...e, record: { ...e.record, body: plain[e.hash] === null ? 'This message could not be unlocked.' : plain[e.hash] || '...' } } : e);

  const header = (
    <ScreenHeader
      back="/chats"
      backLabel="Back to chats"
      leading={<Avatar name={title} keyId={channelId} size={40} />}
      title={title}
      subtitle={isPrivate ? 'Private chat' : 'Public chat'}
      documentTitle={`${title} (chat)`}
      actions={
        <button type="button" className="chat-iconbtn chat-iconbtn--head" onClick={() => setDetailsOpen(true)} aria-haspopup="dialog" aria-label="Chat details">
          <Icon name="info" size={22} />
        </button>
      }
    />
  );

  if (view.phase === 'missing') {
    return (
      <div className="chat-room">
        {header}
        <div className="chat-room__main">
          <EmptyState art="search" title="There is no chat with this address" action={<Link className="ui-btn ui-btn--primary" to="/chats">Back to chats</Link>}>
            Check the address, or go back to the list and start a new chat.
          </EmptyState>
        </div>
      </div>
    );
  }

  const loading = view.phase === 'loading';
  const failedFirst = view.phase === 'error';
  const mismatch = isTrustMismatch(trust) || Boolean(view.anchor && view.anchor.pinMismatch);

  return (
    <div className="chat-room">
      {header}
      <div className="chat-room__main">
        {failedFirst ? (
          <div className="chat-room__notice">
            <Callout tone="bad" title="Could not load the messages">
              <p>{view.error}</p>
              <p>
                <Button size="sm" onClick={kick}>
                  Try again
                </Button>
                {poll.status === 'retrying' ? <span className="ui-muted">{` Trying again by itself in ${Math.max(1, Math.round(poll.delay / 1000))} seconds.`}</span> : null}
              </p>
            </Callout>
          </div>
        ) : null}
        {loading ? (
          <div className="chat-loading" aria-busy="true">
            <Spinner label="Loading messages" />
            <p className="ui-muted">Loading messages and checking who wrote them.</p>
          </div>
        ) : null}
        {!loading && !failedFirst ? (
          <>
            <div className="chat-strip-wrap">
              <p className={`chat-strip chat-strip--${status.tone}`} role={status.tone === 'bad' ? 'alert' : undefined}>
                <Icon name={STRIP_ICON[status.tone] || 'info'} size={16} />
                <span className="chat-strip__text">{status.text}</span>
                <button type="button" className="chat-strip__more" onClick={() => setDetailsOpen(true)}>
                  Details
                </button>
              </p>
            </div>
            {mismatch ? (
              <div className="chat-room__notice">
                <Callout tone="bad" title="The server's identity changed since your last visit">
                  <p>The server now uses a different key than the one saved or seen before. Do not rely on this chat until you know why.</p>
                </Callout>
              </div>
            ) : null}
            {view.problems.length > 0 ? (
              <div className="chat-room__notice">
                <Callout tone="bad" title="Problems found while checking this chat">
                  <ul className="ui-list">
                    {view.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Callout>
              </div>
            ) : null}
            {isPrivate && !groupKey && keyTry.failed ? (
              <div className="chat-room__notice">
                <Callout tone="bad" title="Could not unlock this chat">
                  <p>
                    The messages cannot be read until the group password arrives.{' '}
                    <Button size="sm" onClick={() => setKeyTry((t) => ({ n: t.n + 1, failed: false }))}>
                      Try again
                    </Button>
                  </p>
                </Callout>
              </div>
            ) : null}
            {aboutDoc ? (
              <div className="chat-room__notice">
                <LinkedFileCard docId={aboutDoc} />
              </div>
            ) : null}
            <MessageList
              entries={isPrivate ? view.entries.map(unlocked) : view.entries}
              pending={isPrivate ? pending.map(unlocked) : pending}
              isPrivate={isPrivate}
              identities={view.identities}
              ownKeyId={ownKeyId}
              ownName={identity ? identity.displayName : ''}
              canReply={idStatus === 'ready'}
              onReply={startReply}
              onMenu={setMenuEntry}
              onRetry={retry}
              onDiscard={discard}
              hasOlder={view.hasOlder}
              loadingOlder={loadingOlder}
              olderError={olderError}
              onLoadOlder={loadOlder}
              onBottomChange={setAtBottom}
              firstUnread={firstUnread}
            />
          </>
        ) : null}
      </div>
      <Composer
        identityStatus={idStatus}
        signerName={identity ? identity.displayName : ''}
        replyTo={replyTo}
        replyName={replyTo && replyTo.record ? nameOf(replyTo.record.signer) : ''}
        onCancelReply={() => { setReplyTo(null); if (inputRef.current) inputRef.current.focus(); }}
        onSend={send}
        inputRef={inputRef}
      />
      <MessageMenu
        entry={menuEntry}
        name={menuEntry && menuEntry.record ? nameOf(menuEntry.record.signer) : ''}
        canReply={idStatus === 'ready'}
        onReply={startReply}
        onClose={() => setMenuEntry(null)}
        onNeedSignIn={() => {
          setMenuEntry(null);
          prompt.open('to reply in this chat');
        }}
      />
      <RoomDetails open={detailsOpen} onClose={() => setDetailsOpen(false)} channelId={channelId} view={view} poll={poll} trust={trust} isPrivate={isPrivate} />
    </div>
  );
}
