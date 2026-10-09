import Icon from '../Icon.jsx';
import Spinner from '../Spinner.jsx';

// Progress text for a job that takes a while. busy marks the last step as running.
export default function ProgressList({ steps, busy, label = 'Progress' }) {
  const list = Array.isArray(steps) ? steps : [];
  return (
    <div className="doc-progress" role="status" aria-live="polite" aria-label={label}>
      {list.length > 0 ? (
        <ol className="doc-progress__list">
          {list.map((step, i) => {
            const running = busy && i === list.length - 1;
            return (
              <li key={step.id} className={running ? 'is-running' : 'is-done'}>
                <span className="doc-progress__mark">
                  {running ? <Spinner label={null} size="sm" /> : <Icon name="check" size={16} />}
                </span>
                <span>{step.text}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
