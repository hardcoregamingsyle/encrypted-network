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
2. `npx wrangler kv namespace create hrdlock-blobs`, put the printed id in `wrangler.toml` under `[[kv_namespaces]]` (binding `BLOBS`). The locked files live in this KV namespace. KV needs nothing enabled on the account. If you would rather use R2 later, bind a bucket as `FILES` and the server prefers it.
3. `npx wrangler d1 migrations apply DB --remote` (applies every file in `migrations/`, in order. Run it
   again after every update that adds a migration, BEFORE the new code goes live: the code reads the new
   tables and columns, so code that is live on a database that is behind answers 500 on the chat list and on
   sign in. `/api/health` and `node scripts/check-deploy.mjs` notice this: health answers 503 with
   `"schema": false`, and the check fails with the line to run).
4. Make the server signing key ONCE, into a file, and keep a copy offline:
   `node scripts/setup-dev.mjs --write-production-key server-key.json`
   It prints the key id. Write the id down, it is what verifiers pin.
5. Store it as a secret for Production, and for Preview if you use preview deployments (secrets are per
   environment). In bash: `npx wrangler pages secret put SERVER_SIGNING_JWK --project-name <project> < server-key.json`
   In PowerShell: `Get-Content server-key.json -Raw | npx wrangler pages secret put SERVER_SIGNING_JWK --project-name <project>`
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
  It blocks the hash from being uploaded again, removes the row and deletes the object. KV keeps a copy at each edge location, so the file can still be served for a few minutes (it took about five in a live test) before every location answers 404. It never touches
  the ledger. A document that pointed at the file keeps its record, but its file can no longer be fetched.

## 5. Limits (all enforced by the server)

| What | Limit |
| --- | --- |
| Identities created | 10 per hour per address (an IPv6 /64 counts as one address), 500 per hour in total |
| Sign in codes | 5 mails per hour per inbox (a name with a plus part, or dots on gmail.com, counts as the same inbox), 20 requests per hour per address, 60 per hour per IPv6 /48 network, 400 mails per hour and 2000 per day in total (the operator can set both), 30 seconds between two codes for one email (details in section 8) |
| Code checks | 10 per 10 minutes per address, 5 wrong tries per hour from one address for one email, 25 wrong tries per hour for one email from all addresses together |
| Key registrations | 10 per hour per account, at most 5 keys per account |
| Messages | 20 per minute per identity |
| Document records | 30 per hour per identity, at most 200 records per document (199 versions plus a final revoke) |
| Channels | 10 per hour per identity |
| File uploads | 30 per hour per identity, 4 in flight at once, 200 MiB stored per identity, 900 MiB stored in total |
| One locked file | 20 MiB of file plus 4 KiB, must start with a locked file header |
| JSON bodies | 64 KiB |
| Ledger page | at most 200 entries |
| Document list page | at most 100, channel list page at most 200 (both page on with a cursor) |

The locked files are in Workers KV. On the free Cloudflare plan KV allows 1,000 writes a day (so about 1,000 uploads a day for the whole site) and 1 GB in total, which is why the server stops at 900 MiB. When KV says the write limit is reached, the upload answers `429 rate_limited` with a one hour `Retry-After`. A paid plan lifts both limits. The 20 MiB file limit comes from the 25 MiB KV value limit.

A request without the `CF-Connecting-IP` header (Cloudflare always sets it) is refused, except on a local
development host.

## 6. Answers worth knowing

- `409 conflict`: the record does not fit the current head of the document (someone else wrote first, or the
  document is revoked or full). Reload and sign again.
- `503 busy` (with `Retry-After`): many writers were appending at the same moment and this one kept losing the
  race for about 8 seconds. Nothing was written. Send the same signed record again.
- `429 rate_limited`: a limit above was hit, see `Retry-After`.

### Tabs that were open during a deploy

Every build gives its script files new hashed names, and the old files are gone after a deploy. A page that was
opened before the deploy and asks for an old file later (for example the lazily loaded cipher worker) can get the
app page back instead of a 404, with the one year cache header of `/assets/*`. That is how the local Pages runner
behaves (it was not checked on a real Pages project). The old tab then fails with a script error and the person
has to reload it; a fresh page asks for the new names and is not affected. Nothing in `public/_headers` can tell
a missing file from an existing one, so this is a note and not a fix.

### Polling and the free plan

The app polls: the chat list every 10 seconds while the Chats tab is visible, and an open room every 3 seconds. Each
request is a Functions request and reads rows from D1. The free Cloudflare plan allows 100,000 Functions
requests a day and 5 million D1 rows read a day. One visible Chats tab makes 8,640 list requests a day, one open
room 28,800 message requests, and one list request reads a few hundred rows (every channel on the page, with the
owner and the file it names). Roughly 100 person-hours of open tabs in one day use up the Functions allowance, and
fewer use up the D1 one. When a quota is used up every `/api` call fails until midnight UTC while the static pages
still load, so the site looks up but is dead. Watch the usage in the Cloudflare dashboard. The paid plan lifts both
limits and is the upgrade point when the number of people reading at the same time grows. These are estimates from
the query plan and the poll intervals, not measurements against a real D1.

## 7. Paging

- `GET /api/documents?before=<updatedAt>&beforeId=<docId>` pages on from the last row seen. Send both values
  of the last row. `before` alone still works but can skip documents that share one `updatedAt`.
- `GET /api/channels?before=<n>&beforeId=<channelId>` with the `next` object of the previous answer.
  Channels are ordered by the time the server received them.
- `GET /api/ledger?after=<seq>&limit=<1..200>` with `hasMore`.

## 8. Accounts and email sign in

People can sign in with an email address and a 6 digit code (no password), or use Quick start (a key kept
only in their own browser, no email). Accounts are optional: without the settings below the site works as
before and only Quick start is offered. `/api/health` tells which parts are on:
`{ "ok": true, "signing": true, "mail": "resend", "mailConfigured": "resend", "accounts": true }`.

### Settings

Secrets are set with `npx wrangler pages secret put <NAME> --project-name <project>` and can not be read back. Plain
values (they are not secret) belong in `wrangler.toml` under `[vars]`, as `MAIL_PROVIDER = "resend"`, `MAIL_FROM =
"hrdlock <login@your-domain.example>"`, `CF_ACCOUNT_ID`, `MAIL_CAP_HOUR` and `MAIL_CAP_DAY`. Reason: in a Pages project
that has a `wrangler.toml` the dashboard does not let you edit plain variables, so they live in the file (a
secret works too, it is just hidden in the dashboard). The keys are always secrets: `ACCOUNT_MASTER_KEY`,
`RESEND_API_KEY`, `BREVO_API_KEY`, `CF_EMAIL_TOKEN`. `wrangler.toml` has one set of bindings for the database and the
file store and no separate preview section, so a preview deployment may use the same database and files as
production. Look at Settings, Bindings in the dashboard (the Preview column) and give previews their own database
and namespace if they should not share. Secrets are per environment, so a preview needs its own if you want
accounts there.

| Name | What it is |
| --- | --- |
| `ACCOUNT_MASTER_KEY` | Base64 of 32 random bytes. Without it every account endpoint answers `503 accounts_unavailable` and health says `"accounts": false`. |
| `MAIL_PROVIDER` (plain value) | `resend`, `brevo` or `cloudflare`. Anything else, or missing, means email sign in is off (`503 mail_unavailable`). `echo` is for local development only, see the rule below. |
| `MAIL_FROM` (plain value) | The sender, for example `hrdlock <login@your-domain.example>`. The domain must be verified at the provider. |
| `RESEND_API_KEY` | Resend only. |
| `BREVO_API_KEY` | Brevo only. Brevo takes the sender as address and name: it reads them from `MAIL_FROM`, or from `MAIL_FROM_ADDRESS` and `MAIL_FROM_NAME` when those are set. |
| `CF_ACCOUNT_ID` (plain value), `CF_EMAIL_TOKEN` | Cloudflare email sending only: the 32 character account id and an API token that may send email. |
| `MAIL_CAP_HOUR`, `MAIL_CAP_DAY` (plain values) | The most sign in mails the whole service sends per hour (default 400) and per day (default 2000). Set the day number to what your mail plan allows (small plans allow a few hundred a day): the server stops asking the provider when the number is reached, instead of the provider refusing everybody. |

Do the same for the Preview environment if you use preview deployments (secrets are per environment). The
mail is a short message with the code and no links. Provider answers are never shown to people: a failure
is always `502 mail_failed` with a plain sentence, and nothing about the address or the code is logged.

### The master key

1. Make it ONCE, into a file outside the repository, and keep a copy offline:
   `node scripts/make-master-key.mjs --write-production-key ../account-master-key.txt`
   The script refuses to overwrite a file and never prints the key.
2. Store it. In bash: `npx wrangler pages secret put ACCOUNT_MASTER_KEY --project-name <project> < ../account-master-key.txt`
   In PowerShell (the `<` redirect does not work there): `Get-Content ../account-master-key.txt -Raw | npx wrangler pages secret put ACCOUNT_MASTER_KEY --project-name <project>`
3. Deploy, run `node scripts/check-deploy.mjs https://<site>`. It prints a WARN line when accounts or email
   sign in are off.

Stored secrets can not be read back, so the file is the only copy. A file whose name contains `master-key` is git
ignored, but keep it outside the repository anyway (the script prints a warning when it is inside). A key with fewer
than 16 different byte values, for example 43 letters `A` (32 zero bytes), is refused as a placeholder and
accounts stay off (`"accounts": false` in health). Do not replace the key on a live site:
the hashes that find an account from its email would change (every account would look new) and every key
and password stored for Easy accounts would become unreadable. Three independent keys are derived from it
(email hashing, code hashing, wrapping), so one leak of a derived value does not reveal the others, but
whoever holds the master key can open everything below.

Run `npx wrangler d1 migrations apply DB --remote` before the new code goes live: `0003_accounts.sql` adds
the account tables and two preview columns on channels. It only adds, existing rows are kept (existing
channels get an empty preview until their next message).

### What the server stores for an account

- The email address itself is NOT stored. Only an HMAC of the lower case address (to find the account) and a
  masked form for display, like `pr***@gmail.com`. A copy of the database does not list anybody's address.
  Other people never see an address, only the display name and the key.
- A hash of each sign in code (the code expires after 10 minutes, five wrong tries kill it, a right code is
  used up) and a hash of each session token (the cookie holds the token). A session ends 30 days after it was last used, and in any case 90 days after it was made, so a stolen cookie does not live for ever. Signed in devices are listed by `GET /api/me/sessions`, one is ended with `DELETE /api/me/sessions/<id>`, all the others with `DELETE /api/me/sessions`, and every session including the current one with `POST /api/auth/logout` and `{ "all": true }`. Reading the stored signing key, switching Strict on or off and deleting the account need a session that was made in the last 15 minutes (otherwise `401 reauth_required`: sign in again with a new code, then repeat).
- Easy mode (the default): the account's signing key, which is made in the browser, is sent over TLS once
  and kept encrypted (AES-256-GCM, under a key derived from `ACCOUNT_MASTER_KEY`), and so are the passwords
  of the account's documents. A new device that signs in with email and a code gets the key back. The honest
  trade-off: whoever runs the service and holds the master key CAN use these keys and open these files. It
  does not change what verifiers see, signatures, the hash chain and server checkpoints work as before.
- Strict mode (a switch for the person): the server copy of the key is deleted at once and no password can be stored
  any more. The stored passwords are handed over to the client in pages of 100 (`POST /api/me/strict`, `next`), and
  the client deletes what it has safely stored with `confirmThrough`. A password that nobody confirms is deleted by the
  server 24 hours after the switch, and until then it can only be had through that call. This is so an answer that
  got lost on the way does not lose the passwords. Each new device then makes its own key (at most 5 per account),
  and a file can only be updated or withdrawn on the device that holds its key.
- Deleting an account removes the account, its sessions, its codes, its stored keys and passwords and the counts the
  rate limits kept under the hash of the email. The public identities and the ledger stay: they are signed history and
  nothing can remove them. Files stay owned by the key that published them. The same person can link that key to a
  new account again by sending the key's private key (`POST /api/me/key`), which proves they hold it; without the private
  key nobody can take over a registered key. Say in the UI that deleting an account cuts it off from its files until then.

### The echo mode rule (local development only)

`MAIL_PROVIDER=echo` sends nothing and returns the code in the answer (`debugCode`) so tests and local
development can sign in. It is honoured only when ALL of these hold: the setting is exactly `echo`, the
request went to `localhost` or `127.0.0.1`, and the request has no `CF-Connecting-IP` header or a loopback
one (and no `cf-ray` header). On every other host it behaves as if no mail were set. `npm run setup` writes
`MAIL_PROVIDER=echo` into `.dev.vars` (a local file, never uploaded) when the variable is missing. NEVER set
`echo` as a secret on Cloudflare: if you do, the deploy check FAILS (health reports `mailConfigured: "echo"`
on a site that is not local), and sign in stays off until you remove it. In echo mode a request may also set
the header `x-hrd-test-now` to pretend a different time, which the end to end script uses to test code and
session expiry. That header is ignored everywhere else.

### Answers, limits and safety rules

- Codes: only mails that were really sent are counted against the inbox, the service and the day. A request that is
  refused for the 30 second wait, or whose mail could not be stored or sent (the provider is down, over its quota or
  refuses the address), gives its count back, so a provider outage does not use up anyone's codes. 5 mails per hour
  per inbox (plus parts and gmail dots do not make a new inbox; the count slides over two hours so a window edge
  does not double it), 20 requests per hour per address, 60 per hour per IPv6 /48, 400 mails per hour and 2000 per day
  for the whole service (`MAIL_CAP_HOUR`, `MAIL_CAP_DAY`), and a 30 second wait between two codes for one email
  (`429` with `Retry-After`). Of each service ceiling 75 percent is open to everybody; the rest is kept for
  addresses that sent at most two codes that hour, so a few addresses can not close sign in for everybody. Many
  addresses still can: only a proof of work or a captcha step would stop that, and there is none. Existing sessions
  keep working while sign in is closed. Checking codes: 10 per 10 minutes per address; 5 wrong tries per hour from
  one address for one email (then that address is told `too_many_attempts` until a new code is sent) and 25 wrong
  tries per hour for one email from all addresses together. A stranger's wrong tries from other addresses do not
  kill the code that was mailed to the owner (up to 25). Registering keys: 10 per hour per account. A person who types a wrong email can not see whether an
  account exists: asking for a code gives the same answer for every address.
- Somebody who knows only an address can still ask for 5 codes (about two and a half minutes of requests, 31 seconds
  apart) and use up that person's 5 mails per hour: the person then has to wait for the next hour for a new code,
  and only the newest code works, so the earlier mails are of no use. The same goes for 25 wrong tries from many
  addresses. No limit can tell the owner from a stranger before the owner proves they hold the mailbox. The limits
  cap the damage of mail floods, they do not remove it. The sign in request itself never reveals whether an
  account exists.
- Every write that uses the session cookie (`POST`, `PUT`, `DELETE`) must carry an `Origin` header equal to
  the site's own origin, otherwise `403 forbidden`. The cookie is `HttpOnly` and `SameSite=Lax`, named
  `__Host-hrd_session` with `Secure` on https and `hrd_session` on plain http, which is only allowed on a local
  development host (sign in on plain http to a real host answers `403`).
- New error codes: `invalid_email`, `invalid_code`, `code_expired`, `too_many_attempts` (400, 400, 400, 429),
  `mail_unavailable` (503), `mail_failed` (502), `unauthenticated` (401), `accounts_unavailable` (503),
  `key_exists` and `strict_mode` (409), `reauth_required` (401, ask for a new email code and repeat).
