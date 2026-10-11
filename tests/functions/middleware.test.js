// The middleware and the early checks of route handlers, using stub contexts (no database).
import { describe, expect, it, vi } from 'vitest';
import { SECURITY_HEADERS, isApiPath, onRequest, withHeaders } from '../../functions/_middleware.js';
import { ApiError } from '../../functions/_lib/errors.js';
import * as blobRoute from '../../functions/api/blobs/[hash].js';
import * as docsList from '../../functions/api/documents/index.js';
import * as docRecords from '../../functions/api/documents/[docId]/records.js';
import * as ledgerRoute from '../../functions/api/ledger.js';
import * as catchAll from '../../functions/api/[[path]].js';
import * as healthRoute from '../../functions/api/health.js';
import * as serverKeyRoute from '../../functions/api/server-key.js';
import { resetServerKeyCache } from '../../functions/_lib/serverKey.js';
import { exportPrivateJwk, generateKeyPair } from '../../shared/keys.js';

const ctx = (path, next, init = {}) => ({
  request: new Request('http://x.test' + path, init),
  next,
  env: {}
});

describe('middleware', () => {
  it('adds security headers and no-store to API responses', async () => {
    const res = await onRequest(ctx('/api/health', async () => Response.json({ ok: true })));
    expect(res.status).toBe(200);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k)).toBe(v);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(null);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('keeps a cache header that a handler set (blob downloads)', async () => {
    const res = await onRequest(
      ctx('/api/blobs/' + 'a'.repeat(64), async () => new Response('bytes', { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }))
    );
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('does not force no-store on non API paths', async () => {
    const res = await onRequest(ctx('/assets/app.js', async () => new Response('x', { headers: { 'Cache-Control': 'public, immutable' } })));
    expect(res.headers.get('Cache-Control')).toBe('public, immutable');
    const page = await onRequest(ctx('/', async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } })));
    expect(page.status).toBe(200);
    expect(page.headers.get('Cache-Control')).toBe(null);
  });

  it('turns an app page answer for an unknown /api path into a JSON 404', async () => {
    const res = await onRequest(
      ctx('/api/unknown', async () => new Response('<html>app</html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'no such API route', code: 'not_found' });
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('maps a thrown ApiError to its status and body', async () => {
    const res = await onRequest(
      ctx('/api/x', async () => {
        throw new ApiError('conflict', 'stale head');
      })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'stale head', code: 'conflict' });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('maps any other exception to a plain 500 without leaking it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await onRequest(
      ctx('/api/x', async () => {
        throw new Error('database password is hunter2');
      })
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'server error', code: 'server_error' });
    expect(text).not.toContain('hunter2');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    spy.mockRestore();
  });

  it('keeps extra headers of an ApiError such as Retry-After and Allow', async () => {
    const res = await onRequest(
      ctx('/api/x', async () => {
        throw new ApiError('rate_limited', 'slow', { headers: { 'Retry-After': 12 } });
      })
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('12');
  });

  it('isApiPath only matches /api and below', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/')).toBe(true);
    expect(isApiPath('/api/health')).toBe(true);
    expect(isApiPath('/apix')).toBe(false);
    expect(isApiPath('/')).toBe(false);
    expect(isApiPath('/d/abc')).toBe(false);
  });

  it('withHeaders keeps status, body and existing headers', async () => {
    const res = withHeaders(new Response('hello', { status: 201, headers: { 'X-Mine': '1' } }), true);
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Mine')).toBe('1');
    expect(await res.text()).toBe('hello');
  });
});

describe('route handlers: checks that happen before any database use', () => {
  const put = (hash, headers, body = new Uint8Array([1, 2, 3])) =>
    blobRoute.onRequestPut({
      request: new Request('http://x.test/api/blobs/' + hash, { method: 'PUT', headers, body }),
      env: {},
      params: { hash }
    });
  const goodHeaders = { 'x-hrd-key': 'a'.repeat(64), 'x-hrd-time': String(Date.now()), 'x-hrd-sig': 's'.repeat(86) };

  it('blob PUT refuses a bad hash, missing headers and a bad key id', async () => {
    await expect(put('xyz', goodHeaders)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(put('b'.repeat(64), {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(put('b'.repeat(64), { ...goodHeaders, 'x-hrd-key': 'short' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(put('b'.repeat(64), { ...goodHeaders, 'x-hrd-time': 'yesterday' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('blob PUT refuses an oversized Content-Length with too_large', async () => {
    const req = new Request('http://x.test/api/blobs/' + 'b'.repeat(64), {
      method: 'PUT',
      headers: { ...goodHeaders, 'content-length': String(20971520 + 4096 + 1) },
      body: new Uint8Array(1)
    });
    // fetch() normally forbids lying about the length, so build the check on a plain object.
    const fake = { headers: req.headers, body: req.body };
    await expect(blobRoute.onRequestPut({ request: fake, env: {}, params: { hash: 'b'.repeat(64) } })).rejects.toMatchObject({
      code: 'too_large',
      status: 413
    });
  });

  it('blob PUT refuses a missing Content-Length with 411', async () => {
    const fake = { headers: new Headers(goodHeaders), body: new ReadableStream() };
    await expect(blobRoute.onRequestPut({ request: fake, env: {}, params: { hash: 'b'.repeat(64) } })).rejects.toMatchObject({
      code: 'bad_request',
      status: 411
    });
  });

  it('blob GET and HEAD refuse a bad hash', async () => {
    await expect(blobRoute.onRequestGet({ request: new Request('http://x.test/'), env: {}, params: { hash: 'ABC' } })).rejects.toMatchObject({
      code: 'bad_request'
    });
    await expect(blobRoute.onRequestHead({ env: {}, params: { hash: '1'.repeat(63) } })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('document list refuses bad query values', async () => {
    const get = (q) => docsList.onRequestGet({ request: new Request('http://x.test/api/documents' + q), env: {} });
    await expect(get('?limit=0')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(get('?limit=101')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(get('?before=abc')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(get('?owner=nothex')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(get('?q=' + 'x'.repeat(121))).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('document records POST refuses a bad address, bad body, wrong type and a mismatched id', async () => {
    const post = (docId, body) =>
      docRecords.onRequestPost({
        request: new Request('http://x.test/', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
        env: {},
        params: { docId }
      });
    const docId = 'a'.repeat(32);
    await expect(post('nothex', {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(post(docId, '{bad')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(post(docId, { record: {}, signature: 's' })).rejects.toMatchObject({ code: 'bad_request' });
    const message = { v: 2, type: 'message', channelId: 'abc', body: 'x', replyTo: '', signer: 'a'.repeat(64), createdAt: 1, nonce: 'b'.repeat(32) };
    await expect(post(docId, { record: message, signature: 's' })).rejects.toMatchObject({ code: 'bad_request' });
    const revoke = { v: 2, type: 'doc.revoke', docId: 'c'.repeat(32), version: 2, prev: 'd'.repeat(64), signer: 'a'.repeat(64), createdAt: 1, reason: 'x' };
    await expect(post(docId, { record: revoke, signature: 's' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('ledger route refuses bad paging values', async () => {
    const get = (q) => ledgerRoute.onRequestGet({ request: new Request('http://x.test/api/ledger' + q), env: {} });
    await expect(get('?limit=0')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(get('?limit=501')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(get('?after=-2')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('wrong methods give 405 with Allow, and the catch-all gives 404', () => {
    expect(() => healthRoute.onRequest()).toThrow(ApiError);
    try {
      healthRoute.onRequest();
    } catch (e) {
      expect(e.status).toBe(405);
      expect(e.headers.Allow).toBe('GET');
    }
    try {
      blobRoute.onRequest();
    } catch (e) {
      expect(e.headers.Allow).toBe('GET, HEAD, PUT');
    }
    try {
      catchAll.onRequest();
    } catch (e) {
      expect(e.status).toBe(404);
      expect(e.code).toBe('not_found');
    }
  });
});

describe('GET /api/server-key', () => {
  it('says signing is off without a key', async () => {
    resetServerKeyCache();
    const res = await serverKeyRoute.onRequestGet({ env: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signing: false, keyId: null, publicKey: null });
  });

  it('publishes the public key and id, never the private part', async () => {
    resetServerKeyCache();
    const { privateKey } = await generateKeyPair({ extractable: true });
    const jwk = await exportPrivateJwk(privateKey);
    const res = await serverKeyRoute.onRequestGet({ env: { SERVER_SIGNING_JWK: JSON.stringify(jwk) } });
    const body = await res.json();
    expect(body.signing).toBe(true);
    expect(body.keyId).toMatch(/^[0-9a-f]{64}$/);
    expect(body.publicKey).toEqual({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
    expect(JSON.stringify(body)).not.toContain(jwk.d);
    resetServerKeyCache();
  });
});
