import { useEffect, useRef, useState } from 'react';
import Button from '../Button.jsx';
import Field from '../Field.jsx';
import { PAGE_LIMIT, auditLedger } from '../../lib/audit.js';
import { getLedger } from '../../lib/api.js';
import AuditSummary from './AuditSummary.jsx';
import Section from './Section.jsx';
import { parseFingerprint } from './logic.js';

const fetchPage = ({ after, limit, signal }) => getLedger({ after, limit, signal });

// Reads the optional saved position. Returns { point, error }.
function readPoint(seqText, hashText) {
  const seqRaw = seqText.trim();
  const hashRaw = hashText.trim();
  if (seqRaw === '' && hashRaw === '') return { point: null, error: '' };
  if (!/^[0-9]{1,15}$/.test(seqRaw) || Number(seqRaw) < 1) {
    return { point: null, error: 'Enter the entry number of your saved position (a whole number, 1 or more).' };
  }
  const hash = parseFingerprint(hashRaw);
  if (hash.state !== 'ok') return { point: null, error: 'Enter the 64 character ledger hash of your saved position.' };
  return { point: { seq: Number(seqRaw), hash: hash.value }, error: '' };
}

function progressText(p) {
  if (!p) return 'Starting the audit';
  if (p.phase === 'checkpoint') return `Checked ${p.entries} entries. Checking the server checkpoint`;
  const of = p.total ? ` of about ${p.total}` : '';
  return `Checked ${p.entries}${of} entries, ${p.documents} documents so far${p.problemCount ? `, ${p.problemCount} problems` : ''}`;
}

// Section 5: walk the whole ledger and check everything.
export default function AuditSection({ pinned }) {
  const [phase, setPhase] = useState('idle'); // idle, running, done
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [seqText, setSeqText] = useState('');
  const [hashText, setHashText] = useState('');
  const [pointError, setPointError] = useState('');
  const ctrl = useRef(null);

  useEffect(
    () => () => {
      if (ctrl.current) ctrl.current.abort();
    },
    []
  );

  async function start() {
    const { point, error } = readPoint(seqText, hashText);
    if (error) {
      setPointError(error);
      return;
    }
    setPointError('');
    const controller = new AbortController();
    ctrl.current = controller;
    setPhase('running');
    setResult(null);
    setProgress(null);
    const out = await auditLedger({
      fetchPage,
      signal: controller.signal,
      pinnedServerKeyId: pinned,
      knownPoint: point,
      limit: PAGE_LIMIT,
      onProgress: (p) => {
        if (ctrl.current === controller) setProgress(p);
      }
    });
    if (ctrl.current !== controller) return;
    ctrl.current = null;
    setResult(out);
    setPhase('done');
  }

  function cancel() {
    if (ctrl.current) ctrl.current.abort();
  }

  const running = phase === 'running';
  const hasTotal = progress && progress.total;

  return (
    <Section
      id="verify-audit"
      title="5. Full ledger audit"
      intro="Reads every entry the server has ever recorded and re-checks all signatures and links in your browser."
    >
      <p>
        The audit checks each record, each signature, the chain that joins the entries, and the rules for each document
        (versions in order, one owner, nothing after a revoke). It ends by comparing the last entry with the server's
        signed checkpoint and with your pinned server key. A large ledger takes a while, you can cancel at any time.
      </p>

      <details className="verify-details-toggle">
        <summary>Compare with a position I saved earlier (optional)</summary>
        <div className="verify-form">
          <Field label="Saved entry number" hint="From a summary of an earlier audit.">
            <input
              type="text"
              inputMode="numeric"
              value={seqText}
              onChange={(e) => {
                setSeqText(e.target.value);
                setPointError('');
              }}
              autoComplete="off"
              maxLength={15}
              disabled={running}
            />
          </Field>
          <Field label="Saved ledger hash" error={pointError}>
            <input
              type="text"
              value={hashText}
              onChange={(e) => {
                setHashText(e.target.value);
                setPointError('');
              }}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              maxLength={200}
              className="verify-mono-input"
              disabled={running}
            />
          </Field>
        </div>
      </details>

      <div className="ui-row">
        <Button variant="primary" onClick={start} loading={running}>
          {running ? 'Auditing' : phase === 'done' ? 'Run the audit again' : 'Start the full audit'}
        </Button>
        {running ? (
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        ) : null}
      </div>

      <div className="verify-live" role="status" aria-live="polite">
        {running ? (
          <div className="verify-progress">
            <progress
              className="verify-progress__bar"
              aria-label="Audit progress"
              max={hasTotal ? progress.total : undefined}
              value={hasTotal ? Math.min(progress.entries, progress.total) : undefined}
            />
            <p>{progressText(progress)}</p>
          </div>
        ) : null}
      </div>

      {phase === 'done' && result ? <AuditSummary result={result} /> : null}
    </Section>
  );
}
