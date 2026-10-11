// Can a stranger who knows only an email address (or nothing at all) stop other people from signing in?
// node tests/review/backend/auth-lockout.mjs http://127.0.0.1:8801
// Needs a LOCAL server with accounts and MAIL_PROVIDER=echo. Uses the local test clock with far future
// hours, so the real hourly counters are not touched. A FAIL line means a defect was proved.
//
// What is tried:
//   1. the service wide cap of 400 codes per hour, filled by requests that send nothing
//   2. one person's quota of 5 codes per hour, used up by a stranger who knows the address
//   3. one person's live code, killed by 5 wrong guesses from a stranger
//   4. how many guesses at a code one email can be given per hour, and across an hour boundary
import { a, assert, check, email, eq, expectStatus, finish, freshWindow, loop, needEcho } from './auth-kit.mjs';

await needEcho();

await check('global cap: 400 requests that send no mail (cooldown refusals) must not use up the cap for everyone else', async () => {
  const t = freshWindow();
  const target = email('dup');
  expectStatus(await a('POST', '/api/auth/request', { json: { email: target }, now: t }), 200);
  // 22 addresses (cheap: any botnet, or one IPv6 /48) ask again and again for the SAME address within its cooldown.
  // Every one of these is refused with "a code was sent a moment ago", so no mail leaves the server.
  let refusedAsDuplicate = 0;
  for (let n = 0; n < 22; n++) {
    const ip = loop();
    for (let i = 0; i < 20; i++) {
      const res = await a('POST', '/api/auth/request', { json: { email: target }, ip, now: t + 1000 });
      if (res.json && res.json.code === 'rate_limited' && /moment ago/.test(res.json.error)) refusedAsDuplicate++;
    }
  }
  const legit = await a('POST', '/api/auth/request', { json: { email: email('legit') }, ip: loop(), now: t + 2000 });
  assert(legit.status === 200, `${refusedAsDuplicate} duplicate requests sent no mail, yet a new person is now refused: HTTP ${legit.status} ${legit.json && legit.json.error}`);
});

await check('global cap: 22 addresses asking for 20 codes each must not be able to shut sign in for everybody', async () => {
  const t = freshWindow();
  let sent = 0;
  for (let n = 0; n < 22; n++) {
    const ip = loop();
    for (let i = 0; i < 20; i++) {
      const res = await a('POST', '/api/auth/request', { json: { email: email('flood') }, ip, now: t });
      if (res.status === 200) sent++;
    }
  }
  const legit = await a('POST', '/api/auth/request', { json: { email: email('legit') }, ip: loop(), now: t + 1000 });
  assert(legit.status === 200, `after ${sent} codes for strangers a real person is refused for the rest of the hour: HTTP ${legit.status} ${legit.json && legit.json.error}`);
});

await check('quota: a stranger must not be able to use up another person\'s 5 codes per hour', async () => {
  const t = freshWindow();
  const victim = email('victim');
  // the stranger waits out the 30 s cooldown between asks: 5 asks in under 3 minutes
  for (let i = 0; i < 5; i++) expectStatus(await a('POST', '/api/auth/request', { json: { email: victim }, now: t + i * 31000 }), 200);
  // the real owner now tries to sign in, 3 minutes into the hour
  const owner = await a('POST', '/api/auth/request', { json: { email: victim }, now: t + 6 * 31000 });
  assert(owner.status === 200, `the owner of the address is refused for the rest of the hour (Retry-After ${owner.headers.get('retry-after')} s): HTTP ${owner.status} ${owner.json && owner.json.code}`);
});

await check('live code: a stranger\'s 5 wrong guesses must not kill the code that was mailed to the owner', async () => {
  const t = freshWindow();
  const victim = email('victim');
  const req = await a('POST', '/api/auth/request', { json: { email: victim }, now: t });
  expectStatus(req, 200);
  const wrong = req.json.debugCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await a('POST', '/api/auth/verify', { json: { email: victim, code: wrong }, ip: loop(), now: t + 1000 });
  const owner = await a('POST', '/api/auth/verify', { json: { email: victim, code: req.json.debugCode }, ip: loop(), now: t + 2000 });
  assert(owner.status === 200, `the owner types the right code and gets HTTP ${owner.status} ${owner.json && owner.json.code}`);
});

await check('guessing budget: one email gets at most 5 codes in any 3 minutes (a window boundary must not double it)', async () => {
  const t = freshWindow();
  const hour = 3600 * 1000;
  const boundary = Math.ceil(t / hour) * hour; // the start of the next fixed window
  const victim = email('bound');
  let issued = 0;
  // 5 codes in the last 2.5 minutes of the hour, 5 more in the first 2.5 minutes of the next
  for (let i = 0; i < 5; i++) {
    const res = await a('POST', '/api/auth/request', { json: { email: victim }, now: boundary - 5 * 31000 + i * 31000 });
    if (res.status === 200) issued++;
  }
  for (let i = 0; i < 5; i++) {
    const res = await a('POST', '/api/auth/request', { json: { email: victim }, now: boundary + 1000 + i * 31000 });
    if (res.status === 200) issued++;
  }
  assert(issued <= 5, `${issued} codes (so ${issued * 5} guesses) were issued for one address within about 5 minutes`);
});

await check('guessing budget: guesses at one address per hour stay at 25 (5 codes x 5 tries)', async () => {
  const t = freshWindow();
  const victim = email('budget');
  let guesses = 0;
  let codes = 0;
  for (let i = 0; i < 8; i++) {
    const now = t + i * 31000;
    const req = await a('POST', '/api/auth/request', { json: { email: victim }, now });
    if (req.status !== 200) continue;
    codes++;
    const wrong = req.json.debugCode === '000000' ? '111111' : '000000';
    for (let g = 0; g < 7; g++) {
      const v = await a('POST', '/api/auth/verify', { json: { email: victim, code: wrong }, ip: loop(), now: now + 500 });
      if (v.json && (v.json.code === 'invalid_code' || (v.json.code === 'too_many_attempts' && g === 4))) guesses++;
    }
  }
  eq(codes, 5, 'codes per hour');
  assert(guesses <= 25, `${guesses} guesses were counted`);
});

finish();
