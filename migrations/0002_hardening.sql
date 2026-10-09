-- hrdlock v2, second migration: upload reservations, stable paging, stored channel counters.
-- Safe to apply on a database that already holds data from 0001.

-- Blob uploads reserve their quota before the bytes are streamed. A reserved row has pending = 1
-- and becomes a normal row (pending = 0) when the object is stored. Documents may only point at
-- finished rows. A reserved row that is never finished is swept after two hours.
ALTER TABLE blobs ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_blobs_pending ON blobs (created_at) WHERE pending = 1;

-- Total bytes held (finished and reserved), kept up to date by triggers so the global cap is a
-- single row read. The row with k = 'all' is the only one.
CREATE TABLE blob_totals (
  k TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL
);
INSERT INTO blob_totals (k, bytes) SELECT 'all', COALESCE(SUM(size), 0) FROM blobs;

CREATE TRIGGER blobs_total_insert AFTER INSERT ON blobs
BEGIN
  UPDATE blob_totals SET bytes = bytes + NEW.size WHERE k = 'all';
END;

CREATE TRIGGER blobs_total_delete AFTER DELETE ON blobs
BEGIN
  UPDATE blob_totals SET bytes = bytes - OLD.size WHERE k = 'all';
END;

-- Files an operator has removed. They cannot be uploaded again.
CREATE TABLE blocked_blobs (
  hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Document list paging uses (updated_at, doc_id) as one cursor, so both belong in the index.
DROP INDEX idx_documents_listed_updated;
DROP INDEX idx_documents_owner_updated;
CREATE INDEX idx_documents_listed_updated ON documents (listed, updated_at DESC, doc_id DESC);
CREATE INDEX idx_documents_owner_updated ON documents (owner_key_id, updated_at DESC, doc_id DESC);

-- Channels: order and page by the time the server received the channel (a signer can claim any
-- createdAt within ten minutes), and keep the message counters here so that reading a channel
-- never has to count its messages.
ALTER TABLE channels ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN last_message_at INTEGER;
UPDATE channels SET received_at = created_at;
UPDATE channels SET
  message_count = (SELECT COUNT(*) FROM messages m WHERE m.channel_id = channels.channel_id),
  last_message_at = (SELECT m2.created_at FROM messages m2 WHERE m2.channel_id = channels.channel_id ORDER BY m2.seq DESC LIMIT 1);
DROP INDEX idx_channels_created;
CREATE INDEX idx_channels_received ON channels (received_at DESC, channel_id DESC);
