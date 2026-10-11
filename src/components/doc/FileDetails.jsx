import Button from '../Button.jsx';
import Icon from '../Icon.jsx';
import VerifyResult from '../VerifyResult.jsx';
import DocSummary from './DocSummary.jsx';
import DocTimeline from './DocTimeline.jsx';
import { LATEST_MEANING, LIMITS_SENTENCE, exportBundle, exportBundleName } from './docLogic.js';
import { saveFile } from './saveFile.js';

// The collapsed "Details" area: the full technical checks, hashes and ledger numbers, the offline
// verification bundle and the printable certificate. The page above it speaks plainly, this is where
// the exact facts live.
//   open, onToggle(open)   the open state is controlled, so the Manage sheet can open it
//   pinnedServerKeyId      the key the person pinned on purpose ('' when none), written into the bundle
export default function FileDetails({ docId, bundle, verification, pinnedServerKeyId = '', trust = '', open, onToggle, summaryRef }) {
  const head = verification && verification.head ? verification.head : null;
  const verified = Boolean(verification) && verification.ok === true;

  function downloadBundle() {
    const data = exportBundle(bundle, pinnedServerKeyId, Date.now());
    saveFile(exportBundleName(docId, head ? head.version : null), JSON.stringify(data, null, 2), 'application/json');
  }

  return (
    <details className="doc-details" open={open} onToggle={(e) => onToggle && onToggle(e.currentTarget.open)}>
      <summary ref={summaryRef}>Details</summary>
      <div className="doc-details__body">
        <p className="ui-muted">The full checks this browser ran, with ids, hashes and ledger numbers.</p>
        <VerifyResult result={verification} trust={trust} />
        <DocSummary docId={docId} bundle={bundle} verification={verification} pinnedServerKeyId={pinnedServerKeyId} />
        <DocTimeline bundle={bundle} verified={verified} />
        <section className="ui-card doc-card" aria-labelledby="doc-limits-title">
          <h2 className="ui-card__title" id="doc-limits-title">
            What this does and does not show
          </h2>
          <p>{LATEST_MEANING}</p>
          <p>{LIMITS_SENTENCE}</p>
        </section>
        <div className="ui-row">
          <Button onClick={downloadBundle}>
            <Icon name="download" size={18} /> Download verification bundle
          </Button>
          <Button onClick={() => window.print()}>
            <Icon name="file" size={18} /> Print certificate
          </Button>
        </div>
      </div>
    </details>
  );
}
