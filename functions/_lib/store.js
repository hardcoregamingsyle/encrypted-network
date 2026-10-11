// Where the locked files live. Workers KV when the BLOBS binding exists, R2 when the FILES binding
// exists (R2 wins if both are there). Both answer the same four calls, so the rest of the server does
// not care which one it has:
//   head(key)                              -> { size } or null
//   get(key)                               -> { size, body } or null
//   put(key, readable, { sha256, size })   -> { size }   (throws when the bytes do not match sha256)
//   delete(key)
//
// KV holds one value of at most 25 MiB, so the file limit of the whole app (shared/records.js) is
// 20 MiB. A value is only written after its sha256 was checked, so a wrong upload leaves nothing behind.
import { sha256Hex } from '../../shared/hash.js';
import { ApiError } from './errors.js';

export const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024;

// Same wording R2 uses, so the upload code can recognise a checksum failure from either store.
const CHECKSUM_TEXT = 'put: The SHA-256 checksum you specified did not match what we received. (10037)';

export function blobStore(env) {
  if (env && env.FILES) return r2Store(env.FILES);
  if (env && env.BLOBS) return kvStore(env.BLOBS);
  throw new Error('no file storage: bind a KV namespace as BLOBS (or an R2 bucket as FILES)');
}

function r2Store(bucket) {
  return {
    kind: 'r2',
    head: (key) => bucket.head(key),
    get: (key) => bucket.get(key),
    put: (key, readable, { sha256 }) => bucket.put(key, readable, sha256 ? { sha256 } : undefined),
    delete: (key) => bucket.delete(key)
  };
}

// Reads a stream of exactly `size` bytes into one buffer. Errors from the stream pass through.
async function readExactly(readable, size) {
  const out = new Uint8Array(size);
  let at = 0;
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > size) {
      reader.cancel().catch(() => {});
      throw new Error('put: the body is longer than its declared length');
    }
    out.set(value, at);
    at += value.length;
  }
  if (at !== size) throw new Error('put: the body is shorter than its declared length');
  return out;
}

// KV answers 429 when a write limit is reached (the free plan allows 1000 writes a day).
function kvError(err) {
  const text = String((err && err.message) || err);
  if (/429|too many requests|rate limit|limit exceeded/i.test(text)) {
    return new ApiError('rate_limited', 'the file store has reached its write limit, try again later', {
      headers: { 'Retry-After': 3600 }
    });
  }
  return err;
}

function sizeOf(item) {
  const m = item && item.metadata;
  return m && Number.isSafeInteger(m.size) ? m.size : null;
}

function kvStore(kv) {
  async function open(key) {
    const item = await kv.getWithMetadata(key, { type: 'stream' });
    if (!item || item.value === null || item.value === undefined) return null;
    return item;
  }
  return {
    kind: 'kv',
    async head(key) {
      const item = await open(key);
      if (!item) return null;
      let size = sizeOf(item);
      if (size === null) {
        // No size noted (not written by this server): count the bytes instead.
        size = (await new Response(item.value).arrayBuffer()).byteLength;
      } else {
        item.value.cancel().catch(() => {});
      }
      return { key, size };
    },
    async get(key) {
      const item = await open(key);
      if (!item) return null;
      const size = sizeOf(item);
      if (size === null) {
        const bytes = new Uint8Array(await new Response(item.value).arrayBuffer());
        return { key, size: bytes.length, body: new Blob([bytes]).stream() };
      }
      return { key, size, body: item.value };
    },
    async put(key, readable, { sha256, size }) {
      const bytes = await readExactly(readable, size);
      if (sha256 && (await sha256Hex(bytes)) !== sha256) throw new Error(CHECKSUM_TEXT);
      try {
        await kv.put(key, bytes, { metadata: { size: bytes.length } });
      } catch (err) {
        throw kvError(err);
      }
      return { key, size: bytes.length };
    },
    async delete(key) {
      await kv.delete(key);
    }
  };
}
