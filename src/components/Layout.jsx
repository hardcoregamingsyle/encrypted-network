import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import BottomTabs from './BottomTabs.jsx';
import SideNav from './SideNav.jsx';
import { chromeFor } from './navConfig.js';
import { NEEDS_KEY_COPY, needsKeyKind } from '../lib/authText.js';
import { useSession } from '../lib/session.jsx';

// Shown while an account is signed in but this device has no key yet (never on the sign in page itself).
// A new account is asked for a name; an account that has one is asked to confirm it is them, or to try again.
function NeedsNameBanner() {
  const session = useSession();
  const location = useLocation();
  if (session.status !== 'needsKey' || location.pathname === '/signin') return null;
  const copy = NEEDS_KEY_COPY[needsKeyKind(session)];
  return (
    <div className="ui-banner" role="status">
      <span>{copy.banner}</span>
      <Link to="/signin" className="ui-banner__link">
        {copy.action}
      </Link>
    </div>
  );
}

// Shown after the server ended the session while the app was in use (signed out elsewhere, or it ran out).
function SessionNotice() {
  const { notice, dismissNotice } = useSession();
  const location = useLocation();
  if (!notice) return null;
  return (
    <div className="ui-banner" role="status">
      <span>{notice}</span>
      <span className="ui-banner__actions">
        {location.pathname !== '/signin' ? (
          <Link to="/signin" className="ui-banner__link">
            Sign in
          </Link>
        ) : null}
        <button type="button" className="ui-banner__link ui-banner__dismiss" onClick={dismissNotice}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

// The app frame: skip link, side navigation (wide screens), the page, and the bottom tabs (phones).
// Welcome and sign in have no navigation; one open chat has no tabs on a phone.
// On every route change focus moves to the page heading so keyboard and screen reader users start at the top.
export default function Layout({ children }) {
  const location = useLocation();
  const chrome = chromeFor(location.pathname);
  const mainRef = useRef(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const main = mainRef.current;
    if (!main) return;
    const heading = main.querySelector('h1');
    const target = heading || main;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // After a form is submitted with bad input, the page shows the errors (Field sets aria-invalid on
  // the control). Move focus to the first control with an error, so a keyboard or screen reader user
  // lands on the problem. React has already drawn the errors by the time the timer runs.
  useEffect(() => {
    function onSubmit(event) {
      const form = event.target;
      if (!form || typeof form.querySelector !== 'function') return;
      setTimeout(() => {
        const bad = form.querySelector('[aria-invalid="true"]');
        if (bad && typeof bad.focus === 'function') bad.focus();
      }, 0);
    }
    document.addEventListener('submit', onSubmit, true);
    return () => document.removeEventListener('submit', onSubmit, true);
  }, []);

  function skip(event) {
    event.preventDefault();
    if (mainRef.current) mainRef.current.focus();
  }

  return (
    <div className={`ui-shell ui-shell--${chrome}`}>
      <a className="ui-skip" href="#main" onClick={skip}>
        Skip to content
      </a>
      {chrome === 'bare' ? null : <SideNav />}
      <div className="ui-shell__body">
        <SessionNotice />
        {chrome === 'bare' ? null : <NeedsNameBanner />}
        <main id="main" className="ui-main" tabIndex={-1} ref={mainRef}>
          {children}
        </main>
        {chrome === 'full' ? (
          <footer className="ui-footer">
            <p>
              hrdlock is a prototype. It has not been audited or certified. <Link to="/about">What it does and does not prove</Link>
            </p>
          </footer>
        ) : null}
      </div>
      {chrome === 'full' ? <BottomTabs /> : null}
    </div>
  );
}

export { Layout };
