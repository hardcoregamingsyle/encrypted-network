// Fakes for the system2 trust review: an in memory localStorage and a small fake server for the
// account API. Not a test file (vitest only runs *.test.js). Nothing here touches a network.
import { keyIdOf, verifyRecord } from '../../../shared/keys.js';
import { validateRecord } from '../../../shared/records.js';
import { ApiError } from '../../../src/lib/api.js';
import { paginatedStrict } from '../../app/_accountFake.js';

export function fakeLocalStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    keys: () => [...map.keys()]
  };
}

// A storage that refuses everything, like a browser with site data blocked.
export function blockedLocalStorage() {
  const fail = () => {
    throw new Error('storage is blocked');
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

export const ACCOUNT_ID = 'f'.repeat(32);
export const DOC = 'ab'.repeat(16);
export const DOC2 = 'cd'.repeat(16);

// One account, its keys, its secrets. Options let a test make the account Strict or break a call.
export function makeServer(overrides = {}) {
  const s = {
    signedIn: false,
    account: null,
    strictFromStart: false,
    keys: [],
    secrets: new Map(),
    handover: new Map(),
    fresh: true,
    registered: new Map(),
    calls: [],
    otp: '123456',
    failSecrets: false,
    health: { ok: true, signing: true, mail: 'resend', accounts: true },
    ...overrides
  };
  const count = (name) => s.calls.filter((c) => c === name || (Array.isArray(c) && c[0] === name)).length;
  s.count = count;
  const unauth = () => new ApiError(401, 'unauthenticated', 'sign in first');
  const net = () => new ApiError(0, 'network', 'offline');
  s.api = {
    async getHealth() {
      s.calls.push('getHealth');
      return s.health;
    },
    async getMe() {
      s.calls.push('getMe');
      if (!s.signedIn) throw unauth();
      return { account: { ...s.account }, keys: s.keys.map((k) => ({ keyId: k.keyId, hasCloudCopy: Boolean(k.privateJwk) })) };
    },
    async authRequest(email) {
      s.calls.push(['authRequest', email]);
      return { sent: true, cooldown: 30 };
    },
    async authVerify(email, code) {
      s.calls.push(['authVerify', code]);
      // a right code is used up, like the real server does
      await Promise.resolve();
      if (s.otp === null || code !== s.otp) throw new ApiError(400, 'invalid_code', 'wrong');
      s.otp = null;
      const isNew = !s.account;
      if (!s.account) {
        s.account = { id: ACCOUNT_ID, displayName: null, emailMasked: 'pr***@example.com', strict: s.strictFromStart, createdAt: 1 };
      }
      s.signedIn = true;
      return { account: { ...s.account }, isNew };
    },
    async authLogout() {
      s.calls.push('authLogout');
      s.signedIn = false;
      return { ok: true };
    },
    async postMyKey(body) {
      s.calls.push(['postMyKey', body]);
      if (!s.signedIn) throw unauth();
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
      s.calls.push('getMyKey');
      if (!s.signedIn) throw unauth();
      const k = s.keys.find((x) => x.privateJwk);
      if (!k) throw new ApiError(404, 'not_found', 'none');
      return { keyId: k.keyId, publicKey: k.record.publicKey, privateJwk: k.privateJwk, record: k.record, signature: k.signature };
    },
    async putSecret(docId, password) {
      s.calls.push(['putSecret', docId]);
      if (s.failSecrets) throw net();
      if (!s.signedIn) throw unauth();
      if (s.account.strict) throw new ApiError(409, 'strict_mode', 'strict');
      s.secrets.set(docId, password);
      return { ok: true };
    },
    async getSecret(docId) {
      s.calls.push(['getSecret', docId]);
      if (s.failSecrets) throw net();
      if (!s.secrets.has(docId)) throw new ApiError(404, 'not_found', 'none');
      return { password: s.secrets.get(docId) };
    },
    postStrict: null, // below: the server hands the passwords over in pages, see tests/app/_accountFake.js
    async deleteMe() {
      s.calls.push('deleteMe');
      s.signedIn = false;
      s.account = null;
      s.keys = [];
      s.secrets.clear();
      return { ok: true };
    },
    async getIdentity(keyId) {
      s.calls.push(['getIdentity', keyId]);
      if (!s.registered.has(keyId)) throw new ApiError(404, 'not_found', 'unknown');
      return s.registered.get(keyId);
    },
    async registerIdentity(record, signature) {
      s.calls.push(['registerIdentity', record.displayName]);
      const keyId = await keyIdOf(record.publicKey);
      s.registered.set(keyId, { keyId, record, signature });
      return { keyId };
    }
  };
  s.api.postStrict = paginatedStrict(s);
  return s;
}

export async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
