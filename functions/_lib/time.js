// Time window checks and a sleep helper. The server clock is always Date.now().
import { ApiError } from './errors.js';

export function withinWindow(createdAt, windowMs, now) {
  return Number.isFinite(createdAt) && Math.abs(now - createdAt) <= windowMs;
}

// Throws 400 expired when the time is too far from the server clock.
export function assertFresh(createdAt, windowMs, now = Date.now(), what = 'record') {
  if (!withinWindow(createdAt, windowMs, now)) {
    throw new ApiError('expired', `${what} time is too far from the server time, check your clock`);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
