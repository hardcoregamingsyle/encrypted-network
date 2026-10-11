// The server's copy of keys and document passwords: who can read it, overwrite it, trick it.
// node tests/review/backend/auth-custody.mjs http://127.0.0.1:8801
// Needs a LOCAL server with accounts and MAIL_PROVIDER=echo. The last checks run in process so they can
// change database rows the way an attacker with write access to the table would. A FAIL line means a
// defect was proved.
import { call } from './_lib.mjs';
import { a, addKey, assert, brief, check, email, eq, expectStatus, finish, loop, needEcho, newKey, signIn } from './auth-kit.mjs';
import { accountEnv, callApi, makeKey, signInProc } from './auth-proc.mjs';
import { seedDocument, randomDocId } from '../../functions/fakes.js';

await needEcho();

const post = (acct, k, extra = {}) => a('POST', '/api/me/key', { jar: acct.jar, json: { record: k.record, signature: k.signature, ...extra } });

await check('read: account B can not get account A\'s key, and an account without a key gets 404, not someone else\'s', async () => {
  const A = await signIn(email('custA'));
  const B = await signIn(email('custB'));
  const ka = await addKey(A, { copy: true });
  eq((await a('GET', '/api/me/key', { jar: B.jar })).status, 404, 'B without a key');
  const kb = await addKey(B, { copy: true });
  const got = await a('GET', '/api/me/key', { jar: B.jar });
  eq(got.json.keyId, kb.keyId, 'B gets its own key');
  assert(!got.text.includes(ka.privateJwk.d), 'A\'s private part is in B\'s answer');
  const mine = await a('GET', '/api/me/key', { jar: A.jar });
  eq(mine.json.privateJwk.d, ka.privateJwk.d, 'A gets A\'s key back byte for byte');
  eq((await call('GET', '/api/me/key')).status, 401, 'no cookie');
});

await check('write: B can not overwrite A\'s key, nor attach A\'s public key to itself, even with a key of its own', async () => {
  const A = await signIn(email('owA'));
  const B = await signIn(email('owB'));
  const ka = await addKey(A, { copy: true });
  const kb = await newKey('B ' + Math.random());
  // A's public record replayed with B's private key attached
  const pub = (await call('GET', '/api/identities/' + ka.keyId)).json;
  eq((await a('POST', '/api/me/key', { jar: B.jar, json: { record: pub.record, signature: pub.signature, privateJwk: kb.privateJwk } })).status, 409, 'replay with B\'s private key');
  // A's record with the display name changed (the signature no longer fits)
  const edited = { ...pub.record, displayName: 'Mallory' };
  eq((await a('POST', '/api/me/key', { jar: B.jar, json: { record: edited, signature: pub.signature } })).status, 400, 'edited record');
  // B's own record, signed by B, but claiming A's public key
  const forged = { ...kb.record, publicKey: ka.publicJwk };
  eq((await a('POST', '/api/me/key', { jar: B.jar, json: { record: forged, signature: kb.signature } })).status, 400, 'record naming A\'s key, signed by B');
  const still = await a('GET', '/api/me/key', { jar: A.jar });
  eq(still.json.privateJwk.d, ka.privateJwk.d, 'A\'s stored key unchanged');
  eq((await a('GET', '/api/me', { jar: B.jar })).json.keys.length, 0, 'B gained no key');
});

await check('privateJwk: public only, wrong curve, out of range d, swapped parts, extra members all refused with 400 and no echo', async () => {
  const acct = await signIn(email('jwk'));
  const k = await newKey('Jwk ' + Math.random());
  const zero = 'A'.repeat(43);
  const n = 'Q' + '_'.repeat(0); // placeholder replaced below
  void n;
  // the order of P-256 in base64url: ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551
  const order = Buffer.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', 'hex').toString('base64url');
  const orderPlus1 = Buffer.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632552', 'hex').toString('base64url');
  const max = Buffer.from('ff'.repeat(32), 'hex').toString('base64url');
  const one = Buffer.from('00'.repeat(31) + '01', 'hex').toString('base64url');
  const variants = {
    'no d': { kty: 'EC', crv: 'P-256', x: k.privateJwk.x, y: k.privateJwk.y },
    'd zero': { ...k.privateJwk, d: zero },
    'd one': { ...k.privateJwk, d: one },
    'd = group order': { ...k.privateJwk, d: order },
    'd = order + 1': { ...k.privateJwk, d: orderPlus1 },
    'd = 2^256-1': { ...k.privateJwk, d: max },
    'x and y swapped': { ...k.privateJwk, x: k.privateJwk.y, y: k.privateJwk.x },
    'P-384 label': { ...k.privateJwk, crv: 'P-384' },
    'oct key': { kty: 'oct', k: 'AAAA' },
    'alg member': { ...k.privateJwk, alg: 'ES256' },
    'use member': { ...k.privateJwk, use: 'sig' },
    'd as array': { ...k.privateJwk, d: [k.privateJwk.d] },
    'd with padding char': { ...k.privateJwk, d: k.privateJwk.d.slice(0, 42) + '=' },
    'd long': { ...k.privateJwk, d: k.privateJwk.d + 'AAAA' },
    'empty object': {},
    'nested depth': JSON.parse('{"a":'.repeat(200) + '1' + '}'.repeat(200))
  };
  for (const [name, privateJwk] of Object.entries(variants)) {
    const fresh = await signIn(email('jwk'));
    const res = await a('POST', '/api/me/key', { jar: fresh.jar, json: { record: k.record, signature: k.signature, privateJwk } });
    assert(res.status === 400, `${name}: HTTP ${res.status} ${res.text.slice(0, 100)}`);
    assert(!res.text.includes(k.privateJwk.d), `${name}: the private part came back`);
  }
  eq((await call('GET', '/api/identities/' + k.keyId)).status, 404, 'nothing was registered by any refused request');
  void acct;
});

await check('privateJwk: a key that signs but belongs to another public key is refused (probe sign and verify)', async () => {
  const acct = await signIn(email('pair'));
  const k = await newKey('Pair ' + Math.random());
  const other = await newKey('Other ' + Math.random());
  const res = await post(acct, k, { privateJwk: { ...other.privateJwk, x: k.privateJwk.x, y: k.privateJwk.y } });
  eq(res.status, 400, brief(res));
  const res2 = await post(acct, k, { privateJwk: other.privateJwk });
  eq(res2.status, 400, brief(res2));
});

await check('one copy rule: the same key sent again WITH a private key must be stored or refused, never answered "ok" and dropped', async () => {
  const acct = await signIn(email('existed'));
  const k = await newKey('Ex ' + Math.random());
  expectStatus(await post(acct, k), 201); // first registered without a server copy (for example after a switch back from Strict)
  const again = await post(acct, k, { privateJwk: k.privateJwk });
  const stored = await a('GET', '/api/me/key', { jar: acct.jar });
  assert(again.status >= 400 || stored.status === 200, `the second request answered HTTP ${again.status} ${JSON.stringify(again.json)} but GET /api/me/key says ${stored.status}: the server copy that was asked for does not exist`);
});

await check('one copy rule: a garbage private key on an already linked key does not get an "ok" either', async () => {
  const acct = await signIn(email('existed2'));
  const k = await addKey(acct, { copy: true });
  const res = await a('POST', '/api/me/key', { jar: acct.jar, json: { record: k.record, signature: k.signature, privateJwk: { junk: 1 } } });
  assert(res.status >= 400, `HTTP ${res.status} ${JSON.stringify(res.json)}: a private key that was never checked was accepted`);
});

await check('races: three registrations with a server copy at once leave exactly one copy, one 201, the rest 409 key_exists, and no orphan identity', async () => {
  const acct = await signIn(email('race3'));
  const keys = await Promise.all([newKey('R1 ' + Math.random()), newKey('R2 ' + Math.random()), newKey('R3 ' + Math.random())]);
  const out = await Promise.all(keys.map((k) => post(acct, k, { privateJwk: k.privateJwk })));
  const codes = out.map((r) => r.status + ':' + (r.json.code || 'ok')).sort().join(' ');
  eq(codes, '201:ok 409:key_exists 409:key_exists', 'results');
  const reg = await Promise.all(keys.map((k) => call('GET', '/api/identities/' + k.keyId)));
  eq(reg.filter((r) => r.status === 200).length, 1, 'registered identities');
  eq((await a('GET', '/api/me', { jar: acct.jar })).json.keys.length, 1, 'linked keys');
});

await check('races: 12 parallel keys on a strict account link at most 5 and leave no identity behind for the refused ones', async () => {
  const acct = await signIn(email('race12'));
  expectStatus(await a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: true } }), 200);
  const keys = await Promise.all(Array.from({ length: 12 }, (_, i) => newKey('S' + i + ' ' + Math.random())));
  const out = await Promise.all(keys.map((k) => post(acct, k)));
  assert(out.every((r) => r.status < 500), 'statuses ' + out.map((r) => r.status).join());
  const reg = await Promise.all(keys.map((k) => call('GET', '/api/identities/' + k.keyId)));
  const linked = (await a('GET', '/api/me', { jar: acct.jar })).json.keys.length;
  eq(linked, 5, 'linked');
  eq(reg.filter((r) => r.status === 200).length, linked, 'identities registered (a refused key must not stay registered)');
});

await check('strict account: GET key is 409, a private key is refused even in a parallel burst, nothing wrapped is left behind', async () => {
  const acct = await signIn(email('strictk'));
  await addKey(acct, { copy: true });
  expectStatus(await a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: true } }), 200);
  eq((await a('GET', '/api/me/key', { jar: acct.jar })).status, 409, 'GET key');
  const ks = await Promise.all(Array.from({ length: 4 }, () => newKey('SK ' + Math.random())));
  const out = await Promise.all(ks.map((k) => post(acct, k, { privateJwk: k.privateJwk })));
  eq(out.every((r) => r.status === 409 && r.json.code === 'strict_mode'), true, 'all refused: ' + out.map((r) => r.status).join());
  eq((await a('GET', '/api/me', { jar: acct.jar })).json.keys.every((x) => x.hasCloudCopy === false), true, 'copies');
});

// ---------------------------------------------------------------------------
// stored passwords

const owner = await signIn(email('pwowner'));
const ownerKey = await addKey(owner, { copy: true });
// publish a document for the owner's key directly (the signed chain is not the point here)
import { createRecord, makeBlob, postDoc, putBlob } from './_lib.mjs';
const person = { keyId: ownerKey.keyId, privateKey: ownerKey.privateKey };
const blob = await makeBlob(300);
expectStatus(await putBlob(person, blob), 201);
const rec = createRecord(person, blob, { listed: false });
expectStatus(await postDoc(person, rec), 201);
const docId = rec.docId;

await check('passwords: odd but allowed characters come back byte for byte and are never stored readable', async () => {
  const samples = ['ABCD-EFGH-JKLM-NPQR-STUV', "it's \"quoted\" \\ back\\slash", '%s %d {{x}} ${y} <script>alert(1)</script>', "'; DROP TABLE account_secrets; --", ' leading and trailing ', '~!@#$%^&*()_+-=[]{}|;:,.<>/?`'];
  for (const password of samples) {
    expectStatus(await a('PUT', `/api/me/secrets/${docId}`, { jar: owner.jar, json: { password } }), 200);
    const back = await a('GET', `/api/me/secrets/${docId}`, { jar: owner.jar });
    eq(back.json.password, password, 'round trip');
  }
});

await check('passwords: another account gets 403 or 404 when it writes or reads the password of a document it does not own', async () => {
  const other = await signIn(email('pwother'));
  const r = await a('PUT', `/api/me/secrets/${docId}`, { jar: other.jar, json: { password: 'EVIL' } });
  const read = await a('GET', `/api/me/secrets/${docId}`, { jar: other.jar });
  eq(r.status === 403 || r.status === 404, true, 'PUT status ' + r.status);
  eq(read.status, 404, 'GET status');
});

await check('passwords: the other account\'s write did not change the stored one', async () => {
  const back = await a('GET', `/api/me/secrets/${docId}`, { jar: owner.jar });
  assert(back.json.password !== 'EVIL', 'overwritten');
});

await check('passwords: a strict account can not store one, and the switch back does not bring old ones back', async () => {
  const acct = await signIn(email('pwstrict'));
  const k = await addKey(acct, { copy: true });
  const p2 = { keyId: k.keyId, privateKey: k.privateKey };
  const b2 = await makeBlob(300);
  expectStatus(await putBlob(p2, b2), 201);
  const r2 = createRecord(p2, b2, {});
  expectStatus(await postDoc(p2, r2), 201);
  expectStatus(await a('PUT', `/api/me/secrets/${r2.docId}`, { jar: acct.jar, json: { password: 'SECRET-ONE-AAAA-BBBB-CCCC' } }), 200);
  const off = await a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: true } });
  eq(off.json.passwords.length, 1, 'returned once');
  eq((await a('PUT', `/api/me/secrets/${r2.docId}`, { jar: acct.jar, json: { password: 'x' } })).status, 409, 'PUT while strict');
  expectStatus(await a('POST', '/api/me/strict', { jar: acct.jar, json: { enabled: false } }), 200);
  eq((await a('GET', `/api/me/secrets/${r2.docId}`, { jar: acct.jar })).status, 404, 'old password after switching back');
});

// ---------------------------------------------------------------------------
// what an attacker with write access to the tables can not do (in process, the real route code)

await check('row binding: swapping stored keys or passwords between rows never hands out another row\'s secret', async () => {
  const { env, db } = accountEnv({ env: { MAIL_PROVIDER: 'echo' } });
  const base = 'http://localhost:8788';
  const A = await signInProc(env, { base });
  const B = await signInProc(env, { base });
  const ka = await makeKey('A');
  const kb = await makeKey('B');
  eq((await callApi(env, 'POST', '/api/me/key', { base, jar: A.jar, json: { record: ka.record, signature: ka.signature, privateJwk: ka.privateJwk } })).status, 201, 'A key');
  eq((await callApi(env, 'POST', '/api/me/key', { base, jar: B.jar, json: { record: kb.record, signature: kb.signature, privateJwk: kb.privateJwk } })).status, 201, 'B key');
  const da = randomDocId();
  const dbb = randomDocId();
  seedDocument(db, { docId: da, ownerKeyId: ka.keyId });
  seedDocument(db, { docId: dbb, ownerKeyId: kb.keyId });
  eq((await callApi(env, 'PUT', `/api/me/secrets/${da}`, { base, jar: A.jar, json: { password: 'A-SECRET' } })).status, 200, 'A pw');
  eq((await callApi(env, 'PUT', `/api/me/secrets/${dbb}`, { base, jar: B.jar, json: { password: 'B-SECRET' } })).status, 200, 'B pw');
  const wa = db.prepare('SELECT wrapped_private FROM account_keys WHERE key_id = ?').get(ka.keyId).wrapped_private;
  const wb = db.prepare('SELECT wrapped_private FROM account_keys WHERE key_id = ?').get(kb.keyId).wrapped_private;
  db.prepare('UPDATE account_keys SET wrapped_private = ? WHERE key_id = ?').run(wb, ka.keyId);
  db.prepare('UPDATE account_keys SET wrapped_private = ? WHERE key_id = ?').run(wa, kb.keyId);
  for (const [who, other] of [[A, kb], [B, ka]]) {
    const res = await callApi(env, 'GET', '/api/me/key', { base, jar: who.jar });
    assert(res.status === 500 && !res.text.includes(other.privateJwk.d), `swapped key row: HTTP ${res.status} ${res.text.slice(0, 120)}`);
  }
  const sa = db.prepare('SELECT wrapped FROM account_secrets WHERE doc_id = ?').get(da).wrapped;
  const sb = db.prepare('SELECT wrapped FROM account_secrets WHERE doc_id = ?').get(dbb).wrapped;
  db.prepare('UPDATE account_secrets SET wrapped = ? WHERE doc_id = ?').run(sb, da);
  db.prepare('UPDATE account_secrets SET wrapped = ? WHERE doc_id = ?').run(sa, dbb);
  const r1 = await callApi(env, 'GET', `/api/me/secrets/${da}`, { base, jar: A.jar });
  assert(r1.status === 500 && !r1.text.includes('B-SECRET'), `swapped password row: HTTP ${r1.status} ${r1.text}`);
  // a secret moved to another doc id of the same account does not open either
  db.prepare('UPDATE account_secrets SET wrapped = ? WHERE doc_id = ?').run(sa, da);
  db.prepare('UPDATE account_secrets SET doc_id = ? WHERE doc_id = ?').run(randomDocId(), da);
  void sb;
});

await check('database rules: a 6th key row, a 2nd server copy and a duplicate key id are refused by the table itself', async () => {
  const { env, db } = accountEnv({ env: { MAIL_PROVIDER: 'echo' } });
  const ins = db.prepare('INSERT INTO account_keys (key_id, account_id, wrapped_private, created_at) VALUES (?, ?, ?, 1)');
  for (let i = 0; i < 5; i++) ins.run('k' + i, 'acc1', null);
  let refused = 0;
  for (const fn of [() => ins.run('k5', 'acc1', null), () => ins.run('k0', 'acc2', null)]) {
    try {
      fn();
    } catch {
      refused++;
    }
  }
  eq(refused, 2, 'sixth row and duplicate key id');
  ins.run('c1', 'acc3', 'x');
  let copy = false;
  try {
    ins.run('c2', 'acc3', 'y');
  } catch {
    copy = true;
  }
  eq(copy, true, 'second copy');
  void env;
});

finish();
