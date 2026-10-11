import { Link, useLocation } from 'react-router-dom';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';
import { NAV_ITEMS, activeTab } from './navConfig.js';
import { NEEDS_KEY_COPY, needsKeyKind } from '../lib/authText.js';
import { useSession } from '../lib/session.jsx';

function Who() {
  const session = useSession();
  const { status, identity, account, mode } = session;
  if (status === 'ready' && identity) {
    const sub = mode === 'account' && account ? account.emailMasked : 'Quick start, this device';
    return (
      <Link to="/me" className="ui-sidenav__who">
        <Avatar name={identity.displayName} keyId={identity.keyId} size={40} />
        <span className="ui-sidenav__who-text">
          <span className="ui-sidenav__who-name">{identity.displayName}</span>
          <span className="ui-sidenav__who-sub">{sub}</span>
        </span>
      </Link>
    );
  }
  if (status === 'needsKey') {
    return (
      <Link to="/signin" className="ui-sidenav__who ui-sidenav__who--cta">
        <Icon name="user" size={20} />
        <span className="ui-sidenav__who-name">{NEEDS_KEY_COPY[needsKeyKind(session)].action}</span>
      </Link>
    );
  }
  if (status === 'signedOut') {
    return (
      <Link to="/welcome" className="ui-sidenav__who ui-sidenav__who--cta">
        <Icon name="user" size={20} />
        <span className="ui-sidenav__who-name">Sign in</span>
      </Link>
    );
  }
  return null;
}

// The left column on screens 900px wide and up. Below that the bottom tabs are used instead.
export default function SideNav() {
  const location = useLocation();
  const active = activeTab(location.pathname);
  return (
    <nav className="ui-sidenav" aria-label="Main menu">
      <Link to="/" className="ui-sidenav__brand">
        <Icon name="lock" size={24} />
        <span>hrdlock</span>
      </Link>
      <ul className="ui-sidenav__list">
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <Link to={item.to} className="ui-sidenav__link" aria-current={active === item.id ? 'page' : undefined}>
              <Icon name={item.icon} size={22} />
              <span>{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="ui-sidenav__foot">
        <Who />
      </div>
    </nav>
  );
}

export { SideNav };
