// Cost of the public channel list as messages grow. Works on a scratch SQLite copy of the schema, not on the server.
// node tests/review/backend/channelcost.mjs [rowsPerChannel]
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, assert, check, finish } from './_lib.mjs';
import { CHANNEL_SELECT } from '../../../functions/_lib/channels.js';

const perChannel = Number(process.argv[3] || 5000);
const db = new DatabaseSync(':memory:');
applyMigrations(db);
db.exec('BEGIN');
const insCh = db.prepare('INSERT INTO channels (channel_id, title, doc_id, created_by, created_at, received_at, record, signature, message_count, last_message_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
const insMsg = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)');
for (let c = 0; c < 200; c++) {
  const id = 'chan-' + String(c).padStart(4, '0');
  insCh.run(id, 't', '', 'k', 1000 + c, 1000 + c, '{}', 's', perChannel, 5);
  for (let i = 1; i <= perChannel; i++) insMsg.run(id + ':' + i, id, i, 's', '{}', 'sig', 'p', 'c', 5);
}
db.exec('COMMIT');

await check(`GET /api/channels does not read messages (cost does not grow with message count) (200 channels x ${perChannel} messages)`, async () => {
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + CHANNEL_SELECT + ' ORDER BY c.received_at DESC, c.channel_id DESC LIMIT 200').all().map((r) => r.detail);
  console.log('  plan: ' + plan.join(' | '));
  const t = performance.now();
  const rows = db.prepare(CHANNEL_SELECT + ' ORDER BY c.received_at DESC, c.channel_id DESC LIMIT 200').all();
  const ms = performance.now() - t;
  console.log(`  ${rows.length} channels listed in ${ms.toFixed(0)} ms on an in memory database`);
  assert(!plan.some((d) => /COUNT|COVERING INDEX sqlite_autoindex_messages/i.test(d)) , 'the list counts every message of every channel on each request (no stored counter)');
});
finish();
