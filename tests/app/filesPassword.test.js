import { describe, expect, it } from 'vitest';
import { FILES_PASSWORD_MAX, FILES_PASSWORD_MIN, filesCheckFor, filesPasswordProblem, lockPasswordFor } from '../../src/lib/filesPassword.js';
import { lockFile, unlockFile } from '../../src/lib/lockfile.js';

const ACCOUNT = 'a'.repeat(32);
const FAST = 1000; // iterations for the tests that only look at the result, the lock test below uses the real default

describe('filesPasswordProblem', () => {
  it('accepts a long enough password and says what is wrong otherwise', () => {
    expect(filesPasswordProblem('correct horse battery')).toBe('');
    expect(filesPasswordProblem('x'.repeat(FILES_PASSWORD_MIN))).toBe('');
    expect(filesPasswordProblem('x'.repeat(FILES_PASSWORD_MIN - 1))).toMatch(/at least 10/);
    expect(filesPasswordProblem('x'.repeat(FILES_PASSWORD_MAX + 1))).toMatch(/at most 128/);
    expect(filesPasswordProblem(' '.repeat(12))).toMatch(/spaces/);
    for (const bad of [undefined, null, 12345678901, ['abcdefghijkl']]) expect(filesPasswordProblem(bad)).toMatch(/Type a password/);
  });

  it('counts a character with an accent or an emoji as one', () => {
    expect(filesPasswordProblem('\u00e9'.repeat(10))).toBe('');
    expect(filesPasswordProblem('\u{1F511}'.repeat(10))).toBe('');
  });
});

describe('lockPasswordFor', () => {
  it('gives a 20 character password in the shape of a generated one, the same every time', async () => {
    const a = await lockPasswordFor('correct horse battery', ACCOUNT, FAST);
    expect(a).toMatch(/^([A-HJ-NP-Z2-9]{4}-){4}[A-HJ-NP-Z2-9]{4}$/);
    expect(await lockPasswordFor('correct horse battery', ACCOUNT, FAST)).toBe(a);
  });

  it('is different for another password, another account and another iteration count', async () => {
    const base = await lockPasswordFor('correct horse battery', ACCOUNT, FAST);
    expect(await lockPasswordFor('correct horse batterz', ACCOUNT, FAST)).not.toBe(base);
    expect(await lockPasswordFor('correct horse battery', 'b'.repeat(32), FAST)).not.toBe(base);
    expect(await lockPasswordFor('correct horse battery', ACCOUNT, FAST + 1)).not.toBe(base);
    expect(await lockPasswordFor('Correct horse battery', ACCOUNT, FAST)).not.toBe(base); // capitals count here
  });

  it('treats the same text typed with composed or separate accents as the same password', async () => {
    const composed = 'caf\u00e9 au lait 2026';
    const separate = 'cafe\u0301 au lait 2026';
    expect(await lockPasswordFor(composed, ACCOUNT, FAST)).toBe(await lockPasswordFor(separate, ACCOUNT, FAST));
  });

  it('refuses a bad password or a bad account id before doing any work', async () => {
    await expect(lockPasswordFor('short', ACCOUNT, FAST)).rejects.toThrow(/at least/);
    for (const bad of ['', 'A'.repeat(32), 'a'.repeat(31), undefined, 12]) await expect(lockPasswordFor('correct horse battery', bad, FAST)).rejects.toThrow(/account id/);
  });

  it('works with the locking code: the right password opens a file, a wrong one is refused', async () => {
    const password = await lockPasswordFor('correct horse battery', ACCOUNT); // the real iteration count
    const data = new TextEncoder().encode('private words');
    const locked = await lockFile({ data, name: 'diary.txt', password, iterations: 100000 });
    const opened = await unlockFile(locked.bytes, await lockPasswordFor('correct horse battery', ACCOUNT));
    expect(opened.name).toBe('diary.txt');
    expect(new TextDecoder().decode(opened.data)).toBe('private words');
    const wrong = await lockPasswordFor('correct horse batterz', ACCOUNT);
    await expect(unlockFile(locked.bytes, wrong)).rejects.toThrow(/wrong password/);
  }, 60000);
});

describe('filesCheckFor', () => {
  it('gives 64 hex characters, the same every time, different for another password', async () => {
    const lock = await lockPasswordFor('correct horse battery', ACCOUNT, FAST);
    const a = await filesCheckFor(lock, FAST);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await filesCheckFor(lock, FAST)).toBe(a);
    expect(await filesCheckFor(await lockPasswordFor('correct horse batterz', ACCOUNT, FAST), FAST)).not.toBe(a);
    expect(await filesCheckFor(lock, FAST + 1)).not.toBe(a);
  });

  it('does not contain the password it was made from', async () => {
    const lock = await lockPasswordFor('correct horse battery', ACCOUNT, FAST);
    const check = await filesCheckFor(lock, FAST);
    expect(check).not.toContain(lock.replace(/-/g, '').toLowerCase());
    expect(check.toUpperCase()).not.toContain(lock.replace(/-/g, ''));
  });
});
