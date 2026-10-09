import Icon from '../Icon.jsx';
import Spinner from '../Spinner.jsx';

const STATUS_TEXT = {
  pending: 'waiting',
  active: 'in progress',
  done: 'done',
  error: 'failed'
};

function Mark({ status }) {
  if (status === 'done') return <Icon name="check" size={16} />;
  if (status === 'error') return <Icon name="x" size={16} />;
  if (status === 'active') return <Spinner label={null} size="sm" />;
  return <span className="vault-steps__dot" aria-hidden="true" />;
}

// Step by step progress of a publish. detail is the live sentence from the current step.
export default function ProgressList({ steps, detail = '' }) {
  return (
    <div className="vault-progress">
      <ol className="vault-steps" aria-label="Publishing steps">
        {steps.map((s) => (
          <li key={s.id} className={`vault-steps__item is-${s.status}`} aria-current={s.status === 'active' ? 'step' : undefined}>
            <span className="vault-steps__mark">
              <Mark status={s.status} />
            </span>
            <span className="vault-steps__text">
              <span className="vault-steps__label">
                {s.label}
                <span className="ui-sr-only">{`: ${STATUS_TEXT[s.status] || s.status}`}</span>
              </span>
              {s.status === 'active' && s.hint ? <span className="vault-steps__hint">{s.hint}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <p className="vault-progress__detail" role="status" aria-live="polite">
        {detail}
      </p>
    </div>
  );
}
