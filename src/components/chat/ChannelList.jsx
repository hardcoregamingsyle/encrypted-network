import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import EmptyState from '../EmptyState.jsx';
import KeyBadge from '../KeyBadge.jsx';
import Spinner from '../Spinner.jsx';
import { listChannels } from '../../lib/api.js';
import { describeApiError, sortChannels } from '../../lib/chatClient.js';
import { formatTime, shortHash, textOf, timeAgo } from '../../lib/format.js';
import { isHash } from '../../../shared/records.js';

export function ChannelCard({ channel, now }) {
  // Every field comes from the server, so each one is checked before it is shown.
  const count = Number.isFinite(channel.messageCount) ? channel.messageCount : 0;
  const title = textOf(channel.title) || textOf(channel.channelId);
  const docId = textOf(channel.docId);
  const createdBy = isHash(channel.createdBy) ? channel.createdBy : '';
  return (
    <li className="chat-channel">
      <div className="chat-channel__main">
        <h3 className="chat-channel__title">
          <Link to={`/chat/${channel.channelId}`}>{title}</Link>
        </h3>
        <p className="chat-channel__id">{channel.channelId}</p>
        <p className="chat-channel__meta">
          <span>{count === 1 ? '1 message' : `${count} messages`}</span>
          <span aria-hidden="true"> · </span>
          {Number.isFinite(channel.lastMessageAt) ? (
            <span title={formatTime(channel.lastMessageAt)}>{`last message ${timeAgo(channel.lastMessageAt, now)}`}</span>
          ) : (
            <span>no messages yet</span>
          )}
        </p>
        {createdBy ? (
          <p className="chat-channel__meta">
            <span>Started by </span>
            <KeyBadge keyId={createdBy} name={textOf(channel.createdByName)} />
          </p>
        ) : null}
        {docId ? (
          <p className="chat-channel__meta">
            About document <Link to={`/d/${docId}`}>{shortHash(docId, 8)}</Link>
          </p>
        ) : null}
      </div>
    </li>
  );
}

// The list of channels, loaded from the server. reloadKey changes after a channel is created.
export default function ChannelList({ reloadKey = 0 }) {
  const [state, setState] = useState({ phase: 'loading', channels: [], error: '' });
  const [tries, setTries] = useState(0);

  const load = useCallback(() => setTries((n) => n + 1), []);

  useEffect(() => {
    const ctl = new AbortController();
    setState((s) => ({ ...s, phase: s.channels.length ? 'refreshing' : 'loading', error: '' }));
    listChannels({ signal: ctl.signal })
      .then((res) => {
        if (ctl.signal.aborted) return;
        setState({ phase: 'ready', channels: sortChannels(res && res.channels), error: '' });
      })
      .catch((err) => {
        if (ctl.signal.aborted || (err && err.name === 'AbortError')) return;
        setState((s) => ({ ...s, phase: 'error', error: describeApiError(err, 'load the channels').message }));
      });
    return () => ctl.abort();
  }, [tries, reloadKey]);

  const now = Date.now();
  const showList = state.phase === 'ready' || state.phase === 'refreshing' || (state.phase === 'error' && state.channels.length > 0);
  return (
    <section className="chat-section" aria-labelledby="chat-channels-title" aria-busy={state.phase === 'loading' ? 'true' : 'false'}>
      <div className="chat-section__head">
        <h2 id="chat-channels-title" className="chat-section__title">
          Channels
        </h2>
        <Button size="sm" onClick={load} loading={state.phase === 'refreshing'}>
          Refresh
        </Button>
      </div>
      {state.phase === 'loading' ? (
        <div className="chat-channels-loading">
          <Spinner label="Loading channels" />
        </div>
      ) : null}
      {state.phase === 'error' ? (
        <Callout tone="bad" title="Could not load the channels">
          <p>{state.error}</p>
          <p>
            <Button size="sm" onClick={load}>
              Try again
            </Button>
          </p>
        </Callout>
      ) : null}
      {showList ? (
        state.channels.length === 0 ? (
          <EmptyState title="No channels yet">Start the first one with the form on this page.</EmptyState>
        ) : (
          <ul className="chat-channels">
            {state.channels.map((c) => (
              <ChannelCard key={c.channelId} channel={c} now={now} />
            ))}
          </ul>
        )
      ) : null}
      <p className="ui-muted">
        The list and the details above come from the server and are not signature checked. Messages inside a channel are checked in your browser.
      </p>
    </section>
  );
}
