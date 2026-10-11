// A failed send leaves a log line the operator can use (the HTTP status or the kind of failure), and
// that line never holds the address, the code, the key or anything the provider said.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendMail } from '../../functions/_lib/mail.js';

const env = { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_testkey_abcdefghijklmnop', MAIL_FROM: 'hrdlock <login@mail.example.test>' };
const message = { to: 'person.name@example.test', subject: 'Your hrdlock code: 482913', text: 'code 482913', html: '<p>482913</p>' };

afterEach(() => {
  vi.restoreAllMocks();
});

function logged() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => spy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('mail failure logging', () => {
  it('logs the status of a refusal the person cannot fix, without private text', async () => {
    const read = logged();
    const fetchImpl = async () => new Response('{"message":"secret provider text person.name@example.test"}', { status: 403 });
    await expect(sendMail(env, message, { fetchImpl })).rejects.toMatchObject({ code: 'mail_failed' });
    const text = read();
    expect(text).toContain('HTTP 403');
    for (const secret of ['person.name', 'example.test', '482913', 're_testkey', 'secret provider text']) expect(text).not.toContain(secret);
  });

  it('logs the status for server errors and rate limits too', async () => {
    for (const status of [401, 429, 500, 503]) {
      const read = logged();
      const fetchImpl = async () => new Response('{}', { status });
      await expect(sendMail(env, message, { fetchImpl })).rejects.toMatchObject({ code: 'mail_failed' });
      expect(read()).toContain('HTTP ' + status);
      vi.restoreAllMocks();
    }
  });

  it('logs only the kind of failure when the provider cannot be reached', async () => {
    const read = logged();
    const fetchImpl = async () => {
      const e = new TypeError('connect failed to api.resend.com for person.name@example.test');
      throw e;
    };
    await expect(sendMail(env, message, { fetchImpl })).rejects.toMatchObject({ code: 'mail_failed' });
    const text = read();
    expect(text).toContain('could not be reached');
    expect(text).toContain('TypeError');
    for (const secret of ['person.name', 'example.test', '482913', 're_testkey', 'api.resend.com']) expect(text).not.toContain(secret);
  });

  it('a request the provider calls invalid keeps its own log line and message', async () => {
    const read = logged();
    const fetchImpl = async () => new Response('{}', { status: 422 });
    await expect(sendMail(env, message, { fetchImpl })).rejects.toMatchObject({ code: 'mail_failed' });
    expect(read()).toContain('HTTP 422');
  });
});

describe('redirects from the provider', () => {
  it('asks fetch only for values Cloudflare supports, and treats a redirect answer as a failure', async () => {
    const seen = [];
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls++;
      seen.push(init.redirect);
      // what fetch gives back with redirect manual
      return new Response(null, { status: 302, headers: { Location: 'https://other.example.test/steal' } });
    };
    logged();
    await expect(sendMail(env, message, { fetchImpl })).rejects.toMatchObject({ code: 'mail_failed' });
    expect(calls).toBe(1);
    // Cloudflare's runtime supports only follow and manual
    expect(['follow', 'manual']).toContain(seen[0]);
    expect(seen[0]).toBe('manual');
  });

  it('a stand in fetch that rejects the unsupported value like Cloudflare does still lets a send through', async () => {
    const fetchImpl = async (url, init) => {
      if (init.redirect !== 'follow' && init.redirect !== 'manual') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
      return new Response('{"id":"abc"}', { status: 200 });
    };
    await expect(sendMail(env, message, { fetchImpl })).resolves.toBeUndefined();
  });
});
