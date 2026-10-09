const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CLOUD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hrdlock-test-'));
const server = require('../server.js');
const HRD = require('../public/hrdcipher.js');

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const original = Buffer.from('some bytes \u0000ÿ for the test', 'latin1');
  const password = HRD.generatePassword();
  const locked = await HRD.lock(original, 'notes.txt', password);

  // upload
  let res = await fetch(base + '/api/files', {
    method: 'POST', headers: { 'x-file-name': encodeURIComponent('notes.txt') }, body: locked
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual((await res.json()).name, 'notes.txt.hrdlock');

  // same name again gets a number
  res = await fetch(base + '/api/files', {
    method: 'POST', headers: { 'x-file-name': 'notes.txt' }, body: locked
  });
  assert.strictEqual((await res.json()).name, 'notes.txt (1).hrdlock');

  // a path in the name should not escape the folder
  res = await fetch(base + '/api/files', {
    method: 'POST', headers: { 'x-file-name': encodeURIComponent('..\\..\\evil.txt') }, body: locked
  });
  assert.strictEqual((await res.json()).name, 'evil.txt.hrdlock');

  // plain files are refused
  res = await fetch(base + '/api/files', { method: 'POST', body: Buffer.from('not locked at all') });
  assert.strictEqual(res.status, 400);

  // list
  res = await fetch(base + '/api/files');
  const list = await res.json();
  assert.strictEqual(list.length, 3);

  // download and unlock
  res = await fetch(base + '/api/files/' + encodeURIComponent('notes.txt.hrdlock'));
  const got = new Uint8Array(await res.arrayBuffer());
  const out = await HRD.unlock(got, password);
  assert.strictEqual(out.name, 'notes.txt');
  assert.deepStrictEqual(Buffer.from(out.data), original);

  // stored bytes do not contain the plain text
  assert.ok(!Buffer.from(got).includes(Buffer.from('for the test')));

  // path tricks on download
  res = await fetch(base + '/api/files/' + encodeURIComponent('../package.json'));
  assert.strictEqual(res.status, 400);
  res = await fetch(base + '/api/files/missing.hrdlock');
  assert.strictEqual(res.status, 404);

  // static files
  res = await fetch(base + '/');
  assert.strictEqual(res.status, 200);
  res = await fetch(base + '/..%2fserver.js');
  assert.strictEqual(res.status, 404);

  console.log('server tests passed');
  server.close();
  fs.rmSync(process.env.CLOUD_DIR, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
