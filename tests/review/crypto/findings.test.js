// Review findings. Every test in this file fails against the current code on purpose.
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { lockFile, unlockFile } from '../../../src/lib/lockfile.js';

const FAST = 100000;
const enc = new TextEncoder();

describe('FINDING 1: a non string password is silently accepted', () => {
  it('lockFile refuses a missing password instead of locking with the word UNDEFINED', async () => {
    const data = new Uint8Array([1, 2, 3]);
    // a caller bug (password not loaded yet) must be an error, not a guessable lock
    let locked = null;
    try {
      locked = await lockFile({ data, name: 'a.txt', iterations: FAST });
    } catch { /* good */ }
    if (locked) {
      const back = await unlockFile(locked.bytes, 'undefined');
      expect.fail('file was locked with the guessable password UNDEFINED and no error (unlocked ' + back.data.length + ' bytes with it)');
    }
  });

  it('lockFile refuses null, numbers, arrays and objects as passwords', async () => {
    for (const password of [null, 12345678, ['ABCD', 'EFGH'], { a: 1 }, true]) {
      let ok = false;
      try {
        await lockFile({ data: new Uint8Array(1), name: 'a', password, iterations: FAST });
        ok = true;
      } catch { /* good */ }
      expect(ok, 'accepted password of type ' + typeof password).toBe(false);
    }
  });

  it('unlockFile only ever throws the documented messages, even for a symbol password', async () => {
    const r = await lockFile({ data: new Uint8Array(1), name: 'a', password: 'ABCD-EFGH', iterations: FAST });
    let err;
    try { await unlockFile(r.bytes, Symbol('x')); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect([
      'this is not a hrdlock file', 'bad file header',
      'wrong password, or the file was changed', 'file is damaged'
    ]).toContain(err.message);
  });
});

// PBKDF2-HMAC-SHA256 block number `index` only, computed with node:crypto
function pbkdf2Block(password, salt, iterations, index) {
  const first = createHmac('sha256', password).update(salt).update(Buffer.from([0, 0, 0, index])).digest();
  let u = first;
  const t = Buffer.from(first);
  for (let i = 1; i < iterations; i++) {
    u = createHmac('sha256', password).update(u).digest();
    for (let j = 0; j < 32; j++) t[j] ^= u[j];
  }
  return t;
}

describe('FINDING 2: asking PBKDF2 for 128 bytes gives a password guesser a 4x discount', () => {
  it('the check code key is one single PBKDF2 block, so a guess needs 1/4 of the honest work', async () => {
    const password = 'ABCD-EFGH-JKLM-NPQR-STUV';
    const r = await lockFile({ data: new Uint8Array([5]), name: 'a', password, iterations: FAST });
    const salt = r.bytes.slice(13, 29);
    const norm = enc.encode(password.replace(/[\s-]/g, '').toUpperCase());

    // the attacker computes ONLY block 4 (bytes 96..127 of the output), not all four blocks
    const macKey = pbkdf2Block(Buffer.from(norm), Buffer.from(salt), FAST, 4);
    const macOnFile = r.bytes.slice(r.bytes.length - 32);
    const expected = createHmac('sha256', macKey).update(r.bytes.subarray(0, r.bytes.length - 32)).digest();
    const attackerCanVerifyWithOneBlock = Buffer.from(macOnFile).equals(expected);

    // a sound design makes every password check cost the full iteration count for the honest user
    // as well, so verifying must NOT be possible from a quarter of the derived output
    expect(attackerCanVerifyWithOneBlock).toBe(false);
  }, 60000);
});
