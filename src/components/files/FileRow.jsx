import Button from '../Button.jsx';
import Icon from '../Icon.jsx';
import ListItem from '../ListItem.jsx';
import { fileKind } from '../../lib/format.js';
import { documentRoute } from '../vault/vaultLogic.js';
import { publicSubtitle, rowIcon, rowSubtitle, rowTitle, seenFor, statusChip } from './filesLogic.js';

// The round file icon at the left of a row. The colour follows the kind of file (pdf, image, ...).
export function FileIcon({ label }) {
  const kind = fileKind(typeof label === 'string' ? label.trim() : '');
  return (
    <span className={`files-icon files-icon--${kind}`} aria-hidden="true">
      <Icon name={rowIcon({ label })} size={22} />
    </span>
  );
}

// The status chip. The icon and the words carry the meaning, not the colour alone.
export function StatusChip({ chip }) {
  return (
    <span className={`ui-badge ui-badge--${chip.tone} files-chip`} title={chip.hint || undefined}>
      <Icon name={chip.icon} size={14} />
      <span>{chip.text}</span>
      {chip.hint ? <span className="ui-sr-only">{`. ${chip.hint}`}</span> : null}
    </span>
  );
}

// One row of a file list. A whole row is a link to the file page, except a file that is not on the server.
//   showOwner  public list: the name of the publisher comes before the version line
//   onForget   a file this browser remembers but the server does not have can be removed from the list
export default function FileRow({ row, showOwner = false, onForget, now }) {
  const chip = statusChip(row, row.status === 'active' ? seenFor(row) : null);
  const title = rowTitle(row);
  const base = showOwner ? publicSubtitle(row, now) : rowSubtitle(row, now);
  // The hover hint is not enough on a touch screen: say in the line itself where "Verified" comes from.
  const subtitle = chip.text === 'Verified' ? `${base}. You checked this version here before.` : base;
  const dead = row.status === 'missing';
  const trailing = (
    <>
      <StatusChip chip={chip} />
      {dead && onForget && row.local ? (
        <Button size="sm" variant="ghost" onClick={() => onForget(row.docId)} aria-label={`Remove from list: ${title}`}>
          Remove
        </Button>
      ) : null}
    </>
  );
  return (
    <ListItem
      to={dead ? undefined : documentRoute(row.docId, '')}
      leading={<FileIcon label={row.label} />}
      title={title}
      subtitle={subtitle}
      trailing={trailing}
      className="files-row"
    />
  );
}
