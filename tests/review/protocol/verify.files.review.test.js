// Adversarial review of verifyBlobBytes and verifyPlaintext.
import { describe, expect, it } from 'vitest';
import { verifyBlobBytes, verifyPlaintext } from '../../../shared/verify.js';
import { sha256Hex, computeCommitment } from '../../../shared/hash.js';
import { utf8Encode } from '../../../shared/encoding.js';

async function recordFor(bytes, extra = {}) {
  return { blob: { hash: await sha256Hex(bytes), size: bytes.length, suite: 1 }, commitment: 'c'.repeat(64), ...extra };
}

describe('verifyBlobBytes', () => {
  it('accepts exact bytes, also as ArrayBuffer and Buffer', async () => {
    const bytes = utf8Encode('locked bytes');
    const rec = await recordFor(bytes);
    expect((await verifyBlobBytes(bytes, rec)).ok).toBe(true);
    expect((await verifyBlobBytes(bytes.buffer.slice(0), rec)).ok).toBe(true);
    expect((await verifyBlobBytes(Buffer.from(bytes), rec)).ok).toBe(true);
  });

  it('rejects one flipped bit, a truncated file, an appended byte, same size different content', async () => {
    const bytes = utf8Encode('locked bytes 1234567890');
    const rec = await recordFor(bytes);
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes.slice();
      c[i] ^= 1;
      expect((await verifyBlobBytes(c, rec)).ok).toBe(false);
    }
    expect((await verifyBlobBytes(bytes.slice(0, -1), rec)).ok).toBe(false);
    expect((await verifyBlobBytes(new Uint8Array([...bytes, 0]), rec)).ok).toBe(false);
  });

  it('a signed size that lies about the content is caught even when the hash matches', async () => {
    const bytes = utf8Encode('abc');
    const rec = await recordFor(bytes);
    rec.blob.size = 4;
    expect((await verifyBlobBytes(bytes, rec)).ok).toBe(false);
  });

  it('rejects uppercase or malformed stated hashes and wrong types', async () => {
    const bytes = utf8Encode('abc');
    const rec = await recordFor(bytes);
    expect((await verifyBlobBytes(bytes, { blob: { ...rec.blob, hash: rec.blob.hash.toUpperCase() } })).ok).toBe(false);
    expect((await verifyBlobBytes(bytes, { blob: { ...rec.blob, size: '3' } })).ok).toBe(false);
    expect((await verifyBlobBytes('abc', rec)).ok).toBe(false);
    expect((await verifyBlobBytes([97, 98, 99], rec)).ok).toBe(false);
    expect((await verifyBlobBytes(new DataView(bytes.buffer), rec)).ok).toBe(false);
    expect((await verifyBlobBytes(bytes, null)).ok).toBe(false);
    expect((await verifyBlobBytes(bytes, { blob: null })).ok).toBe(false);
  });

  it('an empty file does not verify against a record that has a size', async () => {
    const rec = await recordFor(utf8Encode('abc'));
    expect((await verifyBlobBytes(new Uint8Array(0), rec)).ok).toBe(false);
  });
});

describe('verifyPlaintext', () => {
  it('accepts the right fingerprint and salt only', async () => {
    const fileHash = await sha256Hex('file');
    const commitSalt = 'ab'.repeat(16);
    const commitment = await computeCommitment({ fileHash, commitSalt });
    const rec = { commitment };
    expect((await verifyPlaintext({ fileHash, commitSalt }, rec)).ok).toBe(true);
    expect((await verifyPlaintext({ fileHash: await sha256Hex('other'), commitSalt }, rec)).ok).toBe(false);
    expect((await verifyPlaintext({ fileHash, commitSalt: 'ac'.repeat(16) }, rec)).ok).toBe(false);
    // swapped roles must not work (salt is 16 bytes, hash 32 bytes)
    expect((await verifyPlaintext({ fileHash: commitSalt.repeat(2), commitSalt: fileHash.slice(0, 32) }, rec)).ok).toBe(false);
  });

  it('rejects uppercase, short and non string inputs', async () => {
    const fileHash = await sha256Hex('file');
    const commitSalt = 'ab'.repeat(16);
    const rec = { commitment: await computeCommitment({ fileHash, commitSalt }) };
    for (const bad of [
      { fileHash: fileHash.toUpperCase(), commitSalt },
      { fileHash, commitSalt: commitSalt.toUpperCase() },
      { fileHash: fileHash.slice(2), commitSalt },
      { fileHash, commitSalt: commitSalt + 'ab' },
      { fileHash, commitSalt: 5 },
      null,
      'x',
      []
    ]) {
      expect((await verifyPlaintext(bad, rec)).ok).toBe(false);
    }
    expect((await verifyPlaintext({ fileHash, commitSalt }, { commitment: rec.commitment.toUpperCase() })).ok).toBe(false);
    expect((await verifyPlaintext({ fileHash, commitSalt }, {})).ok).toBe(false);
  });
});
