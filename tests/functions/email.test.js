// Email normalisation and masking, with hostile input.
import { describe, expect, it } from 'vitest';
import { canonicalInbox, maskEmail, normalizeEmail } from '../../functions/_lib/email.js';

const bad = (input) => {
  try {
    normalizeEmail(input);
  } catch (err) {
    expect(err.code).toBe('invalid_email');
    expect(err.status).toBe(400);
    return err.message;
  }
  throw new Error('expected invalid_email for ' + JSON.stringify(input));
};

describe('normalizeEmail', () => {
  it('trims and lower cases', () => {
    expect(normalizeEmail('  Priya.Sharma@Example.COM \n')).toBe('priya.sharma@example.com');
    expect(normalizeEmail('A@B.CC')).toBe('a@b.cc');
  });

  it('accepts ordinary addresses', () => {
    for (const ok of ['priya@gmail.com', 'first.last@sub.domain.example', 'a+tag@example.co.in', 'a_b-c@exa-mple.org', 'x@y.zz', '123@456.io', 'u%x@example.test', 'a@xn--p1ai.xn--p1ai', 'person@mail.example.museum']) {
      expect(normalizeEmail(ok), ok).toBe(ok.toLowerCase());
    }
  });

  it('accepts the longest allowed sizes and refuses one more', () => {
    const local = 'a'.repeat(64);
    const label = 'b'.repeat(63);
    const longest = `${local}@${label}.${label}.${'c'.repeat(57)}.com`;
    expect(longest.length).toBe(254);
    expect(normalizeEmail(longest)).toBe(longest);
    bad(longest.replace('@', 'x@'));
    bad(`${'a'.repeat(65)}@example.test`);
    bad(`a@${label}b.test`);
    bad(`a@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(63)}.com`);
  });

  it('refuses non strings and empty input', () => {
    for (const v of [undefined, null, 5, true, {}, [], ['a@b.cc'], () => 'a@b.cc', Symbol.iterator]) bad(typeof v === 'symbol' ? 'x' : v);
    for (const v of ['', ' ', '\n', 'a', '@', 'a@', '@b.cc', '@@']) bad(v);
  });

  it('refuses the wrong number of @', () => {
    for (const v of ['a@b@c.cc', 'a@@b.cc', 'abc.cc', '@a@b.cc']) bad(v);
  });

  it('refuses spaces, control characters and header injection', () => {
    for (const v of ['a b@c.cc', 'a@b .cc', 'a@b.cc\r\nBcc: x@y.zz', 'a@b.cc\nX: y', 'a\t@b.cc', 'a\u0000@b.cc', 'a@b.cc\u0000', 'a\u007f@b.cc', '"a b"@c.cc', 'a\u00a0@b.cc']) {
      bad(v);
    }
    // surrounding blanks are fine but inner ones are not
    expect(normalizeEmail('\t a@b.cc \r\n')).toBe('a@b.cc');
  });

  it('refuses non ASCII: accents, look alike letters, full width signs, emoji, right to left tricks', () => {
    const msg = bad('caf\u00e9@example.test');
    expect(msg).toMatch(/plain letters/);
    for (const v of ['\u0430@example.test', 'a@\u0435xample.test', 'a\uff20b.cc', 'a@b\uff0ecc', 'a@b.c\u0441', 'a\u200b@b.cc', 'a@b.cc\u202e', '\u202ea@b.cc', '\u{1F600}@b.cc', 'a@b.\u{1F600}', '\u0130@example.test', 'a@exa\u212ample.test', 'a@b.cc\u2028x']) {
      bad(v);
    }
  });

  it('refuses lists, brackets, quotes and display names', () => {
    for (const v of ['a@b.cc,c@d.cc', 'a@b.cc;c@d.cc', '<a@b.cc>', 'Name <a@b.cc>', '"a"@b.cc', "'ab@c.cc", "ab'@c.cc", 'a(b)@c.cc', 'a[b]@c.cc', 'a\\b@c.cc', 'a@b.cc>', 'a:b@c.cc', 'a!b@c.cc', 'a#b@c.cc', 'a=b@c.cc', 'a?b@c.cc', 'a{b}@c.cc', 'a|b@c.cc', 'a*b@c.cc', 'a/b@c.cc', '&ab@c.cc', 'ab&@c.cc', 'a$b@c.cc', 'a^b@c.cc', 'a~b@c.cc', 'a`b@c.cc']) {
      bad(v);
    }
  });

  it('refuses dots and dashes in the wrong places', () => {
    for (const v of ['.a@b.cc', 'a.@b.cc', 'a..b@c.cc', 'a@.b.cc', 'a@b..cc', 'a@b.cc.', 'a@-b.cc', 'a@b-.cc', 'a@b.-cc', 'a@b.cc-', '+a@b.cc', '%a@b.cc', 'a@b_c.cc']) {
      bad(v);
    }
  });

  // Real addresses that the first pattern refused (finding: auth-takeover, "real addresses").
  it("accepts an apostrophe or an ampersand inside the name and a leading underscore or hyphen", () => {
    for (const v of ["o'brien@example.com", "d'souza@example.com", '_work@example.com', '-work@example.com', 'a&b@example.com', "O'Brien@Example.COM"]) {
      expect(normalizeEmail(v), v).toBe(v.toLowerCase());
    }
  });

  it('the canonical inbox drops a plus part, and the dots of gmail.com and googlemail.com', () => {
    expect(canonicalInbox('user+tag@example.com')).toBe('user@example.com');
    expect(canonicalInbox('user+a+b@example.com')).toBe('user@example.com');
    expect(canonicalInbox('first.last@example.com')).toBe('first.last@example.com'); // dots count elsewhere
    expect(canonicalInbox('fi.rst.la.st+x@gmail.com')).toBe('firstlast@gmail.com');
    expect(canonicalInbox('first.last@googlemail.com')).toBe('firstlast@gmail.com');
    expect(canonicalInbox('first.last@gmail.com.example.com')).toBe('first.last@gmail.com.example.com');
    expect(canonicalInbox('+tag@example.com')).toBe('+tag@example.com'); // never an empty name
    expect(canonicalInbox("o'brien+x@example.com")).toBe("o'brien@example.com");
  });

  it('refuses a domain without a dot, a short or numeric top level, and address literals', () => {
    for (const v of ['a@localhost', 'a@b', 'a@b.c', 'a@b.1', 'a@b.12', 'a@1.2.3.4', 'a@[127.0.0.1]', 'a@[::1]', 'a@127.0.0.1', 'a@b.c0m', 'a@b.xn-', 'a@b.' + 'c'.repeat(64)]) {
      bad(v);
    }
  });

  it('cuts huge input quickly without running the pattern on it', () => {
    const start = Date.now();
    bad('a'.repeat(100000) + '@b.cc');
    bad(('a.' + 'a'.repeat(10)).repeat(20000));
    bad('a@' + 'b.'.repeat(100000) + 'cc');
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('gives plain messages that do not echo the input', () => {
    const msgs = [bad('some<script>alert(1)</script>'), bad('x'.repeat(300)), bad('caf\u00e9@x.cc'), bad('a@@b.cc')];
    for (const m of msgs) {
      expect(m).not.toMatch(/script|alert|xxx|caf/);
      expect(m.length).toBeLessThan(100);
    }
  });

  it('plus tags and dots stay as typed (they are different addresses)', () => {
    expect(normalizeEmail('a.b+c@gmail.com')).toBe('a.b+c@gmail.com');
    expect(normalizeEmail('ab@gmail.com')).not.toBe(normalizeEmail('a.b@gmail.com'));
  });
});

describe('maskEmail', () => {
  it('shows two characters of the local part and the domain', () => {
    expect(maskEmail('priya@gmail.com')).toBe('pr***@gmail.com');
    expect(maskEmail('ab@example.test')).toBe('ab***@example.test');
    expect(maskEmail('a@b.cc')).toBe('a***@b.cc');
    expect(maskEmail('first.last+tag@sub.example.org')).toBe('fi***@sub.example.org');
  });

  it('never shows more of the local part, also for hostile looking input', () => {
    for (const e of ['abcdefghijklmnopqrstuvwxyz@example.test', 'a.b.c.d@example.test', '123456@example.test']) {
      const m = maskEmail(normalizeEmail(e));
      expect(m.split('@')[0]).toMatch(/^.{1,2}\*\*\*$/);
      expect(m.endsWith('@example.test')).toBe(true);
    }
  });
});
