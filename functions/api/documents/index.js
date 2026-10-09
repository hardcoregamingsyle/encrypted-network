// GET /api/documents: public list of listed documents, newest update first.
import { isHash } from '../../../shared/records.js';
import { badRequest } from '../../_lib/errors.js';
import { escapeLike, intParam, json, onlyMethods } from '../../_lib/http.js';

const MAX_QUERY_CHARS = 120;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const limit = intParam(url, 'limit', { min: 1, max: 100, def: 50 });
  const before = intParam(url, 'before', { min: 0, max: Number.MAX_SAFE_INTEGER, def: null });
  const owner = url.searchParams.get('owner');
  const q = url.searchParams.get('q');
  if (owner && !isHash(owner)) throw badRequest('owner must be 64 lowercase hex characters');
  if (q && [...q].length > MAX_QUERY_CHARS) throw badRequest(`q must be at most ${MAX_QUERY_CHARS} characters`);

  // Only fixed SQL text is joined here. Every value goes through bind.
  const where = ['d.listed = 1'];
  const args = [];
  if (before !== null) {
    where.push('d.updated_at < ?');
    args.push(before);
  }
  if (owner) {
    where.push('d.owner_key_id = ?');
    args.push(owner);
  }
  if (q) {
    where.push("d.label LIKE ? ESCAPE '\\'");
    args.push('%' + escapeLike(q) + '%');
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

export const onRequest = onlyMethods('GET');
