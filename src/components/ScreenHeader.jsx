import { Link, useNavigate } from 'react-router-dom';
import Icon from './Icon.jsx';
import { usePageTitle } from './PageHeader.jsx';

function canGoBack() {
  try {
    const idx = window.history.state && window.history.state.idx;
    return Number.isInteger(idx) && idx > 0;
  } catch {
    return false;
  }
}

// The top bar of a screen. It holds the one h1 of the page.
//   title, subtitle   the heading and a quiet line under it
//   back              a path ("/chats") for a link back, or true for the previous screen
//   backTo            where back === true goes when there is no previous screen (default "/")
//   backLabel         screen reader name of the back button
//   leading           something between the back button and the title (an Avatar)
//   actions           buttons on the right
//   documentTitle     browser tab title if it differs from the title
export default function ScreenHeader({ title, subtitle, back, backTo = '/', backLabel = 'Back', leading, actions, documentTitle, className = '' }) {
  usePageTitle(documentTitle || (typeof title === 'string' ? title : ''));
  const navigate = useNavigate();
  let backControl = null;
  if (typeof back === 'string') {
    backControl = (
      <Link to={back} className="ui-screen-header__back">
        <Icon name="arrow-left" size={22} />
        <span className="ui-sr-only">{backLabel}</span>
      </Link>
    );
  } else if (back) {
    backControl = (
      <button type="button" className="ui-screen-header__back" onClick={() => (canGoBack() ? navigate(-1) : navigate(backTo))}>
        <Icon name="arrow-left" size={22} />
        <span className="ui-sr-only">{backLabel}</span>
      </button>
    );
  }
  return (
    <header className={`ui-screen-header ${className}`.trim()}>
      {backControl}
      {leading ? <div className="ui-screen-header__lead">{leading}</div> : null}
      <div className="ui-screen-header__text">
        <h1 className="ui-screen-header__title">{title}</h1>
        {subtitle ? <p className="ui-screen-header__sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="ui-screen-header__actions">{actions}</div> : null}
    </header>
  );
}

export { ScreenHeader };
