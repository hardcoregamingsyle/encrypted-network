// Review: cipherClient and cipher.worker behaviour in Node (fallback) and with a transferring fake Worker.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { lockInWorker, unlockInWorker, resetCipherClient } from '../../../src/lib/cipherClient.js';
import { handleCipherMessage } from '../../../src/lib/cipher.worker.js';
import { lockFile, unlockFile } from '../../../src/lib/lockfile.js';

const FAST = 100000;
const password = 'WXYZ-2345-ABCD-EFGH-JKLM';

afterEach(() => {
  vi.unstubAllGlobals();
  resetCipherClient();
});

describe('main thread fallback', () => {
  it('does not detach, change or reuse the caller buffers', async () => {
    const backing = new Uint8Array(1000);
    for (let i = 0; i < backing.length; i++) backing[i] = i & 255;
    const data = backing.subarray(100, 600); // a view with an offset
    const snapshot = data.slice();
    const args = Object.freeze({ data, name: 'view.bin', password, iterations: FAST });
    const r = await lockInWorker(args);
    expect(backing.buffer.byteLength).toBe(1000);
    expect(Buffer.from(data).equals(Buffer.from(snapshot))).toBe(true);
    expect(r.bytes.buffer).not.toBe(backing.buffer);

    const lockedCopy = r.bytes.slice();
    const unlockArgs = Object.freeze({ bytes: r.bytes, password });
    const back = await unlockInWorker(unlockArgs);
    expect(Buffer.from(back.data).equals(Buffer.from(snapshot))).toBe(true);
    // the locked bytes are untouched and still usable a second time
    expect(Buffer.from(r.bytes).equals(Buffer.from(lockedCopy))).toBe(true);
    expect(r.bytes.buffer.byteLength).toBeGreaterThan(0);
    const again = await unlockInWorker({ bytes: r.bytes, password });
    expect(again.fileHash).toBe(back.fileHash);
    // result data does not alias the locked input
    expect(back.data.buffer).not.toBe(r.bytes.buffer);
  });

  it('an unlock input that is an offset view of a bigger buffer works', async () => {
    const r = await lockFile({ data: new Uint8Array([9, 8, 7]), name: 'v', password, iterations: FAST });
    const pool = new Uint8Array(r.bytes.length + 40);
    pool.set(r.bytes, 17);
    const view = pool.subarray(17, 17 + r.bytes.length);
    const back = await unlockInWorker({ bytes: view, password });
    expect(Array.from(back.data)).toEqual([9, 8, 7]);
  });

  it('errors stay the exact spec messages through the wrapper', async () => {
    const r = await lockInWorker({ data: new Uint8Array(4), name: 'e', password, iterations: FAST });
    const flipped = r.bytes.slice();
    flipped[60] ^= 1;
    await expect(unlockInWorker({ bytes: flipped, password })).rejects.toThrow('wrong password, or the file was changed');
    await expect(unlockInWorker({ bytes: new Uint8Array(0), password })).rejects.toThrow('this is not a hrdlock file');
    await expect(lockInWorker({ data: new Uint8Array(1), name: 'x', password: '', iterations: FAST })).rejects.toThrow('password is empty');
  });

  it('handleCipherMessage never throws and never lists a transfer on failure', async () => {
    for (const msg of [undefined, null, 5, 'x', {}, { id: 1 }, { id: 2, op: 'lock' }, { id: 3, op: 'unlock' }, { id: 4, op: 'unlock', bytes: 7, password }]) {
      const { reply, transfer } = await handleCipherMessage(msg);
      expect(reply.ok).toBe(false);
      expect(typeof reply.error).toBe('string');
      expect(transfer).toEqual([]);
    }
  });
});

// a fake worker that behaves like a real one: inputs are cloned, result buffers are really transferred
function installTransferringWorker() {
  class W {
    postMessage(msg) {
      const copy = structuredClone(msg);
      handleCipherMessage(copy).then(({ reply, transfer }) => {
        const delivered = structuredClone(reply, { transfer });
        setTimeout(() => this.onmessage && this.onmessage({ data: delivered }), 0);
      });
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', W);
}

describe('with a worker that transfers result buffers', () => {
  it('the caller input stays intact and the delivered results are usable', async () => {
    installTransferringWorker();
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const r = await lockInWorker({ data, name: 'tr', password, iterations: FAST });
    expect(data.buffer.byteLength).toBe(6);
    expect(Array.from(data)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.bytes.buffer.byteLength).toBe(r.bytes.length);
    const direct = await unlockFile(r.bytes, password);
    expect(Array.from(direct.data)).toEqual([1, 2, 3, 4, 5, 6]);

    const locked = r.bytes;
    const back = await unlockInWorker({ bytes: locked, password });
    // input of unlock is cloned, so it is still readable
    expect(locked.buffer.byteLength).toBeGreaterThan(0);
    expect(Array.from(back.data)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(back.commitment).toBe(r.commitment);
  });

  it('falls back when postMessage throws (for example a clone error)', async () => {
    vi.stubGlobal('Worker', class { postMessage() { throw new DOMException('no clone', 'DataCloneError'); } terminate() {} });
    const r = await lockInWorker({ data: new Uint8Array([1]), name: 'f', password, iterations: FAST });
    expect((await unlockInWorker({ bytes: r.bytes, password })).name).toBe('f');
  });

  it('concurrent jobs get their own answers', async () => {
    installTransferringWorker();
    const jobs = [];
    for (let i = 0; i < 6; i++) jobs.push(lockInWorker({ data: new Uint8Array([i]), name: 'n' + i, password, iterations: FAST }));
    const done = await Promise.all(jobs);
    const backs = await Promise.all(done.map((d) => unlockInWorker({ bytes: d.bytes, password })));
    backs.forEach((b, i) => {
      expect(b.name).toBe('n' + i);
      expect(b.data[0]).toBe(i);
    });
  });
});
