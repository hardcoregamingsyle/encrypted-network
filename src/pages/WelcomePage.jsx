import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import Button from '../components/Button.jsx';
import Icon from '../components/Icon.jsx';
import { usePageTitle } from '../components/PageHeader.jsx';
import QuickStartForm from '../components/QuickStartForm.jsx';
import Sheet from '../components/Sheet.jsx';
import Spinner from '../components/Spinner.jsx';
import { useSession } from '../lib/session.jsx';

// The first screen for somebody who is not signed in.
export default function WelcomePage() {
  const { status, mailAvailable } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  // Set by the screen that sent the person here (for example after the account was deleted).
  const notice = location.state && typeof location.state.notice === 'string' ? location.state.notice : '';
  const [quickOpen, setQuickOpen] = useState(false);
  usePageTitle('Welcome');

  if (status === 'ready') return <Navigate to="/chats" replace />;
  if (status === 'needsKey') return <Navigate to="/signin" replace />;
  if (status === 'loading') {
    return (
      <div className="ui-splash">
        <h1 className="ui-sr-only">hrdlock</h1>
        <Spinner label="Opening hrdlock" size="lg" />
      </div>
    );
  }

  const quick = (
    <div className="welcome-option">
      <Button variant={mailAvailable ? 'secondary' : 'primary'} onClick={() => setQuickOpen(true)}>
        <Icon name="bolt" size={18} /> Quick start on this device
      </Button>
      <p className="ui-muted welcome-option__note">No email needed. Your key and file passwords stay in this browser. Your signed records and labels are public. If you clear your browser data you lose access.</p>
    </div>
  );

  return (
    <div className="welcome">
      <div className="welcome__card">
        <div className="welcome__logo" aria-hidden="true">
          <Icon name="lock" size={36} />
        </div>
        <h1 className="welcome__title">hrdlock</h1>
        <p className="welcome__lead">Share files and chat in public. Everything is signed by its writer, so anyone can check who wrote it and that it has not changed.</p>

        {notice ? (
          <p className="ui-muted welcome__note" role="status">
            {notice}
          </p>
        ) : null}

        <div className="welcome__actions">
          {mailAvailable ? (
            <>
              <Button variant="primary" onClick={() => navigate('/signin')}>
                <Icon name="mail" size={18} /> Continue with email
              </Button>
              {quick}
            </>
          ) : (
            <>
              {quick}
              <p className="ui-muted welcome__note" role="note">
                Email sign in is not switched on yet.
              </p>
            </>
          )}
        </div>

        <ul className="welcome__links">
          <li>
            <Link to="/about">How it works</Link>
          </li>
          <li>
            <Link to="/verify">Check a document</Link>
          </li>
          <li>
            <Link to="/me/advanced">Restore an old backup file</Link>
          </li>
        </ul>
        <p className="ui-muted welcome__foot">A prototype. It has not been audited or certified.</p>
      </div>

      <Sheet open={quickOpen} onClose={() => setQuickOpen(false)} title="Quick start">
        <QuickStartForm onDone={() => navigate('/chats')} />
      </Sheet>
    </div>
  );
}
