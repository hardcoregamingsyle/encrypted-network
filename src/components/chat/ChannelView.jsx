import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import EmptyState from '../EmptyState.jsx';
import PageHeader from '../PageHeader.jsx';
import Spinner from '../Spinner.jsx';
import AnchorStatus from './AnchorStatus.jsx';
import Composer from './Composer.jsx';
import MessageList from './MessageList.jsx';
import { getMessages, postMessage } from '../../lib/api.js';
import {
  POLL_MS,
  buildMessageRecord,
  canResend,
  createChatSession,
  createPoller,
  describeApiError,
  dropDelivered
} from '../../lib/chatClient.js';
import { formatTime } from '../../lib/format.js';
import { useIdentity } from '../../lib/identity.jsx';
import { getPinnedServerKeyId } from '../../lib/pin.js';
import { recordHash } from '../../../shared/records.js';

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

function pollWords(poll) {
  if (poll.status === 'paused') return 'Paused while this tab is hidden.';
  if (poll.status === 'retrying') return `Connection problem. Trying again in ${Math.max(1, Math.round(poll.delay / 1000))} seconds.`;
  if (poll.status === 'stopped') return 'Not checking for new messages.';
  return `Checking for new messages every ${POLL_MS / 1000} seconds.`;
}

// One open channel: header, messages with a check result each, the head line and the compose box.
export default function ChannelView({ channelId }) {
  const { status: idStatus, identity } = useIdentity();
  const [view, setView] = useState(INITIAL);
  const [poll, setPoll] = useState({ status: 'running', delay: 0 });
  const [pending, setPending] = useState([]);
  const [replyTo, setReplyTo] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  const sessionRef = useRef(null);
  const pollerRef = useRef(null);
  const inputRef = useRef(null);
  const sendLock = useRef(false);

  // One session and one poller per channel. Cleanup stops both and cancels requests.
  useEffect(() => {
    const ctl = new AbortController();
    const session = createChatSession({
      channelId,
      getMessages: (id, opts) => getMessages(id, { ...opts, signal: ctl.signal }),
      getPin: getPinnedServerKeyId
    });
    const poller = createPoller({
      run: () => session.tick(),
      isHidden: () => typeof document !== 'undefined' && document.hidden === true,
      onStatus: (status, delay) => setPoll({ status, delay })
    });
    sessionRef.current = session;
    pollerRef.current = poller;
    setView(INITIAL);
    setPending([]);
    setReplyTo(null);
    setOlderError('');
    const unsub = session.subscribe(setView);
    const onVisible = () => {
      if (!document.hidden) poller.resume();
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
      session.dispose();
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

  const kick = useCallback(() => {
    if (pollerRef.current) pollerRef.current.kick();
  }, []);

  const patchPending = useCallback((id, patch) => {
    setPending((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  // Sends the signed record of a pending item. A repeat of a record the server already has
  // (answer 409) counts as delivered, so a lost answer never causes a second message.
  const deliver = useCallback(
    async (item, { retry = false } = {}) => {
      patchPending(item.id, { status: 'sending', error: '' });
      try {
        await postMessage(channelId, item.record, item.signature);
        patchPending(item.id, { status: 'sent', error: '' });
        kick();
      } catch (err) {
        if (retry && err && err.status === 409) {
          patchPending(item.id, { status: 'sent', error: '' });
          kick();
          return;
        }
        patchPending(item.id, { status: 'failed', error: describeApiError(err, 'send the message').message });
      }
    },
    [channelId, kick, patchPending]
  );

  const send = useCallback(
    async (body, parent) => {
      if (!identity) return { ok: false, error: 'You need an identity to write.' };
      if (sendLock.current) return { ok: false, error: 'The previous message is still being sent.' };
      sendLock.current = true;
      try {
        let item;
        try {
          const record = buildMessageRecord({
            channelId,
            body,
            replyTo: parent && parent.hash ? parent.hash : '',
            signer: identity.keyId
          });
          const signature = await identity.sign(record);
          const hash = await recordHash(record);
          item = { id: hash, hash, record, signature, status: 'sending', error: '' };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : 'Could not sign the message.' };
        }
        setPending((list) => (list.some((p) => p.id === item.id) ? list : [...list, item]));
        setReplyTo(null);
        await deliver(item);
        return { ok: true };
      } finally {
        sendLock.current = false;
      }
    },
    [channelId, identity, deliver]
  );

  const retry = useCallback(
    async (item) => {
      if (canResend(item)) {
        await deliver(item, { retry: true });
        return;
      }
      // Too old for the server to accept: sign the same text again with a fresh time.
      try {
        const record = buildMessageRecord({
          channelId,
          body: item.record.body,
          replyTo: item.record.replyTo,
          signer: identity.keyId
        });
        const signature = await identity.sign(record);
        const hash = await recordHash(record);
        const next = { id: hash, hash, record, signature, status: 'sending', error: '' };
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
    const session = sessionRef.current;
    if (!session || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError('');
    try {
      await session.loadOlder();
    } catch (err) {
      setOlderError(describeApiError(err, 'load older messages').message);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder]);

  const startReply = useCallback((entry) => {
    setReplyTo(entry);
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const nameOf = useCallback(
    (keyId) => {
      const id = view.identities[keyId];
      return id && typeof id.displayName === 'string' ? id.displayName : '';
    },
    [view.identities]
  );

  const channel = view.channel;
  const title = channel && typeof channel.title === 'string' && channel.title ? channel.title : channelId;
  const header = useMemo(
    () => (
      <PageHeader
        title={title}
        documentTitle={`${title} (chat)`}
        lead={
          channel ? (
            <span className="chat-lead">
              <span className="chat-lead__id">{channelId}</span>
              {channel.createdByName ? <span>{`Started by ${channel.createdByName}`}</span> : null}
              {Number.isFinite(channel.createdAt) ? <span>{formatTime(channel.createdAt)}</span> : null}
              {channel.docId ? (
                <span>
                  About document <Link to={`/d/${channel.docId}`}>{channel.docId.slice(0, 8)}...</Link>
                </span>
              ) : null}
            </span>
          ) : (
            channelId
          )
        }
        actions={
          <Link className="ui-btn ui-btn--secondary" to="/chat">
            All channels
          </Link>
        }
      />
    ),
    [channel, channelId, title]
  );

  if (view.phase === 'missing') {
    return (
      <div className="ui-container">
        <PageHeader title="Channel not found" lead={channelId} actions={<Link className="ui-btn ui-btn--secondary" to="/chat">All channels</Link>} />
        <EmptyState title="There is no channel with this id">
          Check the address, or <Link to="/chat">start a new channel</Link>.
        </EmptyState>
      </div>
    );
  }

  const loading = view.phase === 'loading';
  const failedFirst = view.phase === 'error';
  const ownKeyId = identity ? identity.keyId : '';
  const verifiedCount = view.entries.filter((e) => e.verdict && e.verdict.status === 'verified').length;
  const failedCount = view.entries.filter((e) => e.verdict && e.verdict.status === 'invalid').length;

  return (
    <div className="ui-container chat-view">
      {header}
      {failedFirst ? (
        <Callout tone="bad" title="Could not load the messages">
          <p>{view.error}</p>
          <p>
            <Button size="sm" onClick={kick}>
              Try again
            </Button>
            {poll.status === 'retrying' ? <span className="ui-muted">{` Trying again by itself in ${Math.max(1, Math.round(poll.delay / 1000))} seconds.`}</span> : null}
          </p>
        </Callout>
      ) : null}
      {loading ? (
        <div className="chat-loading" aria-busy="true">
          <Spinner label="Loading and checking messages" />
          <p className="ui-muted">Loading the latest messages and checking each signature.</p>
        </div>
      ) : null}
      {!loading && !failedFirst ? (
        <>
          {view.problems.length > 0 ? (
            <Callout tone="bad" title="Problems found while checking this channel">
              <ul className="ui-list">
                {view.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          <MessageList
            entries={view.entries}
            pending={pending}
            identities={view.identities}
            ownKeyId={ownKeyId}
            ownName={identity ? identity.displayName : ''}
            canReply={idStatus === 'ready'}
            onReply={startReply}
            onRetry={retry}
            onDiscard={discard}
            hasOlder={view.hasOlder}
            loadingOlder={loadingOlder}
            olderError={olderError}
            onLoadOlder={loadOlder}
          />
          <AnchorStatus anchor={view.anchor} />
          <p className="chat-statusline" role="status">
            {view.entries.length > 0
              ? `${verifiedCount} of ${view.entries.length} shown messages have a verified signature${failedCount ? `, ${failedCount} failed` : ''}. `
              : ''}
            {view.error ? `${view.error} ` : ''}
            {pollWords(poll)}
          </p>
          <p className="ui-muted chat-note">
            Names come from each sender's own signed identity record. The short code next to a name is the start of the hash of their public key, and it is what identifies them.
            Times are written by the sender and are not attested.
          </p>
        </>
      ) : null}
      <Composer
        identityStatus={idStatus}
        signerName={identity ? identity.displayName : ''}
        replyTo={replyTo}
        replyName={replyTo && replyTo.record ? nameOf(replyTo.record.signer) : ''}
        onCancelReply={() => setReplyTo(null)}
        onSend={send}
        inputRef={inputRef}
      />
    </div>
  );
}
