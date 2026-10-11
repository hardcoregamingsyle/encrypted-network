import { useState } from 'react';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import Field from '../Field.jsx';
import { revokeDocument } from '../../lib/publish.js';
import { useToast } from '../Toast.jsx';
import { PROGRESS_LINES } from '../files/addLogic.js';
import { REASON_MAX } from './docLogic.js';
import { withdrawProblem } from './pageLogic.js';
import '../../styles/files.css';

function errorText(err) {
  if (err && (err.status === 409 || err.code === 'conflict')) {
    return 'This page is out of date, a newer version exists. Reload the file and try again.';
  }
  return err && err.message ? err.message : 'Something went wrong. Try again.';
}

// Owner tool: withdraw the file. It needs a short reason and a tick to confirm.
// A withdrawn file keeps its history, but no newer version can follow.
export default function RevokePanel({ docId, head, identity, onRevoked, onReload }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState('');
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);

  const problem = withdrawProblem({ reason, confirmed });

  async function submit(event) {
    event.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError('');
    setStale(false);
    setLine('Starting');
    try {
      await revokeDocument({
        docId,
        head,
        reason: reason.trim(),
        identity,
        onStep: (id) => setLine(PROGRESS_LINES[id] || 'Working')
      });
      // The Manage sheet closes once the page reloads (a withdrawn file has no owner tools), so the
      // result is announced through the toast area, which stays.
      toast.push({ tone: 'good', text: 'The file was withdrawn. Its history stays visible.' });
      if (onRevoked) await onRevoked();
    } catch (err) {
      setError(errorText(err));
      setStale(Boolean(err && (err.status === 409 || err.code === 'conflict')));
    } finally {
      setBusy(false);
      setLine('');
    }
  }

  return (
    <form className="doc-form" onSubmit={submit} noValidate>
      <Callout tone="warn" title="Withdrawing is permanent and public">
        The file page stops offering a withdrawn file and no new version can follow. The reason you write is shown to everyone who opens the link.
        The earlier versions stay in the history, and the locked copy stays on the server, so anyone who already has the password can still unlock it.
      </Callout>
      <Field label="Reason" hint={`A short reason. Up to ${REASON_MAX} characters.`}>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} maxLength={2000} />
      </Field>
      <label className="ui-check">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />
        <span>I understand this cannot be undone.</span>
      </label>
      <div className="ui-row">
        <Button type="submit" variant="danger" loading={busy} disabled={!!problem}>
          Withdraw file
        </Button>
      </div>
      {problem && !busy && (reason.trim() !== '' || confirmed) ? <p className="ui-muted">{problem}</p> : null}
      <p className="files-add__progress" role="status" aria-live="polite">
        {busy ? line : ''}
      </p>
      {error ? (
        <Callout tone="bad" title="The file was not withdrawn">
          <p>{error}</p>
          {stale && onReload ? (
            <p>
              <Button size="sm" onClick={onReload}>
                Reload the file
              </Button>
            </p>
          ) : null}
        </Callout>
      ) : null}
    </form>
  );
}
