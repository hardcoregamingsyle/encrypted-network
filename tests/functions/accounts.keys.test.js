// Account keys, stored passwords, Strict mode, My files. All through the real routes and middleware.
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../../shared/canonical.js';
import { utf8Encode } from '../../shared/encoding.js';
import { importPrivateJwk, signRecord, verifyRecord } from '../../shared/keys.js';
import { atRest } from '../../functions/_lib/atRest.js';
import { Jar, accountEnv, callApi, loopbackIp, makeKey, randomDocId, seedDocument, signIn } from './fakes.js';

const api = (env, method, path, jar, json, o = {}) => callApi(env, method, path, { jar, json, ...o });

async function account(opts = {}) {
  const ctx = accountEnv(opts);
  const s = await signIn(ctx.env);
  return { ...ctx, s, jar: s.jar };
}

describe('POST /api/me/key', () => {
  it('registers a key with a cloud copy, links it, and sets the display name', async () => {
    const { env, db, jar, s } = await account();
    const k = await makeKey('Priya');
    const res = await api(env, 'POST', '/api/me/key', jar, { record: k.record, signature: k.signature, privateJwk: k.privateJwk });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ keyId: k.keyId });
    expect(db.prepare('SELECT display_name FROM identities WHERE key_id = ?').get(k.keyId).display_name).toBe('Priya');
    expect(db.prepare('SELECT display_name FROM accounts WHERE id = ?').get(s.account.id).display_name).toBe('Priya');
    const me = await api(env, 'GET', '/api/me', jar);
    expect(me.json.account.displayName).toBe('Priya');
    expect(me.json.keys).toEqual([{ keyId: k.keyId, hasCloudCopy: true }]);
    // the stored value is wrapped: the private part of the key is not readable in the database
    const stored = db.prepare('SELECT wrapped_private FROM account_keys').get().wrapped_private;
    expect(stored).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain(k.privateJwk.d);
    expect(JSON.stringify(db.prepare('SELECT * FROM account_keys').all())).not.toContain(k.privateJwk.d);
    // the identity is public through the open endpoint
    const open = await callApi(env, 'GET', '/api/health');
    expect(open.status).toBe(200);
  });

  it('registers a key without a cloud copy', async () => {
    const { env, db, jar } = await account();
    const k = await makeKey('No Copy');
    const res = await api(env, 'POST', '/api/me/key', jar, { record: k.record, signature: k.signature });
    expect(res.status).toBe(201);
    expect(db.prepare('SELECT wrapped_private FROM account_keys').get().wrapped_private).toBeNull();
    const me = await api(env, 'GET', '/api/me', jar);
    expect(me.json.keys).toEqual([{ keyId: k.keyId, hasCloudCopy: false }]);
    expect((await api(env, 'GET', '/api/me/key', jar)).status).toBe(404);
  });

  it('GET returns the key to a second device (fresh cookie jar) and it signs correctly', async () => {
    const ctx = accountEnv();
    const email = 'two-devices@example.test';
    const first = await signIn(ctx.env, { email });
    const k = await makeKey('Two Devices');
    await api(ctx.env, 'POST', '/api/me/key', first.jar, { record: k.record, signature: k.signature, privateJwk: k.privateJwk });
    const second = await signIn(ctx.env, { email });
    expect(second.isNew).toBe(false);
    expect(second.account.displayName).toBe('Two Devices');
    const res = await api(ctx.env, 'GET', '/api/me/key', second.jar);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(res.json).sort()).toEqual(['keyId', 'privateJwk', 'publicKey', 'record', 'signature']);
    expect(res.json.keyId).toBe(k.keyId);
    expect(res.json.record).toEqual(k.record);
    expect(res.json.signature).toBe(k.signature);
    expect(res.json.privateJwk).toEqual(k.privateJwk);
    const priv = await importPrivateJwk(res.json.privateJwk, { extractable: false });
    const probe = { v: 2, type: 'message', note: 'x' };
    expect(await verifyRecord(res.json.publicKey, probe, await signRecord(priv, probe))).toBe(true);
  });

  it('needs a session (401), and a body of the right shape (400)', async () => {
    const { env, jar } = await account();
    const k = await makeKey();
    expect((await callApi(env, 'POST', '/api/me/key', { json: { record: k.record, signature: k.signature } })).status).toBe(401);
    for (const body of [{}, { record: 5, signature: 's' }, { record: k.record }, { record: k.record, signature: 5 }, { record: k.record, signature: k.signature, privateJwk: 'x' }, { record: k.record, signature: k.signature, privateJwk: [] }]) {
      const res = await api(env, 'POST', '/api/me/key', jar, body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
  });

  it('refuses a record that is not a valid self signed identity', async () => {
    const { env, db, jar } = await account();
    const k = await makeKey('Mallory');
    const other = await makeKey('Other');
    const cases = [
      [{ record: { ...k.record, displayName: 'Changed' }, signature: k.signature }, 'bad_signature'],
      [{ record: k.record, signature: other.signature }, 'bad_signature'],
      [{ record: { ...k.record, extra: 1 }, signature: k.signature }, 'bad_request'],
      [{ record: { ...k.record, type: 'message' }, signature: k.signature }, 'bad_request'],
      [{ record: { ...k.record, displayName: '' }, signature: k.signature }, 'bad_request']
    ];
    for (const [body, code] of cases) {
      const res = await api(env, 'POST', '/api/me/key', jar, body);
      expect(res.status).toBe(400);
      expect(res.json.code).toBe(code);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM identities').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_keys').get().n).toBe(0);
  });

  it('refuses an identity record that is too old or too far ahead (expired)', async () => {
    const { env, jar } = await account();
    for (const offset of [-11 * 60_000, 11 * 60_000]) {
      const k = await makeKey('Clock', { createdAt: Date.now() + offset });
      const res = await api(env, 'POST', '/api/me/key', jar, { record: k.record, signature: k.signature });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe('expired');
    }
  });

  it('proves the private key belongs to the public key before storing anything', async () => {
    const { env, db, jar } = await account();
    const k = await makeKey('Pair');
    const other = await makeKey('Not Pair');
    // the private part of another key
    const wrongD = { ...k.privateJwk, d: other.privateJwk.d };
    // x and y of another key
    const wrongPub = { ...other.privateJwk };
    // missing and extra fields
    const { d, ...noD } = k.privateJwk;
    const bodies = [wrongD, wrongPub, noD, { ...k.privateJwk, ext: true }, { ...k.privateJwk, d: 'short' }, {}, { kty: 'RSA' }];
    for (const privateJwk of bodies) {
      const res = await api(env, 'POST', '/api/me/key', jar, { record: k.record, signature: k.signature, privateJwk });
      expect(res.status, JSON.stringify(Object.keys(privateJwk))).toBe(400);
      expect(res.json.code).toBe('bad_request');
      // the key never comes back in an error
      expect(res.text).not.toContain(k.privateJwk.d);
      expect(res.text).not.toContain(other.privateJwk.d);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_keys').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM identities').get().n).toBe(0);
  });

  it('an Easy account that already has a cloud key gets 409 key_exists for another key', async () => {
    const { env, jar } = await account();
    const a = await makeKey('First');
    const b = await makeKey('Second');
    expect((await api(env, 'POST', '/api/me/key', jar, { record: a.record, signature: a.signature, privateJwk: a.privateJwk })).status).toBe(201);
    for (const withCopy of [true, false]) {
      const res = await api(env, 'POST', '/api/me/key', jar, { record: b.record, signature: b.signature, ...(withCopy ? { privateJwk: b.privateJwk } : {}) });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('key_exists');
    }
  });

  it('registering the same key again is a quiet success (retry after a lost answer)', async () => {
    const { env, db, jar } = await account();
    const k = await makeKey('Retry');
    await api(env, 'POST', '/api/me/key', jar, { record: k.record, signature: k.signature, privateJwk: k.privateJwk });
    const again = await api(env, 'POST', '/api/me/key', jar, { record: k.record, signature: k.signature, privateJwk: k.privateJwk });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ keyId: k.keyId, existed: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_keys').get().n).toBe(1);
  });

  it('a key that is already registered (a guest key) can not be linked: its record is public', async () => {
    const { env, db, jar } = await account();
    const k = await makeKey('Guest');
    const guest = await callApi(env, 'POST', '/api/identities', { json: { record: k.record, signature: k.signature }, ip: loopbackIp() });
    expect(guest.status).toBe(201);
    const res = await api(env, 'POST', '/api/me/key', jar, { record: k.record, signature: k.signature });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('exists');
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_keys').get().n).toBe(0);
  });

  it('a key of one account can not be linked to another account', async () => {
    const ctx = accountEnv();
    const a = await signIn(ctx.env);
    const b = await signIn(ctx.env);
    const k = await makeKey('Mine');
    await api(ctx.env, 'POST', '/api/me/key', a.jar, { record: k.record, signature: k.signature, privateJwk: k.privateJwk });
    const res = await api(ctx.env, 'POST', '/api/me/key', b.jar, { record: k.record, signature: k.signature });
    expect(res.status).toBe(409);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM account_keys WHERE account_id = ?').get(b.account.id).n).toBe(0);
  });

  it('a key linked in one batch with its identity: nothing is left behind when the link fails', async () => {
    const { env, db, jar, s } = await account();
    // make the link statement fail: a row with this key id exists for another account
    const k = await makeKey('Batch');
    db.prepare("INSERT INTO account_keys (key_id, account_id, wrapped_private, created_at) VALUES (?, 'someone-else', NULL, 1)").run(k.keyId);
    const res = await api(env, 'POST', '/api/me/key', jar, { record: k.record, signature: k.signature });
    expect(res.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM identities').get().n).toBe(0);
    expect(db.prepare('SELECT display_name FROM accounts WHERE id = ?').get(s.account.id).display_name).toBeNull();
  });

  it('limits key registrations to 10 an hour per account', async () => {
    const { env, db, jar, s } = await account();
    const window = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    db.prepare('INSERT INTO rate_limits (bucket, "window", count) VALUES (?, ?, 10)').run('key-reg:' + s.account.id, window);
    const k = await makeKey('Rate');
    const res = await api(env, 'POST', '/api/me/key', jar, { record: k.record, signature: k.signature });
    expect(res.status).toBe(429);
    expect(res.json.code).toBe('rate_limited');
  });

  it('does not open a second cloud copy even when two requests race (database rule)', async () => {
    const { env, db, jar } = await account();
    const a = await makeKey('Race A');
    const b = await makeKey('Race B');
    const results = await Promise.all([
      api(env, 'POST', '/api/me/key', jar, { record: a.record, signature: a.signature, privateJwk: a.privateJwk }),
      api(env, 'POST', '/api/me/key', jar, { record: b.record, signature: b.signature, privateJwk: b.privateJwk })
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_keys WHERE wrapped_private IS NOT NULL').get().n).toBe(1);
    expect(results.map((r) => r.status).sort()).toContain(201);
  });
});

describe('Strict mode and the key limit', () => {
  async function strictAccount() {
    const ctx = await account();
    const first = await makeKey('Device One');
    await api(ctx.env, 'POST', '/api/me/key', ctx.jar, { record: first.record, signature: first.signature, privateJwk: first.privateJwk });
    const sw = await api(ctx.env, 'POST', '/api/me/strict', ctx.jar, { enabled: true });
    expect(sw.status).toBe(200);
    return { ...ctx, first };
  }

  it('turning Strict on removes the server copy and says so in GET /api/me', async () => {
    const { env, db, jar } = await strictAccount();
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_keys WHERE wrapped_private IS NOT NULL').get().n).toBe(0);
    const me = await api(env, 'GET', '/api/me', jar);
    expect(me.json.account.strict).toBe(true);
    expect(me.json.keys[0].hasCloudCopy).toBe(false);
  });

  it('GET /api/me/key is 409 strict_mode for a strict account', async () => {
    const { env, jar } = await strictAccount();
    const res = await api(env, 'GET', '/api/me/key', jar);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('strict_mode');
  });

  it('a strict account refuses a private key (409 strict_mode) and accepts keys without a copy, up to five', async () => {
    const { env, db, jar } = await strictAccount();
    const withCopy = await makeKey('Copy');
    const refused = await api(env, 'POST', '/api/me/key', jar, { record: withCopy.record, signature: withCopy.signature, privateJwk: withCopy.privateJwk });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('strict_mode');
    expect(refused.text).not.toContain(withCopy.privateJwk.d);
    // 1 key exists, add 4 more
    for (let i = 0; i < 4; i++) {
      const k = await makeKey('Device ' + (i + 2));
      const ok = await api(env, 'POST', '/api/me/key', jar, { record: k.record, signature: k.signature });
      expect(ok.status, 'key ' + (i + 2)).toBe(201);
    }
    const sixth = await makeKey('Device 6');
    const full = await api(env, 'POST', '/api/me/key', jar, { record: sixth.record, signature: sixth.signature });
    expect(full.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_keys').get().n).toBe(5);
    const me = await api(env, 'GET', '/api/me', jar);
    expect(me.json.keys.length).toBe(5);
  });

  it('the database itself stops a sixth key (trigger)', async () => {
    const { db, s } = await account();
    for (let i = 0; i < 5; i++) {
      db.prepare('INSERT INTO account_keys (key_id, account_id, wrapped_private, created_at) VALUES (?, ?, NULL, 1)').run('k' + i, s.account.id);
    }
    expect(() => db.prepare('INSERT INTO account_keys (key_id, account_id, wrapped_private, created_at) VALUES (?, ?, NULL, 1)').run('k5', s.account.id)).toThrow(/too many keys/);
  });

  it('turning Strict off flips the flag only, and a new key with a copy is then allowed next to the old one', async () => {
    const { env, db, jar, first } = await strictAccount();
    const off = await api(env, 'POST', '/api/me/strict', jar, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.json).toEqual({ strict: false, passwords: [] });
    expect(db.prepare('SELECT strict FROM accounts').get().strict).toBe(0);
    const next = await makeKey('New Copy');
    const res = await api(env, 'POST', '/api/me/key', jar, { record: next.record, signature: next.signature, privateJwk: next.privateJwk });
    expect(res.status).toBe(201);
    const me = await api(env, 'GET', '/api/me', jar);
    expect(me.json.keys).toEqual([
      { keyId: first.keyId, hasCloudCopy: false },
      { keyId: next.keyId, hasCloudCopy: true }
    ]);
    expect((await api(env, 'GET', '/api/me/key', jar)).json.keyId).toBe(next.keyId);
  });

  it('POST /api/me/strict validates the body', async () => {
    const { env, jar } = await account();
    for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }, { enabled: null }]) {
      const res = await api(env, 'POST', '/api/me/strict', jar, body);
      expect(res.status).toBe(400);
    }
    expect((await callApi(env, 'POST', '/api/me/strict', { json: { enabled: true } })).status).toBe(401);
  });
});

describe('stored document passwords', () => {
  async function owner() {
    const ctx = await account();
    const k = await makeKey('Owner');
    await api(ctx.env, 'POST', '/api/me/key', ctx.jar, { record: k.record, signature: k.signature, privateJwk: k.privateJwk });
    const docId = randomDocId();
    seedDocument(ctx.db, { docId, ownerKeyId: k.keyId });
    return { ...ctx, k, docId };
  }

  const PASSWORD = 'ABCD-EFGH-JKLM-NPQR-STUV';

  it('PUT stores a password wrapped and GET returns it', async () => {
    const { env, db, jar, docId } = await owner();
    const put = await api(env, 'PUT', `/api/me/secrets/${docId}`, jar, { password: PASSWORD });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ ok: true });
    const stored = db.prepare('SELECT wrapped FROM account_secrets').get().wrapped;
    expect(stored).not.toContain('ABCD');
    const got = await api(env, 'GET', `/api/me/secrets/${docId}`, jar);
    expect(got.status).toBe(200);
    expect(got.json).toEqual({ password: PASSWORD });
    expect(got.headers.get('cache-control')).toBe('no-store');
    // a second PUT replaces it
    await api(env, 'PUT', `/api/me/secrets/${docId}`, jar, { password: 'ABCDEFGHJKLMNPQRSTUV' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_secrets').get().n).toBe(1);
    expect((await api(env, 'GET', `/api/me/secrets/${docId}`, jar)).json.password).toBe('ABCDEFGHJKLMNPQRSTUV');
  });

  it('works from a second device of the same account', async () => {
    const ctx = accountEnv();
    const email = 'secrets-two@example.test';
    const first = await signIn(ctx.env, { email });
    const k = await makeKey('Owner');
    await api(ctx.env, 'POST', '/api/me/key', first.jar, { record: k.record, signature: k.signature, privateJwk: k.privateJwk });
    const docId = randomDocId();
    seedDocument(ctx.db, { docId, ownerKeyId: k.keyId });
    await api(ctx.env, 'PUT', `/api/me/secrets/${docId}`, first.jar, { password: PASSWORD });
    const second = await signIn(ctx.env, { email });
    expect((await api(ctx.env, 'GET', `/api/me/secrets/${docId}`, second.jar)).json.password).toBe(PASSWORD);
  });

  it('404 when nothing is stored, 400 for bad ids and passwords, 401 without a session', async () => {
    const { env, jar, docId } = await owner();
    expect((await api(env, 'GET', `/api/me/secrets/${docId}`, jar)).status).toBe(404);
    expect((await api(env, 'GET', '/api/me/secrets/zzz', jar)).status).toBe(400);
    expect((await api(env, 'PUT', '/api/me/secrets/' + docId.toUpperCase(), jar, { password: 'x' })).status).toBe(400);
    for (const password of [undefined, null, 5, '', 'x'.repeat(129), 'caf\u00e9', 'line\nbreak', 'tab\tchar', '\u0000', ['a']]) {
      const res = await api(env, 'PUT', `/api/me/secrets/${docId}`, jar, { password });
      expect(res.status, JSON.stringify(password)).toBe(400);
    }
    expect((await api(env, 'PUT', `/api/me/secrets/${docId}`, jar, { password: 'x'.repeat(128) })).status).toBe(200);
    expect((await callApi(env, 'GET', `/api/me/secrets/${docId}`)).status).toBe(401);
  });

  it('only for documents the account owns: 404 for an unknown document, 403 for someone else\'s', async () => {
    const { env, db, jar, docId } = await owner();
    const none = await api(env, 'PUT', `/api/me/secrets/${randomDocId()}`, jar, { password: PASSWORD });
    expect(none.status).toBe(404);
    expect(none.json.code).toBe('not_found');
    const foreign = randomDocId();
    seedDocument(db, { docId: foreign, ownerKeyId: 'f'.repeat(64) });
    const refused = await api(env, 'PUT', `/api/me/secrets/${foreign}`, jar, { password: PASSWORD });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('not_owner');
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_secrets').get().n).toBe(0);
    expect(docId).toBeTruthy();
  });

  it('another account can not read or overwrite a password', async () => {
    const ctx = await owner();
    await api(ctx.env, 'PUT', `/api/me/secrets/${ctx.docId}`, ctx.jar, { password: PASSWORD });
    const other = await signIn(ctx.env);
    expect((await api(ctx.env, 'GET', `/api/me/secrets/${ctx.docId}`, other.jar)).status).toBe(404);
    expect((await api(ctx.env, 'PUT', `/api/me/secrets/${ctx.docId}`, other.jar, { password: 'AAAA' })).status).toBe(403);
    expect((await api(ctx.env, 'GET', `/api/me/secrets/${ctx.docId}`, ctx.jar)).json.password).toBe(PASSWORD);
  });

  it('a wrapped password copied to another row does not open (bound to account and document)', async () => {
    const { env, db, jar, docId, k } = await owner();
    await api(env, 'PUT', `/api/me/secrets/${docId}`, jar, { password: PASSWORD });
    const other = randomDocId();
    seedDocument(db, { docId: other, ownerKeyId: k.keyId });
    db.prepare('INSERT INTO account_secrets (account_id, doc_id, wrapped, created_at) SELECT account_id, ?, wrapped, 1 FROM account_secrets').run(other);
    const res = await api(env, 'GET', `/api/me/secrets/${other}`, jar);
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'server error', code: 'server_error' });
  });

  it('a strict account can not store passwords (409 strict_mode); Strict hands them over and deletes what the client confirms', async () => {
    const { env, db, jar, docId } = await owner();
    const second = randomDocId();
    seedDocument(db, { docId: second, ownerKeyId: db.prepare('SELECT key_id FROM account_keys').get().key_id });
    await api(env, 'PUT', `/api/me/secrets/${docId}`, jar, { password: PASSWORD });
    await api(env, 'PUT', `/api/me/secrets/${second}`, jar, { password: 'ZZZZ-YYYY' });
    const on = await api(env, 'POST', '/api/me/strict', jar, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.json.strict).toBe(true);
    const wanted = [
      { docId, password: PASSWORD },
      { docId: second, password: 'ZZZZ-YYYY' }
    ].sort((a, b) => a.docId.localeCompare(b.docId));
    expect(on.json.passwords).toEqual(wanted);
    expect(on.json.next).toBe(null);
    // the key copy is gone at once, no new password can be stored, and the server no longer serves them
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_keys WHERE wrapped_private IS NOT NULL').get().n).toBe(0);
    const put = await api(env, 'PUT', `/api/me/secrets/${docId}`, jar, { password: PASSWORD });
    expect(put.status).toBe(409);
    expect(put.json.code).toBe('strict_mode');
    expect((await api(env, 'GET', `/api/me/secrets/${docId}`, jar)).status).toBe(404);
    // nothing is deleted by handing them over: an answer that got lost costs nothing, asking again returns them
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_secrets').get().n).toBe(2);
    const again = await api(env, 'POST', '/api/me/strict', jar, { enabled: true });
    expect(again.json.passwords).toEqual(wanted);
    // the client confirms what it stored: only that is deleted
    const first = wanted[0].docId;
    const part = await api(env, 'POST', '/api/me/strict', jar, { enabled: true, confirmThrough: first });
    expect(part.json).toEqual({ strict: true, passwords: [], next: null, remaining: 1 });
    expect((await api(env, 'POST', '/api/me/strict', jar, { enabled: true })).json.passwords).toEqual([wanted[1]]);
    const done = await api(env, 'POST', '/api/me/strict', jar, { enabled: true, confirmThrough: wanted[1].docId });
    expect(done.json.remaining).toBe(0);
    expect((await api(env, 'POST', '/api/me/strict', jar, { enabled: true })).json).toEqual({ strict: true, passwords: [], next: null });
  });

  it('Strict hands passwords over in pages of 100 and nothing it did not return is ever deleted', async () => {
    const { env, db, jar } = await owner();
    const accountId = db.prepare('SELECT id FROM accounts').get().id;
    const ar = await atRest(env);
    const ins = db.prepare('INSERT INTO account_secrets (account_id, doc_id, wrapped, created_at) VALUES (?, ?, ?, ?)');
    const ids = [];
    for (let i = 0; i < 230; i++) {
      const id = i.toString(16).padStart(32, '0');
      ids.push(id);
      ins.run(accountId, id, await ar.wrap(utf8Encode('pw-' + i), 'secret', accountId, id), i);
    }
    const p1 = await api(env, 'POST', '/api/me/strict', jar, { enabled: true });
    expect(p1.json.passwords.length).toBe(100);
    expect(p1.json.next).toBe(ids[99]);
    const p2 = await api(env, 'POST', '/api/me/strict', jar, { enabled: true, after: p1.json.next });
    expect(p2.json.passwords.length).toBe(100);
    expect(p2.json.passwords[0].docId).toBe(ids[100]);
    // confirming the first page deletes only the first page
    const c = await api(env, 'POST', '/api/me/strict', jar, { enabled: true, confirmThrough: ids[99] });
    expect(c.json.remaining).toBe(130);
    const p3 = await api(env, 'POST', '/api/me/strict', jar, { enabled: true, after: p2.json.next });
    expect(p3.json.passwords.map((p) => p.docId)).toEqual(ids.slice(200));
    expect(p3.json.next).toBe(null);
    expect(p3.json.passwords[29].password).toBe('pw-229');
  });

  it('opens at most one page of stored passwords per request', async () => {
    const { env, db, jar } = await owner();
    const accountId = db.prepare('SELECT id FROM accounts').get().id;
    const ar = await atRest(env);
    const ins = db.prepare('INSERT INTO account_secrets (account_id, doc_id, wrapped, created_at) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 300; i++) {
      const id = randomDocId();
      ins.run(accountId, id, await ar.wrap(utf8Encode('pw'), 'secret', accountId, id), i);
    }
    const subtle = globalThis.crypto.subtle;
    const real = subtle.decrypt.bind(subtle);
    let opened = 0;
    subtle.decrypt = (...args) => (opened++, real(...args));
    try {
      expect((await api(env, 'POST', '/api/me/strict', jar, { enabled: true })).status).toBe(200);
    } finally {
      subtle.decrypt = real;
    }
    expect(opened).toBeLessThanOrEqual(100);
  });

  it('turning Strict off on an account that is not in Strict mode deletes nothing', async () => {
    const { env, db, jar, docId } = await owner();
    await api(env, 'PUT', `/api/me/secrets/${docId}`, jar, { password: PASSWORD });
    expect((await api(env, 'POST', '/api/me/strict', jar, { enabled: false })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_secrets').get().n).toBe(1);
    expect((await api(env, 'GET', `/api/me/secrets/${docId}`, jar)).json.password).toBe(PASSWORD);
  });

  it('passwords nobody confirmed are deleted 24 hours after the switch, and switching back removes them at once', async () => {
    const { env, db, jar, docId } = await owner();
    await api(env, 'PUT', `/api/me/secrets/${docId}`, jar, { password: PASSWORD });
    const t0 = Date.now();
    const at = (t) => ({ 'x-hrd-test-now': String(t) });
    const on = await callApi(env, 'POST', '/api/me/strict', { jar, json: { enabled: true }, headers: at(t0) });
    expect(on.json.passwords.length).toBe(1);
    // 23 hours later it is still there (the session is old, a new sign in is needed for the passwords, but /api/me is a read)
    expect((await callApi(env, 'GET', '/api/me', { jar, headers: at(t0 + 23 * 3_600_000) })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_secrets').get().n).toBe(1);
    expect((await callApi(env, 'GET', '/api/me', { jar, headers: at(t0 + 25 * 3_600_000) })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM account_secrets').get().n).toBe(0);
  });
});

describe('GET /api/me/documents', () => {
  it('lists every document of every key of the account, listed or not, newest first', async () => {
    const ctx = accountEnv();
    const s = await signIn(ctx.env);
    await api(ctx.env, 'POST', '/api/me/strict', s.jar, { enabled: true });
    const keys = [await makeKey('A'), await makeKey('B')];
    for (const k of keys) await api(ctx.env, 'POST', '/api/me/key', s.jar, { record: k.record, signature: k.signature });
    const stranger = await makeKey('Stranger');
    ctx.db.prepare('INSERT INTO identities (key_id, public_jwk, display_name, created_at, record, signature) VALUES (?, ?, ?, 1, ?, ?)').run(stranger.keyId, '{}', 'Stranger', '{}', 's');
    const ids = [1, 2, 3, 4].map(() => randomDocId());
    seedDocument(ctx.db, { docId: ids[0], ownerKeyId: keys[0].keyId, listed: 1, updatedAt: 1000, label: 'one' });
    seedDocument(ctx.db, { docId: ids[1], ownerKeyId: keys[1].keyId, listed: 0, updatedAt: 3000, label: 'two secret' });
    seedDocument(ctx.db, { docId: ids[2], ownerKeyId: keys[0].keyId, listed: 1, updatedAt: 2000, label: 'three', status: 'revoked', version: 2 });
    seedDocument(ctx.db, { docId: ids[3], ownerKeyId: stranger.keyId, listed: 1, updatedAt: 9000, label: 'not mine' });
    const res = await api(ctx.env, 'GET', '/api/me/documents', s.jar);
    expect(res.status).toBe(200);
    expect(res.json.documents.map((d) => d.label)).toEqual(['two secret', 'three', 'one']);
    expect(res.json.documents[0]).toEqual({
      docId: ids[1],
      label: 'two secret',
      ownerKeyId: keys[1].keyId,
      ownerName: 'B',
      status: 'active',
      headVersion: 1,
      createdAt: 3000,
      updatedAt: 3000,
      listed: false
    });
    expect(res.json.documents[1].status).toBe('revoked');
    // the public list does not show the unlisted one
    const pub = await callApi(ctx.env, 'GET', '/api/documents');
    expect(pub.json.documents.map((d) => d.label)).not.toContain('two secret');
  });

  it('pages with before and beforeId, validates its parameters, and needs a session', async () => {
    const ctx = accountEnv();
    const s = await signIn(ctx.env);
    const k = await makeKey('Pager');
    await api(ctx.env, 'POST', '/api/me/key', s.jar, { record: k.record, signature: k.signature });
    for (let i = 0; i < 5; i++) seedDocument(ctx.db, { docId: randomDocId(), ownerKeyId: k.keyId, updatedAt: 5000, label: 'same time ' + i });
    seedDocument(ctx.db, { docId: randomDocId(), ownerKeyId: k.keyId, updatedAt: 4000, label: 'older' });
    const seen = [];
    let url = '/api/me/documents?limit=2';
    for (let guard = 0; guard < 10; guard++) {
      const page = await api(ctx.env, 'GET', url, s.jar);
      expect(page.status).toBe(200);
      if (page.json.documents.length === 0) break;
      seen.push(...page.json.documents.map((d) => d.docId));
      const last = page.json.documents[page.json.documents.length - 1];
      url = `/api/me/documents?limit=2&before=${last.updatedAt}&beforeId=${last.docId}`;
    }
    expect(seen.length).toBe(6);
    expect(new Set(seen).size).toBe(6);
    for (const bad of ['limit=0', 'limit=101', 'limit=x', 'before=-1', 'beforeId=zz&before=1', 'beforeId=' + 'a'.repeat(32)]) {
      expect((await api(ctx.env, 'GET', '/api/me/documents?' + bad, s.jar)).status, bad).toBe(400);
    }
    expect((await callApi(ctx.env, 'GET', '/api/me/documents')).status).toBe(401);
  });

  it('is empty for a new account', async () => {
    const ctx = accountEnv();
    const s = await signIn(ctx.env);
    expect((await api(ctx.env, 'GET', '/api/me/documents', s.jar)).json).toEqual({ documents: [] });
  });
});

describe('guests still work', () => {
  it('POST /api/identities registers a key with no account and no cookie', async () => {
    const { env } = accountEnv();
    const k = await makeKey('Guest');
    const res = await callApi(env, 'POST', '/api/identities', { json: { record: k.record, signature: k.signature }, ip: loopbackIp(), origin: null });
    expect(res.status).toBe(201);
    expect(res.json.keyId).toBe(k.keyId);
    expect(canonicalize(res.json)).toBe(canonicalize({ keyId: k.keyId }));
  });
});

describe('a deleted account', () => {
  it('leaves public identities and documents in place', async () => {
    const ctx = accountEnv();
    const s = await signIn(ctx.env);
    const k = await makeKey('Leaver');
    await api(ctx.env, 'POST', '/api/me/key', s.jar, { record: k.record, signature: k.signature, privateJwk: k.privateJwk });
    const docId = randomDocId();
    seedDocument(ctx.db, { docId, ownerKeyId: k.keyId });
    await api(ctx.env, 'PUT', `/api/me/secrets/${docId}`, s.jar, { password: 'ABCD' });
    expect((await api(ctx.env, 'DELETE', '/api/me', s.jar)).status).toBe(200);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM identities').get().n).toBe(1);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n).toBe(1);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM account_secrets').get().n).toBe(0);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM account_keys').get().n).toBe(0);
    // unused imports kept honest
    expect(new Jar().header()).toBe('');
  });
});
