import { useState } from 'react';
import { shortKeyId } from '../lib/format.js';

// A signer: the name they chose and the start of their key id (16 of 64 hex characters).
// The tag is a button: one press shows the whole key id, which is the real identifier.
// Names are not unique, so the name alone never identifies anyone.
// plain: show the whole key id as text and no button (used where it sits inside a closed Details).
export default function KeyBadge({ keyId, name, plain = false }) {
  const [open, setOpen] = useState(false);
  const tag = shortKeyId(keyId);
  const full = typeof keyId === 'string' ? keyId : '';
  const title = [name ? String(name) : '', full ? `Key id ${full}` : ''].filter(Boolean).join(', ') || undefined;
  return (
    <span className="ui-keybadge" title={title}>
      {name ? <span className="ui-keybadge__name">{name}</span> : null}
      {tag && plain ? <span className="ui-keybadge__id">{full}</span> : null}
      {tag && !plain ? (
        <button
          type="button"
          className="ui-keybadge__id"
          aria-expanded={open ? 'true' : 'false'}
          aria-label={`Key id starting ${tag}. ${open ? 'Hide' : 'Show'} the full key id`}
          onClick={() => setOpen((v) => !v)}
        >
          {tag}
        </button>
      ) : null}
      {!name && !tag ? <span className="ui-keybadge__name">unknown signer</span> : null}
      {open && full ? <span className="ui-keybadge__full">{full}</span> : null}
    </span>
  );
}

export { KeyBadge };
