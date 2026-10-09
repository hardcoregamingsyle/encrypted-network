import Callout from '../Callout.jsx';
import CopyButton from '../CopyButton.jsx';
import HashText from '../HashText.jsx';
import { PROBLEM_CAP } from '../../lib/audit.js';
import { formatTime } from '../../lib/format.js';

function plural(n, word) {
  const many = word.endsWith('y') ? word.slice(0, -1) + 'ies' : word + 's';
  return `${n} ${n === 1 ? word : many}`;
}

function headline(result) {
  if (result.status === 'aborted') {
    return {
      tone: 'warn',
      title: 'Audit cancelled',
      text: `The audit was stopped after ${plural(result.entries, 'entry')}. Nothing here says the whole ledger is sound.`
    };
  }
  if (result.status === 'error') {
    return {
      tone: 'bad',
      title: 'Audit could not finish',
      text: `${result.error || 'The ledger could not be fetched.'} ${plural(result.entries, 'entry')} were checked before it stopped.`
    };
  }
  if (result.status === 'incomplete') {
    return {
      tone: 'bad',
      title: 'Audit stopped before the end of the ledger',
      text: 'The ledger could not be read to its end, so it is not confirmed.'
    };
  }
  if (result.problemCount > 0) {
    return {
      tone: 'bad',
      title: `Problems found: ${plural(result.problemCount, 'problem')}`,
      text: 'The ledger does not pass. Do not rely on it until each problem below is explained.'
    };
  }
  const cp = result.checkpoint;
  if (!cp || !cp.present) {
    return {
      tone: 'warn',
      title: 'Ledger is consistent, but its end is not confirmed',
      text: `All ${plural(result.entries, 'entry')} are correctly signed and chained. The server sent no signed checkpoint, so nothing ties this to the server's own record of where the ledger ends.`
    };
  }
  return {
    tone: 'good',
    title: 'Ledger audit passed',
    text: `All ${plural(result.entries, 'entry')} for ${plural(result.documents, 'document')} are correctly signed and chained, and the server's signed checkpoint matches the end of the ledger.`
  };
}

function CheckpointLines({ result }) {
  const cp = result.checkpoint;
  if (!cp) return null;
  return (
    <dl className="ui-kv verify-details">
      <div>
        <dt>Server checkpoint</dt>
        <dd>
          {!cp.present
            ? 'None sent'
            : !cp.signatureOk
              ? 'Present, signature does not verify'
              : cp.matchesEnd
                ? `Signature valid, matches the end of the ledger (entry ${cp.seq})`
                : `Signature valid, but it says entry ${cp.seq} and the audit reached entry ${result.lastSeq}`}
        </dd>
      </div>
      {cp.signedAt ? (
        <div>
          <dt>Checkpoint signed at (server clock)</dt>
          <dd>{formatTime(cp.signedAt)}</dd>
        </div>
      ) : null}
      {cp.serverKeyId ? (
        <div>
          <dt>Server key id</dt>
          <dd>
            <HashText value={cp.serverKeyId} />
          </dd>
        </div>
      ) : null}
      <div>
        <dt>Pinned server key</dt>
        <dd>
          {result.pinned
            ? cp.pinMatches
              ? 'Yes, the server key equals your pin'
              : 'NO, the server key differs from your pin'
            : 'Not pinned'}
        </dd>
      </div>
    </dl>
  );
}

// The end result of an audit: a headline, the numbers, the first problems and the warnings.
export default function AuditSummary({ result }) {
  if (!result) return null;
  const top = headline(result);
  const shown = Array.isArray(result.problems) ? result.problems : [];
  const hidden = Math.max(0, result.problemCount - shown.length);
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const hasPosition = result.entries > 0 && result.lastSeq > 0;

  return (
    <div className="verify-audit-summary">
      <Callout tone={top.tone} title={top.title}>
        {top.text}
      </Callout>

      <dl className="ui-kv verify-details">
        <div>
          <dt>Entries checked</dt>
          <dd>{result.entries}</dd>
        </div>
        <div>
          <dt>Documents seen</dt>
          <dd>{result.documents}</dd>
        </div>
        <div>
          <dt>Problems</dt>
          <dd>{result.problemCount}</dd>
        </div>
      </dl>

      <CheckpointLines result={result} />

      {result.problemCount > 0 ? (
        <div className="verify-block">
          <h3 className="verify-subtitle">
            {hidden > 0 ? `Problems (first ${PROBLEM_CAP} of ${result.problemCount})` : `Problems (${result.problemCount})`}
          </h3>
          <ol className="ui-list verify-problems">
            {shown.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ol>
          {hidden > 0 ? <p className="ui-muted">{`and ${hidden} more problems not listed.`}</p> : null}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <Callout tone="warn" title="Read before you rely on this">
          <ul className="ui-list">
            {warnings.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {hasPosition && result.ok ? (
        <div className="verify-block">
          <h3 className="verify-subtitle">Ledger position to keep</h3>
          <p className="ui-muted">
            Save these two values. Next time, enter them as an earlier position to confirm that history was not
            rewritten in between.
          </p>
          <dl className="ui-kv verify-details">
            <div>
              <dt>Entry number</dt>
              <dd>
                {result.lastSeq} <CopyButton text={String(result.lastSeq)} label="Copy" describe="entry number" />
              </dd>
            </div>
            <div>
              <dt>Ledger hash</dt>
              <dd>
                <HashText value={result.lastHash} /> <CopyButton text={result.lastHash} label="Copy" describe="ledger hash" />
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
