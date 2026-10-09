import { shortHash } from '../lib/format.js';

// A hash in monospace. short shows only the first characters, the full value is in the title.
export default function HashText({ value, short = false, length = 8 }) {
  if (typeof value !== 'string' || value === '') return <span className="ui-hash ui-hash--empty">none</span>;
  return (
    <span className={`ui-hash ${short ? 'ui-hash--short' : 'ui-hash--full'}`} title={short ? value : undefined}>
      {short ? shortHash(value, length) : value}
    </span>
  );
}

export { HashText };
