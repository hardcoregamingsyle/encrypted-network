import { Link } from 'react-router-dom';
import CopyButton from '../CopyButton.jsx';
import HashText from '../HashText.jsx';
import KeyBadge from '../KeyBadge.jsx';
import { formatTime, timeAgo } from '../../lib/format.js';
import { checkpointTime, revokeReason, statusOf, timelineOf } from './docLogic.js';

// The main facts about the document: status, latest version, signer and times.
export default function DocSummary({ docId, bundle, verification, pinnedServerKeyId }) {
  const status = statusOf(verification);
  const head = verification && verification.head ? verification.head : null;
  const items = timelineOf(bundle);
  const first = items.length > 0 ? items[items.length - 1] : null;
  const reason = revokeReason(bundle);
  const cpTime = checkpointTime(bundle);
  const serverKeyId = bundle && bundle.server && typeof bundle.server.keyId === 'string' ? bundle.server.keyId : '';

  return (
    <section className="ui-card doc-card" aria-labelledby="doc-summary-title">
      <div className="doc-card__head">
        <h2 className="ui-card__title" id="doc-summary-title">
          Document details
        </h2>
        <span className={`ui-badge ui-badge--${status.tone}`} data-testid="doc-status">
          {status.label}
        </span>
      </div>

      {status.key === 'revoked' && reason ? (
        <p className="doc-reason">
          <strong>Reason given by the owner:</strong> {reason}
        </p>
      ) : null}

      <dl className="ui-kv">
        <div>
          <dt>Document id</dt>
          <dd>
            <HashText value={docId} /> <CopyButton text={docId} label="Copy" describe="document id" />
          </dd>
        </div>
        <div>
          <dt>Latest version</dt>
          <dd>
            {head ? (
              <>
                {`Version ${head.version}`}
                {head.label ? ` - ${head.label}` : ''}
              </>
            ) : (
              'unknown'
            )}
          </dd>
        </div>
        <div>
          <dt>Signed by</dt>
          <dd>
            {head ? <KeyBadge keyId={head.signer} name={head.signerName} /> : 'unknown'}
            {head && head.signer ? (
              <div className="doc-subline">
                Key id <HashText value={head.signer} /> <CopyButton text={head.signer} label="Copy" describe="signer key id" />
              </div>
            ) : null}
          </dd>
        </div>
        {first && first.createdAt !== null ? (
          <div>
            <dt>First published</dt>
            <dd>
              {formatTime(first.createdAt)} <span className="ui-muted">(signer clock, {timeAgo(first.createdAt)})</span>
            </dd>
          </div>
        ) : null}
        {head && head.createdAt ? (
          <div>
            <dt>Latest version signed</dt>
            <dd>
              {formatTime(head.createdAt)} <span className="ui-muted">(signer clock, {timeAgo(head.createdAt)})</span>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Server checkpoint</dt>
          <dd>
            {cpTime === null ? 'none' : formatTime(cpTime)}
            {cpTime !== null ? <span className="ui-muted"> (server clock, {timeAgo(cpTime)})</span> : null}
          </dd>
        </div>
        <div>
          <dt>Server key</dt>
          <dd>
            {serverKeyId ? <HashText value={serverKeyId} /> : 'none'}
            {serverKeyId ? (
              <div className="doc-subline">
                {pinnedServerKeyId && pinnedServerKeyId === serverKeyId ? (
                  <span className="ui-badge ui-badge--good">Matches your pinned key</span>
                ) : pinnedServerKeyId ? (
                  <span className="ui-badge ui-badge--bad">Does not match your pinned key</span>
                ) : (
                  <span className="ui-badge ui-badge--warn">Not pinned</span>
                )}
              </div>
            ) : null}
          </dd>
        </div>
      </dl>

      {!pinnedServerKeyId ? (
        <p className="doc-hint">
          The server key is not pinned in this browser, so the checkpoint cannot be tied to a server you trust.{' '}
          <Link to="/verify">Pin the server key on the verify page</Link>.
        </p>
      ) : null}
    </section>
  );
}
