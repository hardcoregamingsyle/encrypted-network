import { Link } from 'react-router-dom';

// The list that holds ListItem rows. A plain list with no bullets.
export function ItemList({ children, className = '', label }) {
  return (
    <ul className={`ui-items ${className}`.trim()} aria-label={label}>
      {children}
    </ul>
  );
}

// One row of a list: leading picture, title, a quiet line under it, a small note on the right
// (a time), and an optional count badge. Use inside ItemList.
//   to        makes the whole row a link        onClick  makes it a button
//   leading   an Avatar or an icon              meta     the small note on the right
//   badge     a number (unread count), hidden when 0     badgeLabel  screen reader text for it
//   trailing  anything else at the far right (an icon, a chip)
export default function ListItem({ to, onClick, leading, title, subtitle, meta, badge, badgeLabel, trailing, selected = false, className = '', ...rest }) {
  const count = Number.isFinite(badge) ? badge : 0;
  const body = (
    <>
      {leading ? <span className="ui-item__lead">{leading}</span> : null}
      <span className="ui-item__body">
        <span className="ui-item__title">{title}</span>
        {subtitle ? <span className="ui-item__sub">{subtitle}</span> : null}
      </span>
      {meta || count > 0 ? (
        <span className="ui-item__side">
          {meta ? <span className="ui-item__meta">{meta}</span> : null}
          {count > 0 ? (
            <span className="ui-count">
              <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
              <span className="ui-sr-only">{badgeLabel || `${count} unread`}</span>
            </span>
          ) : null}
        </span>
      ) : null}
      {trailing ? <span className="ui-item__trail">{trailing}</span> : null}
    </>
  );
  const classes = `ui-item ${selected ? 'is-selected' : ''} ${className}`.trim();
  let main;
  if (to) {
    main = (
      <Link to={to} className={classes} aria-current={selected ? 'true' : undefined} {...rest}>
        {body}
      </Link>
    );
  } else if (onClick) {
    main = (
      <button type="button" className={classes} onClick={onClick} {...rest}>
        {body}
      </button>
    );
  } else {
    main = (
      <div className={classes} {...rest}>
        {body}
      </div>
    );
  }
  return <li className="ui-items__row">{main}</li>;
}

export { ListItem };
