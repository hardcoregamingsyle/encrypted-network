import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

// Copies text with the clipboard API, with a fallback for older browsers.
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the old way
  }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.className = 'ui-sr-only';
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(box);
    return ok;
  } catch {
    return false;
  }
}

// describe says what is copied, for screen readers: "Copy" + "key id".
export default function CopyButton({ text, label = 'Copy', describe = '' }) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function onClick() {
    const ok = await copyText(String(text ?? ''));
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  }

  const shown = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label;
  return (
    <span className="ui-copy">
      <button
        type="button"
        className="ui-btn ui-btn--ghost ui-btn--sm"
        onClick={onClick}
        aria-label={describe ? `${label} ${describe}` : undefined}
      >
        <Icon name={state === 'copied' ? 'check' : 'copy'} size={16} />
        <span className="ui-btn__label">{shown}</span>
      </button>
      <span className="ui-sr-only" role="status">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Could not copy' : ''}
      </span>
    </span>
  );
}

export { CopyButton };
