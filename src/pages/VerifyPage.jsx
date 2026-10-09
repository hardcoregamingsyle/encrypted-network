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
        lead="This page needs no account. Nothing here asks you to sign in or create a key, and every check runs in your browser."
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
        document is true or legally valid.
      </p>
    </div>
  );
}
