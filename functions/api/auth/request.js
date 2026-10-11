// POST /api/auth/request  body { email }  ->  200 { sent:true, cooldown:30 [, debugCode] }
// Sends a 6 digit code to the address. The answer is the same whether or not an account exists: the
// code belongs to the email, not to an account, and nothing here looks at the accounts table.
// debugCode is only returned in the local development echo mode (see functions/_lib/mail.js).
//
// What counts against which limit (see functions/_lib/rate.js):
//   every request           the source (address, and the whole /48 for IPv6): the server did work for it
//   only a MAIL TO BE SENT  the inbox (aliases with + or dots in the name count as one), the service per
//                           hour and per day, and the sends of this source. A request that is refused for the
//                           30 second wait, or whose mail could not be stored or sent, leaves these as they
//                           were, so a stranger can not use up the allowance of everybody with requests that
//                           send nothing, and a provider outage does not use up a person's codes.
// A share of the service ceilings is kept for sources that have sent little: once the open part is full
// only a source that has sent at most two codes this hour can still use the rest. A few sources can not
// close sign in for everybody, many sources still can (nothing short of a proof of work step prevents
// that, see scripts/DEPLOY.md).
import { atRest } from '../../_lib/atRest.js';
import { canonicalInbox, normalizeEmail } from '../../_lib/email.js';
import { ApiError } from '../../_lib/errors.js';
import { json, networkKeyForRequest, onlyMethods, rateKeyForRequest, readJson } from '../../_lib/http.js';
import { codeEmail, mailMode, sendMail } from '../../_lib/mail.js';
import { OTP_COOLDOWN_MS, cooldownLeft, dropCode, generateCode, storeCode, sweepCodes } from '../../_lib/otp.js';
import { ceilingFrom, consumeRate, refundRate } from '../../_lib/rate.js';
import { requestNow, requireSameOrigin } from '../../_lib/session.js';

// Share of a ceiling that every source may use. The rest is for sources that sent at most
// PRIORITY_SENDS codes in the hour.
export const OPEN_SHARE = 0.75;
export const PRIORITY_SENDS = 2;
export const DEFAULT_CAP_HOUR = 400;
export const DEFAULT_CAP_DAY = 2000;

export async function onRequestPost({ request, env }) {
  requireSameOrigin(request);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);

  const ar = await atRest(env);
  const mode = mailMode(env, request);
  if (mode === 'none') throw new ApiError('mail_unavailable', 'email sign in is not switched on on this server');

  const now = requestNow(env, request);
  const emailHash = await ar.emailHash(email);
  const source = rateKeyForRequest(request);
  const network = networkKeyForRequest(request);
  await consumeRate(env, 'codeIp', source, now);
  if (network) await consumeRate(env, 'codeNet', network, now);

  const tooSoon = (seconds) =>
    new ApiError('rate_limited', `a code was sent a moment ago, wait ${seconds} seconds before asking again`, {
      headers: { 'Retry-After': seconds }
    });
  const wait = await cooldownLeft(env, emailHash, now);
  if (wait > 0) throw tooSoon(wait);

  // From here on a mail is going to be sent: take the allowances, give them back if it is not.
  const taken = [];
  const take = async (name, who, opts) => {
    const count = await consumeRate(env, name, who, now, { undoOnDeny: true, ...opts });
    taken.push([name, who]);
    return count;
  };
  const giveBack = async () => {
    for (const [name, who] of taken) {
      try {
        await refundRate(env, name, who, now);
      } catch {
        // the count stays one too high until the window ends
      }
    }
  };

  let code;
  let codeHash;
  try {
    const inbox = await ar.emailHash(canonicalInbox(email));
    await take('codeEmail', inbox);
    const sends = await take('codeSent', network || source);
    const priority = sends <= PRIORITY_SENDS;
    const hour = ceilingFrom(env, 'MAIL_CAP_HOUR', DEFAULT_CAP_HOUR);
    const day = ceilingFrom(env, 'MAIL_CAP_DAY', DEFAULT_CAP_DAY);
    await take('codeAll', 'all', { max: priority ? hour : Math.floor(hour * OPEN_SHARE) });
    await take('codeDay', 'all', { max: priority ? day : Math.floor(day * OPEN_SHARE) });

    code = generateCode();
    codeHash = await ar.codeHash(emailHash, code);
    if (!(await storeCode(env, emailHash, codeHash, now))) throw tooSoon(Math.ceil(OTP_COOLDOWN_MS / 1000));
  } catch (err) {
    await giveBack();
    throw err;
  }
  await sweepCodes(env, now);

  const cooldown = OTP_COOLDOWN_MS / 1000;
  if (mode === 'echo') return json({ sent: true, cooldown, debugCode: code });
  try {
    await sendMail(env, { to: email, ...codeEmail(code) });
  } catch (err) {
    await dropCode(env, emailHash, codeHash);
    await giveBack();
    throw err;
  }
  return json({ sent: true, cooldown });
}

export const onRequest = onlyMethods('POST');
