-- Replay-protection nonces are pruned by `DELETE FROM request_nonces WHERE
-- created_at < ?`, which runs on every authenticated request. Without an index
-- on created_at that DELETE scans the whole table, so each request reads the
-- entire live nonce window to delete the roughly one row that has expired.
-- On D1 those scanned rows are billed as rows_read, making daily reads grow
-- with the square of request volume.
CREATE INDEX IF NOT EXISTS idx_request_nonces_created_at
ON request_nonces(created_at);
