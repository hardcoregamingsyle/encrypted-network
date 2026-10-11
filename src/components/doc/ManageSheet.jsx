import { useEffect, useRef, useState } from 'react';
import Button from '../Button.jsx';
import Icon from '../Icon.jsx';
import Sheet from '../Sheet.jsx';
import PublishVersion from './PublishVersion.jsx';
import RevokePanel from './RevokePanel.jsx';

const TITLES = { menu: 'Manage this file', update: 'Update file', withdraw: 'Withdraw file' };

function Choice({ icon, title, sub, onClick, tone }) {
  return (
    <li>
      <button type="button" className={`doc-choice ${tone === 'danger' ? 'doc-choice--danger' : ''}`.trim()} onClick={onClick}>
        <span className="doc-choice__icon" aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
        <span className="doc-choice__text">
          <span className="doc-choice__title">{title}</span>
          <span className="doc-choice__sub">{sub}</span>
        </span>
        <Icon name="chevron-right" size={18} />
      </button>
    </li>
  );
}

// The owner's sheet: update the file (a new version with the same password), withdraw it, or jump to Details.
//   head              { version, recordHash } of the version everything builds on
//   password          the file password when known
//   onUpdated(pw, info) after a new version was accepted (the page closes this sheet, shows a toast and refreshes)
//   onWithdrawn()     after the file was withdrawn
//   onDetails()       the person asked for the technical details
export default function ManageSheet({ open, onClose, docId, head, identity, password, previousLabel, onUpdated, onWithdrawn, onReload, onDetails }) {
  const [view, setView] = useState('menu');
  const bodyRef = useRef(null);
  const first = useRef(true);

  // A closed sheet starts at the menu the next time.
  useEffect(() => {
    if (!open) setView('menu');
  }, [open]);

  // The control that was pressed is replaced by the next view, so focus moves to the new content.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (open && bodyRef.current) bodyRef.current.focus({ preventScroll: true });
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const footer =
    view === 'menu' ? null : (
      <Button onClick={() => setView('menu')}>
        <Icon name="arrow-left" size={18} /> Back
      </Button>
    );

  return (
    <Sheet open={open} onClose={onClose} title={TITLES[view]} footer={footer}>
      <div className="doc-manage" ref={bodyRef} tabIndex={-1}>
      {view === 'menu' ? (
        <ul className="doc-choices">
          <Choice icon="upload" title="Update file" sub="Publish a new version. The same link keeps working." onClick={() => setView('update')} />
          <Choice icon="x" tone="danger" title="Withdraw file" sub="Stop sharing it. The history stays visible." onClick={() => setView('withdraw')} />
          <Choice icon="info" title="Details" sub="The technical checks." onClick={onDetails} />
        </ul>
      ) : view === 'update' ? (
        <PublishVersion docId={docId} head={head} identity={identity} password={password} previousLabel={previousLabel} onPublished={onUpdated} onReload={onReload} />
      ) : (
        <RevokePanel docId={docId} head={head} identity={identity} onRevoked={onWithdrawn} onReload={onReload} />
      )}
      </div>
    </Sheet>
  );
}
