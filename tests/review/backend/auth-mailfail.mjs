// The mail provider side of sign in: failures, slowness, hostile input, hostile settings, and the echo guard.
// node tests/review/backend/auth-mailfail.mjs [ignored base url]
// Runs in process against the real route files with a stubbed provider (nothing goes over the network).
// A FAIL line means a defect was proved.
import { assert, check, eq, finish } from './_lib.mjs';
import { SITE, callApi, frozenClock, installMailStub, providerEnv, publicIp, accountEnv } from './auth-proc.mjs';
import { sendMail, codeEmail, mailMode, configuredProvider } from '../../../functions/_lib/mail.js';

frozenClock();
const stub = installMailStub();
const realError = console.error;
const logged = [];
console.error = (...args) => logged.push(args.join(' '));
const ask = (env, address, ip = publicIp(), o = {}) => callApi(env, 'POST', '/api/auth/request', { base: o.base || SITE, ip, json: { email: address }, headers: o.headers });
const setAnswer = (fn) => {
  stub.restore();
  Object.assign(stub, installMailStub(fn));
};

await check('provider outage: a person must not lose their 5 codes per hour to mails that never left', async () => {
  const { env } = providerEnv('resend');
  setAnswer(() => new Response('upstream says: key re_test_key is over quota for bob@example.test', { status: 500 }));
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push((await ask(env, 'bob@example.test', '203.0.113.5')).status);
  eq(seen.join(), '502,502,502,502,502', 'during the outage');
  setAnswer();
  const after = await ask(env, 'bob@example.test', '203.0.113.6');
  assert(after.status === 200, `the provider is back, the person asks once and gets HTTP ${after.status} ${after.json && after.json.code}`);
});

await check('provider outage: refused sends must not use up the service wide cap or the address limit of everybody else', async () => {
  const { env } = providerEnv('resend');
  setAnswer(() => new Response('', { status: 503 }));
  for (let s = 0; s < 21; s++) {
    const ip = publicIp();
    for (let i = 0; i < 20; i++) await ask(env, `p${s}x${i}@example.test`, ip);
  }
  setAnswer();
  const after = await ask(env, 'someone-else@example.test', publicIp());
  assert(after.status === 200, `after 400 sends that the provider refused, a new person gets HTTP ${after.status} ${after.json && after.json.code}`);
});

await check('provider failure: no code stays valid for a mail that was not sent', async () => {
  const { env, db } = providerEnv('resend');
  setAnswer(() => new Response('nope', { status: 500 }));
  eq((await ask(env, 'dead@example.test')).status, 502, 'status');
  eq(db.prepare('SELECT COUNT(*) AS n FROM otp_codes').get().n, 0, 'codes left in the table');
});

await check('provider failure: the provider\'s own words, the key and the address never reach the client or the log', async () => {
  const { env } = providerEnv('resend');
  logged.length = 0;
  setAnswer(() => new Response('upstream says: key re_test_key is over quota for leak@example.test', { status: 422 }));
  const res = await ask(env, 'leak@example.test');
  const everything = res.text + JSON.stringify([...res.headers]) + logged.join('\n');
  assert(!/upstream|re_test_key|leak@example|quota/.test(everything), 'provider text leaked: ' + everything.slice(0, 200));
  eq(res.json.code, 'mail_failed', 'code');
});

await check('provider: a code never appears in a log line, and the address and code are only sent to the provider', async () => {
  const { env } = providerEnv('resend');
  logged.length = 0;
  setAnswer();
  stub.calls.length = 0;
  const res = await ask(env, 'quiet@example.test');
  eq(res.status, 200, 'status');
  assert(!('debugCode' in res.json), 'debugCode in a real mail answer');
  const code = stub.calls[0].code;
  assert(code && !res.text.includes(code), 'the code is in the answer');
  assert(!logged.join('\n').includes(code) && !logged.join('\n').includes('quiet@example'), 'log line holds the code or the address');
  assert(/^Your hrdlock code: \d{6}$/.test(stub.calls[0].body.subject), 'subject: ' + stub.calls[0].body.subject);
  assert(!/https?:|www\./i.test(stub.calls[0].body.text + stub.calls[0].body.html), 'the mail holds a link');
});

await check('hostile addresses (line breaks, quotes, lists, display names, NUL) never reach the provider', async () => {
  const { env } = providerEnv('resend');
  setAnswer();
  stub.calls.length = 0;
  const bad = [
    'a@b.test\r\nBcc: x@y.test', 'a@b.test\nBcc: x@y.test', 'a@b.test,x@y.test', 'a@b.test;x@y.test', 'Name <a@b.test>', '"a b"@b.test',
    'a@b.test\u0000', 'a@b.test%0d%0aBcc:x@y.test', 'a@b.test>\r\nSubject: x', "a'@b.test", "'a@b.test", 'a b@b.test', 'a@b.test x@y.test',
    'a@[127.0.0.1]', 'a@127.0.0.1', 'a@b', 'a@@b.test', '@b.test', 'a@.test', 'a@b..test', '\u202ea@b.test', 'a@b.test\u2028x@y.test'
  ];
  for (const address of bad) {
    const res = await ask(env, address);
    assert(res.status === 400 && res.json.code === 'invalid_email', `${JSON.stringify(address)} gave HTTP ${res.status}`);
  }
  eq(stub.calls.length, 0, 'calls to the provider');
});

// o'brien@ and d'souza@ are real addresses (finding: auth-takeover, "real addresses"), so an apostrophe INSIDE the
// name is accepted. It only ever travels in a JSON body, where it is escaped, never in a header.
await check("real address with an apostrophe inside: accepted, and it reaches the provider as one JSON string", async () => {
  const { env } = providerEnv('resend');
  setAnswer();
  stub.calls.length = 0;
  const res = await ask(env, "o'brien@example.test");
  eq(res.status, 200, 'status');
  eq(stub.calls.length, 1, 'calls');
  eq(stub.calls[0].body.to[0], "o'brien@example.test", 'recipient');
});

await check('provider settings: odd MAIL_PROVIDER and CF_ACCOUNT_ID values never build another URL (no SSRF through env)', async () => {
  const hosts = new Set();
  for (const id of ['../../evil', 'a'.repeat(31) + '/', 'a'.repeat(32) + '?x=', 'a'.repeat(32) + '#', 'a'.repeat(32) + '\n', 'evil.test/' + 'a'.repeat(22), 'a'.repeat(33)]) {
    const mode = configuredProvider({ MAIL_PROVIDER: 'cloudflare', CF_ACCOUNT_ID: id, CF_EMAIL_TOKEN: 't', MAIL_FROM: 'a@b.test' });
    if (mode === 'cloudflare' && id !== 'a'.repeat(32) + '\n') throw new Error('accepted account id ' + JSON.stringify(id));
  }
  for (const kind of ['resend', 'brevo', 'cloudflare']) {
    const { env } = providerEnv(kind);
    setAnswer((c) => (kind === 'cloudflare' ? new Response('{"success":true}', { status: 200 }) : new Response('{}', { status: 200 })));
    stub.calls.length = 0;
    eq((await ask(env, 'url@example.test')).status, 200, kind);
    hosts.add(new URL(stub.calls[0].url).host);
  }
  eq([...hosts].sort().join(), 'api.brevo.com,api.cloudflare.com,api.resend.com', 'provider hosts');
  for (const raw of ['ECHO', ' echo', 'echo ', 'Echo', 'ech0', 'RESEND', 'none', '']) {
    const m = mailMode({ MAIL_PROVIDER: raw, ACCOUNT_MASTER_KEY: 'x' }, new Request('http://localhost/api/auth/request'));
    assert(m !== 'echo', `MAIL_PROVIDER ${JSON.stringify(raw)} turned echo on`);
  }
});

await check('provider settings: a provider API key with a line break in it only fails the send, nothing else', async () => {
  const { env } = providerEnv('resend', { RESEND_API_KEY: 'k\r\nX-Evil: 1' });
  setAnswer((c) => {
    throw new TypeError('invalid header value');
  });
  const res = await ask(env, 'hdr@example.test');
  eq(res.status, 502, 'status');
  eq(res.json.code, 'mail_failed', 'code');
});

await check('provider request: it must refuse redirects (an api-key header is not stripped on a redirect to another host)', async () => {
  const { env } = providerEnv('brevo');
  setAnswer();
  stub.calls.length = 0;
  eq((await ask(env, 'redir@example.test')).status, 200, 'status');
  const mode = stub.calls[0].init.redirect;
  assert(mode === 'error' || mode === 'manual', `fetch was called with redirect=${mode === undefined ? '(default: follow)' : mode}, the Brevo api-key header travels along if the provider host ever redirects`);
});

await check('slow provider: no headers for 11 s ends in a clean 502 after about 10 s', async () => {
  const { env } = providerEnv('resend');
  stub.restore();
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const started = performance.now();
  const res = await ask(env, 'slow@example.test');
  const took = (performance.now() - started) / 1000;
  globalThis.fetch = real;
  eq(res.status, 502, 'status');
  assert(took >= 9 && took < 12, `took ${took.toFixed(1)} s`);
});

await check('slow provider: headers at once but a body that never ends must still end the request in about 10 s', async () => {
  const { env } = providerEnv('cloudflare');
  stub.restore();
  const real = globalThis.fetch;
  // 200 with a body that never finishes (a stalled provider or a proxy that holds the connection)
  globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }), { status: 200 });
  const started = performance.now();
  const finished = await Promise.race([
    ask(env, 'drip@example.test').then((r) => ({ r })),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 14000))
  ]);
  globalThis.fetch = real;
  assert(!finished.hung, `the request was still waiting after ${((performance.now() - started) / 1000).toFixed(0)} s (the 10 s timeout stops at the headers, the body is read without one)`);
});

await check('slow provider: an error answer with a body that never ends must still end the request in about 10 s', async () => {
  const { env } = providerEnv('resend');
  stub.restore();
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }), { status: 500 });
  const started = performance.now();
  const finished = await Promise.race([
    ask(env, 'drip2@example.test').then((r) => ({ r })),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 14000))
  ]);
  globalThis.fetch = real;
  assert(!finished.hung, `the request was still waiting after ${((performance.now() - started) / 1000).toFixed(0)} s, with the unsent code still live in the table`);
});

// ---------------------------------------------------------------------------
// the echo guard, with the real route files

await check('echo guard: on a real https host, echo answers 503 and health says none, whatever the headers', async () => {
  const { env } = accountEnv({ env: { MAIL_PROVIDER: 'echo' } });
  const variants = [
    { base: 'https://hrdlock.example', ip: '203.0.113.9' },
    { base: 'https://hrdlock.example', ip: '127.0.0.1' },
    { base: 'https://hrdlock.example', ip: '::1' },
    { base: 'https://hrdlock.example' },
    { base: 'https://localhost.hrdlock.example', ip: '127.0.0.1' },
    { base: 'https://hrdlock.example', ip: '127.0.0.1', headers: { Host: 'localhost' } },
    { base: 'https://hrdlock.example', headers: { 'X-Forwarded-Host': 'localhost', 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'http', 'X-Original-URL': 'http://localhost/' } },
    { base: 'http://hrdlock.example', ip: '127.0.0.1' },
    { base: 'http://localhost.', ip: '127.0.0.1' },
    { base: 'http://[::1]', ip: '::1' },
    { base: 'http://127.0.0.1.hrdlock.example', ip: '127.0.0.1' },
    { base: 'http://0.0.0.0', ip: '127.0.0.1' },
    { base: 'http://localhost', ip: '127.0.0.1', headers: { 'cf-ray': '8f1c2d3e4f5a6b7c-FRA' } },
    { base: 'http://localhost', ip: '8.8.8.8' },
    { base: 'http://localhost', ip: '127.0.0.1, 8.8.8.8' },
    { base: 'http://localhost', headers: { 'CF-Connecting-IP': '' } },
    { base: 'http://localhost', headers: { 'CF-Connecting-IP': '   ' } }
  ];
  for (const v of variants) {
    const res = await callApi(env, 'POST', '/api/auth/request', { base: v.base, ip: v.ip, headers: v.headers, json: { email: 'guard@example.test' } });
    assert(!/debugCode/.test(res.text), `debugCode leaked for ${JSON.stringify(v)}: ${res.text.slice(0, 100)}`);
  }
  const health = await callApi(env, 'GET', '/api/health', { base: 'https://hrdlock.example', ip: '203.0.113.9' });
  eq(health.json && health.json.mail, 'none', 'health mail');
});

await check('echo guard: control, plain local development still gets the code', async () => {
  const { env } = accountEnv({ env: { MAIL_PROVIDER: 'echo' } });
  for (const [i, base] of ['http://localhost:8788', 'http://127.0.0.1:8788'].entries()) {
    const res = await callApi(env, 'POST', '/api/auth/request', { base, json: { email: `dev${i}@example.test` } });
    assert(res.status === 200 && /^\d{6}$/.test(res.json.debugCode), `${base}: ${res.text}`);
  }
});

await check('echo guard: the test clock header is ignored outside the guard (sessions and code ages follow the real clock)', async () => {
  const { env } = accountEnv({ env: { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.test' } });
  setAnswer();
  stub.calls.length = 0;
  const res = await callApi(env, 'POST', '/api/auth/request', { base: SITE, ip: publicIp(), json: { email: 'clock@example.test' }, headers: { 'x-hrd-test-now': '1' } });
  eq(res.status, 200, 'status');
  const { db } = { db: env.DB };
  const row = await db.prepare('SELECT created_at FROM otp_codes').first();
  assert(row.created_at > 1e12, 'the code was stamped with the forged clock: ' + row.created_at);
});

console.error = realError;
stub.restore();
finish();
