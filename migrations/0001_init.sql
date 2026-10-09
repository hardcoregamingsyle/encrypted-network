-- hrdlock v2 schema. Stored body columns hold the exact canonical JSON of the signed record.

CREATE TABLE identities (
  key_id TEXT PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  record TEXT NOT NULL,
  signature TEXT NOT NULL
);

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  uploader TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_blobs_uploader ON blobs (uploader);

CREATE TABLE documents (
  doc_id TEXT PRIMARY KEY,
  owner_key_id TEXT NOT NULL,
  status TEXT NOT NULL,
  listed INTEGER NOT NULL,
  head_version INTEGER NOT NULL,
  head_record_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_documents_listed_updated ON documents (listed, updated_at DESC);
CREATE INDEX idx_documents_owner_updated ON documents (owner_key_id, updated_at DESC);

CREATE TABLE records (
  record_hash TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  signer TEXT NOT NULL,
  body TEXT NOT NULL,
  signature TEXT NOT NULL,
  ledger_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (doc_id, version)
);
CREATE INDEX idx_records_ledger_seq ON records (ledger_seq);

CREATE TABLE ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  record_hash TEXT NOT NULL UNIQUE,
  prev_ledger_hash TEXT NOT NULL UNIQUE,
  ledger_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE channels (
  channel_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  record TEXT NOT NULL,
  signature TEXT NOT NULL
);
CREATE INDEX idx_channels_created ON channels (created_at DESC);

CREATE TABLE messages (
  hash TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  signer TEXT NOT NULL,
  body TEXT NOT NULL,
  signature TEXT NOT NULL,
  prev_chain_hash TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (channel_id, seq)
);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  "window" INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, "window")
);
CREATE INDEX idx_rate_limits_window ON rate_limits ("window");
