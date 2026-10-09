// Pure helper logic of the backend: errors, requests, time, rate windows, locks, query helpers.
import { describe, expect, it } from 'vitest';
import { ApiError, STATUS_BY_CODE, errorBody, errorResponse, isUniqueConflict } from '../../functions/_lib/errors.js';
import {
  MAX_JSON_BYTES,
  clientIp,
  escapeLike,
  intParam,
  json,
  methodNotAllowed,
  parseContentLength,
  readBodyBytes,
  readJson,
  readSignedBody
} from '../../functions/_lib/http.js';
import { HOUR, MINUTE, RATES, consumeRate, retryAfterSeconds, windowStart } from '../../functions/_lib/rate.js';
import { assertFresh, withinWindow } from '../../functions/_lib/time.js';
import { backoff, withLock } from '../../functions/_lib/lock.js';
import { docSummary, ledgerHeadFromRow } from '../../functions/_lib/documents.js';
import { ZERO_HASH } from '../../shared/encoding.js';
import { LIMITS } from '../../shared/records.js';

function post(body, headers = {}) {
  return new Request('http://x.test/api/thing', { method: 'POST', body, headers });
}

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    }
  });
}

async function thrown(promiseOrFn) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (err) {
    return err;
  }
  throw new Error('expected an error');
}

describe('error mapping', () => {
  it('maps every documented code to a status', () => {
    expect(STATUS_BY_CODE).toMatchObject({
      bad_request: 400,
      bad_signature: 400,
      unknown_signer: 403,
      not_owner: 403,
      exists: 409,
      not_found: 404,
      conflict: 409,
      rate_limited: 429,
      too_large: 413,
      expired: 400,
      forbidden: 403,
      server_error: 500
    });
  });

  it('ApiError carries status and code and builds a JSON response', async () => {
    const err = new ApiError('not_owner', 'no way');
    expect(err.status).toBe(403);
    const res = errorResponse(err);
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'no way', code: 'not_owner' });
  });

  it('extra headers and explicit status are kept', () => {
    const res = errorResponse(new ApiError('rate_limited', 'slow down', { headers: { 'Retry-After': 7 } }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
    expect(methodNotAllowed(['GET', 'PUT']).status).toBe(405);
    expect(errorResponse(methodNotAllowed(['GET', 'PUT'])).headers.get('Allow')).toBe('GET, PUT');
  });

  it('unknown errors never leak details', async () => {
    const res = errorResponse(new Error('secret table name users_v2 broke'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'server error', code: 'server_error' });
    expect(JSON.stringify(errorBody('a string'))).not.toContain('a string');
    expect(errorResponse(null).status).toBe(500);
  });

  it('recognises unique constraint failures from D1', () => {
    expect(isUniqueConflict(new Error('D1_ERROR: UNIQUE constraint failed: ledger.prev_ledger_hash: SQLITE_CONSTRAINT'))).toBe(true);
    expect(isUniqueConflict(new Error('UNIQUE constraint failed: records.doc_id, records.version'))).toBe(true);
    expect(isUniqueConflict(new Error('PRIMARY KEY constraint failed: messages.hash'))).toBe(true);
    expect(isUniqueConflict(new Error('no such table: ledger'))).toBe(false);
    expect(isUniqueConflict(null)).toBe(false);
    expect(isUniqueConflict('')).toBe(false);
  });
});

describe('request parsing', () => {
  it('reads a JSON object', async () => {
    const value = await readJson(post('{"a":1}'));
    expect(value).toEqual({ a: 1 });
  });

  it('rejects malformed JSON, arrays, scalars, null and empty bodies', async () => {
    for (const text of ['{bad', '[1,2]', '3', '"x"', 'null', '']) {
      const err = await thrown(readJson(post(text)));
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('bad_request');
    }
  });

  it('rejects invalid UTF-8', async () => {
    const err = await thrown(readJson(post(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))));
    expect(err.code).toBe('bad_request');
  });

  it('caps the body at 64 KiB by Content-Length', async () => {
    expect(MAX_JSON_BYTES).toBe(LIMITS.MAX_JSON_BYTES);
    const big = '{"x":"' + 'a'.repeat(MAX_JSON_BYTES) + '"}';
    const err = await thrown(readJson(post(big)));
    expect(err.code).toBe('too_large');
    expect(err.status).toBe(413);
  });

  it('caps the body when there is no Content-Length (streamed)', async () => {
    const chunk = new Uint8Array(10000).fill(97);
    const body = streamOf(Array.from({ length: 10 }, () => chunk));
    const req = new Request('http://x.test/', { method: 'POST', body, duplex: 'half' });
    const err = await thrown(readBodyBytes(req, 65536));
    expect(err.code).toBe('too_large');
  });

  it('accepts a body of exactly the cap and refuses one byte more', async () => {
    const exact = new Uint8Array(1000).fill(32);
    expect((await readBodyBytes(post(exact), 1000)).length).toBe(1000);
    const err = await thrown(readBodyBytes(post(new Uint8Array(1001)), 1000));
    expect(err.code).toBe('too_large');
  });

  it('checks Content-Length values', () => {
    expect(parseContentLength(null, 10)).toBe(null);
    expect(parseContentLength('', 10)).toBe(null);
    expect(parseContentLength('10', 10)).toBe(10);
    expect(() => parseContentLength('11', 10)).toThrow(ApiError);
    expect(() => parseContentLength('-1', 10)).toThrow(ApiError);
    expect(() => parseContentLength('1e3', 10)).toThrow(ApiError);
    expect(() => parseContentLength('0x10', 10)).toThrow(ApiError);
  });

  it('readSignedBody wants a record object and a signature string', async () => {
    const ok = await readSignedBody(post(JSON.stringify({ record: { a: 1 }, signature: 's' })));
    expect(ok).toEqual({ record: { a: 1 }, signature: 's' });
    for (const bad of [{ signature: 's' }, { record: [], signature: 's' }, { record: {}, signature: 5 }, { record: {} }, { record: null, signature: 's' }]) {
      const err = await thrown(readSignedBody(post(JSON.stringify(bad))));
      expect(err.code).toBe('bad_request');
    }
  });

  it('json() sets the content type and status', async () => {
    const res = json({ ok: true }, 201, { 'X-Test': 'yes' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('X-Test')).toBe('yes');
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('query helpers', () => {
  const url = (q) => new URL('http://x.test/api/x' + q);

  it('intParam uses the default, accepts in range, and refuses the rest', () => {
    const o = { min: 1, max: 100, def: 50 };
    expect(intParam(url(''), 'limit', o)).toBe(50);
    expect(intParam(url('?limit='), 'limit', o)).toBe(50);
    expect(intParam(url('?limit=1'), 'limit', o)).toBe(1);
    expect(intParam(url('?limit=100'), 'limit', o)).toBe(100);
    for (const bad of ['0', '101', '-5', '2.5', 'abc', '1e2', ' 5', '9'.repeat(30)]) {
      expect(() => intParam(url('?limit=' + encodeURIComponent(bad)), 'limit', o)).toThrow(ApiError);
    }
  });

  it('escapeLike escapes percent, underscore and backslash', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('plain')).toBe('plain');
    expect(escapeLike("it's")).toBe("it's");
  });

  it('clientIp reads CF-Connecting-IP and falls back to local', () => {
    const h = (v) => new Request('http://x.test/', { headers: v ? { 'CF-Connecting-IP': v } : {} });
    expect(clientIp(h('203.0.113.9'))).toBe('203.0.113.9');
    expect(clientIp(h(null))).toBe('local');
    expect(clientIp(h('   '))).toBe('local');
    expect(clientIp(h('x'.repeat(200))).length).toBe(64);
  });
});

describe('time window', () => {
  it('accepts times inside the window in both directions', () => {
    const now = 1_000_000_000_000;
    const w = LIMITS.RECORD_TIME_WINDOW_MS;
    expect(withinWindow(now, w, now)).toBe(true);
    expect(withinWindow(now - w, w, now)).toBe(true);
    expect(withinWindow(now + w, w, now)).toBe(true);
    expect(withinWindow(now - w - 1, w, now)).toBe(false);
    expect(withinWindow(now + w + 1, w, now)).toBe(false);
    expect(withinWindow(NaN, w, now)).toBe(false);
    expect(withinWindow(Infinity, w, now)).toBe(false);
    expect(withinWindow(undefined, w, now)).toBe(false);
  });

  it('assertFresh throws expired', () => {
    const now = 5_000_000;
    expect(() => assertFresh(now, 1000, now)).not.toThrow();
    let err;
    try {
      assertFresh(now - 5000, 1000, now);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('expired');
    expect(err.status).toBe(400);
  });

  it('uses the right windows for records and blobs', () => {
    expect(LIMITS.RECORD_TIME_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(LIMITS.BLOB_TIME_WINDOW_MS).toBe(5 * 60 * 1000);
  });
});

describe('rate window math', () => {
  it('windowStart floors to the window', () => {
    expect(windowStart(0, MINUTE)).toBe(0);
    expect(windowStart(59_999, MINUTE)).toBe(0);
    expect(windowStart(60_000, MINUTE)).toBe(60_000);
    expect(windowStart(3_600_000 + 5, HOUR)).toBe(3_600_000);
  });

  it('retryAfterSeconds is at least 1 and ends at the window edge', () => {
    expect(retryAfterSeconds(0, MINUTE)).toBe(60);
    expect(retryAfterSeconds(59_001, MINUTE)).toBe(1);
    expect(retryAfterSeconds(59_999, MINUTE)).toBe(1);
    expect(retryAfterSeconds(60_000, MINUTE)).toBe(60);
    expect(retryAfterSeconds(HOUR - 1, HOUR)).toBe(1);
  });

  it('uses the limits from the spec', () => {
    expect(RATES.identity).toMatchObject({ windowMs: HOUR, max: 10 });
    expect(RATES.message).toMatchObject({ windowMs: MINUTE, max: 20 });
    expect(RATES.docRecord).toMatchObject({ windowMs: HOUR, max: 30 });
    expect(RATES.channel).toMatchObject({ windowMs: HOUR, max: 10 });
    expect(RATES.blob).toMatchObject({ windowMs: HOUR, max: 30 });
  });

  // A fake database that counts like the real upsert.
  function fakeEnv() {
    const counts = new Map();
    const calls = [];
    return {
      calls,
      DB: {
        prepare(sql) {
          return {
            bind(...args) {
              return {
                async first() {
                  calls.push({ sql, args });
                  const key = args[0] + '|' + args[1];
                  counts.set(key, (counts.get(key) || 0) + 1);
                  return { count: counts.get(key) };
                },
                async run() {
                  return {};
                }
              };
            }
          };
        }
      }
    };
  }

  it('allows up to the maximum and then answers 429 with Retry-After', async () => {
    const env = fakeEnv();
    const now = 10 * MINUTE + 12_000;
    for (let i = 1; i <= 20; i++) expect(await consumeRate(env, 'message', 'abc', now)).toBe(i);
    const err = await thrown(consumeRate(env, 'message', 'abc', now));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(err.headers['Retry-After']).toBe(48);
  });

  it('counts per signer and per window', async () => {
    const env = fakeEnv();
    const now = 10 * MINUTE + 1;
    for (let i = 0; i < 20; i++) await consumeRate(env, 'message', 'a', now);
    expect(await consumeRate(env, 'message', 'b', now)).toBe(1);
    expect(await consumeRate(env, 'message', 'a', now + MINUTE)).toBe(1);
    expect(env.calls.at(-1).args[1]).toBe(11 * MINUTE);
  });

  it('uses bound values only', async () => {
    const env = fakeEnv();
    await consumeRate(env, 'identity', "x'; DROP TABLE identities; --", 1000);
    expect(env.calls[0].sql).not.toContain('DROP');
    expect(env.calls[0].args[0]).toContain('DROP');
  });

  it('rejects an unknown limit name', async () => {
    await expect(consumeRate(fakeEnv(), 'nothing', 'a')).rejects.toThrow();
  });
});

describe('lock and backoff', () => {
  it('runs critical sections one at a time per key', async () => {
    let inside = 0;
    let maxInside = 0;
    const order = [];
    const job = (n) =>
      withLock('k', async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 5));
        order.push(n);
        inside--;
        return n;
      });
    const out = await Promise.all([job(1), job(2), job(3), job(4)]);
    expect(out).toEqual([1, 2, 3, 4]);
    expect(maxInside).toBe(1);
    expect(order.length).toBe(4);
  });

  it('different keys do not wait for each other', async () => {
    let both = 0;
    let inside = 0;
    const job = (key) =>
      withLock(key, async () => {
        inside++;
        both = Math.max(both, inside);
        await new Promise((r) => setTimeout(r, 20));
        inside--;
      });
    await Promise.all([job('a'), job('b')]);
    expect(both).toBe(2);
  });

  it('releases the lock when the work throws', async () => {
    await expect(withLock('t', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await withLock('t', async () => 'fine')).toBe('fine');
  });

  it('a stale lock is taken over', async () => {
    let release;
    const first = withLock('s', () => new Promise((r) => (release = r)), {});
    const started = Date.now();
    const second = await withLock('s', async () => 'second', { staleMs: 30, maxWaitMs: 2000 });
    expect(second).toBe('second');
    expect(Date.now() - started).toBeLessThan(1500);
    release();
    await first;
  });

  it('backoff resolves', async () => {
    await backoff(0);
    await backoff(3);
  });
});

describe('row shaping', () => {
  it('docSummary matches the bundle document shape', () => {
    const row = {
      doc_id: 'd'.repeat(32),
      owner_key_id: 'o'.repeat(64),
      status: 'active',
      listed: 1,
      head_version: 3,
      head_record_hash: 'h'.repeat(64),
      label: 'ignored',
      created_at: 10,
      updated_at: 20
    };
    expect(docSummary(row)).toEqual({
      docId: row.doc_id,
      ownerKeyId: row.owner_key_id,
      status: 'active',
      headVersion: 3,
      headRecordHash: row.head_record_hash,
      listed: true,
      createdAt: 10,
      updatedAt: 20
    });
    expect(docSummary({ ...row, listed: 0 }).listed).toBe(false);
  });

  it('ledgerHeadFromRow gives seq 0 and the zero hash when empty', () => {
    expect(ledgerHeadFromRow(undefined)).toEqual({ seq: 0, hash: ZERO_HASH });
    expect(ledgerHeadFromRow(null)).toEqual({ seq: 0, hash: ZERO_HASH });
    expect(ledgerHeadFromRow({ seq: 4, ledger_hash: 'a'.repeat(64) })).toEqual({ seq: 4, hash: 'a'.repeat(64) });
  });
});
