import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import EmptyState from '../EmptyState.jsx';
import { ItemList } from '../ListItem.jsx';
import Skeleton from '../Skeleton.jsx';
import FileRow from './FileRow.jsx';

// The body of a file list: skeleton rows while loading, an error with a retry, an empty note, or the rows
// with a Load more button. list is what useFileList (or useMineFiles) returned.
export default function FileList({ list, rows, empty, showOwner = false, onForget, busyLabel = 'Loading files', errorTitle = 'Could not load the files', action, now }) {
  if (list.status === 'loading' && rows.length === 0) return <Skeleton variant="row" count={4} label={busyLabel} />;
  if (list.status === 'error' && rows.length === 0) {
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
  if (rows.length === 0) {
    return (
      <EmptyState art="files" title={empty.title} action={action}>
        {empty.text}
      </EmptyState>
    );
  }
  return (
    <div aria-busy={list.status === 'loading' ? 'true' : undefined} className={list.status === 'loading' ? 'files-stale' : undefined}>
      {list.status === 'error' ? (
        <Callout tone="warn" title="Showing what this browser remembers">
          <p>{list.error}</p>
        </Callout>
      ) : null}
      <ItemList label="Files" className="files-list">
        {rows.map((row) => (
          <FileRow key={row.docId} row={row} showOwner={showOwner} onForget={onForget} now={now} />
        ))}
      </ItemList>
      {list.moreError ? (
        <Callout tone="bad" title="Could not load more">
          <p>{list.moreError}</p>
        </Callout>
      ) : null}
      {list.hasMore ? (
        <div className="files-more">
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
