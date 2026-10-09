import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../shared/hash.js';
import { verifyBlobBytes, verifyDocumentBundle, verifyPlaintext } from '../../shared/verify.js';
import {
  MAX_COMPARE_BYTES,
  bundleAttestedAt,
  compareFingerprint,
  compareWithHead,
  compareWithOlder,
  describeOlderComparison,
  fingerprintOfFile,
  parseDocInput,
  parseFingerprint,
  parseKeyIdInput,
  pinStatus,
  readBundleText,
  spacedFingerprint
} from '../../src/components/verify/logic.js';
import { lockFile, unlockFile } from '../../src/lib/lockfile.js';
import { buildBundle, buildBundleParts, createIdentity, createServerKey } from '../helpers/bundle.js';

const ID = '9f2c4a7e1b3d4c5e8a6f0b1c2d3e4f50';
const PW = 'ABCD-EFGH-JKLM-NPQR-STUV';
const PW_PLAIN = 'ABCDEFGHJKLMNPQRSTUV';

describe('parseDocInput', () => {
  it('reads a bare id and lowercases it', () => {
    expect(parseDocInput(ID)).toEqual({ ok: true, docId: ID, password: '', host: '' });
    expect(parseDocInput(ID.toUpperCase()).docId).toBe(ID);
  });

  it('reads a full link with the password after #k=', () => {
    const r = parseDocInput(`https://records.example.gov/d/${ID}#k=${PW_PLAIN}`);
    expect(r).toEqual({ ok: true, docId: ID, password: PW_PLAIN, host: 'records.example.gov' });
  });

  it('reads a link without a password, with a path only, and with a trailing slash', () => {
    expect(parseDocInput(`https://x.test/d/${ID}`).password).toBe('');
    expect(parseDocInput(`/d/${ID}`).docId).toBe(ID);
    expect(parseDocInput(`d/${ID}`).docId).toBe(ID);
    expect(parseDocInput(`https://x.test/d/${ID}/`).docId).toBe(ID);
    expect(parseDocInput(`localhost:5173/d/${ID}`).docId).toBe(ID);
  });

  it('normalises the password: dashes, spaces, case and percent escapes do not matter', () => {
    expect(parseDocInput(`/d/${ID}#k=${PW}`).password).toBe(PW_PLAIN);
    expect(parseDocInput(`/d/${ID}#k=${PW.toLowerCase()}`).password).toBe(PW_PLAIN);
    expect(parseDocInput(`/d/${ID}#k=ABCD%20EFGH%20JKLM%20NPQR%20STUV`).password).toBe(PW_PLAIN);
    expect(parseDocInput(`${ID}#k=${PW}`).password).toBe(PW_PLAIN);
  });

  it('ignores a query string and other fragment parts', () => {
    const r = parseDocInput(`https://x.test/d/${ID}?utm=1#foo=bar&k=${PW_PLAIN}`);
    expect(r.docId).toBe(ID);
    expect(r.password).toBe(PW_PLAIN);
  });

  describe('messy input', () => {
    const messy = {
      'leading and trailing spaces': `   ${ID}   `,
      'tabs and newlines': `\n\t${ID}\r\n`,
      'angle brackets': `<${ID}>`,
      'quotes': `"${ID}"`,
      'trailing full stop': `/d/${ID}.`,
      'trailing comma': `https://x.test/d/${ID},`,
      'upper case id in a link': `HTTPS://X.TEST/d/${ID.toUpperCase()}`
    };
    for (const [name, text] of Object.entries(messy)) {
      it(`still finds the id: ${name}`, () => {
        const r = parseDocInput(text);
        expect(r.ok).toBe(true);
        expect(r.docId).toBe(ID);
      });
    }

    const broken = {
      'one character missing': ID.slice(1),
      'one character extra': ID + 'a',
      'a letter outside a-f': ID.slice(0, 10) + 'g' + ID.slice(11),
      'spaces inside the id': ID.slice(0, 16) + ' ' + ID.slice(16),
      'dashes inside the id': ID.slice(0, 8) + '-' + ID.slice(8),
      'id followed by text': ID + 'xyz',
      'wrong path word': `https://x.test/doc/${ID}`,
      'empty': '',
      'only spaces': '   ',
      'random symbols': '@@@###$$$',
      'filler words': 'please check the document'
    };
    for (const [name, text] of Object.entries(broken)) {
      it(`refuses with a plain message: ${name}`, () => {
        const r = parseDocInput(text);
        expect(r.ok).toBe(false);
        expect(typeof r.error).toBe('string');
        expect(r.error.length).toBeGreaterThan(5);
      });
    }
  });

  it('explains that a 64 character hash is not a document id', () => {
    const r = parseDocInput('a'.repeat(64));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('hash');
  });

  it('rejects non strings and very long input', () => {
    for (const v of [null, undefined, 42, {}, [], true]) expect(parseDocInput(v).ok).toBe(false);
    expect(parseDocInput('a'.repeat(5000)).ok).toBe(false);
  });

  it('a malformed or upper case #K= gives no password but still finds the document', () => {
    expect(parseDocInput(`/d/${ID}#k=`).password).toBe('');
    expect(parseDocInput(`/d/${ID}#k=%E0%A4%A`).password).toBe('');
    expect(parseDocInput(`/d/${ID}#K=${PW}`)).toMatchObject({ ok: true, password: '' });
  });

  it('returns the host so the page can say a foreign host is ignored', () => {
    expect(parseDocInput(`https://elsewhere.test:8443/d/${ID}`).host).toBe('elsewhere.test:8443');
  });
});

describe('fingerprints', () => {
  const HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'; // sha256("abc")

  it('parseFingerprint ignores spaces, colons, dashes and case', () => {
    expect(parseFingerprint(HEX)).toEqual({ state: 'ok', value: HEX });
    expect(parseFingerprint(HEX.toUpperCase())).toEqual({ state: 'ok', value: HEX });
    expect(parseFingerprint(spacedFingerprint(HEX))).toEqual({ state: 'ok', value: HEX });
    expect(parseFingerprint(HEX.replace(/(..)/g, '$1:').slice(0, -1))).toEqual({ state: 'ok', value: HEX });
    expect(parseFingerprint(`  ${HEX}\n`)).toEqual({ state: 'ok', value: HEX });
  });

  it('parseFingerprint tells empty from invalid', () => {
    expect(parseFingerprint('')).toEqual({ state: 'empty' });
    expect(parseFingerprint('   ')).toEqual({ state: 'empty' });
    expect(parseFingerprint(null)).toEqual({ state: 'empty' });
    expect(parseFingerprint(HEX.slice(1))).toEqual({ state: 'invalid' });
    expect(parseFingerprint(HEX + '0')).toEqual({ state: 'invalid' });
    expect(parseFingerprint('g'.repeat(64))).toEqual({ state: 'invalid' });
  });

  it('spacedFingerprint groups by 8 and tolerates bad input', () => {
    expect(spacedFingerprint(HEX).split(' ')).toHaveLength(8);
    expect(spacedFingerprint(HEX).replace(/ /g, '')).toBe(HEX);
    expect(spacedFingerprint(5)).toBe('');
  });

  it('compareFingerprint: match, different, none, invalid', () => {
    expect(compareFingerprint(HEX, HEX)).toEqual({ state: 'match' });
    expect(compareFingerprint(HEX, spacedFingerprint(HEX).toUpperCase())).toEqual({ state: 'match' });
    expect(compareFingerprint(HEX, HEX.replace(/^b/, 'c'))).toEqual({ state: 'different' });
    expect(compareFingerprint(HEX, '')).toEqual({ state: 'none' });
    expect(compareFingerprint(HEX, 'nope')).toEqual({ state: 'invalid' });
    expect(compareFingerprint('', HEX)).toEqual({ state: 'different' });
    expect(compareFingerprint(undefined, HEX)).toEqual({ state: 'different' });
  });

  it('one changed character is a difference', () => {
    for (let i = 0; i < 64; i += 9) {
      const flipped = HEX.slice(0, i) + (HEX[i] === '0' ? '1' : '0') + HEX.slice(i + 1);
      expect(compareFingerprint(HEX, flipped).state).toBe('different');
    }
  });

  it('fingerprintOfFile hashes the bytes of a File or Blob', async () => {
    expect(await fingerprintOfFile(new Blob(['abc']))).toBe(HEX);
    expect(await fingerprintOfFile(new Blob([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const bytes = new Uint8Array(100000).map((_, i) => i % 251);
    expect(await fingerprintOfFile(new Blob([bytes]))).toBe(await sha256Hex(bytes));
  });

  it('fingerprintOfFile refuses missing, huge and unreadable files with a readable message', async () => {
    await expect(fingerprintOfFile(null)).rejects.toThrow('No file');
    await expect(fingerprintOfFile({ size: MAX_COMPARE_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) })).rejects.toThrow(
      'too large'
    );
    await expect(
      fingerprintOfFile({
        size: 1,
        arrayBuffer: async () => {
          throw new Error('disk gone');
        }
      })
    ).rejects.toThrow('could not be read');
  });
});

describe('readBundleText', () => {
  it('accepts a real bundle', async () => {
    const owner = await createIdentity('Registry');
    const bundle = await buildBundle({ owner, versions: [{}] });
    const r = readBundleText(JSON.stringify(bundle));
    expect(r.ok).toBe(true);
    expect(r.bundle.document.docId).toBe(bundle.document.docId);
  });

  it('accepts a wrapper with a bundle field', async () => {
    const owner = await createIdentity('Registry');
    const bundle = await buildBundle({ owner, versions: [{}] });
    const r = readBundleText(JSON.stringify({ kind: 'saved', bundle }));
    expect(r.ok).toBe(true);
    expect(r.bundle.records).toHaveLength(1);
  });

  it('refuses empty, invalid and wrong shaped files with a plain message', () => {
    for (const text of ['', '   ', null, undefined, 5, '{not json', '[]', '"text"', 'null', '{}', '{"records":[]}', '{"document":{}}']) {
      const r = readBundleText(text);
      expect(r.ok).toBe(false);
      expect(r.error.length).toBeGreaterThan(5);
    }
  });

  it('bundleAttestedAt reads the newest server signing time', async () => {
    const owner = await createIdentity('Registry');
    const now = 1_700_000_000_000;
    const bundle = await buildBundle({ owner, versions: [{}], now });
    expect(bundleAttestedAt(bundle)).toBe(now);
    expect(bundleAttestedAt({ ...bundle, checkpoint: null, headCheckpoint: null })).toBe(null);
    expect(bundleAttestedAt(null)).toBe(null);
    expect(bundleAttestedAt('x')).toBe(null);
  });
});

describe('pin helpers', () => {
  const K = 'a'.repeat(64);
  const L = 'b'.repeat(64);

  it('parseKeyIdInput cleans and validates', () => {
    expect(parseKeyIdInput(K)).toEqual({ state: 'ok', value: K });
    expect(parseKeyIdInput(`  ${K.toUpperCase()} `)).toEqual({ state: 'ok', value: K });
    expect(parseKeyIdInput('')).toEqual({ state: 'empty' });
    expect(parseKeyIdInput(undefined)).toEqual({ state: 'empty' });
    expect(parseKeyIdInput('a'.repeat(63))).toEqual({ state: 'invalid' });
    expect(parseKeyIdInput('z'.repeat(64))).toEqual({ state: 'invalid' });
  });

  it('pinStatus covers every state', () => {
    const ready = (keyId, signing = true) => ({ status: 'ready', data: { signing, keyId } });
    expect(pinStatus('', ready(K))).toBe('none');
    expect(pinStatus(K, { status: 'loading' })).toBe('checking');
    expect(pinStatus(K, null)).toBe('checking');
    expect(pinStatus(K, { status: 'error' })).toBe('unknown');
    expect(pinStatus(K, ready(null, false))).toBe('no_signing');
    expect(pinStatus(K, ready('', true))).toBe('no_signing');
    expect(pinStatus(K, ready(K))).toBe('match');
    expect(pinStatus(K, ready(L))).toBe('different');
  });
});

describe('compareWithHead', () => {
  const H1 = 'a'.repeat(64);
  const H2 = 'b'.repeat(64);
  const open = (extra = {}) => ({
    bundle: { records: [{}] },
    verification: { ok: true, status: 'active', head: { version: 2 } },
    blobCheck: { ok: true, detail: '' },
    plaintextCheck: { ok: true, detail: '' },
    fingerprint: H1,
    ...extra
  });

  it('same bytes as the latest version', () => {
    expect(compareWithHead(H1, open())).toMatchObject({ state: 'same', verified: true, version: 2 });
  });

  it('different bytes', () => {
    expect(compareWithHead(H2, open())).toMatchObject({ state: 'different', verified: true });
  });

  it('keeps track of a document that failed its own checks', () => {
    const r = compareWithHead(H1, open({ verification: { ok: false, status: 'invalid', head: null } }));
    expect(r.state).toBe('same');
    expect(r.verified).toBe(false);
  });

  it('a revoked document has no file to compare', () => {
    const r = compareWithHead(H1, open({ verification: { ok: true, status: 'revoked', head: { version: 3 } }, blobCheck: null }));
    expect(r.state).toBe('no_file');
  });

  it('cannot compare when the file did not match its signed hash, or was not unlocked', () => {
    expect(compareWithHead(H1, open({ blobCheck: { ok: false, detail: 'file hash differs' } })).state).toBe('not_unlocked');
    expect(compareWithHead(H1, open({ plaintextCheck: null, fingerprint: null })).state).toBe('not_unlocked');
    expect(compareWithHead(H1, open({ plaintextCheck: { ok: false, detail: 'wrong password, or the file was changed' }, fingerprint: null })).state).toBe(
      'not_unlocked'
    );
  });

  it('never says "same" for an unlocked file that failed the signed commitment', () => {
    const r = compareWithHead(H1, open({ plaintextCheck: { ok: false, detail: 'does not match' }, fingerprint: H1 }));
    expect(r.state).toBe('not_unlocked');
  });

  it('bad input never throws', () => {
    expect(compareWithHead('nothex', open()).state).toBe('not_unlocked');
    expect(compareWithHead(H1, null).state).toBe('not_unlocked');
    expect(compareWithHead(H1, {}).state).toBe('not_unlocked');
  });
});

describe('compareWithOlder', () => {
  const FAST = 100000;
  const encode = (t) => new TextEncoder().encode(t);

  // A document with real locked files. passwords[i] locks version i+1.
  async function makeDoc(texts, passwords) {
    const owner = await createIdentity('Registry');
    const serverKey = await createServerKey();
    const locks = [];
    const versions = [];
    for (let i = 0; i < texts.length; i++) {
      const lock = await lockFile({ data: encode(texts[i]), name: `v${i + 1}.txt`, password: passwords[i], iterations: FAST });
      locks.push(lock);
      versions.push({
        mutate: (record) => {
          record.blob = { hash: lock.blobHash, size: lock.size, suite: 1 };
          record.commitment = lock.commitment;
        }
      });
    }
    const parts = await buildBundleParts({ owner, serverKey, versions });
    const blobs = new Map(locks.map((l) => [l.blobHash, l.bytes]));
    const deps = {
      getBlob: async (hash) => {
        if (!blobs.has(hash)) throw new Error('not found');
        return blobs.get(hash).slice();
      },
      unlock: ({ bytes, password }) => unlockFile(bytes, password),
      verifyBlob: verifyBlobBytes,
      verifyPlaintext
    };
    return { parts, deps, locks, blobs, records: parts.bundle.records };
  }

  it('finds the older version the file equals, and stops there', async () => {
    const d = await makeDoc(['first text', 'second text', 'third text'], [PW, PW, PW]);
    const seen = [];
    const out = await compareWithOlder({
      localHash: d.locks[0].fileHash,
      records: d.records,
      password: PW,
      deps: d.deps,
      onVersion: (e) => seen.push(e.version)
    });
    expect(out.match).toMatchObject({ version: 1, state: 'same' });
    expect(out.results.map((r) => [r.version, r.state])).toEqual([
      [2, 'different'],
      [1, 'same']
    ]);
    expect(seen).toEqual([2, 1]);
    expect(describeOlderComparison(out)).toContain('identical to version 1');
    expect(describeOlderComparison(out)).toContain('not the latest');
  });

  it('says nothing is proven when no older version equals the file', async () => {
    const d = await makeDoc(['first text', 'second text', 'third text'], [PW, PW, PW]);
    const local = await sha256Hex(encode('something else'));
    const out = await compareWithOlder({ localHash: local, records: d.records, password: PW, deps: d.deps });
    expect(out.match).toBe(null);
    expect(out.results.every((r) => r.state === 'different')).toBe(true);
    const text = describeOlderComparison(out);
    expect(text).toContain('not identical to 2 older versions');
    expect(text).not.toContain('is identical to version');
  });

  it('versions that need another password are "unreadable", and the wording admits it', async () => {
    const d = await makeDoc(['first text', 'second text', 'third text'], ['QQQQ-WWWW-EEEE-RRRR-TTTT', PW, PW]);
    const local = d.locks[0].fileHash; // equals version 1, which cannot be unlocked with PW
    const out = await compareWithOlder({ localHash: local, records: d.records, password: PW, deps: d.deps });
    expect(out.match).toBe(null);
    const v1 = out.results.find((r) => r.version === 1);
    expect(v1.state).toBe('unreadable');
    expect(describeOlderComparison(out)).toContain('might still match');
  });

  it('a stored file that does not match its signed hash is unreadable, never "same"', async () => {
    const d = await makeDoc(['first text', 'second text'], [PW, PW]);
    const damaged = d.locks[0].bytes.slice();
    damaged[damaged.length - 5] ^= 1;
    d.blobs.set(d.locks[0].blobHash, damaged);
    const out = await compareWithOlder({ localHash: d.locks[0].fileHash, records: d.records, password: PW, deps: d.deps });
    expect(out.match).toBe(null);
    expect(out.results[0].state).toBe('unreadable');
  });

  it('a download failure is reported for that version only', async () => {
    const d = await makeDoc(['one', 'two', 'three'], [PW, PW, PW]);
    d.blobs.delete(d.locks[1].blobHash);
    const out = await compareWithOlder({ localHash: d.locks[0].fileHash, records: d.records, password: PW, deps: d.deps });
    expect(out.results.map((r) => [r.version, r.state])).toEqual([
      [2, 'unreadable'],
      [1, 'same']
    ]);
  });

  it('can be stopped, and a one version document has nothing older', async () => {
    const d = await makeDoc(['one', 'two', 'three'], [PW, PW, PW]);
    let calls = 0;
    const out = await compareWithOlder({
      localHash: 'f'.repeat(64),
      records: d.records,
      password: PW,
      deps: d.deps,
      shouldStop: () => ++calls > 1
    });
    expect(out.stopped).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(describeOlderComparison(out)).toContain('stopped');

    const single = await makeDoc(['only'], [PW]);
    const none = await compareWithOlder({ localHash: 'f'.repeat(64), records: single.records, password: PW, deps: single.deps });
    expect(none.total).toBe(0);
    expect(describeOlderComparison(none)).toContain('no older versions');
  });

  it('end to end with a verified bundle: head is different, an older one is the same', async () => {
    const d = await makeDoc(['original wording', 'amended wording'], [PW, PW]);
    const verification = await verifyDocumentBundle(d.parts.bundle, { pinnedServerKeyId: d.parts.serverKey.keyId });
    expect(verification.ok).toBe(true);
    const headUnlocked = await unlockFile(d.locks[1].bytes, PW);
    const open = {
      bundle: d.parts.bundle,
      verification,
      blobCheck: await verifyBlobBytes(d.locks[1].bytes, d.parts.versions[1].record),
      plaintextCheck: await verifyPlaintext(headUnlocked, d.parts.versions[1].record),
      fingerprint: headUnlocked.fileHash
    };
    const local = await sha256Hex(encode('original wording'));
    const head = compareWithHead(local, open);
    expect(head.state).toBe('different');
    const older = await compareWithOlder({ localHash: local, records: d.records, password: PW, deps: d.deps });
    expect(older.match.version).toBe(1);
    const same = compareWithHead(await sha256Hex(encode('amended wording')), open);
    expect(same.state).toBe('same');
  });

  it('describeOlderComparison tolerates nothing', () => {
    expect(describeOlderComparison(null)).toBe('');
  });
});
