// Compatibility layer. Older components ask useIdentity() whether the person has a signing identity.
// It now reads the session (src/lib/session.jsx), so an account key and a Quick start key both work.
//
// status: 'loading' | 'none' | 'ready'
// registration (only meaningful when ready): 'unknown' | 'checking' | 'registered' | 'missing' | 'error'
import { useMemo } from 'react';
import { SessionProvider, useSession } from './session.jsx';

export function useIdentity() {
  const session = useSession();
  return useMemo(() => {
    const status = session.status === 'loading' ? 'loading' : session.status === 'ready' && session.identity ? 'ready' : 'none';
    return {
      status,
      identity: status === 'ready' ? session.identity : null,
      registration: session.registration,
      registrationError: session.registrationError,
      error: session.error,
      // a key with a passphrase and a backup file, only for the Advanced page
      create: session.createLegacy,
      restore: session.restoreBackup,
      forget: session.forgetDevice,
      register: session.registerAgain,
      exportBackup: session.exportBackup
    };
  }, [session]);
}

// The provider now is the session provider.
export const IdentityProvider = SessionProvider;
