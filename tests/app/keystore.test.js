import { beforeEach, describe, expect, it } from 'vitest';
import { verifyRecord } from '../../shared/keys.js';
import { validateRecord } from '../../shared/records.js';
import {
  BACKUP_KIND,
  buildBackup,
  createIdentity,
  createMemoryAdapter,
  displayNameError,
  exportBackup,
  forgetIdentity,
  loadIdentity,
  openBackup,
  passphraseStrength,
  restoreIdentity,
  setStorageAdapter
} from '../../src/lib/keystore.js';

const FAST = 100000;
const PASS = 'correct horse battery';

let adapter;
beforeEach(() => {
  adapter = createMemoryAdapter();
  setStorageAdapter(adapter);
});

function mutateBackup(text, change) {
  const file = JSON.parse(text);
  change(file);
  return JSON.stringify(file);
}

function flipChar(s, index) {
  const chars = s.split('');
  chars[index] = chars[index] === 'A' ? 'B' : 'A';
  return chars.join('');
}

describe('createIdentity and loadIdentity', () => {
  it('creates an identity, stores it and loads it back', async () => {
    const { identity, backupText, backupName } = await createIdentity({
      displayName: 'Asha Rao',
      passphrase: PASS,
      iterations: FAST
    });
    expect(identity.displayName).toBe('Asha Rao');
    expect(identity.keyId).toMatch(/^[0-9a-f]{64}$/);
    expect(backupName).toBe(`hrdlock-key-${identity.keyId.slice(0, 8)}.hrdkey`);
    expect(JSON.parse(backupText).kind).toBe(BACKUP_KIND);

    const loaded = await loadIdentity();
    expect(loaded.keyId).toBe(identity.keyId);
    expect(loaded.displayName).toBe('Asha Rao');
    expect(loaded.publicKey).toEqual(identity.publicKey);
    expect(loaded.createdAt).toBe(identity.createdAt);
  });

  it('makes a valid self signed identity record', async () => {
    const { identity } = await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    expect(validateRecord(identity.record)).toEqual({ ok: true });
    expect(identity.record.type).toBe('identity');
    expect(await verifyRecord(identity.publicKey, identity.record, identity.signature)).toBe(true);
  });

  it('signs records that verify with the public key', async () => {
    const { identity } = await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    const record = { v: 2, type: 'blob.put', hash: 'a'.repeat(64), size: 10, signer: identity.keyId, createdAt: 5 };
    const sig = await identity.sign(record);
    expect(await verifyRecord(identity.publicKey, record, sig)).toBe(true);
    expect(await verifyRecord(identity.publicKey, { ...record, size: 11 }, sig)).toBe(false);
  });

  it('stores the private key as a non extractable key', async () => {
    await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    const stored = await adapter.get('identity');
    expect(stored.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('jwk', stored.privateKey)).rejects.toThrow();
  });

  it('works with the default 600000 rounds', async () => {
    const { identity, backupText } = await createIdentity({ displayName: 'Default Rounds', passphrase: PASS });
    expect(JSON.parse(backupText).kdf.iterations).toBe(600000);
    const restored = await openBackup(backupText, PASS);
    expect(restored.keyId).toBe(identity.keyId);
  }, 30000);

  it('trims and normalises the display name', async () => {
    const { identity } = await createIdentity({ displayName: '  Zoé  ', passphrase: PASS, iterations: FAST });
    expect(identity.displayName).toBe('Zoé');
  });

  it('rejects a bad display name and stores nothing', async () => {
    for (const name of ['', '   ', 'x'.repeat(41), 'a​b', 'tab\tname']) {
      await expect(createIdentity({ displayName: name, passphrase: PASS, iterations: FAST })).rejects.toThrow();
    }
    expect(await loadIdentity()).toBe(null);
  });

  it('rejects a short or missing passphrase', async () => {
    await expect(createIdentity({ displayName: 'A', passphrase: 'short', iterations: FAST })).rejects.toThrow(/at least 10/);
    await expect(createIdentity({ displayName: 'A', iterations: FAST })).rejects.toThrow();
    await expect(createIdentity({ displayName: 'A', passphrase: 123456789012, iterations: FAST })).rejects.toThrow();
    expect(await loadIdentity()).toBe(null);
  });

  it('loadIdentity gives null when nothing is stored or the entry is damaged', async () => {
    expect(await loadIdentity()).toBe(null);
    await adapter.set('identity', { keyId: 'abc' });
    expect(await loadIdentity()).toBe(null);
    await adapter.set('identity', 'nonsense');
    expect(await loadIdentity()).toBe(null);
  });

  it('forgetIdentity removes the identity', async () => {
    await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    await forgetIdentity();
    expect(await loadIdentity()).toBe(null);
    await expect(forgetIdentity()).resolves.toBeUndefined();
  });
});

describe('backup and restore', () => {
  it('round trips: restore on an empty store gives the same identity', async () => {
    const made = await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    await forgetIdentity();
    expect(await loadIdentity()).toBe(null);

    const restored = await restoreIdentity(made.backupText, PASS);
    expect(restored.keyId).toBe(made.identity.keyId);
    expect(restored.displayName).toBe('Asha Rao');
    expect(restored.createdAt).toBe(made.identity.createdAt);
    expect(restored.signature).toBe(made.identity.signature);

    const loaded = await loadIdentity();
    expect(loaded.keyId).toBe(made.identity.keyId);
    const record = { v: 2, type: 'blob.put', hash: 'b'.repeat(64), size: 3, signer: loaded.keyId, createdAt: 9 };
    expect(await verifyRecord(made.identity.publicKey, record, await loaded.sign(record))).toBe(true);
    expect((await adapter.get('identity')).privateKey.extractable).toBe(false);
  });

  it('fails with a wrong passphrase and stores nothing', async () => {
    const made = await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    await forgetIdentity();
    await expect(restoreIdentity(made.backupText, 'not the passphrase')).rejects.toThrow(
      'wrong passphrase, or the backup file was changed'
    );
    await expect(restoreIdentity(made.backupText, '')).rejects.toThrow('wrong passphrase');
    expect(await loadIdentity()).toBe(null);
  });

  it('fails when the encrypted data is changed', async () => {
    const made = await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    const bad = mutateBackup(made.backupText, (f) => {
      f.data = flipChar(f.data, 20);
    });
    await expect(openBackup(bad, PASS)).rejects.toThrow('wrong passphrase, or the backup file was changed');
  });

  it('fails when the key id, salt, iv or iterations are changed', async () => {
    const made = await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    const other = 'f'.repeat(64);
    const cases = [
      (f) => {
        f.keyId = other;
      },
      (f) => {
        f.kdf.salt = flipChar(f.kdf.salt, 3);
      },
      (f) => {
        f.iv = flipChar(f.iv, 3);
      },
      (f) => {
        f.kdf.iterations = FAST + 1;
      }
    ];
    for (const change of cases) {
      await expect(openBackup(mutateBackup(made.backupText, change), PASS)).rejects.toThrow(/wrong passphrase/);
    }
  });

  it('rejects files that are not key backups', async () => {
    const made = await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    const msg = 'this is not a hrdlock key backup file';
    const cases = [
      '',
      'not json',
      '[]',
      'null',
      '{}',
      JSON.stringify({ hello: 'world' }),
      mutateBackup(made.backupText, (f) => {
        f.kind = 'something-else';
      }),
      mutateBackup(made.backupText, (f) => {
        f.v = 1;
      }),
      mutateBackup(made.backupText, (f) => {
        f.keyId = 'xyz';
      }),
      mutateBackup(made.backupText, (f) => {
        delete f.kdf;
      }),
      mutateBackup(made.backupText, (f) => {
        f.kdf.iterations = 5;
      }),
      mutateBackup(made.backupText, (f) => {
        f.kdf.iterations = 2000001;
      }),
      mutateBackup(made.backupText, (f) => {
        f.kdf.iterations = 'many';
      }),
      mutateBackup(made.backupText, (f) => {
        f.kdf.name = 'scrypt';
      }),
      mutateBackup(made.backupText, (f) => {
        f.kdf.salt = 'AAAA';
      }),
      mutateBackup(made.backupText, (f) => {
        f.iv = 'AAAA';
      }),
      mutateBackup(made.backupText, (f) => {
        f.data = '';
      }),
      mutateBackup(made.backupText, (f) => {
        f.data = '!!!not base64!!!';
      }),
      'x'.repeat(70000)
    ];
    for (const text of cases) {
      await expect(openBackup(text, PASS)).rejects.toThrow(msg);
    }
    await expect(openBackup(undefined, PASS)).rejects.toThrow(msg);
    await expect(openBackup(42, PASS)).rejects.toThrow(msg);
  });

  it('rejects a correctly encrypted backup whose content is inconsistent', async () => {
    const made = await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    const other = await createIdentity({ displayName: 'Other Person', passphrase: PASS, iterations: FAST });
    const good = await openBackup(made.backupText, PASS);
    const { keyId, ...payload } = good;

    const brokenPayloads = [
      { ...payload, displayName: 'Someone Else' },
      { ...payload, createdAt: payload.createdAt + 1 },
      { ...payload, signature: other.identity.signature },
      { ...payload, record: { ...payload.record, displayName: 'Forged' }, displayName: 'Forged' },
      { ...payload, privateJwk: { ...payload.privateJwk, d: 'A'.repeat(43) } },
      { ...payload, privateJwk: { kty: 'EC' } },
      { ...payload, publicKey: other.identity.publicKey }
    ];
    for (const broken of brokenPayloads) {
      const text = await buildBackup(keyId, broken, PASS, { iterations: FAST });
      await expect(openBackup(text, PASS)).rejects.toThrow('the backup content is damaged');
    }
    // a backup filed under the wrong key id is also refused
    const wrongId = await buildBackup(other.identity.keyId, payload, PASS, { iterations: FAST });
    await expect(openBackup(wrongId, PASS)).rejects.toThrow('the backup content is damaged');
  });

  it('exportBackup gives a fresh file that restores, and needs the right passphrase', async () => {
    const made = await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    const fresh = await exportBackup(PASS, { iterations: FAST });
    expect(fresh.backupName).toBe(made.backupName);
    expect(fresh.backupText).not.toBe(made.backupText);
    const a = JSON.parse(made.backupText);
    const b = JSON.parse(fresh.backupText);
    expect(b.kdf.salt).not.toBe(a.kdf.salt);
    expect(b.iv).not.toBe(a.iv);
    expect(b.keyId).toBe(a.keyId);

    await forgetIdentity();
    const restored = await restoreIdentity(fresh.backupText, PASS);
    expect(restored.keyId).toBe(made.identity.keyId);

    await expect(exportBackup('wrong passphrase here')).rejects.toThrow('wrong passphrase');
  });

  it('exportBackup fails when there is no identity', async () => {
    await expect(exportBackup(PASS)).rejects.toThrow('no identity');
  });

  it('a backup does not contain the private key in plain text', async () => {
    const made = await createIdentity({ displayName: 'Asha Rao', passphrase: PASS, iterations: FAST });
    const opened = await openBackup(made.backupText, PASS);
    expect(made.backupText).not.toContain(opened.privateJwk.d);
    expect(made.backupText).not.toContain('Asha Rao');
  });

  it('normalises the passphrase so equivalent unicode forms match', async () => {
    const composed = 'paéssword-long';
    const decomposed = 'paéssword-long';
    const made = await createIdentity({ displayName: 'Uni', passphrase: composed, iterations: FAST });
    const opened = await openBackup(made.backupText, decomposed);
    expect(opened.keyId).toBe(made.identity.keyId);
  });
});

describe('passphraseStrength', () => {
  it('rates empty, short and repetitive passphrases as not usable', () => {
    expect(passphraseStrength('').ok).toBe(false);
    expect(passphraseStrength(undefined).ok).toBe(false);
    expect(passphraseStrength('short').ok).toBe(false);
    expect(passphraseStrength('short').label).toBe('Too short');
    expect(passphraseStrength('aaaaaaaaaaaaaaaa').ok).toBe(false);
  });

  it('accepts ten or more characters and rises with length and variety', () => {
    const fair = passphraseStrength('abcdefghij');
    const strong = passphraseStrength('purple tractor quietly sings 42');
    expect(fair.ok).toBe(true);
    expect(strong.ok).toBe(true);
    expect(strong.level).toBeGreaterThan(fair.level);
    expect(strong.level).toBeLessThanOrEqual(4);
  });

  it('counts characters, not UTF-16 units', () => {
    // nine emoji are 18 UTF-16 units but only nine characters
    expect(passphraseStrength('\u{1f600}'.repeat(9)).ok).toBe(false);
  });
});

describe('displayNameError', () => {
  it('accepts normal names', () => {
    expect(displayNameError('Asha Rao')).toBe('');
    expect(displayNameError('Office of Records')).toBe('');
    expect(displayNameError('x'.repeat(40))).toBe('');
  });

  it('explains what is wrong', () => {
    expect(displayNameError('')).toMatch(/Enter a display name/);
    expect(displayNameError('   ')).toMatch(/Enter a display name/);
    expect(displayNameError(null)).toMatch(/Enter a display name/);
    expect(displayNameError('x'.repeat(41))).toMatch(/^Display name must be 1 to 40 characters/);
    expect(displayNameError('a​b')).toMatch(/invisible/);
    expect(displayNameError('a\u0001b')).toMatch(/control/);
  });
});
