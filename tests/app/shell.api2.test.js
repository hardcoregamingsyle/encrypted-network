// The account calls in src/lib/api.js: urls, methods, bodies, and how errors look.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../src/lib/api.js';

let fetchMock;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function last() {
  const [url, init] = fetchMock.mock.calls.at(-1);
  return { url, init };
}

const DOC = 'ab'.repeat(16);

describe('account calls', () => {
  it('health is a plain GET', async () => {
    fetchMock.mockImplementation(async () => json({ ok: true, mail: 'resend', accounts: true }));
    const out = await api.getHealth();
    expect(out.mail).toBe('resend');
    expect(last().url).toBe('/api/health');
    expect(last().init.method).toBe('GET');
  });

  it('every call sends the cookie (same origin credentials) and no cache', async () => {
    await api.authRequest('a@b.co');
    await api.getMe();
    await api.deleteMe();
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.credentials).toBe('same-origin');
      expect(init.cache).toBe('no-store');
    }
  });

  it('asks for a code and verifies it', async () => {
    await api.authRequest('priya@example.com');
    expect(last().url).toBe('/api/auth/request');
    expect(last().init.method).toBe('POST');
    expect(JSON.parse(last().init.body)).toEqual({ email: 'priya@example.com' });
    await api.authVerify('priya@example.com', '123456');
    expect(last().url).toBe('/api/auth/verify');
    expect(JSON.parse(last().init.body)).toEqual({ email: 'priya@example.com', code: '123456' });
  });

  it('logs out with a POST', async () => {
    await api.authLogout();
    expect(last().url).toBe('/api/auth/logout');
    expect(last().init.method).toBe('POST');
  });

  it('reads the account and its keys', async () => {
    fetchMock.mockImplementation(async () => json({ account: { id: 'x' }, keys: [] }));
    const out = await api.getMe();
    expect(out.keys).toEqual([]);
    expect(last().url).toBe('/api/me');
    expect(last().init.method).toBe('GET');
  });

  it('registers a key with and without the private part', async () => {
    const record = { v: 2, type: 'identity' };
    await api.postMyKey({ record, signature: 's', privateJwk: { d: 'x' } });
    expect(last().url).toBe('/api/me/key');
    expect(last().init.method).toBe('POST');
    expect(JSON.parse(last().init.body)).toEqual({ record, signature: 's', privateJwk: { d: 'x' } });
    await api.postMyKey({ record, signature: 's' });
    expect(JSON.parse(last().init.body)).toEqual({ record, signature: 's' });
    await api.getMyKey();
    expect(last().url).toBe('/api/me/key');
    expect(last().init.method).toBe('GET');
  });

  it('lists the account documents with a cursor', async () => {
    await api.listMyDocuments({ limit: 20, before: 5, beforeId: DOC });
    expect(last().url).toBe(`/api/me/documents?limit=20&before=5&beforeId=${DOC}`);
    await api.listMyDocuments();
    expect(last().url).toBe('/api/me/documents');
  });

  it('puts and gets a file password', async () => {
    await api.putSecret(DOC, 'ABCD-EFGH');
    expect(last().url).toBe(`/api/me/secrets/${DOC}`);
    expect(last().init.method).toBe('PUT');
    expect(JSON.parse(last().init.body)).toEqual({ password: 'ABCD-EFGH' });
    await api.getSecret(DOC);
    expect(last().init.method).toBe('GET');
  });

  it('encodes ids in the path', async () => {
    await api.getSecret('a/b c');
    expect(last().url).toBe('/api/me/secrets/a%2Fb%20c');
  });

  it('switches Strict mode and deletes the account', async () => {
    await api.postStrict(true);
    expect(last().url).toBe('/api/me/strict');
    expect(JSON.parse(last().init.body)).toEqual({ enabled: true });
    await api.postStrict(0);
    expect(JSON.parse(last().init.body)).toEqual({ enabled: false });
    // paging: after is the docId to go on from, confirmThrough is the last docId that was stored
    const id = 'ab'.repeat(16);
    await api.postStrict(true, { after: id });
    expect(JSON.parse(last().init.body)).toEqual({ enabled: true, after: id });
    await api.postStrict(true, { confirmThrough: id });
    expect(JSON.parse(last().init.body)).toEqual({ enabled: true, confirmThrough: id });
    await api.deleteMe();
    expect(last().url).toBe('/api/me');
    expect(last().init.method).toBe('DELETE');
    expect(last().init.body).toBeUndefined();
  });
});

describe('errors from the account calls', () => {
  it('keeps the code the server sends', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'That code is wrong.', code: 'invalid_code' }, 400));
    await expect(api.authVerify('a@b.co', '000000')).rejects.toMatchObject({ status: 400, code: 'invalid_code', message: 'That code is wrong.' });
  });

  it('a 401 without a body is unauthenticated', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 401 }));
    await expect(api.getMe()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  it('a 429 carries how long to wait', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'Slow down.', code: 'rate_limited' }, 429, { 'retry-after': '27' }));
    await expect(api.authRequest('a@b.co')).rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 27 });
  });

  it('a silly Retry-After is capped or ignored', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'x', code: 'rate_limited' }, 429, { 'retry-after': '999999' }));
    await expect(api.authRequest('a@b.co')).rejects.toMatchObject({ retryAfter: 3600 });
    fetchMock.mockImplementation(async () => json({ error: 'x', code: 'rate_limited' }, 429, { 'retry-after': 'soon' }));
    await expect(api.authRequest('a@b.co')).rejects.toMatchObject({ retryAfter: 0 });
  });

  it('503 mail_unavailable is not retried like a busy answer', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'No mail.', code: 'mail_unavailable' }, 503));
    await expect(api.authRequest('a@b.co')).rejects.toMatchObject({ code: 'mail_unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a network failure is a plain network error', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('failed');
    });
    await expect(api.getMe()).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});
