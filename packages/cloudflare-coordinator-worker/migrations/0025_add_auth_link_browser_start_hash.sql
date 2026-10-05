ALTER TABLE coordinator_auth_link_attempts ADD COLUMN browser_start_hash TEXT CHECK (browser_start_hash IS NULL OR (length(browser_start_hash) = 64 AND browser_start_hash NOT GLOB '*[^0-9a-f]*'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_link_attempts_browser_start
 ON coordinator_auth_link_attempts(coordinator_id, browser_start_hash);
