import { Link } from 'react-router-dom';
import Callout from '../Callout.jsx';
import CopyButton from '../CopyButton.jsx';
import HashText from '../HashText.jsx';
import Icon from '../Icon.jsx';
import KeyBadge from '../KeyBadge.jsx';
import VerifyResult from '../VerifyResult.jsx';
import { formatBytes, formatTime, timeAgo } from '../../lib/format.js';
import { spacedFingerprint } from './logic.js';

function CheckLine({ ok, name, detail }) {
  return (
    <li className={`ui-checks__item ${ok ? 'is-ok' : 'is-bad'}`}>
      <span className="ui-checks__mark">
        <Icon name={ok ? 'check' : 'x'} />
      </span>
      <div>
        <p className="ui-checks__name">
          {name}
          <span className="ui-sr-only">{ok ? ': passed' : ': failed'}</span>
        </p>
        {detail ? <p className="ui-checks__detail">{detail}</p> : null}
      </div>
    </li>
  );
}

// Shows what was checked for one document.
//   verification  result of verifyDocumentBundle
//   bundle        the bundle that was checked
//   blobCheck, plaintextCheck, fingerprint, file ({ name, size })   only for an online check
//   passwordGiven true when a password was used
//   offline       true for a saved bundle that was checked without the network
//   attestedAt    ms, when the server last signed this bundle (informative)
export default function DocResult({
  verification,
  bundle,
  blobCheck = null,
  plaintextCheck = null,
  fingerprint = null,
  file = null,
  passwordGiven = false,
  offline = false,
  attestedAt = null
}) {
  if (!verification) return null;
  const doc = bundle && bundle.document ? bundle.document : null;
  const head = verification.head;
  const records = bundle && Array.isArray(bundle.records) ? bundle.records : [];
  const lastRow = records.length > 0 ? records[records.length - 1] : null;
  const docId = doc && typeof doc.docId === 'string' ? doc.docId : head && head.docId ? head.docId : '';
  const ownerId = doc ? doc.ownerKeyId : null;
  const ownerName =
    bundle && bundle.identities && ownerId && bundle.identities[ownerId] ? bundle.identities[ownerId].displayName : '';
  const fileChecked = blobCheck !== null || plaintextCheck !== null;

  return (
    <div className="verify-docresult" data-offline={offline ? 'true' : undefined}>
      {offline ? (
        <p className="verify-offline-tag">
          <Icon name="lock" size={16} /> <strong>Checked offline.</strong> Nothing was sent anywhere. Only the saved
          file and this browser were used.
        </p>
      ) : null}

      <VerifyResult result={verification} />

      {offline ? (
        <Callout tone="info" title="What 'latest' means for a saved file">
          {attestedAt
            ? `The server signed this file on ${formatTime(attestedAt)} (${timeAgo(attestedAt)}). It shows the latest version as of that moment. `
            : 'This file carries no server signature time. '}
          A newer version may have been published since. Open the document online to see whether it is still the latest.
        </Callout>
      ) : null}

      {doc ? (
        <dl className="ui-kv verify-details">
          <div>
            <dt>Document id</dt>
            <dd>
              <HashText value={docId} />
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{verification.status === 'revoked' ? 'Revoked by the owner' : verification.status === 'active' ? 'Active' : 'Not trusted'}</dd>
          </div>
          <div>
            <dt>Versions</dt>
            <dd>{records.length}</dd>
          </div>
          {ownerId ? (
            <div>
              <dt>Owner</dt>
              <dd>
                <KeyBadge keyId={ownerId} name={ownerName} />
              </dd>
            </div>
          ) : null}
          {head && head.blobHash ? (
            <div>
              <dt>Locked file hash</dt>
              <dd>
                <HashText value={head.blobHash} />
              </dd>
            </div>
          ) : null}
          {lastRow && Number.isSafeInteger(lastRow.ledgerSeq) ? (
            <div>
              <dt>Ledger entry of the latest version</dt>
              <dd>{lastRow.ledgerSeq}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {fileChecked ? (
        <div className="verify-filechecks">
          <h3 className="verify-subtitle">The file</h3>
          <ul className="ui-checks">
            {blobCheck ? (
              <CheckLine ok={blobCheck.ok} name="Locked file matches the signed hash" detail={blobCheck.detail} />
            ) : null}
            {plaintextCheck ? (
              <CheckLine
                ok={plaintextCheck.ok}
                name="Unlocked file matches the signed commitment"
                detail={plaintextCheck.detail}
              />
            ) : null}
          </ul>
          {plaintextCheck && plaintextCheck.ok && fingerprint ? (
            <dl className="ui-kv verify-details">
              {file && file.name ? (
                <div>
                  <dt>File name</dt>
                  <dd>
                    {file.name}
                    {Number.isSafeInteger(file.size) ? <span className="ui-muted"> ({formatBytes(file.size)})</span> : null}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>File fingerprint (SHA-256)</dt>
                <dd>
                  <span className="verify-fp">{spacedFingerprint(fingerprint)}</span>{' '}
                  <CopyButton text={fingerprint} label="Copy" describe="fingerprint" />
                </dd>
              </div>
            </dl>
          ) : null}
        </div>
      ) : head && head.blobHash && !offline && !passwordGiven ? (
        <p className="ui-muted">
          The file itself was not downloaded. Enter the document password to open it and check its fingerprint against
          what the owner signed.
        </p>
      ) : null}
      {!offline && head && head.blobHash && fileChecked && !passwordGiven ? (
        <p className="ui-muted">
          No password was given, so the contents were not opened. Only the locked file was matched to its signed hash.
        </p>
      ) : null}

      {docId ? (
        <p className="verify-doclink">
          <Link to={`/d/${docId}`}>Open the document page</Link>
        </p>
      ) : null}
    </div>
  );
}
