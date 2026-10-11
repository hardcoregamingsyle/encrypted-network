import { useCallback, useEffect, useRef, useState } from 'react';

// The rule behind "ignore a second press": one action at a time, and a short hold after it ends, because
// a double click arrives as two separate presses and an action like saving a file is finished before the
// second one comes. Plain code with no React, so it can be tested on its own.
//   const guard = createBusyGuard(holdMs, onChange)
//   guard.enter()  -> true when the action may start, false when a press must be ignored
//   guard.leave()  -> the action ended; the guard opens again after holdMs
//   guard.cancel() -> drop a pending timer (the screen went away)
export function createBusyGuard(holdMs = 0, onChange = () => {}) {
  let locked = false;
  let timer = null;
  return {
    enter() {
      if (locked) return false;
      locked = true;
      onChange(true);
      return true;
    },
    leave() {
      const release = () => {
        timer = null;
        locked = false;
        onChange(false);
      };
      if (holdMs > 0) timer = setTimeout(release, holdMs);
      else release();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get locked() {
      return locked;
    }
  };
}

// Wraps a button action so a second press is ignored while the first is running and just after it (holdMs).
//   const [run, busy] = useBusyAction(action, { holdMs: 1000 });
// run(...args) calls action(...args) and returns its answer, or undefined when the press was ignored.
// busy is true from the first press until the hold is over: use it for the button's pending look.
export default function useBusyAction(action, { holdMs = 0 } = {}) {
  const actionRef = useRef(action);
  actionRef.current = action;
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const guardRef = useRef(null);
  if (!guardRef.current) {
    guardRef.current = createBusyGuard(holdMs, (on) => {
      if (alive.current) setBusy(on);
    });
  }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      guardRef.current.cancel();
    };
  }, []);

  const run = useCallback(async (...args) => {
    const guard = guardRef.current;
    if (!guard.enter()) return undefined;
    try {
      return await actionRef.current(...args);
    } finally {
      guard.leave();
    }
  }, []);

  return [run, busy];
}

export { useBusyAction };
