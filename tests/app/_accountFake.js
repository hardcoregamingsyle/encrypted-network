// A small in memory copy of the account side of the server, for the session store tests. Not a test file (vitest
// only runs *.test.js). Nothing here touches a network.
//
// It follows the real endpoints (functions/api/me/strict.js, key.js, index.js, sessions, auth/verify.js):
//   - GET /api/me/key, POST /api/me/strict (both ways) and DELETE /api/me answer 401 reauth_required while
//     server.fresh is false; a right code at /api/auth/verify with a session present makes it fresh again
//   - Strict on hands the stored passwords over in pages of 100 in docId order with `next`, deletes nothing until
//     confirmThrough, and keeps what is not confirmed (server.handover)
import { keyIdOf, verifyRecord } from '../../shared/keys.js';
import { validateRecord } from '../../shared/records.js';
import { ApiError } from '../../src/lib/api.js';

export const ACCOUNT_ID = 'f'.repeat(32);
export const EMAIL = 'priya@example.com';
export const CODE = '123456';

export function fakeLocalStorage() {
  const map = new Map();
  const store = {
    map,
    writes: 0,
    failWrites: false,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      if (store.failWrites) throw new Error('storage is full');
      store.writes += 1;
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k)
  };
  return store;
}

export function blockedStorage() {
  const fail = () => {
    throw new Error('storage is blocked');
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

// 32 hex characters that sort in the order of n
export const docIdOf = (n) => String(n).padStart(32, '0');

export function passwordOf(n) {
  return 'PW' + String(n).padStart(4, '0') + '-ABCDE-FGHIJ-KLMNO';
}

// Puts n passwords on the account (docIds 1..n)
export function addSecrets(server, n) {
  for (let i = 1; i <= n; i++) server.secrets.set(docIdOf(i), passwordOf(i));
}

export function makeAccountServer(overrides = {}) {
  const s = {
    signedIn: false,
    account: null,
    keys: [],
    secrets: new Map(),
    handover: new Map(), // what Strict mode handed over and nobody confirmed yet
    registered: new Map(),
    sessions: [],
    calls: [],
    otp: CODE,
    health: { ok: true, signing: true, mail: 'resend', accounts: true },
    fresh: true, // false: the session is older than 15 minutes
    alwaysStale: false, // true: even a new code does not make it fresh (a server that keeps asking)
    down: false,
    pageSize: 100,
    unreadableOnFirstPage: 0,
    verifyAs: null, // an account object: the code belongs to another account
    onUnauth: null,
    ...overrides
  };
  const call = (name, arg) => s.calls.push(arg === undefined ? name : [name, arg]);
  s.count = (name) => s.calls.filter((c) => c === name || (Array.isArray(c) && c[0] === name)).length;
  const unauth = () => new ApiError(401, 'unauthenticated', 'sign in first');
  const net = () => new ApiError(0, 'network', 'offline');
  const stale = () => new ApiError(401, 'reauth_required', 'to do this, sign in again with a new email code');
  const needSession = () => {
    if (s.down) throw net();
    if (!s.signedIn) {
      const err = unauth();
      if (s.onUnauth) s.onUnauth(err);
      throw err;
    }
  };
  const needFresh = () => {
    needSession();
    if (!s.fresh || s.alwaysStale) throw stale();
  };
  s.makeSession = (id, extra = {}) => ({ id, createdAt: 1000, lastSeenAt: 2000, expiresAt: 9000, current: false, ...extra });

  s.api = {
    setUnauthenticatedHandler(fn) {
      s.onUnauth = fn;
    },
    async getHealth() {
      call('getHealth');
      if (s.down) throw net();
      return s.health;
    },
    async getMe() {
      call('getMe');
      if (s.down) throw net();
      if (!s.signedIn) throw unauth(); // quiet in the real api: it does not tell the handler
      return { account: { ...s.account }, keys: s.keys.map((k) => ({ keyId: k.keyId, hasCloudCopy: Boolean(k.privateJwk) })) };
    },
    async authRequest(email) {
      call('authRequest', email);
      if (s.requestError) throw s.requestError;
      return { sent: true, cooldown: 30 };
    },
    async authVerify(email, code) {
      call('authVerify', [email, code]);
      if (s.down) throw net();
      if (code !== s.otp) throw new ApiError(400, 'invalid_code', 'that code is not right');
      if (s.verifyAs) {
        s.signedIn = true;
        s.fresh = true;
        return { account: { ...s.verifyAs }, isNew: false };
      }
      const isNew = !s.account;
      if (!s.account) s.account = { id: ACCOUNT_ID, displayName: null, emailMasked: 'pr***@example.com', strict: false, createdAt: 1 };
      s.signedIn = true;
      s.fresh = true; // the old session is replaced by a new one
      return { account: { ...s.account }, isNew };
    },
    async authLogout(opts) {
      call(opts && opts.all ? 'authLogoutAll' : 'authLogout');
      if (opts && opts.all && !s.signedIn) throw unauth();
      s.signedIn = false;
      return { ok: true };
    },
    async postMyKey(body) {
      call('postMyKey', body);
      needSession();
      if (!validateRecord(body.record).ok) throw new ApiError(400, 'bad_request', 'bad record');
      if (!(await verifyRecord(body.record.publicKey, body.record, body.signature))) throw new ApiError(400, 'bad_signature', 'bad sig');
      if (body.privateJwk && s.account.strict) throw new ApiError(409, 'strict_mode', 'strict');
      if (body.privateJwk && s.keys.some((k) => k.privateJwk)) throw new ApiError(409, 'key_exists', 'exists');
      const keyId = await keyIdOf(body.record.publicKey);
      s.keys.push({ keyId, record: body.record, signature: body.signature, privateJwk: body.privateJwk || null });
      if (!s.account.displayName) s.account.displayName = body.record.displayName;
      return { keyId };
    },
    async getMyKey() {
      call('getMyKey');
      needFresh();
      if (s.account.strict) throw new ApiError(409, 'strict_mode', 'strict');
      const k = s.keys.find((x) => x.privateJwk);
      if (!k) throw new ApiError(404, 'not_found', 'none');
      return { keyId: k.keyId, publicKey: k.record.publicKey, privateJwk: k.privateJwk, record: k.record, signature: k.signature };
    },
    async putSecret(docId, password) {
      call('putSecret', docId);
      needSession();
      if (s.account.strict) throw new ApiError(409, 'strict_mode', 'strict');
      s.secrets.set(docId, password);
      return { ok: true };
    },
    async getSecret(docId) {
      call('getSecret', docId);
      if (!s.secrets.has(docId)) throw new ApiError(404, 'not_found', 'none');
      return { password: s.secrets.get(docId) };
    },
    postStrict: null, // below
    async deleteMe() {
      call('deleteMe');
      needFresh();
      s.signedIn = false;
      s.account = null;
      s.keys = [];
      s.secrets.clear();
      s.handover.clear();
      return { ok: true };
    },
    async getSessions() {
      call('getSessions');
      needSession();
      return { sessions: s.sessions.map((x) => ({ ...x })) };
    },
    async endOtherSessions() {
      call('endOtherSessions');
      needSession();
      const before = s.sessions.length;
      s.sessions = s.sessions.filter((x) => x.current);
      return { ok: true, ended: before - s.sessions.length };
    },
    async endSession(id) {
      call('endSession', id);
      needSession();
      const at = s.sessions.findIndex((x) => x.id === id);
      if (at < 0) throw new ApiError(404, 'not_found', 'no such session');
      const [gone] = s.sessions.splice(at, 1);
      if (gone.current) s.signedIn = false;
      return { ok: true };
    },
    async getIdentity(keyId) {
      call('getIdentity', keyId);
      if (!s.registered.has(keyId)) throw new ApiError(404, 'not_found', 'unknown');
      return s.registered.get(keyId);
    },
    async registerIdentity(record, signature) {
      call('registerIdentity', record.displayName);
      const keyId = await keyIdOf(record.publicKey);
      s.registered.set(keyId, { keyId, record, signature });
      return { keyId };
    }
  };
  s.api.postStrict = paginatedStrict(s);
  return s;
}

// POST /api/me/strict as the real endpoint answers it. The call is logged as ['postStrict', body].
export function paginatedStrict(s) {
  return async function postStrict(enabled, opts = {}) {
    const after = opts.after;
    const through = opts.confirmThrough;
    s.calls.push(['postStrict', enabled === true ? (through !== undefined ? { confirmThrough: through } : after !== undefined ? { after } : {}) : false]);
    if (s.down) throw new ApiError(0, 'network', 'offline');
    if (!s.signedIn) {
      const err = new ApiError(401, 'unauthenticated', 'sign in first');
      if (s.onUnauth) s.onUnauth(err);
      throw err;
    }
    if (!s.fresh || s.alwaysStale) throw new ApiError(401, 'reauth_required', 'to do this, sign in again with a new email code');
    if (s.failStrictCall && s.failStrictCall({ enabled, after, through })) throw new ApiError(0, 'network', 'offline');
    if (!enabled) {
      if (s.account.strict) s.handover.clear();
      s.account.strict = false;
      return { strict: false, passwords: [] };
    }
    if (!s.account.strict) {
      // the one call that really flips: the stored passwords wait for the client, the key copy goes
      s.account.strict = true;
      for (const [id, pw] of s.secrets) s.handover.set(id, pw);
      s.secrets.clear();
      for (const k of s.keys) k.privateJwk = null;
    }
    if (through !== undefined) {
      for (const id of [...s.handover.keys()]) if (id <= through) s.handover.delete(id);
      return { strict: true, passwords: [], next: null, remaining: s.handover.size };
    }
    const ids = [...s.handover.keys()].sort().filter((id) => id > (after === undefined ? '' : after));
    const page = ids.slice(0, s.pageSize);
    const next = ids.length > s.pageSize ? page[page.length - 1] : null;
    const answer = { strict: true, passwords: page.map((docId) => ({ docId, password: s.handover.get(docId) })), next };
    if (after === undefined && s.unreadableOnFirstPage > 0) answer.unreadable = s.unreadableOnFirstPage;
    if (s.mangleNext) answer.next = s.mangleNext(answer, after);
    return answer;
  };
}

export async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
