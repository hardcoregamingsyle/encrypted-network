// Review r3: Cloudflare Pages deployability checks that can run without a Cloudflare account.
// Read cost checks that used to be it.fails tests (demonstrated problems) are normal tests since the fixes.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CHANNEL_SELECT } from '../../../functions/_lib/channels.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Code without comment lines, good enough for a simple search.
function code(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

describe('runtime: functions/ and shared/ use Workers safe APIs only', () => {
  const files = [...walk(join(ROOT, 'functions')), ...walk(join(ROOT, 'shared'))];
  it('finds the server files', () => {
    expect(files.length).toBeGreaterThan(20);
  });
  const banned = [
    [/\bBuffer\b/, 'Buffer'],
    [/\bprocess\./, 'process'],
    [/\brequire\s*\(/, 'require'],
    [/from\s+["']node:/, 'node: import'],
    [/from\s+["'](fs|path|crypto|os|stream|util)["']/, 'bare node module'],
    [/__dirname|__filename/, 'dirname'],
    [/\beval\s*\(|new Function\s*\(/, 'dynamic code'],
    [/\bsetInterval\b/, 'setInterval'],
    [/\blocalStorage\b|\bwindow\.|\bdocument\./, 'browser global'],
    [/import\s*\(/, 'dynamic import']
  ];
  for (const f of files) {
    it(`${relative(ROOT, f).replace(/\\/g, '/')} has no banned API`, () => {
      const text = code(f);
      for (const [re, name] of banned) expect(re.test(text), name).toBe(false);
    });
  }
  it('has no module scope Date.now, Math.random, fetch or random value calls', () => {
    for (const f of files) {
      for (const line of code(f).split('\n')) {
        if (/^(const|let|var)\s.*(Date\.now\(|Math\.random\(|fetch\(|getRandomValues\()/.test(line)) {
          throw new Error(`${f}: module scope call: ${line}`);
        }
      }
    }
  });
  it('imports use explicit .js extensions', () => {
    for (const f of files) {
      for (const m of code(f).matchAll(/from\s+'(\.[^']*)'/g)) expect(m[1].endsWith('.js'), `${f} ${m[1]}`).toBe(true);
    }
  });
});

describe('static hosting config', () => {
  it('_routes.json sends only /api/* to functions', () => {
    const routes = JSON.parse(read('public/_routes.json'));
    expect(routes).toEqual({ version: 1, include: ['/api/*'], exclude: [] });
  });
  it('_headers has a strict CSP with no inline allowance and long cache only for hashed assets', () => {
    const text = read('public/_headers');
    const csp = text.match(/Content-Security-Policy: (.*)/)[1];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    const blocks = text.split(/\r?\n(?=\S)/);
    const assets = blocks.find((b) => b.startsWith('/assets/*'));
    expect(assets).toContain('immutable');
    expect(blocks.find((b) => b.startsWith('/*'))).not.toContain('immutable');
  });
  it('index.html has no inline script, style or event handler', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
  });
  it('there is no 404.html (Pages then serves index.html for deep links, which the SPA needs)', () => {
    expect(existsSync(join(ROOT, 'public', '404.html'))).toBe(false);
  });
  it('the API middleware adds the headers that _headers cannot add to function responses', () => {
    const mw = read('functions/_middleware.js');
    for (const h of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Cache-Control']) expect(mw).toContain(h);
  });
});

describe('wrangler.toml', () => {
  const toml = read('wrangler.toml');
  it('is a Pages config with the bindings the code uses', () => {
    expect(toml).toMatch(/^pages_build_output_dir\s*=\s*"\.\/dist"/m);
    expect(toml).toMatch(/binding\s*=\s*"DB"/);
    expect(toml).toMatch(/binding\s*=\s*"BLOBS"/);
    // R2 is optional: the file store only uses a FILES binding when one is present
    expect(toml).not.toMatch(/binding\s*=\s*"FILES"/);
    expect(toml).toMatch(/migrations_dir\s*=\s*"migrations"/);
    const used = new Set();
    for (const f of walk(join(ROOT, 'functions'))) for (const m of code(f).matchAll(/env\.([A-Z_]+)/g)) used.add(m[1]);
    expect([...used].sort()).toEqual(['BLOBS', 'DB', 'FILES', 'SERVER_SIGNING_JWK']);
  });
  it('compatibility_date is not in the future and no node compat flag is needed', () => {
    const d = toml.match(/compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"/)[1];
    expect(new Date(d).getTime()).toBeLessThanOrEqual(Date.now());
    expect(toml).not.toMatch(/nodejs_compat/);
  });
  it('has a real database id and a real KV namespace id, not placeholders', () => {
    const dbId = toml.match(/database_id\s*=\s*"([^"]+)"/)[1];
    expect(dbId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(dbId).not.toBe('00000000-0000-0000-0000-000000000000');
    const kvId = toml.match(/\[\[kv_namespaces\]\][\s\S]*?\bid\s*=\s*"([^"]+)"/)[1];
    expect(kvId).toMatch(/^[0-9a-f]{32}$/);
    expect(kvId).not.toMatch(/^0+$/);
  });
});

describe('D1 read cost', () => {
  function messagesDb() {
    const db = new DatabaseSync(':memory:');
    for (const name of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
      db.exec(readFileSync(join(ROOT, 'migrations', name), 'utf8'));
    }
    return db;
  }
  const plan = (db, sql, ...args) =>
    db
      .prepare('EXPLAIN QUERY PLAN ' + sql)
      .all(...args)
      .map((r) => r.detail)
      .join(' | ');

  it('the poll query for new messages is an index range seek', () => {
    const db = messagesDb();
    const p = plan(db, 'SELECT hash, seq FROM messages WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT 51', 'abc', 10);
    expect(p).toMatch(/SEARCH messages USING INDEX .*channel_id=\? AND seq>\?/);
  });

  // GET /api/channels/:id/messages runs CHANNEL_SELECT on every poll (every 3 s per open tab). It used to
  // count all messages of the channel, so D1 read one index row per message per poll (the free plan allows
  // 5 million rows read per day). The counters are stored on the channel row now.
  it('a poll does not count every message of the channel', () => {
    const db = messagesDb();
    const p = plan(db, CHANNEL_SELECT + ' WHERE c.channel_id = ?', 'abc');
    expect(p).not.toMatch(/SCALAR SUBQUERY/);
    expect(p).not.toMatch(/messages/);
  });

  it('the channel list does not read messages either', () => {
    const db = messagesDb();
    const p = plan(db, CHANNEL_SELECT + ' ORDER BY c.received_at DESC, c.channel_id DESC LIMIT 200');
    expect(p).not.toMatch(/messages|SCALAR SUBQUERY/);
  });

  // The document bundle used to have no LIMIT, so a document with many versions made an unbounded
  // response and unbounded CPU for one request (free plan: 10 ms CPU). Versions per document are capped
  // on write, and the read is bounded as well.
  it('the document bundle query is bounded', () => {
    const src = read('functions/_lib/documents.js');
    const readDoc = src.slice(src.indexOf('export async function readDocument'));
    expect(readDoc).toMatch(/ORDER BY r\.version ASC LIMIT/);
  });
});
