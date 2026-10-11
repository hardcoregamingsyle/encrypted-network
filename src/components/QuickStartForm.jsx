import { useState } from 'react';
import Button from './Button.jsx';
import Callout from './Callout.jsx';
import Field from './Field.jsx';
import { displayNameError } from '../lib/keystore.js';
import { useSession } from '../lib/session.jsx';
import { plainErrorText } from '../lib/authText.js';

export const QUICK_START_NOTE =
  'Quick start keeps everything on this device. If you clear your browser data you lose access. Sign in with email to use any device.';

// Asks for a name and starts Quick start: a key on this device, no email, no password.
// onDone runs after it worked.
export default function QuickStartForm({ onDone, submitLabel = 'Start' }) {
  const { startGuest } = useSession();
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameError = submitted ? displayNameError(name) : '';

  async function onSubmit(event) {
    event.preventDefault();
    setSubmitted(true);
    setError('');
    if (displayNameError(name)) return;
    setBusy(true);
    try {
      await startGuest(name);
      if (onDone) onDone();
    } catch (err) {
      setError(plainErrorText(err, 'Could not start. Check your connection and try again.'));
      setBusy(false);
    }
  }

  return (
    <form className="ui-stack" onSubmit={onSubmit} noValidate>
      <Field label="What should we call you?" hint="Other people see this name next to what you write and publish." error={nameError}>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" maxLength={40} />
      </Field>
      <p className="ui-muted">{QUICK_START_NOTE}</p>
      {error ? (
        <Callout tone="bad" title="Could not start">
          {error}
        </Callout>
      ) : null}
      <Button type="submit" variant="primary" loading={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}

export { QuickStartForm };
