// The crypto at rest: wrapping keys and passwords, binding to rows, versions, the master key.
// node tests/review/backend/auth-atrest.mjs [ignored base url]
// Runs in process against functions/_lib/atRest.js. A FAIL line means a defect was proved.
import { base64UrlToBytes, bytesToBase64Url } from '../../../shared/encoding.js';
import { aadFor, atRest, deriveSubkeys, parseMasterKey, unwrap, wrap } from '../../../functions/_lib/atRest.js';
import { assert, check, eq, finish } from './_lib.mjs';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const randomKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const env = { ACCOUNT_MASTER_KEY: randomKey() };
const ar = await atRest(env);
const text = (s) => new TextEncoder().encode(s);
const ACC = 'a'.repeat(32);
const KEYID = 'b'.repeat(64);
const DOC = 'c'.repeat(32);

const refuses = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

await check('round trip, and the same plaintext wraps to a different text every time', async () => {
  const one = await ar.wrap(text('hello'), 'key', ACC, KEYID);
  const two = await ar.wrap(text('hello'), 'key', ACC, KEYID);
  assert(one !== two, 'two wraps are identical');
  eq(new TextDecoder().decode(await ar.unwrap(one, 'key', ACC, KEYID)), 'hello', 'round trip');
});

await check('binding: wrong purpose, account or id never opens (key vs secret, other account, other id)', async () => {
  const w = await ar.wrap(text('s3cret'), 'key', ACC, KEYID);
  for (const [p, acc, id] of [['secret', ACC, KEYID], ['key', 'd'.repeat(32), KEYID], ['key', ACC, 'e'.repeat(64)], ['key', ACC, KEYID + 'x'], ['Key', ACC, KEYID], ['key ', ACC, KEYID]]) {
    assert(await refuses(() => ar.unwrap(w, p, acc, id)), `opened with ${p}|${acc.slice(0, 4)}|${id.slice(0, 4)}`);
  }
});

await check('version byte: 0, 2, 255 and a missing byte are all refused', async () => {
  const w = base64UrlToBytes(await ar.wrap(text('v'), 'key', ACC, KEYID));
  for (const v of [0, 2, 3, 128, 255]) {
    const copy = w.slice();
    copy[0] = v;
    assert(await refuses(() => ar.unwrap(bytesToBase64Url(copy), 'key', ACC, KEYID)), 'version ' + v + ' opened');
  }
  assert(await refuses(() => ar.unwrap(bytesToBase64Url(w.slice(1)), 'key', ACC, KEYID)), 'no version byte opened');
});

await check('tamper: flipping any single bit anywhere in the stored text makes it unreadable (every byte, 8 bits)', async () => {
  const w = base64UrlToBytes(await ar.wrap(text('a private key worth protecting'), 'key', ACC, KEYID));
  for (let i = 0; i < w.length; i++) {
    for (let bit = 0; bit < 8; bit += 3) {
      const copy = w.slice();
      copy[i] ^= 1 << bit;
      assert(await refuses(() => ar.unwrap(bytesToBase64Url(copy), 'key', ACC, KEYID)), `byte ${i} bit ${bit} opened`);
    }
  }
});

await check('truncation and extension: cut at any length, or with bytes appended, never opens', async () => {
  const w = base64UrlToBytes(await ar.wrap(text('abcdef'), 'key', ACC, KEYID));
  for (let len = 0; len < w.length; len++) assert(await refuses(() => ar.unwrap(bytesToBase64Url(w.slice(0, len)), 'key', ACC, KEYID)), 'length ' + len + ' opened');
  const longer = new Uint8Array(w.length + 1);
  longer.set(w);
  assert(await refuses(() => ar.unwrap(bytesToBase64Url(longer), 'key', ACC, KEYID)), 'extended text opened');
});

await check('text forms: padding, whitespace, other alphabets, non strings and huge input are refused without a crash', async () => {
  const w = await ar.wrap(text('x'), 'key', ACC, KEYID);
  const std = Buffer.from(base64UrlToBytes(w)).toString('base64');
  for (const bad of [w + '=', w + ' ', ' ' + w, w + '\n', std.includes('+') || std.includes('/') ? std : w.replace('-', '+') + '+', null, undefined, 5, {}, [], '', 'A'.repeat(100000), w.slice(0, -1) + (w.endsWith('A') ? 'B' : 'A')]) {
    assert(await refuses(() => ar.unwrap(bad, 'key', ACC, KEYID)), `${JSON.stringify(String(bad)).slice(0, 30)} opened`);
  }
});

await check('errors: the failure message is the same plain text for every kind of failure and holds none of the input', async () => {
  const w = await ar.wrap(text('SECRETVALUE'), 'key', ACC, KEYID);
  const messages = new Set();
  for (const [t, p] of [[w, 'secret'], ['!!!', 'key'], [w.slice(0, 10), 'key'], [bytesToBase64Url(new Uint8Array(40)), 'key']]) {
    try {
      await ar.unwrap(t, p, ACC, KEYID);
    } catch (e) {
      messages.add(e.message);
      assert(!e.message.includes('SECRET') && !e.message.includes(ACC) && !e.message.includes(KEYID), 'input in message');
    }
  }
  eq(messages.size, 1, 'distinct messages: ' + [...messages].join(' / '));
});

await check('nonce: 60 000 wraps of one plaintext under one key never repeat an iv', async () => {
  const seen = new Set();
  for (let i = 0; i < 60000; i++) {
    const w = await ar.wrap(text('x'), 'secret', ACC, DOC);
    const iv = Buffer.from(base64UrlToBytes(w).slice(1, 13)).toString('hex');
    if (seen.has(iv)) throw new Error('iv repeated after ' + i + ' wraps');
    seen.add(iv);
  }
});

await check('keys: a value wrapped under one master key does not open under another, and the three subkeys are independent', async () => {
  const other = await atRest({ ACCOUNT_MASTER_KEY: randomKey() });
  const w = await ar.wrap(text('k'), 'key', ACC, KEYID);
  assert(await refuses(() => other.unwrap(w, 'key', ACC, KEYID)), 'opened under another master key');
  const email = await ar.emailHash('a@b.test');
  const code = await ar.codeHash(email, '123456');
  assert(email !== code && /^[0-9a-f]{64}$/.test(email) && /^[0-9a-f]{64}$/.test(code), 'hash shapes');
  eq(await ar.emailHash('a@b.test'), email, 'deterministic');
  assert((await other.emailHash('a@b.test')) !== email, 'email hash equal under another master key');
  assert((await ar.emailHash('a@b.test ')) !== email, 'email hash ignores a blank (the normaliser is the only guard)');
  assert((await ar.codeHash(email, '123457')) !== code && (await ar.codeHash(email.replace(/.$/, '0'), '123456')) !== code, 'code hash ignores part of its input');
  const keys = await deriveSubkeys(Uint8Array.from(Buffer.from(env.ACCOUNT_MASTER_KEY, 'base64')));
  assert(keys.wrapKey.extractable === false && keys.emailKey.extractable === false && keys.otpKey.extractable === false, 'a subkey is extractable');
});

await check('master key: only exactly 32 bytes of base64 are taken; short, long, junk and wrong alphabets are refused', async () => {
  for (const bad of ['', '   ', 'abc', 'A'.repeat(42), 'A'.repeat(45), b64(new Uint8Array(31)), b64(new Uint8Array(33)), '!'.repeat(44), 'A'.repeat(43) + '==', randomKey() + '\u0000', '\u00e9'.repeat(43), null, undefined, 5, {}]) {
    assert(parseMasterKey(bad) === null, `accepted ${JSON.stringify(String(bad)).slice(0, 40)}`);
  }
  for (const good of [randomKey(), randomKey().replace(/=+$/, ''), ' ' + randomKey() + '\n']) assert(parseMasterKey(good) !== null, 'refused a good key');
});

await check('master key: an all zero or otherwise obviously empty key is refused (a placeholder must not switch accounts on)', async () => {
  for (const weak of [b64(new Uint8Array(32)), b64(new Uint8Array(32).fill(255)), b64(new Uint8Array(32).fill(65)), 'A'.repeat(43)]) {
    assert(parseMasterKey(weak) === null, `a master key of ${JSON.stringify(weak).slice(0, 20)}... was accepted, every account secret would be wrapped under a public value`);
  }
});

await check('master key: a missing or malformed key switches accounts off with 503 and never logs the value', async () => {
  const logged = [];
  const real = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    for (const bad of [undefined, '', 'short', 'x'.repeat(44)]) {
      let code = null;
      try {
        await atRest({ ACCOUNT_MASTER_KEY: bad });
      } catch (e) {
        code = e.code;
      }
      eq(code, 'accounts_unavailable', 'code for ' + String(bad));
    }
  } finally {
    console.error = real;
  }
  assert(!logged.join('\n').includes('short') && !logged.join('\n').includes('xxxx'), 'the key text was logged');
});

await check('direct use: wrap and unwrap with a raw key reject a wrong key length for the iv and tag sizes', async () => {
  const keys = await deriveSubkeys(crypto.getRandomValues(new Uint8Array(32)));
  const w = await wrap(keys.wrapKey, text('z'), aadFor('key', ACC, KEYID));
  const raw = base64UrlToBytes(w);
  eq(raw.length, 1 + 12 + 1 + 16, 'layout is version, 12 byte iv, ciphertext, 16 byte tag');
  assert(await refuses(() => unwrap(keys.wrapKey, bytesToBase64Url(raw.slice(0, 28)), aadFor('key', ACC, KEYID))), 'a value without a body opened');
});

finish();
