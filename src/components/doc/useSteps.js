import { useCallback, useState } from 'react';

// Progress steps for a long job. onStep matches the callback that publish.js and openDocument call.
// A repeated step id replaces the old text instead of adding a row.
export function useSteps() {
  const [steps, setSteps] = useState([]);
  const onStep = useCallback((id, text) => {
    setSteps((list) => {
      const at = list.findIndex((s) => s.id === id);
      if (at >= 0) {
        const next = list.slice();
        next[at] = { id, text };
        return next;
      }
      return [...list, { id, text }];
    });
  }, []);
  const reset = useCallback(() => setSteps([]), []);
  return [steps, onStep, reset];
}

export default useSteps;
