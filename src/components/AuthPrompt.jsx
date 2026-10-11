import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Button from './Button.jsx';
import QuickStartForm from './QuickStartForm.jsx';
import Sheet from './Sheet.jsx';
import { NEEDS_KEY_COPY, needsKeyKind } from '../lib/authText.js';
import { useSession } from '../lib/session.jsx';

const AuthPromptContext = createContext({ open: () => {}, close: () => {} });

// const prompt = useSignInPrompt();  prompt.open('to write in this chat')
// Opens a sheet that offers email sign in and Quick start. The sheet closes by itself once the person
// has a key. Components that need an identity call this instead of sending people to another page.
export function useSignInPrompt() {
  return useContext(AuthPromptContext);
}

export function AuthPromptProvider({ children }) {
  const [reason, setReason] = useState(null);
  const [quick, setQuick] = useState(false);
  const session = useSession();
  const { status, mailAvailable } = session;
  const navigate = useNavigate();
  const location = useLocation();

  const close = useCallback(() => {
    setReason(null);
    setQuick(false);
  }, []);
  const open = useCallback((why) => {
    setReason(typeof why === 'string' ? why : '');
    setQuick(false);
  }, []);

  useEffect(() => {
    if (status === 'ready') close();
  }, [status, close]);

  const value = useMemo(() => ({ open, close }), [open, close]);
  const isOpen = reason !== null && status !== 'ready';

  function goSignIn() {
    const next = location.pathname + location.search + location.hash;
    close();
    navigate('/signin?next=' + encodeURIComponent(next));
  }

  return (
    <AuthPromptContext.Provider value={value}>
      {children}
      <Sheet
        open={isOpen}
        onClose={close}
        title={status === 'needsKey' ? 'One more step' : 'Sign in to continue'}
        description={reason ? `You need to be signed in ${reason}.` : 'You need to be signed in to do this.'}
      >
        {status === 'needsKey' ? (
          <Button variant="primary" onClick={goSignIn}>
            {NEEDS_KEY_COPY[needsKeyKind(session)].action}
          </Button>
        ) : quick ? (
          <QuickStartForm submitLabel="Start" onDone={close} />
        ) : (
          <div className="ui-stack">
            {mailAvailable ? (
              <Button variant="primary" onClick={goSignIn}>
                Continue with email
              </Button>
            ) : null}
            <Button variant={mailAvailable ? 'secondary' : 'primary'} onClick={() => setQuick(true)}>
              Quick start on this device
            </Button>
            <p className="ui-muted">Anyone can read and check things without signing in.</p>
          </div>
        )}
      </Sheet>
    </AuthPromptContext.Provider>
  );
}

export { AuthPromptContext };
