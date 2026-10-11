// Migration 0003 on a database that already holds data from 0001 and 0002, and the channel preview columns.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appendMessage, channelFromRow, CHANNEL_SELECT, previewText } from '../../functions/_lib/channels.js';
import { ZERO_HASH } from '../../shared/encoding.js';
import { recordHash } from '../../shared/records.js';
import { accountEnv, callApi, fakeD1, newDatabase } from './fakes.js';

const SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0003_accounts.sql'), 'utf8');
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const H = (c) => c.repeat(64);

function oldDatabase() {
  const db = newDatabase('0002_hardening.sql');
  db.prepare('INSERT INTO identities (key_id, public_jwk, display_name, created_at, record, signature) VALUES (?, ?, ?, 1, ?, ?)').run(H('a'), '{"kty":"EC"}', 'Old Name', '{"v":2}', 'sig');
  db.prepare('INSERT INTO identities (key_id, public_jwk, display_name, created_at, record, signature) VALUES (?, ?, ?, 2, ?, ?)').run(H('b'), '{"kty":"EC"}', 'Other', '{"v":2}', 'sig');
  db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, 300, ?, 1, 0)').run(H('c'), H('a'));
  db.prepare('INSERT INTO documents (doc_id, owner_key_id, status, listed, head_version, head_record_hash, label, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?, 10, 10)').run('d'.repeat(32), H('a'), 'active', H('e'), 'Old document');
  db.prepare('INSERT INTO ledger (record_hash, prev_ledger_hash, ledger_hash, created_at) VALUES (?, ?, ?, 10)').run(H('e'), ZERO_HASH, H('f'));
  db.prepare('INSERT INTO records (record_hash, doc_id, version, type, signer, body, signature, ledger_seq, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, 1, 10)').run(H('e'), 'd'.repeat(32), 'doc.create', H('a'), '{}', 'sig');
  db.prepare('INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, received_at, record, signature, message_count, last_message_at) VALUES (?, ?, ?, ?, 20, 21, ?, ?, 2, 30)').run('old-room', 'Old room', '', H('a'), '{}', 'sig');
  db.prepare('INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, received_at, record, signature) VALUES (?, ?, ?, ?, 22, 23, ?, ?)').run('empty-room', 'Empty', '', H('b'), '{}', 'sig');
  for (let seq = 1; seq <= 2; seq++) {
    db.prepare('INSERT INTO messages (hash, channel_id, seq, signer, body, signature, prev_chain_hash, chain_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      H(String(seq)), 'old-room', seq, H('a'), '{"body":"hello ' + seq + '"}', 'sig', seq === 1 ? ZERO_HASH : H('1'), H('9'), 29 + seq
    );
  }
  db.prepare('INSERT INTO rate_limits (bucket, "window", count) VALUES (?, ?, ?)').run('msg:x', 60000, 3);
  db.prepare("INSERT INTO blocked_blobs (hash, reason, created_at) VALUES (?, 'court order', 5)").run(H('7'));
  return db;
}

describe('migration 0003 on a database with data', () => {
  it('applies cleanly and keeps every old row', () => {
    const db = oldDatabase();
    const before = {};
    for (const t of ['identities', 'blobs', 'documents', 'records', 'ledger', 'channels', 'messages', 'rate_limits', 'blocked_blobs', 'blob_totals']) before[t] = count(db, t);
    const rowsBefore = {
      identities: JSON.stringify(db.prepare('SELECT * FROM identities ORDER BY key_id').all()),
      documents: JSON.stringify(db.prepare('SELECT * FROM documents').all()),
      messages: JSON.stringify(db.prepare('SELECT * FROM messages ORDER BY seq').all()),
      blobs: JSON.stringify(db.prepare('SELECT * FROM blobs').all()),
      totals: JSON.stringify(db.prepare('SELECT * FROM blob_totals').all())
    };
    db.exec(SQL);
    for (const [t, n] of Object.entries(before)) expect(count(db, t), t).toBe(n);
    expect(JSON.stringify(db.prepare('SELECT * FROM identities ORDER BY key_id').all())).toBe(rowsBefore.identities);
    expect(JSON.stringify(db.prepare('SELECT * FROM documents').all())).toBe(rowsBefore.documents);
    expect(JSON.stringify(db.prepare('SELECT * FROM messages ORDER BY seq').all())).toBe(rowsBefore.messages);
    expect(JSON.stringify(db.prepare('SELECT * FROM blobs').all())).toBe(rowsBefore.blobs);
    expect(JSON.stringify(db.prepare('SELECT * FROM blob_totals').all())).toBe(rowsBefore.totals);
  });

  it('old channels keep their counters and get empty previews', () => {
    const db = oldDatabase();
    db.exec(SQL);
    const rows = db.prepare('SELECT channel_id, message_count, last_message_at, last_text, last_signer_name, received_at FROM channels ORDER BY channel_id').all();
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { channel_id: 'empty-room', message_count: 0, last_message_at: null, last_text: '', last_signer_name: '', received_at: 23 },
      { channel_id: 'old-room', message_count: 2, last_message_at: 30, last_text: '', last_signer_name: '', received_at: 21 }
    ]);
    const shaped = db.prepare(CHANNEL_SELECT + ' WHERE c.channel_id = ?').get('old-room');
    expect(channelFromRow(shaped)).toMatchObject({ channelId: 'old-room', messageCount: 2, lastMessageAt: 30, lastText: '', lastSignerName: '' });
  });

  it('creates the account tables empty, with the columns of the spec', () => {
    const db = oldDatabase();
    db.exec(SQL);
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    expect(cols('accounts')).toEqual(['id', 'email_hash', 'email_masked', 'display_name', 'strict', 'created_at', 'last_login_at']);
    expect(cols('sessions')).toEqual(['token_hash', 'account_id', 'created_at', 'expires_at', 'last_seen_at']);
    expect(cols('otp_codes')).toEqual(['email_hash', 'code_hash', 'expires_at', 'attempts', 'created_at']);
    expect(cols('account_keys')).toEqual(['key_id', 'account_id', 'wrapped_private', 'created_at']);
    expect(cols('account_secrets')).toEqual(['account_id', 'doc_id', 'wrapped', 'created_at']);
    for (const t of ['accounts', 'sessions', 'otp_codes', 'account_keys', 'account_secrets']) expect(count(db, t), t).toBe(0);
    const defaults = Object.fromEntries(db.prepare('PRAGMA table_info(accounts)').all().map((c) => [c.name, c.dflt_value]));
    expect(defaults.strict).toBe('0');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
    for (const name of ['sessions_account', 'account_keys_account', 'otp_codes_expires', 'account_keys_one_copy']) expect(idx).toContain(name);
  });

  it('keeps the older indexes and triggers working (blob totals still follow the blobs table)', () => {
    const db = oldDatabase();
    db.exec(SQL);
    const total = () => db.prepare("SELECT bytes FROM blob_totals WHERE k = 'all'").get().bytes;
    const t0 = total();
    db.prepare('INSERT INTO blobs (hash, size, uploader, created_at, pending) VALUES (?, 1000, ?, 1, 0)').run(H('8'), H('a'));
    expect(total()).toBe(t0 + 1000);
    db.prepare('DELETE FROM blobs WHERE hash = ?').run(H('8'));
    expect(total()).toBe(t0);
  });

  it('enforces the uniqueness rules: one email per account, one server copy per account, five keys', () => {
    const db = oldDatabase();
    db.exec(SQL);
    db.prepare("INSERT INTO accounts (id, email_hash, email_masked, strict, created_at, last_login_at) VALUES ('a1', 'h1', 'x***@y.zz', 0, 1, 1)").run();
    expect(() => db.prepare("INSERT INTO accounts (id, email_hash, email_masked, strict, created_at, last_login_at) VALUES ('a2', 'h1', 'x***@y.zz', 0, 1, 1)").run()).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO account_keys (key_id, account_id, wrapped_private, created_at) VALUES ('k1', 'a1', 'w', 1)").run();
    expect(() => db.prepare("INSERT INTO account_keys (key_id, account_id, wrapped_private, created_at) VALUES ('k2', 'a1', 'w2', 1)").run()).toThrow(/UNIQUE/);
    for (const k of ['k3', 'k4', 'k5', 'k6']) db.prepare("INSERT INTO account_keys (key_id, account_id, wrapped_private, created_at) VALUES (?, 'a1', NULL, 1)").run(k);
    expect(() => db.prepare("INSERT INTO account_keys (key_id, account_id, wrapped_private, created_at) VALUES ('k7', 'a1', NULL, 1)").run()).toThrow(/too many keys/);
    // another account is not affected by the count of the first
    db.prepare("INSERT INTO account_keys (key_id, account_id, wrapped_private, created_at) VALUES ('k8', 'a9', NULL, 1)").run();
  });

  it('a second run is refused (the tables exist), so the runner can not apply it twice by mistake', () => {
    const db = oldDatabase();
    db.exec(SQL);
    expect(() => db.exec(SQL)).toThrow();
  });

  it('is purely additive: no DROP, no DELETE, no UPDATE of old tables', () => {
    expect(SQL).not.toMatch(/\bDROP\b/i);
    expect(SQL).not.toMatch(/\bDELETE\b/i);
    expect(SQL).not.toMatch(/\bUPDATE\b/i);
    expect(SQL).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it('new messages after the migration fill the preview in the same batch', async () => {
    const db = oldDatabase();
    db.exec(SQL);
    const env = { DB: fakeD1(db) };
    const record = { v: 2, type: 'message', channelId: 'old-room', body: 'first after the upgrade', replyTo: '', signer: H('a'), createdAt: 40, nonce: '0'.repeat(32) };
    // the old chain in the fixture is not a real chain, so continue from its last row
    const out = await appendMessage(env, record, 's'.repeat(86));
    expect(out.seq).toBe(3);
    const row = db.prepare('SELECT message_count, last_message_at, last_text, last_signer_name FROM channels WHERE channel_id = ?').get('old-room');
    expect({ ...row }).toEqual({ message_count: 3, last_message_at: 40, last_text: 'first after the upgrade', last_signer_name: 'Old Name' });
    // the other channel did not change
    expect(db.prepare('SELECT last_text FROM channels WHERE channel_id = ?').get('empty-room').last_text).toBe('');
    expect(await recordHash(record)).toBe(out.hash);
  });

  it('the old channel list route answers with the new fields after the migration', async () => {
    const { env, db } = accountEnv({ upTo: '0002_hardening.sql' });
    db.prepare('INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, received_at, record, signature) VALUES (?, ?, ?, ?, 20, 21, ?, ?)').run('old-room', 'Old room', '', H('a'), '{}', 'sig');
    db.exec(SQL);
    const res = await callApi(env, 'GET', '/api/channels');
    expect(res.status).toBe(200);
    expect(res.json.channels[0]).toMatchObject({ channelId: 'old-room', lastText: '', lastSignerName: '' });
  });
});

describe('channel previews', () => {
  const H1 = H('a');

  async function post(env, channelId, body, signer = H1, createdAt = 100) {
    const record = { v: 2, type: 'message', channelId, body, replyTo: '', signer, createdAt, nonce: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('') };
    return appendMessage(env, record, 's'.repeat(86));
  }

  function setup() {
    const { env, db } = accountEnv();
    db.prepare('INSERT INTO identities (key_id, public_jwk, display_name, created_at, record, signature) VALUES (?, ?, ?, 1, ?, ?)').run(H1, '{}', 'Priya', '{}', 's');
    db.prepare('INSERT INTO identities (key_id, public_jwk, display_name, created_at, record, signature) VALUES (?, ?, ?, 1, ?, ?)').run(H('b'), '{}', 'Rahul', '{}', 's');
    db.prepare('INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, received_at, record, signature) VALUES (?, ?, ?, ?, 1, 1, ?, ?)').run('room-one', 'Room', '', H1, '{}', 's');
    return { env, db };
  }

  it('the newest message and its signer name are kept on the channel row', async () => {
    const { env, db } = setup();
    await post(env, 'room-one', 'hello there');
    await post(env, 'room-one', 'second one', H('b'), 200);
    const row = db.prepare('SELECT * FROM channels').get();
    expect(row.last_text).toBe('second one');
    expect(row.last_signer_name).toBe('Rahul');
    expect(row.message_count).toBe(2);
  });

  it('shows the body on one line: line breaks and runs of blanks become one space', async () => {
    const { env, db } = setup();
    await post(env, 'room-one', 'line one\n\nline   two\r\n\tline three  ');
    expect(db.prepare('SELECT last_text FROM channels').get().last_text).toBe('line one line two line three');
  });

  it('cuts to 140 characters, counting characters and not UTF-16 units', async () => {
    const { env, db } = setup();
    await post(env, 'room-one', 'x'.repeat(500));
    expect(db.prepare('SELECT last_text FROM channels').get().last_text).toBe('x'.repeat(140));
    await post(env, 'room-one', '\u{1F600}'.repeat(300), H1, 200);
    const t = db.prepare('SELECT last_text FROM channels').get().last_text;
    expect(Array.from(t).length).toBe(140);
    expect(t).toBe('\u{1F600}'.repeat(140));
    await post(env, 'room-one', 'y'.repeat(140), H1, 300);
    expect(db.prepare('SELECT last_text FROM channels').get().last_text).toBe('y'.repeat(140));
    expect(previewText('  ')).toBe('');
    expect(previewText('a'.repeat(139) + '\u{1F600}b')).toBe('a'.repeat(139) + '\u{1F600}');
  });

  it('does not change anything when the message is refused (duplicate)', async () => {
    const { env, db } = setup();
    const record = { v: 2, type: 'message', channelId: 'room-one', body: 'only once', replyTo: '', signer: H1, createdAt: 100, nonce: '1'.repeat(32) };
    await appendMessage(env, record, 's'.repeat(86));
    await post(env, 'room-one', 'later one', H('b'), 200);
    await expect(appendMessage(env, record, 's'.repeat(86))).rejects.toMatchObject({ code: 'exists' });
    const row = db.prepare('SELECT message_count, last_text, last_signer_name FROM channels').get();
    expect({ ...row }).toEqual({ message_count: 2, last_text: 'later one', last_signer_name: 'Rahul' });
  });

  it('the preview and the message land together or not at all (batch)', async () => {
    const { db } = setup();
    // a database whose preview update fails: the message insert must be rolled back
    db.exec('CREATE TRIGGER block_preview BEFORE UPDATE OF last_text ON channels BEGIN SELECT RAISE(ABORT, \'preview blocked\'); END;');
    const env = { DB: fakeD1(db) };
    await expect(post(env, 'room-one', 'will fail')).rejects.toThrow(/preview blocked/);
    expect(count(db, 'messages')).toBe(0);
    expect(db.prepare('SELECT message_count FROM channels').get().message_count).toBe(0);
  });

  it('GET /api/channels and the message page carry lastText and lastSignerName', async () => {
    const { env } = setup();
    await post(env, 'room-one', 'visible in the list');
    const list = await callApi(env, 'GET', '/api/channels');
    expect(list.json.channels[0]).toMatchObject({ channelId: 'room-one', lastText: 'visible in the list', lastSignerName: 'Priya', messageCount: 1 });
    const page = await callApi(env, 'GET', '/api/channels/room-one/messages');
    expect(page.json.channel).toMatchObject({ lastText: 'visible in the list', lastSignerName: 'Priya' });
  });

  it('a channel without messages has empty strings', async () => {
    const { env } = setup();
    const list = await callApi(env, 'GET', '/api/channels');
    expect(list.json.channels[0]).toMatchObject({ lastText: '', lastSignerName: '', lastMessageAt: null });
  });
});
