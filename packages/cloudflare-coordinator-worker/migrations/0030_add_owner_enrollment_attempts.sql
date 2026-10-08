-- No cascading references: finalized attempts retain exact reconciliation evidence.
CREATE TABLE IF NOT EXISTS coordinator_owner_enrollment_attempts (
 coordinator_id TEXT NOT NULL CHECK (typeof(coordinator_id) = 'text' AND length(trim(coordinator_id)) BETWEEN 1 AND 256 AND instr(coordinator_id, char(0)) = 0),
 attempt_id TEXT NOT NULL CHECK (typeof(attempt_id) = 'text' AND length(trim(attempt_id)) BETWEEN 1 AND 256 AND instr(attempt_id, char(0)) = 0),
 purpose TEXT NOT NULL CHECK (purpose = 'owner_enroll'),
 origin TEXT NOT NULL CHECK (typeof(origin) = 'text' AND length(trim(origin)) > 0 AND instr(origin, char(0)) = 0),
 device_id TEXT NOT NULL CHECK (typeof(device_id) = 'text' AND length(trim(device_id)) BETWEEN 1 AND 256 AND instr(device_id, char(0)) = 0),
 public_key TEXT NOT NULL CHECK (typeof(public_key) = 'text' AND length(trim(public_key)) > 0 AND instr(public_key, char(0)) = 0),
 key_id TEXT NOT NULL CHECK (typeof(key_id) = 'text' AND length(key_id) = 64 AND key_id NOT GLOB '*[^0-9a-f]*' AND instr(key_id, char(0)) = 0),
 fingerprint TEXT NOT NULL CHECK (typeof(fingerprint) = 'text' AND length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*' AND instr(fingerprint, char(0)) = 0),
 issuer TEXT NOT NULL CHECK (typeof(issuer) = 'text' AND length(trim(issuer)) > 0 AND instr(issuer, char(0)) = 0),
 auth_config_revision TEXT NOT NULL CHECK (typeof(auth_config_revision) = 'text' AND length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*' AND instr(auth_config_revision, char(0)) = 0),
 loopback_redirect TEXT CHECK (loopback_redirect IS NULL OR (typeof(loopback_redirect) = 'text' AND length(trim(loopback_redirect)) > 0 AND instr(loopback_redirect, char(0)) = 0)),
 browser_start_hash TEXT NOT NULL CHECK (typeof(browser_start_hash) = 'text' AND length(browser_start_hash) = 64 AND browser_start_hash NOT GLOB '*[^0-9a-f]*' AND instr(browser_start_hash, char(0)) = 0),
 browser_transaction_hash TEXT CHECK (browser_transaction_hash IS NULL OR (typeof(browser_transaction_hash) = 'text' AND length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*' AND instr(browser_transaction_hash, char(0)) = 0)),
 browser_binder_hash TEXT CHECK (browser_binder_hash IS NULL OR (typeof(browser_binder_hash) = 'text' AND length(browser_binder_hash) = 64 AND browser_binder_hash NOT GLOB '*[^0-9a-f]*' AND instr(browser_binder_hash, char(0)) = 0)),
 account_subject TEXT CHECK (account_subject IS NULL OR (typeof(account_subject) = 'text' AND length(account_subject) BETWEEN 1 AND 255 AND instr(account_subject, char(0)) = 0)),
 identity_id TEXT CHECK (identity_id IS NULL OR (typeof(identity_id) = 'text' AND length(trim(identity_id)) BETWEEN 1 AND 256 AND instr(identity_id, char(0)) = 0)),
 link_id TEXT CHECK (link_id IS NULL OR (typeof(link_id) = 'text' AND length(trim(link_id)) BETWEEN 1 AND 256 AND instr(link_id, char(0)) = 0)),
 link_attempt_id TEXT CHECK (link_attempt_id IS NULL OR (typeof(link_attempt_id) = 'text' AND length(trim(link_attempt_id)) BETWEEN 1 AND 256 AND instr(link_attempt_id, char(0)) = 0)),
 link_controller_attestation_id TEXT CHECK (link_controller_attestation_id IS NULL OR (typeof(link_controller_attestation_id) = 'text' AND length(trim(link_controller_attestation_id)) BETWEEN 1 AND 256 AND instr(link_controller_attestation_id, char(0)) = 0)),
 link_auth_config_revision TEXT CHECK (link_auth_config_revision IS NULL OR (typeof(link_auth_config_revision) = 'text' AND length(link_auth_config_revision) = 64 AND link_auth_config_revision NOT GLOB '*[^0-9a-f]*' AND instr(link_auth_config_revision, char(0)) = 0)),
 grant_revisions_json TEXT CHECK (grant_revisions_json IS NULL OR (typeof(grant_revisions_json) = 'text' AND json_valid(grant_revisions_json) AND json_type(grant_revisions_json) = 'array')),
 confirmation_hash TEXT CHECK (confirmation_hash IS NULL OR (typeof(confirmation_hash) = 'text' AND length(confirmation_hash) = 64 AND confirmation_hash NOT GLOB '*[^0-9a-f]*' AND instr(confirmation_hash, char(0)) = 0)),
 completion_secret_hash TEXT CHECK (completion_secret_hash IS NULL OR (typeof(completion_secret_hash) = 'text' AND length(completion_secret_hash) = 64 AND completion_secret_hash NOT GLOB '*[^0-9a-f]*' AND instr(completion_secret_hash, char(0)) = 0)),
 final_key_proof_hash TEXT CHECK (final_key_proof_hash IS NULL OR (typeof(final_key_proof_hash) = 'text' AND length(final_key_proof_hash) = 64 AND final_key_proof_hash NOT GLOB '*[^0-9a-f]*' AND instr(final_key_proof_hash, char(0)) = 0)),
 state TEXT NOT NULL CHECK (state IN ('pending','browser_claimed','oidc_verified','confirmed','finalized','expired','failed','retired')),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254140991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms = created_at_ms + 600000),
 finalized_at_ms INTEGER CHECK (finalized_at_ms IS NULL OR (typeof(finalized_at_ms) = 'integer' AND finalized_at_ms >= created_at_ms AND finalized_at_ms < expires_at_ms)),
 binding_id TEXT CHECK (binding_id IS NULL OR (typeof(binding_id) = 'text' AND length(trim(binding_id)) BETWEEN 1 AND 256 AND instr(binding_id, char(0)) = 0)),
 audit_event_id TEXT CHECK (audit_event_id IS NULL OR (typeof(audit_event_id) = 'text' AND length(trim(audit_event_id)) BETWEEN 1 AND 256 AND instr(audit_event_id, char(0)) = 0)),
 final_outcome_json TEXT CHECK (final_outcome_json IS NULL OR (typeof(final_outcome_json) = 'text' AND json_valid(final_outcome_json) AND json_type(final_outcome_json) = 'object')),
 PRIMARY KEY (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, browser_start_hash),
 UNIQUE (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, completion_secret_hash),
 CHECK (state NOT IN ('pending','browser_claimed','oidc_verified','confirmed') OR loopback_redirect IS NOT NULL),
 CHECK (state <> 'pending' OR browser_transaction_hash IS NULL),
 CHECK ((browser_transaction_hash IS NULL) = (browser_binder_hash IS NULL)),
 CHECK (state NOT IN ('pending','browser_claimed') OR account_subject IS NULL),
 CHECK (state NOT IN ('pending','browser_claimed','oidc_verified') OR (confirmation_hash IS NULL AND completion_secret_hash IS NULL)),
 CHECK (state NOT IN ('browser_claimed','oidc_verified','confirmed','finalized') OR browser_transaction_hash IS NOT NULL),
 CHECK ((account_subject IS NULL AND identity_id IS NULL AND link_id IS NULL AND link_attempt_id IS NULL AND link_controller_attestation_id IS NULL AND link_auth_config_revision IS NULL AND grant_revisions_json IS NULL) OR (account_subject IS NOT NULL AND identity_id IS NOT NULL AND link_id IS NOT NULL AND link_attempt_id IS NOT NULL AND link_controller_attestation_id IS NOT NULL AND link_auth_config_revision IS NOT NULL AND grant_revisions_json IS NOT NULL)),
 CHECK (state NOT IN ('oidc_verified','confirmed','finalized') OR account_subject IS NOT NULL),
 CHECK (state NOT IN ('confirmed','finalized') OR (confirmation_hash IS NOT NULL AND completion_secret_hash IS NOT NULL)),
 CHECK ((state = 'finalized' AND finalized_at_ms IS NOT NULL AND binding_id IS NOT NULL AND audit_event_id IS NOT NULL AND final_outcome_json IS NOT NULL AND final_key_proof_hash IS NOT NULL AND loopback_redirect IS NULL) OR (state <> 'finalized' AND finalized_at_ms IS NULL AND binding_id IS NULL AND audit_event_id IS NULL AND final_outcome_json IS NULL AND final_key_proof_hash IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_owner_enrollment_device_created
 ON coordinator_owner_enrollment_attempts(coordinator_id, device_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_owner_enrollment_identity_expiry
 ON coordinator_owner_enrollment_attempts(coordinator_id, identity_id, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_owner_enrollment_state_expiry
 ON coordinator_owner_enrollment_attempts(coordinator_id, state, expires_at_ms);
-- Birth facts and recorded commitments survive retries and transient browser cleanup.
CREATE TRIGGER IF NOT EXISTS owner_enrollment_pins_update
BEFORE UPDATE ON coordinator_owner_enrollment_attempts WHEN OLD.state <> 'finalized' AND (
 OLD.coordinator_id IS NOT NEW.coordinator_id OR OLD.attempt_id IS NOT NEW.attempt_id
 OR OLD.purpose IS NOT NEW.purpose OR OLD.origin IS NOT NEW.origin
 OR OLD.device_id IS NOT NEW.device_id OR OLD.public_key IS NOT NEW.public_key
 OR OLD.key_id IS NOT NEW.key_id OR OLD.fingerprint IS NOT NEW.fingerprint
 OR OLD.issuer IS NOT NEW.issuer OR OLD.auth_config_revision IS NOT NEW.auth_config_revision
 OR OLD.browser_start_hash IS NOT NEW.browser_start_hash
 OR OLD.created_at_ms IS NOT NEW.created_at_ms OR OLD.expires_at_ms IS NOT NEW.expires_at_ms
 OR (OLD.loopback_redirect IS NOT NEW.loopback_redirect AND NOT (
  OLD.loopback_redirect IS NOT NULL AND NEW.loopback_redirect IS NULL
  AND NEW.state IN ('finalized','expired','failed','retired')))
 OR (OLD.browser_transaction_hash IS NOT NULL AND OLD.browser_transaction_hash IS NOT NEW.browser_transaction_hash)
 OR (OLD.browser_binder_hash IS NOT NULL AND OLD.browser_binder_hash IS NOT NEW.browser_binder_hash)
 OR (OLD.account_subject IS NOT NULL AND OLD.account_subject IS NOT NEW.account_subject)
 OR (OLD.identity_id IS NOT NULL AND OLD.identity_id IS NOT NEW.identity_id)
 OR (OLD.link_id IS NOT NULL AND OLD.link_id IS NOT NEW.link_id)
 OR (OLD.link_attempt_id IS NOT NULL AND OLD.link_attempt_id IS NOT NEW.link_attempt_id)
 OR (OLD.link_controller_attestation_id IS NOT NULL AND OLD.link_controller_attestation_id IS NOT NEW.link_controller_attestation_id)
 OR (OLD.link_auth_config_revision IS NOT NULL AND OLD.link_auth_config_revision IS NOT NEW.link_auth_config_revision)
 OR (OLD.grant_revisions_json IS NOT NULL AND OLD.grant_revisions_json IS NOT NEW.grant_revisions_json)
 OR (OLD.confirmation_hash IS NOT NULL AND OLD.confirmation_hash IS NOT NEW.confirmation_hash)
 OR (OLD.completion_secret_hash IS NOT NULL AND OLD.completion_secret_hash IS NOT NEW.completion_secret_hash)
 OR (OLD.browser_transaction_hash IS NULL AND NEW.browser_transaction_hash IS NOT NULL
  AND NOT (OLD.state = 'pending' AND NEW.state = 'browser_claimed'))
 OR (OLD.account_subject IS NULL AND NEW.account_subject IS NOT NULL
  AND NOT (OLD.state = 'browser_claimed' AND NEW.state = 'oidc_verified'))
 OR ((OLD.confirmation_hash IS NULL AND NEW.confirmation_hash IS NOT NULL
  OR OLD.completion_secret_hash IS NULL AND NEW.completion_secret_hash IS NOT NULL)
  AND NOT (OLD.state = 'oidc_verified' AND NEW.state = 'confirmed'))
 OR (OLD.state IN ('expired','failed','retired') AND OLD.state IS NOT NEW.state)
 OR (EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a WHERE a.state <> 'finalized'
  AND a.rowid <> OLD.rowid AND (a.rowid = NEW.rowid OR (a.coordinator_id = NEW.coordinator_id
  AND (a.attempt_id = NEW.attempt_id OR a.browser_start_hash = NEW.browser_start_hash
  OR a.browser_transaction_hash = NEW.browser_transaction_hash OR a.completion_secret_hash = NEW.completion_secret_hash))))
  AND NOT EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a WHERE a.state = 'finalized'
   AND a.rowid <> OLD.rowid AND (a.rowid = NEW.rowid OR (a.coordinator_id = NEW.coordinator_id
   AND (a.attempt_id = NEW.attempt_id OR a.browser_start_hash = NEW.browser_start_hash
   OR a.browser_transaction_hash = NEW.browser_transaction_hash OR a.completion_secret_hash = NEW.completion_secret_hash)))))
)
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_pins_immutable'); END;
-- REPLACE can delete a conflicting row without running UPDATE or DELETE triggers.
CREATE TRIGGER IF NOT EXISTS owner_enrollment_pins_insert
BEFORE INSERT ON coordinator_owner_enrollment_attempts
WHEN EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a WHERE a.state <> 'finalized'
 AND (a.rowid = NEW.rowid OR (a.coordinator_id = NEW.coordinator_id AND (a.attempt_id = NEW.attempt_id
 OR a.browser_start_hash = NEW.browser_start_hash OR a.browser_transaction_hash = NEW.browser_transaction_hash
 OR a.completion_secret_hash = NEW.completion_secret_hash)))
 AND (a.coordinator_id,a.attempt_id,a.purpose,a.origin,a.device_id,a.public_key,a.key_id,a.fingerprint,
  a.issuer,a.auth_config_revision,a.loopback_redirect,a.browser_start_hash,a.browser_transaction_hash,a.browser_binder_hash,
  a.account_subject,a.identity_id,a.link_id,a.link_attempt_id,a.link_controller_attestation_id,a.link_auth_config_revision,
  a.grant_revisions_json,a.confirmation_hash,a.completion_secret_hash,a.final_key_proof_hash,a.state,
  a.created_at_ms,a.expires_at_ms,a.finalized_at_ms,a.binding_id,a.audit_event_id,a.final_outcome_json)
 IS NOT (NEW.coordinator_id,NEW.attempt_id,NEW.purpose,NEW.origin,NEW.device_id,NEW.public_key,NEW.key_id,NEW.fingerprint,
  NEW.issuer,NEW.auth_config_revision,NEW.loopback_redirect,NEW.browser_start_hash,NEW.browser_transaction_hash,NEW.browser_binder_hash,
  NEW.account_subject,NEW.identity_id,NEW.link_id,NEW.link_attempt_id,NEW.link_controller_attestation_id,NEW.link_auth_config_revision,
  NEW.grant_revisions_json,NEW.confirmation_hash,NEW.completion_secret_hash,NEW.final_key_proof_hash,NEW.state,
  NEW.created_at_ms,NEW.expires_at_ms,NEW.finalized_at_ms,NEW.binding_id,NEW.audit_event_id,NEW.final_outcome_json))
 AND NOT EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a WHERE a.state = 'finalized'
  AND (a.rowid = NEW.rowid OR (a.coordinator_id = NEW.coordinator_id AND (a.attempt_id = NEW.attempt_id
  OR a.browser_start_hash = NEW.browser_start_hash OR a.browser_transaction_hash = NEW.browser_transaction_hash
  OR a.completion_secret_hash = NEW.completion_secret_hash))))
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_pins_immutable'); END;
-- Retained receipts cannot be changed, deleted, or erased through REPLACE.
CREATE TRIGGER IF NOT EXISTS owner_enrollment_finalized_update
BEFORE UPDATE ON coordinator_owner_enrollment_attempts WHEN OLD.state = 'finalized'
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_receipt_immutable'); END;
CREATE TRIGGER IF NOT EXISTS owner_enrollment_finalized_update_collision
BEFORE UPDATE ON coordinator_owner_enrollment_attempts
WHEN EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a WHERE a.state = 'finalized'
 AND a.rowid <> OLD.rowid AND (a.rowid = NEW.rowid OR (a.coordinator_id = NEW.coordinator_id
 AND (a.attempt_id = NEW.attempt_id OR a.browser_start_hash = NEW.browser_start_hash
 OR a.browser_transaction_hash = NEW.browser_transaction_hash OR a.completion_secret_hash = NEW.completion_secret_hash))))
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_receipt_immutable'); END;
CREATE TRIGGER IF NOT EXISTS owner_enrollment_finalized_delete
BEFORE DELETE ON coordinator_owner_enrollment_attempts WHEN OLD.state = 'finalized'
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_receipt_immutable'); END;
CREATE TRIGGER IF NOT EXISTS owner_enrollment_finalized_replace
BEFORE INSERT ON coordinator_owner_enrollment_attempts
WHEN EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a WHERE a.state = 'finalized'
 AND (a.rowid = NEW.rowid OR (a.coordinator_id = NEW.coordinator_id AND (a.attempt_id = NEW.attempt_id
 OR a.browser_start_hash = NEW.browser_start_hash OR a.browser_transaction_hash = NEW.browser_transaction_hash
 OR a.completion_secret_hash = NEW.completion_secret_hash))))
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_receipt_immutable'); END;
