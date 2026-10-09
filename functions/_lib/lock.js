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

// How long a writer keeps trying when other writers (maybe in other isolates, which this lock
// cannot see) keep winning the race for the head of a chain. After this the caller answers 503 busy.
export const RETRY_BUDGET_MS = 8000;

// Wait a random time before a retry. The window doubles each time (full jitter) up to half a second,
// so a crowd of writers spreads out instead of colliding again.
export function backoff(attempt) {
  const window = Math.min(500, 10 * 2 ** Math.min(attempt, 6));
  return sleep(Math.floor(Math.random() * window));
}

// True while a writer that started at startedAt may still retry.
export function canRetry(startedAt, budgetMs = RETRY_BUDGET_MS) {
  return Date.now() - startedAt < budgetMs;
}
