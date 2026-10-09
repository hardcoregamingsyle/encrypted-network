// cipherClient.js
// Runs lockFile and unlockFile in a module worker so the page stays responsive.
// Falls back to the main thread when Workers are not available (tests, old browsers)
// or when the worker cannot start.

import { lockFile, unlockFile } from './lockfile.js';

let worker = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map();

function failAll(message) {
  for (const [, job] of pending) job.reject(new Error(message));
  pending.clear();
}

function getWorker() {
  if (workerFailed || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('./cipher.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (event) => {
      const msg = event.data || {};
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      if (msg.ok) job.resolve(msg.result);
      else job.reject(new Error(msg.error || 'file is damaged'));
    };
    w.onerror = () => {
      // the worker died: run what was waiting on the main thread, and stop using workers
      workerFailed = true;
      const jobs = [...pending.values()];
      pending.clear();
      worker = null;
      try { w.terminate(); } catch { /* ignore */ }
      for (const job of jobs) job.fallback().then(job.resolve, job.reject);
    };
    worker = w;
    return w;
  } catch {
    workerFailed = true;
    return null;
  }
}

function run(op, args, direct) {
  const w = getWorker();
  if (!w) return direct();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, fallback: direct });
    try {
      // inputs are copied (not transferred) so the caller keeps its own buffers
      w.postMessage({ id, op, ...args });
    } catch (e) {
      pending.delete(id);
      direct().then(resolve, reject);
    }
  });
}

// args: { data, name, password, iterations? }
export function lockInWorker(args) {
  return run('lock', args, () => lockFile(args));
}

// args: { bytes, password }
export function unlockInWorker(args) {
  return run('unlock', args, () => unlockFile(args.bytes, args.password));
}

// for tests: forget the current worker and allow a fresh start
export function resetCipherClient() {
  if (worker) {
    try { worker.terminate(); } catch { /* ignore */ }
  }
  worker = null;
  workerFailed = false;
  failAll('cipher client was reset');
}
