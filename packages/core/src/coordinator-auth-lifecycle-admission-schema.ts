import { authLinkLiveGenerationSql } from "./coordinator-auth-link-liveness.js";

/** Inert V3 definitions, not an initializer or complete authentication policy.
 * Install after historical copies, association backfill and browser rebuilding.
 * Signed writers still own current config, provider verification, canonical-key
 * derivation, authority provenance and the winning reconnect CAS.
 */
export const AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS = Object.freeze([
	`ALTER TABLE coordinator_auth_link_attempts ADD COLUMN prior_link_id TEXT
 CHECK (prior_link_id IS NULL OR (typeof(prior_link_id) = 'text'
  AND length(prior_link_id) BETWEEN 1 AND 256 AND prior_link_id = trim(prior_link_id)
  AND instr(prior_link_id, char(0)) = 0));`,
	`ALTER TABLE coordinator_auth_link_attempts ADD COLUMN prior_generation INTEGER
 CHECK ((prior_link_id IS NULL AND prior_generation IS NULL)
  OR (prior_link_id IS NOT NULL AND prior_generation IS NOT NULL
   AND typeof(prior_generation) = 'integer' AND prior_generation BETWEEN 1 AND 9007199254740991));`,
] as const);

export const AUTH_LIFECYCLE_CONTINUATION_GUARD_STATEMENTS = Object.freeze([
	`CREATE TRIGGER IF NOT EXISTS auth_link_attempts_continuation_insert
 BEFORE INSERT ON coordinator_auth_link_attempts
 WHEN (NEW.prior_link_id IS NULL) IS NOT (NEW.prior_generation IS NULL)
 OR (NEW.prior_link_id IS NOT NULL AND (
  typeof(NEW.prior_link_id) <> 'text' OR length(NEW.prior_link_id) NOT BETWEEN 1 AND 256
  OR NEW.prior_link_id <> trim(NEW.prior_link_id) OR instr(NEW.prior_link_id, char(0)) <> 0
  OR typeof(NEW.prior_generation) <> 'integer'
  OR NEW.prior_generation NOT BETWEEN 1 AND 9007199254740991))
 BEGIN SELECT RAISE(ABORT, 'auth_link_continuation_invalid'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_link_attempts_continuation_immutable
 BEFORE UPDATE ON coordinator_auth_link_attempts
 WHEN OLD.prior_link_id IS NOT NEW.prior_link_id OR OLD.prior_generation IS NOT NEW.prior_generation
 BEGIN SELECT RAISE(ABORT, 'auth_link_continuation_immutable'); END;`,
] as const);

/** Only private, fixed SQL aliases are accepted. Receipts precede sessions in
 * the atomic minting batch; browser consumption precedes provider verification.
 * Browser/receipt revisions describe current proof, not a link's birth config.
 */
function receiptAdmissionSql(options: { receipt: "NEW" | "r" }): string {
	const receipt = options.receipt;
	if (receipt !== "NEW" && receipt !== "r") throw new Error("auth_receipt_alias_invalid");
	// Materialize statement-local facts so session admission can recheck the full
	// receipt proof without flattening its predicates past native D1's depth limit.
	return `EXISTS (WITH live_link AS MATERIALIZED (
 SELECT l.coordinator_id, l.link_id, l.issuer, l.subject, l.identity_id, l.attempt_id,
  l.authority_kind, l.controller_attestation_id, l.auth_config_revision, l.created_at_ms,
  l.signin_sequence_floor
 FROM coordinator_auth_account_links l
 WHERE l.coordinator_id = ${receipt}.coordinator_id AND l.link_id = ${receipt}.link_id
 AND ${authLinkLiveGenerationSql({ link: "l" })}
 ), admitted_receipt AS MATERIALIZED (
 SELECT 1 FROM live_link l
 JOIN coordinator_auth_browser_transactions b
  ON b.coordinator_id = l.coordinator_id AND b.issuer = l.issuer
 WHERE b.browser_transaction_hash = ${receipt}.browser_transaction_hash
 AND b.auth_config_revision = ${receipt}.auth_config_revision
 AND b.state = 'consumed' AND b.nonce IS NULL AND b.pkce_verifier IS NULL
 AND b.claim_token IS NOT NULL AND b.consumed_at_ms IS NOT NULL
 AND b.created_at_ms <= b.consumed_at_ms
 AND b.consumed_at_ms <= ${receipt}.created_at_ms AND b.expires_at_ms > ${receipt}.created_at_ms
 AND ((${receipt}.source = 'signin' AND ${receipt}.attempt_id IS NULL
  AND b.purpose = 'signin' AND b.attempt_id IS NULL
  AND b.browser_sequence > l.signin_sequence_floor
  AND NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts signin_conflict
   WHERE signin_conflict.coordinator_id = b.coordinator_id
   AND signin_conflict.browser_transaction_hash = b.browser_transaction_hash))
 OR (${receipt}.source = 'link_redeem' AND ${receipt}.attempt_id IS NOT NULL
  AND b.purpose = 'link' AND b.attempt_id = ${receipt}.attempt_id
  AND EXISTS (SELECT 1 FROM coordinator_auth_link_attempts t
   WHERE t.coordinator_id = l.coordinator_id AND t.attempt_id = ${receipt}.attempt_id
   AND t.attempt_id = l.attempt_id AND t.link_id = l.link_id
   AND t.browser_transaction_hash = b.browser_transaction_hash
   AND t.state IN ('finalized','session_redeemed')
   AND t.identity_id = l.identity_id AND t.issuer = l.issuer AND t.account_subject = l.subject
   AND t.authority_kind = l.authority_kind
   AND t.controller_attestation_id IS l.controller_attestation_id
   AND t.auth_config_revision = l.auth_config_revision
   AND t.auth_config_revision = b.auth_config_revision
   AND t.finalized_at_ms = l.created_at_ms
   AND t.runtime_verifier_hash IS NOT NULL AND t.browser_start_hash IS NOT NULL
   AND t.completion_secret_hash IS NOT NULL
   AND t.created_at_ms <= t.claimed_at_ms AND t.claimed_at_ms <= t.oidc_verified_at_ms
   AND t.oidc_verified_at_ms <= t.confirmed_at_ms AND t.confirmed_at_ms <= t.finalized_at_ms
   AND t.finalized_at_ms <= ${receipt}.created_at_ms
   AND ${receipt}.created_at_ms < t.finalized_at_ms + 120000
   AND ${receipt}.created_at_ms < t.expires_at_ms))))
 SELECT 1 FROM admitted_receipt)`;
}

/** Admission only. Existing rows stay untouched; install these after copying.
 * Only signin compares sequence floors. Redemption proves the exact live link's
 * own attempt, whose original browser sequence can be at or below that floor.
 * Sessions must reproduce their receipt's tuple and their link's Identity/account.
 */
export const AUTH_LIFECYCLE_SESSION_ADMISSION_GUARD_STATEMENTS = Object.freeze([
	`CREATE TRIGGER IF NOT EXISTS auth_session_receipts_insert_admission
 BEFORE INSERT ON coordinator_auth_session_receipts
 WHEN NOT ${receiptAdmissionSql({ receipt: "NEW" })}
 BEGIN SELECT RAISE(ABORT, 'auth_session_admission_unavailable'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_sessions_insert_admission
 BEFORE INSERT ON coordinator_auth_sessions
 WHEN NEW.revoked_at_ms IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM coordinator_auth_session_receipts r
  JOIN coordinator_auth_account_links cl ON cl.coordinator_id = r.coordinator_id AND cl.link_id = r.link_id
  WHERE r.coordinator_id = NEW.coordinator_id AND r.browser_transaction_hash = NEW.browser_transaction_hash
  AND r.session_id = NEW.session_id AND r.link_id = NEW.link_id
  AND r.auth_config_revision = NEW.auth_config_revision AND r.created_at_ms = NEW.created_at_ms
  AND cl.identity_id = NEW.identity_id AND cl.issuer = NEW.issuer AND cl.subject = NEW.subject
  AND ${receiptAdmissionSql({ receipt: "r" })}
 )
 BEGIN SELECT RAISE(ABORT, 'auth_session_admission_unavailable'); END;`,
] as const);
