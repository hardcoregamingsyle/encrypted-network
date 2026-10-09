// GET /api/documents: public list of listed documents, newest update first.
//   ?limit=<1..100>&owner=<keyId>&q=<text>
//   Paging: before=<updatedAt>&beforeId=<docId> of the last row seen. Both are needed to be sure
//   that documents with the same updatedAt are not skipped (updatedAt is chosen by the signer).
import { isDocId, isHash } from '../../../shared/records.js';
import { badRequest } from '../../_lib/errors.js';
import { headOf, intParam, json, onlyMethods } from '../../_lib/http.js';

const MAX_QUERY_CHARS = 120;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const limit = intParam(url, 'limit', { min: 1, max: 100, def: 50 });
  const before = intParam(url, 'before', { min: 0, max: Number.MAX_SAFE_INTEGER, def: null });
  const beforeId = url.searchParams.get('beforeId');
  const owner = url.searchParams.get('owner');
  const q = url.searchParams.get('q');
  if (beforeId && !isDocId(beforeId)) throw badRequest('beforeId must be 32 lowercase hex characters');
  if (beforeId && before === null) throw badRequest('beforeId needs before');
  if (owner && !isHash(owner)) throw badRequest('owner must be 64 lowercase hex characters');
  if (q && [...q].length > MAX_QUERY_CHARS) throw badRequest(`q must be at most ${MAX_QUERY_CHARS} characters`);

  // Only fixed SQL text is joined here. Every value goes through bind.
  const where = ['d.listed = 1'];
  const args = [];
  if (before !== null && beforeId) {
    // The cursor is the pair (updated_at, doc_id), the same two keys as the sort order.
    where.push('(d.updated_at < ? OR (d.updated_at = ? AND d.doc_id < ?))');
    args.push(before, before, beforeId);
  } else if (before !== null) {
    where.push('d.updated_at < ?');
    args.push(before);
  }
  if (owner) {
    where.push('d.owner_key_id = ?');
    args.push(owner);
  }
  if (q) {
    // instr finds the text as it is. LIKE would need % and _ escaped, and D1 refuses LIKE patterns
    // longer than 50 bytes. Case folding is ASCII only, the same as LIKE.
    where.push('instr(lower(d.label), lower(?)) > 0');
    args.push(q);
  }
  args.push(limit);
  const sql =
    'SELECT d.doc_id, d.label, d.owner_key_id, i.display_name AS owner_name, d.status, d.head_version, d.created_at, d.updated_at ' +
    'FROM documents d LEFT JOIN identities i ON i.key_id = d.owner_key_id WHERE ' +
    where.join(' AND ') +
    ' ORDER BY d.updated_at DESC, d.doc_id DESC LIMIT ?';
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json({
    documents: results.map((r) => ({
      docId: r.doc_id,
      label: r.label,
      ownerKeyId: r.owner_key_id,
      ownerName: r.owner_name || '',
      status: r.status,
      headVersion: r.head_version,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  });
}

export const onRequestHead = headOf(onRequestGet);
export const onRequest = onlyMethods('GET');
