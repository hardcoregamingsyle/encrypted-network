import { useState } from 'react';
import ScreenHeader from '../components/ScreenHeader.jsx';
import AuditSection from '../components/verify/AuditSection.jsx';
import BundleSection from '../components/verify/BundleSection.jsx';
import DocumentSection from '../components/verify/DocumentSection.jsx';
import FileSection from '../components/verify/FileSection.jsx';
import PinSection from '../components/verify/PinSection.jsx';
import QuickCheck from '../components/verify/QuickCheck.jsx';
import RememberedSection from '../components/verify/RememberedSection.jsx';
import { getPinnedServerKeyId } from '../lib/pin.js';
import '../styles/verify.css';

const SECTIONS = [
  ['verify-pin', 'Server key pin'],
  ['verify-remembered', 'Remembered server key'],
  ['verify-document', 'Verify a document'],
  ['verify-bundle', 'Verify a saved bundle'],
  ['verify-file', 'Check a file'],
  ['verify-audit', 'Full ledger audit']
];

// Public screen: needs no sign in. The first thing is one box and a Check button. Everything the page did
// before (pin the server key, a saved bundle, a file, the full audit) sits in the Advanced disclosure.
export default function VerifyPage() {
  const [pinned, setPinned] = useState(() => getPinnedServerKeyId());

  return (
    <div className="ui-screen">
      <ScreenHeader title="Verify" subtitle="Check who signed a file and that it has not changed" documentTitle="Verify" />
      <div className="ui-container ui-container--narrow verify-page">
        <p className="verify-lead">
          This page needs no account. Every check runs in your browser, nothing here asks you to sign in or create a key.
        </p>

        <QuickCheck />

        <details className="verify-advanced">
          <summary className="verify-advanced__summary">Advanced</summary>
          <div className="verify-advanced__body">
            <p className="ui-muted">
              For people who want to see the details: pin the server key, check a saved bundle without the network, compare a
              file, or audit the whole ledger.
            </p>
            <nav className="verify-toc" aria-label="Sections in Advanced">
              <ul>
                {SECTIONS.map(([id, label]) => (
                  <li key={id}>
                    <a href={`#${id}`}>{label}</a>
                  </li>
                ))}
              </ul>
            </nav>

            <PinSection pinned={pinned} onPinChange={setPinned} />
            <RememberedSection pinned={pinned} />
            <DocumentSection pinned={pinned} />
            <BundleSection pinned={pinned} />
            <FileSection pinned={pinned} />
            <AuditSection pinned={pinned} />
          </div>
        </details>

        <p className="ui-muted verify-limits">
          hrdlock is a prototype and has not been audited or certified. A passing check shows that the signing, the links between
          versions and the file contents agree with each other. It does not show that the signer is who they say they are, or
          that a file is true or legally valid. The checks are run by code that this site sends you. A changed or copied site
          could send code that reports a pass without checking, and saving the server's key does not protect against that. For records
          that matter, repeat the checks with a verification program from a source you trust.
        </p>
      </div>
    </div>
  );
}
