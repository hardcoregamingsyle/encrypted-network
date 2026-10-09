// The channel list is paged and ordered by the time the server received a channel, not by the time the
// creator claims, so throwaway channels cannot push a real one out of reach.
// node tests/review/backend/channelspam.mjs <baseUrl>
import { assert, call, channelRecord, check, eq, expectStatus, finish, newPerson, postChannel } from './_lib.mjs';

const victim = await newPerson('ChanVictim');
const vc = channelRecord(victim, { title: 'Official notices' });
expectStatus(await postChannel(victim, vc), 201);

async function walk(limit) {
  const seen = [];
  let url = '/api/channels' + (limit ? '?limit=' + limit : '');
  for (let page = 0; page < 500; page++) {
    const res = await call('GET', url);
    expectStatus(res, 200);
    seen.push(...res.json.channels.map((c) => c.channelId));
    if (!res.json.next) return seen;
    url = `/api/channels?${limit ? 'limit=' + limit + '&' : ''}before=${res.json.next.before}&beforeId=${res.json.next.beforeId}`;
  }
  throw new Error('the list never ended');
}

await check('a real channel stays reachable in the channel list after 210 spam channels are created', async () => {
  // 21 throwaway identities x 10 channels (the per signer limit) = 210 channels, all with a createdAt a few minutes ahead
  const ahead = Date.now() + 5 * 60 * 1000;
  for (let i = 0; i < 21; i++) {
    const spammer = await newPerson('Spam' + i);
    const jobs = [];
    for (let k = 0; k < 10; k++) jobs.push(postChannel(spammer, channelRecord(spammer, { title: 'spam ' + i + '-' + k, createdAt: ahead })));
    const res = await Promise.all(jobs);
    assert(res.every((r) => r.status === 201), 'spam channel refused: ' + res.map((r) => r.status).join(','));
  }
  const first = await call('GET', '/api/channels');
  expectStatus(first, 200);
  assert(first.json.channels.length <= 200, 'first page too long');
  const all = await walk();
  assert(all.includes(vc.channelId), 'the real channel is not reachable by paging');
  assert(new Set(all).size === all.length, 'a channel appeared on two pages');
  const small = await walk(7);
  eq(small.length, all.length, 'paging with a small limit finds the same channels');
  eq(small.join(), all.join(), 'same order with a different page size');
});

await check('a forward dated createdAt does not put a channel ahead of one received later', async () => {
  const early = await newPerson('Early');
  const late = await newPerson('Late');
  const a = channelRecord(early, { createdAt: Date.now() + 9 * 60 * 1000 });
  expectStatus(await postChannel(early, a), 201);
  const b = channelRecord(late);
  expectStatus(await postChannel(late, b), 201);
  const list = await call('GET', '/api/channels?limit=5');
  const ids = list.json.channels.map((c) => c.channelId);
  assert(ids.indexOf(b.channelId) !== -1 && ids.indexOf(b.channelId) < ids.indexOf(a.channelId), 'order follows the claimed time: ' + ids.join());
});

await check('channel paging cursor is validated', async () => {
  expectStatus(await call('GET', '/api/channels?limit=0'), 400);
  expectStatus(await call('GET', '/api/channels?limit=201'), 400);
  expectStatus(await call('GET', '/api/channels?before=x'), 400);
  expectStatus(await call('GET', '/api/channels?before=5&beforeId=A%20B'), 400);
  expectStatus(await call('GET', '/api/channels?before=5&beforeId=abc'), 200);
});
finish();
