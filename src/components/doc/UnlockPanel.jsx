import { useState } from 'react';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import Field from '../Field.jsx';
import Icon from '../Icon.jsx';
import { formatBytes } from '../../lib/format.js';
import useBusyAction from '../useBusyAction.js';
import ProgressList from './ProgressList.jsx';
import { hasPassword, safeFileName, tidyPassword, unlockSteps } from './docLogic.js';
import { saveFile } from './saveFile.js';

const MARKS = { ok: 'check', bad: 'x', todo: 'info', skip: 'info' };
const STATE_WORDS = { ok: 'passed', bad: 'failed', todo: 'not checked yet', skip: 'not checked' };

// Password box, the step checklist and the download button for the decrypted file.
export default function UnlockPanel({ result, verified, revoked, password, onPassword, onUnlock, busy, steps, error }) {
  const [show, setShow] = useState(false);
  const rows = unlockSteps(result, { revoked });
  const file = result && result.file ? result.file : null;

  function onPaste(event) {
    const text = event.clipboardData && event.clipboardData.getData('text');
    if (typeof text !== 'string' || text === '') return;
    event.preventDefault();
    onPassword(tidyPassword(text));
  }

  function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    // A full link typed or filled in by the browser is reduced to its password here, not only on paste.
    const clean = tidyPassword(password);
    if (clean !== password) onPassword(clean);
    onUnlock(clean);
  }

  // A double click saves the file once.
  const [download, downloading] = useBusyAction(
    () => {
      if (file) saveFile(safeFileName(file.name), file.data);
    },
    { holdMs: 1200 }
  );

  return (
    <section className="ui-card doc-card" aria-labelledby="doc-unlock-title">
      <h2 className="ui-card__title" id="doc-unlock-title">
        Unlock and verify the file
      </h2>
      <p className="ui-muted">
        The file is stored locked. Your password stays in this browser: the file is unlocked here and the password is
        never sent to the server.
      </p>

      {revoked ? (
        <Callout tone="warn" title="This document was revoked">
          There is no current file to unlock. The version history below stays visible.
        </Callout>
      ) : (
        <form className="ui-stack" onSubmit={onSubmit} noValidate>
          <Field label="Document password" hint="Paste the password or the full link. Dashes, spaces and capitals do not matter.">
            <input
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => onPassword(e.target.value)}
              onPaste={onPaste}
              onBlur={() => hasPassword(password) && onPassword(tidyPassword(password))}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="doc-password"
            />
          </Field>
          <label className="ui-check">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            <span>Show the password</span>
          </label>
          <div className="ui-row">
            <Button type="submit" variant="primary" loading={busy} disabled={!hasPassword(password)}>
              Unlock and verify
            </Button>
          </div>
          <ProgressList steps={steps} busy={busy} label="Unlock progress" />
          {error ? (
            <Callout tone="bad" title="Could not check the file">
              {error}
            </Callout>
          ) : null}
        </form>
      )}

      <ul className="doc-steplist" aria-label="File checks">
        {rows.map((row) => (
          <li key={row.id} className={`doc-steplist__item is-${row.state}`}>
            <span className="doc-steplist__mark">
              <Icon name={MARKS[row.state]} />
            </span>
            <div>
              <p className="doc-steplist__name">
                {row.label}
                <span className="ui-sr-only">: {STATE_WORDS[row.state]}</span>
              </p>
              {row.detail ? <p className="doc-steplist__detail">{row.detail}</p> : null}
            </div>
          </li>
        ))}
      </ul>

      {file ? (
        <div className="doc-download">
          {!verified ? (
            <Callout tone="warn" title="The document record did not pass verification">
              The file matches the record the server sent, but that record is not confirmed. Do not treat this as the latest
              signed version.
            </Callout>
          ) : (
            <Callout tone="good" title="File checked">
              The file matches the signed hash and commitment of the latest version. The name below was stored inside the
              lock.
            </Callout>
          )}
          <div className="ui-row">
            <Button variant={verified ? 'primary' : 'ghost'} onClick={download} pending={downloading}>
              <Icon name="download" size={18} />{' '}
              {verified ? `Download ${safeFileName(file.name)}` : `Download anyway, not verified: ${safeFileName(file.name)}`}
            </Button>
            <span className="ui-muted">{formatBytes(file.data.length)}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
