import { useRef, useState } from 'react';
import Button from '../components/Button.jsx';
import Callout from '../components/Callout.jsx';
import CopyButton from '../components/CopyButton.jsx';
import Field from '../components/Field.jsx';
import HashText from '../components/HashText.jsx';
import ScreenHeader from '../components/ScreenHeader.jsx';
import Spinner from '../components/Spinner.jsx';
import { useToast } from '../components/Toast.jsx';
import { downloadTextFile } from '../lib/download.js';
import { formatTime, timeAgo } from '../lib/format.js';
import { useToggleFocus } from '../lib/focus.js';
import { useSession } from '../lib/session.jsx';
import '../styles/keys.css';

const MAX_BACKUP_FILE = 64 * 1024;

function errorText(err) {
  return err && err.message ? err.message : 'Something went wrong. Try again.';
}

// ---------------------------------------------------------------------------
// Backup file (only for an identity that was made with a passphrase, or restored from a backup)

function FreshBackup() {
  const { exportBackup } = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const passRef = useRef(null);
  const openRef = useRef(null);
  useToggleFocus(open, passRef, openRef);

  async function onSubmit(event) {
    event.preventDefault();
    if (!pass) {
      setError('Enter the passphrase you chose when you made this backup.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const made = await exportBackup(pass);
      downloadTextFile(made.backupName, made.backupText, 'application/json');
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
        <Button ref={openRef} onClick={() => setOpen(true)}>
          Download a fresh backup
        </Button>
      </div>
    );
  }
  return (
    <form className="ui-stack" onSubmit={onSubmit} noValidate>
      <Field label="Backup passphrase" hint="The passphrase of this identity's backup file." error={error}>
        <input ref={passRef} type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
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

function RestoreForm() {
  const { restoreBackup } = useSession();
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
      await restoreBackup(text, pass);
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
      <p className="ui-muted">
        Earlier versions of hrdlock made a .hrdkey backup file. If you have one, restore it here to sign as the same person
        again on this device.
      </p>
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
// Forget (Quick start identities only)

const FORGET_WORD = 'forget';

function ForgetIdentity() {
  const { forgetDevice } = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const typedRef = useRef(null);
  const openRef = useRef(null);
  useToggleFocus(open, typedRef, openRef);
  const matches = typed.trim().toLowerCase() === FORGET_WORD;

  async function onSubmit(event) {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError('');
    try {
      await forgetDevice();
      toast.push({ tone: 'info', text: 'Identity removed from this browser.' });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="ui-row">
        <Button ref={openRef} variant="danger" onClick={() => setOpen(true)}>
          Forget this identity
        </Button>
      </div>
    );
  }
  return (
    <form className="ui-stack" onSubmit={onSubmit} noValidate>
      <Callout tone="warn" title="This cannot be undone without a backup">
        This removes your key from this browser. Without a backup file you can never sign as this person again, and you
        could not update or withdraw files you published.
      </Callout>
      <Field label={`Type "${FORGET_WORD}" to confirm`} error={error}>
        <input
          ref={typedRef}
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

// ---------------------------------------------------------------------------

function RegistrationLine({ registration, registrationError, onRegister, busy }) {
  if (registration === 'registered') return <span className="ui-badge ui-badge--good">Known to the server</span>;
  if (registration === 'checking' || registration === 'unknown') {
    return (
      <span className="ui-badge">
        <Spinner label={null} size="sm" /> Checking with the server
      </span>
    );
  }
  return (
    <div className="ui-stack ui-stack--tight">
      <span className="ui-badge ui-badge--warn">
        {registration === 'missing' ? 'The server does not know this key yet' : 'Could not tell the server about this key'}
      </span>
      {registrationError ? <p className="ui-muted">{registrationError}</p> : null}
      <div className="ui-row">
        <Button size="sm" loading={busy} onClick={onRegister}>
          Try again
        </Button>
      </div>
    </div>
  );
}

function IdentityCard() {
  const { identity, mode, account, keys, registration, registrationError, registerAgain } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function onRegister() {
    setBusy(true);
    try {
      await registerAgain();
      toast.push({ tone: 'good', text: 'The server knows this key now.' });
    } catch {
      // the error text is shown in the registration line
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ui-card ui-stack" aria-labelledby="adv-identity">
      <h2 className="ui-card__title" id="adv-identity">
        Your signing identity
      </h2>
      <dl className="ui-kv">
        <div>
          <dt>Name</dt>
          <dd>{identity.displayName}</dd>
        </div>
        <div>
          <dt>Kind</dt>
          <dd>{mode === 'account' ? (account && account.strict ? 'Account, Strict mode' : 'Account, Easy mode') : 'Quick start, this device only'}</dd>
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
        {mode !== 'account' ? (
          <div>
            <dt>Server</dt>
            <dd>
              <RegistrationLine registration={registration} registrationError={registrationError} onRegister={onRegister} busy={busy} />
            </dd>
          </div>
        ) : (
          <div>
            <dt>Keys of this account</dt>
            <dd>
              {keys.length === 0 ? (
                'None yet'
              ) : (
                <ul className="adv-keys">
                  {keys.map((k) => (
                    <li key={k.keyId}>
                      <HashText value={k.keyId} short length={16} />{' '}
                      <span className="ui-muted">
                        {k.keyId === identity.keyId ? 'in use here' : 'not used here'}
                        {k.hasCloudCopy ? ', copy in your account' : ', only on devices'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        )}
      </dl>
      <p className="ui-muted">
        The key id is the hash of your public key. It is how other people recognise your signatures.{' '}
        {mode === 'account' && account && !account.strict
          ? 'In Easy mode a protected copy of the key is also kept in your account, so your other devices can use it.'
          : 'The key is kept in this browser and cannot be read back out of it.'}
      </p>
    </section>
  );
}

export default function AdvancedPage() {
  const { status, mode, identity } = useSession();

  let body;
  if (status === 'loading') {
    body = (
      <div className="ui-center">
        <Spinner label="Loading your identity" />
      </div>
    );
  } else {
    body = (
      <div className="ui-stack">
        {status === 'ready' && identity ? (
          <>
            <IdentityCard />
            {identity.hasBackup ? (
              <section className="ui-card ui-stack" aria-labelledby="adv-backup">
                <h2 className="ui-card__title" id="adv-backup">
                  Backup file
                </h2>
                <p>
                  This identity was made with a passphrase. A backup file is the way to recover it if this browser&apos;s data is lost.
                </p>
                <FreshBackup />
              </section>
            ) : null}
            {mode === 'guest' ? (
              <section className="ui-card ui-stack" aria-labelledby="adv-forget">
                <h2 className="ui-card__title" id="adv-forget">
                  Forget this identity
                </h2>
                <p>Removes the key from this browser. To use a different identity, forget this one first.</p>
                <ForgetIdentity />
              </section>
            ) : null}
          </>
        ) : (
          <Callout tone="info" title="You are not signed in">
            <p>There is no identity on this device. You can still restore one from an old backup file below.</p>
          </Callout>
        )}
        {mode === 'guest' && identity && !identity.hasBackup ? (
          <p className="ui-muted">To restore an old backup file, forget this Quick start key first. It has no backup, so it cannot be brought back.</p>
        ) : null}
        {mode !== 'account' && !(mode === 'guest' && identity && !identity.hasBackup) ? <RestoreForm /> : null}
      </div>
    );
  }

  return (
    <div className="ui-screen">
      <ScreenHeader title="Advanced" back="/me" backLabel="Back to Me" />
      <div className="ui-container ui-container--narrow adv-page">{body}</div>
    </div>
  );
}
