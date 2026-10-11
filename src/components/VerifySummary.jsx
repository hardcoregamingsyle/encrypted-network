import Icon from './Icon.jsx';
import KeyBadge from './KeyBadge.jsx';
import VerifyResult from './VerifyResult.jsx';
import { verdictFor } from '../lib/trust.js';
import { LATEST_MEANING } from './doc/docLogic.js';
import '../styles/verify.css';

// Under every green verdict: the answer is the server's own, and a server can keep something back.
export const SERVER_REPORT_LINE = 'This is what the server reports. A withdrawal or newer version it keeps back would not show here. See Details.';

const TONE_ICON = { good: 'shield-check', warn: 'warn', bad: 'x' };

// Plain language answer for one document: a short verdict, one line about it, and a collapsed
// "Details" with the full checklist. It is green only when every check passed, the answer is tied to the
// server's newest record and the server key is a known one (see verdictFor in lib/trust.js).
//   result   what openDocument() returned (or just its verification)
//   trust    'pinned-match' | 'pinned-mismatch' | 'remembered-match' | 'remembered-mismatch' | 'first-visit' | 'first-visit-unsaved'
//   compact  smaller, for the top of the file page
export default function VerifySummary({ result, trust, compact = false }) {
  const verdict = verdictFor(result, trust);
  const { tone, headline, line, details } = verdict;
  const verification = result && typeof result === 'object' ? (result.verification && typeof result.verification === 'object' ? result.verification : Array.isArray(result.checks) ? result : null) : null;
  const who = details.signerName ? details.signerName : '';
  const fact =
    details.version !== null
      ? `Version ${details.version}${who ? `, signed by ${who}` : ''}${details.status === 'revoked' ? ', withdrawn' : ''}`
      : '';

  return (
    <section
      className={`vsum vsum--${tone}${compact ? ' vsum--compact' : ''}`}
      aria-label="Verification summary"
      data-verdict={details.kind}
    >
      <div className="vsum__top" role={tone === 'bad' ? 'alert' : 'status'}>
        <span className="vsum__icon" aria-hidden="true">
          <Icon name={TONE_ICON[tone] || 'info'} size={compact ? 22 : 30} />
        </span>
        <div className="vsum__text">
          <p className="vsum__headline">
            {headline}
          </p>
          <p className="vsum__line">{line}</p>
        </div>
      </div>

      {tone === 'good' ? <p className="vsum__limit">{SERVER_REPORT_LINE}</p> : null}
      {!compact && details.checked ? <p className="vsum__checked">{details.checked}</p> : null}
      {!compact && fact ? (
        <p className="vsum__fact">
          {fact}
          {details.label ? <span className="vsum__label"> ({details.label})</span> : null}
          {who ? <span className="vsum__note"> The name is chosen by the signer and is not checked.</span> : null}
        </p>
      ) : null}
      {!compact && details.trustLine ? <p className="vsum__trust">{details.trustLine}</p> : null}
      {compact && details.trust === 'first-visit' && tone === 'good' ? (
        <p className="vsum__trust">First visit, server key remembered.</p>
      ) : null}

      <details className="vsum__details">
        <summary>Details</summary>
        <div className="vsum__details-body">
          {compact && details.trustLine ? <p className="ui-muted">{details.trustLine}</p> : null}
          {tone === 'good' ? <p className="ui-muted">{LATEST_MEANING}</p> : null}
          {details.signerKeyId ? (
            <p className="ui-muted">
              Signer: <KeyBadge keyId={details.signerKeyId} name={details.signerName} />
            </p>
          ) : null}
          {verification ? <VerifyResult result={verification} trust={trust} /> : <p className="ui-muted">There are no check results to show.</p>}
        </div>
      </details>
    </section>
  );
}

export { VerifySummary };
