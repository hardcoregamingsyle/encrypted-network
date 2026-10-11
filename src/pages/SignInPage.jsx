import { useEffect, useId, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import Button from '../components/Button.jsx';
import Callout from '../components/Callout.jsx';
import Field from '../components/Field.jsx';
import Icon from '../components/Icon.jsx';
import OtpInput from '../components/OtpInput.jsx';
import { usePageTitle } from '../components/PageHeader.jsx';
import Spinner from '../components/Spinner.jsx';
import QuickStartForm from '../components/QuickStartForm.jsx';
import Sheet from '../components/Sheet.jsx';
import { actionErrorText } from '../components/actionText.js';
import useCountdown from '../components/useCountdown.js';
import { authErrorText, hasNonAscii, looksLikeEmail, maskEmail, needsKeyKind } from '../lib/authText.js';
import { safeNextPath } from '../lib/format.js';
import { displayNameError } from '../lib/keystore.js';
import { useSession } from '../lib/session.jsx';

const DEFAULT_COOLDOWN = 30;
// A code works for 10 minutes. After 9 the page asks for a new one instead of reusing the old one.
const CODE_LIVE_MS = 9 * 60 * 1000;


function EmailStep({ initialEmail, liveCode, onSent, onResume }) {
  const { requestCode } = useSession();
  const [email, setEmail] = useState(initialEmail);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(event) {
    event.preventDefault();
    setSubmitted(true);
    setError('');
    if (!looksLikeEmail(email) || hasNonAscii(email)) return;
    // Wrong turn? The code that was just sent still works for the same address: go straight back to it.
    if (liveCode && liveCode.email === email.trim() && liveCode.until > Date.now()) {
      onResume();
      return;
    }
    setBusy(true);
    try {
      const answer = await requestCode(email.trim());
      onSent(email.trim(), answer);
    } catch (err) {
      setError(authErrorText(err));
      setBusy(false);
    }
  }

  const emailError =
    submitted && hasNonAscii(email)
      ? 'Only plain letters, digits and the usual symbols are accepted in an email address for now. Remove accents and other special letters.'
      : submitted && !looksLikeEmail(email)
        ? 'Enter your email address, like name@example.com.'
        : '';
  return (
    <form className="ui-stack signin__form" onSubmit={onSubmit} noValidate>
      <Field label="Your email" hint="We will send you a 6 digit code through an email service. No password needed." error={emailError}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck="false"
          maxLength={254}
        />
      </Field>
      {error ? (
        <Callout tone="bad" title="Could not send the code">
          {error}
        </Callout>
      ) : null}
      <Button type="submit" variant="primary" loading={busy}>
        Continue
      </Button>
    </form>
  );
}

function CodeStep({ email, cooldownUntil, debugCode, onBack, onResent, onVerified }) {
  const { requestCode, verifyCode, refresh } = useSession();
  const [code, setCode] = useState(debugCode || '');
  const [finishFailed, setFinishFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resending, setResending] = useState(false);
  const [notice, setNotice] = useState('');
  const left = useCountdown(cooldownUntil);
  const sentId = useId();
  const masked = maskEmail(email) || 'your email';

  async function submit(value) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setFinishFailed(false);
    try {
      const answer = await verifyCode(email, value);
      onVerified(answer);
    } catch (err) {
      setError(authErrorText(err));
      // Only a code that is wrong, expired or used up is cleared. After a lost connection (network) it is still good.
      if (err && (err.code === 'invalid_code' || err.code === 'code_expired' || err.code === 'too_many_attempts')) setCode('');
      // The code was accepted and is used up, so another try with it cannot work: look again instead.
      if (err && err.code === 'finish_failed') setFinishFailed(true);
      setBusy(false);
    }
  }

  async function checkAgain() {
    setBusy(true);
    setError('');
    try {
      await refresh();
    } catch (err) {
      setError(authErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setResending(true);
    setError('');
    setNotice('');
    try {
      const answer = await requestCode(email);
      setCode(answer.debugCode || '');
      setNotice('We sent a new code.');
      onResent(answer);
    } catch (err) {
      setError(authErrorText(err));
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="ui-stack signin__form">
      <p className="signin__sent" id={sentId}>
        <Icon name="mail" size={18} /> Enter the 6 digit code we sent to <strong>{masked}</strong>
      </p>
      <OtpInput value={code} onChange={setCode} onComplete={submit} error={error} disabled={busy} label="6 digit code" autoFocus describedBy={sentId} />
      {debugCode && code === debugCode ? <p className="ui-muted">Local test mode: no email was sent, the code is filled in for you.</p> : null}
      <p className="ui-muted" role="status">
        {notice}
      </p>
      {finishFailed ? (
        <Button variant="primary" loading={busy} onClick={checkAgain}>
          Check again
        </Button>
      ) : (
        <Button variant="primary" loading={busy} disabled={code.length !== 6} onClick={() => submit(code)}>
          Continue
        </Button>
      )}
      <div className="signin__row">
        <Button variant="ghost" size="sm" onClick={resend} disabled={left > 0} loading={resending}>
          {left > 0 ? `Send a new code in ${left} s` : 'Send a new code'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Wrong email? Go back
        </Button>
      </div>
    </div>
  );
}

function NameStep({ onDone }) {
  const { registerName, account, signOut, setStrict } = useSession();
  const strict = Boolean(account && account.strict);
  const [onlyHere, setOnlyHere] = useState(false);
  const [name, setName] = useState(account && account.displayName ? account.displayName : '');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameError = submitted ? displayNameError(name) : '';

  async function onSubmit(event) {
    event.preventDefault();
    setSubmitted(true);
    setError('');
    if (displayNameError(name)) return;
    setBusy(true);
    try {
      // The choice comes before the key is made, so the key is never sent to the service by someone who did not want that.
      if (onlyHere && !strict) await setStrict(true);
      await registerName(name);
      onDone();
    } catch (err) {
      setError(actionErrorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="ui-stack signin__form" onSubmit={onSubmit} noValidate>
      <Field
        label="What should we call you?"
        hint={strict ? 'This device makes its own key. Other people see this name next to what you write and publish.' : 'Other people see this name next to what you write and publish.'}
        error={nameError}
      >
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" maxLength={40} />
      </Field>
      {strict ? (
        <p className="ui-muted">
          Strict mode is on for your account, so the key made here stays on this device only.
        </p>
      ) : (
        <>
          <p className="ui-muted">
            Easy mode: your signing key is kept in your account, so any device you sign in on works. That means the service
            holds the means to use your key. You can change this later in <Link to="/me">Me</Link>, but a copy the service
            already held cannot be taken back.
          </p>
          <label className="ui-check">
            <input type="checkbox" checked={onlyHere} onChange={(e) => setOnlyHere(e.target.checked)} disabled={busy} />
            <span>
              Keep my key only on my devices
              <span className="ui-field__hint files-add__hint">Strict mode. The service never gets a copy. If you lose every device with the key, nobody can recover it.</span>
            </span>
          </label>
        </>
      )}
      {error ? (
        <Callout tone="bad" title="Could not finish">
          {error}
        </Callout>
      ) : null}
      <Button type="submit" variant="primary" loading={busy}>
        Start
      </Button>
      <Button variant="ghost" size="sm" onClick={() => signOut().catch(() => {})} disabled={busy}>
        Not you? Use a different email
      </Button>
    </form>
  );
}

// Signed in, but the account's key is only handed out after a new code (this sign in is older than 15 minutes).
function UnlockStep() {
  const { unlockKey, signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onUnlock() {
    setBusy(true);
    setError('');
    try {
      await unlockKey();
    } catch (err) {
      setError(actionErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ui-stack signin__form">
      <p>
        You are signed in. Your key is kept by your account, and it is handed out only after a new email code. We send the code to
        your email, and then this device can use your key.
      </p>
      {error ? (
        <Callout tone="bad" title="Could not get your key">
          {error}
        </Callout>
      ) : null}
      <Button variant="primary" loading={busy} onClick={onUnlock}>
        Confirm it is you
      </Button>
      <Button variant="ghost" size="sm" onClick={() => signOut().catch(() => {})} disabled={busy}>
        Not you? Use a different email
      </Button>
    </div>
  );
}

// Signed in, but the key could not be loaded just now (a lost connection, or this browser cannot keep it).
function RetryStep() {
  const { refresh, signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onRetry() {
    setBusy(true);
    setError('');
    try {
      await refresh();
    } catch (err) {
      setError(actionErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ui-stack signin__form">
      <p>You are signed in, but your key could not be loaded just now. Try again in a moment.</p>
      {error ? (
        <Callout tone="bad" title="Could not get your key">
          {error}
        </Callout>
      ) : null}
      <Button variant="primary" loading={busy} onClick={onRetry}>
        Try again
      </Button>
      <Button variant="ghost" size="sm" onClick={() => signOut().catch(() => {})} disabled={busy}>
        Not you? Use a different email
      </Button>
    </div>
  );
}

// Sign in with an email and a 6 digit code, in up to three steps: email, code, name.
export default function SignInPage() {
  const session = useSession();
  const { status, mode, mailAvailable } = session;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [debugCode, setDebugCode] = useState('');
  const [liveCode, setLiveCode] = useState(null); // { email, until } of the last code that was sent
  const [quickOpen, setQuickOpen] = useState(false);
  const headingRef = useRef(null);
  const first = useRef(true);

  // Signed in without a key on this device: a new account picks a name, an account that has one confirms it is them first.
  const kind = needsKeyKind(session);
  const shown = status === 'needsKey' ? (kind === 'confirm' ? 'unlock' : kind === 'retry' ? 'retry' : 'name') : step;
  usePageTitle('Sign in');

  // A new step is a new screen: focus goes to its heading.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // the code step puts focus in the first box instead, and the box is described by the heading text
    if (shown !== 'code' && headingRef.current) headingRef.current.focus({ preventScroll: true });
  }, [shown]);

  // A Quick start person may still sign in with an email, so only an account is sent on.
  if (status === 'ready' && mode === 'account') return <Navigate to={next} replace />;
  if (status === 'loading') {
    return (
      <div className="ui-splash">
        <h1 className="ui-sr-only">Sign in</h1>
        <Spinner label="Loading" size="lg" />
      </div>
    );
  }

  const titles = { email: 'Sign in with email', code: 'Check your email', name: 'Almost there', unlock: 'Confirm it is you', retry: 'Your key did not load' };

  return (
    <div className="signin">
      <div className="signin__card">
        <Link to="/welcome" className="signin__back">
          <Icon name="arrow-left" size={18} /> Back
        </Link>
        <h1 className="signin__title" tabIndex={-1} ref={headingRef}>
          {titles[shown]}
        </h1>
        {!mailAvailable && shown !== 'name' && shown !== 'unlock' && shown !== 'retry' ? (
          <div className="ui-stack">
            <Callout tone="warn" title="Email sign in is not switched on yet">
              You can use Quick start instead. It keeps your key on this device, with no email.
            </Callout>
            <Button variant="primary" onClick={() => setQuickOpen(true)}>
              <Icon name="bolt" size={18} /> Quick start on this device
            </Button>
            <Sheet open={quickOpen} onClose={() => setQuickOpen(false)} title="Quick start">
              <QuickStartForm onDone={() => navigate(next, { replace: true })} />
            </Sheet>
          </div>
        ) : null}
        {mailAvailable && shown === 'email' ? (
          <EmailStep
            initialEmail={email}
            liveCode={liveCode}
            onResume={() => setStep('code')}
            onSent={(addr, answer) => {
              setEmail(addr);
              setDebugCode(answer.debugCode || '');
              setCooldownUntil(Date.now() + (answer.cooldown || DEFAULT_COOLDOWN) * 1000);
              setLiveCode({ email: addr, until: Date.now() + CODE_LIVE_MS });
              setStep('code');
            }}
          />
        ) : null}
        {shown === 'code' ? (
          <CodeStep
            email={email}
            cooldownUntil={cooldownUntil}
            debugCode={debugCode}
            onBack={() => setStep('email')}
            onResent={(answer) => {
              setDebugCode(answer.debugCode || '');
              setCooldownUntil(Date.now() + (answer.cooldown || DEFAULT_COOLDOWN) * 1000);
              setLiveCode({ email, until: Date.now() + CODE_LIVE_MS });
            }}
            onVerified={(answer) => {
              if (answer.status === 'ready') navigate(next, { replace: true });
              else setStep('name');
            }}
          />
        ) : null}
        {shown === 'name' ? <NameStep onDone={() => navigate(next, { replace: true })} /> : null}
        {shown === 'unlock' ? <UnlockStep /> : null}
        {shown === 'retry' ? <RetryStep /> : null}
      </div>
    </div>
  );
}
