import { useEffect, useState } from 'react';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import HashText from '../HashText.jsx';
import Spinner from '../Spinner.jsx';
import { classifyServerKey, currentServerKeyId, forgetRememberedServerKey, getRememberedServerKeyId } from '../../lib/pin.js';
import Section from './Section.jsx';

// The key this browser remembered from its first visit. A key you pinned yourself always wins over it.
export default function RememberedSection({ pinned = '' }) {
  const [remembered, setRemembered] = useState(() => getRememberedServerKeyId());
  const [current, setCurrent] = useState({ status: 'loading', id: '' });
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    currentServerKeyId().then((id) => {
      if (alive) setCurrent({ status: id ? 'ready' : 'unknown', id });
    });
    return () => {
      alive = false;
    };
  }, []);

  const state = remembered ? classifyServerKey({ remembered, current: current.id }) : 'none';

  function onForget() {
    const gone = forgetRememberedServerKey();
    if (gone) setRemembered('');
    setNote(
      gone
        ? 'Forgotten. The next check on this site remembers the key it sees then.'
        : 'Your browser blocked storage, so nothing could be changed.'
    );
  }

  return (
    <Section
      id="verify-remembered"
      title="Remembered server key"
      intro="The first time you check something here, this browser remembers the server key and warns you loudly if it ever changes."
    >
      {pinned ? (
        <Callout tone="info" title="You pinned a key">
          The key you pinned above is used instead of the remembered one.
        </Callout>
      ) : null}
      {remembered ? (
        <p className="verify-keyline">
          Remembered key id: <HashText value={remembered} />
        </p>
      ) : (
        <p className="ui-muted">Nothing is remembered yet. The next check on this site remembers the key it sees.</p>
      )}
      <div aria-live="polite">
        {remembered && current.status === 'loading' ? (
          <p className="verify-loading">
            <Spinner label={null} size="sm" /> Comparing with the key this site uses now
          </p>
        ) : null}
        {state === 'remembered-mismatch' && current.status === 'ready' ? (
          <div className="verify-alarm">
            <Callout tone="bad" title="STOP: this server is not using the key this browser remembered">
              <p>
                This browser remembered <HashText value={remembered} />, but this site signs with <HashText value={current.id} />.
              </p>
              <p>
                Do not rely on any answer from this site until you know why. The key may have been changed on purpose, or
                this may not be the site you used before. If you are sure the change is expected, forget the remembered key
                below.
              </p>
            </Callout>
          </div>
        ) : null}
        {state === 'remembered-match' ? (
          <Callout tone="good" title="Same key as before">
            The key this site signs with now is the one this browser remembered.
          </Callout>
        ) : null}
        {remembered && current.status === 'unknown' ? (
          <Callout tone="warn" title="The server key could not be loaded">
            Try again later to compare it with the remembered key.
          </Callout>
        ) : null}
      </div>
      {remembered ? (
        <div className="ui-row">
          <Button onClick={onForget}>Forget the remembered key</Button>
        </div>
      ) : null}
      <p className="verify-note" role="status">
        {note}
      </p>
    </Section>
  );
}
