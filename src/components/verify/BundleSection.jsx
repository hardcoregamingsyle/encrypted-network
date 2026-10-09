import { useEffect, useRef, useState } from 'react';
import Callout from '../Callout.jsx';
import Field from '../Field.jsx';
import Spinner from '../Spinner.jsx';
import { formatBytes } from '../../lib/format.js';
import { verifyDocumentBundle } from '../../../shared/verify.js';
import DocResult from './DocResult.jsx';
import Section from './Section.jsx';
import { MAX_BUNDLE_BYTES, bundleAttestedAt, readBundleText } from './logic.js';

// Section 3: check a saved bundle without the network.
export default function BundleSection({ pinned }) {
  const [phase, setPhase] = useState('idle'); // idle, working, done, error
  const [fileInfo, setFileInfo] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const run = useRef(0);
  const inputRef = useRef(null);

  useEffect(() => () => {
    run.current += 1;
  }, []);

  async function check(file, pin) {
    const mine = ++run.current;
    setFileInfo({ name: file.name, size: file.size });
    setResult(null);
    setError('');
    if (file.size > MAX_BUNDLE_BYTES) {
      setError('This file is too large to be a saved bundle (the limit is 10 MiB).');
      setPhase('error');
      return;
    }
    setPhase('working');
    try {
      const text = await file.text();
      if (run.current !== mine) return;
      const read = readBundleText(text);
      if (!read.ok) {
        setError(read.error);
        setPhase('error');
        return;
      }
      const verification = await verifyDocumentBundle(read.bundle, { pinnedServerKeyId: pin });
      if (run.current !== mine) return;
      setResult({ verification, bundle: read.bundle, offline: true, attestedAt: bundleAttestedAt(read.bundle) });
      setPhase('done');
    } catch {
      if (run.current !== mine) return;
      setError('The file could not be read. Choose it again.');
      setPhase('error');
    }
  }

  function onPick(e) {
    const file = e.target.files && e.target.files[0];
    if (file) check(file, pinned);
  }

  // A changed pin applies to the file that is already chosen.
  const lastPin = useRef(pinned);
  useEffect(() => {
    if (lastPin.current === pinned) return;
    lastPin.current = pinned;
    const file = inputRef.current && inputRef.current.files && inputRef.current.files[0];
    if (file) check(file, pinned);
  }, [pinned]);

  return (
    <Section
      id="verify-bundle"
      title="3. Verify a saved bundle"
      intro="Check a verification bundle you saved from a document page. This works without any network connection."
    >
      <Field
        label="Saved bundle file (.json)"
        hint="The file is read and checked in this browser. It is not uploaded."
      >
        <input ref={inputRef} type="file" accept=".json,application/json" onChange={onPick} />
      </Field>
      {fileInfo ? (
        <p className="ui-muted">
          {fileInfo.name} ({formatBytes(fileInfo.size)})
        </p>
      ) : null}

      <div className="verify-live" role="status" aria-live="polite">
        {phase === 'working' ? (
          <p className="verify-loading">
            <Spinner label={null} size="sm" /> Checking the bundle
          </p>
        ) : null}
      </div>

      {phase === 'error' ? (
        <Callout tone="bad" title="This file could not be checked">
          {error}
        </Callout>
      ) : null}

      {phase === 'done' && result ? <DocResult {...result} /> : null}
    </Section>
  );
}
