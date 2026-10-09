import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../src/lib/api.js';

let fetchMock;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1);
  return { url, init };
}

describe('request building', () => {
  it('GETs json from the same origin', async () => {
    fetchMock.mockImplementation(async () => json({ signing: true, keyId: 'k', publicKey: {} }));
    const out = await api.getServerKey();
    expect(out.signing).toBe(true);
    const { url, init } = lastCall();
    expect(url).toBe('/api/server-key');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(init.body).toBeUndefined();
  });

  it('POSTs the record and signature as json', async () => {
    fetchMock.mockImplementation(async () => json({ keyId: 'abc' }, 201));
    const record = { v: 2, type: 'identity' };
    const out = await api.registerIdentity(record, 'sig');
    expect(out).toEqual({ keyId: 'abc' });
    const { url, init } = lastCall();
    expect(url).toBe('/api/identities');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ record, signature: 'sig' });
  });

  it('builds query strings and leaves out empty values', async () => {
    fetchMock.mockImplementation(async () => json({ documents: [] }));
    await api.listDocuments({ limit: 20, before: 123, owner: undefined, q: '' });
    expect(lastCall().url).toBe('/api/documents?limit=20&before=123');
    await api.listDocuments({ q: '50% off & more' });
    expect(lastCall().url).toBe('/api/documents?q=50%25+off+%26+more');
    await api.listDocuments();
    expect(lastCall().url).toBe('/api/documents');
    await api.getLedger({ after: 0, limit: 200 });
    expect(lastCall().url).toBe('/api/ledger?after=0&limit=200');
    await api.getMessages('general-chat', { after: 4, tail: 20 });
    expect(lastCall().url).toBe('/api/channels/general-chat/messages?after=4&tail=20');
  });

  it('escapes path pieces', async () => {
    fetchMock.mockImplementation(async () => json({}));
    await api.getDocument('a/b?c');
    expect(lastCall().url).toBe('/api/documents/a%2Fb%3Fc');
    await api.getIdentity('../x');
    expect(lastCall().url).toBe('/api/identities/..%2Fx');
  });

  it('has a wrapper for every route', async () => {
    fetchMock.mockImplementation(async () => json({ ok: true }));
    const id = 'a'.repeat(32);
    const h = 'b'.repeat(64);
    await api.getDocumentHead(id);
    expect(lastCall().url).toBe(`/api/documents/${id}/head`);
    await api.postDocRecord(id, { a: 1 }, 'sig');
    expect(lastCall().url).toBe(`/api/documents/${id}/records`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body)).toEqual({ record: { a: 1 }, signature: 'sig' });
    await api.listChannels();
    expect(lastCall().url).toBe('/api/channels');
    await api.createChannel({ c: 1 }, 'sig');
    expect(lastCall().url).toBe('/api/channels');
    expect(lastCall().init.method).toBe('POST');
    await api.postMessage('room-one', { m: 1 }, 'sig');
    expect(lastCall().url).toBe('/api/channels/room-one/messages');
    expect(lastCall().init.method).toBe('POST');
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
    expect(Array.from(await api.getBlob(h))).toEqual([1, 2, 3]);
    expect(lastCall().url).toBe(`/api/blobs/${h}`);
  });

  it('passes an abort signal through', async () => {
    fetchMock.mockImplementation(async () => json({ channels: [] }));
    const controller = new AbortController();
    await api.listChannels({ signal: controller.signal });
    expect(lastCall().init.signal).toBe(controller.signal);
    await api.getMessages('room-one', { signal: controller.signal });
    expect(lastCall().init.signal).toBe(controller.signal);
  });
});

describe('putBlob', () => {
  it('signs a blob.put record and sends the headers and raw bytes', async () => {
    fetchMock.mockImplementation(async () => json({ hash: 'h', size: 4 }, 201));
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const hash = 'c'.repeat(64);
    const signer = 'd'.repeat(64);
    const sign = vi.fn(async () => 's'.repeat(86));
    const before = Date.now();
    const out = await api.putBlob({ hash, size: 4, bytes, signer, sign });
    const after = Date.now();
    expect(out).toEqual({ hash: 'h', size: 4 });

    expect(sign).toHaveBeenCalledTimes(1);
    const record = sign.mock.calls[0][0];
    expect(record).toEqual({ v: 2, type: 'blob.put', hash, size: 4, signer, createdAt: record.createdAt });
    expect(record.createdAt).toBeGreaterThanOrEqual(before);
    expect(record.createdAt).toBeLessThanOrEqual(after);

    const { url, init } = lastCall();
    expect(url).toBe(`/api/blobs/${hash}`);
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(bytes);
    expect(init.headers['x-hrd-key']).toBe(signer);
    expect(init.headers['x-hrd-time']).toBe(String(record.createdAt));
    expect(init.headers['x-hrd-sig']).toBe('s'.repeat(86));
    expect(init.headers['content-type']).toBe('application/octet-stream');
  });

  it('returns the exists answer', async () => {
    fetchMock.mockImplementation(async () => json({ exists: true, hash: 'h' }, 200));
    const out = await api.putBlob({ hash: 'h', size: 1, bytes: new Uint8Array(1), signer: 's', sign: async () => 'x' });
    expect(out).toEqual({ exists: true, hash: 'h' });
  });

  it('does not send anything if signing fails', async () => {
    const sign = vi.fn(async () => {
      throw new Error('no key');
    });
    await expect(api.putBlob({ hash: 'h', size: 1, bytes: new Uint8Array(1), signer: 's', sign })).rejects.toThrow('no key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a rejected upload to ApiError', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'too big', code: 'too_large' }, 413));
    const err = await api
      .putBlob({ hash: 'h', size: 1, bytes: new Uint8Array(1), signer: 's', sign: async () => 'x' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.status).toBe(413);
    expect(err.code).toBe('too_large');
  });
});

describe('error mapping', () => {
  it('uses the code and message from the server', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'Document not found', code: 'not_found' }, 404));
    const err = await api.getDocument('x').catch((e) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('Document not found');
  });

  it('keeps unusual server codes', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'slow down', code: 'rate_limited' }, 429));
    const err = await api.postMessage('room-one', {}, 's').catch((e) => e);
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
  });

  it('falls back to a code from the status when the body is not json', async () => {
    const cases = [
      [400, 'bad_request'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [413, 'too_large'],
      [429, 'rate_limited'],
      [500, 'server_error'],
      [502, 'server_error']
    ];
    for (const [status, code] of cases) {
      fetchMock.mockImplementation(async () => new Response('<html>oops</html>', { status }));
      const err = await api.listChannels().catch((e) => e);
      expect(err).toBeInstanceOf(api.ApiError);
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(err.message).toContain(String(status));
    }
  });

  it('ignores a body with a wrong shape', async () => {
    fetchMock.mockImplementation(async () => json({ error: 5, code: {} }, 500));
    const err = await api.listChannels().catch((e) => e);
    expect(err.code).toBe('server_error');
    expect(err.message).toContain('500');
  });

  it('turns a network failure into code network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await api.listChannels().catch((e) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.code).toBe('network');
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Could not reach the server/);
  });

  it('turns a network failure on blob download into code network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await api.getBlob('a'.repeat(64)).catch((e) => e);
    expect(err.code).toBe('network');
  });

  it('lets an abort through unchanged', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    fetchMock.mockRejectedValue(abort);
    const err = await api.listChannels().catch((e) => e);
    expect(err).toBe(abort);
  });

  it('fails clearly when a success answer is not json', async () => {
    fetchMock.mockImplementation(async () => new Response('not json', { status: 200 }));
    const err = await api.listChannels().catch((e) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err.code).toBe('server_error');
  });

  it('maps a failed blob download', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'gone', code: 'not_found' }, 404));
    const err = await api.getBlob('a'.repeat(64)).catch((e) => e);
    expect(err.code).toBe('not_found');
  });
});

describe('queryString', () => {
  it('handles empty and odd input', () => {
    expect(api.queryString()).toBe('');
    expect(api.queryString({})).toBe('');
    expect(api.queryString({ a: null, b: undefined, c: '' })).toBe('');
    expect(api.queryString({ a: 0 })).toBe('?a=0');
    expect(api.queryString({ a: 'x y', b: 'é' })).toBe('?a=x+y&b=%C3%A9');
  });
});
