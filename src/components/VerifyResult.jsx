import Callout from './Callout.jsx';
import HashText from './HashText.jsx';
import Icon from './Icon.jsx';
import KeyBadge from './KeyBadge.jsx';
import { formatTime } from '../lib/format.js';
import { serverKeyPinned } from '../lib/trust.js';

const CHECK_NAMES = {
  identities_match: 'Signer identities',
  record_signatures: 'Signatures on every version',
  chain_links: 'Version chain',
  single_owner: 'One owner',
  no_post_revoke: 'Nothing after a revoke',
  ledger_links: 'Server ledger links',
  head_matches: 'Latest version matches',
  checkpoint: 'Server checkpoint'
};

function checkName(id) {
  return CHECK_NAMES[id] || String(id).replace(/_/g, ' ');
}

function headline(result) {
  if (!result.ok) {
    return {
      tone: 'bad',
      title: 'Verification failed',
      text: 'At least one check did not pass. Do not rely on this document until the failed checks are explained.'
    };
  }
  if (result.status === 'revoked') {
    return {
      tone: 'warn',
      title: 'Checks passed, but the owner revoked this document',
      text: 'The signatures and version chain are intact. The last signed entry withdraws the document.'
    };
  }
  if (result.anchored === false) {
    return {
      tone: 'warn',
      title: 'Signatures and chain check out, but the latest version is not confirmed',
      text: 'This record is not tied to the server head, so a newer version could exist.'
    };
  }
  if (!serverKeyPinned(result)) {
    // Anyone can make a server key, a signer and a document, so this only shows an answer that agrees with itself.
    return {
      tone: 'warn',
      title: 'Signatures, version chain and server checkpoint check out, but the server key is not pinned',
      text: 'Every version is signed by one key and the versions link in order. Because no server key is pinned, this only shows that the answer agrees with itself. Anyone can make their own keys and documents that pass these checks. Pin the server key id from an official source on the Verify page to tie the answer to a server you trust.'
    };
  }
  return {
    tone: 'good',
    title: 'Signatures, version chain and server checkpoint all check out',
    text: 'Every version is signed by the owner key, the versions link in order, and the server whose key you pinned confirmed this latest version when it answered.'
  };
}

// Shows the result of verifyDocumentBundle: an overall banner, each check and the warnings.
export default function VerifyResult({ result }) {
  if (!result || typeof result !== 'object') return null;
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const head = result.head;
  const top = headline(result);

  return (
    <section className="ui-verify" aria-label="Verification result">
      <Callout tone={top.tone} title={top.title}>
        {top.text}
      </Callout>

      {head ? (
        <dl className="ui-kv ui-verify__head">
          <div>
            <dt>Latest version</dt>
            <dd>
              {head.version}
              {head.label ? <span> - {head.label}</span> : null}
            </dd>
          </div>
          <div>
            <dt>Signed by</dt>
            <dd>
              <KeyBadge keyId={head.signer} name={head.signerName} />
            </dd>
          </div>
          {head.createdAt ? (
            <div>
              <dt>Signed at (signer clock)</dt>
              <dd>{formatTime(head.createdAt)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Version record hash</dt>
            <dd>
              <HashText value={head.recordHash} />
            </dd>
          </div>
        </dl>
      ) : null}

      {checks.length > 0 ? (
        <ul className="ui-checks">
          {checks.map((check) => (
            <li key={check.id} className={`ui-checks__item ${check.ok ? 'is-ok' : 'is-bad'}`}>
              <span className="ui-checks__mark">
                <Icon name={check.ok ? 'check' : 'x'} />
              </span>
              <div>
                <p className="ui-checks__name">
                  {checkName(check.id)}
                  <span className="ui-sr-only">{check.ok ? ': passed' : ': failed'}</span>
                </p>
                {check.detail ? <p className="ui-checks__detail">{check.detail}</p> : null}
              </div>
            </li>
          ))}
        </ul>
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
    </section>
  );
}

export { VerifyResult };
