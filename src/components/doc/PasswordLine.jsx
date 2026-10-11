import { useId, useState } from 'react';
import Button from '../Button.jsx';
import { tidyPassword } from './docLogic.js';
import { passwordFromInput, promptProblem } from './pageLogic.js';

// The one line password prompt: "Enter the file password or paste the full link".
//   onSubmit(password)  called with the cleaned password
//   error               a sentence from the last try (for example "That password did not work")
export default function PasswordLine({ onSubmit, busy = false, error = '' }) {
  const id = useId();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState('');

  function submit(event) {
    event.preventDefault();
    if (busy) return;
    const why = promptProblem(text);
    setProblem(why);
    if (why) return;
    onSubmit(passwordFromInput(text));
  }

  function paste(event) {
    const pasted = event.clipboardData && event.clipboardData.getData('text');
    if (typeof pasted !== 'string' || pasted === '') return;
    // a full link is reduced to its password right away
    event.preventDefault();
    setText(tidyPassword(pasted));
    setProblem('');
  }

  const shown = problem || error;
  return (
    <form className="doc-ask" onSubmit={submit} noValidate>
      <label className="ui-sr-only" htmlFor={id}>
        File password
      </label>
      <div className="doc-ask__row">
        <input
          id={id}
          type="password"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setProblem('');
          }}
          onPaste={paste}
          placeholder="Enter the file password or paste the full link"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={shown ? 'true' : undefined}
          aria-describedby={shown ? `${id}-error` : undefined}
        />
        <Button type="submit" variant="primary" loading={busy}>
          Open file
        </Button>
      </div>
      {shown ? (
        <p className="ui-field__error" id={`${id}-error`} role="alert">
          {shown}
        </p>
      ) : null}
    </form>
  );
}
