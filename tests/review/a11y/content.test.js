// Content review: banned characters and words, honest claims, consistent wording, and the
// information a printed record needs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ROOT, read, walk } from './helpers.js';
import { all, parseHtml } from './html.js';
import KeyBadge from '../../../src/components/KeyBadge.jsx';
import VerifyResult from '../../../src/components/VerifyResult.jsx';
import { certificateData } from '../../../src/components/doc/docLogic.js';
import { formatTime, shortKeyId } from '../../../src/lib/format.js';
import { passphraseStrength } from '../../../src/lib/keystore.js';
import { verifyDocumentBundle } from '../../../shared/verify.js';
import { buildBundleParts, createIdentity, createServerKey } from '../../helpers/bundle.js';

// every text file a person or a reviewer could read
function repoFiles() {
  const out = [];
  const roots = ['src', 'shared', 'functions', 'scripts', 'public', 'migrations', 'tests'];
  function go(dir) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) go(full);
      else if (/\.(jsx?|mjs|css|html|svg|json|sql|toml|md|txt)$/.test(name) || name === '_headers') out.push(full);
    }
  }
  for (const r of roots) go(join(ROOT, r));
  for (const f of ['index.html', 'README.md', 'wrangler.toml', 'vite.config.js']) out.push(join(ROOT, f));
  return out;
}

// Lines of other tests that only assert a character or word is absent are not counted.
const GUARD = /\.not\.(toContain|toMatch)\(/;
const EM = String.fromCharCode(8212);

const FILES = repoFiles().filter((f) => !f.replace(/\\/g, '/').includes('/tests/review/a11y/'));

describe('banned characters and words', () => {
  it('no em dash anywhere (source, shared, functions, scripts, public, tests, docs)', () => {
    const hits = [];
    for (const f of FILES) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes(EM) && !GUARD.test(line)) hits.push(`${f}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('no emoji or pictographs in anything that ships (test data may use them)', () => {
    const re = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
    const hits = [];
    for (const f of FILES.filter((x) => !/[\\/]tests[\\/]/.test(x))) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (re.test(line)) hits.push(`${f}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('no mention of AI, assistants or any AI vendor in source, markup, tests or docs', () => {
    // The vendor names are built from pieces so this file does not contain them either.
    const words = [
      'A\\.?I',
      'LLMs?',
      'Cl' + 'aude',
      'Anthr' + 'opic',
      'Open' + 'AI',
      'Chat' + 'GPT',
      'GPT-?\\d*',
      'Copi' + 'lot',
      'Gem' + 'ini',
      'Mis' + 'tral',
      'Lla' + 'ma',
      'language model',
      'machine learning',
      'chatbot',
      'assist' + 'ant'
    ];
    const re = new RegExp('\\b(' + words.join('|') + ')\\b');
    const hits = [];
    for (const f of FILES) {
      // The README keeps one plain line saying how the code was written. That line is on purpose.
      if (/README\.md$/.test(f)) continue;
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (re.test(line) && !GUARD.test(line) && !/no mention of/.test(line)) hits.push(`${f}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe('honest claims in text people read', () => {
  const ui = walk('src', ['.jsx', '.js']).filter((f) => !f.endsWith('.worker.js'));

  it('no absolute or marketing security words', () => {
    const re = /\b(unbreakable|tamper[- ]?proof|foolproof|unhackable|bank[- ]grade|military[- ]grade|100 ?%|completely secure|fully secure|totally safe|guarantee[sd]?|impossible to (forge|fake|change))\b/i;
    const hits = [];
    for (const f of ui) {
      read(f)
        .split('\n')
        .forEach((line, i) => {
          if (re.test(line) && !line.trim().startsWith('//')) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('"audited" and "certified" only ever appear in a denial', () => {
    const hits = [];
    for (const f of ui) {
      read(f)
        .split('\n')
        .forEach((line, i) => {
          if (/\b(audited|certified)\b/i.test(line) && !/\bnot\b[^.]{0,40}\b(audited|certified)\b/i.test(line) && !line.trim().startsWith('//')) {
            hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  it('every page footer and the About page say it is a prototype', () => {
    expect(read('src/components/Layout.jsx')).toMatch(/prototype/);
    expect(read('src/pages/AboutPage.jsx')).toMatch(/This is a prototype/);
    expect(read('src/pages/VerifyPage.jsx')).toMatch(/prototype and has not been audited or certified/);
  });

  it('DEFECT: the passphrase meter does not call a repeated phrase "Strong"', () => {
    // It guards the file that holds the signing key, and an offline guesser can try any backup.
    // These are among the first things a guesser tries.
    for (const weak of ['password password password password', 'letmein letmein letmein letmein', 'abcdef abcdef abcdef abcdef']) {
      expect(passphraseStrength(weak).label, weak).not.toBe('Strong');
    }
  });

  it('DEFECT: the chat note does not say a 32 bit tag identifies a signer', () => {
    // The short code is the first 8 hex characters of the key id (32 bits). Anyone can grind
    // a key that has the same 8 characters and pick the same display name, and the full id is only
    // in a hover title, which touch and keyboard users never see.
    expect(shortKeyId('ab'.repeat(32))).toHaveLength(16);
    const chat = read('src/components/chat/ChannelView.jsx');
    expect(/it is what identifies them/.test(chat), 'ChannelView.jsx tells people the 8 character tag is what identifies a sender').toBe(false);
  });

  it('DEFECT: a signer name that is cut short can still be read in full', () => {
    const html = renderToString(h(KeyBadge, { keyId: 'ab'.repeat(32), name: 'Registry Office of the Northern District Council' }));
    const badge = all(parseHtml(html), (e) => (e.attrs.class || '').includes('ui-keybadge'))[0];
    // CSS: .ui-keybadge__name has text-overflow: ellipsis; white-space: nowrap
    expect(badge.attrs.title || '').toContain('Registry Office of the Northern District Council');
  });
});

describe('what a green result says', () => {
  async function fixture() {
    const owner = await createIdentity('Registry Office');
    const serverKey = await createServerKey();
    const parts = await buildBundleParts({ owner, serverKey, versions: [{ label: 'Act of 2026' }] });
    return { parts, serverKey };
  }

  it('DEFECT: the banner is not green when the server key was not pinned', async () => {
    // PinSection tells the reader "Without a pin, a check can only show that the server agrees
    // with itself", yet the same page shows a green "server checkpoint all check out" banner and a
    // green "Active" badge for an unpinned answer. The warning that explains it is further down.
    const { parts } = await fixture();
    const result = await verifyDocumentBundle(parts.bundle, { expectedDocId: parts.docId });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/not pinned/);
    const html = renderToString(h(MemoryRouter, null, h(VerifyResult, { result })));
    expect(html.includes('ui-callout--good'), 'green banner shown although the warnings say the server key is not pinned').toBe(false);
  });

  it('the banner is green when the server key was pinned and matches', async () => {
    const { parts, serverKey } = await fixture();
    const result = await verifyDocumentBundle(parts.bundle, { expectedDocId: parts.docId, pinnedServerKeyId: serverKey.keyId });
    expect(result.ok).toBe(true);
    const html = renderToString(h(MemoryRouter, null, h(VerifyResult, { result })));
    expect(html).toContain('ui-callout--good');
    expect(html).toContain('Signatures, version chain and server checkpoint');
  });
});

describe('the printed certificate', () => {
  async function data(pinned) {
    const owner = await createIdentity('Registry Office');
    const serverKey = await createServerKey();
    const parts = await buildBundleParts({ owner, serverKey, versions: [{ label: 'Act of 2026' }] });
    const verification = await verifyDocumentBundle(parts.bundle, {
      expectedDocId: parts.docId,
      pinnedServerKeyId: pinned ? serverKey.keyId : ''
    });
    return certificateData({ bundle: parts.bundle, verification, pinnedServerKeyId: pinned ? serverKey.keyId : '', now: 1760000000000 });
  }

  it('DEFECT: the big result line says what was checked, not only "Passed all checks"', async () => {
    // Spec: anything that says verified must say what was verified. This line is the one that gets
    // photocopied and handed to an office.
    const c = await data(false);
    expect(c.ok).toBe(true);
    expect(c.resultText).toMatch(/signature/i);
  });

  it('DEFECT: an unpinned server key shows on the result line, not only in a row further down', async () => {
    const c = await data(false);
    expect(c.pinnedServerKeyId).toBe('');
    expect(c.resultText).toMatch(/pin/i);
  });

  it('DEFECT: times on the record show their time zone', () => {
    // A printed "9 Oct 2026, 14:05" with no zone is ambiguous in a legal record, and the same
    // moment prints differently on two computers.
    const text = formatTime(1760000000000);
    expect(text).toMatch(/(UTC|GMT|[A-Z]{3,5}|[+-]\d{1,2}(:\d{2})?)\s*$/);
  });

  it('the printed record lists the ids, hashes, signer, server key, checkpoint and the check time', async () => {
    const c = await data(true);
    for (const key of ['docId', 'headRecordHash', 'headBlobHash', 'signerKeyId', 'serverKeyId', 'ledgerCheckpoint', 'checkedAt', 'limits', 'latest']) {
      expect(c[key], key).toBeTruthy();
    }
    expect(c.limits).toMatch(/not been audited or certified/);
  });
});

describe('consistent wording', () => {
  const sources = walk('src', ['.jsx', '.js']).map((f) => [f, read(f)]);

  function find(re) {
    const hits = [];
    for (const [f, text] of sources) {
      text.split('\n').forEach((line, i) => {
        if (re.test(line) && !line.trim().startsWith('//')) hits.push(`${f}:${i + 1}`);
      });
    }
    return hits;
  }

  it('DEFECT: the identity page has one name (the menu says Identity, so no "Keys page")', () => {
    expect(read('src/components/Nav.jsx')).toMatch(/label: 'Identity'/);
    expect(find(/\bKeys page\b/)).toEqual([]);
  });

  it('DEFECT: "verify-only link" is spelled one way', () => {
    const a = find(/Verify only link/);
    const b = find(/Verify-only link/);
    expect(a.length === 0 || b.length === 0, `hyphen ${b.join(', ')} versus none ${a.join(', ')}`).toBe(true);
  });

  it('the same thing is called a fingerprint of the original file and a hash of the locked file', () => {
    // The two are different values and the labels keep them apart.
    expect(find(/Fingerprint of the original file/).length).toBeGreaterThan(0);
    expect(find(/Locked file hash/).length).toBeGreaterThan(0);
  });

});
