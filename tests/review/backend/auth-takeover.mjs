// Taking over an account: spelling tricks on the email, codes for other addresses, replays, guessing.
// node tests/review/backend/auth-takeover.mjs http://127.0.0.1:8801
// Needs a LOCAL server with accounts and MAIL_PROVIDER=echo. Uses the local test clock with far future
// hours so the hourly counters of the real clock are not touched. A FAIL line means a defect was proved.
import { openDb } from './_lib.mjs';
import { Jar, a, assert, check, email, eq, expectStatus, finish, freshWindow, loop, needEcho, signIn } from './auth-kit.mjs';

await needEcho();
const db = await openDb();

const tagOf = () => Math.random().toString(36).slice(2, 10);

await check('spelling: case and blanks reach one account, anything that can reach a different mailbox is a different account', async () => {
  const t = freshWindow();
  const base = `spell${tagOf()}`;
  const ref = (await signIn(`${base}@example.test`, { now: t })).account.id;
  const same = [`${base.toUpperCase()}@EXAMPLE.TEST`, `  ${base}@example.test`, `${base}@Example.Test\t`, `\n${base}@example.test\r\n`, `\u00a0${base}@example.test\u00a0`];
  const different = [`${base}+x@example.test`, `${base.slice(0, 3)}.${base.slice(3)}@example.test`, `${base}@mail.example.test`, `${base}%x@example.test`, `${base}-@example.test`, `${base}_@example.test`, `${base}0@example.test`];
  for (let i = 0; i < same.length; i++) {
    const got = await signIn(same[i], { now: freshWindow() });
    eq(got.account.id, ref, `same account for ${JSON.stringify(same[i])}`);
  }
  const ids = new Set([ref]);
  for (let i = 0; i < different.length; i++) {
    const got = await signIn(different[i], { now: freshWindow() });
    assert(!ids.has(got.account.id), `${JSON.stringify(different[i])} reached an account that another spelling already has`);
    ids.add(got.account.id);
  }
});

await check('spelling: 80 spellings that are not plain ASCII addresses are all refused with 400 invalid_email, none gets a code', async () => {
  const bad = [];
  const base = `b${tagOf()}`;
  const marks = ['\u0000', '\u0001', '\u001f', '\u007f', '\u0085', '\u00a0', '\u00ad', '\u200b', '\u200e', '\u200f', '\u2028', '\u2029', '\u202e', '\u2060', '\ufeff', '\ufe0f', '\u0301', '\u0430', '\u212a', '\uff20', '\uff0e', '\u3002', '\ud83d\ude00', '\ud800', '\u0131', '\u0130', '\u017f', '\u1e9e', '\ufb01'];
  for (const m of marks) {
    bad.push(`${base}${m}@example.test`, `${base}@exam${m}ple.test`);
    // a blank or BOM at the very edge is trimmed away on purpose, every other mark in front is not an address
    if (m.trim() !== '') bad.push(`${m}${base}@example.test`);
  }
  bad.push(`${base}@example.t\u00e9st`, `${base}@\u00fcnicode.test`, `\u00fc${base}@example.test`, `${base}@example.test.`, `${base}@.example.test`, `${base}@-example.test`, `${base}@example-.test`, `${base}@exa mple.test`, `${base}@example.123`, `${base}@example`, `${base}@@example.test`, `${base}@example.test@x.test`, `.${base}@example.test`, `${base}.@example.test`, `${base}..x@example.test`, `${'a'.repeat(65)}@example.test`, `${base}@${'a'.repeat(64)}.test`, `${base}@${'a.'.repeat(12)}test`, `${base}@${'a'.repeat(250)}.test`, `"${base}"@example.test`, `${base}(c)@example.test`, `${base}!@example.test`, `${base}#@example.test`, `${base}$@example.test`, `${base}&@example.test`, `${base}'@example.test`, `${base}*@example.test`, `${base}/@example.test`, `${base}=@example.test`, `${base}?@example.test`, `${base}^@example.test`, `${base}\`@example.test`, `${base}{@example.test`, `${base}|@example.test`, `${base}~@example.test`, `${base}\\@example.test`, `${base}:@example.test`, `${base};@example.test`, `${base}<@example.test`, `${base}[@example.test`);
  assert(bad.length >= 80, 'corpus ' + bad.length);
  for (const input of bad) {
    const res = await a('POST', '/api/auth/request', { json: { email: input }, now: freshWindow() });
    assert(res.status === 400 && res.json.code === 'invalid_email' && !res.text.includes('debugCode'), `${JSON.stringify(input).slice(0, 60)} gave HTTP ${res.status} ${res.text.slice(0, 80)}`);
  }
});

await check('real addresses: common valid addresses (apostrophe, leading underscore, leading hyphen, ampersand) can sign in', async () => {
  const refused = [];
  for (const local of ["o'brien", "d'souza", '_work', '-work', 'a&b', 'first.last', 'first-last', 'first_last', 'user+tag', 'user%tag']) {
    const res = await a('POST', '/api/auth/request', { json: { email: `${local}${tagOf()}@example.test` }, now: freshWindow() });
    if (res.status !== 200) refused.push(local);
  }
  assert(refused.length === 0, 'refused as not valid although mail servers accept them: ' + refused.join(', '));
});

await check('spelling: a very long or odd body field is a 400, never a crash or a slow answer', async () => {
  for (const value of ['a'.repeat(100000), 'a@'.repeat(50000), '\u0000'.repeat(1000), 5, true, null, [], {}, ['a@b.test'], { toString: 'x' }]) {
    const t0 = Date.now();
    const res = await a('POST', '/api/auth/request', { json: { email: value }, now: freshWindow() });
    assert(res.status === 400 || res.status === 413, `HTTP ${res.status} for ${JSON.stringify(value).slice(0, 30)}`);
    assert(Date.now() - t0 < 3000, 'slow answer');
  }
});

await check('codes: the code of one address never signs in as another, and trying it does not burn the other address\'s own code', async () => {
  const t = freshWindow();
  const A = email('xa');
  const B = email('xb');
  const ra = await a('POST', '/api/auth/request', { json: { email: A }, now: t });
  const rb = await a('POST', '/api/auth/request', { json: { email: B }, now: t });
  if (ra.json.debugCode === rb.json.debugCode) return; // the rare case of equal codes says nothing
  const wrong = await a('POST', '/api/auth/verify', { json: { email: A, code: rb.json.debugCode }, now: t + 1000 });
  eq(wrong.json.code, 'invalid_code', 'B\'s code on A');
  expectStatus(await a('POST', '/api/auth/verify', { json: { email: B, code: rb.json.debugCode }, now: t + 2000 }), 200);
  expectStatus(await a('POST', '/api/auth/verify', { json: { email: A, code: ra.json.debugCode }, now: t + 3000 }), 200);
});

await check('codes: variants of the address (case, plus tag, dots) use the same code only where the address is the same', async () => {
  const t = freshWindow();
  const base = `var${tagOf()}`;
  const r = await a('POST', '/api/auth/request', { json: { email: `${base}@example.test` }, now: t });
  const code = r.json.debugCode;
  for (const other of [`${base}+x@example.test`, `${base}.@example.test`, `x${base}@example.test`, `${base}@example.tes`]) {
    const res = await a('POST', '/api/auth/verify', { json: { email: other, code }, now: t + 1000 });
    assert(res.status === 400 || res.status === 429, `${other} accepted the code: HTTP ${res.status}`);
  }
  expectStatus(await a('POST', '/api/auth/verify', { json: { email: `${base.toUpperCase()}@EXAMPLE.TEST`, code }, now: t + 2000 }), 200);
});

await check('replay: a used code is dead (same address, other address, after logout, after deleting the account)', async () => {
  const t = freshWindow();
  const addr = email('replay');
  const r = await a('POST', '/api/auth/request', { json: { email: addr }, now: t });
  const jar = new Jar();
  expectStatus(await a('POST', '/api/auth/verify', { json: { email: addr, code: r.json.debugCode }, jar, now: t + 1000 }), 200);
  eq((await a('POST', '/api/auth/verify', { json: { email: addr, code: r.json.debugCode }, now: t + 2000 })).json.code, 'code_expired', 'second use');
  expectStatus(await a('POST', '/api/auth/logout', { jar, now: t + 3000 }), 200);
  eq((await a('POST', '/api/auth/verify', { json: { email: addr, code: r.json.debugCode }, now: t + 4000 })).json.code, 'code_expired', 'after logout');
  const s = await signIn(addr, { now: t + 5000 });
  expectStatus(await a('DELETE', '/api/me', { jar: s.jar, now: t + 6000 }), 200);
  eq((await a('POST', '/api/auth/verify', { json: { email: addr, code: r.json.debugCode }, now: t + 7000 })).json.code, 'code_expired', 'after deletion');
});

await check('replay: a new code kills the old one (after the cooldown), the old one gets a counted wrong answer', async () => {
  const t = freshWindow();
  const addr = email('twocodes');
  const c1 = (await a('POST', '/api/auth/request', { json: { email: addr }, now: t })).json.debugCode;
  const c2 = (await a('POST', '/api/auth/request', { json: { email: addr }, now: t + 31000 })).json.debugCode;
  if (c1 === c2) return;
  eq((await a('POST', '/api/auth/verify', { json: { email: addr, code: c1 }, now: t + 32000 })).json.code, 'invalid_code', 'old code');
  expectStatus(await a('POST', '/api/auth/verify', { json: { email: addr, code: c2 }, now: t + 33000 }), 200);
});

await check('expiry: a code works up to the last moment of its 10 minutes and not a millisecond later', async () => {
  const t = freshWindow();
  const ok = email('late1');
  const bad = email('late2');
  const c1 = (await a('POST', '/api/auth/request', { json: { email: ok }, now: t })).json.debugCode;
  const c2 = (await a('POST', '/api/auth/request', { json: { email: bad }, now: t })).json.debugCode;
  expectStatus(await a('POST', '/api/auth/verify', { json: { email: ok, code: c1 }, now: t + 10 * 60 * 1000 - 1 }), 200);
  eq((await a('POST', '/api/auth/verify', { json: { email: bad, code: c2 }, now: t + 10 * 60 * 1000 })).json.code, 'code_expired', 'at 10:00.000');
});

await check('format: only 6 digits are a code (spaces allowed), other spellings are refused and do not use up tries', async () => {
  const t = freshWindow();
  const addr = email('fmt');
  const c = (await a('POST', '/api/auth/request', { json: { email: addr }, now: t })).json.debugCode;
  const odd = [123456, [c], { c }, null, true, `+${c}`, `${c}0`, `0${c}`, c.slice(1), `${c}.0`, `${c}e0`, '0x' + Number(c).toString(16), c.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))), `${c.slice(0, 3)}-${c.slice(3)}`, `${c}\u0000`, `${c}'; --`];
  for (const code of odd) {
    const res = await a('POST', '/api/auth/verify', { json: { email: addr, code }, now: t + 1000, ip: loop() });
    assert(res.status === 400 && res.json.code === 'invalid_code', `${JSON.stringify(code)} gave HTTP ${res.status} ${res.json && res.json.code}`);
  }
  // none of those used a try: the real code still works
  expectStatus(await a('POST', '/api/auth/verify', { json: { email: addr, code: `${c.slice(0, 3)} ${c.slice(3)}` }, now: t + 2000 }), 200);
});

await check('create: 10 parallel right answers make one account row and one session; the account is new exactly once', async () => {
  const t = freshWindow();
  const addr = email('park');
  const c = (await a('POST', '/api/auth/request', { json: { email: addr }, now: t })).json.debugCode;
  const out = await Promise.all(Array.from({ length: 10 }, () => a('POST', '/api/auth/verify', { json: { email: addr, code: c }, now: t + 1000, ip: loop() })));
  eq(out.filter((r) => r.status === 200).length, 1, 'successes');
  assert(out.every((r) => r.status < 500), 'a 5xx: ' + out.map((r) => r.status).join());
  const winner = out.find((r) => r.status === 200);
  eq(winner.json.isNew, true, 'isNew');
  const again = await signIn(addr, { now: t + 100000 });
  eq(again.account.id, winner.json.account.id, 'same account');
  const second = await a('POST', '/api/auth/request', { json: { email: addr }, now: t + 200000 });
  const ver = await a('POST', '/api/auth/verify', { json: { email: addr, code: second.json.debugCode }, now: t + 201000 });
  eq(ver.json.isNew, false, 'isNew on a later sign in');
  if (db) eq(db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE email_masked = ?').get(winner.json.account.emailMasked).n >= 1, true, 'row');
});

await check('guessing: 300 parallel guesses at a live code from 300 addresses are cut off at 5 and the real code then also fails (the price of the limit)', async () => {
  const t = freshWindow();
  const addr = email('storm');
  const c = (await a('POST', '/api/auth/request', { json: { email: addr }, now: t })).json.debugCode;
  const guesses = Array.from({ length: 300 }, (_, i) => String(100000 + ((Number(c) + 1 + i) % 900000)).padStart(6, '0'));
  const out = await Promise.all(guesses.map((g) => a('POST', '/api/auth/verify', { json: { email: addr, code: g }, now: t + 1000, ip: loop() })));
  assert(out.every((r) => r.status === 400 || r.status === 429), 'unexpected: ' + [...new Set(out.map((r) => r.status))].join());
  const counted = out.filter((r) => r.json.code === 'invalid_code').length;
  assert(counted <= 4, `${counted} guesses were counted as ordinary wrong answers`);
  const right = await a('POST', '/api/auth/verify', { json: { email: addr, code: c }, now: t + 2000 });
  assert(right.status === 429, 'the code stayed alive after 300 guesses: HTTP ' + right.status);
  if (db) assert(db.prepare('SELECT MAX(attempts) AS m FROM otp_codes').get().m <= 5, 'attempts above 5');
});

finish();
