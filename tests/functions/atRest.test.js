// Crypto at rest: the master key, the three derived keys, wrapping and unwrapping.
import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url } from '../../shared/encoding.js';
import {
  HKDF_INFO,
  WRAP_VERSION,
  aadFor,
  accountsConfigured,
  atRest,
  deriveSubkeys,
  hmacHex,
  parseMasterKey,
  resetAtRestCache,
  unwrap,
  wrap
} from '../../functions/_lib/atRest.js';
import { masterKeyText } from './fakes.js';

const bytes = (n, fill = 7) => new Uint8Array(n).fill(fill);
const toB64 = (u8) => btoa(String.fromCharCode(...u8));

describe('parseMasterKey', () => {
  it('accepts base64 of 32 bytes, with or without padding, standard or url alphabet, with spaces around', () => {
    const raw = new Uint8Array(32).map((_, i) => 250 - i * 3);
    const std = toB64(raw);
    expect(parseMasterKey(std)).toEqual(raw);
    expect(parseMasterKey(std.replace(/=+$/, ''))).toEqual(raw);
    expect(parseMasterKey(std.replace(/\+/g, '-').replace(/\//g, '_'))).toEqual(raw);
    expect(parseMasterKey('  ' + std + '\r\n')).toEqual(raw);
    expect(parseMasterKey(masterKeyText())).toHaveLength(32);
  });

  it('refuses everything else', () => {
    for (const bad of [undefined, null, 5, {}, '', ' ', 'short', toB64(bytes(31)), toB64(bytes(33)), toB64(bytes(16)), toB64(bytes(64)), '!'.repeat(44), 'A'.repeat(42), 'A'.repeat(45), toB64(bytes(32)) + '=', toB64(bytes(32)).slice(0, 40) + '%%%%', 'not base64 at all, not even close to it!!!!!']) {
      expect(parseMasterKey(bad), String(bad)).toBeNull();
    }
  });
});

describe('derived keys', () => {
  const master = bytes(32, 9);
  const expected = (info, text) => createHmac('sha256', Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32))).update(text).digest('hex');

  it('use HKDF-SHA256 with an empty salt and the three info strings', async () => {
    const keys = await deriveSubkeys(master);
    expect(HKDF_INFO).toEqual({ email: 'hrdlock/v3/email-hash', otp: 'hrdlock/v3/otp', wrap: 'hrdlock/v3/wrap' });
    expect(await hmacHex(keys.emailKey, 'a@example.test')).toBe(expected('hrdlock/v3/email-hash', 'a@example.test'));
    expect(await hmacHex(keys.otpKey, 'abc|123456')).toBe(expected('hrdlock/v3/otp', 'abc|123456'));
  });

  it('wrap key is the third HKDF output (AES-256-GCM)', async () => {
    const keys = await deriveSubkeys(master);
    const raw = new Uint8Array(hkdfSync('sha256', master, Buffer.alloc(0), 'hrdlock/v3/wrap', 32));
    const mine = await wrap(keys.wrapKey, bytes(10), aadFor('key', 'a', 'b'));
    const theirs = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const packed = base64UrlToBytes(mine);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(1, 13), additionalData: aadFor('key', 'a', 'b') }, theirs, packed.slice(13));
    expect(new Uint8Array(plain)).toEqual(bytes(10));
  });

  it('are independent of each other and of the master key', async () => {
    const a = await deriveSubkeys(master);
    const b = await deriveSubkeys(bytes(32, 10));
    const same = async (k) => hmacHex(k, 'x');
    expect(await same(a.emailKey)).not.toBe(await same(a.otpKey));
    expect(await same(a.emailKey)).not.toBe(await same(b.emailKey));
    expect(await same(a.emailKey)).toBe(await same((await deriveSubkeys(master)).emailKey));
  });

  it('keys can not be exported', async () => {
    const keys = await deriveSubkeys(master);
    for (const k of Object.values(keys)) await expect(crypto.subtle.exportKey('raw', k)).rejects.toThrow();
  });
});

describe('wrap and unwrap', () => {
  async function key() {
    return (await deriveSubkeys(bytes(32, 3))).wrapKey;
  }
  const aad = aadFor('secret', 'acc', 'doc');

  it('round trips bytes of every size', async () => {
    const k = await key();
    for (const n of [0, 1, 15, 16, 17, 255, 4096, 100000]) {
      const plain = new Uint8Array(n);
      for (let o = 0; o < n; o += 65536) crypto.getRandomValues(plain.subarray(o, Math.min(n, o + 65536)));
      expect(await unwrap(k, await wrap(k, plain, aad), aad), 'size ' + n).toEqual(plain);
    }
  });

  it('writes version byte 1, a 12 byte iv, then ciphertext and a 16 byte tag, as base64url', async () => {
    const k = await key();
    const text = await wrap(k, bytes(20), aad);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    const raw = base64UrlToBytes(text);
    expect(raw[0]).toBe(WRAP_VERSION);
    expect(raw[0]).toBe(0x01);
    expect(raw.length).toBe(1 + 12 + 20 + 16);
    expect(bytesToBase64Url(raw)).toBe(text);
  });

  it('uses a fresh iv every time', async () => {
    const k = await key();
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(base64UrlToBytes(await wrap(k, bytes(4), aad)).slice(1, 13).join(','));
    expect(seen.size).toBe(50);
    expect(await wrap(k, bytes(4), aad)).not.toBe(await wrap(k, bytes(4), aad));
  });

  it('refuses any changed byte (version, iv, ciphertext, tag), a short value and extra bytes', async () => {
    const k = await key();
    const raw = base64UrlToBytes(await wrap(k, bytes(30), aad));
    for (let i = 0; i < raw.length; i++) {
      const t = raw.slice();
      t[i] ^= 1;
      await expect(unwrap(k, bytesToBase64Url(t), aad), 'byte ' + i).rejects.toThrow('could not open the stored value');
    }
    await expect(unwrap(k, bytesToBase64Url(raw.slice(0, raw.length - 1)), aad)).rejects.toThrow();
    await expect(unwrap(k, bytesToBase64Url(raw.slice(0, 20)), aad)).rejects.toThrow();
    await expect(unwrap(k, bytesToBase64Url(new Uint8Array([...raw, 0])), aad)).rejects.toThrow();
    await expect(unwrap(k, '', aad)).rejects.toThrow();
  });

  it('refuses a wrong version byte even when the rest is intact', async () => {
    const k = await key();
    const raw = base64UrlToBytes(await wrap(k, bytes(8), aad));
    for (const v of [0, 2, 3, 255]) {
      const t = raw.slice();
      t[0] = v;
      await expect(unwrap(k, bytesToBase64Url(t), aad), 'version ' + v).rejects.toThrow();
    }
  });

  it('refuses a wrong aad: purpose, account or id', async () => {
    const k = await key();
    const text = await wrap(k, bytes(8), aadFor('secret', 'acc', 'doc'));
    expect(await unwrap(k, text, aadFor('secret', 'acc', 'doc'))).toEqual(bytes(8));
    for (const wrong of [aadFor('key', 'acc', 'doc'), aadFor('secret', 'acc2', 'doc'), aadFor('secret', 'acc', 'doc2'), aadFor('secret', 'acc', 'doc|'), aadFor('secret|acc', '', 'doc'), new Uint8Array(0)]) {
      await expect(unwrap(k, text, wrong)).rejects.toThrow('could not open the stored value');
    }
  });

  it('refuses a wrong key', async () => {
    const k = await key();
    const other = (await deriveSubkeys(bytes(32, 4))).wrapKey;
    await expect(unwrap(other, await wrap(k, bytes(8), aad), aad)).rejects.toThrow();
  });

  it('refuses text that is not base64url (padding, plus, slash, spaces, non strings)', async () => {
    const k = await key();
    const good = await wrap(k, bytes(8), aad);
    for (const bad of [good + '=', good.replace(/[-_]/, '+') + '+', good + ' ', ' ' + good, good + '\n', null, undefined, 5, {}]) {
      await expect(unwrap(k, bad, aad)).rejects.toThrow();
    }
  });

  it('the error never carries any input', async () => {
    const k = await key();
    const secretLooking = 'SECRET-PASSWORD-VALUE';
    const text = await wrap(k, new TextEncoder().encode(secretLooking), aad);
    const t = base64UrlToBytes(text);
    t[20] ^= 1;
    try {
      await unwrap(k, bytesToBase64Url(t), aadFor('secret', 'acc-id-1', 'doc-id-1'));
    } catch (err) {
      expect(err.message).toBe('could not open the stored value');
      expect(String(err.stack)).not.toContain(secretLooking);
      expect(String(err.stack)).not.toContain('acc-id-1');
    }
  });
});

describe('atRest(env)', () => {
  it('throws 503 accounts_unavailable for a missing or bad master key', async () => {
    for (const v of [undefined, '', '   ', 'x', toB64(bytes(31))]) {
      await expect(atRest({ ACCOUNT_MASTER_KEY: v }), String(v)).rejects.toMatchObject({ code: 'accounts_unavailable', status: 503 });
    }
    await expect(atRest({})).rejects.toMatchObject({ code: 'accounts_unavailable' });
    await expect(atRest(null)).rejects.toMatchObject({ code: 'accounts_unavailable' });
  });

  it('never prints the key when it is malformed', async () => {
    const logged = [];
    const orig = console.error;
    console.error = (...a) => logged.push(a.join(' '));
    try {
      await expect(atRest({ ACCOUNT_MASTER_KEY: 'definitely-not-a-key-' + 'Z'.repeat(30) })).rejects.toThrow();
    } finally {
      console.error = orig;
    }
    expect(logged.join('\n')).not.toContain('definitely-not-a-key');
  });

  it('hashes an email the same way twice and differently for different emails and keys', async () => {
    resetAtRestCache();
    const a = await atRest({ ACCOUNT_MASTER_KEY: masterKeyText() });
    const b = await atRest({ ACCOUNT_MASTER_KEY: masterKeyText() });
    const h = await a.emailHash('a@example.test');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await a.emailHash('a@example.test')).toBe(h);
    expect(await a.emailHash('b@example.test')).not.toBe(h);
    expect(await b.emailHash('a@example.test')).not.toBe(h);
    expect(await a.codeHash(h, '123456')).not.toBe(await a.codeHash(h, '123457'));
    expect(await a.codeHash(h, '123456')).not.toBe(await a.codeHash('0'.repeat(64), '123456'));
  });

  it('wraps and unwraps with purpose, account and id', async () => {
    const env = { ACCOUNT_MASTER_KEY: masterKeyText() };
    const ar = await atRest(env);
    const text = await ar.wrap(new TextEncoder().encode('hello'), 'secret', 'acc', 'doc');
    expect(new TextDecoder().decode(await ar.unwrap(text, 'secret', 'acc', 'doc'))).toBe('hello');
    await expect(ar.unwrap(text, 'key', 'acc', 'doc')).rejects.toThrow();
    // a second instance made from the same text opens it, one from another key does not
    resetAtRestCache();
    expect(new TextDecoder().decode(await (await atRest(env)).unwrap(text, 'secret', 'acc', 'doc'))).toBe('hello');
    await expect((await atRest({ ACCOUNT_MASTER_KEY: masterKeyText() })).unwrap(text, 'secret', 'acc', 'doc')).rejects.toThrow();
  });

  it('accountsConfigured says whether the key is usable', () => {
    expect(accountsConfigured({ ACCOUNT_MASTER_KEY: masterKeyText() })).toBe(true);
    expect(accountsConfigured({ ACCOUNT_MASTER_KEY: 'nope' })).toBe(false);
    expect(accountsConfigured({})).toBe(false);
    expect(accountsConfigured(undefined)).toBe(false);
  });
});
