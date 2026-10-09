// Chain integrity attacks on documents. node tests/review/backend/chain.mjs <baseUrl>
import {
  ZERO_HASH, assert, brief, call, check, createRecord, eq, expectStatus, finish, makeBlob, newDocId, newPerson,
  postDoc, publish, putBlob, revokeRecord, updateRecord, bytesToHex, randomBytes
} from './_lib.mjs';

const alice = await newPerson('Alice');
const bob = await newPerson('Bob');

async function upload(who, n = 250) {
  const b = await makeBlob(n);
  const r = await putBlob(who, b);
  assert(r.status < 300, 'upload failed ' + brief(r));
  return b;
}

await check('update with wrong prev is refused (409 conflict)', async () => {
  const doc = await publish(alice);
  const b = await upload(alice);
  const res = await postDoc(alice, updateRecord(alice, b, { docId: doc.docId, version: 2, prev: bytesToHex(randomBytes(32)) }));
  expectStatus(res, 409, 'conflict');
});

await check('update with a version gap or a replayed version is refused', async () => {
  const doc = await publish(alice);
  const b = await upload(alice);
  expectStatus(await postDoc(alice, updateRecord(alice, b, { docId: doc.docId, version: 3, prev: doc.hash })), 409, 'conflict');
  const ok = await postDoc(alice, updateRecord(alice, b, { docId: doc.docId, version: 2, prev: doc.hash }));
  expectStatus(ok, 201);
  // build on v1 again
  const b2 = await upload(alice);
  expectStatus(await postDoc(alice, updateRecord(alice, b2, { docId: doc.docId, version: 2, prev: doc.hash })), 409, 'conflict');
});

await check('createdAt going backwards is refused', async () => {
  const t = Date.now();
  const doc = await publish(alice, { createdAt: t });
  const b = await upload(alice);
  const res = await postDoc(alice, updateRecord(alice, b, { docId: doc.docId, version: 2, prev: doc.hash, createdAt: t - 5000 }));
  expectStatus(res, 400);
});

await check('createdAt going backwards by one ms is refused', async () => {
  const t = Date.now();
  const doc = await publish(alice, { createdAt: t });
  const b = await upload(alice);
  const res = await postDoc(alice, updateRecord(alice, b, { docId: doc.docId, version: 2, prev: doc.hash, createdAt: t - 1 }));
  expectStatus(res, 400);
});

await check('doc.create whose blob was never uploaded is refused', async () => {
  const b = await makeBlob();
  expectStatus(await postDoc(alice, createRecord(alice, b)), 400);
});

await check('doc.create with the wrong blob size is refused', async () => {
  const b = await upload(alice, 260);
  expectStatus(await postDoc(alice, createRecord(alice, { ...b, size: 261 })), 400);
});

await check('doc.create with an existing doc id (by another owner) is refused', async () => {
  const doc = await publish(alice);
  const b = await upload(bob);
  expectStatus(await postDoc(bob, createRecord(bob, b, { docId: doc.docId })), 409, 'exists');
});

await check('update and revoke after revoke are refused', async () => {
  const doc = await publish(alice);
  const rev = revokeRecord(alice, { docId: doc.docId, version: 2, prev: doc.hash });
  const r = await postDoc(alice, rev);
  expectStatus(r, 201);
  const b = await upload(alice);
  expectStatus(await postDoc(alice, updateRecord(alice, b, { docId: doc.docId, version: 3, prev: r.json.recordHash })), 409, 'conflict');
  expectStatus(await postDoc(alice, revokeRecord(alice, { docId: doc.docId, version: 3, prev: r.json.recordHash })), 409, 'conflict');
  const head = await call('GET', `/api/documents/${doc.docId}/head`);
  eq(head.json.status, 'revoked');
  eq(head.json.blobHash, null);
});

await check('race: 12 parallel updates for version 2 give exactly one winner', async () => {
  const alice = await newPerson('RaceA');
  const doc = await publish(alice);
  const blobs = [];
  for (let i = 0; i < 6; i++) blobs.push(await upload(alice));
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => postDoc(alice, updateRecord(alice, blobs[i % 6], { docId: doc.docId, version: 2, prev: doc.hash, label: 'race ' + i })))
  );
  const wins = results.filter((r) => r.status === 201);
  const bad = results.filter((r) => r.status !== 201 && r.status !== 409);
  assert(bad.length === 0, 'unexpected statuses: ' + bad.map(brief).join(' | '));
  eq(wins.length, 1, 'winners');
  const bundle = await call('GET', `/api/documents/${doc.docId}`);
  eq(bundle.json.records.length, 2, 'record count');
  eq(bundle.json.document.headRecordHash, wins[0].json.recordHash, 'head hash');
});

await check('race: two owners create the same docId, exactly one wins', async () => {
  const alice = await newPerson('RaceB');
  const bob = await newPerson('RaceC');
  const docId = newDocId();
  const [b1, b2] = [await upload(alice), await upload(bob)];
  const results = await Promise.all([postDoc(alice, createRecord(alice, b1, { docId })), postDoc(bob, createRecord(bob, b2, { docId }))]);
  const wins = results.filter((r) => r.status === 201).length;
  eq(wins, 1, 'winners');
  assert(results.every((r) => r.status === 201 || r.status === 409), 'statuses ' + results.map((r) => r.status));
  const bundle = await call('GET', `/api/documents/${docId}`);
  eq(bundle.json.records.length, 1, 'records');
  eq(bundle.json.document.ownerKeyId, bundle.json.records[0].record.signer, 'owner matches signer');
});

await check('race: update and revoke for version 2 at once give one winner and a consistent head', async () => {
  const alice = await newPerson('RaceD');
  const doc = await publish(alice);
  const b = await upload(alice);
  const [u, v] = await Promise.all([
    postDoc(alice, updateRecord(alice, b, { docId: doc.docId, version: 2, prev: doc.hash })),
    postDoc(alice, revokeRecord(alice, { docId: doc.docId, version: 2, prev: doc.hash }))
  ]);
  eq([u.status, v.status].filter((s) => s === 201).length, 1, 'winners');
  const bundle = await call('GET', `/api/documents/${doc.docId}`);
  eq(bundle.json.records.length, 2, 'records');
  eq(bundle.json.document.headRecordHash, bundle.json.records[1].recordHash, 'head hash');
  eq(bundle.json.document.status, bundle.json.records[1].record.type === 'doc.revoke' ? 'revoked' : 'active', 'status');
});

await check('a blob row is required: a hash that exists only as a made up value is refused', async () => {
  const alice = await newPerson('RaceE');
  const fake = { hash: bytesToHex(randomBytes(32)), size: 500, bytes: new Uint8Array(500) };
  expectStatus(await postDoc(alice, createRecord(alice, fake)), 400);
});

finish();
