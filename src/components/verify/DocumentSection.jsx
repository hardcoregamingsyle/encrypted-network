import { useEffect, useRef, useState } from 'react';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import Field from '../Field.jsx';
import Spinner from '../Spinner.jsx';
import { openDocument } from '../../lib/publish.js';
import { tidyPassword } from '../doc/docLogic.js';
import DocResult from './DocResult.jsx';
import Section from './Section.jsx';
import { parseDocInput } from './logic.js';

export function errorText(err) {
  if (err && err.code === 'not_found') return 'No document with this id was found on this site.';
  if (err && err.code === 'network') return err.message;
  return err && err.message ? err.message : 'Something went wrong while checking the document.';
}

// Section 2: open a document by id or link and verify it.
export default function DocumentSection({ pinned }) {
  const [input, setInput] = useState('');
  const [password, setPassword] = useState('');
  const [inputError, setInputError] = useState('');
  const [phase, setPhase] = useState('idle'); // idle, working, done, error
  const [stepText, setStepText] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const run = useRef(0);

  useEffect(() => () => {
    run.current += 1; // ignore answers that arrive after the page is closed
  }, []);

  const parsed = input.trim() === '' ? null : parseDocInput(input);
  const linkPassword = parsed && parsed.ok ? parsed.password : '';
  const siteHost = typeof window !== 'undefined' && window.location ? window.location.host : '';
  const otherHost = parsed && parsed.ok && parsed.host && siteHost && parsed.host !== siteHost ? parsed.host : '';

  async function onSubmit(e) {
    e.preventDefault();
    const p = parseDocInput(input);
    if (!p.ok) {
      setInputError(p.error);
      // the earlier result belongs to another input, so it is not left on screen under the error
      run.current += 1;
      setResult(null);
      setError('');
      setPhase('idle');
      return;
    }
    setInputError('');
    // tidyPassword also reads a full link typed or filled in by the browser, not only a pasted one
    const used = tidyPassword(password) || p.password;
    const mine = ++run.current;
    setPhase('working');
    setResult(null);
    setError('');
    setStepText('Fetching the document');
    try {
      const open = await openDocument({
        docId: p.docId,
        password: used,
        pinnedServerKeyId: pinned,
        onStep: (id, text) => {
          if (run.current === mine) setStepText(text);
        }
      });
      if (run.current !== mine) return;
      setResult({
        verification: open.verification,
        bundle: open.bundle,
        blobCheck: open.blobCheck,
        plaintextCheck: open.plaintextCheck,
        fingerprint: open.fingerprint,
        file: open.file ? { name: open.file.name, size: open.file.data.length } : null,
        passwordGiven: used !== ''
      });
      setPhase('done');
    } catch (err) {
      if (run.current !== mine) return;
      setError(errorText(err));
      setPhase('error');
    }
  }

  const working = phase === 'working';

  return (
    <Section
      id="verify-document"
      title="2. Verify a document"
      intro="Paste a document id or a full link to fetch the document from this site and check it yourself."
    >
      <form className="verify-form" onSubmit={onSubmit} noValidate>
        <Field
          label="Document id or link"
          hint="For example a 32 character id, or a link from the owner. A password after #k= in the link is used for the file checks."
          error={inputError}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setInputError('');
            }}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            maxLength={2100}
            className="verify-mono-input"
          />
        </Field>
        {parsed && parsed.ok ? (
          <p className="ui-muted">
            Recognised document {parsed.docId.slice(0, 8)}...
            {linkPassword ? ' The link includes a password, it stays in this browser.' : ''}
          </p>
        ) : null}
        {otherHost ? (
          <p className="ui-muted">
            This link points to {otherHost}. Only this site is asked, the host in the link is ignored.
          </p>
        ) : null}
        <Field
          label="Document password (optional)"
          hint="Needed only to open the file itself and check its fingerprint. It never leaves this browser."
        >
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={256}
          />
        </Field>
        <div className="ui-row">
          <Button type="submit" variant="primary" loading={working}>
            {working ? 'Checking' : 'Verify document'}
          </Button>
        </div>
      </form>

      <div className="verify-live" role="status" aria-live="polite">
        {working ? (
          <p className="verify-loading">
            <Spinner label={null} size="sm" /> {stepText}
          </p>
        ) : null}
      </div>

      {phase === 'error' ? (
        <Callout tone="bad" title="The document could not be checked">
          {error}
        </Callout>
      ) : null}

      {phase === 'done' && result ? <DocResult {...result} /> : null}
    </Section>
  );
}
