-- Headless account linking: code-entry failure windows and link provenance.
-- Additive only. Headless linking stays off until both tables exist.
-- Generated from packages/core/src/coordinator-auth-headless-schema.ts. coordinator-auth-headless-schema.test.ts checks parity.
CREATE TABLE IF NOT EXISTS coordinator_headless_link_code_limits (
 coordinator_id TEXT NOT NULL CHECK (typeof(coordinator_id) = 'text' AND length(coordinator_id) BETWEEN 1 AND 256),
 scope TEXT NOT NULL CHECK (scope IN ('client','coordinator')),
 key_hash TEXT NOT NULL CHECK ((scope = 'coordinator' AND key_hash = '')
  OR (scope = 'client' AND length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*')),
 window_start_ms INTEGER NOT NULL CHECK (typeof(window_start_ms) = 'integer'
  AND window_start_ms BETWEEN 0 AND 9007199254740991),
 failures INTEGER NOT NULL CHECK (typeof(failures) = 'integer' AND failures BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (coordinator_id, scope, key_hash)
 ) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS coordinator_headless_link_provenance (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0),
 PRIMARY KEY (coordinator_id, link_id),
 UNIQUE (coordinator_id, attempt_id)
 ) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_headless_link_provenance_account
 ON coordinator_headless_link_provenance (coordinator_id, issuer, subject, identity_id, created_at_ms);
CREATE TRIGGER IF NOT EXISTS headless_link_provenance_immutable
 BEFORE UPDATE ON coordinator_headless_link_provenance
 BEGIN SELECT RAISE(ABORT,'headless_link_provenance_immutable'); END;
CREATE TRIGGER IF NOT EXISTS headless_link_provenance_retained
 BEFORE DELETE ON coordinator_headless_link_provenance
 BEGIN SELECT RAISE(ABORT,'headless_link_provenance_retained'); END;
CREATE TRIGGER IF NOT EXISTS headless_link_provenance_no_replace
 BEFORE INSERT ON coordinator_headless_link_provenance
 WHEN EXISTS (SELECT 1 FROM coordinator_headless_link_provenance p WHERE p.coordinator_id = NEW.coordinator_id
  AND (p.link_id = NEW.link_id OR p.attempt_id = NEW.attempt_id))
 BEGIN SELECT RAISE(ABORT,'headless_link_provenance_retained'); END;
