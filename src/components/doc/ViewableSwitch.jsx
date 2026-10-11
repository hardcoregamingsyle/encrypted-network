import { useEffect, useState } from 'react';
import Callout from '../Callout.jsx';
import { actionErrorText } from '../actionText.js';
import { ApiError, getViewable, putSecret, putViewable } from '../../lib/api.js';

// The owner's switch: on, anyone can open and download this file without the password. Off, people can still
// check a file against it, but only people with the password can open it. password (when known) is kept on the
// server first, because that is what is handed out while the switch is on.
export default function ViewableSwitch({ docId, password }) {
  const [on, setOn] = useState(null); // null while it is being read
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    getViewable(docId).then(
      (v) => live && setOn(v.viewable === true),
      () => live && setError('Could not read the current setting. Reload the page to try again.')
    );
    return () => {
      live = false;
    };
  }, [docId]);

  async function flip() {
    if (busy || on === null) return;
    setBusy(true);
    setError('');
    try {
      if (!on && password) await putSecret(docId, password);
      await putViewable(docId, !on);
      setOn(!on);
    } catch (err) {
      setError(err instanceof ApiError ? actionErrorText(err) : err.message);
    }
    setBusy(false);
  }

  return (
    <div className="ui-stack">
      <label className="ui-check">
        <input type="checkbox" checked={on === true} disabled={on === null || busy} onChange={flip} />
        <span>
          Anyone can open this file
          <span className="ui-field__hint">
            {on
              ? 'On: anyone with the link can open and download the file. People who already opened it keep what they saw.'
              : 'Off: anyone can still check a file against this one, but only people with the password can open it.'}
          </span>
        </span>
      </label>
      {error ? (
        <Callout tone="bad" title="That did not work">
          {error}
        </Callout>
      ) : null}
    </div>
  );
}
