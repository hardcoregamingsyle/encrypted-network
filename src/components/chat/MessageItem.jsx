import Avatar from '../Avatar.jsx';
import Button from '../Button.jsx';
import Icon from '../Icon.jsx';
import { formatClock } from '../../lib/format.js';
import { pendingLabel, quoteLine } from './roomLogic.js';

const BODY_SHOW_MAX = 4000;

function isoOf(ms) {
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

export function quoteText(text) {
  return quoteLine(text);
}

// The quoted parent of a reply, shown at the top of a bubble. parent is the loaded message, or
// undefined when it is not loaded. The text and name of a message that failed its check are never shown.
export function ReplyPreview({ replyTo, parent, parentName, onJump }) {
  if (!parent) {
    return <p className="chat-quote chat-quote--missing">Reply to an earlier message that is not loaded here.</p>;
  }
  const ok = parent.verdict && parent.verdict.status === 'verified';
  const who = ok && parentName ? parentName : 'a sender';
  return (
    <button
      type="button"
      className="chat-quote"
      onClick={() => onJump && onJump(parent.seq)}
      aria-label={`${ok ? who : 'A message that failed verification'}: ${ok ? quoteText(parent.record && parent.record.body) : 'its text is not shown'}. Replying to message ${parent.seq}, jump to it.`}
    >
      <span className="chat-quote__who">{ok ? who : 'A message that failed verification'}</span>
      <span className="chat-quote__text">{ok ? quoteText(parent.record && parent.record.body) : 'Its text is not shown.'}</span>
    </button>
  );
}

// What the tick says, in plain words. It is only drawn for a message that was checked here.
export const TICK_TEXT = 'Checked: written by this sender and not changed';

// The small tick under a bubble.
function Tick({ detail }) {
  return (
    <span className="chat-tick" title={detail ? `${TICK_TEXT}: ${detail}` : `${TICK_TEXT}, checked in this browser`}>
      <Icon name="check" size={14} />
      <span className="ui-sr-only">{TICK_TEXT}</span>
    </span>
  );
}

// One message from the server, drawn as a chat bubble.
//   entry      { seq, hash, record, verdict }
//   name       display name from the signer's identity record (only shown when the message verified)
//   parent     the entry this message replies to, when it is loaded
//   own        written by this device's key (right side, accent colour)
//   grouped    the sender line and avatar are left out (the same sender wrote just before)
//   onReply    called with the entry (shown as a button on hover and focus)
//   onMenu     called with the entry (the "more" button, the way to reach Reply on a touch screen)
export function MessageItem({ entry, name, parent, parentName, own = false, grouped = false, endOfGroup = true, canReply = false, onReply, onMenu, onJump }) {
  const rec = entry && entry.record && typeof entry.record === 'object' ? entry.record : {};
  const verdict = entry && entry.verdict ? entry.verdict : { status: 'unverified', detail: '' };
  const status = verdict.status;
  const verified = status === 'verified';
  let body = typeof rec.body === 'string' ? rec.body : '';
  let cut = false;
  if (body.length > BODY_SHOW_MAX) {
    body = body.slice(0, BODY_SHOW_MAX);
    cut = true;
  }
  const shownName = verified && name ? name : '';
  const sender = verified && name ? name : 'a sender';
  const showSender = !own && !grouped;
  const detail = typeof verdict.detail === 'string' ? verdict.detail : '';
  const classes = [
    'chat-msg',
    `chat-msg--${status}`,
    own ? 'chat-msg--own' : 'chat-msg--other',
    grouped ? 'chat-msg--grouped' : 'chat-msg--first',
    endOfGroup ? 'chat-msg--end' : ''
  ]
    .filter(Boolean)
    .join(' ');

  const bodyNode = (
    <p className="chat-msg__body">
      {body}
      {cut ? ' ...' : ''}
    </p>
  );

  return (
    <li id={`chat-msg-${entry.seq}`} tabIndex={-1} className={classes} data-seq={entry.seq}>
      {own ? null : (
        <span className="chat-msg__avatar">{showSender ? <Avatar name={shownName || '?'} keyId={rec.signer} size={32} /> : null}</span>
      )}
      <div className="chat-msg__col">
        <div className="chat-bubble">
          {own ? <span className="ui-sr-only">You: </span> : null}
          {!own && grouped && verified ? <span className="ui-sr-only">{`${shownName || 'A sender'}: `}</span> : null}
          {showSender ? (
            <p className="chat-msg__name" title={verified && rec.signer ? `Key id ${rec.signer}` : undefined}>
              {verified ? shownName || 'A sender' : 'Unknown sender'}
            </p>
          ) : null}
          {rec.replyTo ? <ReplyPreview replyTo={rec.replyTo} parent={parent} parentName={parentName} onJump={onJump} /> : null}
          {verified ? (
            bodyNode
          ) : (
            <>
              <p className="chat-msg__reason">{status === 'invalid' ? 'Could not verify this message' : 'This message was not checked'}</p>
              <p className="chat-msg__why">
                <span className="ui-sr-only">{status === 'invalid' ? 'Failed verification. ' : 'Not verified. '}</span>
                {status === 'invalid' ? 'Do not trust this message.' : 'Treat it with care.'}
              </p>
              <details className="chat-msg__raw">
                <summary>Show the text anyway</summary>
                {detail ? <span className="ui-muted">{`The check said: ${detail}`}</span> : null}
                <span className="ui-sr-only">Unverified text: </span>
                {bodyNode}
              </details>
            </>
          )}
          <p className="chat-msg__foot">
            <time className="chat-msg__time" dateTime={isoOf(rec.createdAt)} title="Time written on the message by its sender. The server does not vouch for it.">
              {formatClock(rec.createdAt)}
            </time>
            {verified ? <Tick detail={detail} /> : null}
          </p>
        </div>
        {verified && (onMenu || (canReply && onReply)) ? (
          <div className="chat-msg__actions">
            {canReply && onReply ? (
              <button type="button" className="chat-iconbtn chat-iconbtn--hover" onClick={() => onReply(entry)} aria-label={`Reply to ${sender}, message ${entry.seq}`}>
                <Icon name="reply" size={18} />
              </button>
            ) : null}
            {onMenu ? (
              <button type="button" className="chat-iconbtn chat-iconbtn--more" onClick={() => onMenu(entry)} aria-haspopup="dialog" aria-label={`More for message ${entry.seq} by ${sender}`}>
                <Icon name="more" size={18} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

// A message this browser just sent, shown before the server list contains it. Sending shows a
// clock, a failed send shows the reason with Try again and Discard.
export function PendingItem({ item, name, keyId, onRetry, onDiscard }) {
  const rec = item.record;
  const failed = item.status === 'failed';
  const label = pendingLabel(item);
  let text = '';
  if (item.status === 'sent') text = 'Sent. Waiting for it to come back from the server and be checked.';
  if (failed) text = item.error || 'Could not send.';
  return (
    <li className={`chat-msg chat-msg--pending chat-msg--own chat-msg--first chat-msg--end${failed ? ' chat-msg--failed' : ''}`} data-status={item.status}>
      <div className="chat-msg__col">
        <div className="chat-bubble">
          <p className="chat-msg__body">{rec.body}</p>
          <p className="chat-msg__foot">
            <time className="chat-msg__time" dateTime={isoOf(rec.createdAt)}>
              {formatClock(rec.createdAt)}
            </time>
            <span className="chat-pendingmark" title={label.label}>
              <Icon name={failed ? 'warn' : 'clock'} size={14} />
              <span className="ui-sr-only">{`${label.label}${name ? ` as ${name}` : ''}`}</span>
            </span>
          </p>
        </div>
        {text ? (
          <p className={`chat-msg__note${failed ? ' chat-msg__note--bad' : ''}`} role={failed ? 'alert' : undefined}>
            {text}
          </p>
        ) : null}
        {failed ? (
          <div className="chat-msg__retry">
            <Button size="sm" variant="primary" onClick={() => onRetry && onRetry(item)}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDiscard && onDiscard(item)}>
              Discard
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export default MessageItem;
