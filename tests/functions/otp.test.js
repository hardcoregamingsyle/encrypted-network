// One time codes: generation (uniform), comparison (constant time helper), cleaning, and the stored state.
import { describe, expect, it } from 'vitest';
import {
  OTP_COOLDOWN_MS,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  checkCode,
  cleanCode,
  constantTimeEqual,
  cooldownLeft,
  dropCode,
  generateCode,
  storeCode
} from '../../functions/_lib/otp.js';
import { accountEnv } from './fakes.js';

const LIMIT = 4294000000; // the largest multiple of 1,000,000 that fits in 32 bits

describe('generateCode', () => {
  it('is 6 digits, leading zeros kept', () => {
    for (let i = 0; i < 2000; i++) expect(generateCode()).toMatch(/^[0-9]{6}$/);
    expect(generateCode(() => 5)).toBe('000005');
    expect(generateCode(() => 0)).toBe('000000');
    expect(generateCode(() => 999999)).toBe('999999');
    expect(generateCode(() => 1000000)).toBe('000000');
  });

  it('throws away values that would make some codes likelier (rejection sampling)', () => {
    const asked = [];
    const seq = [4294967295, LIMIT, LIMIT + 1, LIMIT - 1];
    const code = generateCode(() => {
      const v = seq[asked.length];
      asked.push(v);
      return v;
    });
    // the first three are at or above the limit and are discarded, the fourth is used
    expect(asked.length).toBe(4);
    expect(code).toBe('999999');
  });

  it('every residue is equally likely in the accepted range (no modulo bias)', () => {
    // the accepted range is an exact multiple of 10^6, so each code has the same number of sources
    expect(LIMIT % 1000000).toBe(0);
    expect(Math.floor(0x100000000 / 1000000) * 1000000).toBe(LIMIT);
    // a naive modulo of the full 32 bit range would favour the first 967296 codes
    expect(0x100000000 % 1000000).toBe(967296);
    // walk across a boundary: LIMIT - 1 maps to 999999 and the next value is thrown away
    expect(generateCode(() => LIMIT - 1)).toBe('999999');
    let draws = 0;
    expect(generateCode(() => (draws++ === 0 ? LIMIT : 42))).toBe('000042');
    expect(draws).toBe(2);
  });

  it('looks uniform in each digit position over many draws', () => {
    const N = 60000;
    const counts = Array.from({ length: 6 }, () => new Array(10).fill(0));
    for (let i = 0; i < N; i++) {
      const c = generateCode();
      for (let d = 0; d < 6; d++) counts[d][Number(c[d])]++;
    }
    for (let d = 0; d < 6; d++) {
      const expected = N / 10;
      const chi = counts[d].reduce((sum, n) => sum + (n - expected) ** 2 / expected, 0);
      // 9 degrees of freedom: 40 is far beyond the 99.99th percentile
      expect(chi, 'position ' + d).toBeLessThan(40);
    }
  });

  it('rarely repeats', () => {
    const seen = new Set();
    for (let i = 0; i < 300; i++) seen.add(generateCode());
    expect(seen.size).toBeGreaterThan(290);
  });
});

describe('constantTimeEqual', () => {
  it('compares strings exactly', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
    expect(constantTimeEqual('ab', 'abc')).toBe(false);
    expect(constantTimeEqual('abc', 'ABC')).toBe(false);
    expect(constantTimeEqual('a'.repeat(64), 'a'.repeat(63) + 'b')).toBe(false);
    expect(constantTimeEqual('caf\u00e9', 'caf\u00e9')).toBe(true);
    expect(constantTimeEqual('caf\u00e9', 'cafe\u0301')).toBe(false);
  });

  it('is false for anything that is not two strings', () => {
    for (const [a, b] of [[null, null], [undefined, undefined], [1, 1], ['1', 1], [['a'], ['a']], [{}, {}]]) {
      expect(constantTimeEqual(a, b)).toBe(false);
    }
  });

  it('checks every position: a difference in the first, middle or last byte is found', () => {
    const base = 'f'.repeat(64);
    for (const i of [0, 31, 63]) {
      const other = base.slice(0, i) + '0' + base.slice(i + 1);
      expect(constantTimeEqual(base, other)).toBe(false);
    }
  });
});

describe('cleanCode', () => {
  it('takes six digits, with blanks allowed', () => {
    expect(cleanCode('123456')).toBe('123456');
    expect(cleanCode(' 123 456 ')).toBe('123456');
    expect(cleanCode('000000')).toBe('000000');
    expect(cleanCode('1\t2\n3 4 5 6')).toBe('123456');
  });
  it('refuses everything else', () => {
    for (const v of [undefined, null, 123456, '', '12345', '1234567', '12-3456', 'abcdef', '12345a', '\u0661\u0662\u0663\u0664\u0665\u0666', '1'.repeat(40), '12345\u200b6', '+123456', '1e5555']) {
      expect(cleanCode(v), String(v)).toBeNull();
    }
  });
});

describe('the stored code', () => {
  const H = 'a'.repeat(64);

  it('a stored code lives 10 minutes and the cooldown is 30 seconds', () => {
    expect(OTP_TTL_MS).toBe(600000);
    expect(OTP_COOLDOWN_MS).toBe(30000);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
  });

  it('storeCode refuses to replace a code that is younger than the cooldown', async () => {
    const { env, db } = accountEnv();
    expect(await storeCode(env, H, 'c1', 100000)).toBe(true);
    expect(await cooldownLeft(env, H, 100000)).toBe(30);
    expect(await cooldownLeft(env, H, 110000)).toBe(20);
    expect(await storeCode(env, H, 'c2', 129999)).toBe(false);
    expect(db.prepare('SELECT code_hash FROM otp_codes').get().code_hash).toBe('c1');
    expect(await cooldownLeft(env, H, 130000)).toBe(0);
    expect(await storeCode(env, H, 'c2', 130000)).toBe(true);
    const row = db.prepare('SELECT * FROM otp_codes').get();
    expect(row.code_hash).toBe('c2');
    expect(row.attempts).toBe(0);
    expect(row.expires_at).toBe(130000 + OTP_TTL_MS);
  });

  it('a new code starts again at zero tries', async () => {
    const { env, db } = accountEnv();
    await storeCode(env, H, 'c1', 1000);
    await expect(checkCode(env, H, 'nope', 2000)).rejects.toMatchObject({ code: 'invalid_code' });
    expect(db.prepare('SELECT attempts FROM otp_codes').get().attempts).toBe(1);
    await storeCode(env, H, 'c2', 40000);
    expect(db.prepare('SELECT attempts FROM otp_codes').get().attempts).toBe(0);
  });

  it('dropCode removes only the code that was stored', async () => {
    const { env, db } = accountEnv();
    await storeCode(env, H, 'c1', 1000);
    await dropCode(env, H, 'other');
    expect(db.prepare('SELECT COUNT(*) AS n FROM otp_codes').get().n).toBe(1);
    await dropCode(env, H, 'c1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM otp_codes').get().n).toBe(0);
  });

  it('checkCode: right code is used up, wrong ones are counted, dead after five, expired is removed', async () => {
    const { env, db } = accountEnv();
    await storeCode(env, H, 'right', 1000);
    await expect(checkCode(env, H, 'wrong', 2000)).rejects.toMatchObject({ code: 'invalid_code', status: 400 });
    await checkCode(env, H, 'right', 3000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM otp_codes').get().n).toBe(0);
    await expect(checkCode(env, H, 'right', 3500)).rejects.toMatchObject({ code: 'code_expired' });

    await storeCode(env, H, 'right', 1000);
    const outcomes = [];
    for (let i = 0; i < 7; i++) {
      try {
        await checkCode(env, H, 'wrong', 2000);
      } catch (err) {
        outcomes.push(err.code);
      }
    }
    expect(outcomes).toEqual(['invalid_code', 'invalid_code', 'invalid_code', 'invalid_code', 'too_many_attempts', 'too_many_attempts', 'too_many_attempts']);
    await expect(checkCode(env, H, 'right', 2500)).rejects.toMatchObject({ code: 'too_many_attempts', status: 429 });

    await storeCode(env, 'b'.repeat(64), 'right', 1000);
    await expect(checkCode(env, 'b'.repeat(64), 'right', 1000 + OTP_TTL_MS)).rejects.toMatchObject({ code: 'code_expired' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM otp_codes WHERE email_hash = ?").get('b'.repeat(64)).n).toBe(0);
  });

  it('two right answers at once: only one wins', async () => {
    const { env } = accountEnv();
    await storeCode(env, H, 'right', 1000);
    const results = await Promise.allSettled([checkCode(env, H, 'right', 2000), checkCode(env, H, 'right', 2000), checkCode(env, H, 'right', 2000)]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect(r.reason.code).toBe('code_expired');
  });
});
