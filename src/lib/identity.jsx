// Identity context. useIdentity() tells every page whether the person has a signing identity.
//
// status: 'loading' | 'none' | 'ready'
// registration (only meaningful when ready): 'unknown' | 'checking' | 'registered' | 'missing' | 'error'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, getIdentity, registerIdentity } from './api.js';
import * as keystore from './keystore.js';

const notReady = () => Promise.reject(new Error('the identity service is not available here'));

const DEFAULT_VALUE = Object.freeze({
  status: 'loading',
  identity: null,
  registration: 'unknown',
  registrationError: '',
  error: '',
  create: notReady,
  restore: notReady,
  forget: notReady,
  register: notReady,
  exportBackup: notReady
});

const IdentityContext = createContext(DEFAULT_VALUE);

export function useIdentity() {
  return useContext(IdentityContext);
}

function messageOf(err) {
  return err && err.message ? err.message : 'something went wrong';
}

export function IdentityProvider({ children }) {
  const [status, setStatus] = useState('loading');
  const [identity, setIdentity] = useState(null);
  const [error, setError] = useState('');
  const [registration, setRegistration] = useState('unknown');
  const [registrationError, setRegistrationError] = useState('');
  const current = useRef(null);

  const adopt = useCallback((next) => {
    current.current = next ? next.keyId : null;
    setIdentity(next);
    setStatus(next ? 'ready' : 'none');
    setRegistration('unknown');
    setRegistrationError('');
  }, []);

  // Tells the server about the identity. Safe to call again, "existed" is fine.
  const register = useCallback(async (target) => {
    const who = target || identity;
    if (!who) throw new Error('there is no identity to register');
    setRegistration('checking');
    setRegistrationError('');
    try {
      await registerIdentity(who.record, who.signature);
      if (current.current === who.keyId) setRegistration('registered');
    } catch (err) {
      if (current.current === who.keyId) {
        setRegistration('error');
        setRegistrationError(messageOf(err));
      }
      throw err;
    }
  }, [identity]);

  // Checks whether the server knows this key, and registers it if it does not.
  const checkRegistration = useCallback(async (target) => {
    setRegistration('checking');
    try {
      await getIdentity(target.keyId);
      if (current.current === target.keyId) setRegistration('registered');
      return;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) {
        if (current.current === target.keyId) {
          setRegistration('error');
          setRegistrationError(messageOf(err));
        }
        return;
      }
    }
    if (current.current === target.keyId) setRegistration('missing');
    try {
      await register(target);
    } catch {
      // register() already recorded the error
    }
  }, [register]);

  useEffect(() => {
    let alive = true;
    keystore
      .loadIdentity()
      .then((found) => {
        if (!alive) return;
        adopt(found);
        if (found) checkRegistration(found);
      })
      .catch((err) => {
        if (!alive) return;
        setError(messageOf(err));
        adopt(null);
      });
    return () => {
      alive = false;
    };
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = useCallback(
    async ({ displayName, passphrase }) => {
      const made = await keystore.createIdentity({ displayName, passphrase });
      setError('');
      adopt(made.identity);
      try {
        await register(made.identity);
      } catch {
        // the identity exists locally, registration can be retried from the keys page
      }
      return { backupText: made.backupText, backupName: made.backupName };
    },
    [adopt, register]
  );

  const restore = useCallback(
    async (text, passphrase) => {
      const restored = await keystore.restoreIdentity(text, passphrase);
      setError('');
      adopt(restored);
      await checkRegistration(restored);
      return restored;
    },
    [adopt, checkRegistration]
  );

  const forget = useCallback(async () => {
    await keystore.forgetIdentity();
    adopt(null);
  }, [adopt]);

  const exportBackup = useCallback((passphrase) => keystore.exportBackup(passphrase), []);

  const value = useMemo(
    () => ({
      status,
      identity,
      registration,
      registrationError,
      error,
      create,
      restore,
      forget,
      register: () => register(),
      exportBackup
    }),
    [status, identity, registration, registrationError, error, create, restore, forget, register, exportBackup]
  );

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}
