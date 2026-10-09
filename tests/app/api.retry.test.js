import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../src/lib/api.js';
import { listParams, nextCursor, nextCursorId } from '../../src/components/vault/vaultLogic.js';

let fetchMock;
let sleeps;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const busy = () => json({ error: 'The server is busy, try again.', code: 'busy' }, 503, { 'retry-after': '1' });

beforeEach(() => {
  fetchMock = vi.fn();
  sleeps = [];
  vi.stubGlobal('fetch', fetchMock);
  api.setSleepForTests(async (ms) => {
    sleeps.push(ms);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  api.setSleepForTests(null);
});

describe('busy answers are retried', () => {
  it('sends the same request again after a 503 busy and then succeeds', async () => {
    fetchMock.mockImplementationOnce(async () => busy()).mockImplementationOnce(async () => json({ seq: 4 }, 201));
    const out = await api.postMessage('general', { v: 2, type: 'message' }, 'sig');
    expect(out.seq).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
  });

  it('gives up after three retries and reports the busy error', async () => {
    fetchMock.mockImplementation(async () => busy());
    await expect(api.postDocRecord('a'.repeat(32), {}, 'sig')).rejects.toMatchObject({ status: 503, code: 'busy' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleeps.length).toBe(3);
    for (const ms of sleeps) expect(ms).toBeLessThanOrEqual(4500);
  });

  it('does not retry other 503 answers or other errors', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'down', code: 'server_error' }, 503));
    await expect(api.getServerKey()).rejects.toMatchObject({ status: 503, code: 'server_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => json({ error: 'stale', code: 'conflict' }, 409));
    await expect(api.postDocRecord('b'.repeat(32), {}, 'sig')).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('does not retry when the caller has already cancelled', async () => {
    const ctl = new AbortController();
    ctl.abort();
    fetchMock.mockImplementation(async () => busy());
    await expect(api.getLedger({ signal: ctl.signal })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('list cursors', () => {
  it('sends the document id cursor next to the time cursor', async () => {
    fetchMock.mockImplementation(async () => json({ documents: [] }));
    await api.listDocuments({ limit: 25, before: 123, beforeId: 'c'.repeat(32), q: 'deed' });
    const url = fetchMock.mock.calls.at(-1)[0];
    expect(url).toContain('before=123');
    expect(url).toContain('beforeId=' + 'c'.repeat(32));
    expect(url).toContain('q=deed');
  });

  it('sends the channel cursor and accepts the plain call', async () => {
    fetchMock.mockImplementation(async () => json({ channels: [], next: null }));
    await api.listChannels({ limit: 50, before: 9, beforeId: 'room-one' });
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/channels?limit=50&before=9&beforeId=room-one');
    await api.listChannels();
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/channels');
    await api.listChannels({ signal: new AbortController().signal });
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/channels');
  });

  it('builds list parameters with a valid id cursor only', () => {
    const id = 'd'.repeat(32);
    expect(listParams({ before: 50, beforeId: id })).toEqual({ limit: 25, before: 50, beforeId: id });
    expect(listParams({ before: 50, beforeId: 'NOT-AN-ID' })).toEqual({ limit: 25, before: 50 });
    expect(listParams({ beforeId: id })).toEqual({ limit: 25 });
  });

  it('takes the last row for both parts of the cursor', () => {
    const rows = [
      { docId: 'a'.repeat(32), updatedAt: 30 },
      { docId: 'b'.repeat(32), updatedAt: 30 }
    ];
    expect(nextCursor(rows)).toBe(30);
    expect(nextCursorId(rows)).toBe('b'.repeat(32));
    expect(nextCursorId([])).toBeUndefined();
    expect(nextCursorId([{ updatedAt: 3 }])).toBeUndefined();
  });
});
