import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import Icon from './Icon.jsx';
import { useIdentity } from '../lib/identity.jsx';
import { shortKeyId } from '../lib/format.js';

export const NAV_LINKS = [
  { to: '/', label: 'Vault', end: true },
  { to: '/verify', label: 'Verify' },
  { to: '/chat', label: 'Chat' },
  { to: '/keys', label: 'Identity' },
  { to: '/about', label: 'About' }
];

function IdentityChip() {
  const { status, identity } = useIdentity();
  if (status === 'ready' && identity) {
    return (
      <Link to="/keys" className="ui-nav__chip" title={`Your key id: ${identity.keyId}`}>
        <Icon name="key" size={16} />
        <span className="ui-nav__chip-name">{identity.displayName}</span>
        <span className="ui-nav__chip-id">{shortKeyId(identity.keyId)}</span>
      </Link>
    );
  }
  if (status === 'none') {
    return (
      <Link to="/keys" className="ui-nav__chip ui-nav__chip--cta">
        <Icon name="key" size={16} />
        <span className="ui-nav__chip-name">Create identity</span>
      </Link>
    );
  }
  return null;
}

// Sticky top bar. On small screens the links collapse behind a menu button.
export default function Nav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <nav className="ui-nav" aria-label="Main">
      <div className="ui-nav__bar">
        <Link to="/" className="ui-nav__brand">
          <Icon name="lock" size={22} />
          <span>hrdlock</span>
        </Link>
        <button
          type="button"
          className="ui-nav__toggle"
          aria-expanded={open ? 'true' : 'false'}
          aria-controls="main-menu"
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? 'x' : 'menu'} size={22} />
          <span className="ui-sr-only">{open ? 'Close menu' : 'Open menu'}</span>
        </button>
      </div>
      <div id="main-menu" className={`ui-nav__menu ${open ? 'is-open' : ''}`}>
        <ul className="ui-nav__list">
          {NAV_LINKS.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className="ui-nav__link">
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <IdentityChip />
      </div>
    </nav>
  );
}

export { Nav };
