import { useEffect, useRef, useState } from 'react';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import Field from '../Field.jsx';
import Sheet from '../Sheet.jsx';
import { actionErrorText } from '../actionText.js';
import { ApiError, getFilesCheck, putFilesCheck } from '../../lib/api.js';
import { SET_ELSEWHERE, submitFilesPassword } from './filesPasswordFlow.js';

const FIRST_INFO = 'This password locks your private files. Only you know it. We cannot recover it: if you forget it, your private files are lost.';
const ASK_INFO = {
  add: 'Enter your files password to lock this file.',
  open: 'Enter your files password to open this file.',
  public: 'Enter your files password to make this file public. Anyone will see its name and be able to check it. It stays locked unless you turn on "Anyone can open this file" afterwards.'
};

// Asks for the files password. purpose is 'add' (lock a new file), 'open' or 'public' (open it to publish it). check is optional: give the fingerprint
// (or null) when the caller has it already, otherwise it is read here. onDone gets the password for the locking code.
// When onDone throws, the sentence is shown and the box stays open for another try.
export default function FilesPasswordSheet({ purpose, accountId, check: given, onDone, onClose }) {
  const [check, setCheck] = useState(purpose === 'add' ? given : ''); // undefined while it is being read. Opening needs none: the file says if the password is wrong
  const box = useRef(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (check !== undefined) return undefined;
    let live = true;
    getFilesCheck().then(
      (answer) => live && setCheck(answer.check),
      (err) => live && setError(actionErrorText(err))
    );
    return () => {
      live = false;
    };
  }, [check]);

  useEffect(() => {
    if (!busy && box.current) box.current.focus(); // when the boxes appear, and again after a refused password
  }, [busy, check]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onDone(await submitFilesPassword({ password, again, accountId, purpose, check }, { putCheck: putFilesCheck }));
      return;
    } catch (err) {
      setError(err instanceof ApiError ? actionErrorText(err) : err.message);
      if (err.message === SET_ELSEWHERE) setCheck(undefined); // read it again, then ask for the password once
    }
    setBusy(false);
  }

  const first = check === null;
  const cancel = (
    <Button variant="ghost" onClick={onClose} disabled={busy}>
      Cancel
    </Button>
  );

  return (
    <Sheet open onClose={onClose} dismissible={!busy} title={first ? 'Choose your files password' : 'Your files password'} description={first ? FIRST_INFO : ASK_INFO[purpose] || ASK_INFO.open} footer={cancel}>
      {check === undefined ? (
        error ? <Callout tone="bad" title="Could not check your account">{error}</Callout> : <p className="ui-muted" role="status">Checking your account...</p>
      ) : (
        <form className="ui-stack" onSubmit={submit} noValidate>
          <Field label="Files password" hint={first ? 'At least 10 characters. Pick something you will remember.' : undefined}>
            <input ref={box} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={first ? 'new-password' : 'current-password'} autoCapitalize="none" autoCorrect="off" spellCheck="false" maxLength={128} disabled={busy} />
          </Field>
          {first ? (
            <Field label="Type it again">
              <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck="false" maxLength={128} disabled={busy} />
            </Field>
          ) : null}
          {error ? <Callout tone="bad" title="That did not work">{error}</Callout> : null}
          <Button type="submit" variant="primary" loading={busy}>
            {first ? 'Save password' : 'Continue'}
          </Button>
        </form>
      )}
    </Sheet>
  );
}

export { FilesPasswordSheet };
