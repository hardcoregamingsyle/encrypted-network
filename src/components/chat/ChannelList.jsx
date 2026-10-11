import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Avatar from '../Avatar.jsx';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import EmptyState from '../EmptyState.jsx';
import Icon from '../Icon.jsx';
import Skeleton from '../Skeleton.jsx';
import { listChannels } from '../../lib/api.js';
import { channelPreview, createPoller, describeApiError, filterChannels, sortChannels } from '../../lib/chatClient.js';
import { chatListTime, textOf } from '../../lib/format.js';
import { seedSeen, unreadCount } from '../../lib/unread.js';

// How often the list looks for new messages while the tab is visible.
export const LIST_POLL_MS = 10000;

// The first time the list loads, every chat counts as read, so a new visitor does not see a pile of
// unread counts. Later loads in the same page session leave the counts alone.
let seededOnce = false;

// One row of the chat list. Every field comes from the server and is not signature checked, so each
// one is coerced before it is shown. The unread count comes from this browser's own memory.
export function ChannelCard({ channel, now }) {
  const count = Number.isFinite(channel.messageCount) ? channel.messageCount : 0;
  const title = textOf(channel.title) || textOf(channel.channelId);
  const docId = textOf(channel.docId);
  const preview = channelPreview(channel);
  const stamp = Number.isFinite(channel.lastMessageAt) ? channel.lastMessageAt : null;
  const time = stamp !== null ? chatListTime(stamp, now) : '';
  const unread = unreadCount(channel);
  const base = count === 0 ? 'No messages yet' : count === 1 ? '1 message' : `${count} messages`;
  const sub = preview || (channel.private === true ? `Private chat. ${base}` : base);
  return (
    <li className="ui-items__row chat-row">
      <Link className="ui-item chat-row__link" to={`/chats/${encodeURIComponent(textOf(channel.channelId))}`}>
        <span className="ui-item__lead">
          <Avatar name={title} keyId={textOf(channel.channelId)} size={48} />
        </span>
        <span className="ui-item__body">
          <span className="ui-item__title">{title}</span>
          <span className="ui-item__sub">
            {preview ? <span className="ui-sr-only">Not checked yet: </span> : null}
            {sub}
          </span>
        </span>
        {time || unread > 0 ? (
          <span className="ui-item__side">
            {time ? <span className="ui-item__meta">{time}</span> : null}
            {unread > 0 ? (
              <span className="ui-count">
                <span aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
                <span className="ui-sr-only">{`${unread} unread ${unread === 1 ? 'message' : 'messages'}`}</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </Link>
      {docId ? (
        <Link className="chat-row__file" to={`/d/${encodeURIComponent(docId)}`} aria-label={`Open the file linked to ${title}`}>
          <Icon name="file" size={20} />
        </Link>
      ) : null}
    </li>
  );
}

// The list of chats, loaded from the server and refreshed every 10 seconds while the tab is visible.
//   query         the search text
//   reloadKey     change it to load again at once (after a chat was created)
//   onNewChat     called by the button in the empty state
export default function ChannelList({ query = '', reloadKey = 0, onNewChat }) {
  const [state, setState] = useState({ phase: 'loading', channels: [], error: '', failing: false });
  const pollerRef = useRef(null);

  useEffect(() => {
    const ctl = new AbortController();
    const poller = createPoller({
      baseMs: LIST_POLL_MS,
      isHidden: () => typeof document !== 'undefined' && document.hidden === true,
      run: async () => {
        try {
          const res = await listChannels({ signal: ctl.signal });
          if (ctl.signal.aborted) return { stop: true };
          const rows = sortChannels(res && res.channels);
          if (!seededOnce) {
            seededOnce = true;
            seedSeen(rows);
          }
          setState({ phase: 'ready', channels: rows, error: '', failing: false });
          return { stop: false };
        } catch (err) {
          if (ctl.signal.aborted || (err && err.name === 'AbortError')) return { stop: true };
          setState((s) => ({
            ...s,
            phase: s.channels.length ? 'ready' : 'error',
            error: describeApiError(err, 'load the chats').message,
            failing: true
          }));
          throw err;
        }
      }
    });
    pollerRef.current = poller;
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
      pollerRef.current = null;
    };
  }, []);

  // A new chat was created: look again now.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (pollerRef.current) pollerRef.current.kick();
  }, [reloadKey]);

  const retry = useCallback(() => {
    setState((s) => ({ ...s, phase: s.channels.length ? s.phase : 'loading', error: '' }));
    if (pollerRef.current) pollerRef.current.kick();
  }, []);

  if (state.phase === 'loading') return <Skeleton variant="row" count={7} label="Loading chats" />;
  if (state.phase === 'error') {
    return (
      <Callout tone="bad" title="Could not load the chats">
        <p>{state.error}</p>
        <p>
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        </p>
      </Callout>
    );
  }
  if (state.channels.length === 0) {
    return (
      <EmptyState
        art="chats"
        title="No chats yet"
        action={
          onNewChat ? (
            <Button variant="primary" onClick={onNewChat}>
              Start the first chat
            </Button>
          ) : null
        }
      >
        Public chats can be read by anyone, private chats only by the people in them. Every message is signed by the person who wrote it.
      </EmptyState>
    );
  }
  const shown = filterChannels(state.channels, query);
  const now = Date.now();
  return (
    <>
      {shown.length === 0 ? (
        <EmptyState art="search" title="No chat matches">
          Nothing matches your search. Check the spelling or clear the search box.
        </EmptyState>
      ) : (
        <ul className="ui-items chat-rows" aria-label="Chats">
          {shown.map((c) => (
            <ChannelCard key={c.channelId} channel={c} now={now} />
          ))}
        </ul>
      )}
      {state.failing ? (
        <p className="ui-muted chat-listnote" role="status">
          Could not refresh the list. Trying again.
        </p>
      ) : null}
    </>
  );
}
