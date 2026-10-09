import { useState } from 'react';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import Field from '../Field.jsx';
import { revokeDocument } from '../../lib/publish.js';
import ProgressList from './ProgressList.jsx';
import { REASON_MAX, REVOKE_WORD, revokeProblem } from './docLogic.js';
import { useSteps } from './useSteps.js';

function errorText(err) {
  return err && err.message ? err.message : 'Something went wrong. Try again.';
}

// Owner tool: end the document for good.
export default function RevokePanel({ docId, head, identity, onRevoked }) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [steps, onStep, resetSteps] = useSteps();

  const problem = revokeProblem({ reason, typed });

  async function submit(event) {
    event.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError('');
    resetSteps();
    try {
      await revokeDocument({ docId, head, reason: reason.trim(), identity, onStep });
      if (onRevoked) await onRevoked();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ui-card doc-card doc-card--danger" aria-labelledby="doc-revoke-title">
      <h2 className="ui-card__title" id="doc-revoke-title">
        Revoke this document
      </h2>
      <Callout tone="warn" title="Revoking is permanent and public">
        A revoke is a signed entry that ends the document. It cannot be undone and no new version can follow it. The
        reason you write is shown to everyone who opens this document. Older versions stay visible in the history.
      </Callout>
      <form className="ui-stack" onSubmit={submit} noValidate>
        <Field label="Reason" hint={`Shown publicly. Up to ${REASON_MAX} characters.`}>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} maxLength={2000} />
        </Field>
        <Field label={`Type ${REVOKE_WORD} to confirm`}>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </Field>
        <div className="ui-row">
          <Button type="submit" variant="danger" loading={busy} disabled={!!problem}>
            Revoke this document
          </Button>
        </div>
        {problem && !busy ? <p className="ui-muted">{problem}</p> : null}
        <ProgressList steps={steps} busy={busy} label="Revoke progress" />
        {error ? (
          <Callout tone="bad" title="The document was not revoked">
            {error}
          </Callout>
        ) : null}
      </form>
    </section>
  );
}
