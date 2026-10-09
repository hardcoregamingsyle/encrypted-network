import CopyButton from '../CopyButton.jsx';
import HashText from '../HashText.jsx';
import KeyBadge from '../KeyBadge.jsx';
import { formatBytes, formatTime } from '../../lib/format.js';
import { timelineOf } from './docLogic.js';

function Hash({ label, value }) {
  if (!value) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <HashText value={value} /> <CopyButton text={value} label="Copy" describe={label.toLowerCase()} />
      </dd>
    </div>
  );
}

// Every version, newest first.
export default function DocTimeline({ bundle, verified }) {
  const items = timelineOf(bundle);
  return (
    <section className="ui-card doc-card" aria-labelledby="doc-timeline-title">
      <h2 className="ui-card__title" id="doc-timeline-title">
        Version history
      </h2>
      <p className="ui-muted">
        {verified
          ? 'Every entry below is signed by the owner key and linked to the one before it. Newest first.'
          : 'This is what the server sent. It cannot be trusted until all the checks above pass. Newest first.'}
      </p>
      {items.length === 0 ? (
        <p className="doc-empty">The server sent no versions for this document.</p>
      ) : (
        <ol className="doc-timeline">
          {items.map((item) => (
            <li key={item.version + ':' + item.recordHash} className="doc-version" data-type={item.type}>
              <div className="doc-version__head">
                <span className="doc-version__no">{`Version ${item.version}`}</span>
                <span className={`ui-badge ui-badge--${item.type === 'doc.revoke' ? 'bad' : item.isHead ? 'good' : 'info'}`}>
                  {item.typeLabel}
                </span>
                {item.isHead ? <span className="ui-badge ui-badge--info">Latest</span> : null}
              </div>
              <dl className="ui-kv doc-version__body">
                {item.label ? (
                  <div>
                    <dt>Label</dt>
                    <dd>{item.label}</dd>
                  </div>
                ) : null}
                {item.type === 'doc.revoke' ? (
                  <div>
                    <dt>Reason</dt>
                    <dd>{item.reason || 'none given'}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Signed by</dt>
                  <dd>
                    <KeyBadge keyId={item.signer} name={item.signerName} />
                  </dd>
                </div>
                <div>
                  <dt>Time (signer clock)</dt>
                  <dd>{item.createdAt === null ? 'unknown' : formatTime(item.createdAt)}</dd>
                </div>
                <Hash label="Record hash" value={item.recordHash} />
                <Hash label="Locked file hash" value={item.blobHash} />
                {item.blobSize !== null ? (
                  <div>
                    <dt>Locked file size</dt>
                    <dd>{formatBytes(item.blobSize)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Ledger number</dt>
                  <dd>{item.ledgerSeq === null ? 'unknown' : item.ledgerSeq}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
