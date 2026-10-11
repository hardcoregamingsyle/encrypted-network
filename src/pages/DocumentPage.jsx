import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import Button from '../components/Button.jsx';
import Callout from '../components/Callout.jsx';
import { copyText } from '../components/CopyButton.jsx';
import ScreenHeader from '../components/ScreenHeader.jsx';
import Spinner from '../components/Spinner.jsx';
import { useToast } from '../components/Toast.jsx';
import useBusyAction from '../components/useBusyAction.js';
import FileView from '../components/doc/FileView.jsx';
import ManageSheet from '../components/doc/ManageSheet.jsx';
import { cleanDocId, describeLoadError, docIdProblem, hasPassword, ownerAccess, safeFileName, tidyPassword } from '../components/doc/docLogic.js';
import { fileTitle, initialPassword, openPlan, ownerNote, sharePassword, sharePlan, updateToast } from '../components/doc/pageLogic.js';
import { saveFile } from '../components/doc/saveFile.js';
import { shareLink, shareToast } from '../components/files/shareLogic.js';
import { focusHeading, focusIsLost } from '../lib/focus.js';
import { parseFragment } from '../lib/links.js';
import { normalizePassword } from '../lib/lockfile.js';
import { getPinnedServerKeyId, loadServerTrustOnce } from '../lib/pin.js';
import { openDocument } from '../lib/publish.js';
import { useSession } from '../lib/session.jsx';
import { getDocPassword } from '../lib/vault.js';
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
          <span className="ui-btn__label">Check a file</span>
        </Link>
        <Link className="ui-btn ui-btn--ghost" to="/files">
          <span className="ui-btn__label">Go to your files</span>
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

// Route /d/:docId. A signed file: who signed it, whether it is the latest version and unchanged,
// Share and Open file, the versions, and (for the owner) Manage. Anyone can open this page.
export default function DocumentPage() {
  const params = useParams();
  const location = useLocation();
  const docId = cleanDocId(params.docId);
  const idProblem = docIdProblem(docId);
  const session = useSession();
  const toast = useToast();
  const { identity, status: sessionStatus } = session;
  const sessionReady = sessionStatus !== 'loading';
  const signedIn = sessionStatus === 'ready' && Boolean(identity);
  // Back with no earlier screen in the app: a signed in person goes to their files, a visitor who followed a link goes to Verify.
  const backTarget = signedIn ? '/files' : '/verify';

  const [phase, setPhase] = useState(idProblem ? 'error' : 'loading');
  const [error, setError] = useState(idProblem ? { kind: 'notfound', title: 'Not a document id', text: idProblem } : null);
  const [result, setResult] = useState(null);
  const [trust, setTrust] = useState('');
  const [checkedAt, setCheckedAt] = useState(null);
  const [password, setPassword] = useState('');
  const [unlockedWith, setUnlockedWith] = useState('');
  const [busy, setBusy] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const [loadLine, setLoadLine] = useState('');
  const [pinned, setPinned] = useState(() => getPinnedServerKeyId());
  const [asking, setAsking] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [managePw, setManagePw] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);

  const runId = useRef(0);
  const hashRef = useRef(location.hash);
  hashRef.current = location.hash;
  // One page view = one router location. The trust state is decided once per view (see loadServerTrustOnce).
  const viewRef = useRef(location.key);
  viewRef.current = location.key;
  // The address this page was opened with belongs to the first load below, so the later effect that reads
  // a new fragment must not load it a second time while the session is still starting.
  const handledKey = useRef(location.key + '|' + location.hash);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const detailsRef = useRef(null);

  // Opens the file (fetch, verify, and unlock when there is a password) and returns what came back.
  // mode 'first' shows the full page spinner, 'again' keeps the current page and only marks it busy.
  const run = useCallback(
    async (pw, mode) => {
      const id = ++runId.current;
      pw = tidyPassword(pw);
      if (mode === 'first') {
        setPhase('loading');
        setError(null);
        setLoadLine('Fetching the document');
      } else {
        setBusy(true);
        setUnlockError('');
      }
      try {
        // The server key this browser trusts (pinned, remembered, or the first one it sees).
        const known = await loadServerTrustOnce(viewRef.current);
        if (runId.current !== id) return null;
        const out = await openDocument({
          docId,
          password: hasPassword(pw) ? pw : undefined,
          pinnedServerKeyId: known.pin,
          onStep: (stepId, text) => {
            if (runId.current === id && mode === 'first' && typeof text === 'string') setLoadLine(text);
          }
        });
        if (runId.current !== id) return null;
        setResult(out);
        setTrust(known.trust);
        setPinned(getPinnedServerKeyId());
        setCheckedAt(Date.now());
        setUnlockedWith(out.plaintextCheck && out.plaintextCheck.ok ? normalizePassword(pw) : '');
        setPhase('ready');
        return out;
      } catch (err) {
        if (runId.current !== id) return null;
        const info = describeLoadError(err, '');
        if (mode === 'first') {
          setError(info);
          setPhase('error');
        } else {
          setUnlockError(info.title + '. ' + info.text);
        }
        return null;
      } finally {
        if (runId.current === id) setBusy(false);
      }
    },
    [docId]
  );

  // First load. The password in the link is used if there is one, otherwise the owner's own copy.
  useEffect(() => {
    if (docIdProblem(docId)) {
      setPhase('error');
      setError({ kind: 'notfound', title: 'Not a document id', text: docIdProblem(docId) });
      return undefined;
    }
    if (!sessionReady) return undefined;
    let cancelled = false;
    const fragment = hashRef.current;
    const hadLink = parseFragment(fragment) !== null;
    handledKey.current = location.key + '|' + location.hash;
    // The password was read, so it does not need to stay in the address bar, the history entry or
    // a printed page footer. Share builds the link again when it is needed.
    if (hadLink) dropFragment();
    setResult(null);
    setUnlockedWith('');
    setAsking(false);
    (async () => {
      const { password: pw } = await initialPassword({ docId, fragment, signedIn, getStored: getDocPassword });
      if (cancelled) return;
      setPassword(pw);
      run(pw, 'first');
    })();
    return () => {
      cancelled = true;
      runId.current += 1;
    };
    // signedIn is read once per load: signing in later does not reload the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, run, sessionReady]);

  // A password added to the address after the page loaded (a client side link, or a pasted address)
  // is read too, then removed from the address bar.
  // A new address that differs only in its fragment keeps the router's key, so the fragment is part of what was handled.
  // The address bar is the truth: the router's copy of the fragment can be one that was already removed.
  const takeFragment = useCallback(() => {
    const live = typeof window !== 'undefined' ? window.location.hash : '';
    const fromLink = parseFragment(live) || '';
    if (!fromLink || docIdProblem(docId)) return;
    const pw = tidyPassword(fromLink);
    dropFragment();
    setPassword(pw);
    run(pw, phaseRef.current === 'ready' ? 'again' : 'first');
  }, [docId, run]);

  useEffect(() => {
    const id = location.key + '|' + location.hash;
    if (handledKey.current === id || docIdProblem(docId)) return;
    handledKey.current = id;
    takeFragment();
  }, [location.key, location.hash, docId, takeFragment]);

  // Typing or pasting an address with a new #k= into the address bar of this same page fires hashchange.
  useEffect(() => {
    window.addEventListener('hashchange', takeFragment);
    return () => window.removeEventListener('hashchange', takeFragment);
  }, [takeFragment]);

  // The loading view is replaced by the result (or the error): keep focus on the new heading.
  useEffect(() => {
    if (phase === 'loading' || !focusIsLost()) return;
    const heading = document.querySelector('#main h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }, [phase]);

  const verification = result ? result.verification : null;
  const bundle = result ? result.bundle : null;
  const revoked = Boolean(verification) && verification.status === 'revoked';

  // The owner's tools vanish with a withdrawn file and take the focused control along.
  useEffect(() => {
    if (revoked) focusHeading();
  }, [revoked]);

  const reload = useCallback((pw) => run(typeof pw === 'string' ? pw : password, 'again'), [run, password]);

  function saveOpened(file) {
    saveFile(safeFileName(file.name), file.data);
    toast.push({ tone: 'info', text: 'The file is saved to your downloads.' });
  }

  // A second press while the first one is running (or just done) is ignored, so one click makes one download.
  const [share, sharing] = useBusyAction(shareNow, { holdMs: 600 });
  const [openFile, opening] = useBusyAction(openNow, { holdMs: 1200 });

  if (phase === 'loading') {
    return (
      <div className="ui-screen doc-page">
        <ScreenHeader title="Checking the document" back backTo={backTarget} documentTitle="File" />
        <div className="ui-container ui-container--narrow doc-body">
          <div className="doc-loading" aria-busy="true">
            <Spinner label="Loading the document" />
            <p className="ui-muted" role="status" aria-live="polite">
              {loadLine}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'error' || !result) {
    return (
      <div className="ui-screen doc-page">
        <ScreenHeader title="File" back backTo={backTarget} />
        <div className="ui-container ui-container--narrow doc-body">
          <ErrorView
            error={error || { kind: 'other', title: 'Could not open the document', text: 'Try again.' }}
            onRetry={() => run(password, 'first')}
          />
        </div>
      </div>
    );
  }

  const head = verification && verification.head ? verification.head : null;
  const access = ownerAccess({ identity, bundle, verification });
  const note = ownerNote({ identity, keys: session.keys, bundle, access });
  const plan = openPlan({ result, revoked });
  const showAsk = asking || plan.kind === 'wrong';
  const title = fileTitle(bundle, verification);

  async function shareNow() {
    const pw = await sharePassword({ docId, unlockedWith, isOwner: access.isOwner, getStored: getDocPassword });
    const planned = sharePlan({ docId, password: pw });
    const outcome = await shareLink({ link: planned.link, title }, { copy: copyText });
    const message = shareToast(outcome, { withPassword: planned.withPassword });
    if (message) toast.push(message);
  }

  async function openNow() {
    if (plan.kind === 'ready' && result.file) {
      saveOpened(result.file);
      return;
    }
    // Try the owner's own copy of the password before asking.
    if (plan.kind === 'ask' && signedIn) {
      const stored = await getDocPassword(docId);
      if (stored) {
        setPassword(tidyPassword(stored));
        const out = await run(stored, 'again');
        if (out && out.file) {
          saveOpened(out.file);
          return;
        }
      }
    }
    setAsking(true);
  }

  async function submitPassword(pw) {
    setPassword(pw);
    const out = await run(pw, 'again');
    if (out && out.file) {
      setAsking(false);
      saveOpened(out.file);
    }
  }

  async function openManage() {
    setManageOpen(true);
    const pw = unlockedWith || (await getDocPassword(docId)) || '';
    setManagePw(tidyPassword(pw));
  }

  function showDetails() {
    setManageOpen(false);
    setDetailsOpen(true);
    setTimeout(() => {
      const el = detailsRef.current;
      if (!el) return;
      el.scrollIntoView({ block: 'start' });
      el.focus();
    }, 0);
  }

  return (
    <div className="ui-screen doc-page">
      <FileView
        backTo={backTarget}
        docId={docId}
        result={result}
        trust={trust}
        pinned={pinned}
        checkedAt={checkedAt}
        access={access}
        note={note}
        plan={plan}
        showAsk={showAsk}
        busy={busy}
        unlockError={unlockError}
        detailsOpen={detailsOpen}
        onDetailsToggle={setDetailsOpen}
        detailsRef={detailsRef}
        onShare={share}
        onOpen={openFile}
        sharing={sharing}
        opening={opening}
        onSubmitPassword={submitPassword}
        onManage={openManage}
      />

      {access.allowed ? (
        <ManageSheet
          open={manageOpen}
          onClose={() => setManageOpen(false)}
          docId={docId}
          head={access.head}
          identity={identity}
          password={managePw || unlockedWith}
          previousLabel={head && typeof head.label === 'string' ? head.label : ''}
          onUpdated={async (pw, info) => {
            const clean = tidyPassword(pw);
            setPassword(clean);
            setManagePw(clean);
            // The update is done: close the sheet so it does not offer the next version, and say so in a toast.
            setManageOpen(false);
            toast.push(updateToast(info));
            await reload(clean);
          }}
          onWithdrawn={async () => {
            setManageOpen(false);
            await reload('');
          }}
          onReload={() => reload(password)}
          onDetails={showDetails}
        />
      ) : null}
    </div>
  );
}
