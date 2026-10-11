// Private files: only the owning account can store, list, read back and delete them.
import { describe, expect, it } from 'vitest';
import { onRequestGet as downloadRoute } from '../../functions/api/me/files/[id].js';
import { PRIVATE_QUOTA_BYTES } from '../../functions/api/me/files/index.js';
import { GLOBAL_BLOB_CAP_BYTES, storeBlob } from '../../functions/_lib/blobs.js';
import { sha256Hex } from '../../shared/hash.js';
import { signRecord, verifyRecord } from '../../shared/keys.js';
import { accountEnv, callApi, fakeKV, lockedBytes, makeKey, signIn, streamOfBytes } from './fakes.js';

async function setup(kind) {
  const ctx = kind === 'kv' ? accountEnv({ env: { FILES: undefined, BLOBS: fakeKV() } }) : accountEnv();
  const s = await signIn(ctx.env);
  const k = await makeKey('Owner');
  const reg = await callApi(ctx.env, 'POST', '/api/me/key', { jar: s.jar, json: { record: k.record, signature: k.signature } });
  expect(reg.status).toBe(201);
  return { ...ctx, s, k };
}

async function upload({ env, s, k }, bytes, over = {}) {
  const hash = over.hash || (await sha256Hex(bytes));
  const createdAt = over.time || Date.now();
  const sig = over.sig || (await signRecord(k.privateKey, { v: 2, type: 'blob.put', hash, size: bytes.length, signer: k.keyId, createdAt }));
  return callApi(env, 'POST', '/api/me/files', {
    jar: over.jar || s.jar,
    origin: over.origin,
    body: bytes,
    headers: {
      'x-file-label': encodeURIComponent(over.label === undefined ? 'notes.txt' : over.label),
      'x-blob-sha256': hash,
      'x-hrd-key': over.key || k.keyId,
      'x-hrd-time': String(createdAt),
      'x-hrd-sig': sig,
      'content-length': String(bytes.length)
    }
  });
}

describe.each(['r2', 'kv'])('private files on %s', (kind) => {
  it('stores a file, lists it, gives the same bytes back with the owner signature, and deletes it', async () => {
    const ctx = await setup(kind);
    const bytes = lockedBytes(400);
    const up = await upload(ctx, bytes);
    expect(up.status).toBe(201);
    const id = up.json.id;

    const list = await callApi(ctx.env, 'GET', '/api/me/files', { jar: ctx.s.jar });
    expect(list.json.files).toEqual([{ id, label: 'notes.txt', size: 400, createdAt: expect.any(Number) }]);

    const res = await downloadRoute({ request: new Request('http://localhost/api/me/files/' + id, { headers: { Cookie: ctx.s.jar.header() } }), env: ctx.env, params: { id } });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    // what the browser needs to check the bytes against the owner's signature
    const record = { v: 2, type: 'blob.put', hash: res.headers.get('x-blob-sha256'), size: 400, signer: res.headers.get('x-hrd-key'), createdAt: Number(res.headers.get('x-hrd-time')) };
    expect(record.hash).toBe(await sha256Hex(bytes));
    expect(await verifyRecord(ctx.k.publicJwk, record, res.headers.get('x-hrd-sig'))).toBe(true);

    const del = await callApi(ctx.env, 'DELETE', '/api/me/files/' + id, { jar: ctx.s.jar });
    expect(del.status).toBe(200);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM private_files').get().n).toBe(0);
    expect((await callApi(ctx.env, 'GET', '/api/me/files/' + id, { jar: ctx.s.jar })).status).toBe(404);
  });

  it('is invisible to every other account and to people who are signed out', async () => {
    const ctx = await setup(kind);
    const id = (await upload(ctx, lockedBytes(300))).json.id;
    const other = await signIn(ctx.env);
    expect((await callApi(ctx.env, 'GET', '/api/me/files', { jar: other.jar })).json.files).toEqual([]);
    expect((await callApi(ctx.env, 'GET', '/api/me/files/' + id, { jar: other.jar })).status).toBe(404);
    expect((await callApi(ctx.env, 'DELETE', '/api/me/files/' + id, { jar: other.jar })).status).toBe(404);
    expect((await callApi(ctx.env, 'GET', '/api/me/files')).status).toBe(401);
    expect((await callApi(ctx.env, 'GET', '/api/me/files/' + id)).status).toBe(401);
    // still there for the owner
    expect((await callApi(ctx.env, 'GET', '/api/me/files', { jar: ctx.s.jar })).json.files).toHaveLength(1);
  });

  it('refuses a request from another site, a key of another account, a bad signature and a stale time', async () => {
    const ctx = await setup(kind);
    const stranger = await makeKey('Stranger');
    await callApi(ctx.env, 'POST', '/api/identities', { json: { record: stranger.record, signature: stranger.signature }, ip: '127.1.2.3' });
    expect((await upload(ctx, lockedBytes(300), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await upload(ctx, lockedBytes(300), { key: stranger.keyId })).status).toBeGreaterThanOrEqual(400);
    expect((await upload(ctx, lockedBytes(300), { sig: 'A'.repeat(86) })).status).toBe(400);
    expect((await upload(ctx, lockedBytes(300), { time: Date.now() - 3600 * 1000 })).status).toBe(400);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM private_files').get().n).toBe(0);
  });

  it('refuses bytes that do not match the signed hash, non locked files and bad names, and keeps nothing', async () => {
    const ctx = await setup(kind);
    const wrong = await sha256Hex(lockedBytes(300));
    expect((await upload(ctx, lockedBytes(300), { hash: wrong })).status).toBe(400);
    const plain = new Uint8Array(300).fill(65);
    expect((await upload(ctx, plain)).status).toBe(400);
    expect((await upload(ctx, lockedBytes(300), { label: '' })).status).toBe(400);
    expect((await upload(ctx, lockedBytes(300), { label: 'x'.repeat(121) })).status).toBe(400);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM private_files').get().n).toBe(0);
  });

  it('stops at the quota of one account', async () => {
    const ctx = await setup(kind);
    const accountId = ctx.s.account.id;
    ctx.db.prepare('INSERT INTO private_files (id, account_id, label, size, blob_hash, signer, signed_at, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('a'.repeat(32), accountId, 'big', PRIVATE_QUOTA_BYTES - 200, 'b'.repeat(64), ctx.k.keyId, 1, 'sig', 1);
    expect((await upload(ctx, lockedBytes(300))).status).toBe(413);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM private_files').get().n).toBe(1);
  });
});

// ---- found by the review of this step ----
const storeOf = (env) => env.FILES || env.BLOBS;
const addRows = (ctx, n, size = 200) => {
  for (let i = 0; i < n; i++) {
    const id = i.toString(16).padStart(32, '0');
    ctx.db.prepare('INSERT INTO private_files (id, account_id, label, size, blob_hash, signer, signed_at, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, ctx.s.account.id, 'f' + i, size, 'b'.repeat(64), ctx.k.keyId, 1, 'sig', i);
    storeOf(ctx.env).objects.set('private/' + id, new Uint8Array(size));
  }
};

describe.each(['r2', 'kv'])('private files, review fixes on %s', (kind) => {
  it('a file deleted while it is still arriving leaves nothing behind and the upload says so', async () => {
    const ctx = await setup(kind);
    const store = storeOf(ctx.env);
    const realPut = store.put.bind(store);
    let open;
    const gate = new Promise((r) => (open = r));
    store.put = async (...a) => {
      await gate;
      return realPut(...a);
    };
    const pending = upload(ctx, lockedBytes(300));
    let id = null;
    for (let i = 0; i < 100 && !id; i++) {
      const row = ctx.db.prepare('SELECT id FROM private_files').get();
      if (row) id = row.id;
      else await new Promise((r) => setTimeout(r, 5));
    }
    expect(id).not.toBeNull();
    expect((await callApi(ctx.env, 'DELETE', '/api/me/files/' + id, { jar: ctx.s.jar })).status).toBe(200);
    open();
    expect((await pending).status).toBe(404);
    expect(store.objects.size).toBe(0);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM private_files').get().n).toBe(0);
  });

  it('deleting the account removes its private files, rows and bytes, in rounds of 40', async () => {
    const ctx = await setup(kind);
    expect((await upload(ctx, lockedBytes(300))).status).toBe(201);
    addRows(ctx, 45);
    const first = await callApi(ctx.env, 'DELETE', '/api/me', { jar: ctx.s.jar });
    expect(first.status).toBe(409);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n).toBe(1);
    const second = await callApi(ctx.env, 'DELETE', '/api/me', { jar: ctx.s.jar });
    expect(second.status).toBe(200);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM private_files').get().n).toBe(0);
    expect(storeOf(ctx.env).objects.size).toBe(0);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n).toBe(0);
  });

  it('stops at 200 files per account and refuses invisible or direction changing characters in names', async () => {
    const ctx = await setup(kind);
    addRows(ctx, 200, 1);
    expect((await upload(ctx, lockedBytes(300))).status).toBe(413);
    ctx.db.prepare('DELETE FROM private_files').run();
    for (const label of ['\u202eexe.png', '\u200b', 'a\u0085b', 'a\u2028b']) {
      expect((await upload(ctx, lockedBytes(300), { label })).status).toBe(400);
    }
    expect((await upload(ctx, lockedBytes(300), { label: 'Rechnung \u00e4\u00f6\u00fc 2026.pdf' })).status).toBe(201);
  });

  it('private bytes count against the shared cap that public uploads obey', async () => {
    const ctx = await setup(kind);
    ctx.db.prepare('INSERT INTO private_files (id, account_id, label, size, blob_hash, signer, signed_at, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('c'.repeat(32), ctx.s.account.id, 'big', GLOBAL_BLOB_CAP_BYTES - 100, 'b'.repeat(64), ctx.k.keyId, 1, 'sig', 1);
    const bytes = lockedBytes(300);
    const err = await storeBlob(ctx.env, { body: streamOfBytes(bytes), hash: await sha256Hex(bytes), size: 300, signer: ctx.k.keyId, now: Date.now() }).catch((e) => e);
    expect(err.code).toBe('too_large');
  });
});
