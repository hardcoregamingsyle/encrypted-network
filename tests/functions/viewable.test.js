// "Viewable" public files: the owner lets anyone open the file, then the file password is handed out.
import { describe, expect, it } from 'vitest';
import { accountEnv, callApi, makeKey, randomDocId, seedDocument, signIn } from './fakes.js';

const PASSWORD = 'ABCD-EFGH-JKLM-NPQR-STUV';

async function setup() {
  const ctx = accountEnv();
  const s = await signIn(ctx.env);
  const k = await makeKey('Owner');
  expect((await callApi(ctx.env, 'POST', '/api/me/key', { jar: s.jar, json: { record: k.record, signature: k.signature } })).status).toBe(201);
  const docId = randomDocId();
  seedDocument(ctx.db, { docId, ownerKeyId: k.keyId });
  return { ...ctx, s, k, docId };
}

const keep = (ctx, password = PASSWORD, docId = ctx.docId) => callApi(ctx.env, 'PUT', `/api/me/secrets/${docId}`, { jar: ctx.s.jar, json: { password } });
const put = (ctx, on, over = {}) => callApi(ctx.env, 'PUT', `/api/documents/${over.docId || ctx.docId}/view`, { jar: over.jar || ctx.s.jar, json: { on }, origin: over.origin });
const look = (ctx, docId = ctx.docId) => callApi(ctx.env, 'GET', `/api/documents/${docId}/view`);

describe('GET and PUT /api/documents/:docId/view', () => {
  it('is off by default and says nothing else', async () => {
    const ctx = await setup();
    await keep(ctx);
    const res = await look(ctx);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ viewable: false });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('when the owner turns it on, anyone without a sign in gets the password, and off takes it back', async () => {
    const ctx = await setup();
    expect((await keep(ctx)).status).toBe(200);
    const on = await put(ctx, true);
    expect(on.status).toBe(200);
    expect(on.json).toEqual({ ok: true, viewable: true });
    const open = await look(ctx);
    expect(open.json).toEqual({ viewable: true, password: PASSWORD });
    expect(open.headers.get('cache-control')).toBe('no-store');
    expect((await put(ctx, false)).status).toBe(200);
    expect((await look(ctx)).json).toEqual({ viewable: false });
  });

  it('needs the password to be kept on the server first, and a known document', async () => {
    const ctx = await setup();
    const none = await put(ctx, true);
    expect(none.status).toBe(409);
    expect(none.json.error).toMatch(/does not keep the password/);
    expect((await put(ctx, true, { docId: randomDocId() })).status).toBe(404);
    expect((await look(ctx)).json).toEqual({ viewable: false });
  });

  it('only the owner can change it, and only with a sign in and the same site', async () => {
    const ctx = await setup();
    await keep(ctx);
    const other = await signIn(ctx.env);
    expect((await put(ctx, true, { jar: other.jar })).status).toBe(403);
    expect((await callApi(ctx.env, 'PUT', `/api/documents/${ctx.docId}/view`, { json: { on: true } })).status).toBe(401);
    expect((await put(ctx, true, { origin: 'https://evil.example' })).status).toBe(403);
    for (const bad of [{}, { on: 'yes' }, { on: 1 }, { on: null }]) {
      expect((await callApi(ctx.env, 'PUT', `/api/documents/${ctx.docId}/view`, { jar: ctx.s.jar, json: bad })).status).toBe(400);
    }
    expect((await look(ctx)).json).toEqual({ viewable: false });
  });

  it('stops handing out the password when the file is withdrawn or the stored password is gone', async () => {
    const ctx = await setup();
    await keep(ctx);
    await put(ctx, true);
    ctx.db.prepare('DELETE FROM account_secrets').run();
    expect((await look(ctx)).json).toEqual({ viewable: false });
    await keep(ctx);
    expect((await look(ctx)).json.viewable).toBe(true);
    ctx.db.prepare("UPDATE documents SET status = 'revoked'").run();
    expect((await look(ctx)).json).toEqual({ viewable: false });
    expect((await put(ctx, true)).status).toBe(409);
  });

  it('a Strict account keeps no password on the server: switching to Strict turns viewable off for good', async () => {
    const ctx = await setup();
    await keep(ctx);
    await put(ctx, true);
    expect((await look(ctx)).json.viewable).toBe(true);
    const strict = await callApi(ctx.env, 'POST', '/api/me/strict', { jar: ctx.s.jar, json: { enabled: true } });
    expect(strict.status).toBe(200);
    expect((await look(ctx)).json).toEqual({ viewable: false });
    expect(ctx.db.prepare('SELECT viewable FROM documents WHERE doc_id = ?').get(ctx.docId).viewable).toBe(0);
    // the leftover copy of the password (kept for the handover) can not switch it on again
    expect((await put(ctx, true)).status).toBe(409);
    expect((await put(ctx, false)).status).toBe(200);
    // back to Easy: it stays off until the owner turns it on
    expect((await callApi(ctx.env, 'POST', '/api/me/strict', { jar: ctx.s.jar, json: { enabled: false } })).status).toBe(200);
    await keep(ctx);
    expect((await look(ctx)).json).toEqual({ viewable: false });
    expect((await put(ctx, true)).status).toBe(200);
    expect((await look(ctx)).json.viewable).toBe(true);
  });

  it('deleting the account turns viewable off', async () => {
    const ctx = await setup();
    await keep(ctx);
    await put(ctx, true);
    expect((await callApi(ctx.env, 'DELETE', '/api/me', { jar: ctx.s.jar })).status).toBe(200);
    expect(ctx.db.prepare('SELECT viewable FROM documents WHERE doc_id = ?').get(ctx.docId).viewable).toBe(0);
    expect((await look(ctx)).json).toEqual({ viewable: false });
  });

  it('a bad id is a 400 and the password of one file is never given for another', async () => {
    const ctx = await setup();
    await keep(ctx);
    await put(ctx, true);
    expect((await callApi(ctx.env, 'GET', '/api/documents/not-an-id/view')).status).toBe(400);
    const second = randomDocId();
    seedDocument(ctx.db, { docId: second, ownerKeyId: ctx.k.keyId });
    expect((await look(ctx, second)).json).toEqual({ viewable: false });
  });
});
