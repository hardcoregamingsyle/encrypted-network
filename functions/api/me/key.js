// POST /api/me/key  body { record, signature, privateJwk? }  link a signing key to the account
// GET  /api/me/key  the account's server held key, for the "Easy" mode on a new device
//
// POST registers the identity (a self signed 'identity' record, as for POST /api/identities) and links
// it to the account in ONE batch. When privateJwk is sent (Easy accounts only) the server proves that
// it belongs to record.publicKey and keeps it wrapped (AES-GCM under a key derived from
// ACCOUNT_MASTER_KEY). The private key is never logged and never appears in an error.
//
// A key that is already linked to this account and is sent again WITH its private key is either given a
// server copy now (when it has none and the account may have one) or the request is refused: the answer
// 200 always means that the server holds the copy afterwards.
// A key that is registered but linked to no account (its account was deleted, or it was a guest key) can
// be linked by sending its private key: holding the private key is the proof, the public record alone is
// not (anybody can copy a public record).
//
// GET needs a session made in the last 15 minutes (401 reauth_required otherwise: the client asks for a
// new email code), because the key leaves the server in clear.
import { canonicalize } from '../../../shared/canonical.js';
import { utf8Decode, utf8Encode } from '../../../shared/encoding.js';
import { importPrivateJwk, publicJwkFromPrivate, signRecord, verifyRecord } from '../../../shared/keys.js';
import { LIMITS, newNonce } from '../../../shared/records.js';
import { accountKeyRows, authJson, optionalObject, strictModeError } from '../../_lib/accounts.js';
import { atRest } from '../../_lib/atRest.js';
import { ApiError, badRequest, isUniqueConflict } from '../../_lib/errors.js';
import { onlyMethods, rateKeyForRequest, readJson } from '../../_lib/http.js';
import { checkIdentityRecord, loadIdentity } from '../../_lib/identities.js';
import { consumeRate } from '../../_lib/rate.js';
import { requireAuth, requireFresh, requireSameOrigin } from '../../_lib/session.js';
import { assertFresh } from '../../_lib/time.js';

export const MAX_KEYS_PER_ACCOUNT = 5;

const keyExistsError = () => new ApiError('key_exists', 'this account already has a key stored on the server, sign in on this device to use it');
const tooManyKeysError = () => new ApiError('conflict', `an account can have at most ${MAX_KEYS_PER_ACCOUNT} keys`);

// Proves that the private key and the public key are a pair, without keeping either result.
// Returns the private key as a clean JWK with exactly kty, crv, x, y, d.
async function provePair(privateJwk, publicKey) {
  let pub;
  let signer;
  try {
    pub = publicJwkFromPrivate(privateJwk);
    signer = await importPrivateJwk(privateJwk, { extractable: false });
  } catch {
    throw badRequest('the private key is not valid');
  }
  const mismatch = () => badRequest('the private key does not belong to the public key');
  if (pub.x !== publicKey.x || pub.y !== publicKey.y) throw mismatch();
  const probe = { v: 2, type: 'key.probe', nonce: newNonce() };
  let ok = false;
  try {
    ok = await verifyRecord(publicKey, probe, await signRecord(signer, probe));
  } catch {
    ok = false;
  }
  if (!ok) throw mismatch();
  return { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d };
}

// A key that is linked without a server copy, sent again with its private key: keep the copy now, as long
// as the account is in Easy mode and has no other copy. One statement decides, so a race can not store two.
async function storeCopyForLinkedKey(env, ar, auth, keyId, cleanJwk) {
  const accountId = auth.row.id;
  const wrapped = await ar.wrap(utf8Encode(JSON.stringify(cleanJwk)), 'key', accountId, keyId);
  let res;
  try {
    res = await env.DB.prepare(
      'UPDATE account_keys SET wrapped_private = ? WHERE key_id = ? AND account_id = ? AND wrapped_private IS NULL ' +
        'AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND strict = 0)'
    )
      .bind(wrapped, keyId, accountId, accountId)
      .run();
  } catch (err) {
    if (isUniqueConflict(err)) throw keyExistsError();
    throw err;
  }
  if (res.meta && res.meta.changes === 1) return authJson(auth, { keyId, existed: true, stored: true });
  const state = await env.DB.prepare('SELECT strict FROM accounts WHERE id = ?').bind(accountId).first();
  if (state && state.strict === 1) throw strictModeError('a strict account does not keep a copy of its key on the server');
  const now = await env.DB.prepare('SELECT wrapped_private FROM account_keys WHERE key_id = ? AND account_id = ?').bind(keyId, accountId).first();
  if (now && now.wrapped_private !== null) return authJson(auth, { keyId, existed: true });
  throw new ApiError('conflict', 'the key could not be stored, try again');
}

export async function onRequestPost({ request, env }) {
  requireSameOrigin(request);
  const ar = await atRest(env);
  const auth = await requireAuth(env, request);
  const body = await readJson(request);
  const record = optionalObject(body.record, 'record');
  if (record === undefined) throw badRequest('record must be an object');
  if (typeof body.signature !== 'string') throw badRequest('signature must be a string');
  const privateJwk = optionalObject(body.privateJwk, 'privateJwk');
  const strict = auth.row.strict === 1;
  const accountId = auth.row.id;
  if (privateJwk !== undefined && strict) throw strictModeError('a strict account does not keep a copy of its key on the server');

  const { publicKey, keyId } = await checkIdentityRecord(record, body.signature);
  const links = await accountKeyRows(env, accountId);
  const mine = links.find((l) => l.key_id === keyId);

  if (mine) {
    // The same key again (for example a retry after a lost answer).
    if (privateJwk === undefined) return authJson(auth, { keyId, existed: true });
    const clean = await provePair(privateJwk, publicKey);
    if (mine.wrapped_private !== null) return authJson(auth, { keyId, existed: true });
    if (links.some((l) => l.wrapped_private !== null)) throw keyExistsError();
    return storeCopyForLinkedKey(env, ar, auth, keyId, clean);
  }

  if (!strict && links.some((l) => l.wrapped_private !== null)) throw keyExistsError();
  if (links.length >= MAX_KEYS_PER_ACCOUNT) throw tooManyKeysError();

  // A key that is already registered can not be taken over by sending its public record. It can be linked
  // (again) by someone who sends the private key, which is proven below.
  const known = await loadIdentity(env, keyId);
  if (known) {
    if (privateJwk === undefined) throw new ApiError('exists', 'this key is already registered');
    const linked = await env.DB.prepare('SELECT account_id FROM account_keys WHERE key_id = ?').bind(keyId).first();
    if (linked) throw new ApiError('exists', 'this key is already registered');
  } else {
    assertFresh(record.createdAt, LIMITS.RECORD_TIME_WINDOW_MS, auth.now, 'identity');
  }
  await consumeRate(env, 'keyRegister', accountId, auth.now);
  if (!known) {
    await consumeRate(env, 'identity', rateKeyForRequest(request), auth.now);
    await consumeRate(env, 'identityAll', 'all', auth.now);
  }

  let wrapped = null;
  if (privateJwk !== undefined) {
    const clean = await provePair(privateJwk, publicKey);
    wrapped = await ar.wrap(utf8Encode(JSON.stringify(clean)), 'key', accountId, keyId);
  }

  // The link is only made when the identity is there (for a new key: exactly this one), and a server copy
  // of the key is only kept while the account is still in Easy mode (it may have been switched meanwhile).
  const link = (identityTest, ...identityArgs) =>
    env.DB.prepare(
      'INSERT INTO account_keys (key_id, account_id, wrapped_private, created_at) ' +
        'SELECT ?, ?, CASE WHEN (SELECT strict FROM accounts WHERE id = ?) = 0 THEN ? ELSE NULL END, ? ' +
        'WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?) AND EXISTS (SELECT 1 FROM identities WHERE ' + identityTest + ')'
    ).bind(keyId, accountId, accountId, wrapped, auth.now, accountId, ...identityArgs);
  let results;
  try {
    results = await env.DB.batch(
      known
        ? [
            link('key_id = ?', keyId),
            env.DB.prepare('UPDATE accounts SET display_name = (SELECT display_name FROM identities WHERE key_id = ?) WHERE id = ? AND display_name IS NULL').bind(keyId, accountId)
          ]
        : [
            env.DB.prepare(
              'INSERT INTO identities (key_id, public_jwk, display_name, created_at, record, signature) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key_id) DO NOTHING'
            ).bind(keyId, canonicalize(publicKey), record.displayName, record.createdAt, canonicalize(record), body.signature),
            link('key_id = ? AND signature = ?', keyId, body.signature),
            env.DB.prepare('UPDATE accounts SET display_name = ? WHERE id = ? AND display_name IS NULL').bind(record.displayName, accountId)
          ]
    );
  } catch (err) {
    const text = String((err && err.message) || err);
    if (/too many keys/i.test(text)) throw tooManyKeysError();
    if (isUniqueConflict(err)) {
      if (/account_keys\.account_id/.test(text)) throw keyExistsError();
      throw new ApiError('exists', 'this key is already registered');
    }
    throw err;
  }
  const linked = results[known ? 0 : 1];
  if (!linked.meta || linked.meta.changes !== 1) throw new ApiError('exists', 'this key is already registered');
  return authJson(auth, { keyId }, 201);
}

export async function onRequestGet({ request, env }) {
  const ar = await atRest(env);
  const auth = await requireAuth(env, request);
  requireFresh(auth);
  if (auth.row.strict === 1) throw strictModeError();
  const row = await env.DB.prepare(
    'SELECT k.key_id, k.wrapped_private, i.public_jwk, i.record, i.signature FROM account_keys k ' +
      'JOIN identities i ON i.key_id = k.key_id WHERE k.account_id = ? AND k.wrapped_private IS NOT NULL LIMIT 1'
  )
    .bind(auth.row.id)
    .first();
  if (!row) throw new ApiError('not_found', 'no key is stored for this account');
  let privateJwk;
  try {
    privateJwk = JSON.parse(utf8Decode(await ar.unwrap(row.wrapped_private, 'key', auth.row.id, row.key_id)));
  } catch {
    console.error('a stored account key could not be opened');
    throw new ApiError('server_error', 'server error');
  }
  return authJson(
    auth,
    {
      keyId: row.key_id,
      publicKey: JSON.parse(row.public_jwk),
      privateJwk,
      record: JSON.parse(row.record),
      signature: row.signature
    },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

export const onRequest = onlyMethods('GET', 'POST');
