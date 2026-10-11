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

// Which key the server proof was checked against, in words that match what this browser really did. The
// proof is only "pinned" when the person chose the key on purpose.
function keySource(trust) {
  if (trust === 'pinned-match') return { who: 'the server whose key you pinned', check: 'the server key you pinned' };
  if (trust === 'remembered-match') return { who: "the server whose key this browser remembered from an earlier visit", check: 'the server key this browser remembered from an earlier visit' };
  if (trust === 'first-visit' || trust === 'first-visit-unsaved') return { who: 'the server', check: "the server key seen on this first visit (nothing earlier to compare it with)" };
  return { who: 'the server', check: 'the server key it was checked against' };
}

function headline(result, trust) {
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
  const src = keySource(trust);
  const firstOnly = trust === 'first-visit' || trust === 'first-visit-unsaved';
  return {
    tone: 'good',
    title: 'Signatures, version chain and server checkpoint all check out',
    text:
      `Every version is signed by the owner key, the versions link in order, and ${src.who} confirmed this latest version when it answered.` +
      (firstOnly ? " This browser had not seen the server's key before, so this does not show that the server is the one you expect." : '')
  };
}

// The checkpoint detail from the verifier always says "pinned server key". When the key was only remembered
// (or seen for the first time) that would claim more than was done, so the sentence names the real source.
function detailText(check, src) {
  if (check && check.id === 'checkpoint' && check.ok === true && typeof check.detail === 'string' && /pinned server key/i.test(check.detail)) {
    return check.detail.replace(/the pinned server key/i, src.check);
  }
  return check.detail;
}

// Shows the result of verifyDocumentBundle: an overall banner, each check and the warnings.
export default function VerifyResult({ result, trust }) {
  if (!result || typeof result !== 'object') return null;
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const head = result.head;
  const top = headline(result, trust);
  const src = keySource(trust);

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
                {check.detail ? <p className="ui-checks__detail">{detailText(check, src)}</p> : null}
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
