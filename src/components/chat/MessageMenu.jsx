import { useState } from 'react';
import Button from '../Button.jsx';
import { copyText } from '../CopyButton.jsx';
import Icon from '../Icon.jsx';
import KeyBadge from '../KeyBadge.jsx';
import Sheet from '../Sheet.jsx';
import { formatTime } from '../../lib/format.js';
import { quoteLine } from './roomLogic.js';

// The menu for one message: Reply, Copy text, and who wrote it. This is how touch screens reach Reply
// (on a wide screen a Reply button also shows next to the bubble on hover and focus).
//   entry      the message, or null when the menu is closed
//   name       the sender's name from the signed identity record
//   canReply   false for signed out people
//   onReply    called with the entry
export default function MessageMenu({ entry, name, canReply, onReply, onClose, onNeedSignIn }) {
  const [copied, setCopied] = useState('');
  const rec = entry && entry.record ? entry.record : {};
  const text = typeof rec.body === 'string' ? rec.body : '';

  async function copy() {
    const ok = await copyText(text);
    setCopied(ok ? 'Copied' : 'Could not copy');
  }

  return (
    <Sheet open={Boolean(entry)} onClose={onClose} title="Message">
      {entry ? (
        <div className="ui-stack">
          <p className="chat-menu__quote">{quoteLine(text, 300)}</p>
          <div className="chat-menu__actions">
            {canReply ? (
              <Button variant="primary" data-autofocus onClick={() => onReply(entry)}>
                <Icon name="reply" size={18} /> Reply
              </Button>
            ) : (
              <Button variant="primary" data-autofocus onClick={onNeedSignIn}>
                Sign in to reply
              </Button>
            )}
            <Button onClick={copy}>
              <Icon name="copy" size={18} /> Copy text
            </Button>
          </div>
          <p className="ui-muted" role="status">
            {copied}
          </p>
          <details className="chat-menu__who">
            <summary>Who wrote this</summary>
            <p>
              <KeyBadge keyId={rec.signer} name={name} plain />
            </p>
            <p className="ui-muted">
              Two people can choose the same name. The key id is what tells them apart. The time was written by the sender: {formatTime(rec.createdAt)}.
            </p>
          </details>
        </div>
      ) : null}
    </Sheet>
  );
}
