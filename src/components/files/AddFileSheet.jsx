import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import { copyText } from '../CopyButton.jsx';
import Field from '../Field.jsx';
import Icon from '../Icon.jsx';
import Sheet from '../Sheet.jsx';
import { useToast } from '../Toast.jsx';
import useBusyAction from '../useBusyAction.js';
import DropZone from '../vault/DropZone.jsx';
import { LABEL_MAX, MAX_FILE_BYTES, documentRoute, needsRegistration, normalizeLabel } from '../vault/vaultLogic.js';
import { formatBytes } from '../../lib/format.js';
import { useSession } from '../../lib/session.jsx';
import { saveDocPassword, snapshotVaultContext } from '../../lib/vault.js';
import '../../styles/files.css';
import '../../styles/vault.css';
import { addProblem, canPublish, failureText, labelFor, storedNote } from './addLogic.js';
import { runAddFile } from './addFlow.js';
import { rowTitle } from './filesLogic.js';
import { canNativeShare, shareLink, shareToast } from './shareLogic.js';

// The sheet behind the + button: choose a file, optionally name it, tap Publish. The password is made,
// saved for the owner and kept inside the share link. It is never written on the screen.
//   open, onClose   whether the sheet is shown, and how it closes
//   onPublished     called once with { docId, label } when a file was accepted
export default function AddFileSheet({ open, onClose, onPublished }) {
  const session = useSession();
  const toast = useToast();
  const formId = useId();
  const [file, setFile] = useState(null);
  const [labelText, setLabelText] = useState('');
  const [touched, setTouched] = useState(false);
  const [listed, setListed] = useState(false);
  const [phase, setPhase] = useState('idle'); // idle | running | failed | done
  const [line, setLine] = useState('');
  const [failure, setFailure] = useState(null);
  const [done, setDone] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const [copyError, setCopyError] = useState('');
  const alive = useRef(true);
  const doneRef = useRef(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A closed sheet starts fresh the next time. (It cannot be closed while it is publishing.)
  useEffect(() => {
    if (open) return;
    setFile(null);
    setLabelText('');
    setTouched(false);
    setListed(false);
    setPhase('idle');
    setLine('');
    setFailure(null);
    setDone(null);
    setRegisterError('');
  }, [open]);

  // Closing the tab while the file is being published could lose the only copy of the password.
  useEffect(() => {
    if (phase !== 'running') return undefined;
    function warn(e) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  // The result replaces the form, so focus moves to it.
  useEffect(() => {
    if (phase === 'done' && doneRef.current) doneRef.current.focus();
  }, [phase]);

  const identity = session.identity;
  const running = phase === 'running';
  const fileName = file ? file.name : '';
  // The box shows exactly what will be published: a long file name is cut to the label limit, not silently later.
  const shownLabel = touched ? labelText : normalizeLabel(fileName);
  const label = labelFor({ labelText, touched, fileName });
  const problem = file ? addProblem({ file, label }) : '';
  const fileError = problem && !/label/i.test(problem) ? problem : '';
  const labelError = problem && /label/i.test(problem) ? problem : '';
  const ready = canPublish({ file, label, running }) && Boolean(identity);

  function chooseFile(next) {
    setFailure(null);
    setPhase('idle');
    setFile(next);
  }

  function clearFile() {
    setFile(null);
    setFailure(null);
    setPhase('idle');
  }

  async function submit(e) {
    e.preventDefault();
    if (!ready) return;
    setFailure(null);
    setRegisterError('');
    setPhase('running');
    setLine('Starting');
    // Who is signed in is fixed now. If they sign out while the publish runs, the password still goes to
    // them and never to whoever starts on this browser next.
    const vaultContext = snapshotVaultContext();
    const out = await runAddFile({
      file,
      label,
      listed,
      identity,
      save: (docId, password) => saveDocPassword(docId, password, vaultContext),
      copy: copyText,
      onLine: (text) => {
        if (alive.current) setLine(text);
      }
    });
    if (!out.ok) {
      if (!alive.current) return;
      setFailure(out);
      setPhase('failed');
      setLine('');
      return;
    }
    if (typeof onPublished === 'function') onPublished({ docId: out.result.docId, label });
    if (!alive.current) return;
    setCopyError('');
    setDone({ docId: out.result.docId, link: out.link, label, stored: out.stored, copied: out.copied });
    setPhase('done');
    setLine('');
  }

  async function registerKey() {
    setRegistering(true);
    setRegisterError('');
    try {
      await session.registerAgain();
      if (alive.current) {
        setFailure(null);
        setPhase('idle');
      }
    } catch (err) {
      if (alive.current) setRegisterError(err && err.message ? err.message : 'Could not register your key.');
    } finally {
      if (alive.current) setRegistering(false);
    }
  }

  const [copyLink, copying] = useBusyAction(copyLinkNow, { holdMs: 600 });
  const [share, sharing] = useBusyAction(shareNow, { holdMs: 600 });

  async function copyLinkNow() {
    const ok = await copyText(done.link);
    if (ok) {
      setCopyError('');
      toast.push({ tone: 'good', text: 'Link copied.' });
    } else {
      // The link is not shown anywhere on screen, so this must stay until the person tries again.
      setCopyError('Could not copy the link. Try Copy link again, or use Share or Open.');
    }
  }

  async function shareNow() {
    const outcome = await shareLink({ link: done.link, title: rowTitle({ label: done.label }) }, { copy: copyText });
    const note = shareToast(outcome, { withPassword: true });
    if (note) toast.push(note);
  }

  const showingDone = phase === 'done' && done;
  const note = showingDone ? storedNote(done.stored) : null;

  const footer = showingDone ? (
    <Button variant="primary" onClick={onClose}>
      Done
    </Button>
  ) : (
    <>
      <Button onClick={onClose} disabled={running}>
        Cancel
      </Button>
      <Button type="submit" form={formId} variant="primary" loading={running} disabled={!ready && !running}>
        <Icon name="upload" size={16} /> {failure ? 'Try again' : 'Publish'}
      </Button>
    </>
  );

  return (
    <Sheet open={open} onClose={onClose} title={showingDone ? 'Published.' : 'Add a file'} dismissible={!running} footer={footer}>
      {showingDone ? (
        <div className="files-done">
          <div className="files-done__lead" ref={doneRef} tabIndex={-1} role="status">
            <span className="files-done__tick" aria-hidden="true">
              <Icon name="check" size={26} />
            </span>
            <p className="files-done__text">
              <strong>{rowTitle({ label: done.label })}</strong> is published.
              {done.copied ? ' The link is copied.' : ' Copy the link to share it.'}
            </p>
          </div>
          <Callout tone={note.tone} title="Your password">
            {note.text}
          </Callout>
          {copyError ? (
            <Callout tone="bad" title="Could not copy the link">
              {copyError}
            </Callout>
          ) : null}
          <div className="files-done__actions">
            <Button onClick={copyLink} pending={copying}>
              <Icon name="copy" size={18} /> Copy link
            </Button>
            {canNativeShare() ? (
              <Button onClick={share} pending={sharing}>
                <Icon name="share" size={18} /> Share
              </Button>
            ) : null}
            <Link className="ui-btn ui-btn--primary" to={documentRoute(done.docId, done.link)} onClick={onClose}>
              <span className="ui-btn__label">Open</span>
            </Link>
          </div>
        </div>
      ) : (
        <form id={formId} className="files-add" onSubmit={submit} noValidate>
          <fieldset className="files-add__set" disabled={running}>
            <legend className="ui-sr-only">File and options</legend>
            <DropZone
              file={file}
              onFile={chooseFile}
              onClear={clearFile}
              disabled={running}
              error={fileError}
              limitText={`Up to ${formatBytes(MAX_FILE_BYTES)}. It is locked on this device before it is sent.`}
            />
            <Field label="Label (optional)" hint="Anyone with the link can see the label. The file itself stays locked." error={labelError}>
              <input
                type="text"
                value={shownLabel}
                maxLength={LABEL_MAX}
                placeholder="For example: Land record 2026-114"
                autoComplete="off"
                onChange={(e) => {
                  setLabelText(e.target.value);
                  setTouched(true);
                }}
              />
            </Field>
            <label className="ui-check">
              <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} />
              <span>
                Make it public
                <span className="ui-field__hint files-add__hint">Off: not shown in the Public list, but still in the public record that anyone can read. On: it also shows in the Public list.</span>
              </span>
            </label>
          </fieldset>
          <p className="files-add__progress" role="status" aria-live="polite">
            {running ? line : ''}
          </p>
          {failure ? (
            <Callout tone="bad" title="Publishing did not finish">
              <p>{failureText(failure)}</p>
              {needsRegistration(failure.error) ? (
                <p>
                  <Button size="sm" onClick={registerKey} loading={registering}>
                    Register my key
                  </Button>
                </p>
              ) : null}
              {registerError ? <p>{registerError}</p> : null}
            </Callout>
          ) : null}
        </form>
      )}
    </Sheet>
  );
}
