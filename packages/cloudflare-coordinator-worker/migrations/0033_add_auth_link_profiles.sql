-- Optional display snapshots only. No backfill or authority changes.
CREATE TABLE IF NOT EXISTS coordinator_auth_link_profiles (
 coordinator_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL,
 browser_transaction_hash TEXT NOT NULL,
 link_id TEXT,
 display_name TEXT,
 email TEXT,
 email_verified INTEGER CHECK (email_verified IS NULL OR (email_verified IN (0,1) AND email IS NOT NULL)),
 picture_url TEXT,
 verified_at_ms INTEGER NOT NULL,
 PRIMARY KEY (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, link_id)
);
