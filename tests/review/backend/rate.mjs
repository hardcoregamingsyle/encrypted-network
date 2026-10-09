// Rate limit attacks. node tests/review/backend/rate.mjs <baseUrl>
// Local dev trusts the CF-Connecting-IP request header. On Cloudflare that header is set by the edge and
// cannot be forged, so a spoofed address only shows what the server keys its buckets on.
import { assert, brief, call, channelRecord, check, eq, expectStatus, finish, makeIdentity, messageRecord, newPerson, postChannel, postMessage, putBlob, makeBlob, signRecord, freshIp, RUN } from './_lib.mjs';

async function tryRegister(headers) {
  const id = await makeIdentity('Rate ' + Math.random().toString(36).slice(2, 8));
  return call('POST', '/api/identities', { json: { record: id.identityRecord, signature: id.identitySignature }, headers });
}

await check('identity creation: the 11th from one address in an hour is refused with 429 and Retry-After', async () => {
  const ip = freshIp();
  const codes = [];
  let last = null;
  for (let i = 0; i < 12; i++) {
    last = await tryRegister({ 'CF-Connecting-IP': ip });
    codes.push(last.status);
  }
  eq(codes.slice(0, 10).every((c) => c === 201), true, 'first ten: ' + codes.join(','));
  eq(codes[10], 429, 'eleventh');
  assert(Number(last.headers.get('retry-after')) >= 1, 'Retry-After header missing');
});

await check('X-Forwarded-For and X-Real-IP cannot be used to dodge the per address limit', async () => {
  const ip = freshIp();
  let refused = 0;
  for (let i = 0; i < 14; i++) {
    const r = await tryRegister({ 'CF-Connecting-IP': ip, 'X-Forwarded-For': freshIp(), 'X-Real-IP': freshIp(), 'True-Client-IP': freshIp() });
    if (r.status === 429) refused++;
  }
  assert(refused >= 4, `only ${refused} of 14 refused, forwarded headers were trusted`);
});

await check('IPv6: addresses inside one /64 (one subscriber) share a bucket', async () => {
  const made = [];
  for (let i = 0; i < 25; i++) {
    const r = await tryRegister({ 'CF-Connecting-IP': `2001:db8:${RUN.slice(0, 4)}:${RUN.slice(4, 8)}::${(i + 1).toString(16)}` });
    made.push(r.status);
  }
  const ok = made.filter((s) => s === 201).length;
  assert(ok <= 10, `${ok} of 25 identities were created from one /64, the limit of 10 per hour is keyed on the full address (${made.join(',')})`);
});

await check('failed (bad signature) requests naming a victim do not use up the victims rate limit', async () => {
  const victim = await newPerson('RateVictim');
  const attacker = await newPerson('RateAttacker');
  const ch = channelRecord(victim);
  expectStatus(await postChannel(victim, ch), 201);
  for (let i = 0; i < 30; i++) {
    const rec = messageRecord(victim, ch.channelId);
    const r = await postMessage(attacker, ch.channelId, rec, attacker);
    assert(r.status === 400, 'forged message answered ' + brief(r));
  }
  for (let i = 0; i < 35; i++) {
    const b = await makeBlob(100);
    const r = await putBlob(attacker, b, { signerKeyId: victim.keyId, signWith: attacker });
    assert(r.status === 400, 'forged blob answered ' + brief(r));
  }
  for (let i = 0; i < 3; i++) expectStatus(await postMessage(victim, ch.channelId, messageRecord(victim, ch.channelId)), 201);
  const b = await makeBlob(120);
  assert((await putBlob(victim, b)).status < 300, 'victim upload blocked');
});

await check('message limit: 30 parallel messages from one signer give at most 20 accepted', async () => {
  const p = await newPerson('Flood');
  const ch = channelRecord(p);
  expectStatus(await postChannel(p, ch), 201);
  const res = await Promise.all(Array.from({ length: 30 }, () => postMessage(p, ch.channelId, messageRecord(p, ch.channelId))));
  const ok = res.filter((r) => r.status === 201).length;
  const limited = res.filter((r) => r.status === 429).length;
  assert(ok <= 20, `${ok} accepted`);
  eq(ok + limited, 30, 'every request is either accepted or 429: ' + res.map((r) => r.status).join(','));
});

await check('one signer cannot post to a channel faster by switching channels (limit is per signer, not per channel)', async () => {
  const p = await newPerson('Switch');
  const chans = [];
  for (let i = 0; i < 3; i++) {
    const c = channelRecord(p);
    expectStatus(await postChannel(p, c), 201);
    chans.push(c);
  }
  const res = await Promise.all(Array.from({ length: 30 }, (_, i) => postMessage(p, chans[i % 3].channelId, messageRecord(p, chans[i % 3].channelId))));
  assert(res.filter((r) => r.status === 201).length <= 20, 'more than 20 accepted');
});

await check('channel creation: the 11th channel from one signer in an hour is refused', async () => {
  const p = await newPerson('Chans');
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await postChannel(p, channelRecord(p))).status);
  eq(codes.filter((c) => c === 201).length, 10, 'accepted: ' + codes.join(','));
});

void signRecord;
finish();
