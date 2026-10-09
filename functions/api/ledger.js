// GET /api/ledger?after=<seq>&limit=<1..500>: the public ledger of document records, in order.
import { ledgerHeadFromRow } from '../_lib/documents.js';
import { intParam, json, onlyMethods } from '../_lib/http.js';
import { identityMapFromRows } from '../_lib/identities.js';
import { loadServerKey, serverInfo, signScope } from '../_lib/serverKey.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const after = intParam(url, 'after', { min: 0, max: Number.MAX_SAFE_INTEGER, def: 0 });
  const limit = intParam(url, 'limit', { min: 1, max: 500, def: 200 });

  // One more row than asked for tells whether there is another page.
  const [entryRes, headRes] = await env.DB.batch([
    env.DB
      .prepare(
        'SELECT l.seq, l.record_hash, l.prev_ledger_hash, l.ledger_hash, r.body, r.signature ' +
          'FROM ledger l JOIN records r ON r.record_hash = l.record_hash WHERE l.seq > ? ORDER BY l.seq ASC LIMIT ?'
      )
      .bind(after, limit + 1),
    env.DB.prepare('SELECT seq, ledger_hash FROM ledger ORDER BY seq DESC LIMIT 1')
  ]);
  const rows = entryRes.results;
  const hasMore = rows.length > limit;
  const shown = hasMore ? rows.slice(0, limit) : rows;
  const entries = shown.map((r) => ({
    seq: r.seq,
    recordHash: r.record_hash,
    prevLedgerHash: r.prev_ledger_hash,
    ledgerHash: r.ledger_hash,
    record: JSON.parse(r.body),
    signature: r.signature
  }));

  let identities = {};
  if (entries.length > 0) {
    const lastSeq = entries[entries.length - 1].seq;
    const idRes = await env.DB.prepare(
      'SELECT * FROM identities WHERE key_id IN ' +
        '(SELECT DISTINCT r.signer FROM records r WHERE r.ledger_seq > ? AND r.ledger_seq <= ?)'
    )
      .bind(after, lastSeq)
      .all();
    identities = identityMapFromRows(idRes.results);
  }

  const ledgerHead = ledgerHeadFromRow(headRes.results[0]);
  const key = await loadServerKey(env);
  return json({
    entries,
    identities,
    checkpoint: await signScope(key, { scope: 'ledger', seq: ledgerHead.seq, hash: ledgerHead.hash }),
    server: serverInfo(key),
    hasMore
  });
}

export const onRequest = onlyMethods('GET');
