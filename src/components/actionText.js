// Plain words for the errors of the actions that may ask for a new email code (Strict mode, deleting the account,
// loading the key on a new device, the "Confirm it is you" sheet) and of the devices list.
import { authErrorText, plainErrorText } from '../lib/authText.js';

// Errors made by the session code itself. They carry a plain sentence already, and have no HTTP status.
const OWN_SENTENCE = new Set(['cancelled', 'reauth_failed', 'wrong_account', 'strict_unfinished', 'strict_answer']);

export function actionErrorText(err) {
  if (err && OWN_SENTENCE.has(err.code) && err.message) return String(err.message);
  return err && err.code ? authErrorText(err) : plainErrorText(err);
}

export { actionErrorText as default };
