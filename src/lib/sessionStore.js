// The session logic, without React: who is signed in, and which signing key this device holds.
// session.jsx wraps it in a provider. Tests give it a stubbed api and a memory key store.
//
// status   'loading'    first look at the server and the key store is not done
//          'signedOut'  nobody (no account session, no key on this device)
//          'needsKey'   signed in with an account, but this device has no key yet
//          'ready'      signed in (account) or Quick start (guest) with a usable key
// mode     'account' | 'guest' | null
import * as realApi from './api.js';
import { ApiError } from './api.js';
import { looksLikeEmail, maskEmail } from './authText.js';
import * as realDevice from './deviceKey.js';
import * as keystore from './keystore.js';
import { clearLocalDocs } from './localDocs.js';
import { clearSeen } from './unread.js';
import * as realVault from './vault.js';

export const QUICK_KEY_KEPT_MESSAGE =
  'This device has a Quick start key, which has no backup. To use a different identity, forget this one first.';

// Shown when the key cannot be written to this browser (blocked or private browsing).
export const KEY_STORAGE_MESSAGE =
  'This browser cannot store your key. Turn off private browsing or allow site data for this site, then try again.';

// Shown when the browser can not keep the file passwords that Strict mode hands back.
export const STRICT_STORAGE_MESSAGE =
  'This browser cannot keep your file passwords, so Strict mode would lose them. Allow site data for this site or use another browser, then try again.';

// Shown when the key is kept by the account but only handed out after a new code.
export const KEY_REAUTH_MESSAGE = 'To get your key onto this device, confirm it is you with a new code first.';

// Shown when the person closes the "Confirm it is you" sheet.
export const CANCELLED_MESSAGE = 'Cancelled. Nothing was changed.';

// Shown when a new code was accepted but the server still asks for one.
export const REAUTH_FAILED_MESSAGE = 'We could not confirm it is you. Nothing was changed. Try again in a moment.';

// Shown when the address typed for a new code is not the one of this account.
export const WRONG_ACCOUNT_MESSAGE = 'That is not the email address of this account. Use the address you signed in with.';

// Shown when the session ended on the server (signed out elsewhere, or it ran out).
export const SESSION_ENDED_NOTICE = 'Your sign in ended. Sign in again to continue.';

// The most pages one switch to Strict mode will walk (100 passwords each). A server that never ends does not trap the tab.
const MAX_STRICT_PAGES = 500;

// The address typed at sign in is kept for this tab only, so the "Confirm it is you" sheet can send the code
// without asking again. It is never put in a link.
const EMAIL_KEY = 'hrdlock.signin.email';

function tabStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function rememberedEmail() {
  try {
    const store = tabStorage();
    const value = store ? store.getItem(EMAIL_KEY) : '';
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function rememberEmail(email) {
  try {
    const store = tabStorage();
    if (store) store.setItem(EMAIL_KEY, email);
  } catch {
    // not remembered: the sheet asks for the address
  }
}

function forgetEmail() {
  try {
    const store = tabStorage();
    if (store) store.removeItem(EMAIL_KEY);
  } catch {
    // nothing to forget
  }
}

const isReauth = (err) => Boolean(err && err.status === 401 && err.code === 'reauth_required');
const DOC_ID_RE = /^[0-9a-f]{32}$/;

function cleanSessions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r.id === 'string' && r.id)
    .map((r) => ({
      id: r.id,
      createdAt: Number.isFinite(r.createdAt) ? r.createdAt : 0,
      lastSeenAt: Number.isFinite(r.lastSeenAt) ? r.lastSeenAt : 0,
      expiresAt: Number.isFinite(r.expiresAt) ? r.expiresAt : 0,
      current: r.current === true
    }));
}

const INITIAL = Object.freeze({
  status: 'loading',
  mode: null,
  account: null,
  keys: [],
  identity: null,
  mailAvailable: true,
  accountsAvailable: true,
  registration: 'unknown',
  registrationError: '',
  keyProblem: false,
  notice: '',
  error: ''
});

// What to tell the person when their key could not be loaded on this device.
function keyProblemText(problem) {
  if (problem === 'storage') return KEY_STORAGE_MESSAGE;
  if (problem === 'reauth') return KEY_REAUTH_MESSAGE;
  return 'Your key could not be loaded yet. Try again in a moment.';
}

function messageOf(err) {
  return err && err.message ? err.message : 'something went wrong';
}

function cleanAccount(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : null,
    emailMasked: typeof raw.emailMasked === 'string' ? raw.emailMasked : '',
    strict: Boolean(raw.strict),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0
  };
}

function cleanKeys(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((k) => k && typeof k.keyId === 'string')
    .map((k) => ({ keyId: k.keyId, hasCloudCopy: Boolean(k.hasCloudCopy) }));
}

export function createSessionStore(deps = {}) {
  const api = deps.api || realApi;
  const device = deps.device || realDevice;
  const vault = deps.vault || realVault;

  let state = INITIAL;
  const listeners = new Set();
  let epoch = 0;
  let healthKnown = false;
  let known = {}; // keyId -> identity, every key this device holds for the signed in account
  let madeKey = null; // a key that was made and sent for this account but could not be saved here yet
  const inflight = {}; // slot -> { key, promise }, so a second call with the same input joins the first

  // One call at a time per slot. The same input while one is running gets the same answer (a double tap, a
  // second form); different input waits its turn.
  function single(slot, key, run) {
    const cur = inflight[slot];
    if (cur && cur.key === key) return cur.promise;
    const go = () => {
      const promise = run().finally(() => {
        if (inflight[slot] && inflight[slot].promise === promise) delete inflight[slot];
      });
      inflight[slot] = { key, promise };
      return promise;
    };
    return cur ? cur.promise.catch(() => {}).then(go) : go();
  }

  const hasVault = (name) => typeof vault[name] === 'function';

  let reauthHandler = null; // set by the page: opens the "Confirm it is you" sheet, see requireFresh
  let ending = null; // the look that follows a 401 on a normal call, so a burst of them makes one

  // The server ended the session (signed out elsewhere, or the 90 days ran out) while the app was in use:
  // look once, and if the account is really gone move to the signed out state with a short message.
  function sessionEnded() {
    if (ending) return ending;
    if (state.mode !== 'account' || state.status === 'loading') return Promise.resolve();
    ending = (async () => {
      try {
        await load();
        if (state.mode !== 'account') {
          forgetEmail();
          set({ notice: SESSION_ENDED_NOTICE });
        }
      } catch {
        // the next look will tell
      } finally {
        ending = null;
      }
    })();
    return ending;
  }
  if (typeof api.setUnauthenticatedHandler === 'function') api.setUnauthenticatedHandler(() => sessionEnded());

  function dismissNotice() {
    set({ notice: '' });
  }

  // The next person on this browser must not see what the last one did: the list of files they published and
  // which chats they read are cleared with them.
  function forgetPersonalTraces() {
    clearLocalDocs();
    clearSeen();
  }

  function set(patch) {
    const next = { ...state, ...patch };
    if (next.identity && state.identity && next.identity.keyId === state.identity.keyId) next.identity = state.identity;
    const changed = Object.keys(next).some((k) => {
      if (k === 'account' || k === 'keys') return JSON.stringify(next[k]) !== JSON.stringify(state[k]);
      return next[k] !== state[k];
    });
    if (!changed) return;
    if (JSON.stringify(next.account) === JSON.stringify(state.account)) next.account = state.account;
    if (JSON.stringify(next.keys) === JSON.stringify(state.keys)) next.keys = state.keys;
    state = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  }

  vault.setVaultContext(() => ({
    mode: state.mode,
    strict: Boolean(state.account && state.account.strict),
    accountId: state.account ? state.account.id : ''
  }));

  const getState = () => state;
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ----- reading the world -----

  async function readHealth() {
    if (healthKnown) return;
    try {
      const health = await api.getHealth();
      const mail = health && typeof health.mail === 'string' ? health.mail : 'none';
      const accounts = health && health.accounts === false ? false : true;
      healthKnown = true;
      set({ mailAvailable: mail !== 'none' && accounts, accountsAvailable: accounts });
    } catch {
      // keep the defaults, try again next time
    }
  }

  // Looks for a guest key (or an identity restored from an old backup) and adopts it.
  async function adoptGuest(my) {
    let stored = null;
    try {
      stored = await device.loadGuest();
    } catch (err) {
      if (my !== epoch) return true;
      set({ status: 'signedOut', mode: null, account: null, keys: [], identity: null, registration: 'unknown', error: messageOf(err) });
      return true;
    }
    if (my !== epoch) return true;
    if (!stored) return false;
    known = { [stored.keyId]: stored };
    set({
      status: 'ready',
      mode: 'guest',
      account: null,
      keys: [],
      identity: stored,
      registration: 'unknown',
      registrationError: '',
      keyProblem: false,
      error: ''
    });
    checkRegistration(stored, my);
    return true;
  }

  // Tells the server about a guest key if it does not know it yet. Runs in the background.
  async function checkRegistration(identity, my) {
    const mine = () => my === epoch && state.identity && state.identity.keyId === identity.keyId;
    set({ registration: 'checking', registrationError: '' });
    try {
      await api.getIdentity(identity.keyId);
      if (mine()) set({ registration: 'registered' });
      return;
    } catch (err) {
      if (!err || err.status !== 404) {
        if (mine()) set({ registration: 'error', registrationError: messageOf(err) });
        return;
      }
    }
    if (mine()) set({ registration: 'missing' });
    try {
      await api.registerIdentity(identity.record, identity.signature);
      if (mine()) set({ registration: 'registered', registrationError: '' });
    } catch (err) {
      if (mine()) set({ registration: 'error', registrationError: messageOf(err) });
    }
  }

  // Signed in with an account: find the key for this device.
  async function enterAccount(me, my) {
    const account = cleanAccount(me.account);
    if (!account) return false;
    const keys = cleanKeys(me.keys);
    const keyIds = keys.map((k) => k.keyId);
    let local = { active: null, all: {} };
    try {
      local = await device.loadAccountKeys(account.id, keyIds);
    } catch {
      local = { active: null, all: {} };
    }
    let active = local.active;
    let all = { ...local.all };
    let problem = false; // true: the key could not be loaded, 'storage': this browser cannot keep it, 'reauth': a new code is needed first
    // Easy mode: the account holds a copy of the key. A device that does not have it yet downloads it.
    const cloud = keys.find((k) => k.hasCloudCopy);
    if (!account.strict && cloud && !all[cloud.keyId]) {
      let stored = null;
      let identity = null;
      try {
        const payload = await api.getMyKey();
        stored = await device.storedFromCloud(payload);
        identity = device.identityOf(stored);
      } catch (err) {
        // The session is older than 15 minutes: the key is only handed out after a new code (see unlockKey).
        if (!active) problem = isReauth(err) ? 'reauth' : true;
      }
      if (identity && identity.keyId === cloud.keyId) {
        try {
          await device.saveAccountKey(account.id, stored, { makeActive: true });
          all[identity.keyId] = identity;
          active = identity;
        } catch {
          // the key is fine but this browser cannot keep it, which is not a temporary problem
          if (!active) problem = 'storage';
        }
      } else if (stored) {
        problem = true;
      }
    }
    if (my !== epoch) return true;
    known = all;
    if (active) {
      set({ status: 'ready', mode: 'account', account, keys, identity: active, registration: 'registered', registrationError: '', keyProblem: false, notice: '', error: '' });
      // Passwords that could only be kept on this device earlier are given to the account now (best effort).
      if (!account.strict) flushPending(account.id).catch(() => {});
    } else {
      set({ status: 'needsKey', mode: 'account', account, keys, identity: null, registration: 'unknown', registrationError: '', keyProblem: problem, notice: '', error: '' });
    }
    return true;
  }

  async function load() {
    const my = ++epoch;
    await readHealth();
    if (my !== epoch) return;
    let me = null;
    let meError = null;
    try {
      me = await api.getMe();
    } catch (err) {
      if (err && err.status === 503 && err.code === 'accounts_unavailable') {
        healthKnown = true;
        set({ mailAvailable: false, accountsAvailable: false });
      } else if (!err || err.status !== 401) {
        meError = err;
      }
    }
    if (my !== epoch) return;
    if (meError && state.status !== 'loading') return; // a flaky connection must not sign anybody out
    // Nobody signed in (401) is the normal state of a visitor, not an error: nothing is said about it.
    if (me && (await enterAccount(me, my))) return;
    if (my !== epoch) return;
    if (await adoptGuest(my)) return;
    known = {};
    set({
      status: 'signedOut',
      mode: null,
      account: null,
      keys: [],
      identity: null,
      registration: 'unknown',
      registrationError: '',
      keyProblem: false,
      error: meError ? messageOf(meError) : ''
    });
  }

  // ----- actions -----

  async function requestCode(email) {
    const answer = await api.authRequest(String(email || '').trim());
    return {
      cooldown: Number.isFinite(answer && answer.cooldown) ? answer.cooldown : 30,
      ...(answer && typeof answer.debugCode === 'string' ? { debugCode: answer.debugCode } : {})
    };
  }

  function verifyCode(email, code) {
    const mail = String(email || '').trim();
    const digits = String(code || '').trim();
    return single('verify', mail + '|' + digits, async () => {
      const answer = await api.authVerify(mail, digits);
      rememberEmail(mail);
      await load();
      // a flaky connection right after the code was accepted: look once more before giving up
      if (state.mode !== 'account') await load();
      if (state.mode !== 'account') {
        // The code is used up and the server session already exists, so asking for a new code is the wrong
        // advice: a reload signs the person in. This is its own error code so the page can say so.
        throw new ApiError(0, 'finish_failed', 'The code was right, but we could not finish signing you in. Reload the page or check your connection.');
      }
      return { isNew: Boolean(answer && answer.isNew), status: state.status };
    });
  }

  // The display name after the first sign in (or on a new device of a Strict account): makes the key.
  function registerName(displayName) {
    return single('name', String(displayName), () => makeAndRegisterKey(displayName));
  }

  async function makeAndRegisterKey(displayName) {
    if (state.mode !== 'account' || state.status !== 'needsKey' || !state.account) {
      throw new Error('Sign in first.');
    }
    if (state.keyProblem) throw new Error(keyProblemText(state.keyProblem));
    const account = state.account;
    const easy = !account.strict;
    // A key that the server already accepted but this browser could not save is used again. Making another
    // one would put a second key on the account (a Strict account may only have five).
    let made = madeKey && madeKey.accountId === account.id && madeKey.easy === easy && (madeKey.posted || madeKey.name === displayName) ? madeKey : null;
    if (!made) {
      const material = await device.makeKeyMaterial(displayName, { extractable: easy });
      made = madeKey = { accountId: account.id, easy, name: displayName, material, posted: false };
    }
    if (!made.posted) {
      const body = { record: made.material.record, signature: made.material.signature };
      if (easy) body.privateJwk = made.material.privateJwk;
      try {
        await api.postMyKey(body);
        made.posted = true;
      } catch (err) {
        if (easy && err && err.code === 'key_exists') {
          // another device made the key a moment ago: use that one
          madeKey = null;
          await load();
          if (state.status !== 'ready' || !state.identity) throw new Error(keyProblemText(state.keyProblem));
          return { keyId: state.identity.keyId };
        }
        throw err;
      }
    }
    // From here on only the non extractable copy is kept.
    let stored;
    let identity;
    try {
      stored = await device.toStored(made.material);
      await device.saveAccountKey(account.id, stored, { makeActive: true });
      identity = device.identityOf(stored);
    } catch {
      // the key is on the server but not here: it is kept in memory and tried again on the next call
      throw new Error(KEY_STORAGE_MESSAGE);
    }
    madeKey = null;
    epoch += 1;
    known = { ...known, [identity.keyId]: identity };
    const keys = [...state.keys.filter((k) => k.keyId !== identity.keyId), { keyId: identity.keyId, hasCloudCopy: easy }];
    set({
      status: 'ready',
      account: { ...account, displayName: account.displayName || identity.displayName },
      keys,
      identity,
      registration: 'registered',
      registrationError: '',
      keyProblem: false
    });
    return { keyId: identity.keyId };
  }

  // Quick start: a key on this device only, no passphrase, no backup, no email.
  async function startGuest(displayName) {
    if (state.status !== 'signedOut') throw new Error('You are already signed in.');
    const material = await device.makeKeyMaterial(displayName, { extractable: false });
    await api.registerIdentity(material.record, material.signature);
    const stored = await device.toStored(material);
    const identity = await device.saveGuest(stored);
    epoch += 1;
    known = { [identity.keyId]: identity };
    set({
      status: 'ready',
      mode: 'guest',
      account: null,
      keys: [],
      identity,
      registration: 'registered',
      registrationError: '',
      keyProblem: false,
      error: ''
    });
    return { keyId: identity.keyId };
  }

  async function forgetLocalGuest() {
    await device.forgetGuest();
    vault.localClear('guest');
    forgetPersonalTraces();
  }

  // Sends passwords that were kept on this device only because the account could not be reached back then.
  // -> { sent, left: [{ docId, password }] } where left are the ones that did not reach the account.
  async function flushPending(accountId) {
    if (!hasVault('pendingList')) return { sent: 0, left: [] };
    let sent = 0;
    for (const item of vault.pendingList(accountId).slice(0, 200)) {
      try {
        await api.putSecret(item.docId, item.password);
        if (hasVault('clearPending')) vault.clearPending(accountId, item.docId);
        sent += 1;
      } catch (err) {
        if (err && err.status === 401) break; // no session: nothing more can be sent
      }
    }
    return { sent, left: vault.pendingList(accountId) };
  }

  // Account: ends the session (an Easy account also drops its key from this device, it can be
  // downloaded again). Quick start: removes the key from this device, which cannot be undone.
  // discardUnsent: sign out even though some file passwords never reached the account (they are lost).
  // all: end every session of the account (every device), this one too.
  async function signOut({ discardUnsent = false, all = false } = {}) {
    const current = state;
    if (current.mode === 'account' && current.account) {
      if (!current.account.strict) {
        // Still signed in: give the account the passwords it has not got yet, and wipe none that fail.
        const { left } = await flushPending(current.account.id);
        if (left.length > 0 && !discardUnsent) {
          const many = left.length === 1 ? 'file password is' : 'file passwords are';
          const err = new ApiError(0, 'unsent_passwords', left.length + ' ' + many + ' saved only on this device and could not be sent to your account. Download them first, or try again when you are online.');
          err.passwords = left;
          throw err;
        }
      }
      try {
        if (all) await api.authLogout({ all: true });
        else await api.authLogout();
      } catch (err) {
        if (!err || err.status !== 401) throw err;
      }
      if (!current.account.strict) {
        await device.removeAccountKeys(current.account.id).catch(() => {});
        vault.localClear('a:' + current.account.id);
        if (hasVault('clearPending')) vault.clearPending(current.account.id);
      }
      forgetPersonalTraces();
    } else if (current.mode === 'guest') {
      await forgetLocalGuest();
    }
    forgetEmail();
    madeKey = null;
    epoch += 1;
    known = {};
    set({ status: 'signedOut', mode: null, account: null, keys: [], identity: null, registration: 'unknown', registrationError: '', keyProblem: false, notice: '', error: '' });
    await load();
  }

  // ----- confirming it is the same person (a session made in the last 15 minutes) -----

  // Registers the function that opens the "Confirm it is you" sheet. It is called with a request
  // { email, emailMasked, sent, cooldown, debugCode, sendError, sendCode(email), verify(email, code) } and returns a
  // promise of true (confirmed) or false (the person closed the sheet).
  function setReauthHandler(fn) {
    reauthHandler = typeof fn === 'function' ? fn : null;
  }

  // The address belongs to this account when it has the same masked form the server shows. The server still decides
  // (it only replaces the session of the account the code belongs to); this only stops a typo from sending a mail.
  function belongsToAccount(email) {
    const masked = state.account && state.account.emailMasked;
    if (!masked) return true;
    return maskEmail(String(email || '').trim().toLowerCase()) === masked;
  }

  async function reauthSendCode(email) {
    const mail = String(email || '').trim();
    if (!looksLikeEmail(mail)) throw new ApiError(400, 'invalid_email', 'That email address does not look right. Check it and try again.');
    if (!belongsToAccount(mail)) {
      const hint = state.account && state.account.emailMasked ? ' It looks like ' + state.account.emailMasked + '.' : '';
      throw new ApiError(0, 'wrong_account', WRONG_ACCOUNT_MESSAGE + hint);
    }
    return requestCode(mail);
  }

  // Verifies the code while the old cookie is still sent: the server then replaces the session of this account.
  async function reauthVerify(email, code) {
    const mail = String(email || '').trim();
    const digits = String(code || '').trim();
    const account = state.account;
    const answer = await api.authVerify(mail, digits);
    if (!account || !answer || !answer.account || answer.account.id !== account.id) {
      // The code belonged to another account, so the browser is now signed in as that one. Show the truth.
      await load().catch(() => {});
      throw new ApiError(0, 'wrong_account', 'That address belongs to a different account, so you are now signed in as that account. Nothing was changed on the first one.');
    }
    rememberEmail(mail);
    return true;
  }

  // One sheet at a time, however many actions are waiting. -> true when confirmed, false when closed.
  function askReauth() {
    return single('reauth', 'sheet', async () => {
      if (!reauthHandler) {
        throw new ApiError(401, 'reauth_required', 'To do this, sign out and sign in again with a new code, then repeat it.');
      }
      const email = rememberedEmail();
      const request = {
        email: email && belongsToAccount(email) ? email : '',
        emailMasked: state.account ? state.account.emailMasked : '',
        sent: false,
        cooldown: 0,
        debugCode: '',
        sendError: null,
        sendCode: reauthSendCode,
        verify: reauthVerify
      };
      // The address is known: the code is on its way before the sheet opens.
      if (request.email) {
        try {
          const sent = await reauthSendCode(request.email);
          request.sent = true;
          request.cooldown = sent.cooldown;
          request.debugCode = sent.debugCode || '';
        } catch (err) {
          request.sendError = err;
        }
      }
      return Boolean(await reauthHandler(request));
    });
  }

  // Runs action(). When the server answers 401 reauth_required, opens the sheet, and once the person is confirmed
  // runs action() one more time. The sheet is asked once per call: a second reauth_required is a plain error.
  // Closing the sheet rejects with code 'cancelled' and nothing has changed.
  async function requireFresh(action) {
    try {
      return await action();
    } catch (err) {
      if (!isReauth(err)) throw err;
    }
    const confirmed = await askReauth();
    if (!confirmed) throw new ApiError(0, 'cancelled', CANCELLED_MESSAGE);
    try {
      return await action();
    } catch (err) {
      if (isReauth(err)) throw new ApiError(401, 'reauth_failed', REAUTH_FAILED_MESSAGE);
      throw err;
    }
  }

  // The account holds the key but this session is too old to hand it out: confirm, then load it.
  async function unlockKey() {
    if (state.mode !== 'account' || state.status !== 'needsKey') throw new Error('Sign in first.');
    await requireFresh(() => api.getMyKey());
    await load();
    if (state.status === 'needsKey' && state.keyProblem) throw new Error(keyProblemText(state.keyProblem));
  }

  // ----- Strict and Easy mode -----

  // True while a switch to Strict mode was started on this device and not finished (the service may still hold
  // passwords for it, for 24 hours).
  function strictUnfinished() {
    return Boolean(state.account && hasVault('strictRunOpen') && vault.strictRunOpen(state.account.id));
  }

  function strictStorageError(handed, storedCount) {
    const err = new ApiError(
      0,
      'strict_unfinished',
      'Your file passwords could not all be saved on this device (' + storedCount + ' of ' + handed.length + ' handed over so far). The service keeps the rest for 24 hours: try again, or use another browser. Download the ones you have first.'
    );
    err.passwords = handed;
    return err;
  }

  // Strict on. The service hands the passwords over in pages of 100 and deletes nothing until it is told that a
  // page is stored. Each page is written to this device, read back, and only then confirmed. The account shows as
  // Strict only after the last page is stored. A failure leaves the rest on the service (24 hours): asking again
  // returns the same pages, so a retry resumes where it stopped.
  async function enableStrict(account, onProgress) {
    if (hasVault('canKeepLocally') && !vault.canKeepLocally()) throw new Error(STRICT_STORAGE_MESSAGE);
    // From the first question on the service may switch the account to Strict, so the unfinished switch is written
    // down first. It is taken back below when the service certainly did nothing (see notDone).
    const hadRun = hasVault('strictRunOpen') && vault.strictRunOpen(account.id);
    if (hasVault('markStrictRun') && !vault.markStrictRun(account.id)) throw new Error(STRICT_STORAGE_MESSAGE);
    let answered = false; // the service has answered at least one question
    const handed = []; // everything handed over in this run, also kept in memory so it can be downloaded if storing fails
    let unreadable = 0;
    let after;
    try {
      for (let pages = 1; ; pages++) {
        if (pages > MAX_STRICT_PAGES) throw new ApiError(0, 'strict_answer', 'The service kept sending pages. Try again later.');
        const page = await requireFresh(() => api.postStrict(true, after === undefined ? {} : { after }));
        answered = true;
        const raw = page && Array.isArray(page.passwords) ? page.passwords : null;
        const next = page && typeof page.next === 'string' && DOC_ID_RE.test(page.next) ? page.next : null;
        if (!raw || (page.next !== null && page.next !== undefined && next === null)) {
          throw new ApiError(0, 'strict_answer', 'The service sent an answer that could not be read. Nothing more was deleted: try again.');
        }
        const list = raw.filter((p) => p && typeof p.docId === 'string' && DOC_ID_RE.test(p.docId) && typeof p.password === 'string' && p.password);
        if (Number.isFinite(page.unreadable) && page.unreadable > 0) unreadable += Math.floor(page.unreadable);
        if (list.length > 0) {
          handed.push(...list);
          let kept = 0;
          if (hasVault('keepHandedOver')) kept = vault.keepHandedOver(list);
          else if (hasVault('rememberOnDevice')) kept = vault.rememberOnDevice(list);
          if (kept !== list.length) throw strictStorageError(handed, handed.length - list.length + kept);
          await requireFresh(() => api.postStrict(true, { confirmThrough: list[list.length - 1].docId }));
        }
        onProgress({ saved: handed.length, done: next === null });
        if (next === null) break;
        if (next === after) throw new ApiError(0, 'strict_answer', 'The service repeated a page. Try again later.');
        after = next;
      }
      // Last look: everything that was handed over is on this device.
      if (hasVault('localList')) {
        const there = new Map(vault.localList('a:' + account.id).map((p) => [p.docId, p.password]));
        const missing = handed.filter((p) => there.get(p.docId) !== p.password).length;
        if (missing > 0) throw strictStorageError(handed, handed.length - missing);
      }
    } catch (err) {
      if (err && typeof err === 'object' && !err.passwords && handed.length > 0) err.passwords = handed;
      // Closed the sheet, or the service refused before it did anything: the switch never started.
      const notDone = err && (err.code === 'cancelled' || err.code === 'reauth_failed' || (err.status >= 400 && err.status < 500 && err.status !== 429 && !handed.length));
      if (!answered && !hadRun && notDone && hasVault('clearStrictRun')) vault.clearStrictRun(account.id);
      throw err;
    }
    if (hasVault('clearStrictRun')) vault.clearStrictRun(account.id);
    // What is on this device now is kept on purpose, so none of it is waiting to be sent to the account.
    if (hasVault('clearPending')) vault.clearPending(account.id);
    epoch += 1;
    set({
      account: { ...account, strict: true },
      keys: state.keys.map((k) => ({ ...k, hasCloudCopy: false }))
    });
    return { passwords: handed, kept: handed.length, unreadable };
  }

  // Strict on: see enableStrict. onProgress({ saved, done }) is called after every page.
  // Strict off: the account may hold a key again; a new key is made and saved to it. The passwords the person
  // kept on this device on purpose are NOT sent to the account; only passwords published from then on are.
  async function setStrict(enabled, options = {}) {
    const wanted = Boolean(enabled);
    const onProgress = options && typeof options.onProgress === 'function' ? options.onProgress : () => {};
    // Strict can also be chosen on the name step, before any key exists and before anything is sent.
    const beforeKey = wanted && state.status === 'needsKey' && !state.keys.some((k) => k.hasCloudCopy);
    if (state.mode !== 'account' || !state.account || (state.status !== 'ready' && !beforeKey)) throw new Error('Sign in with your email first.');
    const account = state.account;
    if (wanted) return enableStrict(account, onProgress);
    // Going back to Easy deletes whatever the service still holds from an unfinished switch, so finish that first.
    if (hasVault('strictRunOpen') && vault.strictRunOpen(account.id)) {
      throw new Error('Saving your file passwords to this device is not finished. Turn Strict mode on again to finish it first, otherwise those passwords would be deleted.');
    }
    await requireFresh(() => api.postStrict(false));
    epoch += 1;
    set({ account: { ...account, strict: false } });
    // A key that the account can hold a copy of. Skipped when it already has one.
    if (!state.keys.some((k) => k.hasCloudCopy)) {
      const name = (state.identity && state.identity.displayName) || account.displayName;
      const material = await device.makeKeyMaterial(name, { extractable: true });
      try {
        await api.postMyKey({ record: material.record, signature: material.signature, privateJwk: material.privateJwk });
      } catch (err) {
        throw new Error(
          err && err.code === 'unauthenticated'
            ? messageOf(err)
            : 'Easy mode is on, but your key could not be saved to your account yet. Try again.'
        );
      }
      const stored = await device.toStored(material);
      await device.saveAccountKey(account.id, stored, { makeActive: true });
      const identity = device.identityOf(stored);
      known = { ...known, [identity.keyId]: identity };
      epoch += 1;
      set({
        identity,
        keys: [...state.keys.filter((k) => k.keyId !== identity.keyId), { keyId: identity.keyId, hasCloudCopy: true }]
      });
    }
    return { passwords: [], kept: 0, unreadable: 0 };
  }

  // Deletes the account (sessions, codes, keys and passwords on the server). Signed history stays.
  async function deleteAccount() {
    if (state.mode !== 'account' || !state.account) throw new Error('There is no account to delete.');
    const id = state.account.id;
    await requireFresh(() => api.deleteMe());
    await device.removeAccountKeys(id).catch(() => {});
    vault.localClear('a:' + id);
    if (hasVault('clearPending')) vault.clearPending(id);
    if (hasVault('clearStrictRun')) vault.clearStrictRun(id);
    forgetPersonalTraces();
    forgetEmail();
    madeKey = null;
    epoch += 1;
    known = {};
    set({ status: 'signedOut', mode: null, account: null, keys: [], identity: null, registration: 'unknown', registrationError: '', keyProblem: false, notice: '', error: '' });
    await load();
  }

  // ----- where the account is signed in -----

  function needAccount() {
    if (state.mode !== 'account' || !state.account) throw new Error('Sign in with your email first.');
  }

  // -> [{ id, createdAt, lastSeenAt, expiresAt, current }] newest first
  async function listSessions() {
    needAccount();
    const answer = await api.getSessions();
    return cleanSessions(answer && answer.sessions);
  }

  // Signs out every other device. -> { ended }
  async function endOtherSessions() {
    needAccount();
    const answer = await api.endOtherSessions();
    return { ended: answer && Number.isFinite(answer.ended) ? answer.ended : 0 };
  }

  // Signs out one other device by the id from listSessions. A device that is gone already counts as done.
  async function endSession(id) {
    needAccount();
    try {
      await api.endSession(String(id));
    } catch (err) {
      if (!err || err.status !== 404) throw err;
    }
    return { ended: 1 };
  }

  // ----- Advanced: identities from the old backup file flow -----

  function adoptLegacy(identity) {
    epoch += 1;
    const my = epoch;
    known = { [identity.keyId]: identity };
    set({
      status: 'ready',
      mode: 'guest',
      account: null,
      keys: [],
      identity,
      registration: 'unknown',
      registrationError: '',
      keyProblem: false,
      error: ''
    });
    return checkRegistration(identity, my);
  }

  async function createLegacy({ displayName, passphrase }) {
    const made = await keystore.createIdentity({ displayName, passphrase });
    await adoptLegacy(made.identity);
    return { backupText: made.backupText, backupName: made.backupName };
  }

  async function restoreBackup(text, passphrase) {
    // A Quick start key has no backup and cannot be made again. Writing a restored identity into the same slot
    // would replace it for good, along with the power to update or withdraw what it published.
    const existing = await keystore.loadIdentity().catch(() => null);
    if (existing && !existing.hasBackup) {
      throw new Error(QUICK_KEY_KEPT_MESSAGE);
    }
    const restored = await keystore.restoreIdentity(text, passphrase);
    // An account session wins over a restored identity: the identity is only kept on the device.
    if (state.mode !== 'account') await adoptLegacy(restored);
    return restored;
  }

  function exportBackup(passphrase) {
    return keystore.exportBackup(passphrase);
  }

  async function registerAgain() {
    const identity = state.identity;
    if (!identity) throw new Error('there is no identity to register');
    set({ registration: 'checking', registrationError: '' });
    try {
      await api.registerIdentity(identity.record, identity.signature);
      set({ registration: 'registered' });
    } catch (err) {
      set({ registration: 'error', registrationError: messageOf(err) });
      throw err;
    }
  }

  async function forgetDevice() {
    if (state.mode === 'account') throw new Error('Sign out of your account instead.');
    await forgetLocalGuest();
    epoch += 1;
    known = {};
    set({ status: 'signedOut', mode: null, account: null, keys: [], identity: null, registration: 'unknown', registrationError: '', keyProblem: false, error: '' });
  }

  // The identity this device holds for a key id (the owner key of a file), or null.
  function identityFor(keyId) {
    return known[keyId] || null;
  }

  return {
    getState,
    subscribe,
    init: load,
    refresh: load,
    requestCode,
    verifyCode,
    registerName,
    startGuest,
    signOut,
    setStrict,
    strictUnfinished,
    deleteAccount,
    requireFresh,
    setReauthHandler,
    unlockKey,
    listSessions,
    endOtherSessions,
    endSession,
    dismissNotice,
    identityFor,
    createLegacy,
    restoreBackup,
    exportBackup,
    registerAgain,
    forgetDevice
  };
}
