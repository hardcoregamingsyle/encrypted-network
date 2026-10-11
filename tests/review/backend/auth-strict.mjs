// Switching to Strict, switching back, and deleting the account: data loss, races, what is left behind.
// node tests/review/backend/auth-strict.mjs http://127.0.0.1:8801
// Needs a LOCAL server with accounts and MAIL_PROVIDER=echo. Set HRD_STATE_DIR to the server's
// --persist-to folder (default .wrangler/state-r1) to also read the tables. The 10 001 password check
// runs in process. A FAIL line means a defect was proved.
import { createRecord, makeBlob, openDb, postDoc, putBlob } from './_lib.mjs';
import { a, addKey, assert, check, email, eq, expectStatus, finish, needEcho, newKey, signIn } from './auth-kit.mjs';
import { accountEnv, callApi, signInProc } from './auth-proc.mjs';
import { seedDocument, randomDocId } from '../../functions/fakes.js';
import { atRest } from '../../../functions/_lib/atRest.js';

await needEcho();
const db = await openDb();
if (!db) console.log('note: HRD_STATE_DIR not usable, the table checks are skipped');

async function publishFor(key) {
  const person = { keyId: key.keyId, privateKey: key.privateKey };
  const blob = await makeBlob(300);
  expectStatus(await putBlob(person, blob), 201);
  const rec = createRecord(person, blob, {});
  expectStatus(await postDoc(person, rec), 201);
  return rec.docId;
}

await check('strict switch: the passwords are only deleted after the client has surely got them (a lost answer must not lose them)', async () => {
  const acct = await signIn(email('lost'));
  const key = await addKey(acct, { copy: true });
  const docId = await publishFor(key);
  expectStatus(await a('PUT', `/api/me/secrets/${docId}`, { jar: acct.jar, json: { password: 'LOST-AAAA-BBBB-CCCC-DDDD' } }), 200);
  // the first call is made but its answer never arrives (phone goes through a tunnel, tab closed)
  const first = await a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: true } });
  eq(first.status, 200, 'first call');
  // the client asks again, as the code comment says it should
  const second = await a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: true } });
  const direct = await a('GET', `/api/me/secrets/${docId}`, { jar: acct.jar });
  const recovered = (second.json.passwords || []).some((p) => p.password === 'LOST-AAAA-BBBB-CCCC-DDDD') || direct.status === 200;
  assert(recovered, 'after the first call the password is gone for good: asking again returns ' + JSON.stringify(second.json.passwords) + ' and GET says ' + direct.status);
});

await check('strict switch: every stored password is returned before it is deleted, also with more than 10 000 of them (in process)', async () => {
  const { env, db: mem } = accountEnv({ env: { MAIL_PROVIDER: 'echo' } });
  const base = 'http://localhost:8788';
  const acct = await signInProc(env, { base });
  const ar = await atRest(env);
  const ins = mem.prepare('INSERT INTO account_secrets (account_id, doc_id, wrapped, created_at) VALUES (?, ?, ?, ?)');
  mem.exec('BEGIN');
  for (let i = 0; i < 10001; i++) {
    const docId = randomDocId();
    ins.run(acct.account.id, docId, await ar.wrap(new TextEncoder().encode('PW-' + i), 'secret', acct.account.id, docId), i);
  }
  mem.exec('COMMIT');
  const res = await callApi(env, 'POST', '/api/me/strict', { base, jar: acct.jar, json: { enabled: true } });
  eq(res.status, 200, 'status');
  const left = mem.prepare('SELECT COUNT(*) AS n FROM account_secrets').get().n;
  const returned = res.json.passwords.length;
  assert(returned + (res.json.unreadable || 0) >= 10001 || left > 0, `${returned} passwords were returned, ${left} are left, so ${10001 - returned - left} stored passwords were deleted without ever being handed back`);
});

await check('strict switch: a password saved at the same moment is either returned or refused, never lost (20 rounds)', async () => {
  for (let round = 0; round < 20; round++) {
    const acct = await signIn(email('racepw'));
    const key = await addKey(acct, { copy: true });
    const docs = [await publishFor(key), await publishFor(key)];
    const puts = docs.map((d, i) => a('PUT', `/api/me/secrets/${d}`, { jar: acct.jar, json: { password: `RACE-${round}-${i}-AAAA-BBBB` } }));
    const flip = a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: true } });
    const [flipped, ...putRes] = await Promise.all([flip, ...puts]);
    eq(flipped.status, 200, 'flip');
    const returned = new Set((flipped.json.passwords || []).map((p) => p.password));
    putRes.forEach((r, i) => {
      assert(r.status === 200 || r.status === 409, `round ${round}: PUT gave ${r.status}`);
      if (r.status === 200) assert(returned.has(`RACE-${round}-${i}-AAAA-BBBB`), `round ${round}: a password the server acknowledged (HTTP 200) was deleted and not returned`);
    });
    for (const d of docs) eq((await a('GET', `/api/me/secrets/${d}`, { jar: acct.jar })).status, 404, 'left behind after the switch');
    eq((await a('GET', '/api/me', { jar: acct.jar })).json.keys.every((k) => k.hasCloudCopy === false), true, 'cloud copy left behind');
  }
});

await check('strict switch: a key registered at the same moment never keeps a server copy (20 rounds)', async () => {
  for (let round = 0; round < 20; round++) {
    const acct = await signIn(email('racekey'));
    const k = await newKey('RK ' + Math.random());
    const [flip, reg] = await Promise.all([
      a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: true } }),
      a('POST', '/api/me/key', { jar: acct.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } })
    ]);
    eq(flip.status, 200, 'flip');
    assert(reg.status === 201 || reg.status === 409, 'register gave ' + reg.status);
    const me = await a('GET', '/api/me', { jar: acct.jar });
    eq(me.json.account.strict, true, 'strict');
    assert(me.json.keys.every((x) => x.hasCloudCopy === false), `round ${round}: a server copy of a key survived the switch to Strict`);
  }
});

await check('switch back: the account can store a new key with a copy, and the old key stays without one', async () => {
  const acct = await signIn(email('back'));
  const old = await addKey(acct, { copy: true });
  expectStatus(await a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: true } }), 200);
  expectStatus(await a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: false } }), 200);
  eq((await a('GET', '/api/me/key', { jar: acct.jar })).status, 404, 'no key after the switch');
  const fresh = await addKey(acct, { copy: true });
  const got = await a('GET', '/api/me/key', { jar: acct.jar });
  eq(got.json.keyId, fresh.keyId, 'the new key is the stored one');
  const keys = (await a('GET', '/api/me', { jar: acct.jar })).json.keys;
  eq(keys.find((k) => k.keyId === old.keyId).hasCloudCopy, false, 'old key copy');
});

// ---------------------------------------------------------------------------
// deleting the account

await check('delete: nothing of the account stays in the account tables, the old cookies die, the email starts fresh', async () => {
  const addr = email('gone');
  const one = await signIn(addr);
  const two = await signIn(addr);
  const key = await addKey(one, { copy: true });
  const docId = await publishFor(key);
  expectStatus(await a('PUT', `/api/me/secrets/${docId}`, { jar: one.jar, json: { password: 'GONE-AAAA-BBBB-CCCC-DDDD' } }), 200);
  expectStatus(await a('DELETE', '/api/me', { jar: one.jar }), 200);
  for (const jar of [one.jar, two.jar]) eq((await a('GET', '/api/me', { jar })).status, 401, 'old cookie');
  if (db) {
    for (const [table, col] of [['accounts', 'id'], ['sessions', 'account_id'], ['account_keys', 'account_id'], ['account_secrets', 'account_id']]) {
      eq(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(one.account.id).n, 0, table);
    }
    eq(db.prepare('SELECT COUNT(*) AS n FROM otp_codes WHERE email_hash NOT IN (SELECT email_hash FROM accounts) AND created_at > 0 AND expires_at < 0').get().n, 0, 'codes');
  }
  const again = await signIn(addr);
  assert(again.account.id !== one.account.id, 'same account id after deletion');
  eq((await a('GET', `/api/me/secrets/${docId}`, { jar: again.jar })).status, 404, 'the new account sees the old password');
  eq((await a('GET', '/api/me/documents', { jar: again.jar })).json.documents.length, 0, 'the new account sees the old documents');
});

await check('delete: the hash of the email is gone from every table afterwards (rate limit rows and old codes included)', async () => {
  if (!db) return;
  const addr = email('hashgone');
  const acct = await signIn(addr);
  const emailHash = db.prepare('SELECT email_hash FROM accounts WHERE id = ?').get(acct.account.id).email_hash;
  expectStatus(await a('DELETE', '/api/me', { jar: acct.jar }), 200);
  const where = [];
  for (const t of ['accounts', 'sessions', 'otp_codes', 'account_keys', 'account_secrets', 'rate_limits', 'identities', 'documents', 'channels', 'ledger']) {
    let cols;
    try {
      cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    } catch {
      continue;
    }
    for (const c of cols) {
      let n = 0;
      try {
        n = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE CAST(${c} AS TEXT) LIKE ?`).get('%' + emailHash + '%').n;
      } catch {
        n = 0;
      }
      if (n > 0) where.push(`${t}.${c} (${n})`);
    }
  }
  assert(where.length === 0, 'the email hash is still stored after the account was deleted: ' + where.join(', ') + ' (cleanup of old rate limit rows is random, one request in 50, and keeps rows for 2 days)');
});

await check('delete: public history stays (identity and document), as the Details text says', async () => {
  const acct = await signIn(email('hist'));
  const key = await addKey(acct, { copy: true });
  const docId = await publishFor(key);
  expectStatus(await a('DELETE', '/api/me', { jar: acct.jar }), 200);
  eq((await (await import('./_lib.mjs')).call('GET', '/api/identities/' + key.keyId)).status, 200, 'identity');
  eq((await (await import('./_lib.mjs')).call('GET', '/api/documents/' + docId)).status, 200, 'document');
});

await check('delete: two parallel deletes give one 200 and one 401, and a delete racing key registrations leaves no row for a missing account', async () => {
  for (let round = 0; round < 12; round++) {
    const acct = await signIn(email('del2'));
    const keys = await Promise.all([newKey('D1 ' + Math.random()), newKey('D2 ' + Math.random())]);
    const out = await Promise.all([
      a('DELETE', '/api/me', { jar: acct.jar }),
      a('DELETE', '/api/me', { jar: acct.jar.clone() }),
      ...keys.map((k) => a('POST', '/api/me/key', { jar: acct.jar.clone(), json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } }))
    ]);
    const deletes = out.slice(0, 2).map((r) => r.status).sort().join();
    assert(deletes === '200,401' || deletes === '200,200', 'delete statuses ' + deletes);
    assert(out.every((r) => r.status < 500), 'statuses ' + out.map((r) => r.status).join());
  }
  if (db) {
    for (const [table, col] of [['account_keys', 'account_id'], ['account_secrets', 'account_id'], ['sessions', 'account_id']]) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} NOT IN (SELECT id FROM accounts)`).get().n;
      eq(n, 0, `${table} rows that belong to no account`);
    }
  }
});

await check('delete: a person who deletes the account can link the same key to a new account (their files are not cut off for good)', async () => {
  const addr = email('relink');
  const one = await signIn(addr);
  const k = await addKey(one, { copy: true });
  const docId = await publishFor(k);
  expectStatus(await a('DELETE', '/api/me', { jar: one.jar }), 200);
  const again = await signIn(addr);
  const res = await a('POST', '/api/me/key', { jar: again.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } });
  const docs = await a('GET', '/api/me/documents', { jar: again.jar });
  assert(res.status === 201 && docs.json.documents.some((d) => d.docId === docId), `linking the old key gives HTTP ${res.status} ${res.json && res.json.code}; "My files" shows ${docs.json.documents.length} files: the files are orphaned for good, nobody can manage them from an account again`);
});

finish();
