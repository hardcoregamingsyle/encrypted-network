import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';

const ICONS = { info: 'info', good: 'check', warn: 'warn', bad: 'x' };
const NOOP = Object.freeze({ push: () => {} });

const ToastContext = createContext(NOOP);

// const toast = useToast(); toast.push({ tone: 'good', text: 'Saved' })
export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const nextId = useRef(1);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((list) => list.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    ({ tone = 'info', text }) => {
      if (!text) return;
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { id, tone, text: String(text) }]);
      const wait = tone === 'bad' || tone === 'warn' ? 9000 : 5000;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), wait)
      );
    },
    [dismiss]
  );

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const t of live.values()) clearTimeout(t);
      live.clear();
    };
  }, []);

  const value = useMemo(() => ({ push }), [push]);
  const calm = items.filter((item) => item.tone === 'info' || item.tone === 'good');
  const urgent = items.filter((item) => item.tone === 'bad' || item.tone === 'warn');

  function renderItem(item) {
    return (
      <div key={item.id} className={`ui-toast ui-toast--${item.tone}`}>
        <Icon name={ICONS[item.tone] || 'info'} />
        <p className="ui-toast__text">{item.text}</p>
        <button type="button" className="ui-toast__close" onClick={() => dismiss(item.id)} aria-label="Dismiss message">
          <Icon name="x" size={16} />
        </button>
      </div>
    );
  }

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ui-toasts">
        <div role="status" aria-live="polite">
          {calm.map(renderItem)}
        </div>
        <div role="alert" aria-live="assertive">
          {urgent.map(renderItem)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export default ToastProvider;
