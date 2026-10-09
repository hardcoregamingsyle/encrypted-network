import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import Nav from './Nav.jsx';

// Page frame: skip link, sticky nav, main area and footer.
// On every route change focus moves to the page heading so keyboard and screen reader users start at the top.
export default function Layout({ children }) {
  const location = useLocation();
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

  function skip(event) {
    event.preventDefault();
    if (mainRef.current) mainRef.current.focus();
  }

  return (
    <div className="ui-shell">
      <a className="ui-skip" href="#main" onClick={skip}>
        Skip to content
      </a>
      <header className="ui-header">
        <Nav />
      </header>
      <main id="main" className="ui-main" tabIndex={-1} ref={mainRef}>
        {children}
      </main>
      <footer className="ui-footer">
        <p>
          hrdlock is a prototype. It has not been audited or certified. <Link to="/about">What it does and does not prove</Link>
        </p>
      </footer>
    </div>
  );
}

export { Layout };
