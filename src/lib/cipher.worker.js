// cipher.worker.js
// Module worker: locks and unlocks files off the main thread.
// Messages in:  { id, op: 'lock' | 'unlock', ...args }
// Messages out: { id, ok: true, result } or { id, ok: false, error }
// Result buffers are transferred, not copied.

import { lockFile, unlockFile } from './lockfile.js';

// the real work, kept separate from the worker plumbing so it can be tested
export async function handleCipherMessage(msg) {
  const id = msg && msg.id;
  try {
    if (!msg || (msg.op !== 'lock' && msg.op !== 'unlock')) throw new Error('unknown operation');
    if (msg.op === 'lock') {
      const result = await lockFile({
        data: msg.data,
        name: msg.name,
        password: msg.password,
        iterations: msg.iterations,
        commitSalt: msg.commitSalt
      });
      return { reply: { id, ok: true, result }, transfer: [result.bytes.buffer] };
    }
    const result = await unlockFile(msg.bytes, msg.password);
    return { reply: { id, ok: true, result }, transfer: [result.data.buffer] };
  } catch (e) {
    return { reply: { id, ok: false, error: e && e.message ? e.message : 'file is damaged' }, transfer: [] };
  }
}

const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' &&
  self instanceof WorkerGlobalScope;

if (inWorker) {
  self.onmessage = async (event) => {
    const { reply, transfer } = await handleCipherMessage(event.data);
    self.postMessage(reply, transfer);
  };
}
