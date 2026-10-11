// The files password fingerprint: set once, read back by the owner only.
import { describe, expect, it } from 'vitest';
import { accountEnv, callApi, signIn } from './fakes.js';

const CHECK = 'ab'.repeat(32);

describe('/api/me/files-check', () => {
  it('is empty at first, can be set once, and then reads back the same value', async () => {
    const { env, db } = accountEnv();
    const s = await signIn(env);
    expect((await callApi(env, 'GET', '/api/me/files-check', { jar: s.jar })).json).toEqual({ check: null });
    expect((await callApi(env, 'PUT', '/api/me/files-check', { jar: s.jar, json: { check: CHECK } })).status).toBe(200);
    const read = await callApi(env, 'GET', '/api/me/files-check', { jar: s.jar });
    expect(read.json).toEqual({ check: CHECK });
    expect(read.headers.get('cache-control')).toBe('no-store');
    // a second try, even with the same value, is refused and nothing changes
    const again = await callApi(env, 'PUT', '/api/me/files-check', { jar: s.jar, json: { check: 'cd'.repeat(32) } });
    expect(again.status).toBe(409);
    expect(db.prepare('SELECT files_check FROM accounts WHERE id = ?').get(s.account.id).files_check).toBe(CHECK);
  });

  it('belongs to one account: another account sees nothing and can set its own', async () => {
    const { env } = accountEnv();
    const a = await signIn(env);
    const b = await signIn(env);
    await callApi(env, 'PUT', '/api/me/files-check', { jar: a.jar, json: { check: CHECK } });
    expect((await callApi(env, 'GET', '/api/me/files-check', { jar: b.jar })).json).toEqual({ check: null });
    expect((await callApi(env, 'PUT', '/api/me/files-check', { jar: b.jar, json: { check: 'cd'.repeat(32) } })).status).toBe(200);
    expect((await callApi(env, 'GET', '/api/me/files-check', { jar: a.jar })).json).toEqual({ check: CHECK });
  });

  it('needs a session, the same site, and a value of the right shape', async () => {
    const { env, db } = accountEnv();
    const s = await signIn(env);
    expect((await callApi(env, 'GET', '/api/me/files-check')).status).toBe(401);
    expect((await callApi(env, 'PUT', '/api/me/files-check', { json: { check: CHECK } })).status).toBe(401);
    expect((await callApi(env, 'PUT', '/api/me/files-check', { jar: s.jar, origin: 'https://evil.example', json: { check: CHECK } })).status).toBe(403);
    for (const bad of [undefined, '', 'AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32), 12, ['ab'.repeat(32)]]) {
      expect((await callApi(env, 'PUT', '/api/me/files-check', { jar: s.jar, json: { check: bad } })).status).toBe(400);
    }
    expect(db.prepare('SELECT files_check FROM accounts WHERE id = ?').get(s.account.id).files_check).toBeNull();
  });
});
