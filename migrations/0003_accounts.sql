-- hrdlock v3, third migration: email accounts, sessions, one time codes, wrapped keys and passwords.
-- Additive only. Safe to apply on a database that already holds data from 0001 and 0002.
-- The email address itself is never stored: only an HMAC of it and a masked form for display.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                 -- 32 hex, random
  email_hash TEXT NOT NULL UNIQUE,     -- hex HMAC-SHA256 of the normalised email
  email_masked TEXT NOT NULL,
  display_name TEXT,                   -- set when the first key is registered
  strict INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,         -- hex sha256 of the random session token
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE otp_codes (
  email_hash TEXT PRIMARY KEY,         -- at most one live code per email
  code_hash TEXT NOT NULL,             -- hex HMAC of email_hash and the code
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX otp_codes_expires ON otp_codes(expires_at);

CREATE TABLE account_keys (
  key_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  wrapped_private TEXT,                -- base64url of version byte + iv + ciphertext, NULL in strict mode
  created_at INTEGER NOT NULL
);
CREATE INDEX account_keys_account ON account_keys(account_id);

-- An account holds at most one key with a server copy. The database enforces it, so two requests
-- that race can not both store one.
CREATE UNIQUE INDEX account_keys_one_copy ON account_keys(account_id) WHERE wrapped_private IS NOT NULL;

-- An account holds at most 5 keys. Same reason: the check lives where the insert happens.
CREATE TRIGGER account_keys_max BEFORE INSERT ON account_keys
WHEN (SELECT COUNT(*) FROM account_keys WHERE account_id = NEW.account_id) >= 5
BEGIN
  SELECT RAISE(ABORT, 'too many keys for this account');
END;

CREATE TABLE account_secrets (
  account_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  wrapped TEXT NOT NULL,               -- the document password, wrapped like wrapped_private
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, doc_id)
);

-- The chat list shows a preview of the newest message. These are kept up to date in the same batch
-- that inserts a message. Existing channels get empty strings.
ALTER TABLE channels ADD COLUMN last_text TEXT NOT NULL DEFAULT '';
ALTER TABLE channels ADD COLUMN last_signer_name TEXT NOT NULL DEFAULT '';
