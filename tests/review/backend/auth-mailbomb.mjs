// Can the sign in code mail be used to flood somebody else's inbox, or to waste the mail budget?
// node tests/review/backend/auth-mailbomb.mjs [ignored base url]
// Runs in process against the real route files with a stubbed mail provider (nothing is sent, nothing
// goes over the network) on a real looking https host, so the local only echo shortcut is out of play.
// A FAIL line means a defect was proved.
import { assert, check, eq, finish } from './_lib.mjs';
import { SITE, callApi, frozenClock, installMailStub, providerEnv, publicIp } from './auth-proc.mjs';

const clock = frozenClock();
const stub = installMailStub();

// How many mails reached one inbox. gmail.com ignores dots and anything after a plus sign.
const inboxOf = (to) => {
  const [local, domain] = to.split('@');
  return local.split('+')[0].replace(/\./g, '') + '@' + domain;
};
const mailsTo = (inbox) => stub.calls.filter((c) => inboxOf(c.to) === inbox).length;
const ask = (env, ip, address, headers = {}) => callApi(env, 'POST', '/api/auth/request', { base: SITE, ip, json: { email: address }, headers });

await check('control: the same address 8 times in an hour gets 5 mails', async () => {
  const { env } = providerEnv('resend');
  stub.calls.length = 0;
  let sent = 0;
  for (let i = 0; i < 8; i++) {
    const res = await ask(env, publicIp(), 'control@gmail.com');
    if (res.status === 200) sent++;
    clock.advance(31000);
  }
  eq(sent, 5, 'mails');
  eq(mailsTo('control@gmail.com'), 5, 'delivered');
});

await check('plus tags: one inbox must not receive more than 5 code mails per hour by changing the part after +', async () => {
  const { env } = providerEnv('resend');
  stub.calls.length = 0;
  const ip = publicIp();
  for (let i = 0; i < 40; i++) await ask(env, ip, `victim+${i}@gmail.com`);
  const got = mailsTo('victim@gmail.com');
  assert(got <= 5, `${got} code mails reached victim@gmail.com in one hour from ONE source (40 requests, the per source limit stopped it at 20)`);
});

await check('dots: one gmail inbox must not receive more than 5 code mails per hour by moving dots', async () => {
  const { env } = providerEnv('resend');
  stub.calls.length = 0;
  const base = 'victimname';
  for (let i = 1; i < 10; i++) await ask(env, publicIp(), `${base.slice(0, i)}.${base.slice(i)}@gmail.com`);
  const got = mailsTo('victimname@gmail.com');
  assert(got <= 5, `${got} code mails reached victimname@gmail.com in one hour`);
});

await check('bomb: one attacker with many sources must not push hundreds of mails into one inbox in an hour', async () => {
  const { env } = providerEnv('resend');
  stub.calls.length = 0;
  // 25 sources (any botnet, or 25 /64 blocks of one IPv6 /48), 20 requests each, one address variant per request
  for (let s = 0; s < 25; s++) {
    const ip = `2001:db8:${(s + 1).toString(16)}::7`;
    for (let i = 0; i < 20; i++) await ask(env, ip, `victim+${s}x${i}@gmail.com`);
  }
  const got = mailsTo('victim@gmail.com');
  assert(got <= 20, `${got} code mails reached one inbox in one hour`);
});

await check('control: one IPv6 /64 is one source (20 requests), whatever the host part', async () => {
  const { env } = providerEnv('resend');
  stub.calls.length = 0;
  let ok = 0;
  for (let i = 0; i < 40; i++) {
    const res = await ask(env, `2001:db8:aaaa:bbbb:${i.toString(16)}::${(i * 977).toString(16)}`, `solo${i}@example.test`);
    if (res.status === 200) ok++;
  }
  eq(ok, 20, 'accepted from one /64');
});

await check('control: forwarded headers do not create new sources', async () => {
  const { env } = providerEnv('resend');
  stub.calls.length = 0;
  let ok = 0;
  const ip = publicIp();
  for (let i = 0; i < 30; i++) {
    const res = await ask(env, ip, `fwd${i}@example.test`, { 'X-Forwarded-For': `9.9.9.${i}`, 'X-Real-IP': `8.8.8.${i}`, Forwarded: `for=7.7.7.${i}` });
    if (res.status === 200) ok++;
  }
  eq(ok, 20, 'accepted');
});

await check('control: 40 parallel requests for one address send exactly one mail', async () => {
  const { env } = providerEnv('resend');
  stub.calls.length = 0;
  const out = await Promise.all(Array.from({ length: 40 }, () => ask(env, publicIp(), 'parallel@example.test')));
  eq(out.filter((r) => r.status === 200).length, 1, 'accepted');
  eq(mailsTo('parallel@example.test'), 1, 'mails');
});

stub.restore();
finish();
