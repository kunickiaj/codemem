/** Management-attempt schema installed by the explicit account-schema migration. */
const table = "coordinator_account_change_attempts";
export const ACCOUNT_CHANGE_SCHEMA_STATEMENTS = [
	`CREATE TABLE ${table} (
 coordinator_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 intent TEXT NOT NULL CHECK(intent IN ('refresh','disconnect')),
 target_link_id TEXT NOT NULL, identity_id TEXT NOT NULL, issuer TEXT NOT NULL, target_subject TEXT NOT NULL,
 group_id TEXT NOT NULL, device_id TEXT NOT NULL, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 key_id TEXT NOT NULL, enrollment_identity_id TEXT, auth_config_revision TEXT NOT NULL,
 runtime_verifier_hash TEXT NOT NULL, browser_start_hash TEXT NOT NULL, loopback_redirect TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','browser_pending','consumed','verified','confirmed','committing','completed','cancelled','failed','expired')),
 failure_reason TEXT CHECK(failure_reason IN ('device_cancelled','provider_failure','expired')),
 state_hash TEXT, binder_hash TEXT, nonce TEXT, pkce_verifier TEXT, browser_order INTEGER,
 completion_secret_hash TEXT, display_name TEXT, email TEXT, email_verified INTEGER, picture_url TEXT,
 created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
 consumed_at_ms INTEGER, verified_at_ms INTEGER, confirmed_at_ms INTEGER, completed_at_ms INTEGER,
 PRIMARY KEY(coordinator_id,attempt_id), UNIQUE(coordinator_id,browser_start_hash),
 UNIQUE(coordinator_id,runtime_verifier_hash), UNIQUE(coordinator_id,state_hash),
 UNIQUE(coordinator_id,binder_hash), UNIQUE(coordinator_id,completion_secret_hash),
 CHECK(typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254140991 AND expires_at_ms = created_at_ms + 600000),
 CHECK(browser_order IS NULL OR (typeof(browser_order) = 'integer' AND browser_order BETWEEN 1 AND 9007199254740991)),
 CHECK((state = 'completed') = (completed_at_ms IS NOT NULL)),
 CHECK((state = 'failed' AND failure_reason IS 'provider_failure') OR (state = 'expired' AND failure_reason IS 'expired') OR (state = 'cancelled' AND failure_reason IS 'device_cancelled') OR (state NOT IN ('failed','expired','cancelled') AND failure_reason IS NULL)),
 CHECK(state <> 'pending' OR (state_hash IS NULL AND binder_hash IS NULL AND browser_order IS NULL)),
 CHECK(state <> 'browser_pending' OR (state_hash IS NOT NULL AND binder_hash IS NOT NULL AND nonce IS NOT NULL AND pkce_verifier IS NOT NULL AND browser_order IS NOT NULL)),
 CHECK(state IN ('pending','browser_pending') OR (nonce IS NULL AND pkce_verifier IS NULL)),
 CHECK(state NOT IN ('consumed','verified','confirmed','committing','completed') OR (consumed_at_ms IS NOT NULL AND consumed_at_ms >= created_at_ms AND consumed_at_ms < expires_at_ms)),
 CHECK(state NOT IN ('verified','confirmed','committing','completed') OR (verified_at_ms IS NOT NULL AND verified_at_ms >= consumed_at_ms AND verified_at_ms < expires_at_ms)),
 CHECK(state NOT IN ('confirmed','committing','completed') OR (completion_secret_hash IS NOT NULL AND confirmed_at_ms IS NOT NULL AND confirmed_at_ms >= verified_at_ms AND confirmed_at_ms < expires_at_ms)),
 CHECK(state <> 'completed' OR (completed_at_ms >= confirmed_at_ms AND completed_at_ms < expires_at_ms AND display_name IS NULL AND email IS NULL AND email_verified IS NULL AND picture_url IS NULL)),
 CHECK(email_verified IS NULL OR (email_verified IN (0,1) AND email IS NOT NULL))
)`,
	`CREATE TRIGGER account_change_collision BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${table} WHERE coordinator_id = NEW.coordinator_id AND
 (attempt_id = NEW.attempt_id OR browser_start_hash = NEW.browser_start_hash OR runtime_verifier_hash = NEW.runtime_verifier_hash OR state_hash = NEW.state_hash OR binder_hash = NEW.binder_hash OR completion_secret_hash = NEW.completion_secret_hash))
BEGIN SELECT RAISE(ABORT,'account_change_collision'); END`,
	`CREATE TRIGGER account_change_birth BEFORE UPDATE ON ${table}
WHEN ${["coordinator_id", "attempt_id", "intent", "target_link_id", "identity_id", "issuer", "target_subject", "group_id", "device_id", "public_key", "fingerprint", "key_id", "enrollment_identity_id", "auth_config_revision", "runtime_verifier_hash", "browser_start_hash", "loopback_redirect", "created_at_ms", "expires_at_ms"].map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ")}
BEGIN SELECT RAISE(ABORT,'account_change_birth_immutable'); END`,
	`CREATE TRIGGER account_change_transition BEFORE UPDATE ON ${table}
WHEN OLD.state IN ('completed','cancelled','failed','expired') OR NOT (
 (OLD.state = 'pending' AND NEW.state = 'browser_pending') OR
 (OLD.state = 'browser_pending' AND NEW.state = 'consumed') OR
 (OLD.state = 'consumed' AND ((OLD.intent = 'refresh' AND NEW.state = 'confirmed') OR (OLD.intent = 'disconnect' AND NEW.state = 'verified'))) OR
 (OLD.state = 'verified' AND NEW.state = 'confirmed') OR
 (OLD.state = 'confirmed' AND NEW.state = 'committing') OR
 (OLD.state = 'committing' AND NEW.state = 'completed') OR
 (OLD.state NOT IN ('committing','completed','cancelled','failed','expired') AND NEW.state IN ('cancelled','expired')) OR
 (OLD.state = 'consumed' AND NEW.state = 'failed'))
BEGIN SELECT RAISE(ABORT,'account_change_transition_invalid'); END`,
	`CREATE TRIGGER account_change_receipt_delete BEFORE DELETE ON ${table} WHEN OLD.state = 'completed'
BEGIN SELECT RAISE(ABORT,'account_change_receipt_immutable'); END`,
	`CREATE TRIGGER account_change_archive_receipt BEFORE INSERT ON coordinator_auth_account_connection_history
WHEN NOT EXISTS (SELECT 1 FROM ${table} a WHERE a.coordinator_id = NEW.coordinator_id
 AND a.attempt_id = NEW.end_attempt_id AND a.state = 'committing' AND a.intent = 'disconnect'
 AND a.target_link_id = NEW.link_id AND a.identity_id = NEW.identity_id AND a.issuer = NEW.issuer AND a.target_subject = NEW.subject)
BEGIN SELECT RAISE(ABORT,'account_change_archive_receipt_invalid'); END`,
	// EXPLAIN in the focused tests checks that the repeated revocation barrier
	// changes from a coordinator-prefix scan to an Identity-specific covering lookup.
	`CREATE INDEX account_connection_history_identity_revoked ON coordinator_auth_account_connection_history(coordinator_id,identity_id,revoked_at_ms)`,
	`ALTER TABLE coordinator_auth_link_profiles ADD COLUMN source_change_attempt_id TEXT`,
	`ALTER TABLE coordinator_auth_link_profiles ADD COLUMN source_order INTEGER`,
	`ALTER TABLE coordinator_auth_account_profiles ADD COLUMN source_order INTEGER`,
] as const;
