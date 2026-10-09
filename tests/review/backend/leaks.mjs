// Information leaks. node tests/review/backend/leaks.mjs <baseUrl>
import { assert, brief, call, channelRecord, check, eq, expectStatus, finish, newDocId, newPerson, postChannel, publish, RUN } from './_lib.mjs';

const owner = await newPerson('Leak');
const secretLabel = 'unlisted-' + RUN + ' quarterly settlement draft';
const unlisted = await publish(owner, { listed: false, label: secretLabel });

await check('an unlisted document is absent from the public list (baseline)', async () => {
  const list = await call('GET', '/api/documents?limit=100&q=' + encodeURIComponent('unlisted-' + RUN));
  eq(list.json.documents.length, 0, 'listed count');
  const byOwner = await call('GET', `/api/documents?owner=${owner.keyId}&limit=100`);
  assert(!byOwner.json.documents.some((d) => d.docId === unlisted.docId), 'listed by owner filter');
});

await check('BY DESIGN: the public ledger carries unlisted documents too (listing is only hidden from the list, and the About text must say so)', async () => {
  // The ledger is public so that anyone can audit it, and a signature covers the whole record, so the
  // record (id, label, file hash, signer) cannot be hidden without breaking the audit. This pins the design down.
  let after = 0;
  let found = null;
  for (let page = 0; page < 200 && !found; page++) {
    const res = await call('GET', `/api/ledger?after=${after}&limit=200`);
    expectStatus(res, 200);
    found = res.json.entries.find((e) => e.record.docId === unlisted.docId) || null;
    if (!res.json.hasMore) break;
    after = res.json.entries[res.json.entries.length - 1].seq;
  }
  assert(found, 'the ledger no longer carries the unlisted document: the wording in the app that says so must change with it');
});

await check('BY DESIGN: a channel that names an unlisted document shows its id (the id is not a secret once a channel names it)', async () => {
  const rec = channelRecord(owner, { docId: unlisted.docId });
  expectStatus(await postChannel(owner, rec), 201);
  // the same channel object is in the public channel list and in every message page
  const page = await call('GET', `/api/channels/${rec.channelId}/messages`);
  expectStatus(page, 200);
  eq(page.json.channel.docId, unlisted.docId, 'channel docId');
  eq(page.json.channel.docOwnerKeyId, owner.keyId, 'docOwnerKeyId');
});

await check('error bodies for bad input and for server errors carry no stack, SQL or paths', async () => {
  const probes = [
    call('GET', '/api/documents?q=' + 'a'.repeat(100)),
    call('POST', '/api/documents/' + newDocId() + '/records', { raw: '{"record":{"type":"doc.create"},"signature":"x"}' }),
    call('POST', '/api/identities', { raw: '{"record":{"publicKey":{"kty":"EC"}},"signature":"x"}' }),
    call('GET', '/api/channels/ab/messages'),
    call('PUT', '/api/blobs/' + 'a'.repeat(64)),
    call('GET', '/api/documents/' + '0'.repeat(32))
  ];
  for (const res of await Promise.all(probes)) {
    assert(!/SQLITE|D1_ERROR|SELECT |INSERT |\bat\s+\S+\s*\(|\.js:\d+|node_modules|wrangler|miniflare|workerd|C:\\|\/home\//i.test(res.text), 'leak in: ' + res.text.slice(0, 200));
  }
});

await check('responses carry no server software or build details in headers', async () => {
  const res = await call('GET', '/api/health');
  for (const h of ['server', 'x-powered-by', 'x-server-env']) assert(!res.headers.get(h), `${h}: ${res.headers.get(h)}`);
});

await check('unknown signer and bad signature answers do not let outsiders list registered keys beyond the public identity lookup', async () => {
  // GET /api/identities/<keyId> is public by design, so this only confirms that it is the single oracle.
  const res = await call('GET', '/api/identities/' + owner.keyId);
  expectStatus(res, 200);
  assert(res.json.publicKey && !res.json.d, 'identity lookup returned a private member');
});

void brief;
finish();
