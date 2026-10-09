// Adversarial review of the record validators.
import { describe, expect, it } from 'vitest';
import { validateRecord } from '../../../shared/records.js';
import { validateCheckpointPayload } from '../../../shared/checkpoint.js';
import { createIdentity } from '../../helpers/bundle.js';

const H = (c) => c.repeat(64);
const D = 'd'.repeat(32);

async function samples() {
  const id = await createIdentity('Alice');
  return {
    identity: { v: 2, type: 'identity', publicKey: id.publicJwk, displayName: 'Alice', createdAt: 1000 },
    'doc.create': { v: 2, type: 'doc.create', docId: D, version: 1, prev: H('0'), signer: H('a'), createdAt: 1000, label: 'Lease', listed: true, blob: { hash: H('b'), size: 100, suite: 1 }, commitment: H('c') },
    'doc.update': { v: 2, type: 'doc.update', docId: D, version: 2, prev: H('e'), signer: H('a'), createdAt: 1000, label: 'Lease', blob: { hash: H('b'), size: 100, suite: 1 }, commitment: H('c') },
    'doc.revoke': { v: 2, type: 'doc.revoke', docId: D, version: 2, prev: H('e'), signer: H('a'), createdAt: 1000, reason: 'withdrawn' },
    'channel.create': { v: 2, type: 'channel.create', channelId: 'room-1', title: 'Room', docId: '', signer: H('a'), createdAt: 1000 },
    message: { v: 2, type: 'message', channelId: 'room-1', body: 'hello', replyTo: '', signer: H('a'), createdAt: 1000, nonce: 'f'.repeat(32) },
    'blob.put': { v: 2, type: 'blob.put', hash: H('b'), size: 10, signer: H('a'), createdAt: 1000 },
    checkpoint: { v: 2, type: 'checkpoint', scope: 'ledger', seq: 3, hash: H('9'), signedAt: 1000, serverKeyId: H('a') }
  };
}

const set = (path, value) => (r) => {
  const copy = structuredClone(r);
  let cur = copy;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
  if (value === undefined) delete cur[path[path.length - 1]];
  else cur[path[path.length - 1]] = value;
  return copy;
};

describe('every sample is valid before it is attacked', () => {
  it('samples validate', async () => {
    const s = await samples();
    for (const [type, rec] of Object.entries(s)) expect(validateRecord(rec), type).toEqual({ ok: true });
  });
});

describe('field attacks that must all be rejected', () => {
  const cases = [];
  const add = (type, name, fn) => cases.push([type, name, fn]);
  const common = ['identity', 'doc.create', 'doc.update', 'doc.revoke', 'channel.create', 'message', 'blob.put'];
  for (const t of common) {
    add(t, 'v as string', set(['v'], '2'));
    add(t, 'v 3', set(['v'], 3));
    add(t, 'v 2.0000001', set(['v'], 2.0000001));
    add(t, 'createdAt negative', set(['createdAt'], -1));
    add(t, 'createdAt float', set(['createdAt'], 1.5));
    add(t, 'createdAt string', set(['createdAt'], '1000'));
    add(t, 'createdAt beyond date range', set(['createdAt'], 8.64e15 + 1));
    add(t, 'createdAt unsafe integer', set(['createdAt'], 2 ** 53));
    add(t, 'createdAt NaN', set(['createdAt'], NaN));
    add(t, 'createdAt null', set(['createdAt'], null));
    add(t, 'extra top level field', (r) => ({ ...r, extra: 1 }));
    add(t, 'extra __proto__ own field', (r) => JSON.parse(JSON.stringify(r).replace(/^\{/, '{"__proto__":{"x":1},')));
    add(t, 'extra constructor field', (r) => ({ ...r, constructor: 1 }));
    add(t, 'missing createdAt', set(['createdAt'], undefined));
    add(t, 'missing v', set(['v'], undefined));
    add(t, 'type with trailing space', set(['type'], t + ' '));
    add(t, 'type uppercase', set(['type'], t.toUpperCase()));
  }
  for (const t of ['doc.create', 'doc.update', 'doc.revoke']) {
    for (const f of ['docId', 'prev', 'signer']) {
      const len = f === 'docId' ? 32 : 64;
      add(t, `${f} uppercase`, set([f], 'A'.repeat(len)));
      add(t, `${f} one char short`, set([f], 'a'.repeat(len - 1)));
      add(t, `${f} one char long`, set([f], 'a'.repeat(len + 1)));
      add(t, `${f} trailing newline`, set([f], 'a'.repeat(len - 1) + '\n'));
      add(t, `${f} non hex`, set([f], 'g'.repeat(len)));
      add(t, `${f} number`, set([f], 12));
      add(t, `${f} empty`, set([f], ''));
      add(t, `${f} with 0x`, set([f], '0x' + 'a'.repeat(len - 2)));
    }
    add(t, 'version string', set(['version'], '2'));
    add(t, 'version 0', set(['version'], 0));
    add(t, 'version negative', set(['version'], -2));
    add(t, 'version float', set(['version'], 2.5));
    add(t, 'version beyond safe range', set(['version'], 2 ** 53));
  }
  add('doc.create', 'version 2', set(['version'], 2));
  add('doc.create', 'prev not zero', set(['prev'], H('1')));
  add('doc.update', 'version 1', set(['version'], 1));
  add('doc.update', 'prev zero', set(['prev'], H('0')));
  add('doc.revoke', 'version 1', set(['version'], 1));
  add('doc.revoke', 'prev zero', set(['prev'], H('0')));
  add('doc.revoke', 'blob present', (r) => ({ ...r, blob: { hash: H('b'), size: 1, suite: 1 } }));
  add('doc.revoke', 'commitment present', (r) => ({ ...r, commitment: H('c') }));
  add('doc.update', 'listed present', (r) => ({ ...r, listed: true }));
  add('doc.create', 'listed missing', set(['listed'], undefined));
  add('doc.create', 'listed as string', set(['listed'], 'true'));
  add('doc.create', 'listed as 1', set(['listed'], 1));
  for (const t of ['doc.create', 'doc.update']) {
    add(t, 'blob missing', set(['blob'], undefined));
    add(t, 'blob array', set(['blob'], []));
    add(t, 'blob null', set(['blob'], null));
    add(t, 'blob extra field', set(['blob', 'extra'], 1));
    add(t, 'blob.hash uppercase', set(['blob', 'hash'], 'B'.repeat(64)));
    add(t, 'blob.hash short', set(['blob', 'hash'], 'b'.repeat(63)));
    add(t, 'blob.size 0', set(['blob', 'size'], 0));
    add(t, 'blob.size negative', set(['blob', 'size'], -5));
    add(t, 'blob.size float', set(['blob', 'size'], 10.5));
    add(t, 'blob.size above max', set(['blob', 'size'], 52428800 + 4096 + 1));
    add(t, 'blob.size string', set(['blob', 'size'], '100'));
    add(t, 'blob.suite 2', set(['blob', 'suite'], 2));
    add(t, 'blob.suite missing', set(['blob', 'suite'], undefined));
    add(t, 'commitment uppercase', set(['commitment'], 'C'.repeat(64)));
    add(t, 'commitment missing', set(['commitment'], undefined));
    add(t, 'label too long (121)', set(['label'], 'a'.repeat(121)));
    add(t, 'label number', set(['label'], 5));
    add(t, 'label null', set(['label'], null));
    add(t, 'label not NFC', set(['label'], 'é'));
    add(t, 'label NUL', set(['label'], 'a\u0000b'));
    add(t, 'label newline', set(['label'], 'a\nb'));
    add(t, 'label tab', set(['label'], 'a\tb'));
    add(t, 'label DEL', set(['label'], 'a\u007fb'));
    add(t, 'label C1 control', set(['label'], 'a\u0085b'));
    add(t, 'label bidi override', set(['label'], 'a‮b'));
    add(t, 'label bidi isolate', set(['label'], 'a⁦b'));
    add(t, 'label line separator', set(['label'], 'a b'));
    add(t, 'label lone surrogate', set(['label'], 'a\ud800b'));
    add(t, 'label lone low surrogate', set(['label'], 'a\udc00b'));
  }
  add('doc.revoke', 'reason too long (501)', set(['reason'], 'a'.repeat(501)));
  add('doc.revoke', 'reason newline', set(['reason'], 'a\nb'));
  add('doc.revoke', 'reason missing', set(['reason'], undefined));
  add('identity', 'displayName empty', set(['displayName'], ''));
  add('identity', 'displayName 41 chars', set(['displayName'], 'a'.repeat(41)));
  add('identity', 'displayName spaces only', set(['displayName'], '   '));
  add('identity', 'displayName tab', set(['displayName'], 'a\tb'));
  add('identity', 'displayName newline', set(['displayName'], 'a\nb'));
  add('identity', 'displayName not NFC', set(['displayName'], 'Amélie'));
  add('identity', 'displayName RTL override', set(['displayName'], '‮ecilA'));
  add('identity', 'publicKey with alg', set(['publicKey', 'alg'], 'ES256'));
  add('identity', 'publicKey with d', set(['publicKey', 'd'], 'a'.repeat(43)));
  add('identity', 'publicKey wrong crv', set(['publicKey', 'crv'], 'P-384'));
  add('identity', 'publicKey wrong kty', set(['publicKey', 'kty'], 'RSA'));
  add('identity', 'publicKey x too short', set(['publicKey', 'x'], 'AAAA'));
  add('identity', 'publicKey x padded', (r) => set(['publicKey', 'x'], r.publicKey.x.slice(0, 42) + '=')(r));
  add('identity', 'publicKey x standard base64', (r) => set(['publicKey', 'x'], r.publicKey.x.slice(0, 42) + '+')(r));
  add('identity', 'publicKey array', set(['publicKey'], []));
  add('identity', 'publicKey missing', set(['publicKey'], undefined));
  add('channel.create', 'channelId too short', set(['channelId'], 'ab'));
  add('channel.create', 'channelId uppercase', set(['channelId'], 'Room'));
  add('channel.create', 'channelId leading dash', set(['channelId'], '-room'));
  add('channel.create', 'channelId 41 chars', set(['channelId'], 'a'.repeat(41)));
  add('channel.create', 'channelId underscore', set(['channelId'], 'a_b_c'));
  add('channel.create', 'channelId trailing newline', set(['channelId'], 'room\n'));
  add('channel.create', 'channelId non ascii', set(['channelId'], 'rööm'));
  add('channel.create', 'title empty', set(['title'], ''));
  add('channel.create', 'title 61', set(['title'], 'a'.repeat(61)));
  add('channel.create', 'title blank', set(['title'], ' '));
  add('channel.create', 'docId uppercase', set(['docId'], 'D'.repeat(32)));
  add('channel.create', 'docId short', set(['docId'], 'd'.repeat(31)));
  add('channel.create', 'docId null', set(['docId'], null));
  add('channel.create', 'signer short', set(['signer'], 'a'.repeat(63)));
  add('message', 'body empty', set(['body'], ''));
  add('message', 'body 2001', set(['body'], 'a'.repeat(2001)));
  add('message', 'body blank', set(['body'], ' \n '));
  add('message', 'body CR', set(['body'], 'a\rb'));
  add('message', 'body NUL', set(['body'], 'a\u0000'));
  add('message', 'body bidi override', set(['body'], 'x‮y'));
  add('message', 'body not NFC', set(['body'], 'é'));
  add('message', 'body lone surrogate', set(['body'], '\ud83d'));
  add('message', 'body number', set(['body'], 5));
  add('message', 'replyTo uppercase', set(['replyTo'], 'A'.repeat(64)));
  add('message', 'replyTo short', set(['replyTo'], 'a'.repeat(10)));
  add('message', 'replyTo null', set(['replyTo'], null));
  add('message', 'replyTo missing', set(['replyTo'], undefined));
  add('message', 'nonce short', set(['nonce'], 'f'.repeat(31)));
  add('message', 'nonce long', set(['nonce'], 'f'.repeat(33)));
  add('message', 'nonce uppercase', set(['nonce'], 'F'.repeat(32)));
  add('message', 'nonce missing', set(['nonce'], undefined));
  add('message', 'channelId invalid', set(['channelId'], 'A'));
  add('blob.put', 'hash uppercase', set(['hash'], 'B'.repeat(64)));
  add('blob.put', 'size 0', set(['size'], 0));
  add('blob.put', 'size above max', set(['size'], 52428800 + 4097));
  add('blob.put', 'size float', set(['size'], 1.5));
  add('checkpoint', 'scope empty', set(['scope'], ''));
  add('checkpoint', 'scope ledger with space', set(['scope'], 'ledger '));
  add('checkpoint', 'scope channel: empty id', set(['scope'], 'channel:'));
  add('checkpoint', 'scope channel with bad id', set(['scope'], 'channel:A'));
  add('checkpoint', 'scope channel nested', set(['scope'], 'channel:ab/../x'));
  // 'doc:<docId>' is now a valid scope (document head attestation, the fix for the unanchored
  // bundle finding). The review brief itself proposed it, so the old "doc is rejected" case was
  // replaced by cases that are still wrong.
  add('checkpoint', 'scope doc with short id', set(['scope'], 'doc:' + D.slice(1)));
  add('checkpoint', 'scope doc with uppercase id', set(['scope'], 'doc:' + D.toUpperCase()));
  add('checkpoint', 'scope doc with seq 0', (r) => ({ ...r, scope: 'doc:' + D, seq: 0, hash: H('0') }));
  add('checkpoint', 'seq negative', set(['seq'], -1));
  add('checkpoint', 'seq float', set(['seq'], 1.5));
  add('checkpoint', 'seq 0 with non zero hash', set(['seq'], 0));
  add('checkpoint', 'hash uppercase', set(['hash'], 'A'.repeat(64)));
  add('checkpoint', 'serverKeyId short', set(['serverKeyId'], 'a'.repeat(10)));
  add('checkpoint', 'signedAt negative', set(['signedAt'], -1));
  add('checkpoint', 'extra field', (r) => ({ ...r, extra: 1 }));

  it.each(cases)('%s: %s is rejected', async (type, name, fn) => {
    const s = await samples();
    const bad = fn(s[type]);
    const res = validateRecord(bad);
    expect(res.ok, `${type} / ${name} was accepted`).toBe(false);
    expect(typeof res.error).toBe('string');
    if (type === 'checkpoint') expect(validateCheckpointPayload(bad).ok).toBe(false);
  });
});

describe('values that must stay valid (no over rejection)', () => {
  it('accepts boundary sizes and code point lengths', async () => {
    const s = await samples();
    const b = structuredClone(s['doc.create']);
    b.label = '\u{1F600}'.repeat(120); // 120 code points, 240 UTF-16 units
    b.blob.size = 52428800 + 4096;
    expect(validateRecord(b).ok).toBe(true);
    b.label = '\u{1F600}'.repeat(121);
    expect(validateRecord(b).ok).toBe(false);
    const m = structuredClone(s.message);
    m.body = 'a\n'.repeat(1000).slice(0, 2000);
    expect(validateRecord(m).ok).toBe(true);
    const i = structuredClone(s.identity);
    i.displayName = 'x'.repeat(40);
    expect(validateRecord(i).ok).toBe(true);
    const c = structuredClone(s.checkpoint);
    c.seq = 0;
    c.hash = H('0');
    expect(validateRecord(c).ok).toBe(true);
  });

  it('accepts createdAt 0 and the maximum date', async () => {
    const s = await samples();
    expect(validateRecord({ ...s.message, createdAt: 0 }).ok).toBe(true);
    expect(validateRecord({ ...s.message, createdAt: 8.64e15 }).ok).toBe(true);
  });
});

describe('dispatch', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', 'Message', 'checkpoint '])(
    'unknown type %j is rejected without throwing',
    (t) => {
      const res = validateRecord({ v: 2, type: t });
      expect(res.ok).toBe(false);
    }
  );

  it('never throws for odd containers', () => {
    const throwing = new Proxy({}, { get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
    const getter = { get type() { throw new Error('boom'); } };
    for (const v of [undefined, null, 0, '', [], [1], new Map(), new Date(), () => 1, Symbol('x'), 10n, throwing, getter, Object.create(null)]) {
      expect(() => validateRecord(v)).not.toThrow();
      expect(validateRecord(v).ok).toBe(false);
    }
  });
});

describe('FINDING: invisible text passes the "not blank" and display checks', () => {
  // A name that renders as nothing, or two names that render the same, make signers look alike.
  it.each([
    ['zero width space', '​'],
    ['hangul filler', 'ㅤ'],
    ['braille blank', '⠀'],
    ['word joiner', '⁠'],
    ['BOM / zero width no break space', '﻿'],
    ['soft hyphen', '­']
  ])('displayName made only of %s is rejected', async (_, ch) => {
    const s = await samples();
    expect(validateRecord({ ...s.identity, displayName: ch.repeat(3) }).ok).toBe(false);
  });

  it('displayName with an embedded zero width space is rejected (two keys could look identical)', async () => {
    const s = await samples();
    expect(validateRecord({ ...s.identity, displayName: 'Ali​ce' }).ok).toBe(false);
  });

  it('channel title and message body made only of invisible characters are rejected', async () => {
    const s = await samples();
    expect(validateRecord({ ...s['channel.create'], title: '​​' }).ok).toBe(false);
    expect(validateRecord({ ...s.message, body: '​ㅤ' }).ok).toBe(false);
  });
});
