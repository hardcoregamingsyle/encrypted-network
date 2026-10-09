import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import CopyButton from '../CopyButton.jsx';
import HashText from '../HashText.jsx';
import Icon from '../Icon.jsx';
import { buildSaveText, documentRoute, saveFileName } from './vaultLogic.js';

// Saves text as a file through a temporary link.
function saveTextFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Row({ label, children, copy, describe }) {
  return (
    <div className="vault-result__row">
      <dt>{label}</dt>
      <dd>
        <span className="vault-result__value">{children}</span>
        {copy ? <CopyButton text={copy} label="Copy" describe={describe} /> : null}
      </dd>
    </div>
  );
}

// Shown once after a publish. The password lives only in this component's props.
// result: what publishNewDocument returned. meta: { label, createdAt }.
export default function PublishResult({ result, meta = {}, onDismiss }) {
  const headRef = useRef(null);
  useEffect(() => {
    if (headRef.current) headRef.current.focus();
  }, []);

  // The password cannot be shown again, so ask before the page is closed.
  useEffect(() => {
    function warn(e) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const text = buildSaveText({
    docId: result.docId,
    password: result.password,
    fingerprint: result.fingerprint,
    links: result.links,
    label: meta.label,
    createdAt: meta.createdAt
  });

  return (
    <section className="ui-card vault-result" aria-labelledby="vault-result-title">
      <div className="vault-result__head">
        <span className="vault-result__tick" aria-hidden="true">
          <Icon name="check" size={20} />
        </span>
        <div>
          <h2 className="ui-card__title" id="vault-result-title" tabIndex={-1} ref={headRef}>
            Published: the file is locked and the record is signed
          </h2>
          <p className="ui-muted">
            The server accepted your signed record for version {result.version}. Open the document page to check it
            yourself.
          </p>
        </div>
      </div>

      <Callout tone="warn" title="Save the password now. It is shown only once.">
        <p>
          The password is created in your browser and is never sent to the server. It <strong>cannot be recovered</strong>
          . If you lose it, nobody can unlock the file, including the people who run this server. Anyone who has it can
          open the file.
        </p>
      </Callout>

      <div className="vault-result__password">
        <p className="vault-result__label" id="vault-result-pw-label">
          Password
        </p>
        <p className="vault-result__pw" aria-labelledby="vault-result-pw-label">
          <code>{result.password}</code>
        </p>
        <div className="ui-row">
          <CopyButton text={result.password} label="Copy" describe="password" />
          <Button size="sm" onClick={() => saveTextFile(saveFileName(result.docId), text)}>
            <Icon name="download" size={16} /> Save as text file
          </Button>
        </div>
        <p className="ui-muted">
          The text file holds the document id, the password, the fingerprint and both links. Keep it somewhere private.
        </p>
      </div>

      <dl className="vault-result__list">
        <Row label="Document id" copy={result.docId} describe="document id">
          <HashText value={result.docId} />
        </Row>
        <Row label="Fingerprint of the original file (SHA-256)" copy={result.fingerprint} describe="fingerprint">
          <HashText value={result.fingerprint} />
        </Row>
        <Row label="Verify only link (no password)" copy={result.links.verify} describe="verify only link">
          <span className="vault-result__link">{result.links.verify}</span>
        </Row>
        <Row label="Full link (contains the password after #k=)" copy={result.links.full} describe="full link">
          <span className="vault-result__link">{result.links.full}</span>
        </Row>
      </dl>

      <p className="ui-muted">
        The verify only link shows who signed the document and whether the chain of versions is intact. It cannot open
        the file. The full link can, so share it only with people who should read the file. The part after # is never
        sent to the server.
      </p>

      <div className="ui-row vault-result__actions">
        <Link className="ui-btn ui-btn--primary" to={documentRoute(result.docId, result.links.full)}>
          Open the document page
        </Link>
        <Button variant="ghost" onClick={onDismiss}>
          I have saved the password, close this
        </Button>
      </div>
    </section>
  );
}
