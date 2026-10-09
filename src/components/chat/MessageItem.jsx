import Button from '../Button.jsx';
import HashText from '../HashText.jsx';
import KeyBadge from '../KeyBadge.jsx';
import VerifyBadge from './VerifyBadge.jsx';
import { formatTime } from '../../lib/format.js';

const QUOTE_MAX = 140;
const BODY_SHOW_MAX = 4000;

function isoOf(ms) {
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

export function quoteText(text) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > QUOTE_MAX ? chars.slice(0, QUOTE_MAX).join('') + '...' : flat;
}

// The quoted parent of a reply. parent is the loaded entry (or undefined when it is not loaded).
export function ReplyPreview({ replyTo, parent, parentName, onJump }) {
  if (!parent) {
    return (
      <p className="chat-quote chat-quote--missing">
        Reply to an earlier message that is not loaded here (<HashText value={replyTo} short />).
      </p>
    );
  }
  const ok = parent.verdict && parent.verdict.status === 'verified';
  const who = ok && parentName ? parentName : 'a sender';
  return (
    <button
      type="button"
      className="chat-quote"
      onClick={() => onJump && onJump(parent.seq)}
      aria-label={`Replying to ${who}, message ${parent.seq}. Jump to it.`}
    >
      <span className="chat-quote__who">{ok ? who : 'A message that failed verification'}</span>
      <span className="chat-quote__text">{ok ? quoteText(parent.record && parent.record.body) : 'Its text is not shown.'}</span>
    </button>
  );
}

// One message from the server, with its check result.
//   entry    { seq, hash, record, verdict }
//   name     display name from the signer's identity record (only shown when the message verified)
//   parent   the entry this message replies to, when it is loaded
export function MessageItem({ entry, name, parent, parentName, own = false, canReply = false, onReply, onJump }) {
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
  return (
    <li
      id={`chat-msg-${entry.seq}`}
      tabIndex={-1}
      className={`chat-msg chat-msg--${status}${own ? ' chat-msg--own' : ''}`}
      data-seq={entry.seq}
    >
      <div className="chat-msg__head">
        <KeyBadge keyId={rec.signer} name={shownName} />
        <VerifyBadge status={status} detail={verdict.detail} />
        <span className="chat-msg__meta">
          <time dateTime={isoOf(rec.createdAt)} title="Time written on the message by its signer">
            {formatTime(rec.createdAt)}
          </time>
          <span aria-hidden="true"> · </span>
          <span className="chat-msg__seq">{`#${entry.seq}`}</span>
        </span>
      </div>
      {rec.replyTo ? <ReplyPreview replyTo={rec.replyTo} parent={parent} parentName={parentName} onJump={onJump} /> : null}
      {verified ? null : (
        <p className="chat-msg__reason">
          {status === 'invalid'
            ? `Do not trust this message. ${verdict.detail || 'The check failed.'}`
            : `This message was not checked. ${verdict.detail || ''}`.trim()}
        </p>
      )}
      <p className="chat-msg__body">
        {verified ? null : <span className="ui-sr-only">Unverified text: </span>}
        {body}
        {cut ? ' ...' : ''}
      </p>
      {canReply && verified && onReply ? (
        <div className="chat-msg__actions">
          <Button size="sm" variant="ghost" onClick={() => onReply(entry)} aria-label={`Reply to ${sender}, message ${entry.seq}`}>
            Reply
          </Button>
        </div>
      ) : null}
    </li>
  );
}

// A message this browser just sent, shown before the server list contains it.
export function PendingItem({ item, name, keyId, onRetry, onDiscard }) {
  const rec = item.record;
  const failed = item.status === 'failed';
  const sent = item.status === 'sent';
  let text = 'Sending...';
  if (sent) text = 'Sent. Waiting for it to appear in the list, then it is checked again from the server copy.';
  if (failed) text = item.error || 'Could not send.';
  return (
    <li className={`chat-msg chat-msg--pending${failed ? ' chat-msg--failed' : ''} chat-msg--own`} data-status={item.status}>
      <div className="chat-msg__head">
        <KeyBadge keyId={keyId} name={name} />
        <span className={`ui-badge ui-badge--${failed ? 'bad' : 'info'} chat-vbadge`}>{failed ? 'Not sent' : sent ? 'Sent' : 'Sending'}</span>
        <span className="chat-msg__meta">
          <time dateTime={isoOf(rec.createdAt)}>{formatTime(rec.createdAt)}</time>
        </span>
      </div>
      <p className="chat-msg__body">{rec.body}</p>
      <p className={`chat-msg__reason${failed ? '' : ' chat-msg__reason--soft'}`} role={failed ? 'alert' : undefined}>
        {text}
      </p>
      {failed ? (
        <div className="chat-msg__actions">
          <Button size="sm" variant="primary" onClick={() => onRetry && onRetry(item)}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDiscard && onDiscard(item)}>
            Discard
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export default MessageItem;
