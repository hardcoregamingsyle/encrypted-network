// The calls for the devices list, sign out everywhere, and the 401 hook in src/lib/api.js.
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
  api.setUnauthenticatedHandler(null);
  vi.unstubAllGlobals();
});

function last() {
  const [url, init] = fetchMock.mock.calls.at(-1);
  return { url, init };
}

describe('devices list calls', () => {
  it('lists the sessions with a GET', async () => {
    fetchMock.mockImplementation(async () => json({ sessions: [{ id: 'a'.repeat(16), createdAt: 1, lastSeenAt: 2, expiresAt: 3, current: true }] }));
    const out = await api.getSessions();
    expect(last().url).toBe('/api/me/sessions');
    expect(last().init.method).toBe('GET');
    expect(out.sessions[0].current).toBe(true);
  });

  it('ends the other sessions with a DELETE on the list', async () => {
    fetchMock.mockImplementation(async () => json({ ok: true, ended: 2 }));
    const out = await api.endOtherSessions();
    expect(last().url).toBe('/api/me/sessions');
    expect(last().init.method).toBe('DELETE');
    expect(out.ended).toBe(2);
  });

  it('ends one session by its id', async () => {
    await api.endSession('0123456789abcdef');
    expect(last().url).toBe('/api/me/sessions/0123456789abcdef');
    expect(last().init.method).toBe('DELETE');
  });

  it('signs out everywhere with all:true, and a plain sign out sends no flag', async () => {
    await api.authLogout({ all: true });
    expect(last().url).toBe('/api/auth/logout');
    expect(last().init.method).toBe('POST');
    expect(JSON.parse(last().init.body)).toEqual({ all: true });
    await api.authLogout();
    expect(JSON.parse(last().init.body)).toEqual({});
  });
});

describe('the 401 hook', () => {
  it('tells the handler when a normal call is answered 401 unauthenticated, and still throws the error', async () => {
    const seen = vi.fn();
    api.setUnauthenticatedHandler(seen);
    fetchMock.mockImplementation(async () => json({ error: 'sign in first', code: 'unauthenticated' }, 401));
    await expect(api.getSessions()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('does not tell it for GET /api/me and for sign out: those read the 401 themselves', async () => {
    const seen = vi.fn();
    api.setUnauthenticatedHandler(seen);
    fetchMock.mockImplementation(async () => json({ error: 'sign in first', code: 'unauthenticated' }, 401));
    await expect(api.getMe()).rejects.toMatchObject({ status: 401 });
    await expect(api.authLogout()).rejects.toMatchObject({ status: 401 });
    await expect(api.authLogout({ all: true })).rejects.toMatchObject({ status: 401 });
    expect(seen).not.toHaveBeenCalled();
  });

  it('does not tell it for reauth_required, which is not a sign out', async () => {
    const seen = vi.fn();
    api.setUnauthenticatedHandler(seen);
    fetchMock.mockImplementation(async () => json({ error: 'new code first', code: 'reauth_required' }, 401));
    await expect(api.getMyKey()).rejects.toMatchObject({ status: 401, code: 'reauth_required' });
    await expect(api.postStrict(true)).rejects.toMatchObject({ code: 'reauth_required' });
    await expect(api.deleteMe()).rejects.toMatchObject({ code: 'reauth_required' });
    expect(seen).not.toHaveBeenCalled();
  });

  it('a handler that throws changes nothing for the caller', async () => {
    api.setUnauthenticatedHandler(() => {
      throw new Error('boom');
    });
    fetchMock.mockImplementation(async () => json({ error: 'sign in first', code: 'unauthenticated' }, 401));
    await expect(api.getSessions()).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('works without a handler', async () => {
    api.setUnauthenticatedHandler(null);
    fetchMock.mockImplementation(async () => json({ error: 'sign in first' }, 401));
    await expect(api.getSessions()).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
