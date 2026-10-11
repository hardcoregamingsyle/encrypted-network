import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FilesPasswordSheet from '../../src/components/files/FilesPasswordSheet.jsx';
import { NOT_THE_SAME, NOT_YOURS, SET_ELSEWHERE, submitFilesPassword } from '../../src/components/files/filesPasswordFlow.js';
import { filesCheckFor, lockPasswordFor } from '../../src/lib/filesPassword.js';

const ACCOUNT = 'a'.repeat(32);
const PASSWORD = 'correct horse battery';
const FAST = 1000; // iterations, the real count is far slower and not what these tests are about

function api(over = {}) {
  const calls = [];
  return { calls, putCheck: async (c) => (calls.push(c), over.putCheck ? over.putCheck(c) : undefined) };
}
const base = { accountId: ACCOUNT, iterations: FAST };

describe('submitFilesPassword, first time (no fingerprint on the account yet)', () => {
  it('saves the fingerprint and gives back the password for the locking code', async () => {
    const a = api();
    const lock = await submitFilesPassword({ ...base, password: PASSWORD, again: PASSWORD, purpose: 'add', check: null }, a);
    expect(lock).toBe(await lockPasswordFor(PASSWORD, ACCOUNT, FAST));
    expect(a.calls).toEqual([await filesCheckFor(lock, FAST)]);
  });

  it('refuses two different passwords or a weak one and saves nothing', async () => {
    const a = api();
    await expect(submitFilesPassword({ ...base, password: PASSWORD, again: PASSWORD + 'x', purpose: 'add', check: null }, a)).rejects.toThrow(NOT_THE_SAME);
    await expect(submitFilesPassword({ ...base, password: 'short', again: 'short', purpose: 'add', check: null }, a)).rejects.toThrow(/at least 10/);
    expect(a.calls).toEqual([]);
  });

  it('says so when another device set the password a moment ago, and passes other errors on', async () => {
    const taken = Object.assign(new Error('already'), { code: 'conflict' });
    await expect(submitFilesPassword({ ...base, password: PASSWORD, again: PASSWORD, purpose: 'add', check: null }, api({ putCheck: () => Promise.reject(taken) }))).rejects.toThrow(SET_ELSEWHERE);
    const down = Object.assign(new Error('down'), { code: 'network' });
    await expect(submitFilesPassword({ ...base, password: PASSWORD, again: PASSWORD, purpose: 'add', check: null }, api({ putCheck: () => Promise.reject(down) }))).rejects.toBe(down);
  });
});

describe('submitFilesPassword, password already set', () => {
  it('adding a file: the right password passes, a typo is refused before anything is locked', async () => {
    const check = await filesCheckFor(await lockPasswordFor(PASSWORD, ACCOUNT, FAST), FAST);
    const a = api();
    expect(await submitFilesPassword({ ...base, password: PASSWORD, purpose: 'add', check }, a)).toBe(await lockPasswordFor(PASSWORD, ACCOUNT, FAST));
    await expect(submitFilesPassword({ ...base, password: 'correct horse batterz', purpose: 'add', check }, a)).rejects.toThrow(NOT_YOURS);
    expect(a.calls).toEqual([]); // nothing is saved when the fingerprint exists
  });

  it('opening a file does not compare (the file itself says if the password is wrong)', async () => {
    const check = 'f'.repeat(64);
    expect(await submitFilesPassword({ ...base, password: 'any password at all', purpose: 'open', check }, api())).toBe(await lockPasswordFor('any password at all', ACCOUNT, FAST));
  });

  it('a password that is too short is refused first, with its own sentence', async () => {
    await expect(submitFilesPassword({ ...base, password: 'nope', purpose: 'open', check: 'f'.repeat(64) }, api())).rejects.toThrow(/at least 10/);
  });
});

describe('FilesPasswordSheet (what the person sees)', () => {
  const render = (props) => renderToString(h(FilesPasswordSheet, { accountId: ACCOUNT, onDone: () => {}, onClose: () => {}, ...props }));
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('the first time: two password boxes and a plain warning that nobody can recover it', () => {
    const html = render({ purpose: 'add', check: null });
    expect(text(html)).toContain('Choose your files password');
    expect(text(html)).toContain('We cannot recover it');
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(text(html)).toContain('Save password');
  });

  it('afterwards: one box, and it says what the password is for', () => {
    const add = render({ purpose: 'add', check: 'f'.repeat(64) });
    expect(add.match(/type="password"/g)).toHaveLength(1);
    expect(text(add)).toContain('to lock this file');
    expect(text(render({ purpose: 'open', check: 'f'.repeat(64) }))).toContain('to open this file');
  });

  it('while the fingerprint is being read it shows a short wait line and no boxes', () => {
    const html = render({ purpose: 'add' });
    expect(text(html)).toContain('Checking your account');
    expect(html).not.toContain('type="password"');
  });

  it('opening a file needs no fingerprint: one box at once, nothing is read first', () => {
    const html = render({ purpose: 'open' });
    expect(html.match(/type="password"/g)).toHaveLength(1);
    expect(text(html)).not.toContain('Checking your account');
    expect(text(html)).toContain('to open this file');
    expect(text(html)).not.toContain('Choose your files password');
  });

  it('uses plain words only', () => {
    const all = text(render({ purpose: 'add', check: null }) + render({ purpose: 'open', check: 'f'.repeat(64) }));
    expect(all).not.toMatch(/PBKDF2|fingerprint|hash|key id|salt|JWK|ciphertext/i);
    expect(all).not.toMatch(/[\u2014\u2013]/);
  });
});
