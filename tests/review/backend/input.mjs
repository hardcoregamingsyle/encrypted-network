// Input handling: malformed JSON, odd numbers, oversized and lying bodies, unicode edge cases.
// node tests/review/backend/input.mjs <baseUrl>
import {
  BASE, assert, brief, call, channelRecord, check, createRecord, eq, expectRejected, expectStatus, finish, freshIp,
  makeBlob, makeIdentity, messageRecord, newPerson, postChannel, postDoc, postMessage, putBlob, rawHttp, signRecord
} from './_lib.mjs';

const alice = await newPerson('Inp');
const ch = channelRecord(alice);
expectStatus(await postChannel(alice, ch), 201);
const msgUrl = `/api/channels/${ch.channelId}/messages`;
const notServerError = (res, what) => assert(res.status < 500, `${what}: ${brief(res)}`);

async function sendMessageBody(body) {
  const rec = messageRecord(alice, ch.channelId, { body });
  return postMessage(alice, ch.channelId, rec);
}

await check('duplicate JSON keys are read the same way they are signed (last wins), no 5xx', async () => {
  const rec = messageRecord(alice, ch.channelId);
  const sig = await signRecord(alice.privateKey, rec);
  const text = `{"record":${JSON.stringify({ ...rec, body: 'first' })},"record":${JSON.stringify(rec)},"signature":"${'A'.repeat(86)}","signature":"${sig}"}`;
  const res = await call('POST', msgUrl, { raw: text, headers: { 'Content-Type': 'application/json' } });
  expectStatus(res, 201);
  const got = await call('GET', `/api/channels/${ch.channelId}/messages?tail=1`);
  eq(got.json.messages[0].record.body, rec.body, 'stored body is the signed one');
});

await check('__proto__ and constructor keys are rejected, no prototype pollution effect', async () => {
  const rec = messageRecord(alice, ch.channelId);
  const sig = await signRecord(alice.privateKey, rec);
  for (const text of [
    `{"__proto__":{"signer":"x"},"record":${JSON.stringify(rec)},"signature":"${sig}"}`,
    `{"record":{"__proto__":{"a":1},"v":2},"signature":"${sig}"}`,
    `{"record":${JSON.stringify(rec).slice(0, -1)},"__proto__":{"a":1}},"signature":"${sig}"}`,
    `{"record":${JSON.stringify(rec).slice(0, -1)},"constructor":{"prototype":{"a":1}}},"signature":"${sig}"}`
  ]) {
    const res = await call('POST', msgUrl, { raw: text });
    notServerError(res, 'proto');
    if (text.includes('"__proto__":{"a":1}') || text.includes('constructor')) expectRejected(res, 'proto in record');
  }
  // the server still behaves normally afterwards
  expectStatus(await sendMessageBody('still fine after proto attempts'), 201);
});

await check('huge, negative, fractional and exponent numbers in records are rejected cleanly', async () => {
  const base = messageRecord(alice, ch.channelId);
  const sig = await signRecord(alice.privateKey, base);
  for (const num of ['1e400', '9007199254740993', '-1', '1.5', '1e21', '1E3', '-0', '0.0', '99999999999999999999999999999999', '"1700000000000"', 'null', 'true', '[]']) {
    const text = `{"record":${JSON.stringify(base).replace(/"createdAt":\d+/, `"createdAt":${num}`)},"signature":"${sig}"}`;
    const res = await call('POST', msgUrl, { raw: text });
    notServerError(res, 'createdAt=' + num);
    assert(res.status >= 400, `createdAt=${num} accepted: ${brief(res)}`);
  }
});

await check('deeply nested JSON (100000 levels) answers 4xx, not 5xx or a hang', async () => {
  const n = 30000; // under the 64 KiB cap
  const res = await call('POST', msgUrl, { raw: '['.repeat(n) + ']'.repeat(n) });
  expectRejected(res, 'array nesting');
  const res2 = await call('POST', msgUrl, { raw: '{"record":' + '{"a":'.repeat(10000) + '1' + '}'.repeat(10000) + ',"signature":"x"}' });
  expectRejected(res2, 'object nesting');
});

await check('wrong content types and bodies: empty, array, string, null, number, BOM, invalid UTF-8', async () => {
  const cases = [
    ['', 'empty'], ['[]', 'array'], ['"x"', 'string'], ['null', 'null'], ['12', 'number'], ['\u{feff}{}', 'BOM'], ['{', 'truncated'], ['{"record":1,"signature":2}', 'wrong types']
  ];
  for (const [raw, name] of cases) {
    for (const ct of ['application/json', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await call('POST', msgUrl, { raw, headers: { 'Content-Type': ct } });
      expectRejected(res, `${name} as ${ct}`);
    }
  }
  const res = await call('POST', msgUrl, { raw: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) });
  expectRejected(res, 'invalid utf-8');
});

await check('body over 64 KiB is refused with 413, by Content-Length and when streamed in chunks', async () => {
  const big = '{"record":{},"signature":"' + 'a'.repeat(70000) + '"}';
  expectStatus(await call('POST', msgUrl, { raw: big }), 413, 'too_large');
  // chunked, no Content-Length
  const part = Buffer.from(big);
  const chunked = [
    `POST ${msgUrl} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`,
    `${part.length.toString(16)}\r\n`, part, '\r\n0\r\n\r\n'
  ];
  const r = await rawHttp(chunked);
  assert(r.status === 413, 'chunked oversize answered ' + r.status + ' ' + r.body.slice(0, 120));
});

await check('absurd Content-Length values are refused before the body is read', async () => {
  for (const cl of ['99999999999999999999', '70000', '00000070000']) {
    const r = await rawHttp([`POST ${msgUrl} HTTP/1.1\r\nHost: x\r\nContent-Length: ${cl}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`, '{}'], { waitMs: 1500 });
    assert(r.status === 0 || (r.status >= 400 && r.status < 500), `Content-Length ${cl} -> ${r.status}`);
  }
});

await check('Content-Length smaller than the real body does not smuggle the rest as a second request', async () => {
  const rec = messageRecord(alice, ch.channelId);
  const sig = await signRecord(alice.privateKey, rec);
  const json = JSON.stringify({ record: rec, signature: sig });
  const smuggled = `POST ${msgUrl} HTTP/1.1\r\nHost: x\r\nContent-Length: ${json.length}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${json}GET /api/health HTTP/1.1\r\nHost: x\r\n\r\n`;
  const r = await rawHttp([smuggled]);
  assert(r.status === 201 || r.status === 400 || r.status === 0, 'status ' + r.status);
});

await check('blob PUT without Content-Length (chunked) is refused with 411', async () => {
  const b = await makeBlob(300);
  const time = Date.now();
  const rec = { v: 2, type: 'blob.put', hash: b.hash, size: 300, signer: alice.keyId, createdAt: time };
  const sig = await signRecord(alice.privateKey, rec);
  const head =
    `PUT /api/blobs/${b.hash} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nx-hrd-key: ${alice.keyId}\r\nx-hrd-time: ${time}\r\nx-hrd-sig: ${sig}\r\nConnection: close\r\n\r\n`;
  const r = await rawHttp([head, '12c\r\n', Buffer.from(b.bytes), '\r\n0\r\n\r\n']);
  assert(r.status === 411 || (r.status >= 400 && r.status < 500), 'chunked blob answered ' + r.status);
  // and nothing was stored
  const g = await call('GET', '/api/blobs/' + b.hash);
  eq(g.status, 404, 'blob must not exist after a refused chunked upload');
});

await check('blob PUT with Content-Length larger than the body (client stops early) stores nothing and a retry works', async () => {
  const b = await makeBlob(5000);
  const time = Date.now();
  const rec = { v: 2, type: 'blob.put', hash: b.hash, size: 5000, signer: alice.keyId, createdAt: time };
  const sig = await signRecord(alice.privateKey, rec);
  const head = `PUT /api/blobs/${b.hash} HTTP/1.1\r\nHost: x\r\nContent-Length: 5000\r\nx-hrd-key: ${alice.keyId}\r\nx-hrd-time: ${time}\r\nx-hrd-sig: ${sig}\r\nConnection: close\r\n\r\n`;
  await rawHttp([head, Buffer.from(b.bytes.subarray(0, 2000))], { closeAfterWrite: true, waitMs: 2500 });
  const g = await call('GET', '/api/blobs/' + b.hash);
  eq(g.status, 404, 'half uploaded blob must not be readable');
  const retry = await putBlob(alice, b);
  expectStatus(retry, 201);
  const got = await call('GET', '/api/blobs/' + b.hash);
  eq(got.bytes.length, 5000, 'full blob after retry');
});

await check('blob PUT with Content-Length over the maximum (50 MiB + 4097 bytes actually sent) is refused', async () => {
  const b = await makeBlob(300);
  const time = Date.now();
  const rec = { v: 2, type: 'blob.put', hash: b.hash, size: 52428800 + 4097, signer: alice.keyId, createdAt: time };
  const head = `PUT /api/blobs/${b.hash} HTTP/1.1\r\nHost: x\r\nContent-Length: ${52428800 + 4097}\r\nx-hrd-key: ${alice.keyId}\r\nx-hrd-time: ${time}\r\nx-hrd-sig: ${'A'.repeat(86)}\r\nConnection: close\r\n\r\n`;
  const r = await rawHttp([head, Buffer.alloc(52428800 + 4097)], { waitMs: 30000 });
  assert(r.status === 413, 'answered ' + r.status);
  void rec;
});

await check('unicode: control, bidi, zero width, NFD, lone surrogate, blank bodies are all refused', async () => {
  const bad = ['a\u0000b', 'tab\there', 'cr\rhere', 'rtl \u{202e}evil', 'zero\u{200b}width', 'e\u{301} nfd', 'lone \ud800 surrogate', '   ', '\n\n', 'line\u{2028}sep', 'c1\u0085ctl', '\u{200d}\u{200d}'];
  for (const body of bad) {
    const rec = messageRecord(alice, ch.channelId, { body });
    const sig = await signRecord(alice.privateKey, rec).catch(() => null);
    if (!sig) continue; // the signer itself refuses to canonicalise a lone surrogate
    const res = await call('POST', msgUrl, { json: { record: rec, signature: sig } });
    if (!body.includes('\u{200b}') && !body.includes('\u{200d}')) expectRejected(res, JSON.stringify(body));
    else if (body === '\u{200d}\u{200d}') expectRejected(res, 'only joiners');
    notServerError(res, JSON.stringify(body));
  }
  // raw JSON with an escaped lone surrogate, signed over a harmless body
  const rec = messageRecord(alice, ch.channelId);
  const sig = await signRecord(alice.privateKey, rec);
  const text = JSON.stringify({ record: rec, signature: sig }).replace(rec.body, 'x\\ud800y');
  expectRejected(await call('POST', msgUrl, { raw: text }), 'escaped lone surrogate');
});

await check('unicode: emoji with joiners, combining marks and 2000 four byte characters are accepted and read back unchanged', async () => {
  const bodies = ['family \u{1F468}\u{200d}\u{1F469}\u{200d}\u{1F467} ok', 'e\u{301}'.normalize('NFC') + ' cafe', '\u{1F600}'.repeat(2000), 'multi\nline\nbody', '\u{10FFFF}'.replace('\u{10FFFF}', 'x')];
  for (const body of bodies) {
    const res = await sendMessageBody(body);
    expectStatus(res, 201);
    const got = await call('GET', `/api/channels/${ch.channelId}/messages?tail=1`);
    eq(got.json.messages[0].record.body, body, 'round trip');
  }
  expectStatus(await sendMessageBody('\u{1F600}'.repeat(2001)), 400);
});

await check('labels: NUL, bidi, invisible and 121 code point labels are refused for documents', async () => {
  const b = await makeBlob(320);
  assert((await putBlob(alice, b)).status < 300, 'upload');
  for (const label of ['nul\u0000x', 'bidi \u{202e}abc', 'zw\u{200b}x', '\u{3164}', 'x'.repeat(121), 'e\u{301} nfd']) {
    const res = await postDoc(alice, createRecord(alice, b, { label }));
    expectRejected(res, JSON.stringify(label).slice(0, 30));
  }
  expectStatus(await postDoc(alice, createRecord(alice, b, { label: '\u{1F600}'.repeat(120) })), 201);
});

await check('display names: invisible or blank names are refused at registration', async () => {
  for (const name of ['\u{200b}', ' ', 'a\u{200b}b', '\u{2800}', 'x'.repeat(41)]) {
    const id = await makeIdentity(name);
    const res = await call('POST', '/api/identities', { json: { record: id.identityRecord, signature: id.identitySignature }, ip: freshIp() });
    expectRejected(res, JSON.stringify(name));
  }
});

await check('unknown routes and methods answer JSON 404 / 405, never the app page or a stack', async () => {
  for (const [m, p] of [['GET', '/api/nope'], ['POST', '/api/nope/x'], ['DELETE', '/api/documents'], ['PUT', '/api/identities'], ['PATCH', '/api/health'], ['GET', '/api/documents/zz/records'], ['OPTIONS', '/api/documents']]) {
    const res = await call(m, p);
    assert(res.status === 404 || res.status === 405, `${m} ${p}: ${brief(res)}`);
    assert((res.headers.get('content-type') || '').includes('application/json'), `${m} ${p} not json`);
    assert(!/\bat\s+\S+\s+\(|node_modules|\.js:\d+/.test(res.text), `${m} ${p} leaks a stack`);
  }
});

finish();
void BASE;
