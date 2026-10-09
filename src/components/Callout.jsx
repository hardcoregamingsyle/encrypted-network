import Icon from './Icon.jsx';

const ICONS = { info: 'info', good: 'check', warn: 'warn', bad: 'x' };
const ROLES = { info: 'status', good: 'status', warn: 'note', bad: 'alert' };

// tone: info, good, warn or bad. The icon and title mean the tone is not shown by colour alone.
export default function Callout({ tone = 'info', title, children, className = '' }) {
  const t = ICONS[tone] ? tone : 'info';
  return (
    <div className={`ui-callout ui-callout--${t} ${className}`.trim()} role={ROLES[t]}>
      <span className="ui-callout__icon">
        <Icon name={ICONS[t]} />
      </span>
      <div className="ui-callout__body">
        {title ? <p className="ui-callout__title">{title}</p> : null}
        {children ? <div className="ui-callout__text">{children}</div> : null}
      </div>
    </div>
  );
}

export { Callout };
