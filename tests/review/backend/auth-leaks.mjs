// What the account endpoints give away: account existence, error details, addresses, headers, logs.
// node tests/review/backend/auth-leaks.mjs http://127.0.0.1:8801
// Needs a LOCAL server with accounts and MAIL_PROVIDER=echo. Set HRD_SERVER_LOG to the server's log file
// to also check what it wrote down. A FAIL line means a defect was proved.
import { existsSync, readFileSync } from 'node:fs';
import { call } from './_lib.mjs';
import { a, addKey, assert, check, email, eq, expectStatus, finish, freshWindow, loop, needEcho, signIn } from './auth-kit.mjs';

await needEcho();

const median = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];

await check('existence: a known and an unknown address get the same answers to a code request and to a wrong code', async () => {
  const t = freshWindow();
  const known = await signIn(email('known'), { now: t });
  const unknown = email('unknown');
  const shape = async (addr, now) => {
    const r1 = await a('POST', '/api/auth/request', { json: { email: addr }, now });
    const wrong = r1.json.debugCode === '000000' ? '111111' : '000000';
    const r2 = await a('POST', '/api/auth/verify', { json: { email: addr, code: wrong }, now: now + 1000 });
    const r3 = await a('POST', '/api/auth/request', { json: { email: addr }, now: now + 2000 });
    return [r1.status, Object.keys(r1.json).sort().join(), r2.status, r2.json.code, r2.json.error, r3.status, r3.json.code, Object.keys(r3.headers).length > 0].join('|');
  };
  eq(await shape(known.email, t + 100000), await shape(unknown, t + 100000), 'answers');
});

await check('existence: the time a code request and a wrong code take does not depend on whether the address has an account (60 each, interleaved)', async () => {
  const t0 = freshWindow();
  const known = await signIn(email('tk'), { now: t0 });
  const times = { kreq: [], ureq: [], kver: [], uver: [] };
  for (let i = 0; i < 60; i++) {
    const now = freshWindow();
    const unknown = email('tu');
    let s = performance.now();
    await a('POST', '/api/auth/request', { json: { email: known.email }, now });
    times.kreq.push(performance.now() - s);
    s = performance.now();
    await a('POST', '/api/auth/request', { json: { email: unknown }, now });
    times.ureq.push(performance.now() - s);
    s = performance.now();
    await a('POST', '/api/auth/verify', { json: { email: known.email, code: '000001' }, now: now + 1000 });
    times.kver.push(performance.now() - s);
    s = performance.now();
    await a('POST', '/api/auth/verify', { json: { email: unknown, code: '000001' }, now: now + 1000 });
    times.uver.push(performance.now() - s);
  }
  const m = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, median(v)]));
  const close = (x, y) => Math.abs(x - y) <= Math.max(4, 0.25 * Math.max(x, y));
  assert(close(m.kreq, m.ureq) && close(m.kver, m.uver), `medians in ms: request known ${m.kreq.toFixed(1)} unknown ${m.ureq.toFixed(1)}, wrong code known ${m.kver.toFixed(1)} unknown ${m.uver.toFixed(1)}`);
});

await check('errors: 60 hostile requests across the account routes never show a stack, a path, SQL, a table name or a secret name', async () => {
  const acct = await signIn(email('err'));
  await addKey(acct, { copy: true });
  const docId = 'f'.repeat(32);
  const bodies = [undefined, '{}', 'null', '[]', '{"email":5}', '{"record":5}', '{"record":{},"signature":"x"}', '{"enabled":"yes"}', '{"password":{"a":1}}', '\u0000', '{'.repeat(500), '{"a":"' + 'x'.repeat(70000) + '"}'];
  const routes = [['POST', '/api/auth/request'], ['POST', '/api/auth/verify'], ['POST', '/api/me/key'], ['POST', '/api/me/strict'], ['PUT', `/api/me/secrets/${docId}`]];
  const seen = [];
  for (const [m, p] of routes) {
    for (const raw of bodies) {
      const res = await a(m, p, { jar: acct.jar, raw, headers: { 'Content-Type': 'application/json' } });
      seen.push([m + ' ' + p, res]);
    }
  }
  for (const p of ['/api/me/secrets/zz', '/api/me/secrets/' + '%00', '/api/me/documents?limit=x', '/api/me/documents?before=x', '/api/auth', '/api/me/nothing', '/api/auth/nothing']) seen.push(['GET ' + p, await a('GET', p, { jar: acct.jar })]);
  const forbidden = /\bat [\w$.<>]+ \(|\.js:\d+|node_modules|workerd|miniflare|SQLITE|D1_|syntax error|constraint failed|no such (table|column)|account_(keys|secrets)|otp_codes|rate_limits|ACCOUNT_MASTER_KEY|MAIL_PROVIDER|RESEND|BREVO|SERVER_SIGNING|stack|TypeError|ReferenceError/i;
  for (const [what, res] of seen) {
    assert(res.status < 500, `${what} gave HTTP ${res.status}: ${res.text.slice(0, 100)}`);
    assert(!forbidden.test(res.text), `${what} shows internals: ${res.text.slice(0, 160)}`);
    if (res.status >= 400) assert(res.json && Object.keys(res.json).sort().join() === 'code,error', `${what}: body is not { error, code }: ${res.text.slice(0, 100)}`);
  }
});

await check('headers: no server banner, no powered-by, nosniff, frame deny, no-referrer on account answers', async () => {
  const acct = await signIn(email('hdr'));
  for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/me/key'], ['POST', '/api/auth/request'], ['GET', '/api/health']]) {
    const res = await a(m, p, { jar: acct.jar, json: m === 'POST' ? { email: email('h') } : undefined });
    for (const bad of ['x-powered-by', 'server', 'x-aspnet-version', 'x-debug', 'x-request-id']) assert(!res.headers.get(bad), `${p}: header ${bad} = ${res.headers.get(bad)}`);
    eq(res.headers.get('x-content-type-options'), 'nosniff', p + ' nosniff');
    eq(res.headers.get('x-frame-options'), 'DENY', p + ' frame');
    eq(res.headers.get('referrer-policy'), 'no-referrer', p + ' referrer');
  }
});

await check('addresses: the full address appears in no answer of any account route, only the masked form', async () => {
  const addr = `distinct-${Math.random().toString(36).slice(2, 10)}@example.test`;
  const acct = await signIn(addr);
  await addKey(acct, { copy: true });
  const texts = [];
  for (const [m, p, json] of [['GET', '/api/me'], ['GET', '/api/me/key'], ['GET', '/api/me/documents'], ['POST', '/api/me/strict', { enabled: true }], ['POST', '/api/me/strict', { enabled: false }], ['GET', '/api/health']]) {
    texts.push((await a(m, p, { jar: acct.jar, json })).text);
  }
  texts.push((await a('POST', '/api/auth/request', { json: { email: addr }, now: freshWindow() })).text);
  texts.push((await a('POST', '/api/auth/request', { json: { email: addr } })).text);
  texts.push((await a('POST', '/api/auth/verify', { json: { email: addr, code: '000001' } })).text);
  const local = addr.split('@')[0];
  for (const t of texts) assert(!t.includes(addr) && !t.includes(local), 'the address is in an answer: ' + t.slice(0, 120));
  eq((await a('GET', '/api/me', { jar: acct.jar })).json.account.emailMasked, local.slice(0, 2) + '***@example.test', 'masked form');
});

await check('addresses: other people never see an email or an account id (public identity, document and channel answers)', async () => {
  const addr = `public-${Math.random().toString(36).slice(2, 10)}@example.test`;
  const acct = await signIn(addr);
  const k = await addKey(acct, { copy: true, name: 'Public Name' });
  const body = (await call('GET', '/api/identities/' + k.keyId)).text + (await call('GET', '/api/documents?limit=5')).text + (await call('GET', '/api/channels')).text;
  assert(!body.includes(addr) && !body.includes(acct.account.id) && !body.includes(addr.split('@')[0]), 'private data in public answers');
});

await check('log: the server wrote no address, code, session token or private key into its log (needs HRD_SERVER_LOG)', async () => {
  const file = process.env.HRD_SERVER_LOG;
  if (!file || !existsSync(file)) {
    console.log('  (skipped: set HRD_SERVER_LOG to the server log file)');
    return;
  }
  const log = readFileSync(file, 'utf8');
  assert(!/@example\.test/.test(log), 'an address is in the log');
  assert(!/hrd_session=[A-Za-z0-9_-]{43}/.test(log), 'a session cookie is in the log');
  assert(!/"d":"[A-Za-z0-9_-]{43}"/.test(log) && !/debugCode/.test(log), 'a key or a code is in the log');
  assert(!/atk-/.test(log), 'a test address is in the log');
});

await check('routes: unknown paths under /api/auth and /api/me are JSON 404, wrong verbs are 405 with Allow, nothing falls through to the app page', async () => {
  for (const p of ['/api/auth', '/api/auth/', '/api/auth/nothing', '/api/me/nothing', '/api/me/secrets', '/api/me/secrets/', '/api/me/key/extra', '/api/auth/REQUEST']) {
    const res = await a('GET', p, { ip: loop() });
    assert(res.status === 404 || res.status === 405 || res.status === 308 || res.status === 301, `${p} gave HTTP ${res.status}`);
    assert(!/<html/i.test(res.text), `${p} answered with the app page`);
  }
  for (const [m, p] of [['PUT', '/api/auth/request'], ['GET', '/api/auth/verify'], ['PATCH', '/api/me'], ['DELETE', '/api/me/key'], ['POST', '/api/me/documents'], ['GET', '/api/me/strict'], ['POST', '/api/me/secrets/' + 'a'.repeat(32)]]) {
    const res = await a(m, p, { json: m === 'GET' ? undefined : {} });
    eq(res.status, 405, `${m} ${p}`);
    assert(res.headers.get('allow'), `${m} ${p}: no Allow header`);
  }
  expectStatus(await a('GET', '/api/health'), 200);
});

finish();
