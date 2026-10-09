import { describe, it, expect, afterEach, vi } from 'vitest';
import { lockInWorker, unlockInWorker, resetCipherClient } from '../../src/lib/cipherClient.js';
import { handleCipherMessage } from '../../src/lib/cipher.worker.js';
import { generatePassword, lockFile } from '../../src/lib/lockfile.js';

const FAST = 100000;
const password = generatePassword();

afterEach(() => {
  vi.unstubAllGlobals();
  resetCipherClient();
});

describe('cipherClient fallback (no Worker, as in Node)', () => {
  it('Worker is really undefined here', () => {
    expect(typeof Worker).toBe('undefined');
  });

  it('lock and unlock run on the main thread and return the documented shapes', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const r = await lockInWorker({ data, name: 'five.bin', password, iterations: FAST });
    expect(Object.keys(r).sort()).toEqual(['blobHash', 'bytes', 'commitSalt', 'commitment', 'fileHash', 'size']);
    expect(r.bytes).toBeInstanceOf(Uint8Array);
    expect(r.size).toBe(r.bytes.length);
    // caller's buffer is left alone
    expect(Array.from(data)).toEqual([1, 2, 3, 4, 5]);

    const back = await unlockInWorker({ bytes: r.bytes, password });
    expect(Object.keys(back).sort()).toEqual(['commitSalt', 'commitment', 'data', 'fileHash', 'name']);
    expect(back.name).toBe('five.bin');
    expect(Array.from(back.data)).toEqual([1, 2, 3, 4, 5]);
    expect(back.commitment).toBe(r.commitment);
  });

  it('errors keep their exact messages', async () => {
    const r = await lockInWorker({ data: new Uint8Array(3), name: 'a', password, iterations: FAST });
    await expect(unlockInWorker({ bytes: r.bytes, password: generatePassword() })).rejects.toThrow('wrong password, or the file was changed');
    await expect(unlockInWorker({ bytes: new Uint8Array(10), password })).rejects.toThrow('this is not a hrdlock file');
  });
});

describe('cipher worker message handler', () => {
  it('handles lock and unlock and lists result buffers for transfer', async () => {
    const lock = await handleCipherMessage({ id: 7, op: 'lock', data: new Uint8Array([9, 9]), name: 'n', password, iterations: FAST });
    expect(lock.reply.id).toBe(7);
    expect(lock.reply.ok).toBe(true);
    expect(lock.transfer).toEqual([lock.reply.result.bytes.buffer]);

    const unlock = await handleCipherMessage({ id: 8, op: 'unlock', bytes: lock.reply.result.bytes, password });
    expect(unlock.reply).toMatchObject({ id: 8, ok: true });
    expect(Array.from(unlock.reply.result.data)).toEqual([9, 9]);
    expect(unlock.transfer).toEqual([unlock.reply.result.data.buffer]);
  });

  it('turns errors and unknown operations into error replies', async () => {
    const bad = await handleCipherMessage({ id: 1, op: 'unlock', bytes: new Uint8Array(5), password });
    expect(bad.reply).toEqual({ id: 1, ok: false, error: 'this is not a hrdlock file' });
    expect(bad.transfer).toEqual([]);
    const unknown = await handleCipherMessage({ id: 2, op: 'explode' });
    expect(unknown.reply.ok).toBe(false);
    const empty = await handleCipherMessage(null);
    expect(empty.reply.ok).toBe(false);
  });
});

// a stand in for the browser Worker that runs the real message handler
function installFakeWorker({ crash = false } = {}) {
  const made = [];
  class FakeWorker {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.terminated = false;
      this.transferLists = [];
      made.push(this);
    }
    postMessage(msg) {
      if (crash) {
        setTimeout(() => this.onerror && this.onerror(new Error('boom')), 0);
        return;
      }
      // structured clone like a real worker would do
      const copy = structuredClone(msg);
      handleCipherMessage(copy).then(({ reply, transfer }) => {
        this.transferLists.push(transfer);
        setTimeout(() => this.onmessage && this.onmessage({ data: reply }), 0);
      });
    }
    terminate() { this.terminated = true; }
  }
  vi.stubGlobal('Worker', FakeWorker);
  return made;
}

describe('cipherClient with a Worker', () => {
  it('uses a module worker from a same origin file and matches replies by id', async () => {
    const made = installFakeWorker();
    const [a, b] = await Promise.all([
      lockInWorker({ data: new Uint8Array([1]), name: 'a', password, iterations: FAST }),
      lockInWorker({ data: new Uint8Array([2]), name: 'b', password, iterations: FAST })
    ]);
    expect(made.length).toBe(1);
    expect(made[0].opts).toEqual({ type: 'module' });
    expect(String(made[0].url)).toMatch(/cipher\.worker\.js$/);
    const [ra, rb] = await Promise.all([
      unlockInWorker({ bytes: a.bytes, password }),
      unlockInWorker({ bytes: b.bytes, password })
    ]);
    expect(ra.name).toBe('a');
    expect(rb.name).toBe('b');
    expect(Array.from(ra.data)).toEqual([1]);
    expect(Array.from(rb.data)).toEqual([2]);
    expect(made.length).toBe(1);
  });

  it('rejects with the worker error message', async () => {
    installFakeWorker();
    await expect(unlockInWorker({ bytes: new Uint8Array(4), password })).rejects.toThrow('this is not a hrdlock file');
  });

  it('falls back to the main thread when the worker crashes', async () => {
    installFakeWorker({ crash: true });
    const r = await lockInWorker({ data: new Uint8Array([5, 6]), name: 'c', password, iterations: FAST });
    const direct = await lockFile({ data: new Uint8Array([5, 6]), name: 'c', password, iterations: FAST });
    expect(r.fileHash).toBe(direct.fileHash);
    // later calls skip the broken worker and still work
    const back = await unlockInWorker({ bytes: r.bytes, password });
    expect(Array.from(back.data)).toEqual([5, 6]);
  });

  it('falls back when the Worker constructor throws', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('no workers'); } });
    const r = await lockInWorker({ data: new Uint8Array([4]), name: 'd', password, iterations: FAST });
    expect((await unlockInWorker({ bytes: r.bytes, password })).name).toBe('d');
  });
});
