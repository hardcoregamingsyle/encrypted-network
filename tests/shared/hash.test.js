import { describe, expect, it } from 'vitest';
import { ZERO_HASH, chainHash, computeCommitment, sha256Bytes, sha256Hex } from '../../shared/hash.js';
import { bytesToHex, concatBytes, utf8Encode } from '../../shared/encoding.js';

describe('sha256', () => {
  it('matches known vectors', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    );
  });
  it('hashes strings as UTF-8', async () => {
    expect(await sha256Hex('é')).toBe(await sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });
  it('accepts Uint8Array, ArrayBuffer and views', async () => {
    const want = await sha256Hex('abc');
    expect(await sha256Hex(utf8Encode('abc'))).toBe(want);
    expect(await sha256Hex(utf8Encode('abc').buffer)).toBe(want);
    const big = concatBytes(new Uint8Array([9, 9]), utf8Encode('abc'), new Uint8Array([9]));
    expect(await sha256Hex(big.subarray(2, 5))).toBe(want);
  });
  it('returns 32 bytes and 64 lowercase hex chars', async () => {
    expect((await sha256Bytes('x')).length).toBe(32);
    expect(await sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('hashes large input', async () => {
    const big = new Uint8Array(5 * 1024 * 1024).fill(7);
    expect(await sha256Hex(big)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects non bytes', async () => {
    await expect(sha256Hex(5)).rejects.toThrow();
    await expect(sha256Hex(null)).rejects.toThrow();
  });
});

describe('chainHash', () => {
  it('is sha256 of "prev:h" in ascii', async () => {
    const h = 'a'.repeat(64);
    expect(await chainHash(ZERO_HASH, h)).toBe(await sha256Hex(`${ZERO_HASH}:${h}`));
  });
  it('depends on order and both inputs', async () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(await chainHash(a, b)).not.toBe(await chainHash(b, a));
    expect(await chainHash(a, b)).not.toBe(await chainHash(a, a));
  });
  it('known vector', async () => {
    // sha256("0000...0:0000...0")
    expect(await chainHash(ZERO_HASH, ZERO_HASH)).toBe(await sha256Hex('0'.repeat(64) + ':' + '0'.repeat(64)));
  });
});

describe('computeCommitment', () => {
  const salt = '00112233445566778899aabbccddeeff';
  const fileHash = 'ab'.repeat(32);
  it('is sha256 of tag, salt bytes and file hash bytes', async () => {
    const bytes = concatBytes(
      utf8Encode('hrdlock/v2/commit'),
      new Uint8Array(16).map((_, i) => parseInt(salt.slice(i * 2, i * 2 + 2), 16)),
      new Uint8Array(32).fill(0xab)
    );
    expect(await computeCommitment({ fileHash, commitSalt: salt })).toBe(bytesToHex(await sha256Bytes(bytes)));
  });
  it('changes with salt and with file hash', async () => {
    const base = await computeCommitment({ fileHash, commitSalt: salt });
    expect(await computeCommitment({ fileHash, commitSalt: salt.replace('00', '01') })).not.toBe(base);
    expect(await computeCommitment({ fileHash: 'cd'.repeat(32), commitSalt: salt })).not.toBe(base);
  });
  it('throws on bad lengths and non hex', async () => {
    await expect(computeCommitment({ fileHash: 'ab', commitSalt: salt })).rejects.toThrow();
    await expect(computeCommitment({ fileHash, commitSalt: 'ab' })).rejects.toThrow();
    await expect(computeCommitment({ fileHash: 'zz'.repeat(32), commitSalt: salt })).rejects.toThrow();
    await expect(computeCommitment({ fileHash, commitSalt: salt.toUpperCase() })).rejects.toThrow();
  });
});
