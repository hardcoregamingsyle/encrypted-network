import { avatarColorNumber, initialsOf } from '../lib/format.js';

const SIZES = [24, 32, 40, 48, 56, 72, 96];

// Sizes come from a fixed set of css classes (no inline style attributes).
export function avatarSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n)) return 40;
  let best = SIZES[0];
  for (const s of SIZES) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
}

// A round badge with the initials of a name. The colour comes from a hash of the key id (or the name),
// so the same person looks the same everywhere. It is decorative: the name is written next to it.
export default function Avatar({ name, keyId, size = 40, className = '' }) {
  const color = avatarColorNumber(keyId || name);
  const px = avatarSize(size);
  return (
    <span className={`ui-avatar ui-avatar--c${color} ui-avatar--s${px} ${className}`.trim()} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

export { Avatar };
