import { useEffect, useId, useRef, useState } from 'react';
import { useSignInPrompt } from '../AuthPrompt.jsx';
import Button from '../Button.jsx';
import Icon from '../Icon.jsx';
import Skeleton from '../Skeleton.jsx';
import { NEEDS_KEY_COPY, needsKeyKind } from '../../lib/authText.js';
import { BODY_MAX, checkBody, countChars } from '../../lib/chatClient.js';
import { useSession } from '../../lib/session.jsx';
import { counterState, quoteLine } from './roomLogic.js';

// The writing box, pinned to the bottom of the room.
//   identityStatus   'loading' | 'ready' | 'needsKey' | anything else means signed out
//   onSend(body, replyToEntry)  async, resolves { ok, error? }. ok false keeps the text.
//   replyTo          entry being answered, or null
// On a computer Enter sends and Shift+Enter starts a new line. On a phone or tablet (a touch screen with no
// mouse) Enter starts a new line, because there is no Shift+Enter, and the round Send button sends.
// Signed out people see a "Sign in to write" button.
// True on a phone or tablet: the main pointer is a finger and nothing can hover.
function onTouchKeyboard() {
  try {
    return typeof window !== 'undefined' && Boolean(window.matchMedia && window.matchMedia('(pointer: coarse) and (hover: none)').matches);
  } catch {
    return false;
  }
}

export default function Composer({ identityStatus, signerName, replyTo, replyName, onCancelReply, onSend, inputRef }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [touch, setTouch] = useState(false);
  const lock = useRef(false);
  const localRef = useRef(null);
  const ref = inputRef || localRef;
  const ids = useId();
  const prompt = useSignInPrompt();
  const session = useSession();

  useEffect(() => {
    setTouch(onTouchKeyboard());
  }, []);

  // The box grows with the text, up to a few lines, then scrolls.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [text, ref, identityStatus]);

  if (identityStatus === 'loading') {
    return (
      <div className="chat-compose chat-compose--note">
        <Skeleton variant="text" label="Checking if you are signed in" />
      </div>
    );
  }
  if (identityStatus !== 'ready') {
    const needsKey = identityStatus === 'needsKey';
    const copy = NEEDS_KEY_COPY[needsKeyKind(session)];
    return (
      <div className="chat-compose chat-compose--signin">
        <p className="chat-compose__why">{needsKey ? copy.write : 'Everyone can read this chat. Sign in to write.'}</p>
        <Button variant="primary" onClick={() => prompt.open('to write in this chat')}>
          {needsKey ? copy.action : 'Sign in to write'}
        </Button>
      </div>
    );
  }

  const count = countChars(text);
  const over = count > BODY_MAX;
  const counter = counterState(count, BODY_MAX);
  const hintId = `${ids}-hint`;
  const errId = `${ids}-err`;
  const inputId = `${ids}-input`;

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
    // On a touch screen Enter is a new line and the Send button sends.
    if (onTouchKeyboard()) return;
    // Shift+Enter is a new line. Enter (with or without Ctrl or Cmd) sends.
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
            <span className="chat-replying__quote">{quoteLine(replyTo.record && replyTo.record.body)}</span>
          </p>
          <button type="button" className="chat-iconbtn" onClick={onCancelReply} aria-label="Cancel the reply">
            <Icon name="x" size={18} />
          </button>
        </div>
      ) : null}
      <div className="chat-compose__row">
        <label className="ui-sr-only" htmlFor={inputId}>
          {signerName ? `Message as ${signerName}` : 'Message'}
        </label>
        <textarea
          id={inputId}
          ref={ref}
          className="chat-compose__input"
          rows={1}
          placeholder="Write a message"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError('');
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          enterKeyHint={touch ? 'enter' : 'send'}
          spellCheck
          maxLength={BODY_MAX * 4}
          aria-describedby={[hintId, error ? errId : ''].filter(Boolean).join(' ')}
          aria-invalid={error || over ? 'true' : undefined}
        />
        <button type="submit" className="chat-send" disabled={over || count === 0 || busy} aria-label="Send message">
          <Icon name="send" size={22} />
        </button>
      </div>
      <p className="ui-sr-only" id={hintId}>
        {touch ? 'Enter starts a new line. Use the Send button to send.' : 'Enter sends, Shift+Enter starts a new line.'}
      </p>
      <p className={`chat-compose__count${counter.tone ? ` is-${counter.tone}` : ''}`} aria-live="polite">
        {counter.show ? counter.text : ''}
      </p>
      {error ? (
        <p className="chat-error" id={errId} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
