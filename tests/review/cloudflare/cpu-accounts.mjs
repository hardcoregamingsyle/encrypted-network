// Review r5 helper (not a vitest file). Estimates the Worker CPU of the account routes and of the
// busiest older routes, measured on node. Time spent inside the (synchronous, in memory) database stub
// is taken out, because on Cloudflare a D1 call is a network wait and does not count as Worker CPU.
// What stays is JavaScript plus WebCrypto, which is what the free plan limit (10 ms CPU per request)
// is about. Node is not workerd, so read the numbers as an order of magnitude: BoringSSL in workerd
// is in the same range as OpenSSL in node for these small operations.
//
//   node tests/review/cloudflare/cpu-accounts.mjs
import { performance } from 'node:perf_hooks';
import { canonicalize } from '../../../shared/canonical.js';
import { utf8Encode } from '../../../shared/encoding.js';
import { importPrivateJwk, signRecord } from '../../../shared/keys.js';
import { newNonce } from '../../../shared/records.js';
import { Jar, accountEnv, callApi, loopbackIp, makeKey, randomDocId, seedDocument, signIn } from '../../functions/fakes.js';
import { atRest, deriveSubkeys, parseMasterKey, resetAtRestCache } from '../../../functions/_lib/atRest.js';

const ITER = Number(process.env.ITER || 60);

// Wrap the stub database so its time can be subtracted.
function timedEnv(env) {
  const t = { ms: 0 };
  const timed = (fn) =>
    async (...a) => {
      const s = performance.now();
      try {
        return await fn(...a);
      } finally {
        t.ms += performance.now() - s;
      }
    };
  const wrapStmt = (st) => ({
    ...st,
    bind: (...a) => wrapStmt(st.bind(...a)),
    first: timed(() => st.first()),
    all: timed(() => st.all()),
    run: timed(() => st.run())
  });
  const DB = {
    prepare: (sql) => wrapStmt(env.DB.prepare(sql)),
    batch: timed((list) => env.DB.batch(list.map((s) => ({ sql: s.sql, args: s.args, bind: s.bind, first: s.first, all: s.all, run: s.run }))))
  };
  return { env: { ...env, DB }, t };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

// Runs fn(i) ITER times after a warm up. Returns median and p90 of (wall time - database stub time).
// (process.cpuUsage has a 15 ms tick on Windows, so wall time on an otherwise idle node is used.)
async function measure(label, setup, fn, { iterations = ITER, quiet = false } = {}) {
  const cpus = [];
  const wall = [];
  const dbs = [];
  const state = await setup();
  for (let i = -5; i < iterations; i++) {
    const prep = state.prepare ? await state.prepare(i) : null;
    state.t.ms = 0;
    const c0 = process.cpuUsage();
    const w0 = performance.now();
    await fn(state, i, prep);
    const w = performance.now() - w0;
    const c = process.cpuUsage(c0);
    if (i >= 0) {
      void c;
      cpus.push(w - state.t.ms);
      wall.push(w);
      dbs.push(state.t.ms);
    }
  }
  const s = [...cpus].sort((a, b) => a - b);
  const row = { label, medianMs: median(cpus), p90Ms: s[Math.floor(s.length * 0.9)], dbMs: median(dbs) };
  if (!quiet) console.log(label.padEnd(62), 'cpu median', row.medianMs.toFixed(2).padStart(6), 'ms   p90', row.p90Ms.toFixed(2).padStart(6), 'ms   (db stub', row.dbMs.toFixed(2), 'ms)');
  return row;
}

const results = [];
const add = async (...a) => results.push(await measure(...a));

// ---- raw crypto pieces
{
  const master = parseMasterKey(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
  const t0 = performance.now();
  const keys = await deriveSubkeys(master);
  const dt = performance.now() - t0;
  console.log('deriveSubkeys (HKDF x3, once per isolate)'.padEnd(62), dt.toFixed(2), 'ms (first call includes warm up)');
  const times = [];
  for (let i = 0; i < 30; i++) {
    const s = performance.now();
    await deriveSubkeys(master);
    times.push(performance.now() - s);
  }
  console.log('deriveSubkeys warm median'.padEnd(62), median(times).toFixed(3), 'ms');
  void keys;
}

// ---- account routes
const SEED = async () => {
  const ctx = accountEnv();
  const { env, t } = timedEnv(ctx.env);
  return { ...ctx, env, t, raw: ctx.env };
};

await add('POST /api/auth/request (echo, no mail call)', SEED, async (s, i) => {
  s.db.exec('DELETE FROM rate_limits; DELETE FROM otp_codes');
  const r = await callApi(s.env, 'POST', '/api/auth/request', { ip: loopbackIp(), json: { email: `a${i}-${Math.random()}@example.test` } });
  if (r.status !== 200) throw new Error('request ' + r.text);
});

// With a real provider the handler also builds the JSON body and awaits fetch (a network wait, not CPU).
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"id":"x"}', { status: 200 });
  await add('POST /api/auth/request (resend, fetch stubbed)', async () => {
    const ctx = accountEnv({ env: { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM: 'a@b.example' } });
    const { env, t } = timedEnv(ctx.env);
    return { ...ctx, env, t };
  }, async (s, i) => {
    s.db.exec('DELETE FROM rate_limits; DELETE FROM otp_codes');
    const r = await callApi(s.env, 'POST', '/api/auth/request', { ip: '203.0.113.' + (i % 200 + 1), base: 'https://example.pages.dev', json: { email: `a${i}-${Math.random()}@example.test` } });
    if (r.status !== 200) throw new Error('request ' + r.text);
  });
  globalThis.fetch = realFetch;
}

{
  const s0 = await SEED();
  s0.prepare = async (i) => {
    s0.db.exec('DELETE FROM rate_limits');
    const email = `v${i}-${Math.random()}@example.test`;
    const ip = loopbackIp();
    const req = await callApi(s0.raw, 'POST', '/api/auth/request', { ip, json: { email } });
    return { email, ip, code: req.json.debugCode };
  };
  const row = await measure('POST /api/auth/verify (new account, 1 session)', async () => s0, async (s, i, prep) => {
    s.db.exec('DELETE FROM rate_limits');
    const r = await callApi(s.env, 'POST', '/api/auth/verify', { ip: prep.ip, jar: new Jar(), json: { email: prep.email, code: prep.code } });
    if (r.status !== 200) throw new Error('verify ' + r.text);
  });
  results.push(row);
}

// signed in account fixtures
async function signedIn(extra = {}) {
  const ctx = accountEnv();
  const s = await signIn(ctx.env);
  const { env, t } = timedEnv(ctx.env);
  return { ...ctx, env, t, raw: ctx.env, jar: s.jar, s, ...extra };
}

await add('GET /api/me (session check, keys list)', async () => signedIn(), async (st) => {
  const r = await callApi(st.env, 'GET', '/api/me', { jar: st.jar });
  if (r.status !== 200) throw new Error('me ' + r.text);
});

{
  const st = await signedIn();
  st.prepare = async (i) => {
    st.db.exec('DELETE FROM account_keys; DELETE FROM identities; DELETE FROM rate_limits');
    return await makeKey('Priya ' + i, {});
  };
  results.push(await measure('POST /api/me/key (private key import, probe sign+verify, wrap)', async () => st, async (s, i, k) => {
    const r = await callApi(s.env, 'POST', '/api/me/key', { jar: s.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } });
    if (r.status !== 201) throw new Error('key ' + r.text);
  }));
}

{
  const st = await signedIn();
  const k = await makeKey('Priya');
  const r = await callApi(st.raw, 'POST', '/api/me/key', { jar: st.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } });
  if (r.status !== 201) throw new Error('setup ' + r.text);
  results.push(await measure('GET /api/me/key (session, unwrap, 3 JSON parses)', async () => st, async (s) => {
    const x = await callApi(s.env, 'GET', '/api/me/key', { jar: s.jar });
    if (x.status !== 200) throw new Error('get key ' + x.text);
  }));

  // documents and secrets for the same account
  for (let i = 0; i < 100; i++) seedDocument(st.db, { docId: randomDocId(), ownerKeyId: k.keyId, label: 'Document number ' + i, updatedAt: 1000 + i });
  results.push(await measure('GET /api/me/documents (100 rows)', async () => st, async (s) => {
    const x = await callApi(s.env, 'GET', '/api/me/documents?limit=100', { jar: s.jar });
    if (x.status !== 200 || x.json.documents.length !== 100) throw new Error('docs ' + x.text);
  }));
  const docs = st.db.prepare('SELECT doc_id FROM documents').all().map((r) => r.doc_id);
  results.push(await measure('PUT /api/me/secrets/:docId (wrap)', async () => st, async (s, i) => {
    const x = await callApi(s.env, 'PUT', '/api/me/secrets/' + docs[(i + 5) % docs.length], { jar: s.jar, json: { password: 'abcd-efgh-ijkl-mnop-qrst' } });
    if (x.status !== 200) throw new Error('put ' + x.text);
  }));
  results.push(await measure('GET /api/me/secrets/:docId (unwrap)', async () => st, async (s, i) => {
    const x = await callApi(s.env, 'GET', '/api/me/secrets/' + docs[(i + 5) % docs.length], { jar: s.jar });
    if (x.status !== 200) throw new Error('get ' + x.text);
  }));
}

// Strict mode: unwraps every stored password inside one request.
for (const n of [50, 150, 400, 1000, 3000]) {
  const st = await signedIn();
  const k = await makeKey('Priya');
  await callApi(st.raw, 'POST', '/api/me/key', { jar: st.jar, json: { record: k.record, signature: k.signature, privateJwk: k.privateJwk } });
  const ar = await atRest(st.raw);
  const accountId = st.s.account.id;
  const ids = [];
  for (let i = 0; i < n; i++) {
    const docId = randomDocId();
    ids.push(docId);
    const w = await ar.wrap(utf8Encode('abcd-efgh-ijkl-mnop-qrst'), 'secret', accountId, docId);
    st.db.prepare('INSERT INTO account_secrets (account_id, doc_id, wrapped, created_at) VALUES (?, ?, ?, ?)').run(accountId, docId, w, i);
  }
  st.prepare = async () => {
    st.db.exec('DELETE FROM account_secrets');
    for (let i = 0; i < n; i++) {
      const w = await ar.wrap(utf8Encode('abcd-efgh-ijkl-mnop-qrst'), 'secret', accountId, ids[i]);
      st.db.prepare('INSERT INTO account_secrets (account_id, doc_id, wrapped, created_at) VALUES (?, ?, ?, ?)').run(accountId, ids[i], w, i);
    }
    st.db.exec('UPDATE accounts SET strict = 0');
  };
  results.push(await measure(`POST /api/me/strict with ${n} stored passwords`, async () => st, async (s) => {
    const x = await callApi(s.env, 'POST', '/api/me/strict', { jar: s.jar, json: { enabled: true } });
    if (x.status !== 200 || x.json.passwords.length !== n) throw new Error('strict ' + x.text.slice(0, 200));
  }, { iterations: n >= 1000 ? 8 : 20 }));
}

// ---- busiest older paths
{
  const ctx = accountEnv();
  const { env, t } = timedEnv(ctx.env);
  const k = await makeKey('Chatter');
  const ident = await callApi(ctx.env, 'POST', '/api/identities', { ip: loopbackIp(), origin: null, json: { record: k.record, signature: k.signature } });
  if (ident.status !== 201) throw new Error('identity ' + ident.text);
  const st = { ...ctx, env, t };
  const chan = { v: 2, type: 'channel.create', channelId: 'room-' + Math.random().toString(36).slice(2, 10), title: 'Big room', docId: '', signer: k.keyId, createdAt: Date.now() };
  const cs = await signRecord(k.privateKey, chan);
  const cr = await callApi(ctx.env, 'POST', '/api/channels', { origin: null, json: { record: chan, signature: cs } });
  if (cr.status !== 201) throw new Error('channel ' + cr.text);
  // 200 channels with previews, 100 messages in one
  for (let i = 0; i < 199; i++) {
    ctx.db.prepare("INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, received_at, record, signature, message_count, last_message_at, last_text, last_signer_name) VALUES (?, ?, '', ?, ?, ?, '{}', 's', 5, ?, ?, 'Someone')").run('ch-' + i, 'Channel ' + i, k.keyId, 1000 + i, 1000 + i, 2000 + i, 'x'.repeat(140));
  }
  results.push(await measure('GET /api/channels (200 rows with previews)', async () => st, async (s) => {
    const x = await callApi(s.env, 'GET', '/api/channels', {});
    if (x.status !== 200) throw new Error('channels ' + x.text);
  }));
  for (let i = 0; i < 60; i++) {
    const m = { v: 2, type: 'message', channelId: chan.channelId, body: 'hello ' + 'word '.repeat(20) + i, replyTo: '', signer: k.keyId, createdAt: Date.now(), nonce: newNonce() };
    const ms = await signRecord(k.privateKey, m);
    ctx.db.prepare('DELETE FROM rate_limits').run();
    const x = await callApi(ctx.env, 'POST', `/api/channels/${chan.channelId}/messages`, { origin: null, json: { record: m, signature: ms } });
    if (x.status !== 201) throw new Error('msg ' + x.text);
  }
  results.push(await measure('GET /api/channels/:id/messages (50 messages; no server key)', async () => st, async (s) => {
    const x = await callApi(s.env, 'GET', `/api/channels/${chan.channelId}/messages?limit=50`, {});
    if (x.status !== 200) throw new Error('messages ' + x.text);
  }));
  st.prepare = async () => ({
    m: { v: 2, type: 'message', channelId: chan.channelId, body: 'post ' + Math.random(), replyTo: '', signer: k.keyId, createdAt: Date.now(), nonce: newNonce() }
  });
  results.push(await measure('POST message (verify signature, chain hash, batch)', async () => st, async (s, i, prep) => {
    s.db.exec('DELETE FROM rate_limits');
    const sig = await signRecord(k.privateKey, prep.m);
    const x = await callApi(s.env, 'POST', `/api/channels/${chan.channelId}/messages`, { origin: null, json: { record: prep.m, signature: sig } });
    if (x.status !== 201) throw new Error('post ' + x.text);
  }));
}

console.log('');
const risky = results.filter((r) => r.medianMs > 4 || r.p90Ms > 6);
console.log('over 4 ms median or 6 ms p90 (10 ms is the free plan limit):');
for (const r of risky) console.log('  ' + r.label + ': median ' + r.medianMs.toFixed(2) + ' ms, p90 ' + r.p90Ms.toFixed(2) + ' ms');
void canonicalize;
void importPrivateJwk;
void parseMasterKey;
void resetAtRestCache;
