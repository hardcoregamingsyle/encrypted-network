import { formatTime, formatUtc } from '../../lib/format.js';
import { certificateData } from './docLogic.js';

// A time with the local zone and the same moment in UTC.
function when(ms) {
  return `${formatTime(ms)} (${formatUtc(ms)})`;
}

function Row({ label, children }) {
  return (
    <div className="doc-cert__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// A certificate that is only visible when printing (see doc.css).
export default function Certificate({ bundle, verification, pinnedServerKeyId, checkedAt }) {
  const c = certificateData({ bundle, verification, pinnedServerKeyId, now: checkedAt });
  return (
    <section className="doc-cert" aria-hidden="true" data-testid="doc-cert">
      <h1 className="doc-cert__title">Document verification report</h1>
      <p className={`doc-cert__result ${c.ok && !c.rollback ? 'is-ok' : 'is-bad'}`}>{c.resultText}</p>
      <dl className="doc-cert__list">
        <Row label="Document id">{c.docId}</Row>
        <Row label="Status">
          {c.status}
          {c.reason ? ` (reason: ${c.reason})` : ''}
        </Row>
        <Row label="Latest version">{c.headVersion === null ? 'unknown' : c.headVersion}</Row>
        {c.label ? <Row label="Label">{c.label}</Row> : null}
        <Row label="Version record hash">{c.headRecordHash || 'none'}</Row>
        <Row label="Locked file hash">{c.headBlobHash || 'none'}</Row>
        <Row label="Signer">{c.signerName || 'unknown name'}</Row>
        <Row label="Signer key id">{c.signerKeyId || 'unknown'}</Row>
        <Row label="Signed at (signer clock)">{c.signedAt ? when(c.signedAt) : 'unknown'}</Row>
        <Row label="Server key id">{c.serverKeyId || 'none'}</Row>
        <Row label="Server key pinned">
          {c.pinnedServerKeyId
            ? c.pinned
              ? 'yes, and the checkpoint was checked against it'
              : c.pinMismatch
                ? 'yes, but the server key does not match it'
                : 'yes, but the check did not pass, so it is not confirmed'
            : 'no'}
        </Row>
        {c.ledgerCheckpoint ? (
          <Row label="Ledger checkpoint">
            number {c.ledgerCheckpoint.seq}, hash {c.ledgerCheckpoint.hash}, signed {when(c.ledgerCheckpoint.signedAt)}
          </Row>
        ) : (
          <Row label="Ledger checkpoint">none</Row>
        )}
        {c.headCheckpoint ? (
          <Row label="Document checkpoint">
            version {c.headCheckpoint.seq}, hash {c.headCheckpoint.hash}, signed {when(c.headCheckpoint.signedAt)}
          </Row>
        ) : null}
        <Row label="Tied to the server head">{c.anchored ? 'yes' : 'no'}</Row>
        <Row label="Checked on">{when(c.checkedAt)}</Row>
      </dl>
      {c.failed.length > 0 ? (
        <div className="doc-cert__block">
          <p className="doc-cert__heading">Checks that failed</p>
          <ul>
            {c.failed.map((f) => (
              <li key={f.id}>
                {f.id.replace(/_/g, ' ')}: {f.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="doc-cert__block">
        <p className="doc-cert__heading">What this means</p>
        <p>{c.latest}</p>
        <p>{c.limits}</p>
      </div>
    </section>
  );
}
