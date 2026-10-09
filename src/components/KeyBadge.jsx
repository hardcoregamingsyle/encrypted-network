import { shortKeyId } from '../lib/format.js';

// A signer: the name they chose and the start of their key id.
export default function KeyBadge({ keyId, name }) {
  const tag = shortKeyId(keyId);
  return (
    <span className="ui-keybadge" title={keyId ? `Key id ${keyId}` : undefined}>
      {name ? <span className="ui-keybadge__name">{name}</span> : null}
      {tag ? <span className="ui-keybadge__id">{tag}</span> : null}
      {!name && !tag ? <span className="ui-keybadge__name">unknown signer</span> : null}
    </span>
  );
}

export { KeyBadge };
