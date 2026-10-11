import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';

// The floating action button, bottom right. It floats above the bottom tabs on a phone.
//   label    the words on it ("New chat"), always visible so nobody has to guess what + does
//   icon     an Icon name, plus by default
//   onClick  or  to  (a link)
//   compact  icon only, the label is then read by screen readers only
export default function Fab({ label, icon = 'plus', onClick, to, compact = false, className = '', ...rest }) {
  const classes = `ui-fab ${compact ? 'ui-fab--compact' : ''} ${className}`.trim();
  const inner = (
    <>
      <Icon name={icon} size={22} />
      <span className={compact ? 'ui-sr-only' : 'ui-fab__label'}>{label}</span>
    </>
  );
  if (to) {
    return (
      <Link to={to} className={classes} {...rest}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" className={classes} onClick={onClick} {...rest}>
      {inner}
    </button>
  );
}

export { Fab };
