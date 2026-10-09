// The operator scripts: takedown plan, Node check, deploy check, key file, and the deploy notes.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDeploy } from '../../scripts/check-deploy.mjs';
import { nodeVersionOk } from '../../scripts/check-node.mjs';
import { planTakedown } from '../../scripts/takedown.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HASH = 'ab'.repeat(32);

describe('takedown plan', () => {
  const base = { hash: HASH, reason: 'court order 12', remote: true, local: false, persistTo: null };

  it('blocks the hash, removes the row and deletes the object, in that order', () => {
    const steps = planTakedown(base);
    expect(steps).toHaveLength(3);
    expect(steps[0].slice(0, 3)).toEqual(['d1', 'execute', 'DB']);
    expect(steps[0].at(-1)).toContain('blocked_blobs');
    expect(steps[0].at(-1)).toContain(HASH);
    expect(steps[1].at(-1)).toBe(`DELETE FROM blobs WHERE hash = '${HASH}'`);
    expect(steps[2].slice(0, 3)).toEqual(['r2', 'object', 'delete']);
    expect(steps[2][3]).toBe(`hrdlock-files/blobs/${HASH}`);
    for (const s of steps) expect(s).toContain('--remote');
  });

  it('local runs name the persist folder', () => {
    const steps = planTakedown({ ...base, remote: false, local: true, persistTo: '.wrangler/state-x' });
    for (const s of steps) {
      expect(s).toContain('--local');
      expect(s).toContain('.wrangler/state-x');
    }
  });

  it('refuses a bad hash, no target, both targets and a bad reason', () => {
    expect(() => planTakedown({ ...base, hash: HASH.toUpperCase() })).toThrow(/hex/);
    expect(() => planTakedown({ ...base, hash: "x'; DROP TABLE blobs; --" })).toThrow(/hex/);
    expect(() => planTakedown({ ...base, hash: HASH.slice(1) })).toThrow(/hex/);
    expect(() => planTakedown({ ...base, remote: false, local: false })).toThrow(/exactly one/);
    expect(() => planTakedown({ ...base, remote: true, local: true })).toThrow(/exactly one/);
    expect(() => planTakedown({ ...base, reason: '' })).toThrow(/required/);
    expect(() => planTakedown({ ...base, reason: 'x'.repeat(201) })).toThrow(/200/);
    expect(() => planTakedown({ ...base, reason: 'line\nbreak' })).toThrow(/printable/);
    expect(() => planTakedown({ ...base, reason: 'caf\u{e9}' })).toThrow(/printable/);
  });

  it('keeps quotes in the reason inside the SQL string', () => {
    const sql = planTakedown({ ...base, reason: "it's '); DROP TABLE blobs; --" })[0].at(-1);
    expect(sql).toContain("'it''s ''); DROP TABLE blobs; --'");
  });
});

describe('node version check', () => {
  it('accepts the versions the tools need', () => {
    for (const v of ['20.19.0', '20.20.1', '22.12.0', '22.20.3', '24.19.0', 'v23.1.0', '25.0.0']) expect(nodeVersionOk(v), v).toBe(true);
  });
  it('refuses older and unsupported versions', () => {
    for (const v of ['18.20.4', '20.18.9', '20.0.0', '21.7.0', '22.11.9', '16.0.0', '', 'nonsense']) expect(nodeVersionOk(v), v).toBe(false);
  });
  it('the repo pins a Node major that passes, and the build runs the check', () => {
    const pin = readFileSync(join(ROOT, '.node-version'), 'utf8').trim();
    expect(pin).toMatch(/^\d+$/);
    expect(nodeVersionOk(pin + '.99.0')).toBe(true);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toMatch(/check-node\.mjs/);
  });
});

describe('deploy check', () => {
  function site({ signing = true, keyId = 'c'.repeat(64), health = 200 } = {}) {
    return async (url, init = {}) => {
      const path = new URL(url).pathname;
      const json = (body, status = 200) =>
        new Response(init.method === 'HEAD' ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
        });
      if (path === '/api/health') return json({ ok: true, signing }, health);
      if (path === '/api/server-key') return json({ signing, keyId: signing ? keyId : null, publicKey: null });
      if (path === '/') return new Response('<html></html>', { status: 200, headers: { 'content-security-policy': "default-src 'self'; script-src 'self'" } });
      return json({ error: 'no such API route', code: 'not_found' }, 404);
    };
  }

  it('passes for a healthy site with signing on, and reports the key id', async () => {
    const out = await checkDeploy('https://x.test/', { fetchImpl: site() });
    expect(out.ok).toBe(true);
    expect(out.keyId).toBe('c'.repeat(64));
  });

  it('fails when the signing key is missing', async () => {
    const out = await checkDeploy('https://x.test', { fetchImpl: site({ signing: false }) });
    expect(out.ok).toBe(false);
    expect(out.results.filter((r) => !r.ok).map((r) => r.name)).toEqual(expect.arrayContaining(['health reports signing', 'server key is set']));
  });

  it('fails when the key id is not the expected one, and passes when it is', async () => {
    expect((await checkDeploy('https://x.test', { fetchImpl: site(), expectKeyId: 'd'.repeat(64) })).ok).toBe(false);
    expect((await checkDeploy('https://x.test', { fetchImpl: site(), expectKeyId: 'c'.repeat(64) })).ok).toBe(true);
  });

  it('fails when the site is unreachable', async () => {
    const out = await checkDeploy('https://x.test', {
      fetchImpl: async () => {
        throw new Error('connection refused');
      }
    });
    expect(out.ok).toBe(false);
  });
});

describe('production key file', () => {
  it('writes a private key file once, refuses to overwrite it, and prints the key id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hrdkey-'));
    try {
      const file = join(dir, 'server-key.json');
      const run = () => spawnSync(process.execPath, [join(ROOT, 'scripts', 'setup-dev.mjs'), '--write-production-key', file], { encoding: 'utf8' });
      const first = run();
      expect(first.status).toBe(0);
      expect(first.stdout).toMatch(/server key id: [0-9a-f]{64}/);
      expect(existsSync(file)).toBe(true);
      const jwk = JSON.parse(readFileSync(file, 'utf8'));
      expect(jwk.kty).toBe('EC');
      expect(typeof jwk.d).toBe('string');
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
      const before = readFileSync(file, 'utf8');
      const second = run();
      expect(second.status).not.toBe(0);
      expect(second.stderr).toMatch(/already exists/);
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('deploy notes', () => {
  const notes = readFileSync(join(ROOT, 'scripts', 'DEPLOY.md'), 'utf8');
  it('cover the things an operator has to do', () => {
    for (const word of ['migrations apply', 'write-production-key', 'secret put SERVER_SIGNING_JWK', 'check-deploy', 'takedown', 'NODE_VERSION', 'prototype']) {
      expect(notes, word).toContain(word);
    }
    expect(notes).toMatch(/ledger is public/i);
    expect(notes).toMatch(/unlisted/i);
  });
  // built from pieces so that this file does not hold the words either
  const banned = new RegExp('\\b(' + ['A' + 'I', 'assist' + 'ant', 'Cl' + 'aude', 'Anthr' + 'opic', 'Open' + 'A' + 'I', 'G' + 'PT', 'L' + 'LM'].join('|') + ')\\b');
  it('use no long dashes, and name no tool or vendor that wrote code', () => {
    for (const file of ['scripts/DEPLOY.md', 'scripts/takedown.mjs', 'scripts/check-deploy.mjs', 'scripts/check-node.mjs', 'scripts/setup-dev.mjs', 'migrations/0002_hardening.sql']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text, file).not.toMatch(new RegExp(String.fromCodePoint(0x2014) + '|' + String.fromCodePoint(0x2013)));
      expect(text, file).not.toMatch(banned);
    }
  });
});
