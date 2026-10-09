// Per isolate lock for writers that append to a chain (ledger, one channel).
//
// The database stays the source of truth: UNIQUE columns reject a second writer and the
// handler retries. This lock only stops requests that run in the same isolate from fighting
// each other, so a burst of parallel writes does not burn all its retries. It never shares a
// promise between requests: waiters poll with their own timers.
import { sleep } from './time.js';

const held = new Map();

export async function withLock(key, fn, { maxWaitMs = 8000, staleMs = 15000 } = {}) {
  const start = Date.now();
  for (;;) {
    const cur = held.get(key);
    if (!cur || Date.now() - cur.at > staleMs || Date.now() - start > maxWaitMs) break;
    await sleep(2 + Math.floor(Math.random() * 6));
  }
  const mine = { at: Date.now() };
  held.set(key, mine);
  try {
    return await fn();
  } finally {
    if (held.get(key) === mine) held.delete(key);
  }
}

// Wait a short random time before a retry, longer each time.
export function backoff(attempt) {
  return sleep(Math.floor(Math.random() * 15 * (attempt + 1)));
}
