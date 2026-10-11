// Email address rules: one conservative pattern, ASCII only, and a masked form for display.
// The address is never stored, only an HMAC of the normalised form and the masked text.
import { ApiError } from './errors.js';

export const EMAIL_MAX = 254;
export const LOCAL_MAX = 64;

// The part before the @: letters, digits and . _ % + - & ' with a dot at neither end and no two dots in a row.
// A leading _ or - is allowed (_work@, -work@). The ' and the & are allowed inside the name (o'brien@,
// d'souza@, a&b@ are real addresses) but not at either end. The address only ever goes into a JSON body and
// into a hash, never into a mail header or a query, so these characters are not a way to inject anything.
const LOCAL_RE = /^[a-z0-9_-](?:[a-z0-9._%+&'-]*[a-z0-9_%+-])?$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const bad = (message) => new ApiError('invalid_email', message);

// Returns the normalised address (trimmed, lower case) or throws 400 invalid_email.
export function normalizeEmail(input) {
  if (typeof input !== 'string') throw bad('enter an email address');
  // Cut very long input before any other work.
  if (input.length > 512) throw bad('that email address is too long');
  const t = input.trim();
  if (t.length < 3) throw bad('enter a full email address');
  if (t.length > EMAIL_MAX) throw bad('that email address is too long');
  if (!/^[\x21-\x7e]+$/.test(t)) {
    throw bad('use an email address with plain letters and digits, no spaces and no accents');
  }
  const email = t.toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2) throw bad('an email address has exactly one @');
  const [local, domain] = parts;
  if (local.length < 1 || local.length > LOCAL_MAX) throw bad('the part before the @ is not valid');
  if (!LOCAL_RE.test(local) || local.includes('..')) throw bad('the part before the @ is not valid');
  const labels = domain.split('.');
  if (labels.length < 2 || labels.length > 10) throw bad('the part after the @ is not valid');
  if (!labels.every((l) => LABEL_RE.test(l)) || !TLD_RE.test(labels[labels.length - 1])) {
    throw bad('the part after the @ is not valid');
  }
  return email;
}

// The mailbox an address really is, for limits on how many mails one inbox can be sent (NOT for finding
// an account, that uses the address as typed): the part after a + is dropped, and for gmail.com and
// googlemail.com the dots in the name are dropped too, because the provider delivers all of those
// spellings to one inbox. Takes an already normalised address.
export function canonicalInbox(email) {
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return local + '@' + domain;
}

// "priya@gmail.com" -> "pr***@gmail.com". Takes an already normalised address.
export function maskEmail(email) {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  return local.slice(0, 2) + '***' + email.slice(at);
}
