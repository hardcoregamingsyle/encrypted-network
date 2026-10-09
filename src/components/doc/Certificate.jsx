import { formatTime } from '../../lib/format.js';
import { certificateData } from './docLogic.js';

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
      <h1 className="doc-cert__title">Document verification certificate</h1>
      <p className={`doc-cert__result ${c.ok ? 'is-ok' : 'is-bad'}`}>{c.resultText}</p>
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
        <Row label="Signed at (signer clock)">{c.signedAt ? formatTime(c.signedAt) : 'unknown'}</Row>
        <Row label="Server key id">{c.serverKeyId || 'none'}</Row>
        <Row label="Server key pinned">
          {c.pinnedServerKeyId ? (c.pinned ? 'yes, and it matches' : 'yes, but it does not match') : 'no'}
        </Row>
        {c.ledgerCheckpoint ? (
          <Row label="Ledger checkpoint">
            number {c.ledgerCheckpoint.seq}, hash {c.ledgerCheckpoint.hash}, signed {formatTime(c.ledgerCheckpoint.signedAt)}
          </Row>
        ) : (
          <Row label="Ledger checkpoint">none</Row>
        )}
        {c.headCheckpoint ? (
          <Row label="Document checkpoint">
            version {c.headCheckpoint.seq}, hash {c.headCheckpoint.hash}, signed {formatTime(c.headCheckpoint.signedAt)}
          </Row>
        ) : null}
        <Row label="Tied to the server head">{c.anchored ? 'yes' : 'no'}</Row>
        <Row label="Checked on">{formatTime(c.checkedAt)}</Row>
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
