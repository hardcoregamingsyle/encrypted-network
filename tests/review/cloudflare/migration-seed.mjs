// Review r5 helper (not a vitest file). Writes SQL that fills a database made by migrations 0001 and 0002
// with realistic shaped rows (identities, documents, records, ledger, channels with messages, blobs,
// rate limits). Usage: node tests/review/cloudflare/migration-seed.mjs <out.sql> [scale]
import { writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const out = process.argv[2];
const scale = Number(process.argv[3] || 1);
if (!out) throw new Error('usage: migration-seed.mjs <out.sql> [scale]');
const hex = (s) => createHash('sha256').update(String(s)).digest('hex');
const q = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
const lines = [];
const ins = (table, cols, vals) => lines.push(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.map(q).join(',')});`);
const T0 = 1760000000000;

const N_ID = 120 * scale, N_DOC = 300 * scale, N_CH = 60 * scale, N_MSG = 4000 * scale, N_BLOB = 300 * scale;
const ids = [];
for (let i = 0; i < N_ID; i++) {
  const keyId = hex('key' + i);
  ids.push(keyId);
  const pub = JSON.stringify({ crv: 'P-256', kty: 'EC', x: randomBytes(32).toString('base64url'), y: randomBytes(32).toString('base64url') });
  ins('identities', ['key_id', 'public_jwk', 'display_name', 'created_at', 'record', 'signature'], [keyId, pub, 'Person ' + i, T0 + i, JSON.stringify({ v: 2, type: 'identity', publicKey: pub, displayName: 'Person ' + i, createdAt: T0 + i }), randomBytes(64).toString('base64url')]);
}
for (let i = 0; i < N_BLOB; i++) {
  ins('blobs', ['hash', 'size', 'uploader', 'created_at', 'pending'], [hex('blob' + i), 5000 + i * 37, ids[i % ids.length], T0 + i, 0]);
}
let seq = 0, prev = '0'.repeat(64);
for (let d = 0; d < N_DOC; d++) {
  const docId = hex('doc' + d).slice(0, 32);
  const owner = ids[d % ids.length];
  const versions = 1 + (d % 4);
  let head = '';
  for (let v = 1; v <= versions; v++) {
    seq++;
    const rh = hex('rec' + d + ':' + v);
    head = rh;
    ins('ledger', ['record_hash', 'prev_ledger_hash', 'ledger_hash', 'created_at'], [rh, prev, hex('led' + seq), T0 + seq]);
    prev = hex('led' + seq);
    ins('records', ['record_hash', 'doc_id', 'version', 'type', 'signer', 'body', 'signature', 'ledger_seq', 'created_at'], [rh, docId, v, v === 1 ? 'doc.create' : 'doc.update', owner, JSON.stringify({ v: 2, type: 'doc.update', docId, version: v, label: 'Document ' + d, pad: 'x'.repeat(600) }), randomBytes(64).toString('base64url'), seq, T0 + seq]);
  }
  ins('documents', ['doc_id', 'owner_key_id', 'status', 'listed', 'head_version', 'head_record_hash', 'label', 'created_at', 'updated_at'], [docId, owner, d % 17 === 0 ? 'revoked' : 'active', d % 5 === 0 ? 0 : 1, versions, head, 'Document ' + d, T0 + d, T0 + d * 3]);
}
const perCh = Math.floor(N_MSG / N_CH);
for (let c = 0; c < N_CH; c++) {
  const chId = 'room-' + c + '-' + hex('ch' + c).slice(0, 8);
  ins('channels', ['channel_id', 'title', 'doc_id', 'created_by', 'created_at', 'record', 'signature'], [chId, 'Room ' + c, c % 3 === 0 ? hex('doc' + c).slice(0, 32) : '', ids[c % ids.length], T0 + c * 10, JSON.stringify({ v: 2, type: 'channel.create', title: 'Room ' + c }), randomBytes(64).toString('base64url')]);
  let chain = '0'.repeat(64);
  for (let s = 1; s <= perCh; s++) {
    const h = hex('m' + c + ':' + s), nc = hex('c' + c + ':' + s);
    ins('messages', ['hash', 'channel_id', 'seq', 'signer', 'body', 'signature', 'prev_chain_hash', 'chain_hash', 'created_at'], [h, chId, s, ids[(c + s) % ids.length], JSON.stringify({ v: 2, type: 'message', body: 'Hello number ' + s + ' in room ' + c, replyTo: '' }), randomBytes(64).toString('base64url'), chain, nc, T0 + c * 10 + s]);
    chain = nc;
  }
}
for (let i = 0; i < 2000 * scale; i++) ins('rate_limits', ['bucket', '"window"', 'count'], ['msg:' + ids[i % ids.length] + ':' + i, T0 + i * 60000, 1 + (i % 7)]);
ins('blocked_blobs', ['hash', 'reason', 'created_at'], [hex('bad'), 'operator takedown', T0]);
// the 0002 migration filled received_at, message_count and last_message_at for old channels; a live
// database that kept running on 0002 has these set by the app, so set them like the app would.
lines.push('UPDATE channels SET received_at = created_at + 1, message_count = (SELECT COUNT(*) FROM messages m WHERE m.channel_id = channels.channel_id), last_message_at = (SELECT MAX(created_at) FROM messages m WHERE m.channel_id = channels.channel_id);');
writeFileSync(out, lines.join('\n') + '\n');
console.log('statements', lines.length, 'identities', N_ID, 'documents', N_DOC, 'channels', N_CH, 'messages', perCh * N_CH, 'blobs', N_BLOB);
