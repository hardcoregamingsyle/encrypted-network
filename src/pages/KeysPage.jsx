import { useState } from 'react';
import Button from '../components/Button.jsx';
import Callout from '../components/Callout.jsx';
import CopyButton from '../components/CopyButton.jsx';
import Field from '../components/Field.jsx';
import HashText from '../components/HashText.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Spinner from '../components/Spinner.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatTime, timeAgo } from '../lib/format.js';
import { useIdentity } from '../lib/identity.jsx';
import { MIN_PASSPHRASE_LENGTH, displayNameError, passphraseStrength } from '../lib/keystore.js';
import '../styles/keys.css';

const MAX_BACKUP_FILE = 64 * 1024;

// Saves text as a file through a temporary link.
function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function errorText(err) {
  return err && err.message ? err.message : 'Something went wrong. Try again.';
}

function Strength({ passphrase }) {
  const s = passphraseStrength(passphrase);
  return (
    <div className="keys-strength" data-level={s.level} aria-live="polite">
      <div className="keys-strength__bars" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <p className="keys-strength__label">
        {passphrase ? `Passphrase strength: ${s.label}` : 'Use a few random words, or a long sentence only you know.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create

function CreateForm({ onCreated, onBusyChange }) {
  const { create } = useIdentity();
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const nameError = submitted ? displayNameError(name) : '';
  const strength = passphraseStrength(pass);
  const passError = submitted && !strength.ok ? `Use at least ${MIN_PASSPHRASE_LENGTH} characters.` : '';
  const confirmError = submitted && strength.ok && confirm !== pass ? 'The two passphrases do not match.' : '';

  async function onSubmit(event) {
    event.preventDefault();
    setSubmitted(true);
    setError('');
    if (displayNameError(name) || !strength.ok || confirm !== pass) return;
    setBusy(true);
    onBusyChange(true);
    try {
      const made = await create({ displayName: name.normalize('NFC').trim(), passphrase: pass });
      setPass('');
      setConfirm('');
      onCreated(made);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <form className="ui-card ui-stack" onSubmit={onSubmit} noValidate>
      <h2 className="ui-card__title">Create your identity</h2>
      <Field
        label="Display name"
        hint="Public. People see this next to everything you sign. 1 to 40 characters."
        error={nameError}
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          maxLength={80}
          required
        />
      </Field>
      <Field
        label="Backup passphrase"
        hint={`Protects your backup file. At least ${MIN_PASSPHRASE_LENGTH} characters. It is never sent anywhere.`}
        error={passError}
      >
        <input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>
      <Strength passphrase={pass} />
      <Field label="Confirm passphrase" error={confirmError}>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>
      {error ? (
        <Callout tone="bad" title="Could not create the identity">
          {error}
        </Callout>
      ) : null}
      {busy ? (
        <p className="ui-muted" role="status">
          Creating your key and protecting the backup, this takes a moment.
        </p>
      ) : null}
      <div className="ui-row">
        <Button type="submit" variant="primary" loading={busy}>
          Create identity
        </Button>
      </div>
    </form>
  );
}

// After creation: the backup must be downloaded or skipped on purpose.
function BackupStep({ setup, onDone }) {
  const { identity } = useIdentity();
  const [downloaded, setDownloaded] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [understood, setUnderstood] = useState(false);

  function onDownload() {
    downloadText(setup.backupName, setup.backupText);
    setDownloaded(true);
  }

  return (
    <div className="ui-stack">
      <Callout tone="good" title="Your identity is ready">
        <p>This is your key id. It is the hash of your public key, and it is how others recognise your signatures.</p>
        <p className="keys-keyid">
          <HashText value={identity ? identity.keyId : ''} />
        </p>
        <CopyButton text={identity ? identity.keyId : ''} label="Copy" describe="key id" />
      </Callout>

      <section className="ui-card ui-stack" aria-labelledby="keys-backup-title">
        <h2 className="ui-card__title" id="keys-backup-title">
          Step 2: download your backup file
        </h2>
        <p>
          Your key lives only in this browser. If you lose it, for example by clearing browser data or changing
          computer, you lose this identity and cannot sign as this person again. The backup file is the only way to
          recover it. It is locked with your passphrase.
        </p>
        <div className="ui-row">
          <Button variant="primary" onClick={onDownload}>
            {downloaded ? 'Download the backup again' : 'Download your backup file'}
          </Button>
        </div>
        <p className="ui-muted" role="status">
          {downloaded ? `Saved as ${setup.backupName}. Keep it somewhere safe, and keep the passphrase apart from it.` : ''}
        </p>

        {downloaded ? (
          <div className="ui-row">
            <Button onClick={onDone}>I have saved the backup, continue</Button>
          </div>
        ) : skipping ? (
          <Callout tone="warn" title="Continue without a backup?">
            <p>
              Without a backup, losing this browser's data means losing this identity for good. Documents you published
              stay public, but you could never update or revoke them.
            </p>
            <label className="ui-check">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              <span>I understand and I want to skip the backup.</span>
            </label>
            <div className="ui-row">
              <Button variant="danger" disabled={!understood} onClick={onDone}>
                Continue without a backup
              </Button>
              <Button variant="ghost" onClick={() => setSkipping(false)}>
                Go back
              </Button>
            </div>
          </Callout>
        ) : (
          <div className="ui-row">
            <Button variant="ghost" onClick={() => setSkipping(true)}>
              Skip the backup
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Restore

function RestoreForm() {
  const { restore } = useIdentity();
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setSubmitted(true);
    setError('');
    if (!file || !pass) return;
    if (file.size > MAX_BACKUP_FILE) {
      setError('This file is too large to be a key backup.');
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      await restore(text, pass);
      toast.push({ tone: 'good', text: 'Identity restored from your backup.' });
      setPass('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ui-card ui-stack" onSubmit={onSubmit} noValidate>
      <h2 className="ui-card__title">Restore from a backup file</h2>
      <p className="ui-muted">Already have a .hrdkey backup file? Restore it here to sign as the same person again.</p>
      <Field label="Backup file (.hrdkey)" error={submitted && !file ? 'Choose your backup file.' : ''}>
        <input
          type="file"
          accept=".hrdkey,application/json,.json"
          onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
        />
      </Field>
      <Field label="Backup passphrase" error={submitted && !pass ? 'Enter the passphrase for this backup.' : ''}>
        <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
      </Field>
      {error ? (
        <Callout tone="bad" title="Could not restore">
          {error}
        </Callout>
      ) : null}
      {busy ? (
        <p className="ui-muted" role="status">
          Opening the backup, this takes a moment.
        </p>
      ) : null}
      <div className="ui-row">
        <Button type="submit" loading={busy}>
          Restore identity
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Ready

function RegistrationLine({ registration, registrationError, onRegister, busy }) {
  if (registration === 'registered') {
    return <span className="ui-badge ui-badge--good">Registered with the server</span>;
  }
  if (registration === 'checking' || registration === 'unknown') {
    return (
      <span className="ui-badge ui-badge--neutral">
        <Spinner label={null} size="sm" /> Checking with the server
      </span>
    );
  }
  return (
    <div className="ui-stack ui-stack--tight">
      <span className="ui-badge ui-badge--warn">
        {registration === 'missing' ? 'Not registered with the server yet' : 'Could not register with the server'}
      </span>
      {registrationError ? <p className="ui-muted">{registrationError}</p> : null}
      <div className="ui-row">
        <Button size="sm" loading={busy} onClick={onRegister}>
          Register now
        </Button>
      </div>
    </div>
  );
}

function FreshBackup() {
  const { exportBackup } = useIdentity();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(event) {
    event.preventDefault();
    if (!pass) {
      setError('Enter the passphrase you chose when you created this identity.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const made = await exportBackup(pass);
      downloadText(made.backupName, made.backupText);
      toast.push({ tone: 'good', text: `Backup saved as ${made.backupName}.` });
      setPass('');
      setOpen(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="ui-row">
        <Button onClick={() => setOpen(true)}>Download a fresh backup</Button>
      </div>
    );
  }
  return (
    <form className="ui-stack" onSubmit={onSubmit} noValidate>
      <Field label="Backup passphrase" hint="The passphrase you chose when you created or restored this identity." error={error}>
        <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
      </Field>
      {busy ? (
        <p className="ui-muted" role="status">
          Preparing the backup, this takes a moment.
        </p>
      ) : null}
      <div className="ui-row">
        <Button type="submit" variant="primary" loading={busy}>
          Download backup
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const FORGET_WORD = 'forget';

function ForgetIdentity() {
  const { forget } = useIdentity();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const matches = typed.trim().toLowerCase() === FORGET_WORD;

  async function onSubmit(event) {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError('');
    try {
      await forget();
      toast.push({ tone: 'info', text: 'Identity removed from this browser.' });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="ui-row">
        <Button variant="danger" onClick={() => setOpen(true)}>
          Forget this identity
        </Button>
      </div>
    );
  }
  return (
    <form className="ui-stack" onSubmit={onSubmit} noValidate>
      <Callout tone="warn" title="This cannot be undone without a backup">
        This removes your key from this browser. Without a backup file you can never sign as this person again, and you
        could not update or revoke documents you published. With a backup file you can restore it later.
      </Callout>
      <Field label={`Type "${FORGET_WORD}" to confirm`} error={error}>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck="false"
        />
      </Field>
      <div className="ui-row">
        <Button type="submit" variant="danger" disabled={!matches} loading={busy}>
          Forget this identity
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setTyped('');
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ReadyView() {
  const { identity, registration, registrationError, register } = useIdentity();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function onRegister() {
    setBusy(true);
    try {
      await register();
      toast.push({ tone: 'good', text: 'Registered with the server.' });
    } catch {
      // the error text is shown in the registration line
    } finally {
      setBusy(false);
    }
  }

  if (!identity) return null;
  return (
    <div className="ui-stack">
      <section className="ui-card ui-stack" aria-labelledby="keys-identity-title">
        <h2 className="ui-card__title" id="keys-identity-title">
          Your signing identity
        </h2>
        <dl className="ui-kv">
          <div>
            <dt>Display name</dt>
            <dd>{identity.displayName}</dd>
          </div>
          <div>
            <dt>Key id</dt>
            <dd>
              <HashText value={identity.keyId} />
              <CopyButton text={identity.keyId} label="Copy" describe="key id" />
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              {formatTime(identity.createdAt)} ({timeAgo(identity.createdAt)})
            </dd>
          </div>
          <div>
            <dt>Server registration</dt>
            <dd>
              <RegistrationLine
                registration={registration}
                registrationError={registrationError}
                onRegister={onRegister}
                busy={busy}
              />
            </dd>
          </div>
        </dl>
      </section>

      <section className="ui-card ui-stack" aria-labelledby="keys-backup-ready">
        <h2 className="ui-card__title" id="keys-backup-ready">
          Backup
        </h2>
        <p>
          A backup file is the only way to recover this identity if this browser's data is lost. It is locked with the
          passphrase you chose.
        </p>
        <FreshBackup />
      </section>

      <section className="ui-card ui-stack" aria-labelledby="keys-forget-title">
        <h2 className="ui-card__title" id="keys-forget-title">
          Forget this identity
        </h2>
        <p>
          Removes the key from this browser. To switch to a different identity, forget this one first and then restore
          or create another.
        </p>
        <ForgetIdentity />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function KeysPage() {
  const { status, error } = useIdentity();
  const [setup, setSetup] = useState(null);
  const [creating, setCreating] = useState(false);

  let body;
  if (status === 'loading') {
    body = (
      <div className="ui-center">
        <Spinner label="Loading your identity" />
      </div>
    );
  } else if (setup && status === 'ready' && !creating) {
    body = <BackupStep setup={setup} onDone={() => setSetup(null)} />;
  } else if (status === 'ready' && !creating) {
    body = <ReadyView />;
  } else {
    body = (
      <div className="ui-stack">
        {error ? (
          <Callout tone="bad" title="Could not open key storage">
            {error}
          </Callout>
        ) : null}
        <div className="keys-columns">
          <CreateForm onCreated={(made) => setSetup(made)} onBusyChange={setCreating} />
          <RestoreForm />
        </div>
      </div>
    );
  }

  return (
    <div className="ui-container">
      <PageHeader
        title="Your identity"
        lead="Your signing identity is a key pair made in this browser. Everything you publish or post is signed with it, and your key id, the hash of the public key, is how others recognise you."
        documentTitle="Identity"
      />
      {body}
    </div>
  );
}
