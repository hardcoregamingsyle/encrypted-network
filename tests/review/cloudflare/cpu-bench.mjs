// Review helper. Estimates the CPU the ledger and bundle routes spend in JavaScript (not in D1).
import { canonicalize } from '../../../shared/canonical.js';
import { signCheckpoint, makeCheckpointPayload } from '../../../shared/checkpoint.js';
import { exportPublicJwk, generateKeyPair, keyIdOf, signRecord, verifyRecord } from '../../../shared/keys.js';
import { chainHash, recordHash } from '../../../shared/records.js';
import { sha256Hex } from '../../../shared/hash.js';

const BASE = process.argv[2] || 'http://127.0.0.1:8793';
const page = await (await fetch(BASE + '/api/ledger?limit=200')).json();
console.log('entries', page.entries.length, 'identities', Object.keys(page.identities).length);

// rows as D1 would hand them to the handler
const rows = page.entries.map((e) => ({ seq: e.seq, record_hash: e.recordHash, prev_ledger_hash: e.prevLedgerHash, ledger_hash: e.ledgerHash, body: canonicalize(e.record), signature: e.signature }));
const idRows = Object.values(page.identities).map((i) => ({ key_id: i.keyId, public_jwk: JSON.stringify(i.publicKey), display_name: i.displayName, created_at: i.createdAt, record: JSON.stringify(i.record), signature: i.signature }));

function handler() {
  const entries = rows.map((r) => ({ seq: r.seq, recordHash: r.record_hash, prevLedgerHash: r.prev_ledger_hash, ledgerHash: r.ledger_hash, record: JSON.parse(r.body), signature: r.signature }));
  const ids = {};
  for (const r of idRows) ids[r.key_id] = { keyId: r.key_id, publicKey: JSON.parse(r.public_jwk), displayName: r.display_name, createdAt: r.created_at, record: JSON.parse(r.record), signature: r.signature };
  return JSON.stringify({ entries, identities: ids, checkpoint: null, server: null, hasMore: false });
}
function time(label, fn, n = 30) {
  for (let i = 0; i < 5; i++) fn();
  const ts = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); fn(); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  console.log(label.padEnd(46), 'median', ts[Math.floor(n / 2)].toFixed(2), 'ms  p90', ts[Math.floor(n * 0.9)].toFixed(2), 'ms  max', ts[n - 1].toFixed(2));
}
time('ledger limit=200 (the maximum) parse+shape+stringify (JS only)', handler);
rows.length = Math.min(rows.length, 100);
time('ledger limit=100', handler);

// crypto costs
const { publicKey, privateKey } = await generateKeyPair({ extractable: false });
const jwk = await exportPublicJwk(publicKey);
const rec = { v: 2, type: 'message', channelId: 'abc', body: 'x'.repeat(2000), replyTo: '', signer: await keyIdOf(jwk), createdAt: Date.now(), nonce: 'a'.repeat(32) };
const sig = await signRecord(privateKey, rec);
async function atime(label, fn, n = 100) {
  for (let i = 0; i < 10; i++) await fn();
  const ts = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  console.log(label.padEnd(46), 'median', ts[n >> 1].toFixed(3), 'ms  p90', ts[Math.floor(n * 0.9)].toFixed(3), 'ms');
}
await atime('verifyRecord (2000 char message)', () => verifyRecord(jwk, rec, sig));
await atime('signCheckpoint', async () => signCheckpoint(privateKey, makeCheckpointPayload({ scope: 'ledger', seq: 5, hash: 'a'.repeat(64), signedAt: Date.now(), serverKeyId: 'b'.repeat(64) })));
await atime('recordHash + chainHash', async () => chainHash('0'.repeat(64), await recordHash(rec)));
const big = { ...rec, body: 'y'.repeat(2000) };
await atime('canonicalize+sha256 of 2k record', () => sha256Hex(canonicalize(big)));
