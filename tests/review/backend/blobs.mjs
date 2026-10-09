// Blob handling: hash checks, traversal, HEAD, ranges, headers, content checks.
// node tests/review/backend/blobs.mjs <baseUrl>
import {
  assert, brief, call, check, eq, expectStatus, finish, makeBlob, newPerson, putBlob, randomBytes, sha256Hex, bytesToHex,
  channelRecord, postChannel, openDb, rawHttp, stampLockHeader, MIN_LOCKED
} from './_lib.mjs';

const alice = await newPerson('Blob');

await check('bytes that do not match the signed hash are refused and nothing is stored', async () => {
  const good = await makeBlob(400);
  const other = randomBytes(400);
  const res = await putBlob(alice, good, { body: other });
  expectStatus(res, 400, 'bad_request');
  eq((await call('GET', '/api/blobs/' + good.hash)).status, 404, 'GET after mismatch');
  const db = await openDb();
  if (db) eq(db.prepare('SELECT COUNT(*) n FROM blobs WHERE hash = ?').get(good.hash).n, 0, 'blobs row');
  // a retry with the right bytes works
  expectStatus(await putBlob(alice, good), 201);
});

await check('bytes with the right hash but shorter than the signed size cannot be stored under the hash', async () => {
  const good = await makeBlob(400);
  const res = await putBlob(alice, good, { body: good.bytes.subarray(0, 399) });
  assert(res.status >= 400 && res.status < 500, brief(res));
  eq((await call('GET', '/api/blobs/' + good.hash)).status, 404);
});

await check('empty body and zero size are refused', async () => {
  const empty = { bytes: new Uint8Array(0), hash: await sha256Hex(new Uint8Array(0)), size: 0 };
  const res = await putBlob(alice, empty);
  assert(res.status >= 400 && res.status < 500, brief(res));
});

await check('GET with traversal, encoded slashes, wrong case or length in the hash is a clean 400/404', async () => {
  const h = 'a'.repeat(64);
  for (const p of [
    '../../x', '..%2F..%2Fx', '%2e%2e/%2e%2e/x', h.toUpperCase(), h.slice(1), h + 'a', h + '/', h + '%2F..', `${h}%00`, '%2F' + h, `blobs/${h}`,
    '..%5C..%5Cx', '%252e%252e%252f', h.slice(0, 63) + 'g'
  ]) {
    for (const m of ['GET', 'HEAD']) {
      // raw socket, so the client does not normalise dot segments before they reach the server
      const r = await rawHttp([`${m} /api/blobs/${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`], { waitMs: 2000 });
      // dot segments the platform normalises away end up at the app page, never at a blob
      const spaPage = r.status === 200 && /text\/html/i.test(r.head) && !/octet-stream/i.test(r.head);
      assert((r.status >= 400 && r.status < 500) || ((p.includes('..') || p.includes('%2e')) && spaPage), `${m} ${p} -> ${r.status}`);
      assert(!/blobs\/[0-9a-f]/.test(r.body), 'leaks key path');
    }
  }
});

const stored = await makeBlob(1000);
expectStatus(await putBlob(alice, stored), 201);

await check('GET headers: octet-stream, attachment, nosniff, immutable cache, ETag = hash', async () => {
  const res = await call('GET', '/api/blobs/' + stored.hash);
  expectStatus(res, 200);
  eq(res.headers.get('content-type'), 'application/octet-stream', 'content-type');
  assert(/^attachment/.test(res.headers.get('content-disposition') || ''), 'disposition ' + res.headers.get('content-disposition'));
  eq(res.headers.get('x-content-type-options'), 'nosniff', 'nosniff');
  assert(/immutable/.test(res.headers.get('cache-control') || ''), 'cache-control ' + res.headers.get('cache-control'));
  eq(res.headers.get('etag'), `"${stored.hash}"`, 'etag');
  eq(await sha256Hex(res.bytes), stored.hash, 'body hash');
});

await check('HEAD returns the same headers and no body', async () => {
  const res = await call('HEAD', '/api/blobs/' + stored.hash);
  expectStatus(res, 200);
  eq(res.bytes.length, 0, 'head body');
  eq(res.headers.get('content-length'), '1000', 'content-length');
  eq(res.headers.get('content-type'), 'application/octet-stream');
});

await check('If-None-Match gives 304 and does not leak a missing blob as present', async () => {
  const res = await call('GET', '/api/blobs/' + stored.hash, { headers: { 'If-None-Match': `"${stored.hash}"` } });
  eq(res.status, 304, 'status');
  const missing = 'c'.repeat(64);
  eq((await call('GET', '/api/blobs/' + missing, { headers: { 'If-None-Match': `"${missing}"` } })).status, 404, 'missing blob with matching etag');
  eq((await call('GET', '/api/blobs/' + missing, { headers: { 'If-None-Match': '*' } })).status, 404, 'missing blob with *');
});

await check('Range requests: either a correct 206 or a plain full 200, never wrong bytes', async () => {
  const res = await call('GET', '/api/blobs/' + stored.hash, { headers: { Range: 'bytes=10-19' } });
  if (res.status === 206) {
    eq(res.bytes.length, 10, 'partial length');
    eq(Buffer.compare(Buffer.from(res.bytes), Buffer.from(stored.bytes.subarray(10, 20))), 0, 'partial bytes');
    assert(/^bytes 10-19\/1000$/.test(res.headers.get('content-range') || ''), 'content-range');
  } else {
    eq(res.status, 200, 'status');
    eq(res.bytes.length, 1000, 'full body');
  }
  const bad = await call('GET', '/api/blobs/' + stored.hash, { headers: { Range: 'bytes=5000-6000' } });
  assert(bad.status === 416 || bad.status === 200, 'bad range -> ' + bad.status);
});

await check('404 for a blob is not cacheable and carries no blob caching headers', async () => {
  const res = await call('GET', '/api/blobs/' + 'd'.repeat(64));
  eq(res.status, 404);
  assert(/no-store/.test(res.headers.get('cache-control') || ''), 'cache-control ' + res.headers.get('cache-control'));
});

await check('HEAD answers like GET without a body on the JSON routes (monitors and verifiers use it)', async () => {
  const urls = ['/api/health', '/api/server-key', '/api/documents', '/api/ledger?limit=1', '/api/channels', '/api/identities/' + alice.keyId];
  for (const u of urls) {
    const res = await call('HEAD', u);
    eq(res.status, 200, 'HEAD ' + u);
    eq(res.bytes.length, 0, 'body of HEAD ' + u);
    eq(res.headers.get('x-content-type-options'), 'nosniff', 'nosniff on HEAD ' + u);
  }
  eq((await call('HEAD', '/api/nothing-here')).status, 404, 'HEAD on an unknown route');
  eq((await call('POST', '/api/health')).status, 405, 'POST on health');
});

await check('every JSON endpoint is no-store', async () => {
  const ch = channelRecord(alice);
  expectStatus(await postChannel(alice, ch), 201);
  const urls = ['/api/health', '/api/server-key', '/api/documents', '/api/ledger', '/api/channels', `/api/channels/${ch.channelId}/messages`, '/api/identities/' + alice.keyId, '/api/nothing-here', '/api/documents/' + 'a'.repeat(32)];
  for (const u of urls) {
    const res = await call('GET', u);
    assert(/no-store/.test(res.headers.get('cache-control') || ''), `${u}: cache-control ${res.headers.get('cache-control')}`);
    eq(res.headers.get('x-content-type-options'), 'nosniff', u + ' nosniff');
  }
});

await check('the server only stores files that look like locked files (HRDLOCK3 header), not arbitrary public content', async () => {
  const filler = '<html><script>alert(1)</script> not a locked file, free public hosting ' + bytesToHex(randomBytes(8)) + '</html>';
  const text = new TextEncoder().encode(filler.padEnd(400, ' '));
  const res = await putBlob(alice, { bytes: text, hash: await sha256Hex(text), size: text.length });
  assert(res.status >= 400 && res.status < 500, 'arbitrary non locked bytes were accepted and are now served publicly: ' + brief(res));
  eq((await call('GET', '/api/blobs/' + (await sha256Hex(text)))).status, 404, 'nothing may be stored');
});

await check('upload header check: wrong magic, suite or iteration count, and files that are too short, are refused and leave nothing behind', async () => {
  const cases = {
    'wrong magic': { magic: 'HRDLOCK2' },
    'suite 2': { suite: 2 },
    'suite 0': { suite: 0 },
    'iterations below the minimum': { iterations: 99999 },
    'iterations above the maximum': { iterations: 2000001 },
    'iterations zero': { iterations: 0 }
  };
  for (const [name, header] of Object.entries(cases)) {
    const blob = await makeBlob(400, header);
    const res = await putBlob(alice, blob);
    assert(res.status === 400, name + ': ' + brief(res));
    eq((await call('GET', '/api/blobs/' + blob.hash)).status, 404, name + ' stored anyway');
  }
  const short = stampLockHeader(randomBytes(MIN_LOCKED - 1));
  const res = await putBlob(alice, { bytes: short, hash: await sha256Hex(short), size: short.length });
  assert(res.status === 400, 'too short: ' + brief(res));
  // the bounds themselves are accepted
  for (const iterations of [100000, 2000000]) {
    const blob = await makeBlob(MIN_LOCKED, { iterations });
    expectStatus(await putBlob(alice, blob), 201);
  }
  // a retry after a refused upload is not blocked by a leftover reservation
  const again = await makeBlob(400);
  expectStatus(await putBlob(alice, again), 201);
});

await check('a blob row only appears together with its stored object (no orphan rows)', async () => {
  const db = await openDb();
  assert(db, 'local database not found');
  const rows = db.prepare('SELECT hash, size FROM blobs ORDER BY created_at DESC LIMIT 20').all();
  for (const r of rows) {
    const head = await call('HEAD', '/api/blobs/' + r.hash);
    eq(head.status, 200, 'object for row ' + r.hash.slice(0, 8));
    eq(head.headers.get('content-length'), String(r.size), 'size for row ' + r.hash.slice(0, 8));
  }
});

void bytesToHex;
finish();
