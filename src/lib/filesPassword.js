// The files password: chosen once by the person, never sent anywhere. It is stretched with PBKDF2 into a
// password in the same shape as a generated one (20 letters and digits), and that is what the locking code
// gets. The account id is the salt, so the same words give a different result for every account.
const ITERATIONS = 600000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // the same 32 characters as generated passwords
export const FILES_PASSWORD_MIN = 10;
export const FILES_PASSWORD_MAX = 128;

// '' when the password is fine, otherwise a plain sentence that says what to change.
export function filesPasswordProblem(password) {
  if (typeof password !== 'string') return 'Type a password.';
  const length = Array.from(password).length;
  if (length < FILES_PASSWORD_MIN) return `Use at least ${FILES_PASSWORD_MIN} characters.`;
  if (length > FILES_PASSWORD_MAX) return `Use at most ${FILES_PASSWORD_MAX} characters.`;
  if (!password.trim()) return 'Use more than spaces.';
  return '';
}

// The password for lockFile and unlockFile. Takes about half a second (the stretching is on purpose).
export async function lockPasswordFor(password, accountId, iterations = ITERATIONS) {
  const problem = filesPasswordProblem(password);
  if (problem) throw new Error(problem);
  if (typeof accountId !== 'string' || !/^[0-9a-f]{32}$/.test(accountId)) throw new Error('bad account id');
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const salt = await crypto.subtle.digest('SHA-256', enc.encode('hrdlock/files-password/v1|' + accountId));
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 160));
  let out = '';
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += ALPHABET[bits[i] & 31];
  }
  return out;
}

// A fingerprint of the files password (64 hex characters), kept on the server so a typo is caught before a file
// is locked with the wrong key. It takes a second round of stretching, so guessing against it is no cheaper
// than guessing against a locked file. Only needed when a file is added, opening a file checks itself.
export async function filesCheckFor(lockPassword, iterations = ITERATIONS) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(String(lockPassword)), 'PBKDF2', false, ['deriveBits']);
  const salt = enc.encode('hrdlock/files-check/v1');
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  return Array.from(bits, (b) => b.toString(16).padStart(2, '0')).join('');
}
