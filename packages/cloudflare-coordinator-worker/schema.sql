-- Inert historical-label receipts, not credentials or proof of authority.
-- Canonical IDs use the full ECMAScript String.trim character set, including BOM.
CREATE TABLE IF NOT EXISTS coordinator_legacy_owner_resolutions (
 coordinator_id TEXT NOT NULL CHECK (typeof(coordinator_id) = 'text' AND length(coordinator_id) BETWEEN 1 AND 256 AND length(trim(coordinator_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(coordinator_id, char(0)) = 0),
 resolution_id TEXT NOT NULL CHECK (typeof(resolution_id) = 'text' AND length(resolution_id) BETWEEN 1 AND 256 AND length(trim(resolution_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(resolution_id, char(0)) = 0),
 resolution_version INTEGER NOT NULL CHECK (typeof(resolution_version) = 'integer' AND resolution_version = 1),
 device_id TEXT NOT NULL CHECK (typeof(device_id) = 'text' AND length(device_id) BETWEEN 1 AND 256 AND length(trim(device_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(device_id, char(0)) = 0),
 key_id TEXT NOT NULL CHECK (typeof(key_id) = 'text' AND length(key_id) = 64 AND key_id NOT GLOB '*[^0-9a-f]*' AND instr(key_id, char(0)) = 0),
 owner_identity_id TEXT NOT NULL CHECK (typeof(owner_identity_id) = 'text' AND length(owner_identity_id) BETWEEN 1 AND 256 AND length(trim(owner_identity_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(owner_identity_id, char(0)) = 0),
 purpose TEXT NOT NULL CHECK (purpose = 'existing_account_owner'),
 scope TEXT NOT NULL CHECK (scope = 'historical_included_owner_labels_only'),
 source_attestation_id TEXT NOT NULL CHECK (typeof(source_attestation_id) = 'text' AND length(source_attestation_id) BETWEEN 1 AND 256 AND length(trim(source_attestation_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_attestation_id, char(0)) = 0),
 source_group_id TEXT NOT NULL CHECK (typeof(source_group_id) = 'text' AND length(source_group_id) BETWEEN 1 AND 256 AND length(trim(source_group_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_group_id, char(0)) = 0),
 source_controller_revision INTEGER NOT NULL CHECK (typeof(source_controller_revision) = 'integer' AND source_controller_revision = 1),
 source_public_key TEXT NOT NULL CHECK (typeof(source_public_key) = 'text' AND length(source_public_key) BETWEEN 1 AND 4096 AND length(trim(source_public_key, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_public_key, char(0)) = 0),
 source_fingerprint TEXT NOT NULL CHECK (typeof(source_fingerprint) = 'text' AND length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*' AND instr(source_fingerprint, char(0)) = 0),
 source_enrollment_identity_id TEXT CHECK (source_enrollment_identity_id IS NULL OR (typeof(source_enrollment_identity_id) = 'text' AND length(source_enrollment_identity_id) BETWEEN 1 AND 256 AND length(trim(source_enrollment_identity_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_enrollment_identity_id, char(0)) = 0)),
 source_created_at TEXT NOT NULL CHECK (typeof(source_created_at) = 'text' AND length(source_created_at) BETWEEN 1 AND 256 AND length(trim(source_created_at, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_created_at, char(0)) = 0),
 source_review_receipt_id TEXT NOT NULL CHECK (typeof(source_review_receipt_id) = 'text' AND length(source_review_receipt_id) BETWEEN 1 AND 256 AND length(trim(source_review_receipt_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_review_receipt_id, char(0)) = 0),
 source_evidence_digest TEXT NOT NULL CHECK (typeof(source_evidence_digest) = 'text' AND length(source_evidence_digest) = 64 AND source_evidence_digest NOT GLOB '*[^0-9a-f]*' AND instr(source_evidence_digest, char(0)) = 0),
 resolution_evidence_digest TEXT NOT NULL CHECK (typeof(resolution_evidence_digest) = 'text' AND length(resolution_evidence_digest) = 64 AND resolution_evidence_digest NOT GLOB '*[^0-9a-f]*' AND instr(resolution_evidence_digest, char(0)) = 0),
 reviewed_weak_labels_json TEXT NOT NULL CHECK (typeof(reviewed_weak_labels_json) = 'text' AND length(CAST(reviewed_weak_labels_json AS BLOB)) <= 131072 AND CASE WHEN json_valid(reviewed_weak_labels_json) THEN json_type(reviewed_weak_labels_json) = 'array' ELSE 0 END),
 created_at TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND length(created_at) BETWEEN 1 AND 256 AND length(trim(created_at, char(9)||char(10)||char(13)||' ')) > 0 AND instr(created_at, char(0)) = 0),
 CHECK (
  coordinator_id = trim(coordinator_id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
  AND resolution_id = trim(resolution_id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
  AND device_id = trim(device_id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
  AND owner_identity_id = trim(owner_identity_id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
  AND source_attestation_id = trim(source_attestation_id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
  AND source_group_id = trim(source_group_id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
  AND source_review_receipt_id = trim(source_review_receipt_id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
  AND (source_enrollment_identity_id IS NULL OR source_enrollment_identity_id = trim(source_enrollment_identity_id, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))
 ),
 PRIMARY KEY (coordinator_id, resolution_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_legacy_owner_resolutions_device
 ON coordinator_legacy_owner_resolutions (coordinator_id, device_id);

CREATE INDEX IF NOT EXISTS idx_legacy_owner_resolutions_key
 ON coordinator_legacy_owner_resolutions (coordinator_id, key_id);

-- Reject before REPLACE can erase a receipt, even with recursive triggers off.
-- Separate indexed probes keep device-OR-key conflicts coordinator-scoped.
CREATE TRIGGER IF NOT EXISTS legacy_owner_resolution_insert_collision
BEFORE INSERT ON coordinator_legacy_owner_resolutions
WHEN EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions
 WHERE coordinator_id = NEW.coordinator_id AND resolution_id = NEW.resolution_id)
 OR EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions
 WHERE coordinator_id = NEW.coordinator_id AND device_id = NEW.device_id AND owner_identity_id <> NEW.owner_identity_id)
 OR EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions
 WHERE coordinator_id = NEW.coordinator_id AND key_id = NEW.key_id AND owner_identity_id <> NEW.owner_identity_id)
BEGIN SELECT RAISE(ABORT, 'legacy_owner_resolution_collision'); END;

CREATE TRIGGER IF NOT EXISTS legacy_owner_resolution_immutable_update
BEFORE UPDATE ON coordinator_legacy_owner_resolutions
BEGIN SELECT RAISE(ABORT, 'legacy_owner_resolution_immutable'); END;

CREATE TRIGGER IF NOT EXISTS legacy_owner_resolution_immutable_delete
BEFORE DELETE ON coordinator_legacy_owner_resolutions
BEGIN SELECT RAISE(ABORT, 'legacy_owner_resolution_immutable'); END;

-- Inert ceremony storage; finalized rows retain prior-commit evidence, not permission.
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
 admission_owner_hash TEXT CHECK (admission_owner_hash IS NULL OR (typeof(admission_owner_hash) = 'text' AND length(admission_owner_hash) = 64 AND admission_owner_hash NOT GLOB '*[^0-9a-f]*' AND instr(admission_owner_hash, char(0)) = 0)),
 owner_qualification_id TEXT CHECK (owner_qualification_id IS NULL OR (typeof(owner_qualification_id) = 'text' AND length(owner_qualification_id) BETWEEN 1 AND 256 AND owner_qualification_id = trim(owner_qualification_id) AND length(trim(owner_qualification_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(owner_qualification_id, char(0)) = 0)),
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
 CHECK ((account_subject IS NULL AND identity_id IS NULL AND link_id IS NULL AND link_attempt_id IS NULL AND link_controller_attestation_id IS NULL AND owner_qualification_id IS NULL AND link_auth_config_revision IS NULL AND grant_revisions_json IS NULL) OR (account_subject IS NOT NULL AND identity_id IS NOT NULL AND link_id IS NOT NULL AND link_attempt_id IS NOT NULL AND ((link_controller_attestation_id IS NOT NULL AND owner_qualification_id IS NULL) OR (link_controller_attestation_id IS NULL AND owner_qualification_id IS NOT NULL)) AND link_auth_config_revision IS NOT NULL AND grant_revisions_json IS NOT NULL)),
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
-- Admission is a birth fact, including NULL for preexisting/operator attempts.
CREATE TRIGGER IF NOT EXISTS owner_enrollment_admission_update
BEFORE UPDATE ON coordinator_owner_enrollment_attempts
WHEN OLD.admission_owner_hash IS NOT NEW.admission_owner_hash
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_admission_immutable'); END;
-- Probe each unique key separately; a coordinator-only OR plan scans every prior attempt.
CREATE TRIGGER IF NOT EXISTS owner_enrollment_admission_insert
BEFORE INSERT ON coordinator_owner_enrollment_attempts
WHEN EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a
 WHERE a.rowid IN (
 SELECT rowid FROM coordinator_owner_enrollment_attempts WHERE rowid = NEW.rowid
 UNION ALL SELECT rowid FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = NEW.coordinator_id AND attempt_id = NEW.attempt_id
 UNION ALL SELECT rowid FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = NEW.coordinator_id AND browser_start_hash = NEW.browser_start_hash
 UNION ALL SELECT rowid FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = NEW.coordinator_id AND browser_transaction_hash = NEW.browser_transaction_hash
 UNION ALL SELECT rowid FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = NEW.coordinator_id AND completion_secret_hash = NEW.completion_secret_hash)
 AND a.admission_owner_hash IS NOT NEW.admission_owner_hash)
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_admission_immutable'); END;
-- The authority branch, including its NULL pin, is fixed at first owner resolution.
CREATE TRIGGER IF NOT EXISTS owner_enrollment_authority_update
BEFORE UPDATE ON coordinator_owner_enrollment_attempts
WHEN (OLD.account_subject IS NOT NULL AND (
 OLD.owner_qualification_id IS NOT NEW.owner_qualification_id
 OR OLD.link_controller_attestation_id IS NOT NEW.link_controller_attestation_id))
 OR (OLD.owner_qualification_id IS NOT NEW.owner_qualification_id AND NOT (
  OLD.account_subject IS NULL AND NEW.account_subject IS NOT NULL
  AND OLD.state = 'browser_claimed' AND NEW.state = 'oidc_verified'))
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_pins_immutable'); END;
CREATE TRIGGER IF NOT EXISTS owner_enrollment_authority_insert
BEFORE INSERT ON coordinator_owner_enrollment_attempts
WHEN EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a
 WHERE a.rowid IN (
 SELECT rowid FROM coordinator_owner_enrollment_attempts WHERE rowid = NEW.rowid
 UNION ALL SELECT rowid FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = NEW.coordinator_id AND attempt_id = NEW.attempt_id
 UNION ALL SELECT rowid FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = NEW.coordinator_id AND browser_start_hash = NEW.browser_start_hash
 UNION ALL SELECT rowid FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = NEW.coordinator_id AND browser_transaction_hash = NEW.browser_transaction_hash
 UNION ALL SELECT rowid FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = NEW.coordinator_id AND completion_secret_hash = NEW.completion_secret_hash)
 AND (a.owner_qualification_id IS NOT NEW.owner_qualification_id
  OR a.link_controller_attestation_id IS NOT NEW.link_controller_attestation_id))
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

CREATE TABLE IF NOT EXISTS coordinator_device_ownership_bindings (
  device_id TEXT PRIMARY KEY NOT NULL CHECK(
    typeof(device_id) = 'text' AND length(trim(device_id)) > 0 AND instr(device_id, char(0)) = 0),
  key_id TEXT NOT NULL UNIQUE CHECK(
    typeof(key_id) = 'text' AND length(key_id) = 64 AND key_id NOT GLOB '*[^a-f0-9]*'
    AND instr(key_id, char(0)) = 0),
  identity_id TEXT NOT NULL CHECK(
    typeof(identity_id) = 'text' AND length(trim(identity_id)) > 0 AND instr(identity_id, char(0)) = 0),
  coordinator_id TEXT NOT NULL CHECK(
    typeof(coordinator_id) = 'text' AND length(trim(coordinator_id)) > 0 AND instr(coordinator_id, char(0)) = 0),
  binding_id TEXT NOT NULL UNIQUE CHECK(
    typeof(binding_id) = 'text' AND length(trim(binding_id)) > 0 AND instr(binding_id, char(0)) = 0),
  provenance TEXT NOT NULL CHECK(
    typeof(provenance) = 'text' AND provenance IN ('owner_enrollment', 'reviewed_legacy_migration')),
  source_ref TEXT NOT NULL CHECK(
    typeof(source_ref) = 'text' AND length(trim(source_ref)) > 0 AND instr(source_ref, char(0)) = 0),
  bound_at TEXT NOT NULL CHECK(
    typeof(bound_at) = 'text' AND length(trim(bound_at)) > 0 AND instr(bound_at, char(0)) = 0)
);

-- REPLACE's implicit deletes may skip DELETE triggers when recursive triggers are off.
CREATE TRIGGER IF NOT EXISTS coordinator_device_ownership_insert_collision
BEFORE INSERT ON coordinator_device_ownership_bindings
WHEN EXISTS (
  SELECT 1 FROM coordinator_device_ownership_bindings
  WHERE device_id = NEW.device_id OR key_id = NEW.key_id OR binding_id = NEW.binding_id
)
BEGIN
  SELECT RAISE(ABORT, 'device_ownership_collision');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_ownership_immutable_update
BEFORE UPDATE ON coordinator_device_ownership_bindings
BEGIN
  SELECT RAISE(ABORT, 'device_ownership_immutable');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_ownership_immutable_delete
BEFORE DELETE ON coordinator_device_ownership_bindings
BEGIN
  SELECT RAISE(ABORT, 'device_ownership_immutable');
END;

CREATE TABLE IF NOT EXISTS coordinator_device_revocations (
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('device_id', 'ed25519_key')),
  subject_value TEXT NOT NULL CHECK(
    (subject_kind = 'device_id' AND length(subject_value) BETWEEN 1 AND 256) OR
    (subject_kind = 'ed25519_key' AND length(subject_value) = 64
      AND subject_value NOT GLOB '*[^a-f0-9]*')),
  revocation_id TEXT NOT NULL,
  evidence_group_id TEXT NOT NULL,
  evidence_device_id TEXT NOT NULL,
  evidence_public_key TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subject_kind, subject_value)
);

CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  display_name TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrolled_devices (
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  identity_id TEXT,
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, device_id)
);

CREATE TABLE IF NOT EXISTS presence_records (
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  addresses_json TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (group_id, device_id)
);

CREATE TABLE IF NOT EXISTS request_nonces (
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, nonce)
);

-- Keeps the per-request expiry sweep off a full table scan; see migration
-- 0014_add_request_nonces_created_at_index.sql.
CREATE INDEX IF NOT EXISTS idx_request_nonces_created_at
ON request_nonces(created_at);

CREATE TABLE IF NOT EXISTS coordinator_invites (
  invite_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  policy TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  team_name_snapshot TEXT,
  revoked_at TEXT,
  operation_id TEXT,
  reviewed_project_set_digest TEXT,
  token_digest TEXT,
  inviter_actor_id TEXT,
  inviter_display_name TEXT,
  inviter_device_id TEXT,
  pending_person_id TEXT,
  project_summaries_json TEXT,
  project_intent_json TEXT,
  consumed_at TEXT,
  bound_device_id TEXT,
  bound_public_key TEXT,
  bound_fingerprint TEXT,
  recipient_actor_id TEXT,
  recipient_display_name TEXT,
  recipient_device_display_name TEXT,
  trust_state TEXT,
  bootstrap_grant_id TEXT,
  invite_kind TEXT,
  policy_team_id TEXT,
  target_identity_id TEXT,
  assigned_identity_id TEXT,
  reviewed_preview_digest TEXT,
  reviewed_intent_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_invites_operation_id
ON coordinator_invites(operation_id) WHERE operation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_invites_token_digest
ON coordinator_invites(token_digest) WHERE token_digest IS NOT NULL;

-- Serves listInvites' group filter and created_at ordering from one seek; see
-- migration 0015_add_coordinator_invites_group_created_index.sql.
CREATE INDEX IF NOT EXISTS idx_coordinator_invites_group_created
ON coordinator_invites(group_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coordinator_join_requests (
  request_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  display_name TEXT,
  token TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
);

CREATE TABLE IF NOT EXISTS coordinator_reciprocal_approvals (
  request_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  requesting_device_id TEXT NOT NULL,
  requested_device_id TEXT NOT NULL,
  pending_pair_low_device_id TEXT,
  pending_pair_high_device_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS coordinator_bootstrap_grants (
  grant_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  seed_device_id TEXT NOT NULL,
  worker_device_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS coordinator_scopes (
  scope_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'user',
  authority_type TEXT NOT NULL DEFAULT 'coordinator',
  coordinator_id TEXT,
  group_id TEXT,
  manifest_issuer_device_id TEXT,
  membership_epoch INTEGER NOT NULL DEFAULT 0,
  manifest_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coordinator_scopes_status
ON coordinator_scopes(status);

CREATE INDEX IF NOT EXISTS idx_coordinator_scopes_authority_group
ON coordinator_scopes(coordinator_id, group_id);

CREATE TABLE IF NOT EXISTS coordinator_scope_memberships (
  scope_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  membership_epoch INTEGER NOT NULL DEFAULT 0,
  coordinator_id TEXT,
  group_id TEXT,
  manifest_issuer_device_id TEXT,
  manifest_hash TEXT,
  signed_manifest_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_scope_memberships_device_status
ON coordinator_scope_memberships(device_id, status);

CREATE INDEX IF NOT EXISTS idx_coordinator_scope_memberships_scope_status
ON coordinator_scope_memberships(scope_id, status);

CREATE INDEX IF NOT EXISTS idx_coordinator_scope_memberships_authority_group
ON coordinator_scope_memberships(coordinator_id, group_id);

CREATE TABLE IF NOT EXISTS coordinator_scope_membership_audit_log (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_id TEXT,
  action TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL,
  membership_epoch INTEGER NOT NULL,
  previous_role TEXT,
  previous_status TEXT,
  previous_membership_epoch INTEGER,
  coordinator_id TEXT,
  group_id TEXT,
  actor_type TEXT,
  actor_id TEXT,
  manifest_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coordinator_scope_membership_audit_scope_created
ON coordinator_scope_membership_audit_log(scope_id, created_at, event_id);

CREATE INDEX IF NOT EXISTS idx_coordinator_scope_membership_audit_device_created
ON coordinator_scope_membership_audit_log(device_id, created_at, event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_scope_membership_audit_effect
ON coordinator_scope_membership_audit_log(effect_id) WHERE effect_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS coordinator_scope_membership_effect_receipts (
  effect_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
  request_json TEXT NOT NULL,
  outcome_applied INTEGER NOT NULL CHECK (outcome_applied IN (0, 1)),
  scope_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT,
  status TEXT,
  membership_epoch INTEGER,
  coordinator_id TEXT,
  group_id TEXT,
  manifest_issuer_device_id TEXT,
  manifest_hash TEXT,
  signed_manifest_json TEXT,
  updated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_reciprocal_pending_pair
ON coordinator_reciprocal_approvals(group_id, pending_pair_low_device_id, pending_pair_high_device_id)
WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS coordinator_legacy_team_completions (
  group_id TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,
  manifest_version INTEGER NOT NULL CHECK (manifest_version = 1),
  manifest_json TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, candidate_ref)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_legacy_team_completions_group
ON coordinator_legacy_team_completions(group_id, completed_at, candidate_ref);

-- Empty by design: enrollment labels do not constitute admin-reviewed authority.
-- No foreign keys: retain revoked proofs even after enrollment removal.
CREATE TABLE IF NOT EXISTS coordinator_auth_controller_attestations (
	attestation_id TEXT NOT NULL,
	coordinator_id TEXT NOT NULL,
	identity_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	public_key TEXT NOT NULL,
	fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
	review_receipt_id TEXT NOT NULL,
	evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
	enrollment_identity_id TEXT,
	revision INTEGER NOT NULL DEFAULT 1 CHECK (revision = 1),
	created_at TEXT NOT NULL,
	revoked_at TEXT,
	PRIMARY KEY (coordinator_id, attestation_id),
	UNIQUE (coordinator_id, group_id, device_id, fingerprint),
	UNIQUE (coordinator_id, review_receipt_id)
);

CREATE TABLE IF NOT EXISTS coordinator_auth_link_attempts (
 coordinator_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 public_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
 controller_attestation_id TEXT,
 controller_review_receipt_id TEXT,
 controller_revision INTEGER,
 issuer TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 runtime_verifier_hash TEXT NOT NULL CHECK (length(runtime_verifier_hash) = 64 AND runtime_verifier_hash NOT GLOB '*[^0-9a-f]*'),
 loopback_redirect TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending','browser_claimed','oidc_verified','confirmed','finalized','session_redeemed','expired','failed')),
 browser_transaction_hash TEXT CHECK (browser_transaction_hash IS NULL OR (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*')),
 account_subject TEXT CHECK (account_subject IS NULL OR length(account_subject) BETWEEN 1 AND 255),
 completion_secret_hash TEXT CHECK (completion_secret_hash IS NULL OR (length(completion_secret_hash) = 64 AND completion_secret_hash NOT GLOB '*[^0-9a-f]*')),
 link_id TEXT,
 failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN ('device_cancelled','browser_cancelled','provider_failure','config_failure')),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0 AND created_at_ms <= 9007199254140991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms = created_at_ms + 600000),
 claimed_at_ms INTEGER,
 oidc_verified_at_ms INTEGER,
 confirmed_at_ms INTEGER,
 finalized_at_ms INTEGER,
 failed_at_ms INTEGER,
 browser_start_hash TEXT CHECK (browser_start_hash IS NULL OR (length(browser_start_hash) = 64 AND browser_start_hash NOT GLOB '*[^0-9a-f]*')),
 authority_kind TEXT NOT NULL CHECK (authority_kind IN ('controller_attestation','device_claim')),
 PRIMARY KEY (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, runtime_verifier_hash),
 UNIQUE (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, completion_secret_hash),
 UNIQUE (coordinator_id, link_id),
 CHECK (state <> 'pending' OR (browser_transaction_hash IS NULL AND account_subject IS NULL AND completion_secret_hash IS NULL AND link_id IS NULL)),
 CHECK (state NOT IN ('browser_claimed','oidc_verified','confirmed','finalized','session_redeemed') OR browser_transaction_hash IS NOT NULL),
 CHECK (state NOT IN ('oidc_verified','confirmed','finalized','session_redeemed') OR account_subject IS NOT NULL),
 CHECK (state NOT IN ('confirmed','finalized','session_redeemed') OR completion_secret_hash IS NOT NULL),
 CHECK ((state IN ('finalized','session_redeemed') AND link_id IS NOT NULL AND finalized_at_ms IS NOT NULL) OR (state NOT IN ('finalized','session_redeemed') AND link_id IS NULL AND finalized_at_ms IS NULL)),
 CHECK ((state = 'failed' AND failure_reason IS NOT NULL AND failed_at_ms IS NOT NULL) OR (state <> 'failed' AND failure_reason IS NULL AND failed_at_ms IS NULL)),
 CHECK ((authority_kind = 'controller_attestation'
  AND (controller_attestation_id IS NOT NULL AND typeof(controller_attestation_id) = 'text' AND length(controller_attestation_id) BETWEEN 1 AND 256 AND controller_attestation_id = trim(controller_attestation_id) AND instr(controller_attestation_id, char(0)) = 0)
  AND (controller_review_receipt_id IS NOT NULL AND typeof(controller_review_receipt_id) = 'text' AND length(controller_review_receipt_id) BETWEEN 1 AND 256 AND controller_review_receipt_id = trim(controller_review_receipt_id) AND instr(controller_review_receipt_id, char(0)) = 0)
  AND controller_revision IS NOT NULL AND typeof(controller_revision) = 'integer' AND controller_revision = 1)
  OR (authority_kind = 'device_claim' AND controller_attestation_id IS NULL AND controller_review_receipt_id IS NULL AND controller_revision IS NULL))
);
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
 PRIMARY KEY (coordinator_id, link_id),
 UNIQUE (coordinator_id, issuer, subject),
 UNIQUE (coordinator_id, identity_id),
 UNIQUE (coordinator_id, attempt_id),
 UNIQUE (device_claim_id),
 CHECK ((authority_kind = 'controller_attestation'
  AND (controller_attestation_id IS NOT NULL AND typeof(controller_attestation_id) = 'text' AND length(controller_attestation_id) BETWEEN 1 AND 256 AND controller_attestation_id = trim(controller_attestation_id) AND instr(controller_attestation_id, char(0)) = 0) AND device_claim_id IS NULL)
  OR (authority_kind = 'device_claim' AND controller_attestation_id IS NULL
  AND (device_claim_id IS NOT NULL AND typeof(device_claim_id) = 'text' AND length(device_claim_id) BETWEEN 1 AND 256 AND device_claim_id = trim(device_claim_id) AND instr(device_claim_id, char(0)) = 0)))
);
CREATE TABLE IF NOT EXISTS coordinator_auth_link_audit_log (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK (action IN ('link_created','link_revoked')),
 attempt_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
 controller_attestation_id TEXT,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL,
 authority_kind TEXT NOT NULL CHECK (authority_kind IN ('controller_attestation','device_claim')),
 device_claim_id TEXT,
 PRIMARY KEY (coordinator_id, link_id, action),
 CHECK ((authority_kind = 'controller_attestation'
  AND (controller_attestation_id IS NOT NULL AND typeof(controller_attestation_id) = 'text' AND length(controller_attestation_id) BETWEEN 1 AND 256 AND controller_attestation_id = trim(controller_attestation_id) AND instr(controller_attestation_id, char(0)) = 0) AND device_claim_id IS NULL)
  OR (authority_kind = 'device_claim' AND controller_attestation_id IS NULL
  AND (device_claim_id IS NOT NULL AND typeof(device_claim_id) = 'text' AND length(device_claim_id) BETWEEN 1 AND 256 AND device_claim_id = trim(device_claim_id) AND instr(device_claim_id, char(0)) = 0)))
);

CREATE TABLE IF NOT EXISTS coordinator_auth_session_receipts (
 coordinator_id TEXT NOT NULL,
 browser_transaction_hash TEXT NOT NULL CHECK (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*'),
 source TEXT NOT NULL CHECK (source IN ('link_redeem','signin')),
 attempt_id TEXT,
 link_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199225940991),
 purge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (typeof(purge_eligible) = 'integer' AND purge_eligible IN (0,1) AND (purge_eligible = 0 OR (source = 'signin' AND attempt_id IS NULL))),
 PRIMARY KEY (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, session_id),
 UNIQUE (coordinator_id, attempt_id),
 CHECK ((source = 'link_redeem' AND attempt_id IS NOT NULL) OR (source = 'signin' AND attempt_id IS NULL))
);
CREATE TABLE IF NOT EXISTS coordinator_auth_sessions (
 coordinator_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 credential_hash TEXT NOT NULL CHECK (length(credential_hash) = 64 AND credential_hash NOT GLOB '*[^0-9a-f]*'),
 browser_transaction_hash TEXT NOT NULL CHECK (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*'),
 link_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199225940991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms BETWEEN 0 AND 9007199254740991 AND expires_at_ms = created_at_ms + 28800000),
 revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR (typeof(revoked_at_ms) = 'integer' AND revoked_at_ms BETWEEN 0 AND 9007199254740991)),
 PRIMARY KEY (coordinator_id, session_id),
 UNIQUE (coordinator_id, credential_hash),
 UNIQUE (coordinator_id, browser_transaction_hash)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_link_config_expiry
  ON coordinator_auth_sessions(coordinator_id, link_id, auth_config_revision, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
 ON coordinator_auth_sessions(coordinator_id, expires_at_ms, session_id);
CREATE INDEX IF NOT EXISTS idx_auth_session_receipts_purge
 ON coordinator_auth_session_receipts(coordinator_id, purge_eligible, created_at_ms, browser_transaction_hash);

CREATE INDEX IF NOT EXISTS idx_auth_link_attempts_device_created
 ON coordinator_auth_link_attempts(coordinator_id, group_id, device_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_auth_link_attempts_identity_expiry
 ON coordinator_auth_link_attempts(coordinator_id, identity_id, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_auth_link_attempts_state_expiry
 ON coordinator_auth_link_attempts(coordinator_id, state, expires_at_ms);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_link_attempts_browser_start
 ON coordinator_auth_link_attempts(coordinator_id, browser_start_hash);

CREATE TABLE IF NOT EXISTS coordinator_auth_browser_transactions (
 coordinator_id TEXT NOT NULL CHECK (length(coordinator_id) BETWEEN 1 AND 256),
 browser_transaction_hash TEXT NOT NULL CHECK (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*'),
  purpose TEXT NOT NULL CHECK (purpose IN ('signin','link','owner_enroll')),
 attempt_id TEXT CHECK (attempt_id IS NULL OR length(attempt_id) BETWEEN 1 AND 256),
 state_hash TEXT NOT NULL CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
 binder_hash TEXT NOT NULL CHECK (length(binder_hash) = 64 AND binder_hash NOT GLOB '*[^0-9a-f]*'),
 issuer TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 redirect_uri TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending','consumed','expired')),
 nonce TEXT CHECK (nonce IS NULL OR (length(nonce) BETWEEN 43 AND 128 AND nonce NOT GLOB '*[^A-Za-z0-9._~-]*')),
 pkce_verifier TEXT CHECK (pkce_verifier IS NULL OR (length(pkce_verifier) BETWEEN 43 AND 128 AND pkce_verifier NOT GLOB '*[^A-Za-z0-9._~-]*')),
 claim_token TEXT,
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254140991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms > created_at_ms AND expires_at_ms <= created_at_ms + 600000),
 consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR (typeof(consumed_at_ms) = 'integer' AND consumed_at_ms >= created_at_ms AND consumed_at_ms < expires_at_ms AND consumed_at_ms <= 9007199254740991)),
 PRIMARY KEY (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, state_hash),
 UNIQUE (coordinator_id, binder_hash),
 UNIQUE (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, claim_token),
  CHECK ((purpose IN ('link','owner_enroll') AND attempt_id IS NOT NULL) OR (purpose = 'signin' AND attempt_id IS NULL)),
 CHECK ((state = 'pending' AND nonce IS NOT NULL AND pkce_verifier IS NOT NULL) OR (state <> 'pending' AND nonce IS NULL AND pkce_verifier IS NULL)),
 CHECK ((state = 'consumed' AND claim_token IS NOT NULL AND consumed_at_ms IS NOT NULL) OR (state <> 'consumed' AND claim_token IS NULL AND consumed_at_ms IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_auth_browser_txn_purpose_created
 ON coordinator_auth_browser_transactions(coordinator_id, purpose, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_auth_browser_txn_state_expiry
 ON coordinator_auth_browser_transactions(coordinator_id, state, expires_at_ms);
CREATE TABLE IF NOT EXISTS coordinator_auth_signin_purge_floors (
 coordinator_id TEXT NOT NULL PRIMARY KEY CHECK (length(coordinator_id) BETWEEN 1 AND 256),
 purged_through_created_at_ms INTEGER NOT NULL CHECK (typeof(purged_through_created_at_ms) = 'integer' AND purged_through_created_at_ms BETWEEN 0 AND 9007199254140991)
);
CREATE TABLE IF NOT EXISTS coordinator_identity_group_grants (
 coordinator_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
 revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
 source_kind TEXT NOT NULL CHECK (source_kind = 'controller_attestation'),
 source_receipt_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 revoked_at TEXT,
 PRIMARY KEY (coordinator_id, identity_id, group_id),
 CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS coordinator_auth_account_profiles (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 display_name TEXT CHECK (display_name IS NULL OR (typeof(display_name) = 'text' AND length(display_name) BETWEEN 1 AND 256)),
 email TEXT CHECK (email IS NULL OR (typeof(email) = 'text' AND length(email) BETWEEN 1 AND 320)),
 email_verified INTEGER CHECK (email_verified IS NULL OR (typeof(email_verified) = 'integer' AND email_verified IN (0,1) AND email IS NOT NULL)),
 picture_url TEXT CHECK (picture_url IS NULL OR (typeof(picture_url) = 'text' AND length(picture_url) BETWEEN 1 AND 2048 AND substr(picture_url, 1, 8) = 'https://')),
 source_session_id TEXT NOT NULL,
 source_signed_in_at_ms INTEGER NOT NULL CHECK (typeof(source_signed_in_at_ms) = 'integer' AND source_signed_in_at_ms BETWEEN 0 AND 9007199225940991),
  PRIMARY KEY (coordinator_id, link_id)
);
CREATE TABLE IF NOT EXISTS coordinator_owner_enrollment_audit_log (
 coordinator_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK (action = 'owner_device_enrolled'),
 binding_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 PRIMARY KEY (coordinator_id, event_id),
 UNIQUE (coordinator_id, attempt_id)
);

-- Committed proofs only; finalization writes logical references atomically.
CREATE TABLE IF NOT EXISTS coordinator_auth_device_claims (
  claim_id TEXT PRIMARY KEY NOT NULL CHECK(
    typeof(claim_id) = 'text' AND length(claim_id) BETWEEN 1 AND 256
    AND claim_id = trim(claim_id) AND instr(claim_id, char(0)) = 0),
  coordinator_id TEXT NOT NULL CHECK(
    typeof(coordinator_id) = 'text' AND length(coordinator_id) BETWEEN 1 AND 256
    AND coordinator_id = trim(coordinator_id) AND instr(coordinator_id, char(0)) = 0),
  identity_id TEXT NOT NULL CHECK(
    typeof(identity_id) = 'text' AND length(identity_id) BETWEEN 1 AND 256
    AND identity_id = trim(identity_id) AND instr(identity_id, char(0)) = 0),
  group_id TEXT NOT NULL CHECK(
    typeof(group_id) = 'text' AND length(group_id) BETWEEN 1 AND 256
    AND group_id = trim(group_id) AND instr(group_id, char(0)) = 0),
  device_id TEXT NOT NULL CHECK(
    typeof(device_id) = 'text' AND length(device_id) BETWEEN 1 AND 256
    AND device_id = trim(device_id) AND instr(device_id, char(0)) = 0),
  public_key TEXT NOT NULL CHECK(
    typeof(public_key) = 'text' AND length(public_key) BETWEEN 1 AND 4096
    AND length(trim(replace(replace(public_key, char(13), ''), char(10), ''))) > 0
    AND instr(public_key, char(0)) = 0),
  fingerprint TEXT NOT NULL CHECK(
    typeof(fingerprint) = 'text' AND length(fingerprint) = 64
    AND fingerprint NOT GLOB '*[^a-f0-9]*' AND instr(fingerprint, char(0)) = 0),
  key_id TEXT NOT NULL CHECK(
    typeof(key_id) = 'text' AND length(key_id) = 64
    AND key_id NOT GLOB '*[^a-f0-9]*' AND instr(key_id, char(0)) = 0),
  attempt_id TEXT NOT NULL CHECK(
    typeof(attempt_id) = 'text' AND length(attempt_id) BETWEEN 1 AND 256
    AND attempt_id = trim(attempt_id) AND instr(attempt_id, char(0)) = 0),
  issuer TEXT NOT NULL CHECK(
    typeof(issuer) = 'text' AND length(trim(issuer)) > 0
    AND issuer = trim(issuer) AND instr(issuer, char(0)) = 0),
  auth_config_revision TEXT NOT NULL CHECK(
    typeof(auth_config_revision) = 'text' AND length(auth_config_revision) = 64
    AND auth_config_revision NOT GLOB '*[^a-f0-9]*' AND instr(auth_config_revision, char(0)) = 0),
  created_at_ms INTEGER NOT NULL CHECK(
    typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (coordinator_id, identity_id),
  UNIQUE (coordinator_id, device_id),
  UNIQUE (coordinator_id, key_id),
  UNIQUE (coordinator_id, attempt_id)
) WITHOUT ROWID;

-- REPLACE's implicit deletes may skip DELETE triggers when recursive triggers are off.
-- Check every unique identifier before conflict handling, including UPSERT DO NOTHING.
CREATE TRIGGER IF NOT EXISTS coordinator_auth_device_claims_insert_collision
BEFORE INSERT ON coordinator_auth_device_claims
WHEN EXISTS (
  SELECT 1 FROM coordinator_auth_device_claims
  WHERE claim_id = NEW.claim_id OR (coordinator_id = NEW.coordinator_id AND (
    identity_id = NEW.identity_id OR device_id = NEW.device_id
    OR key_id = NEW.key_id OR attempt_id = NEW.attempt_id
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'auth_device_claim_collision');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_auth_device_claims_immutable_update
BEFORE UPDATE ON coordinator_auth_device_claims
BEGIN
  SELECT RAISE(ABORT, 'auth_device_claim_immutable');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_auth_device_claims_immutable_delete
BEFORE DELETE ON coordinator_auth_device_claims
BEGIN
  SELECT RAISE(ABORT, 'auth_device_claim_immutable');
END;

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

-- 0038: device rebinding (ADR 0005 Section 8)
CREATE TABLE IF NOT EXISTS coordinator_device_rebind_attempts (
 coordinator_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 origin TEXT NOT NULL,
 device_id TEXT NOT NULL,
 public_key TEXT NOT NULL,
 key_id TEXT NOT NULL CHECK (length(key_id) = 64 AND key_id NOT GLOB '*[^0-9a-f]*'),
 fingerprint TEXT NOT NULL,
 current_identity_id TEXT NOT NULL CHECK (length(current_identity_id) BETWEEN 1 AND 256),
 issuer TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL,
 loopback_redirect TEXT,
 browser_start_hash TEXT NOT NULL UNIQUE,
 browser_transaction_hash TEXT UNIQUE,
 browser_binder_hash TEXT,
 account_subject TEXT,
 target_identity_id TEXT,
 link_id TEXT,
 link_authority_kind TEXT CHECK (link_authority_kind IS NULL
  OR link_authority_kind IN ('controller_attestation', 'device_claim')),
 review_digest TEXT CHECK (review_digest IS NULL
  OR (length(review_digest) = 64 AND review_digest NOT GLOB '*[^0-9a-f]*')),
 team_effects_json TEXT CHECK (team_effects_json IS NULL OR json_valid(team_effects_json)),
 enrollment_count INTEGER CHECK (enrollment_count IS NULL OR enrollment_count BETWEEN 1 AND 50),
 confirmation_hash TEXT,
 completion_secret_hash TEXT UNIQUE,
 final_key_proof_hash TEXT,
 state TEXT NOT NULL CHECK (state IN
  ('pending', 'browser_claimed', 'oidc_verified', 'confirmed', 'finalized', 'expired', 'failed')),
 created_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 600000),
 finalized_at_ms INTEGER,
 binding_id TEXT UNIQUE,
 audit_event_id TEXT UNIQUE,
 final_outcome_json TEXT CHECK (final_outcome_json IS NULL OR json_valid(final_outcome_json)),
 PRIMARY KEY (coordinator_id, attempt_id),
 CHECK (target_identity_id IS NULL OR target_identity_id <> current_identity_id),
 CHECK (state NOT IN ('confirmed', 'finalized') OR (account_subject IS NOT NULL
  AND target_identity_id IS NOT NULL AND link_id IS NOT NULL AND link_authority_kind IS NOT NULL
  AND review_digest IS NOT NULL AND team_effects_json IS NOT NULL AND enrollment_count IS NOT NULL
  AND confirmation_hash IS NOT NULL AND completion_secret_hash IS NOT NULL)),
 CHECK (state <> 'finalized' OR (finalized_at_ms IS NOT NULL AND binding_id IS NOT NULL
  AND audit_event_id IS NOT NULL AND final_key_proof_hash IS NOT NULL
  AND final_outcome_json IS NOT NULL AND loopback_redirect IS NULL)),
 CHECK (state = 'finalized' OR (finalized_at_ms IS NULL AND binding_id IS NULL
  AND audit_event_id IS NULL AND final_key_proof_hash IS NULL AND final_outcome_json IS NULL)),
 CHECK (state NOT IN ('pending', 'browser_claimed', 'oidc_verified')
  OR (confirmation_hash IS NULL AND completion_secret_hash IS NULL)),
 CHECK (state NOT IN ('pending', 'browser_claimed') OR (account_subject IS NULL
  AND target_identity_id IS NULL AND link_id IS NULL AND link_authority_kind IS NULL
  AND review_digest IS NULL AND team_effects_json IS NULL AND enrollment_count IS NULL)),
 CHECK (state <> 'pending' OR (browser_transaction_hash IS NULL AND browser_binder_hash IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_coordinator_device_rebind_attempts_device
 ON coordinator_device_rebind_attempts (coordinator_id, device_id, state);

-- Birth facts never change; proofs are set once; only forward transitions are allowed.
-- The EXISTS clause stops UPDATE OR REPLACE from deleting another row through a unique key.
CREATE TRIGGER IF NOT EXISTS coordinator_device_rebind_attempt_pins
BEFORE UPDATE ON coordinator_device_rebind_attempts
WHEN OLD.state IN ('finalized', 'expired', 'failed') OR NEW.rowid IS NOT OLD.rowid
 OR EXISTS (SELECT 1 FROM coordinator_device_rebind_attempts o
  WHERE NOT (o.coordinator_id = OLD.coordinator_id AND o.attempt_id = OLD.attempt_id)
  AND (o.browser_transaction_hash = NEW.browser_transaction_hash
  OR o.completion_secret_hash = NEW.completion_secret_hash
  OR o.binding_id = NEW.binding_id OR o.audit_event_id = NEW.audit_event_id))
 OR NEW.coordinator_id IS NOT OLD.coordinator_id OR NEW.attempt_id IS NOT OLD.attempt_id
 OR NEW.origin IS NOT OLD.origin OR NEW.device_id IS NOT OLD.device_id
 OR NEW.public_key IS NOT OLD.public_key OR NEW.key_id IS NOT OLD.key_id
 OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.current_identity_id IS NOT OLD.current_identity_id
 OR NEW.issuer IS NOT OLD.issuer OR NEW.auth_config_revision IS NOT OLD.auth_config_revision
 OR NEW.browser_start_hash IS NOT OLD.browser_start_hash
 OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR (OLD.browser_transaction_hash IS NOT NULL AND NEW.browser_transaction_hash IS NOT OLD.browser_transaction_hash)
 OR (OLD.browser_binder_hash IS NOT NULL AND NEW.browser_binder_hash IS NOT OLD.browser_binder_hash)
 OR (OLD.account_subject IS NOT NULL AND NEW.account_subject IS NOT OLD.account_subject)
 OR (OLD.target_identity_id IS NOT NULL AND NEW.target_identity_id IS NOT OLD.target_identity_id)
 OR (OLD.link_id IS NOT NULL AND NEW.link_id IS NOT OLD.link_id)
 OR (OLD.review_digest IS NOT NULL AND NEW.review_digest IS NOT OLD.review_digest)
 OR (OLD.team_effects_json IS NOT NULL AND NEW.team_effects_json IS NOT OLD.team_effects_json)
 OR (OLD.enrollment_count IS NOT NULL AND NEW.enrollment_count IS NOT OLD.enrollment_count)
 OR (OLD.confirmation_hash IS NOT NULL AND NEW.confirmation_hash IS NOT OLD.confirmation_hash)
 OR (OLD.completion_secret_hash IS NOT NULL AND NEW.completion_secret_hash IS NOT OLD.completion_secret_hash)
 OR (NEW.loopback_redirect IS NOT OLD.loopback_redirect
  AND NOT (NEW.loopback_redirect IS NULL AND NEW.state IN ('finalized', 'expired', 'failed')))
 OR NOT ((OLD.state = NEW.state)
  OR (OLD.state = 'pending' AND NEW.state IN ('browser_claimed', 'expired', 'failed'))
  OR (OLD.state = 'browser_claimed' AND NEW.state IN ('oidc_verified', 'expired', 'failed'))
  OR (OLD.state = 'oidc_verified' AND NEW.state IN ('confirmed', 'expired', 'failed'))
  OR (OLD.state = 'confirmed' AND NEW.state IN ('finalized', 'expired', 'failed')))
BEGIN
 SELECT RAISE(ABORT, 'device_rebind_attempt_immutable');
END;

-- REPLACE's implicit deletes may skip DELETE triggers when recursive triggers are off.
CREATE TRIGGER IF NOT EXISTS coordinator_device_rebind_attempt_insert_collision
BEFORE INSERT ON coordinator_device_rebind_attempts
WHEN EXISTS (SELECT 1 FROM coordinator_device_rebind_attempts
 WHERE rowid = NEW.rowid OR (coordinator_id = NEW.coordinator_id AND attempt_id = NEW.attempt_id)
 OR browser_start_hash = NEW.browser_start_hash
 OR browser_transaction_hash = NEW.browser_transaction_hash
 OR completion_secret_hash = NEW.completion_secret_hash
 OR binding_id = NEW.binding_id OR audit_event_id = NEW.audit_event_id)
BEGIN
 SELECT RAISE(ABORT, 'device_rebind_attempt_collision');
END;

-- An automatic rowid reads as -1 before insert; positive rowids keep that from matching a row.
CREATE TRIGGER IF NOT EXISTS coordinator_device_rebind_attempt_rowid
AFTER INSERT ON coordinator_device_rebind_attempts
WHEN NEW.rowid < 1
BEGIN
 SELECT RAISE(ABORT, 'device_rebind_attempt_rowid');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_rebind_attempt_retained
BEFORE DELETE ON coordinator_device_rebind_attempts
WHEN OLD.state = 'finalized'
BEGIN
 SELECT RAISE(ABORT, 'device_rebind_attempt_immutable');
END;

CREATE TABLE IF NOT EXISTS coordinator_device_rebind_audit_log (
 coordinator_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK (action = 'owner_device_rebound'),
 binding_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 previous_identity_id TEXT NOT NULL,
 target_identity_id TEXT NOT NULL,
 enrollment_count INTEGER NOT NULL CHECK (enrollment_count BETWEEN 1 AND 50),
 created_at_ms INTEGER NOT NULL,
 PRIMARY KEY (coordinator_id, event_id),
 UNIQUE (coordinator_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_device_rebind_audit_target
 ON coordinator_device_rebind_audit_log (coordinator_id, target_identity_id, created_at_ms);

CREATE TRIGGER IF NOT EXISTS coordinator_device_rebind_audit_insert_collision
BEFORE INSERT ON coordinator_device_rebind_audit_log
WHEN EXISTS (SELECT 1 FROM coordinator_device_rebind_audit_log
 WHERE rowid = NEW.rowid
 OR (coordinator_id = NEW.coordinator_id AND (event_id = NEW.event_id OR attempt_id = NEW.attempt_id)))
BEGIN
 SELECT RAISE(ABORT, 'device_rebind_audit_collision');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_rebind_audit_rowid
AFTER INSERT ON coordinator_device_rebind_audit_log
WHEN NEW.rowid < 1
BEGIN
 SELECT RAISE(ABORT, 'device_rebind_audit_rowid');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_rebind_audit_immutable_update
BEFORE UPDATE ON coordinator_device_rebind_audit_log
BEGIN
 SELECT RAISE(ABORT, 'device_rebind_audit_immutable');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_rebind_audit_immutable_delete
BEFORE DELETE ON coordinator_device_rebind_audit_log
BEGIN
 SELECT RAISE(ABORT, 'device_rebind_audit_immutable');
END;
