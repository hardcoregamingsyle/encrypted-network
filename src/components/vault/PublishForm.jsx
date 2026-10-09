import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import Field from '../Field.jsx';
import Icon from '../Icon.jsx';
import { formatBytes } from '../../lib/format.js';
import DropZone from './DropZone.jsx';
import ProgressList from './ProgressList.jsx';
import PublishResult from './PublishResult.jsx';
import { runPublish } from './publishFlow.js';
import {
  LABEL_MAX,
  MAX_FILE_BYTES,
  createSteps,
  effectiveLabel,
  fileProblem,
  labelProblem,
  needsRegistration,
  suggestedLabel
} from './vaultLogic.js';

function Intro() {
  return (
    <div className="vault-note">
      <p>
        <strong>What happens.</strong> The file is locked in this browser with a new random password before anything is
        sent. The server only ever receives the locked file. Your key then signs a record that says which locked file
        belongs to this document.
      </p>
      <ul className="ui-list">
        <li>
          <strong>Public:</strong> the label you choose, the size and hash of the locked file, your name and key id, the
          time, and the document id. Anyone who has the document id or link can see these.
        </li>
        <li>
          <strong>Not public:</strong> the contents of the file and its file name. The file name is stored inside the
          locked file, never in the record.
        </li>
        <li>
          <strong>Public list:</strong> only if you tick the box below does the document also appear in the public list
          and in search.
        </li>
      </ul>
    </div>
  );
}

function SignedOut({ status }) {
  if (status === 'loading') {
    return (
      <section className="ui-card vault-publish" aria-busy="true" aria-label="Lock and publish a file">
        <div className="vault-skel vault-skel--title" />
        <div className="vault-skel vault-skel--block" />
      </section>
    );
  }
  return (
    <section className="ui-card vault-publish" aria-labelledby="vault-publish-title">
      <h2 className="ui-card__title" id="vault-publish-title">
        Lock and publish a file
      </h2>
      <Callout tone="info" title="You need an identity first">
        <p>
          Documents are signed with your own key, so the signature shows it was you. Making a key takes a minute and
          stays on this device.
        </p>
        <p>
          <Link className="ui-btn ui-btn--primary" to="/keys">
            Create or restore your identity
          </Link>
        </p>
      </Callout>
    </section>
  );
}

// onPublished() runs after a document was accepted, so lists can refresh.
export default function PublishForm({ status, identity, registration = 'unknown', onRegister, onPublished }) {
  const [file, setFile] = useState(null);
  const [labelText, setLabelText] = useState('');
  const [labelTouched, setLabelTouched] = useState(false);
  const [hideName, setHideName] = useState(false);
  const [listed, setListed] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [steps, setSteps] = useState(createSteps());
  const [detail, setDetail] = useState('');
  const [failure, setFailure] = useState(null);
  const [result, setResult] = useState(null);
  const [meta, setMeta] = useState({});
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Closing the tab in the middle of a publish loses the password, so ask first.
  useEffect(() => {
    if (phase !== 'running') return undefined;
    function warn(e) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  if (status !== 'ready' || !identity) return <SignedOut status={status} />;

  const running = phase === 'running';
  const fileName = file ? file.name : '';
  const shownLabel = labelTouched ? labelText : suggestedLabel({ fileName, hideName });
  const publicLabel = effectiveLabel({ labelText: shownLabel, fileName, hideName });
  const fileError = file ? fileProblem(file) : '';
  const labelError = labelProblem(publicLabel);
  const canPublish = !!file && !fileError && !labelError && !running;

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
    if (!canPublish) return;
    setFailure(null);
    setRegisterError('');
    setPhase('running');
    setSteps(createSteps());
    setDetail('');
    const label = publicLabel;
    const out = await runPublish({
      file,
      label,
      listed,
      identity,
      onUpdate: (s, text) => {
        if (!alive.current) return;
        setSteps(s);
        setDetail(text);
      }
    });
    if (!alive.current) return;
    setSteps(out.steps);
    if (out.ok) {
      setResult(out.result);
      setMeta({ label, createdAt: Date.now() });
      setPhase('idle');
      setFile(null);
      setLabelText('');
      setLabelTouched(false);
      setListed(false);
      setDetail('');
      if (typeof onPublished === 'function') onPublished(out.result);
    } else {
      setFailure(out);
      setPhase('failed');
      setDetail('');
    }
  }

  async function registerKey() {
    if (typeof onRegister !== 'function') return;
    setRegistering(true);
    setRegisterError('');
    try {
      await onRegister();
      if (alive.current) {
        setFailure(null);
        setPhase('idle');
      }
    } catch (err) {
      if (alive.current) setRegisterError(err && err.message ? err.message : 'Could not register the key.');
    } finally {
      if (alive.current) setRegistering(false);
    }
  }

  const registrationWarn = registration === 'missing' || registration === 'error';

  return (
    <div className="vault-publish-wrap">
      {result ? <PublishResult result={result} meta={meta} onDismiss={() => {
          setResult(null);
          setListed(false);
        }} /> : null}

      <section className="ui-card vault-publish" aria-labelledby="vault-publish-title">
        <h2 className="ui-card__title" id="vault-publish-title">
          Lock and publish a file
        </h2>
        <Intro />

        {registrationWarn ? (
          <Callout tone="warn" title="The server may not know your key yet">
            <p>Publishing needs the server to know your key. You can register it now.</p>
            <p>
              <Button size="sm" onClick={registerKey} loading={registering}>
                Register my key
              </Button>
            </p>
          </Callout>
        ) : null}

        <form className="vault-form" onSubmit={submit} noValidate>
          <fieldset className="vault-form__set" disabled={running}>
            <legend className="ui-sr-only">File and options</legend>

            <DropZone
              file={file}
              onFile={chooseFile}
              onClear={clearFile}
              disabled={running}
              error={fileError}
              limitText={`Up to ${formatBytes(MAX_FILE_BYTES)}. It is locked here, in your browser.`}
            />

            <Field
              label="Public label"
              hint={`Shown to everyone who sees this document. Up to ${LABEL_MAX} characters. It can be left empty.`}
              error={labelError}
            >
              <input
                type="text"
                value={shownLabel}
                maxLength={LABEL_MAX}
                placeholder={hideName ? 'No public label' : 'For example: Land record 2026-114'}
                autoComplete="off"
                onChange={(e) => {
                  setLabelText(e.target.value);
                  setLabelTouched(true);
                }}
              />
            </Field>

            <div className="vault-checks">
              <label className="ui-check">
                <input type="checkbox" checked={hideName} onChange={(e) => setHideName(e.target.checked)} />
                <span>
                  Do not use the file name in the public label
                  <span className="ui-field__hint vault-checks__hint">
                    The label then starts empty. The file name is inside the locked file either way.
                  </span>
                </span>
              </label>
              <label className="ui-check">
                <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} />
                <span>
                  Show in the public list
                  <span className="ui-field__hint vault-checks__hint">
                    Off by default. Unlisted only hides it from the list. The signed ledger is public, so its id, label and file hash can still be seen by anyone who reads the ledger.
                  </span>
                </span>
              </label>
            </div>

            <div className="vault-actions">
              <Button type="submit" variant="primary" loading={running} disabled={!canPublish && !running}>
                <Icon name="lock" size={16} /> {running ? 'Publishing' : failure ? 'Try again' : 'Lock and publish'}
              </Button>
              {!file ? <span className="ui-muted">Choose a file to continue.</span> : null}
            </div>
          </fieldset>
        </form>

        {phase === 'running' || phase === 'failed' ? <ProgressList steps={steps} detail={detail} /> : null}

        {failure ? (
          <Callout tone="bad" title="Publishing did not finish">
            <p>{failure.message}</p>
            <p>{failure.hint}</p>
            {needsRegistration(failure.error) ? (
              <p>
                <Button size="sm" onClick={registerKey} loading={registering}>
                  Register my key
                </Button>
              </p>
            ) : null}
            {registerError ? <p>{registerError}</p> : null}
            <p className="ui-muted">Use the Try again button above when you are ready.</p>
          </Callout>
        ) : null}
      </section>
    </div>
  );
}
