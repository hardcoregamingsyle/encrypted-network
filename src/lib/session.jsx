// Session context. useSession() tells every page who is signed in and which signing key this device holds.
// The logic lives in sessionStore.js, this file connects it to React.
//
//   const { status, mode, account, identity, mailAvailable, requestCode, verifyCode, registerName,
//           startGuest, signOut, refresh, setStrict, deleteAccount } = useSession();
//   Also: requireFresh(action) runs an action that needs a session made in the last 15 minutes and, when the server
//   asks, opens the "Confirm it is you" sheet and repeats the action once; listSessions, endOtherSessions,
//   endSession and signOutEverywhere for the devices the account is signed in on; notice (a short message after the
//   session ended on the server) and dismissNotice.
//
// status: 'loading' | 'signedOut' | 'needsKey' | 'ready'      mode: 'account' | 'guest' | null
// identity (status ready): { keyId, displayName, publicKey, sign(record) -> Promise<signature>, ... }
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import ReauthSheet from '../components/ReauthSheet.jsx';
import { createSessionStore } from './sessionStore.js';

const unavailable = () => Promise.reject(new Error('the session is not available here'));

const DEFAULT_VALUE = Object.freeze({
  status: 'loading',
  mode: null,
  account: null,
  keys: [],
  identity: null,
  canSign: false,
  mailAvailable: true,
  accountsAvailable: true,
  registration: 'unknown',
  registrationError: '',
  keyProblem: false,
  notice: '',
  error: '',
  requestCode: unavailable,
  verifyCode: unavailable,
  registerName: unavailable,
  startGuest: unavailable,
  signOut: unavailable,
  refresh: unavailable,
  setStrict: unavailable,
  deleteAccount: unavailable,
  strictUnfinished: () => false,
  requireFresh: (action) => action(),
  unlockKey: unavailable,
  listSessions: unavailable,
  endOtherSessions: unavailable,
  endSession: unavailable,
  signOutEverywhere: unavailable,
  dismissNotice: () => {},
  identityFor: () => null,
  createLegacy: unavailable,
  restoreBackup: unavailable,
  exportBackup: unavailable,
  registerAgain: unavailable,
  forgetDevice: unavailable
});

const SessionContext = createContext(DEFAULT_VALUE);

export function useSession() {
  return useContext(SessionContext);
}

// Opens the "Confirm it is you" sheet when the store asks for it, and tells the store how it ended.
function ReauthHost({ store }) {
  const [pending, setPending] = useState(null);
  const open = useRef(null);
  open.current = pending;

  useEffect(() => {
    if (typeof store.setReauthHandler !== 'function') return undefined;
    store.setReauthHandler(
      (request) =>
        new Promise((resolve) => {
          setPending({ request, resolve });
        })
    );
    return () => {
      store.setReauthHandler(null);
      if (open.current) open.current.resolve(false);
    };
  }, [store]);

  if (!pending) return null;
  return (
    <ReauthSheet
      request={pending.request}
      onFinish={(ok) => {
        setPending(null);
        pending.resolve(Boolean(ok));
      }}
    />
  );
}

// Shortest time between two refreshes caused by coming back to the tab.
const REFRESH_GAP_MS = 15000;

// A test can pass its own store. Normally the provider makes one.
export function SessionProvider({ children, store: given }) {
  const [store] = useState(() => given || createSessionStore());
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const lastRefresh = useRef(Date.now());
  const channel = useRef(null);

  useEffect(() => {
    store.init().catch(() => {});
  }, [store]);

  // Look again when the tab becomes visible, so a sign in or sign out in another tab shows up here.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastRefresh.current < REFRESH_GAP_MS) return;
      lastRefresh.current = now;
      store.refresh().catch(() => {});
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [store]);

  // Another tab of this browser hears that the person signed in or out and looks again at once, so it is not
  // left showing a person who is gone. The message carries nothing: the other tab asks the server itself.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    let ch = null;
    try {
      ch = new BroadcastChannel('hrd-session');
    } catch {
      return undefined;
    }
    channel.current = ch;
    ch.onmessage = () => {
      lastRefresh.current = Date.now();
      store.refresh().catch(() => {});
    };
    return () => {
      ch.close();
      channel.current = null;
    };
  }, [store]);

  // These keep one identity for the life of the store. Each runs the action and, when it worked, tells the other tabs.
  const announced = useMemo(() => {
    const announce =
      (fn) =>
      async (...args) => {
        const out = await fn(...args);
        try {
          if (channel.current) channel.current.postMessage('changed');
        } catch {
          // a closed channel is not a problem
        }
        return out;
      };
    return {
      verifyCode: announce(store.verifyCode),
      registerName: announce(store.registerName),
      startGuest: announce(store.startGuest),
      signOut: announce(store.signOut),
      deleteAccount: announce(store.deleteAccount),
      forgetDevice: announce(store.forgetDevice),
      signOutEverywhere: announce(() => store.signOut({ all: true }))
    };
  }, [store]);

  const value = useMemo(() => {
    return {
      ...state,
      canSign: Boolean(state.identity),
      requestCode: store.requestCode,
      verifyCode: announced.verifyCode,
      registerName: announced.registerName,
      startGuest: announced.startGuest,
      signOut: announced.signOut,
      refresh: store.refresh,
      setStrict: store.setStrict,
      deleteAccount: announced.deleteAccount,
      strictUnfinished: store.strictUnfinished || DEFAULT_VALUE.strictUnfinished,
      requireFresh: store.requireFresh || DEFAULT_VALUE.requireFresh,
      unlockKey: store.unlockKey || unavailable,
      listSessions: store.listSessions || unavailable,
      endOtherSessions: store.endOtherSessions || unavailable,
      endSession: store.endSession || unavailable,
      signOutEverywhere: announced.signOutEverywhere,
      dismissNotice: store.dismissNotice || DEFAULT_VALUE.dismissNotice,
      identityFor: store.identityFor,
      createLegacy: store.createLegacy,
      restoreBackup: store.restoreBackup,
      exportBackup: store.exportBackup,
      registerAgain: store.registerAgain,
      forgetDevice: announced.forgetDevice
    };
  }, [state, store, announced]);

  return (
    <SessionContext.Provider value={value}>
      {children}
      <ReauthHost store={store} />
    </SessionContext.Provider>
  );
}

export { SessionContext, DEFAULT_VALUE as DEFAULT_SESSION };
