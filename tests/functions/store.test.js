// The file store layer: KV and R2 answer the same calls, and a bad upload leaves nothing behind.
import { describe, expect, it } from 'vitest';
import { KV_MAX_VALUE_BYTES, blobStore } from '../../functions/_lib/store.js';
import { ApiError } from '../../functions/_lib/errors.js';
import { sha256Hex } from '../../shared/hash.js';
import { LIMITS } from '../../shared/records.js';
import { fakeKV, fakeR2, lockedBytes, streamOfBytes } from './fakes.js';

async function readAll(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('choosing the store', () => {
  it('uses KV when only BLOBS is bound and R2 when FILES is bound', () => {
    expect(blobStore({ BLOBS: fakeKV() }).kind).toBe('kv');
    expect(blobStore({ FILES: fakeR2() }).kind).toBe('r2');
    expect(blobStore({ FILES: fakeR2(), BLOBS: fakeKV() }).kind).toBe('r2');
  });

  it('says plainly when there is no file storage', () => {
    expect(() => blobStore({})).toThrow(/KV namespace as BLOBS/);
    expect(() => blobStore(undefined)).toThrow(/no file storage/);
  });

  it('keeps the app file limit under the KV value limit with room for the lock overhead', () => {
    expect(LIMITS.MAX_BLOB_BYTES).toBeLessThan(KV_MAX_VALUE_BYTES);
    expect(LIMITS.MAX_FILE_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe.each([
  ['kv', () => ({ raw: fakeKV() }), (raw) => blobStore({ BLOBS: raw })],
  ['r2', () => ({ raw: fakeR2() }), (raw) => blobStore({ FILES: raw })]
])('the %s store', (name, make, open) => {
  it('writes, reads back byte for byte, reports the size and deletes', async () => {
    const { raw } = make();
    const store = open(raw);
    const bytes = lockedBytes(5000);
    const hash = await sha256Hex(bytes);
    expect(await store.head('blobs/' + hash)).toBeNull();
    expect(await store.get('blobs/' + hash)).toBeNull();

    const written = await store.put('blobs/' + hash, streamOfBytes(bytes, 777), { sha256: hash, size: bytes.length });
    expect(written.size).toBe(bytes.length);
    expect((await store.head('blobs/' + hash)).size).toBe(bytes.length);

    const got = await store.get('blobs/' + hash);
    expect(got.size).toBe(bytes.length);
    expect(await readAll(got.body)).toEqual(bytes);

    await store.delete('blobs/' + hash);
    expect(await store.head('blobs/' + hash)).toBeNull();
  });

  it('refuses bytes that do not match the hash and stores nothing', async () => {
    const { raw } = make();
    const store = open(raw);
    const bytes = lockedBytes(2000);
    const wrong = await sha256Hex(lockedBytes(2000));
    await expect(store.put('blobs/x', streamOfBytes(bytes), { sha256: wrong, size: bytes.length })).rejects.toThrow(
      /checksum|sha-?256/i
    );
    expect(await store.head('blobs/x')).toBeNull();
  });
});

describe('the kv store in detail', () => {
  it('refuses a body that is shorter or longer than declared, and stores nothing', async () => {
    const kv = fakeKV();
    const store = blobStore({ BLOBS: kv });
    const bytes = lockedBytes(1000);
    await expect(store.put('blobs/a', streamOfBytes(bytes), { size: bytes.length + 1 })).rejects.toThrow(/shorter/);
    await expect(store.put('blobs/b', streamOfBytes(bytes), { size: bytes.length - 1 })).rejects.toThrow(/longer/);
    expect(kv.objects.size).toBe(0);
  });

  it('passes a stream error through, so the header check can stop an upload', async () => {
    const kv = fakeKV();
    const store = blobStore({ BLOBS: kv });
    const broken = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(10));
        c.error(new Error('the file does not start with a locked file header'));
      }
    });
    await expect(store.put('blobs/c', broken, { size: 100 })).rejects.toThrow(/locked file header/);
    expect(kv.objects.size).toBe(0);
  });

  it('turns a KV write limit answer into a rate_limited error with a long retry time', async () => {
    const kv = fakeKV();
    const store = blobStore({ BLOBS: kv });
    const bytes = lockedBytes(500);
    kv.failNextPut('KV PUT failed: 429 Too Many Requests');
    const err = await store.put('blobs/d', streamOfBytes(bytes), { size: bytes.length }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('rate_limited');
    expect(String(err.headers && err.headers['Retry-After'])).toBe('3600');
    // other KV failures are not hidden as a rate limit
    kv.failNextPut('KV PUT failed: 500 Internal Server Error');
    const other = await store.put('blobs/e', streamOfBytes(bytes), { size: bytes.length }).catch((e) => e);
    expect(other).not.toBeInstanceOf(ApiError);
    expect(String(other.message)).toMatch(/500/);
  });

  it('notes the size next to the value and finds it again with head, without reading the value', async () => {
    const kv = fakeKV();
    const store = blobStore({ BLOBS: kv });
    const bytes = lockedBytes(3000);
    await store.put('blobs/f', streamOfBytes(bytes), { size: bytes.length });
    expect(kv.notes.get('blobs/f')).toEqual({ size: 3000 });
    expect(await store.head('blobs/f')).toEqual({ key: 'blobs/f', size: 3000 });
  });

  it('still answers for a value that has no size note by counting its bytes', async () => {
    const kv = fakeKV();
    const store = blobStore({ BLOBS: kv });
    const bytes = lockedBytes(1234);
    kv.objects.set('blobs/g', bytes);
    expect((await store.head('blobs/g')).size).toBe(1234);
    const got = await store.get('blobs/g');
    expect(got.size).toBe(1234);
    expect(await readAll(got.body)).toEqual(bytes);
  });

  it('handles a file at the app limit in one value', async () => {
    const kv = fakeKV();
    const store = blobStore({ BLOBS: kv });
    const size = LIMITS.MAX_BLOB_BYTES;
    const bytes = new Uint8Array(size);
    bytes[0] = 7;
    const hash = await sha256Hex(bytes);
    const out = await store.put('blobs/h', streamOfBytes(bytes, 1 << 20), { sha256: hash, size });
    expect(out.size).toBe(size);
    expect((await store.head('blobs/h')).size).toBe(size);
  });
});
