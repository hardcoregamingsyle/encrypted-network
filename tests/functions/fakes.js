// Test doubles for the Workers bindings: a D1 look alike on node:sqlite (all migrations applied) and a
// small R2 and KV look alikes. Not a test file itself.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '../../shared/hash.js';
import { exportPrivateJwk, exportPublicJwk, generateKeyPair, keyIdOf, signRecord } from '../../shared/keys.js';
import { onRequest as middleware } from '../../functions/_middleware.js';
import * as authRequestRoute from '../../functions/api/auth/request.js';
import * as authVerifyRoute from '../../functions/api/auth/verify.js';
import * as authLogoutRoute from '../../functions/api/auth/logout.js';
import * as meRoute from '../../functions/api/me/index.js';
import * as meKeyRoute from '../../functions/api/me/key.js';
import * as meDocsRoute from '../../functions/api/me/documents.js';
import * as meStrictRoute from '../../functions/api/me/strict.js';
import * as meSecretsRoute from '../../functions/api/me/secrets/[docId].js';
import * as meSessionsRoute from '../../functions/api/me/sessions/index.js';
import * as meSessionRoute from '../../functions/api/me/sessions/[id].js';
import * as meFilesRoute from '../../functions/api/me/files/index.js';
import * as meFileRoute from '../../functions/api/me/files/[id].js';
import * as meFilesCheckRoute from '../../functions/api/me/files-check.js';
import * as identitiesRoute from '../../functions/api/identities/index.js';
import * as healthRoute from '../../functions/api/health.js';
import * as channelsRoute from '../../functions/api/channels/index.js';
import * as messagesRoute from '../../functions/api/channels/[channelId]/messages.js';
import * as channelKeyRoute from '../../functions/api/channels/[channelId]/key.js';
import * as channelMembersRoute from '../../functions/api/channels/[channelId]/members.js';
import * as docViewRoute from '../../functions/api/documents/[docId]/view.js';
import * as docListRoute from '../../functions/api/documents/index.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function newDatabase(upTo = null) {
  const db = new DatabaseSync(':memory:');
  for (const name of migrationFiles()) {
    if (upTo && name > upTo) break;
    db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
  }
  return db;
}

function run(db, sql, args) {
  const st = db.prepare(sql);
  if (/^\s*SELECT/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { results: st.all(...args), meta: { changes: 0 } };
  const r = st.run(...args);
  return { results: [], meta: { changes: Number(r.changes) } };
}

// D1 look alike. hooks.beforeCall (optional async function) runs before every call.
export function fakeD1(db, hooks = {}) {
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    first: async () => {
      if (hooks.beforeCall) await hooks.beforeCall(sql);
      return run(db, sql, args).results[0] || null;
    },
    all: async () => {
      if (hooks.beforeCall) await hooks.beforeCall(sql);
      return run(db, sql, args);
    },
    run: async () => {
      if (hooks.beforeCall) await hooks.beforeCall(sql);
      return run(db, sql, args);
    }
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      if (hooks.beforeCall) await hooks.beforeCall('batch');
      db.exec('BEGIN');
      try {
        const out = list.map((s) => run(db, s.sql, s.args));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  };
}

// R2 look alike. put reads the whole stream, checks the sha256 option and the stream errors.
export function fakeR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, opts = {}) {
      const chunks = [];
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.length;
      }
      if (opts.sha256 && (await sha256Hex(bytes)) !== opts.sha256) {
        throw new Error('put: The SHA-256 checksum you specified did not match what we received. (10037)');
      }
      objects.set(key, bytes);
      return { key, size: bytes.length };
    },
    async head(key) {
      const b = objects.get(key);
      return b ? { key, size: b.length } : null;
    },
    async get(key) {
      const b = objects.get(key);
      return b ? { key, size: b.length, body: new Blob([b]).stream() } : null;
    },
    async delete(key) {
      objects.delete(key);
    }
  };
}

// KV look alike. objects holds the bytes, notes the metadata. failNextPut(text) makes the next put throw.
export function fakeKV() {
  const objects = new Map();
  const notes = new Map();
  let failure = null;
  return {
    objects,
    notes,
    failNextPut(text) {
      failure = text;
    },
    async getWithMetadata(key) {
      const b = objects.get(key);
      if (!b) return { value: null, metadata: null, cacheStatus: null };
      return { value: new Blob([b]).stream(), metadata: notes.has(key) ? notes.get(key) : null, cacheStatus: null };
    },
    async put(key, value, opts = {}) {
      if (failure) {
        const text = failure;
        failure = null;
        throw new Error(text);
      }
      const bytes = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) : new Uint8Array(value);
      if (bytes.length > 25 * 1024 * 1024) throw new Error("KV PUT failed: 413 Value length exceeds the 25 MiB limit");
      objects.set(key, bytes);
      notes.set(key, opts.metadata === undefined ? null : opts.metadata);
    },
    async delete(key) {
      objects.delete(key);
      notes.delete(key);
    }
  };
}

export function streamOfBytes(bytes, chunk = 1000) {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    }
  });
}

// Random bytes with a valid locked file header on top.
export function lockedBytes(n = 300, { iterations = 600000, suite = 1, magic = 'HRDLOCK3' } = {}) {
  const b = new Uint8Array(Math.max(n, 0));
  for (let off = 0; off < b.length; off += 65536) crypto.getRandomValues(b.subarray(off, Math.min(b.length, off + 65536)));
  for (let i = 0; i < 8 && i < b.length; i++) b[i] = magic.charCodeAt(i);
  if (b.length > 12) {
    b[8] = suite;
    new DataView(b.buffer).setUint32(9, iterations, false);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Accounts: an environment with the account secrets, a router that runs a request through the real
// middleware and route modules, a cookie jar, and small row helpers.

// base64 of 32 random bytes, the shape of ACCOUNT_MASTER_KEY.
export function masterKeyText() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
}

// A full environment: D1 on sqlite (all migrations), file store, master key, echo mail.
// opts.env overrides or removes (undefined) variables, opts.upTo limits the migrations.
export function accountEnv(opts = {}) {
  const db = newDatabase(opts.upTo || null);
  const env = { DB: fakeD1(db, opts.hooks), FILES: fakeR2(), ACCOUNT_MASTER_KEY: masterKeyText(), MAIL_PROVIDER: 'echo' };
  for (const [k, v] of Object.entries(opts.env || {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return { db, env };
}

const ROUTES = [
  [/^\/api\/auth\/request$/, authRequestRoute, []],
  [/^\/api\/auth\/verify$/, authVerifyRoute, []],
  [/^\/api\/auth\/logout$/, authLogoutRoute, []],
  [/^\/api\/me$/, meRoute, []],
  [/^\/api\/me\/key$/, meKeyRoute, []],
  [/^\/api\/me\/documents$/, meDocsRoute, []],
  [/^\/api\/me\/strict$/, meStrictRoute, []],
  [/^\/api\/me\/secrets\/([^/]+)$/, meSecretsRoute, ['docId']],
  [/^\/api\/me\/sessions$/, meSessionsRoute, []],
  [/^\/api\/me\/sessions\/([^/]+)$/, meSessionRoute, ['id']],
  [/^\/api\/me\/files-check$/, meFilesCheckRoute, []],
  [/^\/api\/me\/files$/, meFilesRoute, []],
  [/^\/api\/me\/files\/([^/]+)$/, meFileRoute, ['id']],
  [/^\/api\/identities$/, identitiesRoute, []],
  [/^\/api\/health$/, healthRoute, []],
  [/^\/api\/channels$/, channelsRoute, []],
  [/^\/api\/channels\/([^/]+)\/messages$/, messagesRoute, ['channelId']],
  [/^\/api\/channels\/([^/]+)\/key$/, channelKeyRoute, ['channelId']],
  [/^\/api\/channels\/([^/]+)\/members$/, channelMembersRoute, ['channelId']],
  [/^\/api\/documents\/([^/]+)\/view$/, docViewRoute, ['docId']],
  [/^\/api\/documents$/, docListRoute, []]
];

// Cookie jar: remembers the cookies a response sets (name -> value) and sends them back.
export class Jar {
  constructor() {
    this.cookies = new Map();
    this.last = [];
  }
  absorb(response) {
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    this.last = list;
    for (const c of list) {
      const [pair, ...attrs] = c.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      if (value === '' || (maxAge && Number(maxAge.split('=')[1]) <= 0)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name) {
    return this.cookies.get(name);
  }
}

// Runs one request through the middleware and the matching route like Cloudflare Pages does.
// o: base, ip, jar, json, body, headers, origin (a string, or null to send none).
// Returns { status, headers, json, text, res }.
export async function callApi(env, method, path, o = {}) {
  const base = o.base || 'http://localhost';
  const url = new URL(path, base);
  const headers = new Headers(o.headers || {});
  if (o.origin !== null && !headers.has('Origin') && method !== 'GET' && method !== 'HEAD') headers.set('Origin', o.origin || url.origin);
  if (o.ip) headers.set('CF-Connecting-IP', o.ip);
  if (o.jar && o.jar.header()) headers.set('Cookie', o.jar.header());
  let body;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers.set('Content-Type', 'application/json');
  } else if (o.body !== undefined) {
    body = o.body;
  }
  const request = new Request(url, { method, headers, body });
  let handler = null;
  const params = {};
  for (const [re, mod, names] of ROUTES) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
    handler = mod['onRequest' + method[0] + method.slice(1).toLowerCase()] || mod.onRequest;
    break;
  }
  const context = {
    request,
    env,
    params,
    next: async () => {
      if (!handler) throw new Error('no route for ' + path);
      return handler({ request, env, params });
    }
  };
  const res = await middleware(context);
  if (o.jar) o.jar.absorb(res);
  const text = await res.text();
  let parsed = null;
  if ((res.headers.get('content-type') || '').includes('json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, headers: res.headers, json: parsed, text, res };
}

// A random loopback client address (127.0.0.0/8), so rate limits per address do not collide.
export function loopbackIp() {
  const n = () => Math.floor(Math.random() * 250) + 1;
  return `127.${n()}.${n()}.${n()}`;
}

// Signs in through the real endpoints (echo mail). Returns { jar, account, isNew, email, ip }.
let emailCounter = 0;
export async function signIn(env, { email = null, base = 'http://localhost', ip = null, jar = new Jar() } = {}) {
  const address = email || `person${++emailCounter}-${Math.floor(Math.random() * 1e9)}@example.test`;
  const addr = ip || loopbackIp();
  const req = await callApi(env, 'POST', '/api/auth/request', { base, ip: addr, json: { email: address } });
  if (req.status !== 200) throw new Error('request failed: ' + req.text);
  const ver = await callApi(env, 'POST', '/api/auth/verify', { base, ip: addr, jar, json: { email: address, code: req.json.debugCode } });
  if (ver.status !== 200) throw new Error('verify failed: ' + ver.text);
  return { jar, account: ver.json.account, isNew: ver.json.isNew, email: address, ip: addr };
}

// A signing key with its identity record. The private key is extractable so a test can send it.
export async function makeKey(displayName = 'Test Person', { createdAt = Date.now() } = {}) {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: true });
  const publicJwk = await exportPublicJwk(publicKey);
  const keyId = await keyIdOf(publicJwk);
  const record = { v: 2, type: 'identity', publicKey: publicJwk, displayName, createdAt };
  const signature = await signRecord(privateKey, record);
  return { keyId, publicJwk, privateKey, record, signature, privateJwk: await exportPrivateJwk(privateKey), displayName };
}

// Inserts a document row for a key (the account tests do not need the whole chain).
export function seedDocument(db, { docId, ownerKeyId, label = 'doc', listed = 1, status = 'active', version = 1, updatedAt = 1000 }) {
  db.prepare(
    'INSERT INTO documents (doc_id, owner_key_id, status, listed, head_version, head_record_hash, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(docId, ownerKeyId, status, listed, version, 'e'.repeat(64), label, updatedAt, updatedAt);
}

export const randomDocId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// A stand in for fetch that records its calls. answer is a Response or a function (url, init) -> Response.
export function stubFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return typeof answer === 'function' ? answer(String(url), init) : answer;
  };
  fn.calls = calls;
  return fn;
}
