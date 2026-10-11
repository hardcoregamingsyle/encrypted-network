import { Link } from 'react-router-dom';
import Callout from '../Callout.jsx';
import Sheet from '../Sheet.jsx';
import AnchorStatus from './AnchorStatus.jsx';
import { POLL_MS } from '../../lib/chatClient.js';
import { formatTime, textOf } from '../../lib/format.js';
import { isTrustMismatch } from './roomLogic.js';

function pollWords(poll) {
  if (poll.status === 'paused') return 'Paused while this tab is hidden.';
  if (poll.status === 'retrying') return `Connection problem. Trying again in ${Math.max(1, Math.round(poll.delay / 1000))} seconds.`;
  if (poll.status === 'stopped') return 'Not checking for new messages.';
  return `Looking for new messages every ${POLL_MS / 1000} seconds.`;
}

// The technical side of one chat, for people who want it: what the server states (not signature
// checked) and what this device checked. The main screen only shows a short line about it.
export default function RoomDetails({ open, onClose, channelId, view, poll, trust }) {
  const channel = view.channel;
  const startedBy = channel ? textOf(channel.createdByName) : '';
  const docId = channel ? textOf(channel.docId) : '';
  const verified = view.entries.filter((e) => e.verdict && e.verdict.status === 'verified').length;
  const failed = view.entries.filter((e) => e.verdict && e.verdict.status === 'invalid').length;
  return (
    <Sheet open={open} onClose={onClose} title="Chat details">
      <div className="ui-stack chat-details">
        <section aria-labelledby="chat-det-server">
          <h3 id="chat-det-server" className="chat-details__h">
            What the server says
          </h3>
          <p className="ui-muted">This part is not signature checked. It is shown as information only.</p>
          <dl className="ui-kv">
            <dt>Chat id</dt>
            <dd className="chat-channel__id">{channelId}</dd>
            {startedBy ? (
              <>
                <dt>Started by</dt>
                <dd>{startedBy}</dd>
              </>
            ) : null}
            {channel && Number.isFinite(channel.createdAt) ? (
              <>
                <dt>Started</dt>
                <dd>{formatTime(channel.createdAt)}</dd>
              </>
            ) : null}
            {channel && Number.isFinite(channel.messageCount) ? (
              <>
                <dt>Messages</dt>
                <dd>{channel.messageCount}</dd>
              </>
            ) : null}
            {docId ? (
              <>
                <dt>Linked file</dt>
                <dd>
                  <Link to={`/d/${encodeURIComponent(docId)}`}>Open the file page</Link>
                </dd>
              </>
            ) : null}
          </dl>
        </section>
        <section aria-labelledby="chat-det-device">
          <h3 id="chat-det-device" className="chat-details__h">
            What your device checked
          </h3>
          <p>
            {view.entries.length === 0
              ? 'No messages to check yet.'
              : `${verified} of ${view.entries.length} shown messages have a verified signature${failed ? `, ${failed} failed` : ''}. Names come from each sender's own signed identity record.`}
          </p>
          {isTrustMismatch(trust) ? (
            <Callout tone="bad" title="The server's identity changed since your last visit">
              <p>The server now signs with a different key than the one you pinned or saw before. Do not rely on this chat until you know why.</p>
            </Callout>
          ) : null}
          {view.problems.length > 0 ? (
            <Callout tone="bad" title="Problems found while checking this chat">
              <ul className="ui-list">
                {view.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          <AnchorStatus anchor={view.anchor} />
          {trust === 'first-visit' ? <p className="ui-muted">First visit: the server key was remembered, so a change will be reported next time.</p> : null}
          {trust === 'first-visit-unsaved' ? <p className="ui-muted">First visit: this browser could not save the server key, so a change on a later visit would not be reported.</p> : null}
          <p className="ui-muted" role="status">
            {pollWords(poll)}
          </p>
        </section>
        <p className="ui-muted">
          Names are not unique, so two people can choose the same name. The avatar colour comes from the sender's key, so one sender always has the same colour. Times are written by the sender and the server does not vouch for them.
        </p>
      </div>
    </Sheet>
  );
}
