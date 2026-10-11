// Mail providers with a stubbed fetch, the message text, and the echo guard (every way it must refuse).
import { describe, expect, it } from 'vitest';
import { codeEmail, configuredProvider, echoAllowed, mailMode, sendMail } from '../../functions/_lib/mail.js';
import { isLoopbackAddress } from '../../functions/_lib/http.js';
import { stubFetch } from './fakes.js';

const MSG = { to: 'person@example.test', subject: 'Your hrdlock code: 123456', text: 'plain text', html: '<p>html</p>' };
const ok = () => new Response('{"id":"abc"}', { status: 200, headers: { 'Content-Type': 'application/json' } });

const RESEND = { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_key_1', MAIL_FROM: 'hrdlock <login@example.test>' };
const BREVO = { MAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'xkeysib-1', MAIL_FROM_ADDRESS: 'login@example.test', MAIL_FROM_NAME: 'hrdlock' };
const CF = { MAIL_PROVIDER: 'cloudflare', CF_ACCOUNT_ID: 'a'.repeat(32), CF_EMAIL_TOKEN: 'cf-token-1', MAIL_FROM: 'login@example.test' };

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a failure');
}

describe('request shapes', () => {
  it('resend: POST https://api.resend.com/emails with a bearer key and { from, to:[to], subject, text, html }', async () => {
    const f = stubFetch(ok);
    await sendMail(RESEND, MSG, { fetchImpl: f });
    expect(f.calls.length).toBe(1);
    const { url, init } = f.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer re_key_1');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ from: 'hrdlock <login@example.test>', to: ['person@example.test'], subject: MSG.subject, text: MSG.text, html: MSG.html });
  });

  it('brevo: POST https://api.brevo.com/v3/smtp/email with the api-key header and sender, to, textContent, htmlContent', async () => {
    const f = stubFetch(ok);
    await sendMail(BREVO, MSG, { fetchImpl: f });
    const { url, init } = f.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect(init.headers['api-key']).toBe('xkeysib-1');
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      sender: { email: 'login@example.test', name: 'hrdlock' },
      to: [{ email: 'person@example.test' }],
      subject: MSG.subject,
      textContent: MSG.text,
      htmlContent: MSG.html
    });
  });

  it('brevo: sender falls back to MAIL_FROM, with or without a display name', async () => {
    const a = stubFetch(ok);
    await sendMail({ MAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k', MAIL_FROM: 'Login Team <login@example.test>' }, MSG, { fetchImpl: a });
    expect(JSON.parse(a.calls[0].init.body).sender).toEqual({ email: 'login@example.test', name: 'Login Team' });
    const b = stubFetch(ok);
    await sendMail({ MAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k', MAIL_FROM: 'login@example.test' }, MSG, { fetchImpl: b });
    expect(JSON.parse(b.calls[0].init.body).sender).toEqual({ email: 'login@example.test', name: 'hrdlock' });
  });

  it('cloudflare: POST .../accounts/<id>/email/sending/send with a bearer token and { to, from, subject, text, html }', async () => {
    const f = stubFetch(() => new Response('{"success":true,"result":{}}', { status: 200 }));
    await sendMail(CF, MSG, { fetchImpl: f });
    const { url, init } = f.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/email/sending/send`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer cf-token-1');
    expect(JSON.parse(init.body)).toEqual({ to: 'person@example.test', from: 'login@example.test', subject: MSG.subject, text: MSG.text, html: MSG.html });
  });

  it('every request has an abort signal so a stuck provider can not hold a request open', async () => {
    const f = stubFetch(ok);
    await sendMail(RESEND, MSG, { fetchImpl: f });
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('the provider name is not case sensitive and is trimmed, except echo', () => {
    expect(configuredProvider({ ...RESEND, MAIL_PROVIDER: ' Resend ' })).toBe('resend');
    expect(configuredProvider({ ...BREVO, MAIL_PROVIDER: 'BREVO' })).toBe('brevo');
    expect(configuredProvider({ ...CF, MAIL_PROVIDER: 'Cloudflare' })).toBe('cloudflare');
    for (const v of ['Echo', ' echo', 'echo ', 'ECHO']) expect(configuredProvider({ MAIL_PROVIDER: v }), v).toBe('none');
    expect(configuredProvider({ MAIL_PROVIDER: 'echo' })).toBe('echo');
  });
});

describe('errors', () => {
  it('maps every failure to mail_failed (502) with a fixed message', async () => {
    const cases = [
      stubFetch(() => new Response('{"message":"invalid api key re_key_1 for person@example.test"}', { status: 401 })),
      stubFetch(() => new Response('upstream exploded', { status: 500 })),
      stubFetch(() => new Response('', { status: 429 })),
      stubFetch(() => new Response('nope', { status: 302, headers: { Location: 'https://evil.test' } })),
      stubFetch(() => {
        throw new TypeError('fetch failed to https://api.resend.com with Bearer re_key_1');
      }),
      stubFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')))
    ];
    for (const f of cases) {
      const err = await failure(sendMail(RESEND, MSG, { fetchImpl: f }));
      expect(err.code).toBe('mail_failed');
      expect(err.status).toBe(502);
      expect(err.message).toBe('the email could not be sent, please try again in a moment');
      expect(JSON.stringify(err)).not.toMatch(/re_key_1|person@example|exploded|evil/);
    }
  });

  it('cloudflare: a 200 without success:true is a failure, also for junk answers', async () => {
    for (const body of ['{"success":false,"errors":[{"message":"secret reason"}]}', '{}', 'not json', '', '[]', '{"success":"true"}', 'null']) {
      const err = await failure(sendMail(CF, MSG, { fetchImpl: stubFetch(() => new Response(body, { status: 200 })) }));
      expect(err.code).toBe('mail_failed');
      expect(err.message).not.toMatch(/secret reason/);
    }
  });

  it('does not require a JSON answer from resend or brevo, only a 2xx', async () => {
    await sendMail(RESEND, MSG, { fetchImpl: stubFetch(() => new Response('', { status: 202 })) });
    await sendMail(BREVO, MSG, { fetchImpl: stubFetch(() => new Response('{"messageId":"x"}', { status: 201 })) });
  });

  it('a provider that is not set up is mail_unavailable and nothing is fetched', async () => {
    const incomplete = [
      {},
      { MAIL_PROVIDER: 'smtp' },
      { MAIL_PROVIDER: 'resend' },
      { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k' },
      { MAIL_PROVIDER: 'resend', MAIL_FROM: 'a@b.cc' },
      { MAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k' },
      { MAIL_PROVIDER: 'brevo', MAIL_FROM: 'a@b.cc' },
      { MAIL_PROVIDER: 'cloudflare', CF_ACCOUNT_ID: 'a'.repeat(32), MAIL_FROM: 'a@b.cc' },
      { MAIL_PROVIDER: 'cloudflare', CF_EMAIL_TOKEN: 't', MAIL_FROM: 'a@b.cc' },
      { ...CF, CF_ACCOUNT_ID: '../../evil' },
      { ...CF, CF_ACCOUNT_ID: 'a'.repeat(31) },
      { ...RESEND, RESEND_API_KEY: '   ' }
    ];
    for (const env of incomplete) {
      const f = stubFetch(ok);
      const err = await failure(sendMail(env, MSG, { fetchImpl: f }));
      expect(err.code, JSON.stringify(env)).toBe('mail_unavailable');
      expect(err.status).toBe(503);
      expect(f.calls.length).toBe(0);
    }
  });

  it('echo sends nothing', async () => {
    const f = stubFetch(ok);
    await sendMail({ MAIL_PROVIDER: 'echo' }, MSG, { fetchImpl: f });
    expect(f.calls.length).toBe(0);
  });
});

describe('the message', () => {
  it('has the subject and text from the spec, a small html version, and no links', () => {
    const m = codeEmail('123456');
    expect(m.subject).toBe('Your hrdlock code: 123456');
    expect(m.text).toBe('Your hrdlock code is 123456. It works for 10 minutes. If you did not ask for it, you can ignore this email.');
    expect(m.html).toContain('123456');
    expect(m.html).toContain('10 minutes');
    expect(m.html.length).toBeLessThan(900);
    for (const part of [m.subject, m.text, m.html]) {
      expect(part).not.toMatch(/https?:|href|<a |<img|<script/i);
    }
  });
});

function req(url, headers = {}) {
  return new Request(url, { headers });
}

describe('echo guard', () => {
  const echo = { MAIL_PROVIDER: 'echo' };

  it('is honoured on localhost and 127.0.0.1 with no edge address or a loopback one', () => {
    for (const url of ['http://localhost:8800/api/x', 'http://127.0.0.1:8800/api/x', 'https://localhost/api/x', 'http://localhost/']) {
      expect(echoAllowed(echo, req(url)), url).toBe(true);
      expect(mailMode(echo, req(url)), url).toBe('echo');
    }
    for (const ip of ['127.0.0.1', '127.9.9.9', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', ' 127.0.0.1 ']) {
      expect(echoAllowed(echo, req('http://localhost/', { 'CF-Connecting-IP': ip })), ip).toBe(true);
    }
  });

  it('refuses when the provider is not exactly echo', () => {
    for (const v of [undefined, '', 'Echo', 'ECHO', ' echo', 'echo ', 'echo2', 'resend', 'none', 'ech']) {
      const env = v === undefined ? {} : { MAIL_PROVIDER: v };
      expect(echoAllowed(env, req('http://localhost/')), String(v)).toBe(false);
    }
  });

  it('refuses every other host name', () => {
    for (const url of [
      'https://hrdlock.example/',
      'https://hrdlock.pages.dev/',
      'http://example.com/',
      'http://localhost.evil.test/',
      'http://evil-localhost/',
      'http://notlocalhost/',
      'http://127.0.0.2/',
      'http://127.0.0.1.evil.test/',
      'http://[::1]/',
      'http://0.0.0.0/',
      'http://192.168.1.10/',
      'http://10.0.0.5/',
      'http://foo.localhost/',
      'http://localhost.:8800/'
    ]) {
      expect(echoAllowed(echo, req(url)), url).toBe(false);
      expect(mailMode(echo, req(url)), url).toBe('none');
    }
  });

  it('refuses when the edge says the client is not on this machine', () => {
    for (const ip of ['203.0.113.7', '8.8.8.8', '10.0.0.1', '192.168.0.2', '2001:db8::1', '::ffff:8.8.8.8', '::', '0.0.0.0', '128.0.0.1', '126.255.255.255', 'unknown', 'junk', '127.0.0.1, 8.8.8.8', '127.0.0.256', '1.1.1.1', '']) {
      expect(echoAllowed(echo, req('http://localhost/', { 'CF-Connecting-IP': ip })), JSON.stringify(ip)).toBe(false);
    }
  });

  it('refuses a request that passed the Cloudflare edge (cf-ray)', () => {
    expect(echoAllowed(echo, req('http://localhost/', { 'cf-ray': '8f1c2d3e4f5a6b7c-FRA' }))).toBe(false);
    expect(echoAllowed(echo, req('http://localhost/', { 'cf-ray': '8f1c2d3e4f5a6b7c-FRA', 'CF-Connecting-IP': '127.0.0.1' }))).toBe(false);
  });

  it('refuses without a request', () => {
    expect(echoAllowed(echo, undefined)).toBe(false);
    expect(echoAllowed(echo, null)).toBe(false);
    expect(echoAllowed(null, req('http://localhost/'))).toBe(false);
    expect(mailMode(echo, undefined)).toBe('none');
  });

  it('a forged Host header on a real site is no help: the url decides', () => {
    // On Cloudflare the url is the public address, so a Host header of localhost does not change it
    expect(echoAllowed(echo, new Request('https://hrdlock.example/api/x', { headers: { Host: 'localhost' } }))).toBe(false);
  });

  it('on a refused request the sender is none, but the setting is still reported', () => {
    expect(mailMode(echo, req('https://hrdlock.example/'))).toBe('none');
    expect(configuredProvider(echo)).toBe('echo');
  });

  it('real providers do not care about the host', () => {
    expect(mailMode(RESEND, req('https://hrdlock.example/'))).toBe('resend');
    expect(mailMode(BREVO, req('http://localhost/'))).toBe('brevo');
    expect(mailMode(CF, req('https://hrdlock.example/'))).toBe('cloudflare');
  });
});

describe('isLoopbackAddress', () => {
  it('knows loopback addresses and nothing else', () => {
    for (const ip of ['127.0.0.1', '127.255.255.255', '::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '0000:0000:0000:0000:0000:0000:0000:0001']) expect(isLoopbackAddress(ip), ip).toBe(true);
    for (const ip of ['', 'localhost', '128.0.0.1', '126.0.0.1', '1.127.0.0.1', '127.0.0', '127.0.0.1.1', '::2', '::', '::ffff:128.0.0.1', '2001:db8::1', '127.0.0.1/8', '0x7f.0.0.1', '127.0.0.01x', '::1%lo0', '::1%25eth0x', '127.0.0.1%eth0']) expect(isLoopbackAddress(ip), ip).toBe(false);
  });
});
