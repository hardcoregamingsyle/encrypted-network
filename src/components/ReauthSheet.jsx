import { useId, useRef, useState } from 'react';
import Button from './Button.jsx';
import Callout from './Callout.jsx';
import Field from './Field.jsx';
import Icon from './Icon.jsx';
import OtpInput from './OtpInput.jsx';
import Sheet from './Sheet.jsx';
import useCountdown from './useCountdown.js';
import { hasNonAscii, looksLikeEmail, maskEmail } from '../lib/authText.js';
import { actionErrorText } from './actionText.js';

const DEFAULT_COOLDOWN = 30;

export const REAUTH_TITLE = 'Confirm it is you';
export const REAUTH_INTRO =
  'To do this we send a new 6 digit code to your email. Nothing changes until you enter it. You stay signed in either way.';

// The service sends one code every 30 seconds for an address. Asking again sooner is answered "wait N seconds", and
// the code that was sent a moment ago still works, so that case is a notice and not an error.
export const CODE_JUST_SENT = 'A code was sent a moment ago. Enter it here, or ask for a new one when the timer ends.';
const justSent = (err) => Boolean(err && err.code === 'rate_limited' && err.retryAfter > 0 && err.retryAfter <= 90);

// Codes that leave the digits useless: the boxes are emptied so a new code can be typed.
const CLEARS_CODE = ['invalid_code', 'code_expired', 'too_many_attempts'];

// "Confirm it is you": a new email code for the account that is signed in, needed before the few things that
// cannot be undone (reading the stored key, switching Strict mode, deleting the account).
//   request   { email, emailMasked, sent, cooldown, debugCode, sendError, sendCode(email), verify(email, code) }
//             from the session store. email is empty when the address is not known in this tab.
//   onFinish  called once with true (confirmed) or false (closed without confirming)
export default function ReauthSheet({ request, onFinish }) {
  const known = Boolean(request && request.email);
  const [email, setEmail] = useState(known ? request.email : '');
  const [step, setStep] = useState(known ? 'code' : 'email');
  const [code, setCode] = useState(request && request.debugCode ? request.debugCode : '');
  const early = request && request.sendError && justSent(request.sendError) ? request.sendError : null;
  const [error, setError] = useState(request && request.sendError && !early ? actionErrorText(request.sendError) : '');
  const [notice, setNotice] = useState(early ? CODE_JUST_SENT : '');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(() => {
    if (request && request.sent) return Date.now() + (request.cooldown || DEFAULT_COOLDOWN) * 1000;
    return early ? Date.now() + early.retryAfter * 1000 : 0;
  });
  const left = useCountdown(cooldownUntil);
  const sentId = useId();
  const emailRef = useRef(null);
  const finished = useRef(false);

  function finish(ok) {
    if (finished.current) return;
    finished.current = true;
    onFinish(ok);
  }

  const masked = maskEmail(email) || (request && request.emailMasked) || 'your email';

  async function send(address) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const answer = await request.sendCode(address);
      setEmail(address);
      setCode(answer.debugCode || '');
      setCooldownUntil(Date.now() + (answer.cooldown || DEFAULT_COOLDOWN) * 1000);
      setStep('code');
      setNotice('We sent a new code.');
    } catch (err) {
      if (justSent(err)) {
        setStep('code');
        setEmail(address);
        setNotice(CODE_JUST_SENT);
        setCooldownUntil(Date.now() + err.retryAfter * 1000);
      } else {
        setError(actionErrorText(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function onEmailSubmit(event) {
    event.preventDefault();
    setSubmitted(true);
    const address = email.trim();
    if (!looksLikeEmail(address) || hasNonAscii(address)) return;
    send(address);
  }

  async function submitCode(value) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request.verify(email.trim(), value);
      finish(true);
    } catch (err) {
      setError(actionErrorText(err));
      if (err && CLEARS_CODE.includes(err.code)) setCode('');
      setBusy(false);
    }
  }

  const emailError =
    submitted && hasNonAscii(email)
      ? 'Only plain letters, digits and the usual symbols are accepted in an email address for now. Remove accents and other special letters.'
      : submitted && !looksLikeEmail(email)
        ? 'Enter your email address, like name@example.com.'
        : '';

  const cancel = (
    <Button variant="ghost" onClick={() => finish(false)} disabled={busy}>
      Cancel
    </Button>
  );

  return (
    <Sheet
      open
      onClose={() => {
        if (!busy) finish(false);
      }}
      dismissible={!busy}
      title={REAUTH_TITLE}
      description={REAUTH_INTRO}
      footer={cancel}
    >
      {step === 'email' ? (
        <form className="ui-stack" onSubmit={onEmailSubmit} noValidate>
          <Field label="The email address of this account" hint={request && request.emailMasked ? `It looks like ${request.emailMasked}.` : undefined} error={emailError}>
            <input
              ref={emailRef}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              maxLength={254}
              disabled={busy}
            />
          </Field>
          {error ? (
            <Callout tone="bad" title="Could not send the code">
              {error}
            </Callout>
          ) : null}
          <Button type="submit" variant="primary" loading={busy}>
            Send me a code
          </Button>
        </form>
      ) : (
        <div className="ui-stack">
          <p className="signin__sent" id={sentId}>
            <Icon name="mail" size={18} /> Enter the 6 digit code we sent to <strong>{masked}</strong>
          </p>
          <OtpInput value={code} onChange={setCode} onComplete={submitCode} error={error} disabled={busy} label="6 digit code" autoFocus describedBy={sentId} />
          {request && request.debugCode && code === request.debugCode ? (
            <p className="ui-muted">Local test mode: no email was sent, the code is filled in for you.</p>
          ) : null}
          <p className="ui-muted" role="status">
            {notice}
          </p>
          <Button variant="primary" loading={busy} disabled={code.length !== 6} onClick={() => submitCode(code)}>
            Continue
          </Button>
          <div className="signin__row">
            <Button variant="ghost" size="sm" onClick={() => send(email.trim())} disabled={left > 0 || busy}>
              {left > 0 ? `Send a new code in ${left} s` : 'Send a new code'}
            </Button>
            {!known ? (
              <Button variant="ghost" size="sm" onClick={() => { setStep('email'); setError(''); setNotice(''); }} disabled={busy}>
                Wrong email? Go back
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </Sheet>
  );
}

export { ReauthSheet };
