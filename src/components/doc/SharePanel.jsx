import Button from '../Button.jsx';
import CopyButton from '../CopyButton.jsx';
import Icon from '../Icon.jsx';
import { fullLink, verifyLink } from '../../lib/links.js';
import { exportBundle, exportBundleName, hasPassword } from './docLogic.js';
import { saveFile } from './saveFile.js';

// Share links, the offline bundle and the printable certificate.
export default function SharePanel({ docId, bundle, headVersion, pinnedServerKeyId, password, confirmed }) {
  const verify = verifyLink(docId);
  const known = hasPassword(password);
  const full = known ? fullLink(docId, password) : '';

  function downloadBundle() {
    const data = exportBundle(bundle, pinnedServerKeyId, Date.now());
    saveFile(exportBundleName(docId, headVersion), JSON.stringify(data, null, 2), 'application/json');
  }

  return (
    <section className="ui-card doc-card" aria-labelledby="doc-share-title">
      <h2 className="ui-card__title" id="doc-share-title">
        Share and export
      </h2>
      <div className="ui-stack">
        <div>
          <p className="doc-label">Verify-only link</p>
          <p className="ui-muted">Opens the checks and the history. It does not let anyone read the file.</p>
          <p className="doc-linkline">
            <span className="ui-hash ui-hash--full" data-testid="doc-verify-link">
              {verify}
            </span>{' '}
            <CopyButton text={verify} label="Copy" describe="verify-only link" />
          </p>
        </div>
        <div>
          <p className="doc-label">Full link with password</p>
          {known ? (
            <>
              <p className="ui-muted">
                Anyone with this link can read the file. The password sits after the # sign, so the browser does not send it
                to the server.
                {confirmed ? '' : ' The password has not been confirmed yet, unlock the file to check it.'}
              </p>
              <p className="doc-linkline">
                <span className="ui-hash ui-hash--full" data-testid="doc-full-link">
                  {full}
                </span>{' '}
                <CopyButton text={full} label="Copy" describe="full link" />
              </p>
            </>
          ) : (
            <p className="ui-muted">Enter the document password above to get a link that also opens the file.</p>
          )}
        </div>
        <div>
          <p className="doc-label">Offline checking</p>
          <p className="ui-muted">
            Saves the signed records, the signer keys and the server checkpoint as one file, with the server key you pinned and the
            time. Open it on the verify page to check it without the server.
          </p>
          <div className="ui-row">
            <Button onClick={downloadBundle}>
              <Icon name="download" size={18} /> Download verification bundle
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
