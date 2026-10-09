// Adversarial review of verifyDocumentBundle.
import { describe, expect, it } from 'vitest';
import { verifyDocumentBundle } from '../../../shared/verify.js';
import { signCheckpoint, makeCheckpointPayload } from '../../../shared/checkpoint.js';
import {
  buildBundle,
  buildBundleParts,
  buildLedger,
  clone,
  createIdentity,
  createServerKey,
  identityEntry,
  ledgerCheckpoint,
  serverInfo
} from '../../helpers/bundle.js';
import { DELETE, getAt, leafPaths, pathText, replacements, withChange } from './fuzz.js';

const opts = (serverKey, extra = {}) => ({ pinnedServerKeyId: serverKey.keyId, ...extra });

describe('FINDING: a checkpoint is not bound to the document records', () => {
  it('a forged document that the server never saw must not verify under the pinned server key', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    // The real registry has 9 documents, so the real ledger head is at seq 9.
    const ledger = buildLedger();
    for (let i = 0; i < 9; i++) await buildBundleParts({ owner: alice, serverKey: server, ledger });
    const realCheckpoint = await ledgerCheckpoint(server, ledger);

    // Mallory writes a whole bundle by herself. She never talked to the server.
    const mallory = await createIdentity('Ministry of Health');
    const forged = await buildBundle({ owner: mallory, serverKey: null, versions: [{ label: 'Official order 7' }] });
    // She copies any genuine checkpoint and the genuine server key into it.
    forged.checkpoint = clone(realCheckpoint);
    forged.server = serverInfo(server);

    const result = await verifyDocumentBundle(forged, opts(server));
    expect(result.ok, 'forged bundle passed: ' + JSON.stringify(result.checks.filter((c) => !c.ok))).toBe(false);
  });

  it('a forged update that the server never saw must not verify', async () => {
    // The owner key is real, but the bundle claims a version the server never recorded.
    // Needs the owner key, so this is the "key leaked or owner lies about the registry" case.
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const ledger = buildLedger();
    for (let i = 0; i < 5; i++) await buildBundleParts({ owner: alice, serverKey: server, ledger });
    const cp = await ledgerCheckpoint(server, ledger);
    const own = await buildBundle({ owner: alice, serverKey: null, versions: [{}, {}, {}] });
    own.checkpoint = clone(cp);
    own.server = serverInfo(server);
    const result = await verifyDocumentBundle(own, opts(server));
    expect(result.ok).toBe(false);
  });
});

describe('FINDING: document summary without docId passes', () => {
  it('a summary with no docId is rejected', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const bundle = await buildBundle({ owner: alice, serverKey: server, versions: [{}, {}] });
    delete bundle.document.docId;
    const result = await verifyDocumentBundle(bundle, opts(server));
    expect(result.ok).toBe(false);
  });
});

describe('FINDING: no way to refuse an old checkpoint', () => {
  it('maxCheckpointAgeMs makes an old bundle fail', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const yearAgo = Date.now() - 365 * 24 * 3600 * 1000;
    const bundle = await buildBundle({ owner: alice, serverKey: server, now: yearAgo, versions: [{}, {}] });
    const plain = await verifyDocumentBundle(bundle, opts(server));
    // Today: ok true, only a warning. A caller who needs "latest" has no switch.
    expect(plain.ok).toBe(true);
    const strict = await verifyDocumentBundle(bundle, opts(server, { maxCheckpointAgeMs: 60 * 60 * 1000 }));
    expect(strict.ok).toBe(false);
  });
});

describe('FINDING: pin is silently ignored when it is not a string', () => {
  it.each([[12345], [true], [['x']], [{}]])('a malformed pin %j must not turn into "not pinned"', async (pin) => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const bundle = await buildBundle({ owner: alice, serverKey: server, versions: [{}] });
    const result = await verifyDocumentBundle(bundle, { pinnedServerKeyId: pin });
    expect(result.ok).toBe(false);
  });

  it('pinned key given in a non plain options object is not ignored', async () => {
    class Opts {
      constructor(pin) {
        this.pinnedServerKeyId = pin;
      }
    }
    const server = await createServerKey();
    const other = await createServerKey();
    const alice = await createIdentity('Alice');
    const bundle = await buildBundle({ owner: alice, serverKey: server, versions: [{}] });
    const result = await verifyDocumentBundle(bundle, new Opts(other.keyId));
    expect(result.ok).toBe(false);
  });
});

describe('held up: forgery attempts from the review brief', () => {
  it('blob hash swapped without re-signing', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}, {}] });
    b.records[1].record.blob.hash = b.records[0].record.blob.hash;
    expect((await verifyDocumentBundle(b, opts(server))).ok).toBe(false);
  });

  it('newest version dropped while the summary still claims it', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}, {}, {}] });
    b.records.pop();
    expect((await verifyDocumentBundle(b, opts(server))).ok).toBe(false);
  });

  it('signature of version 1 pasted on version 2', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}, {}] });
    b.records[1].signature = b.records[0].signature;
    expect((await verifyDocumentBundle(b, opts(server))).ok).toBe(false);
  });

  it('identity entry of the owner replaced by an attacker key under the same key id', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const mallory = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}] });
    b.identities[alice.keyId] = { ...identityEntry(mallory), keyId: alice.keyId };
    expect((await verifyDocumentBundle(b, opts(server))).ok).toBe(false);
  });

  it('whole bundle re-signed by an attacker identity but owner summary left alone', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const mallory = await createIdentity('Mallory');
    const b = await buildBundle({ owner: mallory, serverKey: server, versions: [{}] });
    b.document.ownerKeyId = alice.keyId;
    expect((await verifyDocumentBundle(b, opts(server))).ok).toBe(false);
  });

  it('checkpoint from a channel scope used as ledger scope', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}] });
    const payload = makeCheckpointPayload({
      scope: 'channel:general',
      seq: b.checkpoint.payload.seq,
      hash: b.checkpoint.payload.hash,
      signedAt: b.checkpoint.payload.signedAt,
      serverKeyId: server.keyId
    });
    b.checkpoint = await signCheckpoint(server.privateKey, payload);
    const r = await verifyDocumentBundle(b, opts(server));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'checkpoint').ok).toBe(false);
  });

  it('stale checkpoint with lower seq than the records', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const parts = await buildBundleParts({ owner: alice, serverKey: server, versions: [{}, {}] });
    const older = buildLedger();
    older.entries.push(parts.ledger.entries[0]);
    parts.bundle.checkpoint = await ledgerCheckpoint(server, older);
    expect((await verifyDocumentBundle(parts.bundle, opts(server))).ok).toBe(false);
  });

  it('checkpoint with the right seq but the hash of another ledger', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}, {}] });
    const other = buildLedger();
    for (let i = 0; i < b.records[1].ledgerSeq; i++) other.entries.push({ seq: i + 1, ledgerHash: 'f'.repeat(64) });
    b.checkpoint = await ledgerCheckpoint(server, other);
    expect((await verifyDocumentBundle(b, opts(server))).ok).toBe(false);
  });

  it('checkpoint presented by another server, pinned to the real one', async () => {
    const server = await createServerKey();
    const evil = await createServerKey();
    const alice = await createIdentity('Alice');
    const parts = await buildBundleParts({ owner: alice, serverKey: evil, versions: [{}] });
    expect((await verifyDocumentBundle(parts.bundle, opts(server))).ok).toBe(false);
    expect((await verifyDocumentBundle(parts.bundle, {})).ok).toBe(true); // by design, with a warning
  });

  it('empty records array and empty bundle', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}] });
    b.records = [];
    const r = await verifyDocumentBundle(b, opts(server));
    expect(r.ok).toBe(false);
    expect(r.head).toBe(null);
  });

  it('duplicate versions and reordered versions', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}, {}, {}] });
    const dup = clone(b);
    dup.records.push(clone(dup.records[2]));
    expect((await verifyDocumentBundle(dup, opts(server))).ok).toBe(false);
    const swapped = clone(b);
    [swapped.records[1], swapped.records[2]] = [swapped.records[2], swapped.records[1]];
    expect((await verifyDocumentBundle(swapped, opts(server))).ok).toBe(false);
  });

  it('ledger entries re-pointed to another record of the same bundle', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}, {}] });
    const copy = clone(b);
    copy.records[1].ledgerHash = copy.records[0].ledgerHash;
    expect((await verifyDocumentBundle(copy, opts(server))).ok).toBe(false);
    const copy2 = clone(b);
    [copy2.records[0].ledgerHash, copy2.records[1].ledgerHash] = [copy2.records[1].ledgerHash, copy2.records[0].ledgerHash];
    expect((await verifyDocumentBundle(copy2, opts(server))).ok).toBe(false);
  });

  it('createdAt going backwards, signed correctly', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const now = Date.now();
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{ createdAt: now }, { createdAt: now - 1 }] });
    const r = await verifyDocumentBundle(b, opts(server));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'no_post_revoke').ok).toBe(false);
  });

  it('first record is an update (version 1 with type doc.update) is invalid', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({
      owner: alice,
      serverKey: server,
      versions: [{ mutate: (r) => { r.type = 'doc.update'; delete r.listed; } }]
    });
    expect((await verifyDocumentBundle(b, opts(server))).ok).toBe(false);
  });

  it('a failed bundle never exposes a head', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}, {}] });
    b.records[1].record.label = 'changed';
    const r = await verifyDocumentBundle(b, opts(server));
    expect(r.ok).toBe(false);
    expect(r.head).toBe(null);
    expect(r.status).toBe('invalid');
  });

  it('JSON text with __proto__ and constructor keys cannot smuggle data', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}] });
    const text = JSON.stringify(b).replace('"identities":{', '"identities":{"__proto__":{"x":1},"constructor":{},');
    const r = await verifyDocumentBundle(JSON.parse(text), opts(server));
    expect(r.ok).toBe(false);
    expect(({}).x).toBeUndefined();
  });

  it('same bundle verifies the same twice and does not leak state between calls', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}, {}] });
    const a1 = await verifyDocumentBundle(b, opts(server));
    const bad = clone(b);
    bad.records[0].record.label = 'x';
    await verifyDocumentBundle(bad, opts(server));
    const a2 = await verifyDocumentBundle(b, opts(server));
    expect(a2.ok).toBe(true);
    expect(a2.head).toEqual(a1.head);
  });

  it('records with uppercase signer or uppercase keyId map keys are rejected', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const b = await buildBundle({ owner: alice, serverKey: server, versions: [{}] });
    const up = clone(b);
    up.records[0].record.signer = alice.keyId.toUpperCase();
    expect((await verifyDocumentBundle(up, opts(server))).ok).toBe(false);
    const up2 = clone(b);
    up2.identities = { [alice.keyId.toUpperCase()]: up2.identities[alice.keyId] };
    expect((await verifyDocumentBundle(up2, opts(server))).ok).toBe(false);
  });
});

describe('mutation fuzz: any change to a verified bundle must fail or leave the verified head unchanged', () => {
  // Unsigned display fields that the verifier is allowed to ignore.
  const ALLOWED_IGNORED = [
    /^document\.(listed|createdAt|updatedAt)$/,
    /^document\.docId$/, // deletion is a reported finding on its own (see above)
    /^server\.keyId$/,
    /^identities\.[0-9a-f]{64}\.(publicKey\..*|displayName|createdAt)$/ // optional duplicates of the signed record
  ];

  it('document bundle', async () => {
    const server = await createServerKey();
    const alice = await createIdentity('Alice');
    const bundle = await buildBundle({ owner: alice, serverKey: server, versions: [{}, {}, { label: 'third' }] });
    const base = await verifyDocumentBundle(bundle, opts(server));
    expect(base.ok).toBe(true);
    const surprising = [];
    for (const path of leafPaths(bundle)) {
      const original = getAt(bundle, path);
      for (const rep of replacements(original)) {
        const mutated = withChange(bundle, path, rep);
        const r = await verifyDocumentBundle(mutated, opts(server));
        if (!r.ok) continue;
        const label = pathText(path) + (rep === DELETE ? ' (deleted)' : ' -> ' + JSON.stringify(rep));
        const sameHead = JSON.stringify(r.head) === JSON.stringify(base.head) && r.status === base.status;
        const allowed = ALLOWED_IGNORED.some((re) => re.test(pathText(path)));
        if (!sameHead) surprising.push('HEAD CHANGED: ' + label);
        else if (!allowed) surprising.push('ignored: ' + label);
      }
    }
    expect(surprising).toEqual([]);
  }, 120000);
});
