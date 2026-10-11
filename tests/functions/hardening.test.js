// Fixes from the backend review: address keys, HEAD, document search and paging, version cap, busy
// writers, channel counters, paging and links, health, and the second migration on old data.
import { describe, expect, it } from 'vitest';
import { ApiError, STATUS_BY_CODE } from '../../functions/_lib/errors.js';
import { addressKey, headOf, rateKeyForRequest } from '../../functions/_lib/http.js';
import { MAX_DOC_VERSIONS, appendDocRecord, readDocument } from '../../functions/_lib/documents.js';
import { CHANNEL_SELECT, appendMessage } from '../../functions/_lib/channels.js';
import { RATES } from '../../functions/_lib/rate.js';
import * as docList from '../../functions/api/documents/index.js';
import * as channelsRoute from '../../functions/api/channels/index.js';
import * as messagesRoute from '../../functions/api/channels/[channelId]/messages.js';
import * as health from '../../functions/api/health.js';
import * as ledgerRoute from '../../functions/api/ledger.js';
import { ZERO_HASH, bytesToHex } from '../../shared/encoding.js';
import { recordHash } from '../../shared/records.js';
import { fakeD1, fakeKV, fakeR2, migrationFiles, newDatabase } from './fakes.js';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const BLOB = 'c'.repeat(64);

function req(path, headers = {}, method = 'GET') {
  return new Request('http://example.test' + path, { method, headers });
}

async function thrown(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected an error');
}

// the same tests run on R2 (default) and on KV (tests/functions/*.kv.test.js sets the kind first)
const newStore = () => (globalThis.__STORE_KIND === "kv" ? { BLOBS: fakeKV() } : { FILES: fakeR2() });
const objectsOf = (env) => (env.FILES || env.BLOBS).objects;

function setup(hooks) {
  const db = newDatabase();
  db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, 300, ?, 1, 0)').run(BLOB, OWNER);
  for (const [k, n] of [[OWNER, 'Owner'], [OTHER, 'Other']]) {
    db.prepare('INSERT INTO identities (key_id, public_jwk, display_name, created_at, record, signature) VALUES (?, ?, ?, 1, ?, ?)').run(k, '{}', n, '{}', 's');
  }
  return { db, env: { DB: fakeD1(db, hooks), ...newStore() } };
}

const docId = (n) => n.toString(16).padStart(32, '0');

function createRec(n, o = {}) {
  return {
    v: 2,
    type: 'doc.create',
    docId: o.docId || docId(n),
    version: 1,
    prev: ZERO_HASH,
    signer: o.signer || OWNER,
    createdAt: o.createdAt ?? 1000,
    label: o.label ?? 'doc ' + n,
    listed: o.listed ?? true,
    blob: { hash: BLOB, size: 300, suite: 1 },
    commitment: bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  };
}

async function updateRec(prevRecord, version, o = {}) {
  return {
    v: 2,
    type: o.type || 'doc.update',
    docId: prevRecord.docId,
    version,
    prev: o.prev || (await recordHash(prevRecord)),
    signer: prevRecord.signer,
    createdAt: o.createdAt ?? prevRecord.createdAt + 1,
    ...(o.type === 'doc.revoke'
      ? { reason: 'withdrawn' }
      : { label: 'v' + version, blob: { hash: BLOB, size: 300, suite: 1 }, commitment: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) })
  };
}

describe('address keys for rate limits', () => {
  it('leaves IPv4 addresses as they are', () => {
    expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('  203.0.113.9 ')).toBe('203.0.113.9');
  });

  it('gives every address inside one /64 the same key and different /64s different keys', () => {
    const a = addressKey('2001:db8:1:2::1');
    expect(addressKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(a);
    expect(addressKey('2001:0db8:0001:0002:0000:0000:0000:0007')).toBe(a);
    expect(addressKey('2001:DB8:1:2::abcd')).toBe(a);
    expect(addressKey('[2001:db8:1:2::9]')).toBe(a);
    expect(addressKey('2001:db8:1:2::9%eth0')).toBe(a);
    expect(addressKey('2001:db8:1:3::1')).not.toBe(a);
    expect(addressKey('2001:db8:2:2::1')).not.toBe(a);
    expect(a.startsWith('v6:')).toBe(true);
  });

  it('handles compressed forms, the unspecified and loopback addresses', () => {
    expect(addressKey('::1')).toBe('v6:0:0:0:0');
    expect(addressKey('::')).toBe('v6:0:0:0:0');
    expect(addressKey('2001:db8::')).toBe('v6:2001:db8:0:0');
    expect(addressKey('1:2:3:4:5:6:7:8')).toBe('v6:1:2:3:4');
  });

  it('treats an IPv4 mapped address as the IPv4 address', () => {
    expect(addressKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('::ffff:cb00:7109')).toBe('203.0.113.9');
    expect(addressKey('::FFFF:203.0.113.9')).toBe('203.0.113.9');
  });

  it('uses text that does not parse as it is, cut to 64 characters', () => {
    expect(addressKey('not an address')).toBe('not an address');
    expect(addressKey('1:2:3')).toBe('1:2:3');
    expect(addressKey('1::2::3')).toBe('1::2::3');
    expect(addressKey('g::1')).toBe('g::1');
    expect(addressKey(':'.repeat(200)).length).toBe(64);
    expect(addressKey('::ffff:1.2.3.999')).toBe('::ffff:1.2.3.999');
  });

  it('rateKeyForRequest reads CF-Connecting-IP and ignores forwarding headers', () => {
    const r = (headers) => new Request('https://records.example/api/identities', { headers });
    expect(rateKeyForRequest(r({ 'CF-Connecting-IP': '2001:db8:1:2::5', 'X-Forwarded-For': '1.1.1.1', 'X-Real-IP': '2.2.2.2' }))).toBe(
      addressKey('2001:db8:1:2::1')
    );
    expect(rateKeyForRequest(r({ 'CF-Connecting-IP': '203.0.113.9', 'True-Client-IP': '1.1.1.1' }))).toBe('203.0.113.9');
  });

  it('refuses a request without the address header on a real host, accepts it on a local development host', () => {
    const err = (() => {
      try {
        rateKeyForRequest(new Request('https://records.example/api/identities'));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('forbidden');
    expect(() => rateKeyForRequest(new Request('https://records.example/api/identities', { headers: { 'CF-Connecting-IP': '  ' } }))).toThrow();
    for (const host of ['http://localhost:8788', 'http://127.0.0.1:8788', 'http://[::1]:8788', 'http://app.localhost:8788']) {
      expect(rateKeyForRequest(new Request(host + '/api/identities'))).toBe('local');
    }
    // a name that only ends in the word is not local
    expect(() => rateKeyForRequest(new Request('https://notlocalhost.example/api/identities'))).toThrow();
  });

  it('has a service wide identity limit on top of the per address one', () => {
    expect(RATES.identityAll.windowMs).toBe(RATES.identity.windowMs);
    expect(RATES.identityAll.max).toBeGreaterThan(RATES.identity.max);
  });
});

describe('HEAD', () => {
  it('headOf answers like GET without a body', async () => {
    const head = headOf(async () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json', 'X-A': '1' } }));
    const res = await head({});
    expect(res.status).toBe(200);
    expect(res.headers.get('x-a')).toBe('1');
    expect(await res.text()).toBe('');
  });

  it('every JSON route that has GET also has HEAD', async () => {
    const mods = [
      '../../functions/api/health.js',
      '../../functions/api/server-key.js',
      '../../functions/api/ledger.js',
      '../../functions/api/documents/index.js',
      '../../functions/api/documents/[docId]/index.js',
      '../../functions/api/documents/[docId]/head.js',
      '../../functions/api/identities/[keyId].js',
      '../../functions/api/channels/index.js',
      '../../functions/api/channels/[channelId]/messages.js',
      '../../functions/api/blobs/[hash].js'
    ];
    for (const m of mods) {
      const mod = await import(m);
      expect(typeof mod.onRequestGet, m).toBe('function');
      expect(typeof mod.onRequestHead, m).toBe('function');
    }
  });

  it('HEAD on the ledger and the document list returns the GET status and no body', async () => {
    const { env } = setup();
    for (const mod of [ledgerRoute, docList, channelsRoute]) {
      const res = await mod.onRequestHead({ request: req('/api/x', {}, 'HEAD'), env, params: {} });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.text()).toBe('');
    }
  });
});

describe('health', () => {
  it('reports whether a server signing key is set', async () => {
    const { env } = setup();
    const without = await (await health.onRequestGet({ env: { ...env, FILES: { head: async () => null } } })).json();
    // v3 added mail, mailConfigured and accounts (nothing configured here: all off)
    expect(without).toEqual({ ok: true, schema: true, signing: false, mail: 'none', mailConfigured: 'none', accounts: false });
  });
});

describe('document search and paging', () => {
  async function seeded() {
    const s = setup();
    const labels = ['100% sure', 'a_b', 'back\\slash', 'aXb', 'Quarterly REPORT'];
    for (let i = 0; i < labels.length; i++) await appendDocRecord(s.env, createRec(i + 1, { label: labels[i], createdAt: 1000 + i }), 's');
    return s;
  }
  const list = async (env, qs) => {
    const res = await docList.onRequestGet({ request: req('/api/documents' + qs), env });
    return { status: res.status, body: await res.json() };
  };

  it('finds literal percent, underscore and backslash text and ignores ASCII case', async () => {
    const { env } = await seeded();
    expect((await list(env, '?q=' + encodeURIComponent('100%'))).body.documents.map((d) => d.label)).toEqual(['100% sure']);
    expect((await list(env, '?q=' + encodeURIComponent('a_b'))).body.documents.map((d) => d.label)).toEqual(['a_b']);
    expect((await list(env, '?q=' + encodeURIComponent('\\'))).body.documents.map((d) => d.label)).toEqual(['back\\slash']);
    expect((await list(env, '?q=' + encodeURIComponent('quarterly report'))).body.documents.map((d) => d.label)).toEqual(['Quarterly REPORT']);
    expect((await list(env, '?q=%25')).body.documents).toHaveLength(1);
    expect((await list(env, '?q=_')).body.documents).toHaveLength(1);
  });

  it('never fails on long or odd queries (D1 refuses LIKE patterns over 50 bytes, this does not use LIKE)', async () => {
    const { env } = await seeded();
    for (const q of ['a'.repeat(48), 'a'.repeat(49), 'a'.repeat(120), '\u{1f600}'.repeat(13), '\u{1f600}'.repeat(120), '%'.repeat(120), "' OR 1=1 --", '\u0000abc']) {
      const r = await list(env, '?q=' + encodeURIComponent(q));
      expect(r.status).toBe(200);
      expect(r.body.documents).toEqual([]);
    }
    const err = await thrown(list(env, '?q=' + encodeURIComponent('a'.repeat(121))));
    expect(err.code).toBe('bad_request');
  });

  it('paging with before and beforeId reaches every document, also when many share one updatedAt', async () => {
    const s = setup();
    // one victim and many documents with the same updatedAt and higher ids
    const ids = [];
    for (let i = 1; i <= 9; i++) {
      const r = createRec(i, { docId: (i === 1 ? '00' : 'f' + i) + 'a'.repeat(30), createdAt: 5000 });
      ids.push(r.docId);
      await appendDocRecord(s.env, r, 's');
    }
    await appendDocRecord(s.env, createRec(20, { createdAt: 4000 }), 's');
    ids.push(docId(20));
    for (const limit of [1, 2, 3, 4, 100]) {
      const seen = [];
      let qs = `?limit=${limit}`;
      for (let page = 0; page < 50; page++) {
        const { body } = await list(s.env, qs);
        if (body.documents.length === 0) break;
        seen.push(...body.documents.map((d) => d.docId));
        const last = body.documents[body.documents.length - 1];
        qs = `?limit=${limit}&before=${last.updatedAt}&beforeId=${last.docId}`;
      }
      expect(seen.slice().sort()).toEqual(ids.slice().sort());
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it('the old cursor (before alone) still means strictly earlier, and beforeId is validated', async () => {
    const s = setup();
    await appendDocRecord(s.env, createRec(1, { createdAt: 5000 }), 's');
    await appendDocRecord(s.env, createRec(2, { createdAt: 6000 }), 's');
    expect((await list(s.env, '?before=6000')).body.documents.map((d) => d.docId)).toEqual([docId(1)]);
    expect((await thrown(list(s.env, '?beforeId=' + docId(1)))).code).toBe('bad_request');
    expect((await thrown(list(s.env, '?before=5&beforeId=xyz'))).code).toBe('bad_request');
  });

  it('only lists listed documents, and the owner filter still works', async () => {
    const s = setup();
    await appendDocRecord(s.env, createRec(1, { listed: false }), 's');
    await appendDocRecord(s.env, createRec(2, { signer: OTHER }), 's');
    expect((await list(s.env, '')).body.documents.map((d) => d.docId)).toEqual([docId(2)]);
    expect((await list(s.env, '?owner=' + OWNER)).body.documents).toEqual([]);
    expect((await list(s.env, '?owner=' + OTHER)).body.documents).toHaveLength(1);
  });

  it('uses the combined index for the list query', () => {
    const db = newDatabase();
    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT d.doc_id FROM documents d WHERE d.listed = 1 AND (d.updated_at < ? OR (d.updated_at = ? AND d.doc_id < ?)) ORDER BY d.updated_at DESC, d.doc_id DESC LIMIT 5'
      )
      .all(1, 1, 'a')
      .map((r) => r.detail)
      .join(' | ');
    expect(plan).toMatch(/idx_documents_listed_updated/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });
});

describe('versions per document', () => {
  it('stops updates at the cap but always leaves room to revoke, and the bundle query is bounded', async () => {
    const { env } = setup();
    let last = createRec(1);
    await appendDocRecord(env, last, 's');
    for (let v = 2; v < MAX_DOC_VERSIONS; v++) {
      last = await updateRec(last, v);
      await appendDocRecord(env, last, 's');
    }
    // the next update would be the last place
    const over = await updateRec(last, MAX_DOC_VERSIONS);
    const err = await thrown(appendDocRecord(env, over, 's'));
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/at most/);
    const revoke = await updateRec(last, MAX_DOC_VERSIONS, { type: 'doc.revoke' });
    const out = await appendDocRecord(env, revoke, 's');
    expect(out.document.status).toBe('revoked');
    expect(out.document.headVersion).toBe(MAX_DOC_VERSIONS);
    const bundle = await readDocument(env, last.docId);
    expect(bundle.records).toHaveLength(MAX_DOC_VERSIONS);
    expect(bundle.records[MAX_DOC_VERSIONS - 1].record.type).toBe('doc.revoke');
  }, 60000);

  it('the cap is a few hundred, small enough for one request', () => {
    expect(MAX_DOC_VERSIONS).toBeGreaterThanOrEqual(50);
    expect(MAX_DOC_VERSIONS).toBeLessThanOrEqual(500);
  });
});

describe('writers that keep losing the race', () => {
  it('answer 503 busy (not the 409 of a real chain conflict) after the retry budget, and change nothing', async () => {
    const db = newDatabase();
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, 300, ?, 1, 0)').run(BLOB, OWNER);
    const d1 = fakeD1(db);
    // Every write batch is beaten by another writer, as if a crowd in other isolates won each time.
    const env = {
      DB: {
        prepare: d1.prepare,
        batch: async (list) => {
          if (list.length > 1 && /INSERT INTO ledger/.test(list[0].sql)) throw new Error('D1_ERROR: UNIQUE constraint failed: ledger.prev_ledger_hash');
          return d1.batch(list);
        }
      }
    };
    const err = await appendDocRecord(env, createRec(1), 's', { budgetMs: 150 }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('busy');
    expect(err.status).toBe(503);
    expect(err.headers['Retry-After']).toBeGreaterThan(0);
    expect(STATUS_BY_CODE.busy).toBe(503);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n).toBe(0);
  });

  it('message writers get 503 busy too when the channel keeps being won by others', async () => {
    const db = newDatabase();
    db.prepare(
      'INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, received_at, record, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('room-one', 't', '', OWNER, 1, 1, '{}', 's');
    const d1 = fakeD1(db);
    const env = {
      DB: {
        prepare: d1.prepare,
        batch: async (list) => {
          if (/INSERT INTO messages/.test(list[0].sql)) throw new Error('UNIQUE constraint failed: messages.channel_id, messages.seq');
          return d1.batch(list);
        }
      }
    };
    const record = { v: 2, type: 'message', channelId: 'room-one', body: 'hi', replyTo: '', signer: OWNER, createdAt: 5, nonce: 'a'.repeat(32) };
    const err = await appendMessage(env, record, 's', { budgetMs: 100 }).then(
      () => null,
      (e) => e
    );
    expect(err.code).toBe('busy');
    expect(err.status).toBe(503);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n).toBe(0);
    expect(db.prepare('SELECT message_count FROM channels').get().message_count).toBe(0);
  });

  it('a real chain conflict is still a 409 conflict and is not retried', async () => {
    const { env } = setup();
    const first = createRec(1);
    await appendDocRecord(env, first, 's');
    const stale = await updateRec(first, 2, { prev: 'f'.repeat(64) });
    const err = await thrown(appendDocRecord(env, stale, 's'));
    expect(err.code).toBe('conflict');
    expect(err.status).toBe(409);
  });

  it('a burst of writers that fail a few times in a row still gets through', async () => {
    const db = newDatabase();
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, 300, ?, 1, 0)').run(BLOB, OWNER);
    const d1 = fakeD1(db);
    let failures = 0;
    const env = {
      DB: {
        prepare: d1.prepare,
        batch: async (list) => {
          if (list.length > 1 && /INSERT INTO ledger/.test(list[0].sql) && failures < 12) {
            failures++;
            throw new Error('UNIQUE constraint failed: ledger.prev_ledger_hash');
          }
          return d1.batch(list);
        }
      }
    };
    const out = await appendDocRecord(env, createRec(1), 's');
    expect(out.ledgerSeq).toBe(1);
    expect(failures).toBe(12);
  }, 30000);
});

describe('channels', () => {
  const msg = (channelId, n, createdAt = 2000 + n) => ({
    v: 2,
    type: 'message',
    channelId,
    body: 'hello ' + n,
    replyTo: '',
    signer: OWNER,
    createdAt,
    nonce: n.toString(16).padStart(32, '0')
  });

  function insertChannel(db, id, { receivedAt = 1000, docIdValue = '' } = {}) {
    db.prepare(
      'INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, received_at, record, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'title ' + id, docIdValue, OWNER, receivedAt, receivedAt, '{}', 's');
  }

  it('keeps message_count and last_message_at on the channel row, in step with the messages', async () => {
    const { db, env } = setup();
    insertChannel(db, 'room-one');
    expect(db.prepare('SELECT message_count, last_message_at FROM channels').get()).toMatchObject({ message_count: 0, last_message_at: null });
    for (let i = 1; i <= 5; i++) await appendMessage(env, msg('room-one', i), 's');
    expect(db.prepare('SELECT message_count, last_message_at FROM channels').get()).toMatchObject({ message_count: 5, last_message_at: 2005 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n).toBe(5);
    const row = db.prepare(CHANNEL_SELECT + ' WHERE c.channel_id = ?').get('room-one');
    expect(row.message_count).toBe(5);
  });

  it('a message that is refused changes neither the messages nor the counters', async () => {
    const { db, env } = setup();
    insertChannel(db, 'room-one');
    await appendMessage(env, msg('room-one', 1), 's');
    const err = await thrown(appendMessage(env, msg('room-one', 1), 's'));
    expect(err.code).toBe('exists');
    expect(db.prepare('SELECT message_count FROM channels').get().message_count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n).toBe(1);
  });

  it('parallel messages to one channel keep the counter equal to the number of messages', async () => {
    const { db, env } = setup();
    insertChannel(db, 'room-one');
    await Promise.all(Array.from({ length: 15 }, (_, i) => appendMessage(env, msg('room-one', i + 1), 's')));
    expect(db.prepare('SELECT message_count FROM channels').get().message_count).toBe(15);
    expect(db.prepare('SELECT MAX(seq) AS m FROM messages').get().m).toBe(15);
  });

  it('reading a channel or the list does not touch the messages table', () => {
    const db = newDatabase();
    const plan = (sql) =>
      db
        .prepare('EXPLAIN QUERY PLAN ' + sql)
        .all(...(sql.includes('?') ? ['x'] : []))
        .map((r) => r.detail)
        .join(' | ');
    expect(plan(CHANNEL_SELECT + ' WHERE c.channel_id = ?')).not.toMatch(/messages/);
    expect(plan(CHANNEL_SELECT + ' ORDER BY c.received_at DESC, c.channel_id DESC LIMIT 200')).not.toMatch(/messages/);
    expect(CHANNEL_SELECT).not.toMatch(/COUNT\(/i);
  });

  it('the messages route returns the stored counters for the channel', async () => {
    const { db, env } = setup();
    insertChannel(db, 'room-one');
    for (let i = 1; i <= 3; i++) await appendMessage(env, msg('room-one', i), 's');
    const res = await messagesRoute.onRequestGet({ request: req('/api/channels/room-one/messages'), env, params: { channelId: 'room-one' } });
    const body = await res.json();
    expect(body.channel.messageCount).toBe(3);
    expect(body.channel.lastMessageAt).toBe(2003);
    expect(body.messages).toHaveLength(3);
  });

  it('the list is paged by receive time with a cursor that cannot skip channels received at the same time', async () => {
    const { db, env } = setup();
    // 7 channels, five of them received in the same millisecond
    const ids = ['aaa-1', 'aaa-2', 'bbb-1', 'bbb-2', 'bbb-3', 'bbb-4', 'ccc-1'];
    insertChannel(db, 'aaa-1', { receivedAt: 100 });
    insertChannel(db, 'aaa-2', { receivedAt: 200 });
    for (const id of ['bbb-1', 'bbb-2', 'bbb-3', 'bbb-4']) insertChannel(db, id, { receivedAt: 300 });
    insertChannel(db, 'ccc-1', { receivedAt: 400 });
    for (const limit of [1, 2, 3, 7, 200]) {
      const seen = [];
      let qs = `?limit=${limit}`;
      for (let page = 0; page < 20; page++) {
        const res = await channelsRoute.onRequestGet({ request: req('/api/channels' + qs), env });
        const body = await res.json();
        seen.push(...body.channels.map((c) => c.channelId));
        if (!body.next) break;
        qs = `?limit=${limit}&before=${body.next.before}&beforeId=${body.next.beforeId}`;
      }
      expect(seen).toEqual(['ccc-1', 'bbb-4', 'bbb-3', 'bbb-2', 'bbb-1', 'aaa-2', 'aaa-1']);
      expect(seen.length).toBe(ids.length);
    }
  });

  it('orders by receive time, not by the time the creator claims', async () => {
    const { db, env } = setup();
    db.prepare(
      'INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, received_at, record, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('claims-future', 't', '', OWNER, 9_999_999, 100, '{}', 's');
    insertChannel(db, 'honest-late', { receivedAt: 200 });
    const res = await channelsRoute.onRequestGet({ request: req('/api/channels'), env });
    expect((await res.json()).channels.map((c) => c.channelId)).toEqual(['honest-late', 'claims-future']);
  });

  it('rejects a bad cursor or limit', async () => {
    const { env } = setup();
    for (const qs of ['?limit=0', '?limit=201', '?before=x', '?before=5&beforeId=A%20B', '?before=5&beforeId=a']) {
      const err = await thrown(channelsRoute.onRequestGet({ request: req('/api/channels' + qs), env }));
      expect(err.code, qs).toBe('bad_request');
    }
  });

  it('shows who owns the document a channel names', async () => {
    const { db, env } = setup();
    await appendDocRecord(env, createRec(1), 's');
    insertChannel(db, 'about-doc', { docIdValue: docId(1) });
    insertChannel(db, 'about-nothing');
    const res = await channelsRoute.onRequestGet({ request: req('/api/channels'), env });
    const byId = Object.fromEntries((await res.json()).channels.map((c) => [c.channelId, c]));
    expect(byId['about-doc'].docOwnerKeyId).toBe(OWNER);
    expect(byId['about-nothing'].docOwnerKeyId).toBe('');
  });
});

describe('the second migration on a database that already holds data', () => {
  it('keeps old rows, backfills the counters and totals, and moves the indexes', () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(2);
    const db = new DatabaseSync(':memory:');
    const dir = new URL('../../migrations/', import.meta.url);
    db.exec(readFileSync(new URL(files[0], dir), 'utf8'));
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at) VALUES (?, 100, ?, 1)').run('1'.repeat(64), OWNER);
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at) VALUES (?, 250, ?, 1)').run('2'.repeat(64), OTHER);
    db.prepare('INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, record, signature) VALUES (?, ?, ?, ?, ?, ?, ?)').run('old-room', 't', '', OWNER, 777, '{}', 's');
    for (let i = 1; i <= 4; i++) {
      db.prepare('INSERT INTO messages (hash, channel_id, seq, signer, body, signature, prev_chain_hash, chain_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'm' + i, 'old-room', i, OWNER, '{}', 's', 'p', 'c', 1000 + i
      );
    }
    for (const f of files.slice(1)) db.exec(readFileSync(new URL(f, dir), 'utf8'));
    expect(db.prepare('SELECT size, pending FROM blobs ORDER BY hash').all()).toEqual([
      { size: 100, pending: 0 },
      { size: 250, pending: 0 }
    ]);
    expect(db.prepare("SELECT bytes FROM blob_totals WHERE k = 'all'").get().bytes).toBe(350);
    expect(db.prepare('SELECT received_at, message_count, last_message_at FROM channels').get()).toEqual({ received_at: 777, message_count: 4, last_message_at: 1004 });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
    expect(names).toContain('idx_documents_listed_updated');
    expect(names).toContain('idx_channels_received');
    expect(names).not.toContain('idx_channels_created');
  });

  it('keeps the total in step when blobs come and go', () => {
    const db = newDatabase();
    const total = () => db.prepare("SELECT bytes FROM blob_totals WHERE k = 'all'").get().bytes;
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, 100, ?, 1, 1)').run('1'.repeat(64), OWNER);
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, 50, ?, 1, 0)').run('2'.repeat(64), OWNER);
    expect(total()).toBe(150);
    db.prepare('UPDATE blobs SET pending = 0 WHERE hash = ?').run('1'.repeat(64));
    expect(total()).toBe(150);
    db.prepare('DELETE FROM blobs WHERE hash = ?').run('1'.repeat(64));
    expect(total()).toBe(50);
  });
});
