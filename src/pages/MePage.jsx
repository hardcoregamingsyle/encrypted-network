import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Avatar from '../components/Avatar.jsx';
import Button from '../components/Button.jsx';
import Callout from '../components/Callout.jsx';
import Field from '../components/Field.jsx';
import Icon from '../components/Icon.jsx';
import ScreenHeader from '../components/ScreenHeader.jsx';
import Sheet from '../components/Sheet.jsx';
import Skeleton from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { QUICK_START_NOTE } from '../components/QuickStartForm.jsx';
import { actionErrorText } from '../components/actionText.js';
import { authErrorText } from '../lib/authText.js';
import { downloadTextFile } from '../lib/download.js';
import { timeAgo } from '../lib/format.js';
import { CANCELLED_MESSAGE } from '../lib/sessionStore.js';
import { useSession } from '../lib/session.jsx';
import { passwordsFileText } from '../lib/vault.js';
import '../styles/me.css';

export const EASY_TRADE_OFF =
  'In Easy mode the service keeps a locked copy of your signing key and of your file passwords, so any device you sign in on can use them. The trade-off: whoever runs the service holds the means to use that key and open those passwords. It does not change what other people see when they check your files.';

export const STRICT_EXPLAIN =
  'Strict mode keeps your key only on your own devices. The service deletes its copy of your key and of your file passwords, and every new device you sign in on makes its own key. Files stay owned by the key that published them, so updating or withdrawing a file only works on a device that holds that key. If you lose all those devices, nobody can recover that key.';

// What Strict mode cannot undo, said before it is switched on and on the card afterwards.
export const STRICT_LIMITS =
  'The service already held your key until now, and your existing files stay signed by that same key. Deleting its copy cannot undo that, and an earlier copy may still exist in backups of the service.';

// What stays on a computer after sign out, for the people whose key stays on it.
export const SHARED_COMPUTER_STRICT =
  'When you sign out, your key and file passwords stay on this device so you can use them again. Do not use Strict mode on a shared computer.';
export const SHARED_COMPUTER_QUICK =
  'On a shared computer, choose Leave Quick start when you are done. It removes your key and file passwords from this browser.';

function Row({ to, icon, title, sub }) {
  return (
    <li>
      <Link to={to} className="me-row">
        <span className="me-row__icon">
          <Icon name={icon} size={20} />
        </span>
        <span className="me-row__text">
          <span className="me-row__title">{title}</span>
          {sub ? <span className="me-row__sub">{sub}</span> : null}
        </span>
        <Icon name="chevron-right" size={18} />
      </Link>
    </li>
  );
}

function InstallHint() {
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    try {
      setStandalone(Boolean(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches));
    } catch {
      setStandalone(false);
    }
  }, []);
  if (standalone) return null;
  return (
    <section className="me-card" aria-labelledby="me-install">
      <h2 className="me-card__title" id="me-install">
        Keep it on your home screen
      </h2>
      <p className="ui-muted">
        In your browser menu choose Add to Home Screen (or Install app). hrdlock then opens like any other app.
      </p>
    </section>
  );
}

function ModeSwitch({ strict, unfinished = false, busy, onToggle }) {
  return (
    <div className="me-switch">
      <div className="me-switch__text">
        <span className="me-switch__label" id="me-strict-label">
          Keep my key only on my devices
        </span>
        <span className="me-switch__state">{unfinished ? 'Strict mode is not finished' : strict ? 'Strict mode is on' : 'Easy mode is on'}</span>
      </div>
      <button
        type="button"
        aria-pressed={strict ? 'true' : 'false'}
        aria-labelledby="me-strict-label"
        className="me-switch__btn"
        disabled={busy}
        onClick={onToggle}
      >
        <span className="me-switch__knob" aria-hidden="true" />
      </button>
    </div>
  );
}

// A button that waits for an answer is disabled and loses focus. After a failure or a cancel the button is
// pressable again, and focus goes back to it. Call back() in the catch block.
function useRefocus(busy) {
  const ref = useRef(null);
  const wanted = useRef(false);
  useEffect(() => {
    if (!busy && wanted.current) {
      wanted.current = false;
      if (ref.current) ref.current.focus({ preventScroll: true });
    }
  }, [busy]);
  return [ref, () => { wanted.current = true; }];
}

// What the progress line says while the passwords are handed over. The service does not say how many there are
// until the last page, so the count is what has been saved so far.
export function strictProgressText(progress) {
  if (!progress) return 'Asking the service for your file passwords.';
  const n = progress.saved;
  if (progress.done) return `Saved ${n} file ${n === 1 ? 'password' : 'passwords'} to this device.`;
  return `Saving your file passwords to this device, ${n} saved so far.`;
}

// resume: a switch to Strict mode was started on this device and not finished, so the sheet finishes it.
function StrictSheet({ open, onClose, strict, resume = false }) {
  const { setStrict } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);
  const [kept, setKept] = useState([]); // passwords handed over before a failure, so they can be downloaded
  const [saveError, setSaveError] = useState('');
  const resultRef = useRef(null);
  const [confirmRef, refocusLater] = useRefocus(busy);
  const turningOn = resume || !strict;

  useEffect(() => {
    if (open) {
      setError('');
      setResult(null);
      setProgress(null);
      setKept([]);
      setSaveError('');
      setBusy(false);
    }
  }, [open]);

  // The question is replaced by the answer inside the same sheet, so focus is moved to the answer.
  useEffect(() => {
    if (result && resultRef.current) resultRef.current.focus({ preventScroll: true });
  }, [result]);

  async function confirm() {
    setBusy(true);
    setError('');
    setKept([]);
    setProgress(null);
    try {
      const out = await setStrict(turningOn, { onProgress: setProgress });
      if (turningOn) setResult(out);
      else {
        toast.push({ tone: 'good', text: 'Easy mode is on.' });
        onClose();
      }
    } catch (err) {
      setKept(err && Array.isArray(err.passwords) ? err.passwords : []);
      setError(actionErrorText(err));
      refocusLater();
    } finally {
      setBusy(false);
    }
  }

  function download(list) {
    if (!downloadTextFile('hrdlock-file-passwords.txt', passwordsFileText(list))) {
      setSaveError('Could not save the file. Try again, or copy the passwords from your share links.');
    } else {
      setSaveError('');
    }
  }

  if (result) {
    const count = result.passwords.length;
    const stored = Number.isFinite(result.kept) ? result.kept : count;
    const lost = count - stored;
    const unreadable = Number.isFinite(result.unreadable) ? result.unreadable : 0;
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title="Strict mode is on"
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}
      >
        <div className="ui-stack" ref={resultRef} tabIndex={-1} role="status">
          <p>
            The service no longer holds a copy of your key or your file passwords.
            {stored > 0 ? ` ${stored} file ${stored === 1 ? 'password was' : 'passwords were'} handed back and saved on this device.` : ''}
          </p>
          {lost > 0 ? (
            <Callout tone="bad" title="Not all passwords could be kept on this device">
              {lost === 1 ? 'One password' : `${lost} passwords`} could not be stored here. Download the passwords now.
            </Callout>
          ) : null}
          {unreadable > 0 ? (
            <Callout tone="warn" title="Some passwords could not be handed back">
              The service could not read {unreadable === 1 ? 'one saved password' : `${unreadable} saved passwords`}, so{' '}
              {unreadable === 1 ? 'it' : 'they'} could not be saved here. Files with {unreadable === 1 ? 'that password' : 'those passwords'} still open
              with their share links.
            </Callout>
          ) : null}
          {count > 0 ? (
            <Button variant={lost > 0 ? 'primary' : 'secondary'} onClick={() => download(result.passwords)}>
              <Icon name="download" size={18} /> Download the passwords
            </Button>
          ) : null}
          {saveError ? (
            <Callout tone="bad" title="Could not save the file">
              {saveError}
            </Callout>
          ) : null}
          <p className="ui-muted">Keep the downloaded file private. Anyone who has it can open those files.</p>
          <p className="ui-muted">{STRICT_LIMITS}</p>
          <p className="ui-muted">{SHARED_COMPUTER_STRICT}</p>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={resume ? 'Finish Strict mode' : strict ? 'Back to Easy mode' : 'Turn on Strict mode'}
      footer={
        <>
          <Button ref={confirmRef} variant={turningOn ? 'danger' : 'primary'} loading={busy} onClick={confirm}>
            {resume ? 'Finish saving my passwords' : strict ? 'Turn on Easy mode' : 'Turn on Strict mode'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy} data-autofocus="true">
            Cancel
          </Button>
        </>
      }
    >
      <div className="ui-stack">
        {resume ? (
          <>
            <p>
              Strict mode was switched on, but your file passwords were not all saved on this device. The service keeps the rest
              for 24 hours, then deletes them.
            </p>
            <p>Finishing saves them here, one page at a time. It asks for a new email code if it has been a while since you signed in.</p>
          </>
        ) : strict ? (
          <>
            <p>
              Your account will keep a locked copy of a signing key again, and of the file passwords you publish from now
              on, so any device you sign in on can use them.
            </p>
            <p>A new key is made on this device for that. Files you published before stay with the key that published them.</p>
            <p>The file passwords already on this device stay here. They are not sent to the service.</p>
            <p>We will ask for a new email code first if it has been a while since you signed in.</p>
            <p className="ui-muted">{EASY_TRADE_OFF}</p>
          </>
        ) : (
          <>
            <p>{STRICT_EXPLAIN}</p>
            <p>{STRICT_LIMITS}</p>
            <p>
              Your file passwords are handed back and saved on this device, a page at a time. The service deletes each page only
              after it is saved here. You can download them too. We will ask for a new email code first if it has been a while
              since you signed in.
            </p>
          </>
        )}
        <p className="ui-muted" role="status">
          {busy && turningOn ? strictProgressText(progress) : ''}
        </p>
        {error ? (
          <Callout tone="bad" title={error === CANCELLED_MESSAGE ? 'Cancelled' : 'Could not change the mode'}>
            <p>{error}</p>
            {kept.length > 0 ? (
              <Button size="sm" onClick={() => download(kept)}>
                <Icon name="download" size={18} /> Download the passwords saved so far
              </Button>
            ) : null}
            {saveError ? <p role="alert">{saveError}</p> : null}
          </Callout>
        ) : null}
      </div>
    </Sheet>
  );
}

function DeleteSheet({ open, onClose, isAccount }) {
  const { deleteAccount, forgetDevice } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const word = isAccount ? 'delete' : 'leave';
  const ok = typed.trim().toLowerCase() === word;
  const [confirmRef, refocusLater] = useRefocus(busy);

  useEffect(() => {
    if (open) {
      setTyped('');
      setError('');
      setBusy(false);
    }
  }, [open]);

  async function confirm() {
    if (!ok || busy) return;
    setBusy(true);
    setError('');
    try {
      if (isAccount) await deleteAccount();
      else await forgetDevice();
      toast.push({ tone: 'info', text: isAccount ? 'Your account was deleted.' : 'Quick start was removed from this device.' });
      onClose();
      navigate('/welcome', {
        replace: true,
        state: { notice: isAccount ? 'Your account was deleted. What you signed stays in the public history.' : 'Quick start was removed from this device.' }
      });
    } catch (err) {
      setError(actionErrorText(err));
      refocusLater();
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={isAccount ? 'Delete your account' : 'Leave Quick start'}
      footer={
        <>
          <Button ref={confirmRef} variant="danger" disabled={!ok} loading={busy} onClick={confirm}>
            {isAccount ? 'Delete my account' : 'Remove from this device'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      <form
        className="ui-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        {isAccount ? (
          <>
            <p>
              This deletes your account, the saved copy of your key and your saved file passwords from the server, and the key and
              passwords on this device. It cannot be undone.
            </p>
            <p>We will ask for a new email code first if it has been a while since you signed in.</p>
            <p>
              Afterwards you can no longer update or withdraw your files, and you cannot open them without a share link that
              carries the password.
            </p>
            <p>
              What you already signed stays in the public history, because that is what makes history checkable: your
              messages, your file versions, your name and your public key.
            </p>
          </>
        ) : (
          <>
            <p>
              This removes your key and your saved file passwords from this browser. Without them you can no longer update or
              withdraw what you published, and nobody can bring them back.
            </p>
            <p>What you already signed stays in the public history.</p>
          </>
        )}
        <Field label={`Type "${word}" to confirm`} error={error}>
          <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck="false" disabled={busy} enterKeyHint="done" />
        </Field>
      </form>
    </Sheet>
  );
}

function Profile({ identity, line, badge }) {
  return (
    <section className="me-profile" aria-label="Your profile">
      <Avatar name={identity.displayName} keyId={identity.keyId} size={72} />
      <div className="me-profile__text">
        <p className="me-profile__name">{identity.displayName}</p>
        <p className="me-profile__line">{line}</p>
        {badge ? <span className="ui-badge ui-badge--info">{badge}</span> : null}
      </div>
    </section>
  );
}

// A question with a yes button, used before signing devices out.
function ConfirmSheet({ open, onClose, title, confirmLabel, onConfirm, children }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmRef, refocusLater] = useRefocus(busy);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setError('');
    }
  }, [open]);

  async function go() {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
    } catch (err) {
      setError(actionErrorText(err));
      refocusLater();
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={title}
      footer={
        <>
          <Button ref={confirmRef} variant="danger" loading={busy} onClick={go}>
            {confirmLabel}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy} data-autofocus="true">
            Cancel
          </Button>
        </>
      }
    >
      <div className="ui-stack">
        {children}
        {error ? (
          <Callout tone="bad" title="Could not sign out">
            {error}
          </Callout>
        ) : null}
      </div>
    </Sheet>
  );
}

// "Where you are signed in": the devices and browsers that hold a session of this account.
export function SessionRow({ session, now, busy, onEnd }) {
  const used = timeAgo(session.lastSeenAt, now);
  return (
    <li className="me-session">
      <span className="me-session__text">
        <span className="me-session__title">
          {session.current ? 'This device' : 'Another device'}
          {session.current ? <span className="ui-badge ui-badge--info me-session__badge">Current</span> : null}
        </span>
        <span className="me-session__sub">
          {session.current ? 'In use now' : `Last used ${used}`}. Signed in {timeAgo(session.createdAt, now)}.
        </span>
      </span>
      {session.current ? null : (
        <Button size="sm" variant="ghost" loading={busy} onClick={() => onEnd(session)} aria-label={`Sign out the device last used ${used}`}>
          Sign out
        </Button>
      )}
    </li>
  );
}

function SessionsCard() {
  const { listSessions, endOtherSessions, endSession, signOutEverywhere } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [view, setView] = useState({ loading: true, error: '', sessions: [], now: Date.now() });
  const [ask, setAsk] = useState(''); // '' | 'others' | 'all'
  const [endingId, setEndingId] = useState('');
  const [rowError, setRowError] = useState('');
  const headingRef = useRef(null);

  // The button that was pressed goes away when its work is done (no other device is left): focus then stays on this card.
  function focusCard() {
    if (headingRef.current) headingRef.current.focus({ preventScroll: true });
  }

  async function load() {
    try {
      const sessions = await listSessions();
      setView({ loading: false, error: '', sessions, now: Date.now() });
    } catch (err) {
      setView((v) => ({ ...v, loading: false, error: actionErrorText(err) }));
    }
  }

  useEffect(() => {
    let alive = true;
    listSessions()
      .then((sessions) => {
        if (alive) setView({ loading: false, error: '', sessions, now: Date.now() });
      })
      .catch((err) => {
        if (alive) setView((v) => ({ ...v, loading: false, error: actionErrorText(err) }));
      });
    return () => {
      alive = false;
    };
  }, [listSessions]);

  const others = view.sessions.filter((x) => !x.current);

  async function endOne(session) {
    setEndingId(session.id);
    setRowError('');
    try {
      await endSession(session.id);
      await load();
      focusCard();
    } catch (err) {
      setRowError(actionErrorText(err));
    } finally {
      setEndingId('');
    }
  }

  return (
    <section className="me-card" aria-labelledby="me-sessions">
      <h2 className="me-card__title" id="me-sessions" tabIndex={-1} ref={headingRef}>
        Where you are signed in
      </h2>
      <p className="ui-muted">
        A sign in ends 30 days after you last used it, and 90 days after it began at the latest.
      </p>
      {view.loading ? <Skeleton variant="row" count={2} label="Loading the devices you are signed in on" /> : null}
      {view.error ? (
        <Callout tone="warn" title="Could not load this list">
          <p>{view.error}</p>
          <Button size="sm" onClick={() => load()}>
            Try again
          </Button>
        </Callout>
      ) : null}
      {!view.loading && !view.error ? (
        <ul className="me-sessions">
          {view.sessions.length === 0 ? <li className="ui-muted">No other sign ins were found.</li> : null}
          {view.sessions.map((x) => (
            <SessionRow key={x.id} session={x} now={view.now} busy={endingId === x.id} onEnd={endOne} />
          ))}
        </ul>
      ) : null}
      {rowError ? <p role="alert">{rowError}</p> : null}
      <div className="me-actions">
        {others.length > 0 ? (
          <Button onClick={() => setAsk('others')}>Sign out other devices</Button>
        ) : null}
        <Button variant="danger" onClick={() => setAsk('all')}>
          Sign out everywhere
        </Button>
      </div>

      <ConfirmSheet
        open={ask === 'others'}
        onClose={() => setAsk('')}
        title="Sign out other devices"
        confirmLabel="Sign out other devices"
        onConfirm={async () => {
          const out = await endOtherSessions();
          setAsk('');
          toast.push({ tone: 'info', text: out.ended === 1 ? 'Signed out 1 other device.' : `Signed out ${out.ended} other devices.` });
          await load();
          focusCard();
        }}
      >
        <p>Every other device and browser is signed out of your account. This device stays signed in.</p>
      </ConfirmSheet>

      <ConfirmSheet
        open={ask === 'all'}
        onClose={() => setAsk('')}
        title="Sign out everywhere"
        confirmLabel="Sign out everywhere"
        onConfirm={async () => {
          await signOutEverywhere();
          setAsk('');
          toast.push({ tone: 'info', text: 'You are signed out everywhere.' });
          navigate('/welcome', { replace: true });
        }}
      >
        <p>Every device and browser is signed out, this one too. To use your account again you need a new email code.</p>
        <p className="ui-muted">If you use Strict mode, your key stays on the devices that hold it.</p>
      </ConfirmSheet>
    </section>
  );
}

export default function MePage() {
  const { status, mode, account, identity, keys, keyProblem, mailAvailable, signOut, refresh, setStrict, strictUnfinished, unlockKey } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [strictOpen, setStrictOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [signOutError, setSignOutError] = useState('');
  const [unsent, setUnsent] = useState([]); // file passwords that exist only on this device
  const [downloadError, setDownloadError] = useState('');

  // The account holds the key, but this sign in is too old to hand it out: confirm with a new code, then load it.
  async function onUnlock() {
    setUnlocking(true);
    setUnlockError('');
    try {
      await unlockKey();
    } catch (err) {
      setUnlockError(actionErrorText(err));
    } finally {
      setUnlocking(false);
    }
  }

  // Easy mode without a saved key: make one and save it to the account.
  async function onSaveKey() {
    setSavingKey(true);
    setKeyError('');
    try {
      await setStrict(false);
      toast.push({ tone: 'good', text: 'Your key is saved to your account.' });
    } catch (err) {
      setKeyError(actionErrorText(err));
    } finally {
      setSavingKey(false);
    }
  }

  async function onSignOut(options) {
    setSigningOut(true);
    setSignOutError('');
    try {
      await signOut(options);
      toast.push({ tone: 'info', text: 'You are signed out.' });
      navigate('/welcome', { replace: true });
    } catch (err) {
      // A password that never reached the account would be lost with the sign out: say so and offer to save it.
      setUnsent(err && err.code === 'unsent_passwords' && Array.isArray(err.passwords) ? err.passwords : []);
      setSignOutError(authErrorText(err));
      setSigningOut(false);
    }
  }

  const unsentBlock = signOutError ? (
    <Callout tone="bad" title="You are still signed in">
      <p>{signOutError}</p>
      {unsent.length > 0 ? (
        <div className="ui-stack">
          <Button
            onClick={() => {
              setDownloadError(
                downloadTextFile('hrdlock-file-passwords.txt', passwordsFileText(unsent)) ? '' : 'Could not save the file. Try again.'
              );
            }}
          >
            <Icon name="download" size={18} /> Download the passwords
          </Button>
          {downloadError ? <p role="alert">{downloadError}</p> : null}
          <Button variant="danger" onClick={() => onSignOut({ discardUnsent: true })} loading={signingOut}>
            Sign out and lose them
          </Button>
        </div>
      ) : null}
    </Callout>
  ) : null;

  let body;
  if (status === 'loading') {
    body = <Skeleton variant="row" count={3} label="Loading your profile" />;
  } else if (status === 'ready' && identity && mode === 'account' && account) {
    // A switch to Strict mode that was started and not finished is shown as such, not as Strict mode.
    const unfinished = typeof strictUnfinished === 'function' && strictUnfinished();
    const strict = account.strict && !unfinished;
    const hasCloud = keys.some((k) => k.hasCloudCopy);
    body = (
      <>
        <Profile identity={identity} line={account.emailMasked} badge={unfinished ? 'Strict mode, not finished' : strict ? 'Strict mode' : 'Easy mode'} />

        <section className="me-card" aria-labelledby="me-key">
          <h2 className="me-card__title" id="me-key">
            Your key
          </h2>
          <ModeSwitch strict={strict} unfinished={unfinished} busy={false} onToggle={() => setStrictOpen(true)} />
          {unfinished ? (
            <Callout tone="warn" title="Strict mode is not finished">
              <p>
                Your file passwords were not all saved on this device. The service keeps the rest for 24 hours and then deletes
                them.
              </p>
              <Button size="sm" variant="primary" onClick={() => setStrictOpen(true)}>
                Finish saving them
              </Button>
            </Callout>
          ) : null}
          <p className="ui-muted">{strict ? STRICT_EXPLAIN : EASY_TRADE_OFF}</p>
          {strict ? <p className="ui-muted">{SHARED_COMPUTER_STRICT}</p> : null}
          {!strict && !hasCloud && !unfinished ? (
            <Callout tone="warn" title="Your key is not saved to your account yet">
              <p>Easy mode is on, but this account does not hold a copy of a key yet.</p>
              {keyError ? <p role="alert">{keyError}</p> : null}
              <Button size="sm" loading={savingKey} onClick={onSaveKey}>
                Save it now
              </Button>
            </Callout>
          ) : null}
        </section>

        <SessionsCard />

        <ul className="me-rows">
          <Row to="/me/advanced" icon="key" title="Advanced" sub="Your key details" />
          <Row to="/about" icon="info" title="About" sub="What hrdlock does and does not prove" />
        </ul>
        <InstallHint />

        <section className="me-card me-card--actions" aria-label="Account actions">
          {unsentBlock}
          <Button onClick={() => onSignOut()} loading={signingOut}>
            <Icon name="logout" size={18} /> Sign out
          </Button>
          <Button variant="danger" onClick={() => setDeleteOpen(true)} disabled={signingOut}>
            <Icon name="trash" size={18} /> Delete account
          </Button>
        </section>

        <StrictSheet open={strictOpen} onClose={() => setStrictOpen(false)} strict={strict} resume={unfinished} />
        <DeleteSheet open={deleteOpen} onClose={() => setDeleteOpen(false)} isAccount />
      </>
    );
  } else if (status === 'ready' && identity) {
    body = (
      <>
        <Profile identity={identity} line="Quick start, this device only" badge="Quick start" />
        <Callout tone="warn" title="Everything is on this device">
          <p>{QUICK_START_NOTE}</p>
          <p>{SHARED_COMPUTER_QUICK}</p>
        </Callout>
        {mailAvailable ? (
          <div className="me-card me-card--actions">
            <Button variant="primary" onClick={() => navigate('/signin?next=%2Fme')}>
              <Icon name="mail" size={18} /> Sign in with email
            </Button>
            <p className="ui-muted">Signing in gives you a new identity tied to your email. What you made with Quick start stays as it is.</p>
          </div>
        ) : null}
        <ul className="me-rows">
          <Row to="/me/advanced" icon="key" title="Advanced" sub="Your key details and backup file" />
          <Row to="/about" icon="info" title="About" sub="What hrdlock does and does not prove" />
        </ul>
        <InstallHint />
        <section className="me-card me-card--actions" aria-label="Quick start actions">
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            <Icon name="trash" size={18} /> Leave Quick start
          </Button>
        </section>
        <DeleteSheet open={deleteOpen} onClose={() => setDeleteOpen(false)} isAccount={false} />
      </>
    );
  } else if (status === 'needsKey') {
    body = (
      <>
        <Callout tone="info" title="One more step">
          <p>
            {keyProblem === 'reauth'
              ? 'Your key is kept by your account. To get it onto this device, confirm it is you with a new email code.'
              : keyProblem
                ? 'Your key could not be loaded just now.'
                : 'You are signed in. Choose the name people will see.'}
          </p>
          {unlockError ? <p role="alert">{unlockError}</p> : null}
          {keyProblem === 'reauth' ? (
            <Button size="sm" variant="primary" loading={unlocking} onClick={onUnlock}>
              Confirm it is you
            </Button>
          ) : keyProblem ? (
            <Button size="sm" onClick={() => refresh().catch(() => {})}>
              Try again
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => navigate('/signin')}>
              Choose your name
            </Button>
          )}
        </Callout>
        <ul className="me-rows">
          <Row to="/about" icon="info" title="About" sub="What hrdlock does and does not prove" />
        </ul>
        <section className="me-card me-card--actions">
          {unsentBlock}
          <Button onClick={() => onSignOut()} loading={signingOut}>
            <Icon name="logout" size={18} /> Sign out
          </Button>
        </section>
      </>
    );
  } else {
    body = (
      <>
        <section className="me-card" aria-labelledby="me-out">
          <h2 className="me-card__title" id="me-out">
            You are not signed in
          </h2>
          <p className="ui-muted">You can read chats and check documents without signing in. To write or publish, sign in.</p>
          <div className="ui-stack">
            {mailAvailable ? (
              <Button variant="primary" onClick={() => navigate('/signin?next=%2Fme')}>
                <Icon name="mail" size={18} /> Continue with email
              </Button>
            ) : null}
            <Button variant={mailAvailable ? 'secondary' : 'primary'} onClick={() => navigate('/welcome')}>
              Other ways to start
            </Button>
          </div>
        </section>
        <ul className="me-rows">
          <Row to="/me/advanced" icon="key" title="Advanced" sub="Restore an old backup file" />
          <Row to="/about" icon="info" title="About" sub="What hrdlock does and does not prove" />
        </ul>
        <InstallHint />
      </>
    );
  }

  return (
    <div className="ui-screen">
      <ScreenHeader title="Me" />
      <div className="ui-container ui-container--narrow me-page">{body}</div>
    </div>
  );
}
