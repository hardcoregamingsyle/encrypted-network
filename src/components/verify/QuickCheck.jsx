import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../Button.jsx';
import Field from '../Field.jsx';
import Icon from '../Icon.jsx';
import Spinner from '../Spinner.jsx';
import VerifySummary from '../VerifySummary.jsx';
import { formatBytes, textOf } from '../../lib/format.js';
import { verdictFor } from '../../lib/trust.js';
import { loadServerTrust } from '../../lib/pin.js';
import { openDocument } from '../../lib/publish.js';
import { errorText } from './DocumentSection.jsx';
import { parseDocInput } from './logic.js';
import { fileLines, quickCheck } from './quickLogic.js';

// The file checks, one plain line each. Shown only when a password came with the link.
function FileLines({ result }) {
  const lines = fileLines(result);
  if (lines.length === 0) return null;
  return (
    <ul className="ui-checks vq-files" aria-label="File checks">
      {lines.map((l) => (
        <li key={l.id} className={`ui-checks__item ${l.neutral ? 'is-note' : l.ok ? 'is-ok' : 'is-bad'}`}>
          <span className="ui-checks__mark">
            <Icon name={l.neutral ? 'info' : l.ok ? 'check' : 'x'} />
          </span>
          <div>
            <p className="ui-checks__name">
              {l.text}
              <span className="ui-sr-only">{l.neutral ? ': not checked' : l.ok ? ': passed' : ': failed'}</span>
            </p>
            {l.note ? <p className="ui-checks__detail">{l.note}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

// The main thing on the Verify screen: paste a link or an id, press Check, read a plain answer.
// It needs no sign in. The link may carry the file password after #k=, then the file is checked too.
export default function QuickCheck() {
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState('');
  const [phase, setPhase] = useState('idle'); // idle, working, done, error
  const [stepText, setStepText] = useState('');
  const [result, setResult] = useState(null);
  const [trust, setTrust] = useState('');
  const [docId, setDocId] = useState('');
  const [error, setError] = useState('');
  const run = useRef(0);

  useEffect(() => () => {
    run.current += 1; // ignore answers that arrive after the screen is closed
  }, []);

  const parsed = input.trim() === '' ? null : parseDocInput(input);
  const siteHost = typeof window !== 'undefined' && window.location ? window.location.host : '';
  const otherHost = parsed && parsed.ok && parsed.host && siteHost && parsed.host !== siteHost ? parsed.host : '';

  async function onSubmit(e) {
    e.preventDefault();
    const mine = ++run.current;
    setResult(null);
    setError('');
    setInputError('');
    if (!parseDocInput(input).ok) {
      setInputError(parseDocInput(input).error);
      setPhase('idle');
      return;
    }
    setPhase('working');
    setStepText('Fetching the document');
    try {
      const out = await quickCheck(
        input,
        { loadTrust: loadServerTrust, open: openDocument },
        {
          onStep: (id, text) => {
            if (run.current === mine) setStepText(text);
          },
          isStale: () => run.current !== mine
        }
      );
      if (out.stale || run.current !== mine) return;
      setResult(out.result);
      setTrust(out.trust);
      setDocId(out.docId);
      setPhase('done');
    } catch (err) {
      if (run.current !== mine) return;
      setError(errorText(err));
      setPhase('error');
    }
  }

  const working = phase === 'working';

  return (
    <section className="vq" aria-labelledby="vq-title">
      <h2 className="vq-title" id="vq-title">
        Check a document
      </h2>
      <form className="vq-form" onSubmit={onSubmit} noValidate>
        <Field label="Paste a link or ID" hint="A link someone sent you, or the 32 character document ID." error={inputError}>
          <input
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setInputError('');
            }}
            className="vq-input"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            inputMode="url"
            maxLength={2100}
          />
        </Field>
        {parsed && parsed.ok && parsed.password ? (
          <p className="ui-muted">The link includes the file password. It stays in this browser, so the file is checked too.</p>
        ) : null}
        {otherHost ? (
          <p className="ui-muted">This link points to {otherHost}. Only this site is asked, the host in the link is ignored.</p>
        ) : null}
        <Button type="submit" variant="primary" loading={working} className="vq-go">
          {working ? 'Checking' : 'Check'}
        </Button>
      </form>

      <div className="vq-live" role="status" aria-live="polite">
        {working ? (
          <p className="vq-loading">
            <Spinner label={null} size="sm" /> {stepText}
          </p>
        ) : null}
        {phase === 'done' && result ? (
          <div className="vq-result">
            <VerifySummary result={result} trust={trust} />
            {/* Green rows under a red answer would send mixed signals, so they are left out when the server's key
                changed or the answer is older than one seen before. */}
            {['key-changed', 'rollback'].includes(verdictFor(result, trust).details.kind) ? null : <FileLines result={result} />}
            {result.file && result.file.name ? (
              <p className="ui-muted">
                File: {textOf(result.file.name)}
                {Number.isSafeInteger(result.file.size) ? ` (${formatBytes(result.file.size)})` : ''}
              </p>
            ) : null}
            <p className="vq-link">
              <Link to={`/d/${docId}`}>Open the document page</Link>
            </p>
          </div>
        ) : null}
      </div>

      {phase === 'error' ? (
        <div className="vsum vsum--bad" role="alert">
          <div className="vsum__top">
            <span className="vsum__icon" aria-hidden="true">
              <Icon name="x" size={30} />
            </span>
            <div className="vsum__text">
              <p className="vsum__headline">Could not check this file</p>
              <p className="vsum__line">{error}</p>
            </div>
          </div>
        </div>
      ) : null}

    </section>
  );
}
