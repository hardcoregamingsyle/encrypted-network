// Authentication and authorisation attacks. node tests/review/backend/auth.mjs <baseUrl>
import {
  ZERO_HASH, assert, brief, call, channelRecord, check, createRecord, eq, expectRejected, expectStatus, finish,
  freshIp, makeBlob, makeIdentity, messageRecord, newDocId, newNonce, newPerson, postChannel, postDoc, postMessage,
  publish, putBlob, register, revokeRecord, signRecord, updateRecord
} from './_lib.mjs';

const alice = await newPerson('Alice');
const mallory = await newPerson('Mallory');
const ghost = await makeIdentity('Ghost ' + Date.now()); // never registered

await check('sign as one key but claim another signer is refused (doc.create)', async () => {
  const blob = await makeBlob();
  assert((await putBlob(alice, blob)).status < 300, 'upload');
  const rec = createRecord(alice, blob); // signer = alice
  const res = await postDoc(mallory, rec, { signWith: mallory });
  expectStatus(res, 400, 'bad_signature');
});

await check('sign as one key but claim another signer is refused (message)', async () => {
  const ch = channelRecord(alice);
  expectStatus(await postChannel(alice, ch), 201);
  const rec = messageRecord(alice, ch.channelId);
  expectStatus(await postMessage(mallory, ch.channelId, rec, mallory), 400, 'bad_signature');
});

await check('sign as one key but claim another signer is refused (channel.create)', async () => {
  const rec = channelRecord(alice);
  expectStatus(await postChannel(mallory, rec, mallory), 400, 'bad_signature');
});

await check('blob.put signed by a different key than x-hrd-key is refused', async () => {
  const blob = await makeBlob();
  const res = await putBlob(mallory, blob, { signerKeyId: alice.keyId, signWith: mallory });
  expectStatus(res, 400, 'bad_signature');
});

await check('unregistered signer cannot write a doc, blob, channel or message', async () => {
  const blob = await makeBlob();
  expectStatus(await putBlob(ghost, blob), 403, 'unknown_signer');
  const rec = createRecord(ghost, blob);
  expectStatus(await postDoc(ghost, rec), 403, 'unknown_signer');
  expectStatus(await postChannel(ghost, channelRecord(ghost)), 403, 'unknown_signer');
  const ch = channelRecord(alice);
  expectStatus(await postChannel(alice, ch), 201);
  expectStatus(await postMessage(ghost, ch.channelId, messageRecord(ghost, ch.channelId)), 403, 'unknown_signer');
});

await check('non owner cannot update or revoke someone elses document', async () => {
  const doc = await publish(alice);
  const blob = await makeBlob();
  assert((await putBlob(mallory, blob)).status < 300, 'upload');
  const upd = updateRecord(mallory, blob, { docId: doc.docId, version: 2, prev: doc.hash });
  expectStatus(await postDoc(mallory, upd), 403, 'not_owner');
  const rev = revokeRecord(mallory, { docId: doc.docId, version: 2, prev: doc.hash });
  expectStatus(await postDoc(mallory, rev), 403, 'not_owner');
  const head = await call('GET', `/api/documents/${doc.docId}/head`);
  eq(head.json.headVersion, 1, 'head version unchanged');
});

await check('record signed for doc A cannot be replayed to doc B address', async () => {
  const blob = await makeBlob();
  assert((await putBlob(alice, blob)).status < 300, 'upload');
  const rec = createRecord(alice, blob);
  const signature = await signRecord(alice.privateKey, rec);
  const other = newDocId();
  expectRejected(await call('POST', `/api/documents/${other}/records`, { json: { record: rec, signature } }), 'replay to other docId');
  // rewriting docId in the record breaks the signature
  const forged = { ...rec, docId: other };
  expectStatus(await call('POST', `/api/documents/${other}/records`, { json: { record: forged, signature } }), 400, 'bad_signature');
});

await check('message signed for channel A cannot be replayed into channel B', async () => {
  const a = channelRecord(alice);
  const b = channelRecord(alice);
  expectStatus(await postChannel(alice, a), 201);
  expectStatus(await postChannel(alice, b), 201);
  const rec = messageRecord(alice, a.channelId);
  const signature = await signRecord(alice.privateKey, rec);
  expectRejected(await call('POST', `/api/channels/${b.channelId}/messages`, { json: { record: rec, signature } }), 'replay to channel B');
  const forged = { ...rec, channelId: b.channelId };
  expectStatus(await call('POST', `/api/channels/${b.channelId}/messages`, { json: { record: forged, signature } }), 400, 'bad_signature');
});

await check('same signed message cannot be posted twice (replay in time)', async () => {
  const a = channelRecord(alice);
  expectStatus(await postChannel(alice, a), 201);
  const rec = messageRecord(alice, a.channelId);
  const signature = await signRecord(alice.privateKey, rec);
  const r1 = await call('POST', `/api/channels/${a.channelId}/messages`, { json: { record: rec, signature } });
  expectStatus(r1, 201);
  const r2 = await call('POST', `/api/channels/${a.channelId}/messages`, { json: { record: rec, signature } });
  expectStatus(r2, 409, 'exists');
  // a second valid encoding of the same signature (s -> n - s) must not give a second message either
  const sigBytes = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64');
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  let s = 0n;
  for (const b of sigBytes.subarray(32)) s = (s << 8n) | BigInt(b);
  const s2 = (n - s).toString(16).padStart(64, '0');
  const mall = Buffer.concat([sigBytes.subarray(0, 32), Buffer.from(s2, 'hex')]).toString('base64url');
  const r3 = await call('POST', `/api/channels/${a.channelId}/messages`, { json: { record: rec, signature: mall } });
  assert(r3.status >= 400, 'malleated signature produced a second message: ' + brief(r3));
});

await check('malleated signature (s -> n - s) cannot create a second copy of a doc record', async () => {
  const blob = await makeBlob();
  assert((await putBlob(alice, blob)).status < 300, 'upload');
  const rec = createRecord(alice, blob);
  const signature = await signRecord(alice.privateKey, rec);
  expectStatus(await call('POST', `/api/documents/${rec.docId}/records`, { json: { record: rec, signature } }), 201);
  const sigBytes = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64');
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  let s = 0n;
  for (const b of sigBytes.subarray(32)) s = (s << 8n) | BigInt(b);
  const s2 = (n - s).toString(16).padStart(64, '0');
  const mall = Buffer.concat([sigBytes.subarray(0, 32), Buffer.from(s2, 'hex')]).toString('base64url');
  const r = await call('POST', `/api/documents/${rec.docId}/records`, { json: { record: rec, signature: mall } });
  assert(r.status >= 400, 'second create accepted: ' + brief(r));
});

await check('cross type signature reuse: a signature over one record type is useless for another', async () => {
  const blob = await makeBlob();
  assert((await putBlob(alice, blob)).status < 300, 'upload');
  const rec = createRecord(alice, blob);
  // sign the doc.create bytes but submit the same fields as a doc.update (different type tag)
  const sig = await signRecord(alice.privateKey, rec);
  const asUpdate = { ...rec, type: 'doc.update', version: 2, prev: 'a'.repeat(64) };
  delete asUpdate.listed;
  expectRejected(await call('POST', `/api/documents/${rec.docId}/records`, { json: { record: asUpdate, signature: sig } }), 'type swap');
  // blob.put signature used as a doc record signature
  const bp = { v: 2, type: 'blob.put', hash: blob.hash, size: blob.size, signer: alice.keyId, createdAt: Date.now() };
  const bpSig = await signRecord(alice.privateKey, bp);
  expectRejected(await call('POST', `/api/documents/${rec.docId}/records`, { json: { record: bp, signature: bpSig } }), 'blob.put as doc');
  expectRejected(await call('POST', '/api/identities', { json: { record: bp, signature: bpSig }, ip: freshIp() }), 'blob.put as identity');
});

await check('blob.put signature cannot be reused for a different hash or size', async () => {
  const b1 = await makeBlob(200);
  const b2 = await makeBlob(200);
  const time = Date.now();
  const rec = { v: 2, type: 'blob.put', hash: b1.hash, size: 200, signer: alice.keyId, createdAt: time };
  const sig = await signRecord(alice.privateKey, rec);
  // send b2 bytes with b1 signature to /b2.hash
  const res = await call('PUT', '/api/blobs/' + b2.hash, {
    headers: { 'x-hrd-key': alice.keyId, 'x-hrd-time': String(time), 'x-hrd-sig': sig },
    body: b2.bytes
  });
  expectStatus(res, 400, 'bad_signature');
});

await check('blob.put with a stale or future time is refused', async () => {
  const b = await makeBlob();
  expectStatus(await putBlob(alice, b, { time: Date.now() - 6 * 60 * 1000 }), 400, 'expired');
  expectStatus(await putBlob(alice, b, { time: Date.now() + 6 * 60 * 1000 }), 400, 'expired');
});

await check('doc record with time outside the window is refused', async () => {
  const b = await makeBlob();
  assert((await putBlob(alice, b)).status < 300, 'upload');
  expectStatus(await postDoc(alice, createRecord(alice, b, { createdAt: Date.now() - 11 * 60 * 1000 })), 400, 'expired');
  expectStatus(await postDoc(alice, createRecord(alice, b, { createdAt: Date.now() + 11 * 60 * 1000 })), 400, 'expired');
});

await check('re-registering a key id with another display name keeps the first name', async () => {
  const id = await makeIdentity('First Name ' + Date.now());
  await register(id);
  const second = { ...id.identityRecord, displayName: 'Second Name', createdAt: Date.now() };
  const sig = await signRecord(id.privateKey, second);
  const r = await call('POST', '/api/identities', { json: { record: second, signature: sig }, ip: freshIp() });
  assert(r.status === 200 && r.json.existed === true, 'expected existed:true, got ' + brief(r));
  const got = await call('GET', '/api/identities/' + id.keyId);
  eq(got.json.displayName, id.identityRecord.displayName, 'display name');
});

await check('registering a victim public key with the attackers signature is refused', async () => {
  const rec = { ...mallory.identityRecord, publicKey: alice.publicJwk, displayName: 'Not Alice', createdAt: Date.now() };
  const sig = await signRecord(mallory.privateKey, rec);
  expectStatus(await call('POST', '/api/identities', { json: { record: rec, signature: sig }, ip: freshIp() }), 400, 'bad_signature');
});

await check('identity record with extra jwk field or other curve cannot alias a key id', async () => {
  const rec = { ...alice.identityRecord, publicKey: { ...alice.publicJwk, ext: true }, createdAt: Date.now() };
  const sig = await signRecord(alice.privateKey, rec);
  expectRejected(await call('POST', '/api/identities', { json: { record: rec, signature: sig }, ip: freshIp() }), 'extra jwk field');
});

await check('different bytes for the same blob hash cannot be stored (no overwrite of an existing blob)', async () => {
  const b = await makeBlob(400);
  assert((await putBlob(alice, b)).status < 300, 'upload');
  const other = new Uint8Array(400).fill(7);
  const res = await putBlob(mallory, { bytes: other, hash: b.hash, size: 400 }, { hash: b.hash });
  assert(res.status === 200 ? res.json.exists === true : res.status >= 400, 'unexpected ' + brief(res));
  const got = await call('GET', '/api/blobs/' + b.hash);
  assert(Buffer.compare(Buffer.from(got.bytes), Buffer.from(b.bytes)) === 0, 'stored bytes changed');
});

await check('a channel cannot name a document that does not exist, and the owner of a named document is shown', async () => {
  const doc = await publish(alice);
  const ghostDoc = newDocId();
  const none = await postChannel(mallory, channelRecord(mallory, { docId: ghostDoc }));
  assert(none.status === 400, 'a channel was linked to a document id that does not exist: ' + brief(none));
  // Anyone may open a channel about a public document (that is how people discuss it), but the channel
  // says who owns the document it names, so a viewer can tell the owner from someone else.
  const mine = await postChannel(mallory, channelRecord(mallory, { docId: doc.docId }));
  expectStatus(mine, 201);
  eq(mine.json.channel.docOwnerKeyId, alice.keyId, 'docOwnerKeyId');
  assert(mine.json.channel.createdBy !== mine.json.channel.docOwnerKeyId, 'a non owner channel must not look like an owner channel');
  const own = await postChannel(alice, channelRecord(alice, { docId: doc.docId }));
  expectStatus(own, 201);
  eq(own.json.channel.createdBy, own.json.channel.docOwnerKeyId, 'owner channel');
  const noDoc = await postChannel(alice, channelRecord(alice));
  eq(noDoc.json.channel.docOwnerKeyId, '', 'channel without a document');
});

finish();
