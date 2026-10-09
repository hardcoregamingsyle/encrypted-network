import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import Field from '../Field.jsx';
import { BODY_MAX, checkBody, countChars } from '../../lib/chatClient.js';
import { quoteText } from './MessageItem.jsx';

// The box for writing a message.
//   identityStatus   'loading' | 'none' | 'ready'
//   onSend(body, replyToEntry)  async, resolves { ok, error? }. ok false keeps the text.
//   replyTo          entry being answered, or null
export default function Composer({ identityStatus, signerName, replyTo, replyName, onCancelReply, onSend, inputRef }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const localRef = useRef(null);
  const ref = inputRef || localRef;

  if (identityStatus === 'loading') {
    return (
      <div className="chat-compose chat-compose--note">
        <p className="ui-muted">Checking for your identity...</p>
      </div>
    );
  }
  if (identityStatus !== 'ready') {
    return (
      <div className="chat-compose">
        <Callout tone="info" title="You need an identity to write here">
          Every message is signed with your key. You can read this channel without one.{' '}
          <Link to="/keys">Create or restore an identity</Link>.
        </Callout>
      </div>
    );
  }

  const count = countChars(text);
  const over = count > BODY_MAX;
  const near = count >= BODY_MAX * 0.9;

  async function submit() {
    if (lock.current) return;
    const check = checkBody(text);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    const sent = text;
    setText('');
    try {
      const res = await onSend(check.body, replyTo);
      if (res && res.ok === false) {
        setText((now) => (now === '' ? sent : now));
        setError(res.error || 'Could not send the message.');
      }
    } catch (err) {
      setText((now) => (now === '' ? sent : now));
      setError(err && err.message ? err.message : 'Could not send the message.');
    } finally {
      lock.current = false;
      setBusy(false);
      if (ref.current) ref.current.focus();
    }
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    // Shift+Enter is a new line. Enter and Ctrl+Enter (or Cmd+Enter) send.
    if (e.shiftKey) return;
    e.preventDefault();
    submit();
  }

  return (
    <form
      className="chat-compose"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      {replyTo ? (
        <div className="chat-replying">
          <p className="chat-replying__text">
            <span className="chat-replying__label">{`Replying to ${replyName || 'a sender'}`}</span>
            <span className="chat-replying__quote">{quoteText(replyTo.record && replyTo.record.body)}</span>
          </p>
          <Button size="sm" variant="ghost" onClick={onCancelReply} aria-label="Cancel the reply">
            Cancel
          </Button>
        </div>
      ) : null}
      <Field
        label={signerName ? `Message as ${signerName}` : 'Message'}
        hint="Enter sends, Shift+Enter starts a new line."
        error={error || (over ? `The message is ${count} characters, the limit is ${BODY_MAX}.` : '')}
      >
        <textarea
          ref={ref}
          className="chat-compose__input"
          rows={3}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError('');
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck
          maxLength={BODY_MAX * 4}
        />
      </Field>
      <div className="chat-compose__bar">
        <span className={`chat-compose__count${over ? ' is-over' : near ? ' is-near' : ''}`} aria-live={over || near ? 'polite' : 'off'}>
          {`${count} / ${BODY_MAX}`}
        </span>
        <Button type="submit" variant="primary" loading={busy} disabled={over || count === 0}>
          Send
        </Button>
      </div>
    </form>
  );
}
