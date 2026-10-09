import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import Button from '../components/Button.jsx';
import Callout from '../components/Callout.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Spinner from '../components/Spinner.jsx';
import VerifyResult from '../components/VerifyResult.jsx';
import Certificate from '../components/doc/Certificate.jsx';
import DocSummary from '../components/doc/DocSummary.jsx';
import DocTimeline from '../components/doc/DocTimeline.jsx';
import ProgressList from '../components/doc/ProgressList.jsx';
import PublishVersion from '../components/doc/PublishVersion.jsx';
import RevokePanel from '../components/doc/RevokePanel.jsx';
import SharePanel from '../components/doc/SharePanel.jsx';
import UnlockPanel from '../components/doc/UnlockPanel.jsx';
import {
  cleanDocId,
  describeLoadError,
  docIdProblem,
  hasPassword,
  ownerAccess,
  tidyPassword,
  verdictSentence
} from '../components/doc/docLogic.js';
import { useSteps } from '../components/doc/useSteps.js';
import { useIdentity } from '../lib/identity.jsx';
import { focusIsLost } from '../lib/focus.js';
import { parseFragment } from '../lib/links.js';
import { normalizePassword } from '../lib/lockfile.js';
import { getPinnedServerKeyId } from '../lib/pin.js';
import { openDocument } from '../lib/publish.js';
import '../styles/doc.css';

function ErrorView({ error, onRetry }) {
  const tone = error.kind === 'notfound' ? 'warn' : 'bad';
  return (
    <div className="ui-stack">
      <Callout tone={tone} title={error.title}>
        {error.text}
      </Callout>
      <div className="ui-row">
        {error.kind !== 'notfound' && onRetry ? (
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        <Link className="ui-btn ui-btn--ghost" to="/verify">
          <span className="ui-btn__label">Open the verify page</span>
        </Link>
        <Link className="ui-btn ui-btn--ghost" to="/">
          <span className="ui-btn__label">Go to your documents</span>
        </Link>
      </div>
    </div>
  );
}

// Removes #k=... from the address bar without adding a history entry. The router state is kept.
function dropFragment() {
  try {
    if (typeof window === 'undefined' || !window.location.hash) return;
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  } catch {
    // an address that cannot be changed is left as it is
  }
}

export default function DocumentPage() {
  const params = useParams();
  const location = useLocation();
  const docId = cleanDocId(params.docId);
  const idProblem = docIdProblem(docId);
  const { identity, status: identityStatus } = useIdentity();

  const [phase, setPhase] = useState(idProblem ? 'error' : 'loading');
  const [error, setError] = useState(idProblem ? { kind: 'notfound', title: 'Not a document id', text: idProblem } : null);
  const [result, setResult] = useState(null);
  const [checkedAt, setCheckedAt] = useState(null);
  const [password, setPassword] = useState('');
  const [unlockedWith, setUnlockedWith] = useState('');
  const [busy, setBusy] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [loadSteps, onLoadStep, resetLoadSteps] = useSteps();
  const [unlockSteps, onUnlockStep, resetUnlockSteps] = useSteps();
  const [pinned, setPinned] = useState(() => getPinnedServerKeyId());

  const runId = useRef(0);
  const lastStep = useRef('');
  const hashRef = useRef(location.hash);
  hashRef.current = location.hash;
  const handledKey = useRef('');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Opens the document (fetch, verify, and unlock when there is a password).
  // mode 'first' shows the full page spinner, 'again' keeps the current page and shows progress.
  const run = useCallback(
    async (pw, mode) => {
      const id = ++runId.current;
      const pin = getPinnedServerKeyId();
      pw = tidyPassword(pw);
      setPinned(pin);
      const stepSink = mode === 'first' ? onLoadStep : onUnlockStep;
      lastStep.current = '';
      if (mode === 'first') {
        setPhase('loading');
        setError(null);
        resetLoadSteps();
      } else {
        setBusy(true);
        setUnlockError('');
        resetUnlockSteps();
      }
      try {
        const out = await openDocument({
          docId,
          password: hasPassword(pw) ? pw : undefined,
          pinnedServerKeyId: pin,
          onStep: (stepId, text) => {
            if (runId.current !== id) return;
            lastStep.current = stepId;
            stepSink(stepId, text);
          }
        });
        if (runId.current !== id) return;
        setResult(out);
        setCheckedAt(Date.now());
        setUnlockedWith(out.plaintextCheck && out.plaintextCheck.ok ? normalizePassword(pw) : '');
        setPhase('ready');
      } catch (err) {
        if (runId.current !== id) return;
        const info = describeLoadError(err, lastStep.current);
        if (mode === 'first') {
          setError(info);
          setPhase('error');
        } else {
          setUnlockError(info.title + '. ' + info.text);
        }
      } finally {
        if (runId.current === id) setBusy(false);
      }
    },
    [docId, onLoadStep, onUnlockStep, resetLoadSteps, resetUnlockSteps]
  );

  // First load. The password in the link fragment is used if there is one.
  useEffect(() => {
    if (docIdProblem(docId)) {
      setPhase('error');
      setError({ kind: 'notfound', title: 'Not a document id', text: docIdProblem(docId) });
      return undefined;
    }
    const fromLink = parseFragment(hashRef.current) || '';
    const pw = fromLink ? tidyPassword(fromLink) : '';
    handledKey.current = location.key;
    // The password was read, so it does not need to stay in the address bar, the history entry or
    // a printed page footer. The share panel builds the link again when it is needed.
    if (fromLink) dropFragment();
    setPassword(pw);
    setResult(null);
    setUnlockedWith('');
    run(pw, 'first');
    return () => {
      runId.current += 1;
    };
  }, [docId, run]);

  // A password added to the address after the page loaded (a client side link, or a pasted address)
  // is read too, then removed from the address bar.
  useEffect(() => {
    if (handledKey.current === location.key || docIdProblem(docId)) return;
    handledKey.current = location.key;
    const fromLink = parseFragment(location.hash) || '';
    if (!fromLink) return;
    const pw = tidyPassword(fromLink);
    dropFragment();
    setPassword(pw);
    run(pw, phaseRef.current === 'ready' ? 'again' : 'first');
  }, [location.key, location.hash, docId, run]);

  // The loading view is replaced by the result (or the error): keep focus on the new heading.
  useEffect(() => {
    if (phase === 'loading' || !focusIsLost()) return;
    const heading = document.querySelector('#main h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }, [phase]);

  const unlock = useCallback((pw) => run(typeof pw === 'string' ? pw : password, 'again'), [run, password]);
  const reload = useCallback((pw) => run(pw, 'again'), [run]);

  if (phase === 'loading') {
    return (
      <div className="ui-container ui-container--narrow">
        <PageHeader title="Checking the document" lead="Fetching the signed records and checking them in this browser." documentTitle="Document" />
        <div className="ui-card doc-card doc-loading" aria-busy="true">
          <Spinner label="Loading the document" />
          <ProgressList steps={loadSteps} busy label="Loading progress" />
        </div>
      </div>
    );
  }

  if (phase === 'error' || !result) {
    return (
      <div className="ui-container ui-container--narrow">
        <PageHeader title="Document" lead="This document could not be opened." documentTitle="Document" />
        <ErrorView error={error || { kind: 'other', title: 'Could not open the document', text: 'Try again.' }} onRetry={() => run(password, 'first')} />
      </div>
    );
  }

  const { bundle, verification } = result;
  const verified = verification && verification.ok === true;
  const revoked = verification && verification.status === 'revoked';
  const head = verification && verification.head ? verification.head : null;
  const verdict = verdictSentence(verification, { pinned: !!pinned, bundle });
  const access = ownerAccess({ identity, bundle, verification });
  const title = head && head.label ? head.label : 'Document';

  return (
    <div className="ui-container doc-page">
      <div className="doc-screen">
        <PageHeader
          title={title}
          lead={revoked ? 'The owner revoked this document.' : 'Signed document with a public version history.'}
          documentTitle={title}
          actions={
            <Button onClick={() => window.print()}>Print verification report</Button>
          }
        />

        <div className="doc-layout">
          <section className="doc-block" aria-labelledby="doc-verify-title">
            <h2 className="doc-block__title" id="doc-verify-title">
              Verification
            </h2>
            <VerifyResult result={verification} />
            <p className={`doc-verdict doc-verdict--${verdict.tone}`} data-testid="doc-verdict">
              {verdict.text}
            </p>
          </section>

          <DocSummary docId={docId} bundle={bundle} verification={verification} pinnedServerKeyId={pinned} />

          <UnlockPanel
            result={result}
            verified={verified}
            revoked={revoked}
            password={password}
            onPassword={setPassword}
            onUnlock={unlock}
            busy={busy}
            steps={unlockSteps}
            error={unlockError}
          />

          {access.allowed ? (
            <>
              <PublishVersion
                docId={docId}
                head={access.head}
                identity={identity}
                unlockedWith={unlockedWith}
                previousLabel={head && typeof head.label === 'string' ? head.label : ''}
                onReload={() => reload(password)}
                onPublished={(pw) => {
                  setPassword(tidyPassword(pw));
                  return reload(pw);
                }}
              />
              <RevokePanel docId={docId} head={access.head} identity={identity} onRevoked={() => reload('')} />
            </>
          ) : access.isOwner ? (
            <section className="ui-card doc-card" aria-labelledby="doc-owner-title">
              <h2 className="ui-card__title" id="doc-owner-title">
                Owner tools
              </h2>
              <Callout tone="warn" title="Owner tools are not available">
                {access.reason}
              </Callout>
            </section>
          ) : identityStatus === 'none' && !revoked && verified ? (
            <p className="ui-muted doc-owner-note">
              Are you the owner? Restore your identity on the <Link to="/keys">Identity page</Link> to publish new versions or revoke
              this document.
            </p>
          ) : null}

          <SharePanel
            docId={docId}
            bundle={bundle}
            headVersion={head ? head.version : null}
            pinnedServerKeyId={pinned}
            password={unlockedWith || (result.plaintextCheck && !result.plaintextCheck.ok ? '' : password)}
            confirmed={!!unlockedWith}
          />

          <DocTimeline bundle={bundle} verified={verified} />
        </div>
      </div>

      <Certificate bundle={bundle} verification={verification} pinnedServerKeyId={pinned} checkedAt={checkedAt || Date.now()} />
    </div>
  );
}
