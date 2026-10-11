import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import Icon from '../Icon.jsx';
import ScreenHeader from '../ScreenHeader.jsx';
import VerifySummary from '../VerifySummary.jsx';
import { versionLine } from '../../lib/format.js';
import { verdictFor } from '../../lib/trust.js';
import Certificate from './Certificate.jsx';
import FileDetails from './FileDetails.jsx';
import PasswordLine from './PasswordLine.jsx';
import VersionList from './VersionList.jsx';
import { revokeReason } from './docLogic.js';
import { fileTitle, openLabel, versionRows } from './pageLogic.js';

// What the file page shows once the file is loaded. It only draws: the page (src/pages/DocumentPage.jsx)
// owns the state and passes the results of the checks and the handlers in.
//   result            what openDocument() returned
//   trust             the state of the server key (see VerifySummary)
//   pinned            the key the person pinned on purpose, '' when none
//   access, note      ownerAccess() and ownerNote(): what the signed in person may do
//   plan              openPlan(): what the Open file button does
//   showAsk           show the one line password prompt
//   onShare, onOpen, onSubmitPassword, onManage   handlers
//   sharing, opening  true while Share or Open file is running: the button is disabled so a double click does it once
export default function FileView({
  docId,
  result,
  trust,
  pinned = '',
  checkedAt,
  now,
  access,
  note = '',
  plan,
  showAsk = false,
  busy = false,
  unlockError = '',
  detailsOpen = false,
  onDetailsToggle,
  detailsRef,
  onShare,
  onOpen,
  sharing = false,
  opening = false,
  onSubmitPassword,
  onManage,
  backTo = '/verify'
}) {
  const { bundle, verification } = result;
  const head = verification && verification.head ? verification.head : null;
  const revoked = Boolean(verification) && verification.status === 'revoked';
  // Not verified: a failed check, an older answer than this browser saw, or a changed server key (a red verdict).
  const verified = Boolean(verification) && verification.ok === true && verdictFor(result, trust).tone !== 'bad';
  const title = fileTitle(bundle, verification);
  const subtitle = revoked ? 'Withdrawn' : head && Number.isFinite(head.createdAt) ? versionLine(head.version, head.createdAt, now) : '';
  const reason = revoked ? revokeReason(bundle) : '';
  const promptShown = showAsk && plan.kind !== 'ready' && plan.kind !== 'none';

  const actions = access && access.allowed ? (
    <Button size="sm" onClick={onManage}>
      <Icon name="edit" size={16} /> Manage
    </Button>
  ) : null;

  return (
    <>
      <div className="doc-screen">
        <ScreenHeader title={title} subtitle={subtitle} back backTo={backTo} documentTitle={title} actions={actions} />
        <div className="ui-container ui-container--narrow doc-body">
          <VerifySummary result={result} trust={trust} compact />

          {revoked ? (
            <p className="doc-reason" data-testid="doc-reason">
              <strong>Reason given by the owner:</strong> {reason || 'none given'}
            </p>
          ) : null}

          <div className="doc-actions">
            <Button onClick={onShare} pending={sharing}>
              <Icon name="share" size={20} /> Share
            </Button>
            {plan.kind !== 'none' ? (
              <Button variant="primary" onClick={onOpen} loading={busy && !showAsk} pending={opening}>
                <Icon name="download" size={20} /> {openLabel({ verified, kind: plan.kind })}
              </Button>
            ) : null}
          </div>
          {plan.text && !(promptShown && plan.kind === 'wrong') ? <p className="ui-muted doc-actions__note">{plan.text}</p> : null}
          {plan.kind === 'ready' && !verified ? (
            <Callout tone="warn" title="Not verified">
              The file opened, but the checks above did not all pass. Do not treat it as the latest signed version.
            </Callout>
          ) : null}

          {promptShown ? (
            <PasswordLine onSubmit={onSubmitPassword} busy={busy} error={unlockError || (plan.kind === 'wrong' ? plan.text : '')} />
          ) : null}
          {unlockError && !showAsk ? (
            <Callout tone="bad" title="Could not check the file">
              {unlockError}
            </Callout>
          ) : null}

          {note ? <p className="ui-muted">{note}</p> : null}
          {access && access.isOwner && !access.allowed && access.reason && !revoked ? <p className="ui-muted">{access.reason}</p> : null}

          <section className="doc-section" aria-labelledby="doc-versions-title">
            <h2 className="doc-section__title" id="doc-versions-title">
              Versions
            </h2>
            <VersionList rows={versionRows(bundle, now)} />
          </section>

          <FileDetails
            docId={docId}
            bundle={bundle}
            verification={verification}
            pinnedServerKeyId={pinned}
            trust={trust}
            open={detailsOpen}
            onToggle={onDetailsToggle}
            summaryRef={detailsRef}
          />
        </div>
      </div>

      <Certificate bundle={bundle} verification={verification} pinnedServerKeyId={pinned} checkedAt={checkedAt || Date.now()} />
    </>
  );
}
