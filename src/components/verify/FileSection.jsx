import { useEffect, useRef, useState } from 'react';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import CopyButton from '../CopyButton.jsx';
import Field from '../Field.jsx';
import Icon from '../Icon.jsx';
import Spinner from '../Spinner.jsx';
import { getBlob } from '../../lib/api.js';
import { unlockInWorker } from '../../lib/cipherClient.js';
import { formatBytes } from '../../lib/format.js';
import { normalizePassword } from '../../lib/lockfile.js';
import { openDocument } from '../../lib/publish.js';
import { verifyBlobBytes, verifyPlaintext } from '../../../shared/verify.js';
import DocResult from './DocResult.jsx';
import { errorText } from './DocumentSection.jsx';
import Section from './Section.jsx';
import {
  compareFingerprint,
  compareWithHead,
  compareWithOlder,
  describeOlderComparison,
  fingerprintOfFile,
  parseDocInput,
  parseFingerprint,
  spacedFingerprint
} from './logic.js';

function FingerprintVerdict({ state }) {
  if (state === 'match') {
    return (
      <Callout tone="good" title="Match">
        The file you chose has exactly the fingerprint you pasted. The two SHA-256 hashes are equal, so the contents are
        the same, byte for byte.
      </Callout>
    );
  }
  if (state === 'different') {
    return (
      <Callout tone="bad" title="No match">
        This is not the same file as the one the pasted fingerprint came from. A single changed byte gives a completely
        different fingerprint.
      </Callout>
    );
  }
  return <p className="ui-muted">Paste a fingerprint above to compare it with this file.</p>;
}

function HeadVerdict({ cmp }) {
  const v = cmp.version ? ` (version ${cmp.version})` : '';
  if (cmp.state === 'same') {
    return cmp.verified ? (
      <Callout tone="good" title={`Same as the latest signed version${v}`}>
        The fingerprint of your file equals the fingerprint inside the file the owner signed for the latest version. The
        document's signatures and version chain also checked out. Only the contents are compared, not file names.
      </Callout>
    ) : (
      <Callout tone="warn" title={`Same as the file in the latest version${v}, but the document did not fully check out`}>
        Your file equals the file stored in the latest version, but not every check on the document passed, so do not
        rely on it. See the document checks below.
      </Callout>
    );
  }
  if (cmp.state === 'different') {
    return (
      <Callout tone="warn" title={`Different from the latest signed version${v}`}>
        The contents of your file are not equal to the latest signed version. On its own this does not say whether your
        file is an older version, an edited copy or a different file.
      </Callout>
    );
  }
  return (
    <Callout tone="info" title="The comparison could not be made">
      {cmp.detail}
    </Callout>
  );
}

// Section 4: fingerprint of a local file, compared with a pasted fingerprint or a document.
export default function FileSection({ pinned }) {
  const [file, setFile] = useState(null);
  const [fp, setFp] = useState({ status: 'idle', hash: '', error: '' });
  const [pasted, setPasted] = useState('');
  const [docInput, setDocInput] = useState('');
  const [docPassword, setDocPassword] = useState('');
  const [docError, setDocError] = useState('');
  const [cmp, setCmp] = useState({ phase: 'idle', step: '', error: '', result: null, view: null });
  const [older, setOlder] = useState({ phase: 'idle', entries: [], outcome: null });
  const hashRun = useRef(0);
  const cmpRun = useRef(0);
  const stopOlder = useRef(false);

  useEffect(
    () => () => {
      hashRun.current += 1;
      cmpRun.current += 1;
      stopOlder.current = true;
    },
    []
  );

  async function onPick(e) {
    const picked = e.target.files && e.target.files[0];
    const mine = ++hashRun.current;
    cmpRun.current += 1;
    stopOlder.current = true;
    setCmp({ phase: 'idle', step: '', error: '', result: null, view: null });
    setOlder({ phase: 'idle', entries: [], outcome: null });
    if (!picked) {
      setFile(null);
      setFp({ status: 'idle', hash: '', error: '' });
      return;
    }
    setFile({ name: picked.name, size: picked.size });
    setFp({ status: 'working', hash: '', error: '' });
    try {
      const hash = await fingerprintOfFile(picked);
      if (hashRun.current === mine) setFp({ status: 'ready', hash, error: '' });
    } catch (err) {
      if (hashRun.current === mine) setFp({ status: 'error', hash: '', error: err.message });
    }
  }

  const pastedState = parseFingerprint(pasted).state;
  const fpVerdict = fp.status === 'ready' ? compareFingerprint(fp.hash, pasted) : { state: 'none' };

  const docParsed = docInput.trim() === '' ? null : parseDocInput(docInput);

  async function onCompare(e) {
    e.preventDefault();
    if (fp.status !== 'ready') {
      setDocError('Choose a file first and wait for its fingerprint.');
      return;
    }
    const p = parseDocInput(docInput);
    if (!p.ok) {
      setDocError(p.error);
      return;
    }
    const used = normalizePassword(docPassword) || p.password;
    if (!used) {
      setDocError('Enter the document password. Without it the stored file cannot be opened for comparison.');
      return;
    }
    setDocError('');
    const mine = ++cmpRun.current;
    stopOlder.current = true;
    setOlder({ phase: 'idle', entries: [], outcome: null });
    setCmp({ phase: 'working', step: 'Fetching the document', error: '', result: null, view: null });
    try {
      const open = await openDocument({
        docId: p.docId,
        password: used,
        pinnedServerKeyId: pinned,
        onStep: (id, text) => {
          if (cmpRun.current === mine) setCmp((c) => ({ ...c, step: text }));
        }
      });
      if (cmpRun.current !== mine) return;
      const result = compareWithHead(fp.hash, open);
      const records = open.bundle && Array.isArray(open.bundle.records) ? open.bundle.records : [];
      setCmp({
        phase: 'done',
        step: '',
        error: '',
        result: { ...result, records, password: used, localHash: fp.hash },
        view: {
          verification: open.verification,
          bundle: open.bundle,
          blobCheck: open.blobCheck,
          plaintextCheck: open.plaintextCheck,
          fingerprint: open.fingerprint,
          file: open.file ? { name: open.file.name, size: open.file.data.length } : null,
          passwordGiven: true
        }
      });
    } catch (err) {
      if (cmpRun.current !== mine) return;
      setCmp({ phase: 'error', step: '', error: errorText(err), result: null, view: null });
    }
  }

  async function onCheckOlder() {
    const info = cmp.result;
    if (!info) return;
    const mine = cmpRun.current;
    stopOlder.current = false;
    setOlder({ phase: 'working', entries: [], outcome: null });
    const outcome = await compareWithOlder({
      localHash: info.localHash,
      records: info.records,
      password: info.password,
      deps: { getBlob, unlock: unlockInWorker, verifyBlob: verifyBlobBytes, verifyPlaintext },
      shouldStop: () => stopOlder.current || cmpRun.current !== mine,
      onVersion: (entry) => {
        if (cmpRun.current === mine) setOlder((o) => ({ ...o, entries: [...o.entries, entry] }));
      }
    });
    if (cmpRun.current !== mine) return;
    setOlder((o) => ({ ...o, phase: 'done', outcome }));
  }

  const comparing = cmp.phase === 'working';
  const result = cmp.result;
  const canOlder = result && result.state === 'different' && result.verified && result.records.length > 1;

  return (
    <Section
      id="verify-file"
      title="4. Check a file"
      intro="Compute the SHA-256 fingerprint of any file on your computer, then compare it with a fingerprint or with a document."
    >
      <Field label="File to check" hint="The file is read in this browser. It is never uploaded.">
        <input type="file" onChange={onPick} />
      </Field>

      <div className="verify-live" role="status" aria-live="polite">
        {fp.status === 'working' ? (
          <p className="verify-loading">
            <Spinner label={null} size="sm" /> Reading the file and computing its fingerprint
          </p>
        ) : null}
      </div>
      {fp.status === 'error' ? (
        <Callout tone="bad" title="This file could not be read">
          {fp.error}
        </Callout>
      ) : null}
      {fp.status === 'ready' ? (
        <div className="verify-block">
          <h3 className="verify-subtitle">Fingerprint (SHA-256)</h3>
          <p className="verify-fp">{spacedFingerprint(fp.hash)}</p>
          <p className="ui-muted">
            {file ? `${file.name}, ${formatBytes(file.size)}. ` : ''}
            <CopyButton text={fp.hash} label="Copy" describe="fingerprint" />
          </p>
        </div>
      ) : null}

      <div className="verify-block">
        <h3 className="verify-subtitle">Compare with a fingerprint</h3>
        <Field
          label="Fingerprint to compare (optional)"
          hint="Paste the 64 character fingerprint you were given. Spaces are ignored."
          error={pastedState === 'invalid' ? 'That does not look like a fingerprint. It is 64 letters and numbers (0-9, a-f).' : ''}
        >
          <input
            type="text"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            maxLength={200}
            className="verify-mono-input"
          />
        </Field>
        <div aria-live="polite" role="status" className="verify-verdict">
          {fp.status === 'ready' && pastedState !== 'invalid' ? <FingerprintVerdict state={fpVerdict.state} /> : null}
          {fp.status !== 'ready' && pastedState === 'ok' ? <p className="ui-muted">Choose a file to compare.</p> : null}
        </div>
      </div>

      <form className="verify-block verify-form" onSubmit={onCompare} noValidate>
        <h3 className="verify-subtitle">Compare with a document</h3>
        <p>
          Unlocks the latest version of a document with its password and checks whether the file you chose has the same
          contents.
        </p>
        <Field label="Document id or link">
          <input
            type="text"
            value={docInput}
            onChange={(e) => {
              setDocInput(e.target.value);
              setDocError('');
            }}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            maxLength={2100}
            className="verify-mono-input"
          />
        </Field>
        <Field
          label="Document password"
          hint={
            docParsed && docParsed.ok && docParsed.password
              ? 'The link already includes a password. Leave this empty to use it.'
              : 'Stays in this browser. Opening the file takes a moment.'
          }
          error={docError}
        >
          <input
            type="password"
            value={docPassword}
            onChange={(e) => {
              setDocPassword(e.target.value);
              setDocError('');
            }}
            autoComplete="off"
            spellCheck={false}
            maxLength={256}
          />
        </Field>
        <div className="ui-row">
          <Button type="submit" variant="primary" loading={comparing}>
            {comparing ? 'Comparing' : 'Unlock and compare'}
          </Button>
        </div>
      </form>

      <div className="verify-live" role="status" aria-live="polite">
        {comparing ? (
          <p className="verify-loading">
            <Spinner label={null} size="sm" /> {cmp.step}
          </p>
        ) : null}
      </div>

      {cmp.phase === 'error' ? (
        <Callout tone="bad" title="The document could not be opened">
          {cmp.error}
        </Callout>
      ) : null}

      {cmp.phase === 'done' && result ? (
        <div className="verify-block">
          <HeadVerdict cmp={result} />

          {canOlder ? (
            <div className="verify-block">
              <p>
                To see whether your file is an older version, each older version can be unlocked with the same password
                and compared. Versions that use a different password cannot be compared.
              </p>
              <div className="ui-row">
                <Button onClick={onCheckOlder} loading={older.phase === 'working'}>
                  Check older versions too
                </Button>
                {older.phase === 'working' ? (
                  <Button variant="ghost" onClick={() => (stopOlder.current = true)}>
                    Stop
                  </Button>
                ) : null}
              </div>
              <div aria-live="polite" role="status">
                {older.entries.length > 0 ? (
                  <ul className="ui-checks">
                    {older.entries.map((entry) => (
                      <li
                        key={entry.version}
                        className={`ui-checks__item ${entry.state === 'same' ? 'is-ok' : ''}`}
                      >
                        <span className="ui-checks__mark">
                          <Icon name={entry.state === 'same' ? 'check' : 'info'} />
                        </span>
                        <div>
                          <p className="ui-checks__name">
                            Version {entry.version}:{' '}
                            {entry.state === 'same'
                              ? 'identical to your file'
                              : entry.state === 'different'
                                ? 'not identical to your file'
                                : 'could not be compared'}
                          </p>
                          {entry.detail ? <p className="ui-checks__detail">{entry.detail}</p> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {older.phase === 'done' && older.outcome ? (
                  <Callout tone={older.outcome.match ? 'warn' : 'info'} title="Older versions">
                    {describeOlderComparison(older.outcome)}
                  </Callout>
                ) : null}
              </div>
            </div>
          ) : null}

          {cmp.result && cmp.view ? (
            <details className="verify-details-toggle">
              <summary>Show the document checks</summary>
              <DocResult {...cmp.view} />
            </details>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
