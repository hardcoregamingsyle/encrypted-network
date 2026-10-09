import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBlobBytes, verifyPlaintext } from '../../shared/verify.js';
import { sha256Hex } from '../../shared/hash.js';
import { buildBundleParts, createIdentity } from '../helpers/bundle.js';

let parts;
beforeAll(async () => {
  const alice = await createIdentity('Alice');
  parts = await buildBundleParts({ owner: alice, versions: [{ content: 'first file' }, { content: 'second file' }] });
});

describe('verifyBlobBytes', () => {
  it('accepts the exact locked bytes', async () => {
    const v = parts.versions[0];
    const res = await verifyBlobBytes(v.lockedBytes, v.record);
    expect(res.ok).toBe(true);
    expect(typeof res.detail).toBe('string');
  });
  it('accepts an ArrayBuffer', async () => {
    const v = parts.versions[1];
    const copy = v.lockedBytes.slice();
    expect((await verifyBlobBytes(copy.buffer, v.record)).ok).toBe(true);
  });
  it('accepts a view into a bigger buffer', async () => {
    const v = parts.versions[0];
    const big = new Uint8Array(v.lockedBytes.length + 10);
    big.set(v.lockedBytes, 5);
    expect((await verifyBlobBytes(big.subarray(5, 5 + v.lockedBytes.length), v.record)).ok).toBe(true);
  });
  it('rejects the bytes of another version (swapped blob hash)', async () => {
    const res = await verifyBlobBytes(parts.versions[0].lockedBytes, parts.versions[1].record);
    expect(res.ok).toBe(false);
  });
  it('rejects one changed byte', async () => {
    const v = parts.versions[0];
    const copy = v.lockedBytes.slice();
    copy[copy.length - 1] ^= 1;
    const res = await verifyBlobBytes(copy, v.record);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/hash/);
  });
  it('rejects truncated and extended bytes by size', async () => {
    const v = parts.versions[0];
    expect((await verifyBlobBytes(v.lockedBytes.slice(1), v.record)).detail).toMatch(/size/);
    const longer = new Uint8Array(v.lockedBytes.length + 1);
    longer.set(v.lockedBytes);
    expect((await verifyBlobBytes(longer, v.record)).detail).toMatch(/size/);
  });
  it('rejects a record whose size was changed', async () => {
    const v = parts.versions[0];
    const record = { ...v.record, blob: { ...v.record.blob, size: v.record.blob.size + 1 } };
    expect((await verifyBlobBytes(v.lockedBytes, record)).ok).toBe(false);
  });
  it('rejects a record whose hash is a different case', async () => {
    const v = parts.versions[0];
    const record = { ...v.record, blob: { ...v.record.blob, hash: v.record.blob.hash.toUpperCase() } };
    expect((await verifyBlobBytes(v.lockedBytes, record)).ok).toBe(false);
  });
  it('matches the sha256 of the bytes', async () => {
    const v = parts.versions[0];
    expect(await sha256Hex(v.lockedBytes)).toBe(v.record.blob.hash);
    expect(v.lockedBytes.length).toBe(v.record.blob.size);
  });
  it('never throws on malformed input', async () => {
    const v = parts.versions[0];
    for (const bytes of [null, undefined, 'text', 5, {}, []]) {
      expect((await verifyBlobBytes(bytes, v.record)).ok).toBe(false);
    }
    for (const record of [null, undefined, {}, { blob: null }, { blob: { hash: 'x', size: 1 } }, { blob: { hash: v.record.blob.hash } }, 'r']) {
      expect((await verifyBlobBytes(v.lockedBytes, record)).ok).toBe(false);
    }
  });
  it('works for a revoke record (no file) by failing', async () => {
    const res = await verifyBlobBytes(new Uint8Array(3), { type: 'doc.revoke', reason: '' });
    expect(res.ok).toBe(false);
  });
});

describe('verifyPlaintext', () => {
  it('accepts the right fingerprint and salt', async () => {
    const v = parts.versions[0];
    const res = await verifyPlaintext({ fileHash: v.fileHash, commitSalt: v.commitSalt }, v.record);
    expect(res.ok).toBe(true);
  });
  it('rejects another file with the same salt', async () => {
    const v = parts.versions[0];
    const res = await verifyPlaintext({ fileHash: await sha256Hex('other file'), commitSalt: v.commitSalt }, v.record);
    expect(res.ok).toBe(false);
  });
  it('rejects the right file with another salt', async () => {
    const v = parts.versions[0];
    const res = await verifyPlaintext({ fileHash: v.fileHash, commitSalt: '00'.repeat(16) }, v.record);
    expect(res.ok).toBe(false);
  });
  it('rejects the file of another version', async () => {
    const [a, b] = parts.versions;
    expect((await verifyPlaintext({ fileHash: b.fileHash, commitSalt: b.commitSalt }, a.record)).ok).toBe(false);
  });
  it('rejects a changed commitment', async () => {
    const v = parts.versions[0];
    const record = { ...v.record, commitment: v.record.commitment.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) };
    expect((await verifyPlaintext({ fileHash: v.fileHash, commitSalt: v.commitSalt }, record)).ok).toBe(false);
  });
  it('never throws on malformed input', async () => {
    const v = parts.versions[0];
    const goodIn = { fileHash: v.fileHash, commitSalt: v.commitSalt };
    const badIns = [null, undefined, {}, 'x', { fileHash: v.fileHash }, { commitSalt: v.commitSalt }, { fileHash: 'zz'.repeat(32), commitSalt: v.commitSalt }, { fileHash: v.fileHash, commitSalt: v.commitSalt.toUpperCase() }, { fileHash: v.fileHash, commitSalt: 'ab' }, { fileHash: 'ab', commitSalt: v.commitSalt }, { fileHash: 5, commitSalt: 6 }];
    for (const input of badIns) expect((await verifyPlaintext(input, v.record)).ok).toBe(false);
    for (const record of [null, undefined, {}, { commitment: 'x' }, 'r']) expect((await verifyPlaintext(goodIn, record)).ok).toBe(false);
  });
});
