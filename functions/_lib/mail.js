// Sending the sign in code by email.
//
// env.MAIL_PROVIDER picks the sender: 'resend', 'brevo' or 'cloudflare'. 'echo' sends nothing and is
// for local development only (see echoAllowed). Anything else, or a provider whose settings are
// missing, counts as 'none' and the auth endpoints answer 503 mail_unavailable.
//
// Provider answers are never passed on to the client: any failure becomes 502 mail_failed with a
// fixed plain message. Nothing here logs an address, a code or a provider answer.
import { ApiError } from './errors.js';
import { isLoopbackAddress } from './http.js';

export const MAIL_MODES = Object.freeze(['none', 'resend', 'brevo', 'cloudflare', 'echo']);
const SEND_TIMEOUT_MS = 10000;

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

// What the operator asked for, ignoring where the request came from.
export function configuredProvider(env) {
  const raw = env && typeof env.MAIL_PROVIDER === 'string' ? env.MAIL_PROVIDER : '';
  if (raw === 'echo') return 'echo';
  const name = raw.trim().toLowerCase();
  if (name === 'resend') return clean(env.RESEND_API_KEY) && clean(env.MAIL_FROM) ? 'resend' : 'none';
  if (name === 'brevo') return clean(env.BREVO_API_KEY) && brevoSender(env).email ? 'brevo' : 'none';
  if (name === 'cloudflare') {
    const ok = /^[0-9a-f]{32}$/i.test(clean(env.CF_ACCOUNT_ID)) && clean(env.CF_EMAIL_TOKEN) && clean(env.MAIL_FROM);
    return ok ? 'cloudflare' : 'none';
  }
  return 'none';
}

// Echo is honoured only when ALL hold: MAIL_PROVIDER is exactly 'echo', the request went to localhost
// or 127.0.0.1, and no address from the Cloudflare edge says the request came from elsewhere (the
// header is missing, or it is a loopback address). A request that passed through the Cloudflare edge
// (cf-ray) is refused too. On any other host 'echo' behaves like 'none'.
export function echoAllowed(env, request) {
  if (!env || env.MAIL_PROVIDER !== 'echo' || !request) return false;
  let host;
  try {
    host = new URL(request.url).hostname;
  } catch {
    return false;
  }
  if (host !== 'localhost' && host !== '127.0.0.1') return false;
  if (request.headers.get('cf-ray')) return false;
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip !== null && ip.trim() !== '' && !isLoopbackAddress(ip)) return false;
  // a header that is present but empty or junk is not "missing"
  if (ip !== null && ip.trim() === '') return false;
  return true;
}

// The sender that is used for this request: configuredProvider, except that echo needs echoAllowed.
export function mailMode(env, request) {
  const mode = configuredProvider(env);
  if (mode === 'echo') return echoAllowed(env, request) ? 'echo' : 'none';
  return mode;
}

// "Name <a@b.example>" or "a@b.example" into { name, email }.
function splitAddress(text) {
  const t = clean(text);
  const m = /^(.*)<([^<>]+)>\s*$/.exec(t);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() };
  return { name: '', email: t };
}

function brevoSender(env) {
  const parsed = splitAddress(env.MAIL_FROM);
  return {
    email: clean(env.MAIL_FROM_ADDRESS) || parsed.email,
    name: clean(env.MAIL_FROM_NAME) || parsed.name || 'hrdlock'
  };
}

// The message for a sign in code.
export function codeEmail(code) {
  return {
    subject: `Your hrdlock code: ${code}`,
    text: `Your hrdlock code is ${code}. It works for 10 minutes. If you did not ask for it, you can ignore this email.`,
    html:
      '<div style="font-family:system-ui,sans-serif;font-size:16px;color:#1f2430">' +
      '<p>Your hrdlock code is</p>' +
      `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p>` +
      '<p>It works for 10 minutes. If you did not ask for it, you can ignore this email.</p></div>'
  };
}

function failed() {
  return new ApiError('mail_failed', 'the email could not be sent, please try again in a moment');
}

// The provider said the request itself was not acceptable (HTTP 400 or 422, which is how they answer an
// address that is not a real mailbox address). Trying again later changes nothing, so the person is
// told to look at the address. A wrong sender setting answers the same way, so the status goes to the
// server log (never the address, the code or the provider's text) for the operator.
function refused(status) {
  console.error('the mail provider did not accept a sign in mail (HTTP ' + status + ')');
  return new ApiError('mail_failed', 'the email could not be sent to that address, check it for mistakes or use another address');
}

// Builds the provider request: { url, headers, body, check(answer) }.
function providerRequest(env, mode, { to, subject, text, html }) {
  if (mode === 'resend') {
    return {
      url: 'https://api.resend.com/emails',
      headers: { Authorization: 'Bearer ' + clean(env.RESEND_API_KEY) },
      body: { from: clean(env.MAIL_FROM), to: [to], subject, text, html }
    };
  }
  if (mode === 'brevo') {
    const sender = brevoSender(env);
    return {
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: { 'api-key': clean(env.BREVO_API_KEY) },
      body: { sender: { email: sender.email, name: sender.name }, to: [{ email: to }], subject, textContent: text, htmlContent: html }
    };
  }
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${clean(env.CF_ACCOUNT_ID)}/email/sending/send`,
    headers: { Authorization: 'Bearer ' + clean(env.CF_EMAIL_TOKEN) },
    body: { to, from: clean(env.MAIL_FROM), subject, text, html },
    needsSuccessFlag: true
  };
}

// Gives up the answer body without reading it (a body that never ends must not hold the request).
function dropBody(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') {
      const p = res.body.cancel();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch {
    // ignore
  }
}

// Sends one email. Resolves when the provider accepted it. Throws ApiError mail_unavailable (nothing
// configured) or mail_failed (the provider refused or could not be reached). 'echo' sends nothing.
// The whole exchange, the answer body included, has to be over in SEND_TIMEOUT_MS. Redirects are not
// followed: the provider key travels in a header that a redirect to another host would carry along.
export async function sendMail(env, message, { fetchImpl = globalThis.fetch } = {}) {
  const mode = configuredProvider(env);
  if (mode === 'echo') return;
  if (mode === 'none') throw new ApiError('mail_unavailable', 'email sign in is not switched on on this server');
  const req = providerRequest(env, mode, message);
  const controller = new AbortController();
  // Rejects when the time is up, so a body that the signal does not reach still ends in time.
  const deadline = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(failed()), { once: true });
  });
  deadline.catch(() => {});
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await Promise.race([
        fetchImpl(req.url, {
          method: 'POST',
          headers: { ...req.headers, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(req.body),
          redirect: 'error',
          signal: controller.signal
        }),
        deadline
      ]);
    } catch (err) {
      // Only the kind of failure is logged, never an address, a code or anything the provider said.
      console.error('the mail provider could not be reached (' + String((err && err.name) || 'error') + ')');
      throw failed();
    }
    if (!res || !res.ok) {
      dropBody(res);
      if (res && (res.status === 400 || res.status === 422)) throw refused(res.status);
      if (res) console.error('the mail provider answered HTTP ' + res.status);
      throw failed();
    }
    if (!req.needsSuccessFlag) {
      dropBody(res);
      return;
    }
    let answer = null;
    try {
      answer = await Promise.race([res.json(), deadline]);
    } catch {
      answer = null;
    }
    if (!answer || answer.success !== true) {
      dropBody(res);
      throw failed();
    }
  } finally {
    clearTimeout(timer);
  }
}
