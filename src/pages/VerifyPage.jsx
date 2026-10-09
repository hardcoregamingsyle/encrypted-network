import { useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import AuditSection from '../components/verify/AuditSection.jsx';
import BundleSection from '../components/verify/BundleSection.jsx';
import DocumentSection from '../components/verify/DocumentSection.jsx';
import FileSection from '../components/verify/FileSection.jsx';
import PinSection from '../components/verify/PinSection.jsx';
import { getPinnedServerKeyId } from '../lib/pin.js';
import '../styles/verify.css';

const SECTIONS = [
  ['verify-pin', 'Server key pin'],
  ['verify-document', 'Verify a document'],
  ['verify-bundle', 'Verify a saved bundle'],
  ['verify-file', 'Check a file'],
  ['verify-audit', 'Full ledger audit']
];

// Verifier tools for officials. No account or identity is needed for any of it.
export default function VerifyPage() {
  const [pinned, setPinned] = useState(() => getPinnedServerKeyId());

  return (
    <div className="ui-container verify-page">
      <PageHeader
        title="Verify"
        lead="This page needs no account. Nothing here asks you to sign in or create a key, and every check runs in your browser. The checking code comes from this same site, which is a limit explained at the bottom of the page."
        documentTitle="Verify"
      />

      <nav className="verify-toc" aria-label="Sections on this page">
        <ul>
          {SECTIONS.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ul>
      </nav>

      <PinSection pinned={pinned} onPinChange={setPinned} />
      <DocumentSection pinned={pinned} />
      <BundleSection pinned={pinned} />
      <FileSection pinned={pinned} />
      <AuditSection pinned={pinned} />

      <p className="ui-muted verify-limits">
        hrdlock is a prototype and has not been audited or certified. A passing check shows that the signatures, links
        and hashes described above are consistent. It does not show that the signer is who they say they are, or that a
        document is true or legally valid. The checks are run by code that this site sends you. A changed or copied site could send
        code that reports a pass without checking, and pinning the server key does not protect against that. For records that matter,
        repeat the checks with a verification program from a source you trust.
      </p>
    </div>
  );
}
