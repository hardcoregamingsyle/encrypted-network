// Private chats: members only, a group password nobody picks, messages signed by a key of the member who writes.
import { describe, expect, it } from 'vitest';
import { signRecord } from '../../shared/keys.js';
import { accountEnv, callApi, makeKey, signIn } from './fakes.js';

const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

async function person(env, name) {
  const s = await signIn(env);
  const k = await makeKey(name);
  expect((await callApi(env, 'POST', '/api/me/key', { jar: s.jar, json: { record: k.record, signature: k.signature } })).status).toBe(201);
  return { ...s, k };
}

async function channelRecord(who, channelId) {
  const record = { v: 2, type: 'channel.create', channelId, title: 'Study group', docId: '', signer: who.k.keyId, createdAt: Date.now() };
  return { record, signature: await signRecord(who.k.privateKey, record) };
}

// a locked message is base64url text of at least 39 characters
const LOCKED = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5';

async function messageRecord(who, channelId, body = LOCKED) {
  const record = { v: 2, type: 'message', channelId, body, replyTo: '', signer: who.k.keyId, createdAt: Date.now(), nonce: nonce() };
  return { record, signature: await signRecord(who.k.privateKey, record) };
}

async function setup() {
  const ctx = accountEnv();
  const [a, b, c] = [await person(ctx.env, 'Asha'), await person(ctx.env, 'Bilal'), await person(ctx.env, 'Chen')];
  const channelId = 'study-group-' + Math.floor(Math.random() * 1e6);
  const { record, signature } = await channelRecord(a, channelId);
  const made = await callApi(ctx.env, 'POST', '/api/channels', { jar: a.jar, json: { record, signature, members: [b.email] } });
  expect(made.status).toBe(201);
  return { ...ctx, a, b, c, channelId, made };
}

const list = (env, who) => callApi(env, 'GET', '/api/channels', { jar: who && who.jar });
const read = (ctx, who) => callApi(ctx.env, 'GET', `/api/channels/${ctx.channelId}/messages`, { jar: who && who.jar });
const send = async (ctx, who, over = {}) => {
  const m = await messageRecord(over.as || who || ctx.b, ctx.channelId);
  return callApi(ctx.env, 'POST', `/api/channels/${ctx.channelId}/messages`, { jar: who && who.jar, json: m, origin: over.origin });
};

describe('creating a private chat', () => {
  it('marks it private, and the creator and the invited account are the members', async () => {
    const ctx = await setup();
    expect(ctx.made.json.channel).toMatchObject({ channelId: ctx.channelId, private: true });
    const rows = ctx.db.prepare('SELECT account_id FROM channel_members WHERE channel_id = ? ORDER BY account_id').all(ctx.channelId).map((r) => r.account_id);
    expect(rows.sort()).toEqual([ctx.a.account.id, ctx.b.account.id].sort());
    expect(ctx.db.prepare('SELECT sealed FROM channels WHERE channel_id = ?').get(ctx.channelId).sealed).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it('refuses a sign in that is missing, an address with no account, a key of someone else, and a bad list', async () => {
    const ctx = await setup();
    const fresh = async (who, members, over = {}) => {
      const id = 'room-' + Math.floor(Math.random() * 1e9);
      const { record, signature } = await channelRecord(over.as || who, id);
      return callApi(ctx.env, 'POST', '/api/channels', { jar: over.noJar ? undefined : who.jar, json: { record, signature, members }, origin: over.origin });
    };
    expect((await fresh(ctx.a, [ctx.b.email], { noJar: true })).status).toBe(401);
    const unknown = await fresh(ctx.a, ['nobody-here@example.test']);
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe('nobody-here@example.test has no account here');
    expect((await fresh(ctx.a, [ctx.b.email], { as: ctx.b })).status).toBe(403);
    expect((await fresh(ctx.a, [ctx.b.email], { origin: 'https://evil.example' })).status).toBe(403);
    for (const bad of [[], 'x', [5], Array.from({ length: 20 }, (_, i) => `p${i}@example.test`)]) {
      expect((await fresh(ctx.a, bad)).status, JSON.stringify(bad).slice(0, 30)).toBe(400);
    }
    expect((await fresh(ctx.a, ['not an email'])).status).toBe(400);
  });

  it('a chat without members is public as before: listed for everyone, no sign in needed', async () => {
    const ctx = await setup();
    const { record, signature } = await channelRecord(ctx.a, 'open-room-1');
    const made = await callApi(ctx.env, 'POST', '/api/channels', { json: { record, signature } });
    expect(made.status).toBe(201);
    expect(made.json.channel.private).toBeUndefined();
    expect((await list(ctx.env)).json.channels.map((c) => c.channelId)).toEqual(['open-room-1']);
  });
});

describe('who can see a private chat', () => {
  it('the list shows it to its members only', async () => {
    const ctx = await setup();
    const ids = async (who) => (await list(ctx.env, who)).json.channels.map((c) => c.channelId);
    expect(await ids(ctx.a)).toEqual([ctx.channelId]);
    expect(await ids(ctx.b)).toEqual([ctx.channelId]);
    expect(await ids(ctx.c)).toEqual([]);
    expect(await ids(null)).toEqual([]);
    expect((await list(ctx.env, ctx.b)).json.channels[0].private).toBe(true);
  });

  it('reading the messages is for members only, everybody else gets not found', async () => {
    const ctx = await setup();
    expect((await read(ctx, ctx.a)).status).toBe(200);
    expect((await read(ctx, ctx.b)).status).toBe(200);
    expect((await read(ctx, ctx.c)).status).toBe(404);
    expect((await read(ctx, null)).status).toBe(404);
    expect((await callApi(ctx.env, 'GET', '/api/channels/no-such-room-1/messages')).status).toBe(404);
  });

  it('the group password goes to members only, is the same for all of them, and differs per chat', async () => {
    const ctx = await setup();
    const keyOf = (who, id = ctx.channelId) => callApi(ctx.env, 'GET', `/api/channels/${id}/key`, { jar: who && who.jar });
    const ka = await keyOf(ctx.a);
    const kb = await keyOf(ctx.b);
    expect(ka.status).toBe(200);
    expect(ka.json.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(kb.json.key).toBe(ka.json.key);
    expect(ka.headers.get('cache-control')).toBe('no-store');
    expect((await keyOf(ctx.c)).status).toBe(404);
    expect((await keyOf(null)).status).toBe(404);
    const { record, signature } = await channelRecord(ctx.a, 'second-room-1');
    await callApi(ctx.env, 'POST', '/api/channels', { jar: ctx.a.jar, json: { record, signature, members: [ctx.c.email] } });
    expect((await keyOf(ctx.a, 'second-room-1')).json.key).not.toBe(ka.json.key);
    const open = await channelRecord(ctx.a, 'open-room-2');
    await callApi(ctx.env, 'POST', '/api/channels', { json: { record: open.record, signature: open.signature } });
    expect((await keyOf(ctx.a, 'open-room-2')).status).toBe(404); // a public chat has no group password
  });
});

describe('writing in a private chat', () => {
  it('a member writes with a key of their own account, the list preview stays empty', async () => {
    const ctx = await setup();
    const sent = await send(ctx, ctx.b);
    expect(sent.status).toBe(201);
    const shown = (await read(ctx, ctx.a)).json;
    expect(shown.messages).toHaveLength(1);
    const row = (await list(ctx.env, ctx.a)).json.channels[0];
    expect(row).toMatchObject({ messageCount: 1, lastText: '' });
  });

  it('refuses a message that is not locked, so readable text never lands in a private chat', async () => {
    const ctx = await setup();
    for (const body of ['hello everyone', 'short', 'has spaces in it and is long enough to pass the length check', 'QUJD' + '='.repeat(40)]) {
      const m = await messageRecord(ctx.b, ctx.channelId, body);
      const res = await callApi(ctx.env, 'POST', `/api/channels/${ctx.channelId}/messages`, { jar: ctx.b.jar, json: m });
      expect(res.status, body).toBe(400);
    }
    expect((await read(ctx, ctx.a)).json.messages).toHaveLength(0);
  });

  it('a stranger cannot tell a private chat from one that does not exist, whatever the message looks like', async () => {
    const ctx = await setup();
    const stranger = await makeKey('Stranger'); // a key the server has never seen
    const m = await messageRecord({ k: stranger }, ctx.channelId);
    const post = (id, over = {}) => callApi(ctx.env, 'POST', `/api/channels/${id}/messages`, { json: { record: { ...m.record, channelId: id }, signature: m.signature }, ...over });
    const real = await post(ctx.channelId);
    const none = await post('no-such-room-77');
    expect(real.status).toBe(404);
    expect(none.status).toBe(404);
    expect(real.json).toEqual(none.json);
    expect((await post(ctx.channelId, { origin: null })).status).toBe(404); // no Origin header at all
    const outsider = await person(ctx.env, 'Outsider');
    expect((await post(ctx.channelId, { jar: outsider.jar })).status).toBe(404);
  });

  it('refuses a non member, a visitor, another member\'s key, and another site', async () => {
    const ctx = await setup();
    expect((await send(ctx, ctx.c)).status).toBe(404);
    expect((await send(ctx, null)).status).toBe(404);
    expect((await send(ctx, ctx.b, { as: ctx.a })).status).toBe(403);
    expect((await send(ctx, ctx.b, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await read(ctx, ctx.a)).json.messages).toHaveLength(0);
  });

  it('a public chat still takes a message from a visitor and shows its preview', async () => {
    const ctx = await setup();
    const { record, signature } = await channelRecord(ctx.a, 'open-room-3');
    await callApi(ctx.env, 'POST', '/api/channels', { json: { record, signature } });
    const m = await messageRecord(ctx.b, 'open-room-3', 'hello all');
    expect((await callApi(ctx.env, 'POST', '/api/channels/open-room-3/messages', { json: m })).status).toBe(201);
    expect((await list(ctx.env)).json.channels[0]).toMatchObject({ channelId: 'open-room-3', lastText: 'hello all' });
  });
});

describe('adding people later', () => {
  const add = (ctx, who, members, origin) => callApi(ctx.env, 'POST', `/api/channels/${ctx.channelId}/members`, { jar: who && who.jar, json: { members }, origin });

  it('a member adds someone, who then sees the chat and its password; adding again adds nobody', async () => {
    const ctx = await setup();
    const added = await add(ctx, ctx.b, [ctx.c.email]);
    expect(added.status).toBe(200);
    expect(added.json).toEqual({ ok: true, added: 1 });
    expect((await read(ctx, ctx.c)).status).toBe(200);
    expect((await callApi(ctx.env, 'GET', `/api/channels/${ctx.channelId}/key`, { jar: ctx.c.jar })).status).toBe(200);
    expect((await add(ctx, ctx.a, [ctx.c.email, ctx.b.email])).json.added).toBe(0);
  });

  it('is for members only, needs real addresses and the same site, and a chat holds 20 people at most', async () => {
    const ctx = await setup();
    expect((await add(ctx, ctx.c, [ctx.c.email])).status).toBe(404);
    expect((await add(ctx, null, [ctx.c.email])).status).toBe(404);
    expect((await add(ctx, ctx.a, ['nobody-here@example.test'])).status).toBe(400);
    expect((await add(ctx, ctx.a, [ctx.c.email], 'https://evil.example')).status).toBe(403);
    expect((await add(ctx, ctx.a, [])).status).toBe(400);
    expect((await read(ctx, ctx.c)).status).toBe(404);
    for (let i = 0; i < 17; i++) ctx.db.prepare('INSERT INTO channel_members (channel_id, account_id) VALUES (?, ?)').run(ctx.channelId, 'f'.repeat(30) + String(i).padStart(2, '0'));
    expect((await add(ctx, ctx.a, [ctx.c.email])).status).toBe(200); // the 20th person
    const extra = await person(ctx.env, 'Dev');
    expect((await add(ctx, ctx.a, [extra.email])).status).toBe(409);
  });

  it('deleting an account takes it out of its chats', async () => {
    const ctx = await setup();
    const gone = await callApi(ctx.env, 'DELETE', '/api/me', { jar: ctx.b.jar });
    expect(gone.status).toBe(200);
    const rows = ctx.db.prepare('SELECT account_id FROM channel_members WHERE channel_id = ?').all(ctx.channelId).map((r) => r.account_id);
    expect(rows).toEqual([ctx.a.account.id]);
  });
});
