import { authLinkLiveGenerationSql } from "./coordinator-auth-link-liveness.js";

/** Inert V3 DDL only. Install after historical copies and association backfill.
 * These pins are not Google verification, key derivation, or current authority.
 * Future signed writers must check those proofs and current config in their CAS.
 */
const LIVE_STATES = "('pending','browser_claimed','oidc_verified','confirmed')";
const TABLE = "coordinator_auth_link_change_attempts";

function text(column: string, max = 256): string {
	return `typeof(${column}) = 'text' AND length(${column}) BETWEEN 1 AND ${max}
 AND ${column} = trim(${column}) AND instr(${column}, char(0)) = 0`;
}

function hash(column: string): string {
	return `typeof(${column}) = 'text' AND length(${column}) = 64
 AND ${column} NOT GLOB '*[^0-9a-f]*' AND instr(${column}, char(0)) = 0`;
}

function timestamp(column: string): string {
	return `typeof(${column}) = 'integer' AND ${column} >= created_at_ms AND ${column} < expires_at_ms`;
}

export const AUTH_LINK_CHANGE_ATTEMPT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
 coordinator_id TEXT NOT NULL CHECK (${text("coordinator_id")}),
 attempt_id TEXT NOT NULL CHECK (${text("attempt_id")}),
 purpose TEXT NOT NULL CHECK (purpose = 'coordinator-account-link-change-v1'),
 intent TEXT NOT NULL CHECK (intent IN ('disconnect','refresh')),
 target_link_id TEXT NOT NULL CHECK (${text("target_link_id")}),
 target_generation INTEGER NOT NULL CHECK (typeof(target_generation) = 'integer' AND target_generation BETWEEN 1 AND 9007199254740991),
 identity_id TEXT NOT NULL CHECK (${text("identity_id")}),
 issuer TEXT NOT NULL CHECK (${text("issuer", 2048)}),
 target_subject TEXT NOT NULL CHECK (typeof(target_subject) = 'text' AND length(target_subject) BETWEEN 1 AND 255 AND instr(target_subject, char(0)) = 0),
 group_id TEXT NOT NULL CHECK (${text("group_id")}),
 device_id TEXT NOT NULL CHECK (${text("device_id")}),
 public_key TEXT NOT NULL CHECK (typeof(public_key) = 'text' AND length(public_key) BETWEEN 1 AND 4096
  AND length(trim(replace(replace(public_key, char(13), ''), char(10), ''))) > 0 AND instr(public_key, char(0)) = 0),
 fingerprint TEXT NOT NULL CHECK (${hash("fingerprint")}),
 key_id TEXT NOT NULL CHECK (${hash("key_id")}),
 authority_kind TEXT NOT NULL CHECK (authority_kind IN ('controller_attestation','device_claim')),
 controller_attestation_id TEXT CHECK (controller_attestation_id IS NULL OR (${text("controller_attestation_id")})),
 controller_review_receipt_id TEXT CHECK (controller_review_receipt_id IS NULL OR (${text("controller_review_receipt_id")})),
 controller_revision INTEGER,
 device_claim_id TEXT CHECK (device_claim_id IS NULL OR (${text("device_claim_id")})),
 auth_config_revision TEXT NOT NULL CHECK (${hash("auth_config_revision")}),
 origin TEXT NOT NULL CHECK (${text("origin", 2048)}),
 loopback_redirect TEXT NOT NULL CHECK (${text("loopback_redirect", 2048)}),
 runtime_verifier_hash TEXT NOT NULL CHECK (${hash("runtime_verifier_hash")}),
 browser_start_hash TEXT NOT NULL CHECK (${hash("browser_start_hash")}),
 browser_transaction_hash TEXT CHECK (browser_transaction_hash IS NULL OR (${hash("browser_transaction_hash")})),
 browser_binder_hash TEXT CHECK (browser_binder_hash IS NULL OR (${hash("browser_binder_hash")})),
 browser_sequence INTEGER CHECK (browser_sequence IS NULL OR (typeof(browser_sequence) = 'integer' AND browser_sequence BETWEEN 1 AND 9007199254740990)),
 account_subject TEXT CHECK (account_subject IS NULL OR (typeof(account_subject) = 'text' AND account_subject = target_subject)),
 completion_secret_hash TEXT CHECK (completion_secret_hash IS NULL OR (${hash("completion_secret_hash")})),
 state TEXT NOT NULL CHECK (state IN ('pending','browser_claimed','oidc_verified','confirmed','completed','failed','expired')),
 failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN ('device_cancelled','browser_cancelled','provider_failure','config_failure')),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254140991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms = created_at_ms + 600000),
 claimed_at_ms INTEGER CHECK (claimed_at_ms IS NULL OR (${timestamp("claimed_at_ms")})),
 oidc_verified_at_ms INTEGER CHECK (oidc_verified_at_ms IS NULL OR (${timestamp("oidc_verified_at_ms")})),
 confirmed_at_ms INTEGER CHECK (confirmed_at_ms IS NULL OR (${timestamp("confirmed_at_ms")})),
 completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR (${timestamp("completed_at_ms")})),
 failed_at_ms INTEGER CHECK (failed_at_ms IS NULL OR (typeof(failed_at_ms) = 'integer' AND failed_at_ms BETWEEN created_at_ms AND 9007199254740991)),
 PRIMARY KEY (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, runtime_verifier_hash),
 UNIQUE (coordinator_id, browser_start_hash),
 UNIQUE (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, completion_secret_hash),
 CHECK ((authority_kind = 'controller_attestation' AND controller_attestation_id IS NOT NULL
  AND controller_review_receipt_id IS NOT NULL AND controller_revision IS NOT NULL
  AND typeof(controller_revision) = 'integer' AND controller_revision = 1 AND device_claim_id IS NULL)
  OR (authority_kind = 'device_claim' AND device_claim_id IS NOT NULL AND controller_attestation_id IS NULL
   AND controller_review_receipt_id IS NULL AND controller_revision IS NULL)),
 CHECK ((browser_transaction_hash IS NULL) = (browser_sequence IS NULL)
  AND (browser_transaction_hash IS NULL) = (browser_binder_hash IS NULL)
  AND (browser_transaction_hash IS NULL) = (claimed_at_ms IS NULL)),
 CHECK ((account_subject IS NULL) = (oidc_verified_at_ms IS NULL)),
 CHECK ((completion_secret_hash IS NULL) = (confirmed_at_ms IS NULL)),
 CHECK (oidc_verified_at_ms IS NULL OR (claimed_at_ms IS NOT NULL AND oidc_verified_at_ms >= claimed_at_ms)),
 CHECK (confirmed_at_ms IS NULL OR (oidc_verified_at_ms IS NOT NULL AND confirmed_at_ms >= oidc_verified_at_ms)),
 CHECK (completed_at_ms IS NULL OR (confirmed_at_ms IS NOT NULL AND completed_at_ms >= confirmed_at_ms)),
 CHECK (failed_at_ms IS NULL OR (failed_at_ms >= coalesce(confirmed_at_ms, oidc_verified_at_ms, claimed_at_ms, created_at_ms))),
 CHECK (state <> 'pending' OR browser_transaction_hash IS NULL),
 CHECK (state NOT IN ('pending','browser_claimed') OR account_subject IS NULL),
 CHECK (state NOT IN ('pending','browser_claimed','oidc_verified') OR completion_secret_hash IS NULL),
 CHECK (state NOT IN ('browser_claimed','oidc_verified','confirmed','completed') OR browser_transaction_hash IS NOT NULL),
 CHECK (state NOT IN ('oidc_verified','confirmed','completed') OR account_subject IS NOT NULL),
 CHECK (state NOT IN ('confirmed','completed') OR completion_secret_hash IS NOT NULL),
 CHECK ((state = 'completed') = (completed_at_ms IS NOT NULL)),
 CHECK ((state = 'failed' AND failure_reason IS NOT NULL AND failed_at_ms IS NOT NULL)
  OR (state <> 'failed' AND failure_reason IS NULL AND failed_at_ms IS NULL))
);`;

export const AUTH_LINK_CHANGE_ATTEMPT_INDEX_STATEMENTS = Object.freeze([
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_link_change_active_identity
 ON ${TABLE}(coordinator_id, identity_id) WHERE state IN ${LIVE_STATES};`,
	`CREATE INDEX IF NOT EXISTS idx_auth_link_change_device_created
 ON ${TABLE}(coordinator_id, group_id, device_id, created_at_ms);`,
	`CREATE INDEX IF NOT EXISTS idx_auth_link_change_identity_expiry
 ON ${TABLE}(coordinator_id, identity_id, expires_at_ms);`,
	`CREATE INDEX IF NOT EXISTS idx_auth_link_change_state_expiry
 ON ${TABLE}(coordinator_id, state, expires_at_ms);`,
] as const);

const BIRTH_COLUMNS = [
	"coordinator_id",
	"attempt_id",
	"purpose",
	"intent",
	"target_link_id",
	"target_generation",
	"identity_id",
	"issuer",
	"target_subject",
	"group_id",
	"device_id",
	"public_key",
	"fingerprint",
	"key_id",
	"authority_kind",
	"controller_attestation_id",
	"controller_review_receipt_id",
	"controller_revision",
	"device_claim_id",
	"auth_config_revision",
	"origin",
	"loopback_redirect",
	"runtime_verifier_hash",
	"browser_start_hash",
	"created_at_ms",
	"expires_at_ms",
] as const;

const PHASE_COLUMNS = [
	["browser_transaction_hash", "pending", "browser_claimed"],
	["browser_binder_hash", "pending", "browser_claimed"],
	["browser_sequence", "pending", "browser_claimed"],
	["claimed_at_ms", "pending", "browser_claimed"],
	["account_subject", "browser_claimed", "oidc_verified"],
	["oidc_verified_at_ms", "browser_claimed", "oidc_verified"],
	["completion_secret_hash", "oidc_verified", "confirmed"],
	["confirmed_at_ms", "oidc_verified", "confirmed"],
	["completed_at_ms", "confirmed", "completed"],
] as const;

// Shared by INSERT and UPDATE: REPLACE must not silently evict any retained row,
// even with recursive_triggers OFF. Exact retries read receipts, never upsert.
const COLLISION_SQL = `a.rowid = NEW.rowid OR (a.coordinator_id = NEW.coordinator_id AND (
 a.attempt_id = NEW.attempt_id OR a.runtime_verifier_hash = NEW.runtime_verifier_hash
 OR a.browser_start_hash = NEW.browser_start_hash OR a.browser_transaction_hash = NEW.browser_transaction_hash
 OR a.completion_secret_hash = NEW.completion_secret_hash
 OR (a.identity_id = NEW.identity_id AND a.state IN ${LIVE_STATES} AND NEW.state IN ${LIVE_STATES})))`;

// Check before recording success: a later zero-row end CAS cannot undo a receipt.
// Current signer eligibility and crypto verification remain the writer's job.
const LIVE_TARGET_SQL = `EXISTS (SELECT 1 FROM coordinator_auth_account_links l
 WHERE l.coordinator_id = NEW.coordinator_id AND l.link_id = NEW.target_link_id
 AND l.generation = NEW.target_generation AND l.identity_id = NEW.identity_id
 AND l.issuer = NEW.issuer AND l.subject = NEW.target_subject
 AND l.authority_kind = NEW.authority_kind
 AND (NEW.authority_kind <> 'device_claim' OR l.device_claim_id = NEW.device_claim_id)
 AND ${authLinkLiveGenerationSql({ link: "l" })})`;

export const AUTH_LINK_CHANGE_ATTEMPT_GUARD_STATEMENTS = Object.freeze([
	`CREATE TRIGGER IF NOT EXISTS auth_link_change_insert_live_target
 BEFORE INSERT ON ${TABLE} WHEN NOT ${LIVE_TARGET_SQL}
 BEGIN SELECT RAISE(ABORT, 'auth_link_change_target_unavailable'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_link_change_complete_live_target
 BEFORE UPDATE ON ${TABLE}
 WHEN NEW.state = 'completed' AND OLD.state <> NEW.state AND NOT ${LIVE_TARGET_SQL}
 BEGIN SELECT RAISE(ABORT, 'auth_link_change_target_unavailable'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_link_change_insert_collision
 BEFORE INSERT ON ${TABLE}
 WHEN EXISTS (SELECT 1 FROM ${TABLE} a WHERE ${COLLISION_SQL})
 BEGIN SELECT RAISE(ABORT, 'auth_link_change_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_link_change_insert_pending
 BEFORE INSERT ON ${TABLE} WHEN NEW.state <> 'pending'
 BEGIN SELECT RAISE(ABORT, 'auth_link_change_birth_invalid'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_link_change_update_collision
 BEFORE UPDATE ON ${TABLE}
 WHEN EXISTS (SELECT 1 FROM ${TABLE} a WHERE a.rowid <> OLD.rowid AND (${COLLISION_SQL}))
 BEGIN SELECT RAISE(ABORT, 'auth_link_change_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_link_change_pins_update
 BEFORE UPDATE ON ${TABLE}
 WHEN OLD.rowid IS NOT NEW.rowid
 OR ${BIRTH_COLUMNS.map((column) => `OLD.${column} IS NOT NEW.${column}`).join("\n OR ")}
 OR ${PHASE_COLUMNS.map(
		([column, from, to]) => `(OLD.${column} IS NOT NEW.${column}
  AND NOT (OLD.${column} IS NULL AND NEW.${column} IS NOT NULL AND OLD.state = '${from}' AND NEW.state = '${to}'))`,
 ).join("\n OR ")}
 OR (OLD.failure_reason IS NOT NEW.failure_reason AND NOT (OLD.state IN ${LIVE_STATES} AND NEW.state = 'failed'))
 OR (OLD.failed_at_ms IS NOT NEW.failed_at_ms AND NOT (OLD.state IN ${LIVE_STATES} AND NEW.state = 'failed'))
 BEGIN SELECT RAISE(ABORT, 'auth_link_change_pins_immutable'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_link_change_state_update
 BEFORE UPDATE ON ${TABLE} WHEN OLD.state IS NOT NEW.state AND NOT (
  (OLD.state = 'pending' AND NEW.state = 'browser_claimed')
  OR (OLD.state = 'browser_claimed' AND NEW.state = 'oidc_verified')
  OR (OLD.state = 'oidc_verified' AND NEW.state = 'confirmed')
  OR (OLD.state = 'confirmed' AND NEW.state = 'completed')
  OR (OLD.state IN ${LIVE_STATES} AND NEW.state IN ('failed','expired')))
 BEGIN SELECT RAISE(ABORT, 'auth_link_change_transition_invalid'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_link_change_completed_update
 BEFORE UPDATE ON ${TABLE} WHEN OLD.state = 'completed'
 BEGIN SELECT RAISE(ABORT, 'auth_link_change_receipt_immutable'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_link_change_completed_delete
 BEFORE DELETE ON ${TABLE} WHEN OLD.state = 'completed'
 BEGIN SELECT RAISE(ABORT, 'auth_link_change_receipt_immutable'); END;`,
] as const);

/** The attempt completes first, then the target ends in the same future batch.
 * This checks retained metadata, not current enrollment/attestation eligibility.
 * Birth config need not equal the fresh attempt's same-issuer config revision.
 */
export const AUTH_LINK_CHANGE_END_RECEIPT_GUARD_SQL = `
CREATE TRIGGER IF NOT EXISTS auth_account_links_end_receipt
 BEFORE UPDATE ON coordinator_auth_account_links
 WHEN OLD.ended_at_ms IS NULL AND NEW.ended_at_ms IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ${TABLE} a JOIN coordinator_auth_account_links l
   ON l.coordinator_id = OLD.coordinator_id AND l.link_id = OLD.link_id
  WHERE a.coordinator_id = l.coordinator_id AND a.attempt_id = NEW.end_attempt_id
   AND a.intent = 'disconnect' AND a.state = 'completed'
   AND a.purpose = 'coordinator-account-link-change-v1'
   AND a.target_link_id = l.link_id AND a.target_generation = l.generation
   AND a.identity_id = l.identity_id AND a.issuer = l.issuer
   AND a.target_subject = l.subject AND a.account_subject = l.subject
   AND a.completed_at_ms = NEW.ended_at_ms AND NEW.end_reason = 'user_disconnected'
   AND a.authority_kind = l.authority_kind
   AND ${authLinkLiveGenerationSql({ link: "l" })}
   AND ((a.authority_kind = 'controller_attestation' AND a.device_claim_id IS NULL
    AND a.controller_attestation_id IS NOT NULL AND a.controller_review_receipt_id IS NOT NULL
    AND a.controller_revision = 1)
    OR (a.authority_kind = 'device_claim' AND a.device_claim_id = l.device_claim_id
     AND a.controller_attestation_id IS NULL AND a.controller_review_receipt_id IS NULL
     AND a.controller_revision IS NULL AND EXISTS (
      SELECT 1 FROM coordinator_auth_device_claims d WHERE d.claim_id = a.device_claim_id
       AND d.coordinator_id = a.coordinator_id AND d.identity_id = a.identity_id
       AND d.device_id = a.device_id AND d.public_key = a.public_key
       AND d.fingerprint = a.fingerprint AND d.key_id = a.key_id AND d.issuer = a.issuer)))
 )
 BEGIN SELECT RAISE(ABORT, 'auth_link_change_end_receipt_invalid'); END;`;
