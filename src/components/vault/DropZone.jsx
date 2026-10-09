import { useId, useRef, useState } from 'react';
import Icon from '../Icon.jsx';
import { formatBytes } from '../../lib/format.js';

// Drag and drop plus a normal file chooser. The real file input is kept in the page for keyboards
// and screen readers, the box around it is just its label.
export default function DropZone({ file, onFile, onClear, disabled = false, error = '', limitText }) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState('');

  function take(list) {
    if (!list || list.length === 0) return;
    setNote(list.length > 1 ? 'Only one file can be published at a time, so the first one was used.' : '');
    onFile(list[0]);
  }

  function onDrop(e) {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    take(e.dataTransfer && e.dataTransfer.files);
  }

  function onChange(e) {
    take(e.target.files);
    // lets the same file be chosen again after it was removed
    e.target.value = '';
  }

  function clear() {
    setNote('');
    onClear();
    if (inputRef.current) inputRef.current.focus();
  }

  const classes = ['vault-drop', over ? 'is-over' : '', disabled ? 'is-disabled' : '', error ? 'has-error' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className="vault-dropwrap">
      <label
        className={classes}
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="ui-sr-only"
          onChange={onChange}
          disabled={disabled}
          aria-describedby={hintId}
          aria-invalid={error ? 'true' : undefined}
        />
        <span className="vault-drop__icon" aria-hidden="true">
          <Icon name="lock" size={28} />
        </span>
        {file ? (
          <span className="vault-drop__text">
            <span className="vault-drop__name">{file.name}</span>
            <span className="vault-drop__meta">{formatBytes(file.size)}. Drop or choose another file to replace it.</span>
          </span>
        ) : (
          <span className="vault-drop__text">
            <span className="vault-drop__name">Drop a file here, or choose one</span>
            <span className="vault-drop__meta">{limitText}</span>
          </span>
        )}
        <span className="vault-drop__cta ui-btn ui-btn--sm" aria-hidden="true">
          Choose file
        </span>
      </label>
      <p className="ui-field__hint" id={hintId}>
        One file at a time.
      </p>
      {note ? (
        <p className="ui-muted" role="status">
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="ui-field__error" role="alert">
          {error}
        </p>
      ) : null}
      {file && !disabled ? (
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm vault-drop__remove" onClick={clear}>
          Remove file
        </button>
      ) : null}
    </div>
  );
}
