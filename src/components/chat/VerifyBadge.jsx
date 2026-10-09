import Icon from '../Icon.jsx';

// What the badge says for each state. Only a verdict of 'verified' can be green.
const STATES = {
  verified: { tone: 'good', icon: 'check', label: 'Signature verified' },
  invalid: { tone: 'bad', icon: 'x', label: 'Failed verification' },
  unverified: { tone: 'warn', icon: 'warn', label: 'Not verified' },
  pending: { tone: 'info', icon: 'info', label: 'Sending' }
};

export function badgeState(status) {
  return STATES[status] || STATES.unverified;
}

// The per message badge. The reason is in the title (hover) and in text for screen readers.
export default function VerifyBadge({ status, detail }) {
  const s = badgeState(status);
  const reason = typeof detail === 'string' ? detail : '';
  return (
    <span className={`ui-badge ui-badge--${s.tone} chat-vbadge`} title={reason || undefined} data-status={status}>
      <Icon name={s.icon} size={14} />
      <span>{s.label}</span>
      {reason ? <span className="ui-sr-only">{`: ${reason}`}</span> : null}
    </span>
  );
}

export { VerifyBadge };
