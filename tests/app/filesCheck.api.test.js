import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getFilesCheck, putFilesCheck } from '../../src/lib/api.js';

let fetchMock;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('files check calls', () => {
  it('reads the fingerprint', async () => {
    fetchMock.mockImplementation(async () => json({ check: null }));
    expect(await getFilesCheck()).toEqual({ check: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/me/files-check');
    expect(init.method).toBe('GET');
  });

  it('sets it with a PUT and the check in the body, and a second try is a conflict error', async () => {
    fetchMock.mockImplementationOnce(async () => json({ ok: true })).mockImplementationOnce(async () => json({ error: 'the files password is already set', code: 'conflict' }, 409));
    expect(await putFilesCheck('ab'.repeat(32))).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/me/files-check');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ check: 'ab'.repeat(32) });
    await expect(putFilesCheck('cd'.repeat(32))).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await expect(putFilesCheck('cd'.repeat(32))).rejects.toBeInstanceOf(Error);
  });
});
