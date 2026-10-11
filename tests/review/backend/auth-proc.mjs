// In process helpers for the auth-*.mjs scripts that need what a live local server can not give them:
// a real mail provider (stubbed fetch), a real https host name, a fixed clock, or direct access to the
// database. They run the real middleware and route files against a node:sqlite database with every
// migration applied (the doubles in tests/functions/fakes.js). Not a script itself.
import { accountEnv, callApi, Jar, makeKey, signIn as fakeSignIn, stubFetch } from '../../functions/fakes.js';

export { accountEnv, callApi, Jar, makeKey, stubFetch };

export const HOUR = 3600 * 1000;

// Freezes Date.now at a quiet point inside an hour (so a long loop never crosses a window edge) and
// lets a script move it. Returns { set(ms), advance(ms), now() }.
export function frozenClock(startAtMs = Date.UTC(2031, 5, 15, 10, 20, 0)) {
  let t = startAtMs;
  Date.now = () => t;
  return { set: (ms) => (t = ms), advance: (ms) => (t += ms), now: () => t };
}

// An environment with a real looking provider. Mails are recorded instead of sent: globalThis.fetch is
// replaced for the life of the script. kind: 'resend' | 'brevo' | 'cloudflare'.
export function providerEnv(kind = 'resend', extra = {}) {
  const vars = {
    resend: { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key', MAIL_FROM: 'hrdlock <login@mail.example.test>' },
    brevo: { MAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'xkeysib-test', MAIL_FROM: 'hrdlock <login@mail.example.test>' },
    cloudflare: { MAIL_PROVIDER: 'cloudflare', CF_ACCOUNT_ID: 'a'.repeat(32), CF_EMAIL_TOKEN: 'cf-test-token', MAIL_FROM: 'login@mail.example.test' }
  }[kind];
  return accountEnv({ env: { ...vars, ...extra } });
}

// Installs a fetch that answers every provider call with `answer` (a Response, or a function that
// returns one) and records it. Returns { calls, mails } where mails lists { to, code, init, url }.
export function installMailStub(answer = () => new Response('{"id":"msg_1"}', { status: 200 })) {
  const calls = [];
  const stub = async (url, init) => {
    const body = JSON.parse(init.body);
    const to = Array.isArray(body.to) ? (typeof body.to[0] === 'string' ? body.to[0] : body.to[0].email) : body.to;
    const text = body.text || body.textContent || '';
    const code = (/\b(\d{6})\b/.exec(text) || [])[1] || null;
    const entry = { url: String(url), init, to, code, body };
    calls.push(entry);
    return typeof answer === 'function' ? answer(entry) : answer;
  };
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    }
  };
}

// A client address on the real internet (what Cloudflare would put in CF-Connecting-IP).
let n = 0;
export function publicIp() {
  n++;
  return `198.51.${(n >> 8) & 255}.${(n & 255) + 1}`;
}
export function publicV6(prefix64, host = 1) {
  return `${prefix64}::${host}`;
}

export const SITE = 'https://hrdlock.example';

export async function signInProc(env, opts) {
  return fakeSignIn(env, opts);
}
