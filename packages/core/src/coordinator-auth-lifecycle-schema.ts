/** Inert V3 definitions: no initializer, migration, or runtime imports this module.
 * Historical copies and association backfill must precede guard installation.
 * End-receipt matching belongs to the separate change-attempt schema; these
 * definitions alone are not an activatable lifecycle schema.
 */
export const AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_auth_account_associations (
 coordinator_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
 identity_id TEXT NOT NULL,
 first_link_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 PRIMARY KEY (coordinator_id, issuer, subject)
);`;

/** Existing birth columns and authority checks retain their predecessor shape. */
export const AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_auth_account_links (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
 identity_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 controller_attestation_id TEXT,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL,
 revoked_at_ms INTEGER,
 authority_kind TEXT NOT NULL CHECK (authority_kind IN ('controller_attestation','device_claim')),
 device_claim_id TEXT,
 generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation BETWEEN 1 AND 9007199254740991),
 ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR (typeof(ended_at_ms) = 'integer' AND ended_at_ms BETWEEN 0 AND 9007199254740991 AND ended_at_ms >= created_at_ms)),
 end_reason TEXT CHECK (end_reason IS NULL OR end_reason = 'user_disconnected'),
 end_attempt_id TEXT CHECK (end_attempt_id IS NULL OR (typeof(end_attempt_id) = 'text' AND length(end_attempt_id) BETWEEN 1 AND 256 AND end_attempt_id = trim(end_attempt_id) AND instr(end_attempt_id, char(0)) = 0)),
 signin_sequence_floor INTEGER NOT NULL CHECK (typeof(signin_sequence_floor) = 'integer' AND signin_sequence_floor BETWEEN 0 AND 9007199254740990),
 PRIMARY KEY (coordinator_id, link_id),
 UNIQUE (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, identity_id, generation),
 CHECK ((ended_at_ms IS NULL AND end_reason IS NULL AND end_attempt_id IS NULL)
  OR (ended_at_ms IS NOT NULL AND end_reason IS NOT NULL AND end_attempt_id IS NOT NULL)),
 CHECK ((authority_kind = 'controller_attestation'
  AND (controller_attestation_id IS NOT NULL AND typeof(controller_attestation_id) = 'text' AND length(controller_attestation_id) BETWEEN 1 AND 256 AND controller_attestation_id = trim(controller_attestation_id) AND instr(controller_attestation_id, char(0)) = 0) AND device_claim_id IS NULL)
  OR (authority_kind = 'device_claim' AND controller_attestation_id IS NULL
  AND (device_claim_id IS NOT NULL AND typeof(device_claim_id) = 'text' AND length(device_claim_id) BETWEEN 1 AND 256 AND device_claim_id = trim(device_claim_id) AND instr(device_claim_id, char(0)) = 0)))
);`;

export const AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS = Object.freeze([
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_account_links_open_identity
 ON coordinator_auth_account_links(coordinator_id, identity_id)
 WHERE revoked_at_ms IS NULL AND ended_at_ms IS NULL;`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_account_links_open_account
 ON coordinator_auth_account_links(coordinator_id, issuer, subject)
 WHERE revoked_at_ms IS NULL AND ended_at_ms IS NULL;`,
] as const);

export const AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS = Object.freeze([
	// Explicit rowid collisions can also evict a reservation through REPLACE.
	`CREATE TRIGGER IF NOT EXISTS auth_account_associations_insert_collision
 BEFORE INSERT ON coordinator_auth_account_associations
 WHEN EXISTS (SELECT 1 FROM coordinator_auth_account_associations a
  WHERE a.rowid = NEW.rowid OR (a.coordinator_id = NEW.coordinator_id
   AND a.issuer = NEW.issuer AND a.subject = NEW.subject))
 BEGIN SELECT RAISE(ABORT, 'auth_account_association_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_account_associations_immutable_update
 BEFORE UPDATE ON coordinator_auth_account_associations
 BEGIN SELECT RAISE(ABORT, 'auth_account_association_immutable'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_account_associations_immutable_delete
 BEFORE DELETE ON coordinator_auth_account_associations
 BEGIN SELECT RAISE(ABORT, 'auth_account_association_immutable'); END;`,
] as const);

export const AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS = Object.freeze([
	// Check permanent keys and partial open-row uniques before REPLACE can delete.
	`CREATE TRIGGER IF NOT EXISTS auth_account_links_insert_collision
 BEFORE INSERT ON coordinator_auth_account_links
 WHEN EXISTS (SELECT 1 FROM coordinator_auth_account_links l
  WHERE l.rowid = NEW.rowid OR (l.coordinator_id = NEW.coordinator_id AND (
   l.link_id = NEW.link_id OR l.attempt_id = NEW.attempt_id
   OR (l.identity_id = NEW.identity_id AND l.generation = NEW.generation)
   OR (NEW.revoked_at_ms IS NULL AND NEW.ended_at_ms IS NULL
    AND l.revoked_at_ms IS NULL AND l.ended_at_ms IS NULL
    AND (l.identity_id = NEW.identity_id OR (l.issuer = NEW.issuer AND l.subject = NEW.subject))))))
 BEGIN SELECT RAISE(ABORT, 'auth_account_link_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_account_links_insert_authority
 BEFORE INSERT ON coordinator_auth_account_links
 WHEN NOT EXISTS (SELECT 1 FROM coordinator_auth_account_associations a
  WHERE a.coordinator_id = NEW.coordinator_id AND a.issuer = NEW.issuer
   AND a.subject = NEW.subject AND a.identity_id = NEW.identity_id)
 OR EXISTS (SELECT 1 FROM coordinator_auth_account_links l
  WHERE l.coordinator_id = NEW.coordinator_id AND l.identity_id = NEW.identity_id
   AND l.revoked_at_ms IS NOT NULL)
 BEGIN SELECT RAISE(ABORT, 'auth_account_link_unavailable'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_account_links_immutable_update
 BEFORE UPDATE ON coordinator_auth_account_links
 WHEN OLD.rowid IS NOT NEW.rowid
 OR OLD.coordinator_id IS NOT NEW.coordinator_id OR OLD.link_id IS NOT NEW.link_id
 OR OLD.issuer IS NOT NEW.issuer OR OLD.subject IS NOT NEW.subject
 OR OLD.identity_id IS NOT NEW.identity_id OR OLD.attempt_id IS NOT NEW.attempt_id
 OR OLD.controller_attestation_id IS NOT NEW.controller_attestation_id
 OR OLD.auth_config_revision IS NOT NEW.auth_config_revision
 OR OLD.created_at_ms IS NOT NEW.created_at_ms OR OLD.authority_kind IS NOT NEW.authority_kind
 OR OLD.device_claim_id IS NOT NEW.device_claim_id OR OLD.generation IS NOT NEW.generation
 OR OLD.signin_sequence_floor IS NOT NEW.signin_sequence_floor
 OR (OLD.revoked_at_ms IS NOT NULL AND OLD.revoked_at_ms IS NOT NEW.revoked_at_ms)
 OR (OLD.revoked_at_ms IS NULL AND NEW.revoked_at_ms IS NOT NULL AND (
  typeof(NEW.revoked_at_ms) <> 'integer' OR NEW.revoked_at_ms < OLD.created_at_ms
  OR NEW.revoked_at_ms NOT BETWEEN 0 AND 9007199254740991))
 OR (OLD.ended_at_ms IS NOT NULL AND (OLD.ended_at_ms IS NOT NEW.ended_at_ms
  OR OLD.end_reason IS NOT NEW.end_reason OR OLD.end_attempt_id IS NOT NEW.end_attempt_id))
 OR (OLD.ended_at_ms IS NULL AND NEW.ended_at_ms IS NOT NULL AND (
  OLD.revoked_at_ms IS NOT NULL OR OLD.revoked_at_ms IS NOT NEW.revoked_at_ms))
 BEGIN SELECT RAISE(ABORT, 'auth_account_link_immutable'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_account_links_immutable_delete
 BEFORE DELETE ON coordinator_auth_account_links
 BEGIN SELECT RAISE(ABORT, 'auth_account_link_immutable'); END;`,
] as const);

/** Fourth claim-table trigger: the frozen V2 exact-three check must reject it.
 * Canonical key derivation remains the signed writer's job; SQLite compares the
 * exact public-key and fingerprint pins, never substitutes a PEM hash for key_id.
 * The attempt transitions first; claim, link and audit inserts follow atomically.
 */
export const AUTH_DEVICE_CLAIM_FIRST_GENERATION_GUARD_SQL = `
CREATE TRIGGER IF NOT EXISTS coordinator_auth_device_claims_first_generation
 BEFORE INSERT ON coordinator_auth_device_claims
 WHEN NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = NEW.coordinator_id AND t.attempt_id = NEW.attempt_id
  AND t.link_id = NEW.claim_id AND t.prior_link_id IS NULL AND t.prior_generation IS NULL
  AND t.authority_kind = 'device_claim' AND t.state = 'finalized'
  AND t.controller_attestation_id IS NULL AND t.controller_review_receipt_id IS NULL
  AND t.controller_revision IS NULL AND t.identity_id = NEW.identity_id
  AND t.group_id = NEW.group_id AND t.device_id = NEW.device_id
  AND t.public_key = NEW.public_key AND t.fingerprint = NEW.fingerprint
  AND t.issuer = NEW.issuer AND t.auth_config_revision = NEW.auth_config_revision
  AND t.finalized_at_ms = NEW.created_at_ms AND t.account_subject IS NOT NULL
  AND t.runtime_verifier_hash IS NOT NULL AND t.browser_start_hash IS NOT NULL
  AND t.browser_transaction_hash IS NOT NULL AND t.completion_secret_hash IS NOT NULL
  AND t.created_at_ms <= t.claimed_at_ms AND t.claimed_at_ms <= t.oidc_verified_at_ms
  AND t.oidc_verified_at_ms <= t.confirmed_at_ms
  AND t.confirmed_at_ms <= t.finalized_at_ms AND t.finalized_at_ms < t.expires_at_ms)
 OR EXISTS (SELECT 1 FROM coordinator_auth_account_links l
  WHERE l.coordinator_id = NEW.coordinator_id AND l.identity_id = NEW.identity_id)
 BEGIN SELECT RAISE(ABORT, 'auth_device_claim_genesis_unavailable'); END;`;

/** Keep the existing audit table, action checks and historical columns unchanged. */
export const AUTH_LINK_AUDIT_RECEIPT_GUARD_STATEMENTS = Object.freeze([
	`CREATE TRIGGER IF NOT EXISTS auth_link_audit_insert_collision
 BEFORE INSERT ON coordinator_auth_link_audit_log
 WHEN EXISTS (SELECT 1 FROM coordinator_auth_link_audit_log a
  WHERE a.rowid = NEW.rowid OR (a.coordinator_id = NEW.coordinator_id
   AND a.link_id = NEW.link_id AND a.action = NEW.action))
 BEGIN SELECT RAISE(ABORT, 'auth_link_audit_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_link_audit_immutable_update
 BEFORE UPDATE ON coordinator_auth_link_audit_log
 BEGIN SELECT RAISE(ABORT, 'auth_link_audit_immutable'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_link_audit_immutable_delete
 BEFORE DELETE ON coordinator_auth_link_audit_log
 BEGIN SELECT RAISE(ABORT, 'auth_link_audit_immutable'); END;`,
] as const);
