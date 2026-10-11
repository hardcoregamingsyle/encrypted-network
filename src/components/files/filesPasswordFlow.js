// What happens when the files password prompt is sent. check is the fingerprint kept on the account (null when the
// password was never set). Gives back the password for the locking code, or throws an Error with a plain sentence.
import { filesCheckFor, filesPasswordProblem, lockPasswordFor } from '../../lib/filesPassword.js';

export const NOT_THE_SAME = 'The two passwords are not the same.';
export const NOT_YOURS = 'That is not your files password.';
export const SET_ELSEWHERE = 'Your files password was just set on another device. Enter it again.';

// purpose: 'add' (lock a new file, the password is checked first so a typo cannot lock a file with a wrong key)
// or 'open' (opening a file checks the password itself). api.putCheck(check) sets the fingerprint once.
export async function submitFilesPassword({ password, again, accountId, purpose, check, iterations }, { putCheck }) {
  const problem = filesPasswordProblem(password);
  if (problem) throw new Error(problem);
  if (check === null && password !== again) throw new Error(NOT_THE_SAME);
  const lock = await lockPasswordFor(password, accountId, iterations);
  if (check === null) {
    try {
      await putCheck(await filesCheckFor(lock, iterations));
    } catch (err) {
      if (err && err.code === 'conflict') throw new Error(SET_ELSEWHERE);
      throw err;
    }
  } else if (purpose === 'add' && (await filesCheckFor(lock, iterations)) !== check) {
    throw new Error(NOT_YOURS);
  }
  return lock;
}
