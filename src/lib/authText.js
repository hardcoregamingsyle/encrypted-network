// Plain words for the errors of the sign in flow. No codes, no jargon.

const NETWORK = 'Could not reach the server. Check your connection and try again.';

// err is an ApiError (status, code, message, retryAfter) or any Error.
export function authErrorText(err) {
  if (!err) return 'Something went wrong. Try again.';
  switch (err.code) {
    case 'invalid_email':
      return 'That email address does not look right. Check it and try again.';
    case 'invalid_code':
      return 'That code is not right, try again.';
    case 'code_expired':
      return 'That code has expired. Ask for a new one.';
    case 'too_many_attempts':
      return 'Too many wrong tries. Ask for a new code.';
    case 'mail_unavailable':
      return 'Email sign in is not switched on yet. You can use Quick start instead.';
    case 'mail_failed':
      return 'We could not send the email. Try again in a minute.';
    case 'accounts_unavailable':
      return 'Accounts are not switched on yet. You can use Quick start instead.';
    case 'rate_limited': {
      const wait = Number.isFinite(err.retryAfter) && err.retryAfter > 0 ? err.retryAfter : 0;
      if (wait > 0 && wait <= 90) return `Please wait ${wait} ${wait === 1 ? 'second' : 'seconds'} before trying again.`;
      return 'Too many tries for now. Wait a little and try again.';
    }
    case 'unauthenticated':
      return 'You are signed out. Sign in again to continue.';
    case 'strict_mode':
      return 'This works only in Easy mode. Switch to Easy mode in Me first.';
    case 'key_exists':
      return 'Your account already has a key.';
    case 'forbidden':
      return 'The server did not accept this request. Reload the page and try again.';
    case 'network':
      return NETWORK;
    case 'finish_failed':
      // The code is used up but the server already signed the person in, so a new code is the wrong advice.
      return 'The code was right, but we could not finish signing you in. Reload the page, or check your connection and try again.';
    case 'unsent_passwords':
      return err.message ? String(err.message) : 'Some file passwords are saved only on this device. Download them first, then sign out.';
    default:
      break;
  }
  if (err.status === 0) return NETWORK;
  if (err.status >= 500) return 'The server had a problem. Try again in a moment.';
  return err.message ? String(err.message) : 'Something went wrong. Try again.';
}

// A plain Error from the key code (display name rules, damaged backup...) is already readable.
export function plainErrorText(err, fallback = 'Something went wrong. Try again.') {
  return err && err.message ? String(err.message) : fallback;
}

// True when the address has a character outside plain ASCII. The server accepts only plain letters and digits.
export function hasNonAscii(text) {
  return typeof text === 'string' && /[^\x00-\x7f]/.test(text);
}

// A light check before asking the server: something@something.tld without spaces. The server decides.
export function looksLikeEmail(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return t.length >= 3 && t.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

// "priya.nair@gmail.com" -> "pr***@gmail.com", the same shape the server shows.
export function maskEmail(email) {
  // lower case, like the address the service stores and shows on the Me page
  const t = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const at = t.lastIndexOf('@');
  if (at < 1) return '';
  return Array.from(t.slice(0, at)).slice(0, 2).join('') + '***' + t.slice(at);
}

// ---------------------------------------------------------------------------
// Signed in, but this device has no key yet ("needsKey"). Three different situations, each with its own words:
//   name     a new account (or a Strict account on a new device): it needs a name to make a key
//   confirm  an Easy account whose key is kept by the service, but this sign in is older than 15 minutes:
//            the key is only handed out after a new email code. The account already has a name.
//   retry    the key could not be loaded just now (connection, or this browser cannot keep it)
// session is the session state: { keyProblem, account, keys }.
export function needsKeyKind(session) {
  const s = session || {};
  if (s.keyProblem === 'reauth') return 'confirm';
  if (s.keyProblem) return 'retry';
  const account = s.account || null;
  const keys = Array.isArray(s.keys) ? s.keys : [];
  // an Easy account that has a name and a stored key is never asked for a name again
  if (account && account.displayName && !account.strict && keys.some((k) => k && k.hasCloudCopy)) return 'confirm';
  return 'name';
}

// The words for each kind, so every screen says the same thing.
export const NEEDS_KEY_COPY = Object.freeze({
  name: Object.freeze({
    action: 'Choose your name',
    banner: 'One more step: choose the name people will see.',
    files: 'Pick the name people will see, then your files show up here.',
    write: 'Choose your name to write here.',
    prompt: 'Pick the name people will see, then you can do this.'
  }),
  confirm: Object.freeze({
    action: 'Confirm it is you',
    banner: 'One more step: confirm it is you with a new email code, so this device can use your key.',
    files: 'Your key is kept by your account. Confirm it is you with a new email code, then your files show up here.',
    write: 'Confirm it is you to write here.',
    prompt: 'Your key is kept by your account. Confirm it is you with a new email code, then you can do this.'
  }),
  retry: Object.freeze({
    action: 'Try again',
    banner: 'Your key could not be loaded just now.',
    files: 'Your key could not be loaded just now. Try again, then your files show up here.',
    write: 'Your key could not be loaded just now.',
    prompt: 'Your key could not be loaded just now. Try again, then you can do this.'
  })
});
