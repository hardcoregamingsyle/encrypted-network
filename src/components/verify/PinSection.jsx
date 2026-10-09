import { useEffect, useState } from 'react';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import CopyButton from '../CopyButton.jsx';
import Field from '../Field.jsx';
import HashText from '../HashText.jsx';
import Spinner from '../Spinner.jsx';
import { getServerKey } from '../../lib/api.js';
import { keyIdOf } from '../../../shared/keys.js';
import { clearPin, setPinnedServerKeyId } from '../../lib/pin.js';
import Section from './Section.jsx';
import { parseKeyIdInput, pinStatus } from './logic.js';

// Returns the server answer with keyId replaced by the id computed from publicKey.
//   keyChecked   true when the id was computed from a valid public key
//   inconsistent true when the server stated a different id than the one computed
async function withCheckedKeyId(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  if (!data.signing) return { ...data, keyChecked: false };
  try {
    const computed = await keyIdOf(data.publicKey);
    return {
      ...data,
      statedKeyId: typeof data.keyId === 'string' ? data.keyId : '',
      keyId: computed,
      keyChecked: true,
      inconsistent: typeof data.keyId === 'string' && data.keyId !== computed
    };
  } catch {
    return { ...data, statedKeyId: typeof data.keyId === 'string' ? data.keyId : '', keyId: '', keyChecked: false };
  }
}

// Loads the key this site's server signs with. status: loading, ready or error.
function useServerKey() {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    setState({ status: 'loading', data: null, error: '' });
    getServerKey({ signal: ctrl ? ctrl.signal : undefined }).then(
      async (raw) => {
        // The key id the server states is only text. The id shown and compared is worked out here
        // from the public key it sends, the same way every signature check does it.
        const data = await withCheckedKeyId(raw);
        if (alive) setState({ status: 'ready', data, error: '' });
      },
      (err) => {
        if (!alive) return;
        const message = err && err.message ? err.message : 'The server key could not be loaded.';
        setState({ status: 'error', data: null, error: message });
      }
    );
    return () => {
      alive = false;
      if (ctrl) ctrl.abort();
    };
  }, [attempt]);
  return [state, () => setAttempt((n) => n + 1)];
}

function StateCallout({ status, pinned, serverKeyId }) {
  if (status === 'different') {
    return (
      <div className="verify-alarm">
        <Callout tone="bad" title="STOP: this server is not using the key you pinned">
          <p>
            You pinned <HashText value={pinned} />, but this site signs with <HashText value={serverKeyId} />.
          </p>
          <p>
            Do not rely on any document or ledger answer from this site until you know why. Either you pinned the wrong
            key, the key was changed on purpose, or this is not the site you meant to use. Every check on this page
            that depends on the server key will fail while the keys differ.
          </p>
        </Callout>
      </div>
    );
  }
  if (status === 'inconsistent') {
    return (
      <div className="verify-alarm">
        <Callout tone="bad" title="STOP: the server states one key id but sends another key">
          <p>
            The key id this server states about itself does not match the public key it sends. Do not rely on anything
            from this site until you know why.
          </p>
        </Callout>
      </div>
    );
  }
  if (status === 'match') {
    return (
      <Callout tone="good" title="Pinned, and it matches">
        The public key this site sends has the key id you pinned. Checks on this page will fail if that ever changes.
      </Callout>
    );
  }
  if (status === 'no_signing') {
    return (
      <Callout tone="bad" title="Pinned, but this server is not signing">
        You pinned a key, but this server has no signing key set up right now. It cannot prove anything with a
        signature, so checks that need the server key will fail.
      </Callout>
    );
  }
  if (status === 'unknown') {
    return (
      <Callout tone="warn" title="Pinned, but the server key could not be loaded">
        Your pin is saved. Load the server key again above to see whether it matches.
      </Callout>
    );
  }
  if (status === 'checking') {
    return (
      <Callout tone="info" title="Pinned, checking the server key">
        Your pin is saved. Comparing it with the key this site uses now.
      </Callout>
    );
  }
  return (
    <Callout tone="warn" title="Not pinned">
      Without a pin, a check can only show that the server agrees with itself. Paste the key id you got from an official
      source below to close that gap.
    </Callout>
  );
}

// Section 1: the server key and the pin.
export default function PinSection({ pinned, onPinChange }) {
  const [server, reload] = useServerKey();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const status = pinStatus(pinned, server);
  const serverKeyId = server.status === 'ready' && server.data && server.data.keyId ? server.data.keyId : '';
  const typed = parseKeyIdInput(text);
  let liveHint = '';
  if (typed.state === 'ok' && serverKeyId) {
    liveHint =
      typed.value === serverKeyId
        ? 'This is the same as the key this site uses now.'
        : 'This is different from the key this site uses now. Save it only if your official source gave you this one.';
  }

  function onSave(e) {
    e.preventDefault();
    setNote('');
    const parsed = parseKeyIdInput(text);
    if (parsed.state === 'empty') {
      setError('Paste the server key id first.');
      return;
    }
    if (parsed.state === 'invalid') {
      setError('A key id is 64 letters and numbers (0-9 and a-f). Check that you copied all of it.');
      return;
    }
    setError('');
    const stored = setPinnedServerKeyId(parsed.value);
    onPinChange(parsed.value);
    setText('');
    setNote(
      stored
        ? 'Pin saved in this browser.'
        : 'Pin set for this visit only. Your browser blocked storage, so it will be forgotten when you leave.'
    );
  }

  function onClear() {
    clearPin();
    onPinChange('');
    setError('');
    setNote('Pin cleared.');
  }

  return (
    <Section
      id="verify-pin"
      title="1. Server key pin"
      intro="Pinning tells this browser which server key to trust, so a look-alike site cannot pass for the real one."
    >
      <div className="verify-block">
        <h3 className="verify-subtitle">Server key id on this site</h3>
        {server.status === 'loading' ? (
          <p className="verify-loading">
            <Spinner label="Loading the server key" size="sm" /> <span aria-hidden="true">Loading the server key...</span>
          </p>
        ) : server.status === 'error' ? (
          <Callout tone="bad" title="Could not load the server key">
            <p>{server.error}</p>
            <p>
              <Button size="sm" onClick={reload}>
                Try again
              </Button>
            </p>
          </Callout>
        ) : server.data && server.data.signing && server.data.keyId ? (
          <p className="verify-keyline">
            <HashText value={server.data.keyId} />{' '}
            <CopyButton text={server.data.keyId} label="Copy" describe="server key id" />
          </p>
        ) : (
          <Callout tone="warn" title="This server is not signing right now">
            It has no signing key set up, so it cannot give signed checkpoints. Document checks that need the server key
            will not be able to pass.
          </Callout>
        )}
      </div>

      <div className="verify-block">
        <h3 className="verify-subtitle">Why pinning matters</h3>
        <p>
          Everything the server sends is signed with one key, named by its key id. If you never fix that key id in
          advance, a fake copy of this site would simply sign with its own key and every check would still look fine.
          Get the real key id from somewhere you already trust, such as a printed notice, a government page or a phone
          call, and pin it here. After that, a different key is flagged loudly.
        </p>
      </div>

      <div className="verify-block" aria-live="polite">
        <h3 className="verify-subtitle">Your pin</h3>
        <StateCallout status={status} pinned={pinned} serverKeyId={serverKeyId} />
        {pinned ? (
          <p className="verify-keyline">
            Pinned key id: <HashText value={pinned} />
          </p>
        ) : null}
      </div>

      <form className="verify-form" onSubmit={onSave} noValidate>
        <Field
          label="Expected server key id (from an official source)"
          hint="64 letters and numbers. Spaces and dashes are ignored."
          error={error}
        >
          <input
            type="text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError('');
              setNote('');
            }}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            maxLength={200}
            className="verify-mono-input"
          />
        </Field>
        {liveHint ? <p className="ui-muted">{liveHint}</p> : null}
        <div className="ui-row">
          <Button type="submit" variant="primary">
            Save pin
          </Button>
          {pinned ? (
            <Button onClick={onClear} variant="ghost">
              Clear pin
            </Button>
          ) : null}
        </div>
        <p className="verify-note" role="status">
          {note}
        </p>
      </form>
    </Section>
  );
}
