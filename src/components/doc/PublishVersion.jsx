import { useState } from 'react';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import CopyButton from '../CopyButton.jsx';
import Field from '../Field.jsx';
import { generatePassword } from '../../lib/lockfile.js';
import { fullLink } from '../../lib/links.js';
import { publishNewVersion } from '../../lib/publish.js';
import ProgressList from './ProgressList.jsx';
import { LABEL_MAX, passwordFileText, versionLabel, versionProblem } from './docLogic.js';
import { saveFile } from './saveFile.js';
import { useSteps } from './useSteps.js';

function errorText(err) {
  if (err && (err.status === 409 || err.code === 'conflict')) {
    return 'Someone else published a newer version, or this page is out of date. Reload to see the latest version, then try again.';
  }
  return err && err.message ? err.message : 'Something went wrong. Try again.';
}

function isConflict(err) {
  return Boolean(err && (err.status === 409 || err.code === 'conflict'));
}

// Owner tool: lock a new file and publish it as the next version.
// unlockedWith is the document password once an unlock has been confirmed, else ''.
// previousLabel is the label of the current latest version. An empty label keeps it, the file name is
// never used as a label because the label is public and the file name is private.
export default function PublishVersion({ docId, head, identity, unlockedWith, onPublished, previousLabel = '', onReload }) {
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0);
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState('reuse');
  const [fresh, setFresh] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [done, setDone] = useState(null);
  const [steps, onStep, resetSteps] = useSteps();

  const problem = versionProblem({
    file,
    label,
    mode,
    reusePassword: unlockedWith,
    freshSaved: saved && fresh !== ''
  });

  function chooseMode(next) {
    setMode(next);
    setSaved(false);
    resetSteps();
    if (next === 'fresh' && fresh === '') setFresh(generatePassword());
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || problem) return;
    const password = mode === 'fresh' ? fresh : unlockedWith;
    setBusy(true);
    setError('');
    setConflict(false);
    setDone(null);
    resetSteps();
    try {
      const out = await publishNewVersion({
        docId,
        head,
        file,
        label: versionLabel(label, previousLabel),
        identity,
        password,
        onStep
      });
      setDone({ version: out.version, password, fresh: mode === 'fresh', link: fullLink(docId, password) });
      setFile(null);
      setFileKey((k) => k + 1);
      setLabel('');
      setFresh('');
      setSaved(false);
      setMode('reuse');
      if (onPublished) await onPublished(password);
    } catch (err) {
      setError(errorText(err));
      setConflict(isConflict(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ui-card doc-card" aria-labelledby="doc-publish-title">
      <h2 className="ui-card__title" id="doc-publish-title">
        Publish a new version
      </h2>
      <p className="ui-muted">
        The new file is locked in this browser and signed with your key. Older versions stay in the history. Anyone who
        checks the document afterwards sees this version as the latest.
      </p>

      <form className="ui-stack" onSubmit={submit} noValidate>
        <Field label="New file" hint="Up to 50 MiB.">
          <input
            key={fileKey}
            type="file"
            onChange={(e) => {
              setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null);
              resetSteps();
              setError('');
              setConflict(false);
            }}
            disabled={busy}
          />
        </Field>
        <Field label="Label" hint={`Public. Optional, up to ${LABEL_MAX} characters. Leave empty to keep the current label. The file name is never used as a label.`}>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={400} disabled={busy} autoComplete="off" />
        </Field>

        <fieldset className="doc-fieldset" disabled={busy}>
          <legend>Password for the new version</legend>
          <label className="ui-check">
            <input type="radio" name="doc-pw-mode" checked={mode === 'reuse'} onChange={() => chooseMode('reuse')} />
            <span>
              Keep the current document password
              <span className="doc-option-hint">The same share link keeps working.</span>
            </span>
          </label>
          {mode === 'reuse' && !unlockedWith ? (
            <p className="doc-hint">Unlock the file above first. That confirms the password before it is reused.</p>
          ) : null}
          <label className="ui-check">
            <input type="radio" name="doc-pw-mode" checked={mode === 'fresh'} onChange={() => chooseMode('fresh')} />
            <span>
              Use a new password
              <span className="doc-option-hint">Old links with the old password will not open the new file.</span>
            </span>
          </label>
        </fieldset>

        {mode === 'fresh' && fresh ? (
          <div className="doc-secret">
            <p className="doc-secret__title">New password. It is shown only here, save it now.</p>
            <p className="doc-secret__value" data-testid="doc-fresh-password">
              {fresh}
            </p>
            <div className="ui-row">
              <CopyButton text={fresh} label="Copy" describe="new password" />
              <Button size="sm" onClick={() => saveFile('hrdlock-password.txt', passwordFileText(docId, fresh), 'text/plain')}>
                Save as text file
              </Button>
            </div>
            <label className="ui-check">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              <span>I saved this password. I know it cannot be shown again.</span>
            </label>
          </div>
        ) : null}

        <div className="ui-row">
          <Button type="submit" variant="primary" loading={busy} disabled={!!problem}>
            {head ? `Lock and publish version ${head.version + 1}` : 'Lock and publish'}
          </Button>
        </div>
        {problem && !busy ? <p className="ui-muted">{problem}</p> : null}
        <ProgressList steps={steps} busy={busy} label="Publish progress" />
        {error ? (
          <Callout tone="bad" title="The new version was not published">
            <p>{error}</p>
            {conflict && onReload ? (
              <p>
                <Button size="sm" onClick={onReload}>
                  Reload the document
                </Button>
              </p>
            ) : null}
          </Callout>
        ) : null}
      </form>

      {done ? (
        <Callout tone="good" title={`Version ${done.version} is published`}>
          <p>The history below is refreshed.{done.fresh ? ' The document now uses the new password.' : ''}</p>
          <p className="doc-linkline">
            Full link: <span className="ui-hash ui-hash--full">{done.link}</span> <CopyButton text={done.link} label="Copy" describe="full link" />
          </p>
        </Callout>
      ) : null}
    </section>
  );
}
