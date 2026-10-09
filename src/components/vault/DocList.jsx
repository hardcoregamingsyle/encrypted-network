import { Link } from 'react-router-dom';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import EmptyState from '../EmptyState.jsx';
import HashText from '../HashText.jsx';
import KeyBadge from '../KeyBadge.jsx';
import { formatTime, timeAgo } from '../../lib/format.js';
import { displayLabel, statusView } from './vaultLogic.js';

export function StatusBadge({ status }) {
  const v = statusView(status);
  return <span className={`ui-badge ui-badge--${v.tone}`}>{v.text}</span>;
}

// Loading placeholders with the same height as real rows, so the page does not jump.
export function SkeletonRows({ count = 3, label = 'Loading documents' }) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push(
      <li className="vault-doc vault-doc--skeleton" key={i} aria-hidden="true">
        <div className="vault-skel vault-skel--line" />
        <div className="vault-skel vault-skel--small" />
      </li>
    );
  }
  return (
    <div role="status" aria-live="polite">
      <span className="ui-sr-only">{label}</span>
      <ul className="vault-list" aria-hidden="true">
        {items}
      </ul>
    </div>
  );
}

function Time({ ms, approx }) {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return <span>time unknown</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={formatTime(ms)}>
      {`${approx ? 'published' : 'updated'} ${timeAgo(ms)}`}
    </time>
  );
}

// One row. doc has docId, label, status, version, updatedAt and optionally owner fields.
export function DocRow({ doc, showOwner = false, onForget }) {
  const dead = doc.status === 'missing';
  return (
    <li className="vault-doc">
      <div className="vault-doc__main">
        <div className="vault-doc__title">
          {dead ? (
            <span className="vault-doc__name">{displayLabel(doc.label)}</span>
          ) : (
            <Link className="vault-doc__name" to={`/d/${doc.docId}`}>
              {displayLabel(doc.label)}
            </Link>
          )}
          <StatusBadge status={doc.status} />
          {doc.listed ? <span className="ui-badge ui-badge--info">In public list</span> : null}
        </div>
        <div className="vault-doc__meta">
          {Number.isFinite(doc.version) ? <span>{`Version ${doc.version}`}</span> : null}
          <Time ms={doc.updatedAt} approx={doc.approxTime} />
          {showOwner ? (
            <span className="vault-doc__owner">
              <span className="ui-sr-only">Published by </span>
              <KeyBadge keyId={doc.ownerKeyId} name={doc.ownerName} />
            </span>
          ) : null}
          <span className="vault-doc__id">
            <span className="ui-sr-only">Document id </span>
            <HashText value={doc.docId} short length={10} />
          </span>
        </div>
        {dead ? (
          <p className="ui-muted vault-doc__note">
            The server does not have this document. It was probably published to another server or never finished.
          </p>
        ) : null}
        {doc.status === 'unknown' ? (
          <p className="ui-muted vault-doc__note">Could not check this document right now. Open it to try again.</p>
        ) : null}
      </div>
      {onForget && doc.local ? (
        <Button size="sm" variant="ghost" onClick={() => onForget(doc.docId)} aria-label={`Remove from list: ${displayLabel(doc.label)}`}>
          Remove from list
        </Button>
      ) : null}
    </li>
  );
}

// The body of a list card: skeletons, error, empty message or rows, plus the load more button.
// list is what useDocumentList returned (status, items, error, hasMore, moreBusy, moreError, reload, loadMore).
// rows are the rows to show (the list items, or a merged version of them).
export function DocListBody({ list, rows, empty, showOwner, onForget, errorTitle = 'Could not load the documents', busyLabel }) {
  const loadingFirst = list.status === 'loading' && rows.length === 0;
  if (loadingFirst) return <SkeletonRows label={busyLabel} />;
  if (list.status === 'error') {
    return (
      <Callout tone="bad" title={errorTitle}>
        <p>{list.error}</p>
        <p>
          <Button size="sm" onClick={list.reload}>
            Try again
          </Button>
        </p>
      </Callout>
    );
  }
  if (rows.length === 0) return <EmptyState title={empty.title}>{empty.text}</EmptyState>;
  return (
    <div aria-busy={list.status === 'loading' ? 'true' : undefined}>
      <ul className={`vault-list ${list.status === 'loading' ? 'is-stale' : ''}`.trim()}>
        {rows.map((d) => (
          <DocRow key={d.docId} doc={d} showOwner={showOwner} onForget={onForget} />
        ))}
      </ul>
      {list.moreError ? (
        <Callout tone="bad" title="Could not load more">
          <p>{list.moreError}</p>
        </Callout>
      ) : null}
      {list.hasMore ? (
        <div className="vault-more">
          <Button onClick={list.loadMore} loading={list.moreBusy}>
            Load more
          </Button>
        </div>
      ) : null}
      <p className="ui-sr-only" role="status" aria-live="polite">
        {list.announce}
      </p>
    </div>
  );
}
