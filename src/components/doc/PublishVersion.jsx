import { useState } from 'react';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import Field from '../Field.jsx';
import Icon from '../Icon.jsx';
import DropZone from '../vault/DropZone.jsx';
import { PROGRESS_LINES } from '../files/addLogic.js';
import { generatePassword } from '../../lib/lockfile.js';
import { publishNewVersion } from '../../lib/publish.js';
import { saveDocPassword, snapshotVaultContext } from '../../lib/vault.js';
import '../../styles/files.css';
import '../../styles/vault.css';
import { LABEL_MAX, hasPassword, tidyPassword, versionLabel } from './docLogic.js';
import { passwordFromInput, updateProblem } from './pageLogic.js';

function errorText(err) {
  if (err && (err.status === 409 || err.code === 'conflict')) {
    return 'Someone else published a newer version, or this page is out of date. Reload to see the latest version, then try again.';
  }
  return err && err.message ? err.message : 'Something went wrong. Try again.';
}

function isConflict(err) {
  return Boolean(err && (err.status === 409 || err.code === 'conflict'));
}

// Owner tool: lock a new file and publish it as the next version, with the same password as before.
//   password        the file password when it is known (from the vault or the link), else ''
//   previousLabel   the label of the current version. An empty label keeps it. The file name is never
//                   used as a label, because the label is public and the file name is private.
//   onPublished(pw, info) called after the new version was accepted, with the password that locks it and
//                   { version, fresh, stored } (stored is 'none' when the password could not be saved)
export default function PublishVersion({ docId, head, identity, password = '', onPublished, previousLabel = '', onReload }) {
  const known = passwordFromInput(password);
  const [file, setFile] = useState(null);
  const [label, setLabel] = useState('');
  const [typed, setTyped] = useState('');
  const [fresh, setFresh] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [done, setDone] = useState(null);

  const secret = known || (fresh ? fresh : passwordFromInput(typed));
  const problem = updateProblem({ file, password: secret });

  function chooseFile(next) {
    setFile(next);
    setError('');
    setConflict(false);
    setDone(null);
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || problem) return;
    setBusy(true);
    setError('');
    setConflict(false);
    setDone(null);
    setLine('Starting');
    const vaultContext = snapshotVaultContext();
    try {
      const out = await publishNewVersion({
        docId,
        head,
        file,
        label: versionLabel(label, previousLabel),
        identity,
        password: secret,
        onStep: (id) => setLine(PROGRESS_LINES[id] || (id === 'done' ? 'Published' : 'Working'))
      });
      // Keep the password for the owner. A failure here is reported, the link still carries it.
      const stored = known ? 'kept' : await saveDocPassword(docId, secret, vaultContext);
      setDone({ version: out.version, fresh: !known && fresh !== '', stored });
      setFile(null);
      setLabel('');
      setTyped('');
      setFresh('');
      if (onPublished) await onPublished(secret, { version: out.version, fresh: !known && fresh !== '', stored });
    } catch (err) {
      setError(errorText(err));
      setConflict(isConflict(err));
    } finally {
      setBusy(false);
      setLine('');
    }
  }

  return (
    <form className="doc-form" onSubmit={submit} noValidate>
      <p className="ui-muted">
        The new file is locked on this device and signed with your key. Older versions stay in the history, and the same link keeps working.
      </p>
      <DropZone file={file} onFile={chooseFile} onClear={() => chooseFile(null)} disabled={busy} limitText="Up to 20 MiB. It is locked on this device before it is sent." />
      <Field label="Label (optional)" hint={`Leave empty to keep the current label. Up to ${LABEL_MAX} characters, public.`}>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={400} disabled={busy} autoComplete="off" />
      </Field>

      {!known ? (
        <div className="doc-form__key">
          {fresh ? (
            <Callout tone="warn" title="A new password will be used">
              <p>It is made for you and saved with your account or on this device. Links shared before this version will not open the new file.</p>
              <p>
                <Button size="sm" onClick={() => setFresh('')} disabled={busy}>
                  Use the old password instead
                </Button>
              </p>
            </Callout>
          ) : (
            <>
              <Field label="File password" hint="We could not find the password for this file. Enter it, or paste the full link.">
                <input
                  type="password"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onBlur={() => hasPassword(typed) && setTyped(tidyPassword(typed))}
                  disabled={busy}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </Field>
              <Button size="sm" variant="ghost" onClick={() => setFresh(generatePassword())} disabled={busy}>
                Use a new password instead
              </Button>
            </>
          )}
        </div>
      ) : null}

      <div className="ui-row">
        <Button type="submit" variant="primary" loading={busy} disabled={!!problem}>
          <Icon name="upload" size={16} /> {head ? `Publish version ${head.version + 1}` : 'Publish'}
        </Button>
      </div>
      {problem && !busy && file ? <p className="ui-muted">{problem}</p> : null}
      <p className="files-add__progress" role="status" aria-live="polite">
        {busy ? line : ''}
      </p>
      {error ? (
        <Callout tone="bad" title="The new version was not published">
          <p>{error}</p>
          {conflict && onReload ? (
            <p>
              <Button size="sm" onClick={onReload}>
                Reload the file
              </Button>
            </p>
          ) : null}
        </Callout>
      ) : null}
      {done ? (
        <Callout tone={done.stored === 'none' ? 'warn' : 'good'} title={`Version ${done.version} is published`}>
          <p>The history is refreshed.{done.fresh ? ' The file now uses the new password.' : ''}</p>
          {done.stored === 'none' ? <p>The password could not be saved here. Copy the link from Share now: it is the only copy.</p> : null}
        </Callout>
      ) : null}
    </form>
  );
}
