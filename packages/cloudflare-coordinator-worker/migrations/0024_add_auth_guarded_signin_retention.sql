ALTER TABLE coordinator_auth_session_receipts ADD COLUMN purge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (typeof(purge_eligible) = 'integer' AND purge_eligible IN (0,1) AND (purge_eligible = 0 OR (source = 'signin' AND attempt_id IS NULL)));

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
 ON coordinator_auth_sessions(coordinator_id, expires_at_ms, session_id);
CREATE INDEX IF NOT EXISTS idx_auth_session_receipts_purge
 ON coordinator_auth_session_receipts(coordinator_id, purge_eligible, created_at_ms, browser_transaction_hash);
