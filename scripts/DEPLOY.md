# Deploying hrdlock to Cloudflare Pages

hrdlock is a prototype. It has not been audited or certified. This file is the operator's checklist and
the plain list of what the service does and does not promise.

## 1. Build requirements

- Node 22 (the repo has a `.node-version` file; Cloudflare Pages reads it). Vite 8 needs Node 20.19 or
  22.12 and newer, wrangler 4 needs Node 22. If the build image is older, set `NODE_VERSION=22` in the
  Pages project settings. `npm run build` stops early with a clear message on an unsuitable Node.
- Build command `npm run build`, output folder `dist`.

## 2. First deploy

1. `npx wrangler d1 create hrdlock`, put the printed id in `wrangler.toml` as `database_id`.
2. `npx wrangler r2 bucket create hrdlock-files`.
3. `npx wrangler d1 migrations apply DB --remote` (applies every file in `migrations/`, in order. Run it
   again after every update that adds a migration, before the new code goes live).
4. Make the server signing key ONCE, into a file, and keep a copy offline:
   `node scripts/setup-dev.mjs --write-production-key server-key.json`
   It prints the key id. Write the id down, it is what verifiers pin.
5. Store it as a secret for Production, and for Preview if you use preview deployments (secrets are per
   environment): `npx wrangler pages secret put SERVER_SIGNING_JWK --project-name <project> < server-key.json`
6. Deploy, then run `node scripts/check-deploy.mjs https://<site> --key-id <the id from step 4>`.
   It fails when the API is down or when signing is off. Without the secret the site still works, but
   nothing it serves is anchored by a checkpoint and every document check fails its anchor test.
   `/api/health` also says `"signing": true` or `false`.

### About the signing key

- Stored secrets can not be read back. The file from step 4 is the only copy. Lose it and you can only make
  a new key, which has a new key id, and every verifier that pinned the old id then rejects every checkpoint.
- Rotating the key therefore invalidates pins. There is no list of accepted key ids, one key signs at a time.
- Do not commit the file. Do not pipe `--print-production-key` into wrangler unless you accept having no copy.

## 3. What is public

- The whole ledger is public: `GET /api/ledger` returns every document record, with document id, label,
  file hash, signer and times. That is what lets anyone audit the chain, and a signature covers the whole
  record, so it can not be hidden or redacted.
- "Unlisted" only keeps a document out of the document list and search. It is not secret. Anyone can find
  its id and label in the ledger. A channel that names a document also shows that document's id.
- Labels, display names, channel titles and chat messages are public and can not be removed by their authors.
  Do not put anything there that must stay private. The locked file is encrypted and its file name is inside
  the encrypted part, but its size is visible.
- Locked files are stored in a public bucket path behind `GET /api/blobs/<hash>`: anyone who knows the hash can
  download the (encrypted) bytes. Only the password opens them.

## 4. Deleting

- Authors can not delete records, versions or messages. A document can be revoked (a signed record), not erased.
- The operator can take one stored file down: `npm run takedown -- <blobHash> --reason "text" --remote`.
  It blocks the hash from being uploaded again, removes the row and deletes the object. It never touches
  the ledger. A document that pointed at the file keeps its record, but its file can no longer be fetched.

## 5. Limits (all enforced by the server)

| What | Limit |
| --- | --- |
| Identities created | 10 per hour per address (an IPv6 /64 counts as one address), 500 per hour in total |
| Messages | 20 per minute per identity |
| Document records | 30 per hour per identity, at most 200 records per document (199 versions plus a final revoke) |
| Channels | 10 per hour per identity |
| File uploads | 30 per hour per identity, 4 in flight at once, 500 MiB stored per identity, 10 GiB stored in total |
| One locked file | 50 MiB of file plus 4 KiB, must start with a locked file header |
| JSON bodies | 64 KiB |
| Ledger page | at most 200 entries |
| Document list page | at most 100, channel list page at most 200 (both page on with a cursor) |

A request without the `CF-Connecting-IP` header (Cloudflare always sets it) is refused, except on a local
development host.

## 6. Answers worth knowing

- `409 conflict`: the record does not fit the current head of the document (someone else wrote first, or the
  document is revoked or full). Reload and sign again.
- `503 busy` (with `Retry-After`): many writers were appending at the same moment and this one kept losing the
  race for about 8 seconds. Nothing was written. Send the same signed record again.
- `429 rate_limited`: a limit above was hit, see `Retry-After`.

## 7. Paging

- `GET /api/documents?before=<updatedAt>&beforeId=<docId>` pages on from the last row seen. Send both values
  of the last row. `before` alone still works but can skip documents that share one `updatedAt`.
- `GET /api/channels?before=<n>&beforeId=<channelId>` with the `next` object of the previous answer.
  Channels are ordered by the time the server received them.
- `GET /api/ledger?after=<seq>&limit=<1..200>` with `hasMore`.
