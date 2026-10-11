// GET /api/me/documents  every document owned by any key of the account, listed or not, newest
// update first. Same rows as GET /api/documents plus `listed`. Paging: limit (1..100, default 50),
// before=<updatedAt> and beforeId=<docId> of the last row seen.
import { authJson } from '../../_lib/accounts.js';
import { atRest } from '../../_lib/atRest.js';
import { badRequest } from '../../_lib/errors.js';
import { intParam, onlyMethods } from '../../_lib/http.js';
import { docListRow } from '../../_lib/documents.js';
import { isDocId } from '../../../shared/records.js';
import { requireAuth } from '../../_lib/session.js';

// The query, with no cursor, a cursor of updatedAt, or a cursor of updatedAt and docId. Driven from the
// account's own keys (CROSS JOIN pins that order) so every page, also the ones with a cursor, reads only the
// account's documents through idx_documents_owner_updated. With the keys in an IN (...) the cursor form made
// SQLite scan the whole documents table (tests/review/cloudflare/accounts-deploy.test.js pins the plan).
export function meDocumentsSql(cursor = 'none') {
  const where = ['k.account_id = ?'];
  if (cursor === 'timeId') where.push('(d.updated_at < ? OR (d.updated_at = ? AND d.doc_id < ?))');
  else if (cursor === 'time') where.push('d.updated_at < ?');
  return (
    'SELECT d.doc_id, d.label, d.owner_key_id, d.listed, i.display_name AS owner_name, d.status, d.head_version, d.created_at, d.updated_at ' +
    'FROM account_keys k CROSS JOIN documents d ON d.owner_key_id = k.key_id LEFT JOIN identities i ON i.key_id = d.owner_key_id WHERE ' +
    where.join(' AND ') +
    ' ORDER BY d.updated_at DESC, d.doc_id DESC LIMIT ?'
  );
}

export async function onRequestGet({ request, env }) {
  await atRest(env);
  const auth = await requireAuth(env, request);
  const url = new URL(request.url);
  const limit = intParam(url, 'limit', { min: 1, max: 100, def: 50 });
  const before = intParam(url, 'before', { min: 0, max: Number.MAX_SAFE_INTEGER, def: null });
  const beforeId = url.searchParams.get('beforeId');
  if (beforeId && !isDocId(beforeId)) throw badRequest('beforeId must be 32 lowercase hex characters');
  if (beforeId && before === null) throw badRequest('beforeId needs before');

  const args = [auth.row.id];
  let cursor = 'none';
  if (before !== null && beforeId) {
    cursor = 'timeId';
    args.push(before, before, beforeId);
  } else if (before !== null) {
    cursor = 'time';
    args.push(before);
  }
  args.push(limit);
  const { results } = await env.DB.prepare(meDocumentsSql(cursor)).bind(...args).all();
  return authJson(auth, { documents: results.map((r) => ({ ...docListRow(r), listed: r.listed === 1 })) });
}

export const onRequest = onlyMethods('GET');
