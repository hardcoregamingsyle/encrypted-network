// The Private tab: the add pipeline (lock, sign, send) and what the tab shows.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../shared/records.js';
import { signRecord, verifyRecord } from '../../shared/keys.js';
import { unlockFile } from '../../src/lib/lockfile.js';
import { ToastProvider } from '../../src/components/Toast.jsx';
import ViewableSwitch from '../../src/components/doc/ViewableSwitch.jsx';
import PrivateFiles from '../../src/components/files/PrivateFiles.jsx';
import { addPrivateFile, labelFor } from '../../src/components/files/addPrivate.js';
import { NOT_YOURS } from '../../src/components/files/filesPasswordFlow.js';
import { DAMAGED, NOT_SAVED_BY_YOU, fetchChecked, openLocked } from '../../src/components/files/openPrivate.js';
import { deletePrivateFile, getPrivateFile } from '../../src/lib/api.js';
import { createIdentity } from '../helpers/bundle.js';

const PASSWORD = 'lock-password-for-tests';
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const fileOf = (bytes, name = 'Land record.pdf') => ({ name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });

describe('labelFor', () => {
  it('keeps plain names, swaps control and direction characters, and has a fallback', () => {
    expect(labelFor('Land record.pdf')).toBe('Land record.pdf');
    expect(labelFor('a' + String.fromCharCode(10, 0x202e, 0x200b) + 'b')).toBe('a___b');
    expect(labelFor('x'.repeat(300))).toHaveLength(120);
    expect(labelFor('')).toBe('Private file');
    expect(labelFor(undefined)).toBe('Private file');
  });
});

describe('addPrivateFile', () => {
  it('locks with the password, signs the blob record, and sends what the server checks', async () => {
    const who = await createIdentity('Priya');
    const identity = { keyId: who.keyId, sign: (record) => signRecord(who.privateKey, record) };
    const sent = [];
    const data = new TextEncoder().encode('private words');
    const answer = await addPrivateFile({ file: fileOf(data), lockPassword: PASSWORD, identity }, { putPrivateFile: async (x) => (sent.push(x), { id: 'f'.repeat(32), size: x.bytes.length }) });
    expect(answer.id).toHaveLength(32);
    const [s] = sent;
    expect(s.label).toBe('Land record.pdf');
    expect(s.signer).toBe(who.keyId);
    const record = { v: 2, type: 'blob.put', hash: s.hash, size: s.bytes.length, signer: who.keyId, createdAt: s.createdAt };
    expect(await verifyRecord(who.publicJwk, record, s.signature)).toBe(true);
    const opened = await unlockFile(s.bytes, PASSWORD);
    expect(new TextDecoder().decode(opened.data)).toBe('private words');
    await expect(unlockFile(s.bytes, PASSWORD + 'x')).rejects.toThrow();
  });

  it('refuses an empty file and a file over the limit before locking anything', async () => {
    const put = async () => {
      throw new Error('should not be called');
    };
    const identity = { keyId: 'k', sign: put };
    await expect(addPrivateFile({ file: fileOf(new Uint8Array(0)), lockPassword: PASSWORD, identity }, { putPrivateFile: put })).rejects.toThrow(/empty/);
    const big = { name: 'big.bin', size: LIMITS.MAX_FILE_BYTES + 1, arrayBuffer: put };
    await expect(addPrivateFile({ file: big, lockPassword: PASSWORD, identity }, { putPrivateFile: put })).rejects.toThrow(/too large/);
  });
});

describe('PrivateFiles (what the person sees)', () => {
  const READY = { status: 'ready', mode: 'account', account: { id: 'f'.repeat(32) }, identity: { keyId: 'ab'.repeat(32) } };
  const render = (session, props) => renderToString(h(MemoryRouter, null, h(ToastProvider, null, h(PrivateFiles, { session, ...props }))));

  it('signed out or a quick start guest: says email is needed and links to sign in', () => {
    for (const session of [{ status: 'signedOut', mode: null }, { status: 'ready', mode: 'guest', identity: { keyId: 'k' } }]) {
      const html = render(session);
      expect(text(html)).toContain('Private files need an email account');
      expect(html).toContain('href="/signin"');
      expect(html).not.toContain('type="file"');
    }
  });

  it('signed in by email but without a key on this device: the same one more step as the Mine tab', () => {
    const html = render({ status: 'needsKey', mode: 'account', account: { displayName: null }, keys: [], identity: null });
    expect(text(html)).toContain('One more step');
    expect(text(html)).toContain('Choose your name');
    expect(text(html)).not.toContain('need an email account');
  });

  it('while the session loads it shows a wait state and no button', () => {
    const html = render({ status: 'loading' });
    expect(html).not.toContain('Add a private file');
    expect(html).not.toContain('type="file"');
  });

  it('an account: the add button and a hidden file box, no sheet until a file is picked', () => {
    const html = render(READY, { files: [] });
    expect(text(html)).toContain('Add a private file');
    expect(html).toContain('type="file"');
    expect(html).toMatch(/class="ui-sr-only"[^>]*type="file"/); // the plain browser box stays out of sight
    expect(html).not.toMatch(/<input[^>]*shidden/);
    expect(text(html)).toContain('No private files yet');
    expect(html).not.toContain('Files password');
  });

  it('lists each file by its name with its size and age', () => {
    const now = 1790000000000;
    const html = render(READY, { now, files: [{ id: 'a'.repeat(32), label: 'Land record.pdf', size: 2048, createdAt: now - 3600 * 1000 }] });
    expect(text(html)).toContain('Land record.pdf');
    expect(text(html)).toContain('2 KiB');
    expect(text(html)).not.toContain('No private files yet');
  });

  it('each row also has a Make public button, and the viewable switch waits for its answer before it can be used', () => {
    const html = render(READY, { files: [{ id: 'a'.repeat(32), label: 'Land record.pdf', size: 2048, createdAt: 1790000000000 }] });
    expect(html).toContain('aria-label="Make Land record.pdf public"');
    expect(text(html)).toContain('Make public');
    const sw = renderToString(h(ViewableSwitch, { docId: 'c'.repeat(32), password: 'ABCD' }));
    expect(text(sw)).toContain('Anyone can open this file');
    expect(text(sw)).toContain('Off: anyone can still check a file against this one');
    expect(sw).toMatch(/<input[^>]*disabled/);
    expect(sw).toMatch(/type="checkbox"/);
  });

  it('each row has a Download and a Delete button named after the file', () => {
    const html = render(READY, { files: [{ id: 'a'.repeat(32), label: 'Land record.pdf', size: 2048, createdAt: 1790000000000 }] });
    expect(html).toContain('aria-label="Download Land record.pdf"');
    expect(html).toContain('aria-label="Delete Land record.pdf"');
    expect(html).not.toContain('Delete this file?'); // the confirm sheet is closed until Delete is pressed
  });

  it('uses plain words only', () => {
    const all = text(render(READY, { files: [] }) + render({ status: 'signedOut', mode: null }));
    expect(all).not.toMatch(/PBKDF2|fingerprint|hash|key id|salt|JWK|ciphertext|blob/i);
    expect(all).not.toMatch(new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']'));
  });
});

// A saved file as the server would hand it back: made by the real add pipeline with a real key.
async function saved(who, content = 'private words') {
  const identity = { keyId: who.keyId, sign: (record) => signRecord(who.privateKey, record) };
  let stored;
  await addPrivateFile({ file: fileOf(new TextEncoder().encode(content)), lockPassword: PASSWORD, identity }, { putPrivateFile: async (x) => (stored = x) });
  return stored;
}

describe('fetchChecked and openLocked', () => {
  const serve = (file) => ({ getPrivateFile: async () => ({ ...file }) });

  it('a file the account saved passes, then opens with the right password', async () => {
    const who = await createIdentity('Priya');
    const file = await saved(who);
    const bytes = await fetchChecked('a'.repeat(32), { ownKeyIds: [who.keyId], publicKeyOf: async () => who.publicJwk }, serve(file));
    const opened = await openLocked(bytes, PASSWORD);
    expect(opened.name).toBe('Land record.pdf');
    expect(new TextDecoder().decode(opened.data)).toBe('private words');
  });

  it('a wrong password gives the plain sentence and nothing is returned', async () => {
    const who = await createIdentity('Priya');
    const file = await saved(who);
    await expect(openLocked(file.bytes, PASSWORD + 'x')).rejects.toThrow(NOT_YOURS);
    await expect(openLocked(file.bytes, '')).rejects.toThrow(NOT_YOURS);
    await expect(openLocked(new Uint8Array(200), PASSWORD)).rejects.toThrow(DAMAGED);
  });

  it('refuses bytes that changed, a changed time, a signature of someone else, and a key that is not one of the account keys', async () => {
    const who = await createIdentity('Priya');
    const other = await createIdentity('Other');
    const file = await saved(who);
    const mine = { ownKeyIds: [who.keyId], publicKeyOf: async () => who.publicJwk };
    const swapped = file.bytes.slice();
    swapped[swapped.length - 40] ^= 1;
    const forged = await signRecord(other.privateKey, { v: 2, type: 'blob.put', hash: file.hash, size: file.bytes.length, signer: who.keyId, createdAt: file.createdAt });
    const own = await saved(other);
    const cases = [
      ['bytes changed', { ...file, bytes: swapped }, mine],
      ['time changed', { ...file, createdAt: file.createdAt + 1 }, mine],
      ['time missing', { ...file, createdAt: NaN }, mine],
      ['hash header changed', { ...file, hash: '0'.repeat(64) }, mine],
      ['signature missing', { ...file, signature: '' }, mine],
      ['signed by another key', { ...file, signature: forged }, mine],
      ['a different key swapped in with its own good signature', own, mine],
      ['the key the server names is not the one that was asked for', file, { ownKeyIds: [who.keyId], publicKeyOf: async () => other.publicJwk }]
    ];
    for (const [name, served, options] of cases) {
      await expect(fetchChecked('a'.repeat(32), options, serve(served)), name).rejects.toThrow(NOT_SAVED_BY_YOU);
    }
  });
});

describe('private file calls', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('getPrivateFile reads the bytes and what the owner signed from the headers', async () => {
    const headers = { 'x-blob-sha256': 'ab'.repeat(32), 'x-hrd-key': 'cd'.repeat(32), 'x-hrd-time': '1790000000000', 'x-hrd-sig': 's'.repeat(86) };
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers }));
    const got = await getPrivateFile('e'.repeat(32));
    expect(Array.from(got.bytes)).toEqual([1, 2, 3]);
    expect(got).toMatchObject({ hash: 'ab'.repeat(32), signer: 'cd'.repeat(32), createdAt: 1790000000000, signature: 's'.repeat(86) });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/me/files/' + 'e'.repeat(32));
  });

  it('getPrivateFile gives empty values (which the check refuses) when the headers are missing, and an error when the file is gone', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(new Uint8Array([1]), { status: 200 }));
    expect(await getPrivateFile('e'.repeat(32))).toMatchObject({ hash: '', signer: '', signature: '', createdAt: 0 });
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'file not found', code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } }));
    await expect(getPrivateFile('e'.repeat(32))).rejects.toMatchObject({ status: 404 });
  });

  it('deletePrivateFile sends a DELETE for that file', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await deletePrivateFile('e'.repeat(32))).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/me/files/' + 'e'.repeat(32));
    expect(init.method).toBe('DELETE');
  });
});
