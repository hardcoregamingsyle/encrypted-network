import { useEffect, useState } from 'react';
import { secondsLeft } from '../lib/format.js';

// Counts down to a moment (ms). Returns the seconds left and ticks once a second only while there is time left.
export default function useCountdown(until) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until || until <= Date.now()) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  return secondsLeft(until, now);
}

export { useCountdown };
