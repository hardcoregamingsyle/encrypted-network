import Icon from '../Icon.jsx';
import { describeAnchor } from '../../lib/chatClient.js';
import { formatTime } from '../../lib/format.js';

const ICON = { good: 'check', warn: 'warn', bad: 'x', info: 'info' };

// The line under the messages: are the newest messages tied to the signed server head?
export default function AnchorStatus({ anchor, checking = false }) {
  const d = describeAnchor(anchor, { checking });
  return (
    <div className={`chat-anchor chat-anchor--${d.tone}`} role="status">
      <span className="chat-anchor__icon">
        <Icon name={ICON[d.tone] || 'info'} size={16} />
      </span>
      <div className="chat-anchor__text">
        <p className="chat-anchor__title">{d.title}</p>
        {d.lines.map((line) => (
          <p key={line} className="chat-anchor__line">
            {line}
          </p>
        ))}
        {anchor && anchor.signedAt ? <p className="chat-anchor__line">{`Checkpoint signed ${formatTime(anchor.signedAt)}.`}</p> : null}
      </div>
    </div>
  );
}
