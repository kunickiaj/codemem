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
  WHERE rowid = NEW.rowid OR device_id = NEW.device_id OR key_id = NEW.key_id
    OR binding_id = NEW.binding_id
)
BEGIN
  SELECT RAISE(ABORT, 'device_ownership_collision');
END;

-- An automatic rowid reads as -1 before insert; positive rowids keep that from matching a row.
CREATE TRIGGER IF NOT EXISTS coordinator_device_ownership_rowid
AFTER INSERT ON coordinator_device_ownership_bindings
WHEN NEW.rowid < 1
BEGIN
  SELECT RAISE(ABORT, 'device_ownership_rowid');
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
 start_authority_json TEXT CHECK (start_authority_json IS NULL OR json_valid(start_authority_json)),
 PRIMARY KEY (coordinator_id, attempt_id),
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
  AND team_effects_json IS NULL AND enrollment_count IS NULL)),
 CHECK (review_digest IS NOT NULL),
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
 OR NEW.start_authority_json IS NOT OLD.start_authority_json
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

-- Relay admission metadata, readiness and budgets (migrations 0041 and 0042).
CREATE TABLE IF NOT EXISTS relay_admission_authority_policy (
 authority_id TEXT NOT NULL PRIMARY KEY CHECK (typeof(authority_id) = 'text'
  AND length(CAST(authority_id AS BLOB)) = 64
  AND authority_id NOT GLOB '*[^0-9a-f]*' AND instr(authority_id, char(0)) = 0),
 policy_revision INTEGER NOT NULL CHECK (typeof(policy_revision) = 'integer'
  AND policy_revision BETWEEN 1 AND 9007199254740991),
 operator_state TEXT NOT NULL CHECK (operator_state IN ('enabled','disabled'))
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS relay_admission_audiences (
 authority_id TEXT NOT NULL,
 audience_id TEXT NOT NULL CHECK (typeof(audience_id) = 'text'
  AND length(CAST(audience_id AS BLOB)) = 64
  AND audience_id NOT GLOB '*[^0-9a-f]*' AND instr(audience_id, char(0)) = 0),
 state TEXT NOT NULL CHECK (state IN ('enabled','revoked')),
 changed_revision INTEGER NOT NULL CHECK (typeof(changed_revision) = 'integer'
  AND changed_revision BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (authority_id, audience_id),
 FOREIGN KEY (authority_id) REFERENCES relay_admission_authority_policy(authority_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS relay_admission_realms (
 authority_id TEXT NOT NULL,
 group_id TEXT NOT NULL CHECK (typeof(group_id) = 'text'
  AND length(CAST(group_id AS BLOB)) BETWEEN 1 AND 128 AND instr(group_id, char(0)) = 0),
 operator_state TEXT NOT NULL CHECK (operator_state IN ('enabled','disabled')),
 changed_revision INTEGER NOT NULL CHECK (typeof(changed_revision) = 'integer'
  AND changed_revision BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (authority_id, group_id),
 FOREIGN KEY (authority_id) REFERENCES relay_admission_authority_policy(authority_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS relay_admission_readiness (
 authority_id TEXT NOT NULL,
 scope TEXT NOT NULL CHECK (scope IN ('authority','realm')),
 group_id TEXT NOT NULL CHECK (typeof(group_id) = 'text' AND instr(group_id, char(0)) = 0
  AND ((scope = 'authority' AND group_id = '')
   OR (scope = 'realm' AND length(CAST(group_id AS BLOB)) BETWEEN 1 AND 128))),
 revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer'
  AND revision BETWEEN 1 AND 9007199254740991),
 state TEXT NOT NULL CHECK (state IN ('ready','paused','tripped')),
 observed_at_ms INTEGER CHECK (observed_at_ms IS NULL OR (typeof(observed_at_ms) = 'integer'
  AND observed_at_ms BETWEEN 0 AND 9007199254690991)),
 CHECK (state <> 'ready' OR observed_at_ms IS NOT NULL),
 PRIMARY KEY (authority_id, scope, group_id),
 FOREIGN KEY (authority_id) REFERENCES relay_admission_authority_policy(authority_id)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS relay_admission_policy_insert
 BEFORE INSERT ON relay_admission_authority_policy
 WHEN NEW.policy_revision IS NOT 1
 BEGIN SELECT RAISE(ABORT, 'relay_policy_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_policy_collision
 BEFORE INSERT ON relay_admission_authority_policy
 WHEN EXISTS (SELECT 1 FROM relay_admission_authority_policy p WHERE p.authority_id = NEW.authority_id)
 BEGIN SELECT RAISE(ABORT, 'relay_policy_collision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_policy_update
 BEFORE UPDATE ON relay_admission_authority_policy
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.policy_revision IS NOT OLD.policy_revision + 1
 BEGIN SELECT RAISE(ABORT, 'relay_policy_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_policy_delete
 BEFORE DELETE ON relay_admission_authority_policy
 BEGIN SELECT RAISE(ABORT, 'relay_policy_permanent'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_audience_collision
 BEFORE INSERT ON relay_admission_audiences
 WHEN EXISTS (SELECT 1 FROM relay_admission_audiences a
  WHERE a.authority_id = NEW.authority_id AND a.audience_id = NEW.audience_id)
 BEGIN SELECT RAISE(ABORT, 'relay_audience_collision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_audience_insert
 BEFORE INSERT ON relay_admission_audiences
 WHEN NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
  WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_audience_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_audience_update
 BEFORE UPDATE ON relay_admission_audiences
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.audience_id IS NOT OLD.audience_id
  OR OLD.state = 'revoked' OR NEW.changed_revision <= OLD.changed_revision
  OR NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
   WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_audience_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_audience_delete
 BEFORE DELETE ON relay_admission_audiences
 BEGIN SELECT RAISE(ABORT, 'relay_audience_permanent'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_realm_collision
 BEFORE INSERT ON relay_admission_realms
 WHEN EXISTS (SELECT 1 FROM relay_admission_realms r
  WHERE r.authority_id = NEW.authority_id AND r.group_id = NEW.group_id)
 BEGIN SELECT RAISE(ABORT, 'relay_realm_collision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_realm_insert
 BEFORE INSERT ON relay_admission_realms
 WHEN NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
  WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_realm_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_realm_update
 BEFORE UPDATE ON relay_admission_realms
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.group_id IS NOT OLD.group_id
  OR NEW.changed_revision <= OLD.changed_revision
  OR NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
   WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_realm_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_realm_delete
 BEFORE DELETE ON relay_admission_realms
 BEGIN SELECT RAISE(ABORT, 'relay_realm_permanent'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_collision
 BEFORE INSERT ON relay_admission_readiness
 WHEN EXISTS (SELECT 1 FROM relay_admission_readiness h
  WHERE h.authority_id = NEW.authority_id AND h.scope = NEW.scope AND h.group_id = NEW.group_id)
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_collision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_insert
 BEFORE INSERT ON relay_admission_readiness
 WHEN NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p WHERE p.authority_id = NEW.authority_id)
  OR (NEW.scope = 'authority' AND NEW.revision IS NOT 1)
  OR (NEW.scope = 'realm' AND (
   NOT EXISTS (SELECT 1 FROM relay_admission_realms r
    WHERE r.authority_id = NEW.authority_id AND r.group_id = NEW.group_id)
   OR NOT EXISTS (SELECT 1 FROM relay_admission_readiness ha
    WHERE ha.authority_id = NEW.authority_id AND ha.scope = 'authority'
     AND ha.group_id = '' AND ha.revision = NEW.revision)))
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_update
 BEFORE UPDATE ON relay_admission_readiness
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.scope IS NOT OLD.scope
  OR NEW.group_id IS NOT OLD.group_id
  OR (NEW.scope = 'authority' AND NEW.revision IS NOT OLD.revision + 1)
  OR (NEW.scope = 'realm' AND (NEW.revision <= OLD.revision
   OR NOT EXISTS (SELECT 1 FROM relay_admission_realms r
    WHERE r.authority_id = NEW.authority_id AND r.group_id = NEW.group_id)
   OR NOT EXISTS (SELECT 1 FROM relay_admission_readiness ha
    WHERE ha.authority_id = NEW.authority_id AND ha.scope = 'authority'
     AND ha.group_id = '' AND ha.revision = NEW.revision)))
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_delete
 BEFORE DELETE ON relay_admission_readiness
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_permanent'); END;
CREATE TABLE IF NOT EXISTS admission_budget_allocations (
 authority_id TEXT NOT NULL CHECK (typeof(authority_id) = 'text'
  AND length(CAST(authority_id AS BLOB)) = 64 AND authority_id NOT GLOB '*[^0-9a-f]*'
  AND instr(authority_id,char(0)) = 0),
 pool TEXT NOT NULL CHECK (pool IN ('authority','relay-route','relay-registration','traversal','device','device-registration')),
 audience_id TEXT NOT NULL CHECK (typeof(audience_id) = 'text' AND instr(audience_id,char(0)) = 0
  AND ((pool IN ('relay-route','relay-registration') AND length(CAST(audience_id AS BLOB)) = 64
   AND audience_id NOT GLOB '*[^0-9a-f]*')
  OR (pool NOT IN ('relay-route','relay-registration') AND audience_id = ''))),
 group_id TEXT NOT NULL CHECK (typeof(group_id) = 'text' AND instr(group_id,char(0)) = 0
  AND length(CAST(group_id AS BLOB)) <= 128
  AND (pool IN ('relay-route','relay-registration','traversal') OR group_id = '')),
 rate_per_min INTEGER NOT NULL DEFAULT 0 CHECK (typeof(rate_per_min) = 'integer'
  AND rate_per_min BETWEEN 0 AND 9007199254740991),
 burst INTEGER NOT NULL DEFAULT 0 CHECK (typeof(burst) = 'integer' AND burst BETWEEN 0 AND 150119987579),
 CHECK ((rate_per_min = 0) = (burst = 0)),
 CHECK (pool <> 'device' OR (rate_per_min <= 96 AND burst <= 16)),
 CHECK (pool <> 'device-registration' OR (rate_per_min <= 2 AND burst <= 2)),
 PRIMARY KEY (authority_id,pool,audience_id,group_id)
 ) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS admission_budget_allocation_collision
 BEFORE INSERT ON admission_budget_allocations
 WHEN EXISTS (SELECT 1 FROM admission_budget_allocations p WHERE p.authority_id = NEW.authority_id
 AND p.pool = NEW.pool AND p.audience_id = NEW.audience_id AND p.group_id = NEW.group_id)
 BEGIN SELECT RAISE(ABORT,'budget_allocation_collision'); END;
CREATE TRIGGER IF NOT EXISTS admission_budget_allocation_keys
 BEFORE UPDATE ON admission_budget_allocations
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.pool IS NOT OLD.pool
 OR NEW.audience_id IS NOT OLD.audience_id OR NEW.group_id IS NOT OLD.group_id
 BEGIN SELECT RAISE(ABORT,'budget_allocation_keys'); END;
CREATE TRIGGER IF NOT EXISTS admission_budget_allocation_insert
 AFTER INSERT ON admission_budget_allocations WHEN (NEW.pool <> 'authority' AND NOT EXISTS (
 SELECT 1 FROM admission_budget_allocations r WHERE r.authority_id = NEW.authority_id
 AND r.pool = 'authority' AND r.audience_id = '' AND r.group_id = ''))
 OR (NEW.group_id <> '' AND NOT EXISTS (
 SELECT 1 FROM admission_budget_allocations p WHERE p.authority_id = NEW.authority_id
 AND p.pool = NEW.pool AND p.audience_id = NEW.audience_id AND p.group_id = ''))
 OR EXISTS (SELECT 1 FROM admission_budget_allocations p
 WHERE p.authority_id = NEW.authority_id AND p.group_id = '' AND (
 (p.pool = 'authority' AND (
  p.rate_per_min < (SELECT COALESCE(SUM(c.rate_per_min),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool IN ('relay-route','relay-registration','traversal') AND c.group_id = '')
  OR p.burst < (SELECT COALESCE(SUM(c.burst),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool IN ('relay-route','relay-registration','traversal') AND c.group_id = '')))
 OR (p.pool IN ('relay-route','relay-registration','traversal') AND (
  p.rate_per_min < (SELECT COALESCE(SUM(c.rate_per_min),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool = p.pool
    AND c.audience_id = p.audience_id AND c.group_id <> '')
  OR p.burst < (SELECT COALESCE(SUM(c.burst),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool = p.pool
    AND c.audience_id = p.audience_id AND c.group_id <> '')))))
 BEGIN SELECT RAISE(ABORT,'budget_allocation_hierarchy'); END;
CREATE TRIGGER IF NOT EXISTS admission_budget_allocation_update
 AFTER UPDATE ON admission_budget_allocations WHEN (NEW.pool <> 'authority' AND NOT EXISTS (
 SELECT 1 FROM admission_budget_allocations r WHERE r.authority_id = NEW.authority_id
 AND r.pool = 'authority' AND r.audience_id = '' AND r.group_id = ''))
 OR (NEW.group_id <> '' AND NOT EXISTS (
 SELECT 1 FROM admission_budget_allocations p WHERE p.authority_id = NEW.authority_id
 AND p.pool = NEW.pool AND p.audience_id = NEW.audience_id AND p.group_id = ''))
 OR EXISTS (SELECT 1 FROM admission_budget_allocations p
 WHERE p.authority_id = NEW.authority_id AND p.group_id = '' AND (
 (p.pool = 'authority' AND (
  p.rate_per_min < (SELECT COALESCE(SUM(c.rate_per_min),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool IN ('relay-route','relay-registration','traversal') AND c.group_id = '')
  OR p.burst < (SELECT COALESCE(SUM(c.burst),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool IN ('relay-route','relay-registration','traversal') AND c.group_id = '')))
 OR (p.pool IN ('relay-route','relay-registration','traversal') AND (
  p.rate_per_min < (SELECT COALESCE(SUM(c.rate_per_min),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool = p.pool
    AND c.audience_id = p.audience_id AND c.group_id <> '')
  OR p.burst < (SELECT COALESCE(SUM(c.burst),0) FROM admission_budget_allocations c
   WHERE c.authority_id = p.authority_id AND c.pool = p.pool
    AND c.audience_id = p.audience_id AND c.group_id <> '')))))
 BEGIN SELECT RAISE(ABORT,'budget_allocation_hierarchy'); END;
CREATE TRIGGER IF NOT EXISTS admission_budget_allocation_delete BEFORE DELETE ON admission_budget_allocations
 BEGIN SELECT RAISE(ABORT,'budget_allocation_permanent'); END;
CREATE TABLE IF NOT EXISTS admission_budget_buckets (
 authority_id TEXT NOT NULL CHECK (typeof(authority_id) = 'text'
  AND length(CAST(authority_id AS BLOB)) = 64 AND authority_id NOT GLOB '*[^0-9a-f]*'
  AND instr(authority_id,char(0)) = 0),
 pool TEXT NOT NULL CHECK (pool IN ('authority','relay-route','relay-registration','traversal','device','device-registration')),
 audience_id TEXT NOT NULL CHECK (typeof(audience_id) = 'text' AND instr(audience_id,char(0)) = 0
  AND ((pool IN ('relay-route','relay-registration') AND length(CAST(audience_id AS BLOB)) = 64
   AND audience_id NOT GLOB '*[^0-9a-f]*')
  OR (pool NOT IN ('relay-route','relay-registration') AND audience_id = ''))),
 group_id TEXT NOT NULL CHECK (typeof(group_id) = 'text' AND instr(group_id,char(0)) = 0
  AND length(CAST(group_id AS BLOB)) <= 128
  AND (pool <> 'authority' OR group_id = '')
  AND (pool NOT IN ('device','device-registration') OR length(CAST(group_id AS BLOB)) >= 1)),
 device_id TEXT NOT NULL CHECK (typeof(device_id) = 'text' AND instr(device_id,char(0)) = 0
  AND ((pool IN ('device','device-registration') AND length(CAST(device_id AS BLOB)) BETWEEN 1 AND 64
   AND device_id NOT GLOB '*[^!-~]*')
  OR (pool NOT IN ('device','device-registration') AND device_id = ''))),
 units INTEGER NOT NULL CHECK (typeof(units) = 'integer' AND units BETWEEN 0 AND last_capacity),
 refilled_at_ms INTEGER NOT NULL CHECK (typeof(refilled_at_ms) = 'integer' AND refilled_at_ms BETWEEN 0 AND 9007199254740991),
 last_rate INTEGER NOT NULL CHECK (typeof(last_rate) = 'integer' AND last_rate BETWEEN 0 AND 9007199254740991),
 last_capacity INTEGER NOT NULL CHECK (typeof(last_capacity) = 'integer'
  AND last_capacity BETWEEN 0 AND 9007199254740991 AND last_capacity % 60000 = 0),
 exec_id TEXT NOT NULL CHECK (typeof(exec_id) = 'text' AND length(CAST(exec_id AS BLOB)) = 32
  AND exec_id NOT GLOB '*[^0-9a-f]*' AND instr(exec_id,char(0)) = 0),
 granted INTEGER NOT NULL CHECK (typeof(granted) = 'integer' AND granted IN (0,1)),
 CHECK ((last_rate = 0) = (last_capacity = 0)),
 CHECK (pool <> 'device' OR (last_rate <= 96 AND last_capacity <= 960000)),
 CHECK (pool <> 'device-registration' OR (last_rate <= 2 AND last_capacity <= 120000)),
 CHECK ((granted = 1 AND last_rate > 0 AND units <= last_capacity - 60000)
  OR (granted = 0 AND units < 60000)),
 PRIMARY KEY (authority_id,pool,audience_id,group_id,device_id)
 ) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS admission_budget_bucket_allocation BEFORE INSERT ON admission_budget_buckets
 WHEN NOT EXISTS (SELECT 1 FROM admission_budget_allocations p
 WHERE p.authority_id = NEW.authority_id AND p.pool = NEW.pool AND p.audience_id = NEW.audience_id
 AND p.group_id = CASE WHEN NEW.pool IN ('device','device-registration') THEN '' ELSE NEW.group_id END)
 BEGIN SELECT RAISE(ABORT,'budget_bucket_allocation'); END;
CREATE TRIGGER IF NOT EXISTS admission_budget_bucket_update BEFORE UPDATE ON admission_budget_buckets
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.pool IS NOT OLD.pool
 OR NEW.audience_id IS NOT OLD.audience_id OR NEW.group_id IS NOT OLD.group_id OR NEW.device_id IS NOT OLD.device_id
 OR NEW.refilled_at_ms < OLD.refilled_at_ms OR NEW.exec_id IS OLD.exec_id
 BEGIN SELECT RAISE(ABORT,'budget_bucket_update'); END;
CREATE TRIGGER IF NOT EXISTS admission_budget_bucket_delete BEFORE DELETE ON admission_budget_buckets
 BEGIN SELECT RAISE(ABORT,'budget_bucket_permanent'); END;

-- 0043: headless account linking
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

-- Account management (migrations 0046 and 0047): connection history, browser ordering,
-- refresh and device unlink. Each guard statement checks the schema it starts from.
INSERT INTO coordinator_auth_device_claims (claim_id) SELECT NULL WHERE NOT (((SELECT
 (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_attempts') WHERE lower(name) = 'authority_kind')
 + (SELECT count(*) FROM pragma_table_info('coordinator_auth_account_links') WHERE lower(name) IN ('authority_kind','device_claim_id'))
 + (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_audit_log') WHERE lower(name) IN ('authority_kind','device_claim_id'))
 + (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_auth_link_profiles')
 + (EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_auth_device_claims' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'435245415445205441424c45204946204e4f542045584953545320636f6f7264696e61746f725f617574685f6465766963655f636c61696d7320280a2020636c61696d5f69642054455854205052494d415259204b4559204e4f54204e554c4c20434845434b280a20202020747970656f6628636c61696d5f696429203d2027746578742720414e44206c656e67746828636c61696d5f696429204245545745454e203120414e44203235360a20202020414e4420636c61696d5f6964203d207472696d28636c61696d5f69642920414e4420696e73747228636c61696d5f69642c206368617228302929203d2030292c0a2020636f6f7264696e61746f725f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f6628636f6f7264696e61746f725f696429203d2027746578742720414e44206c656e67746828636f6f7264696e61746f725f696429204245545745454e203120414e44203235360a20202020414e4420636f6f7264696e61746f725f6964203d207472696d28636f6f7264696e61746f725f69642920414e4420696e73747228636f6f7264696e61746f725f69642c206368617228302929203d2030292c0a20206964656e746974795f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f66286964656e746974795f696429203d2027746578742720414e44206c656e677468286964656e746974795f696429204245545745454e203120414e44203235360a20202020414e44206964656e746974795f6964203d207472696d286964656e746974795f69642920414e4420696e737472286964656e746974795f69642c206368617228302929203d2030292c0a202067726f75705f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f662867726f75705f696429203d2027746578742720414e44206c656e6774682867726f75705f696429204245545745454e203120414e44203235360a20202020414e442067726f75705f6964203d207472696d2867726f75705f69642920414e4420696e7374722867726f75705f69642c206368617228302929203d2030292c0a20206465766963655f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f66286465766963655f696429203d2027746578742720414e44206c656e677468286465766963655f696429204245545745454e203120414e44203235360a20202020414e44206465766963655f6964203d207472696d286465766963655f69642920414e4420696e737472286465766963655f69642c206368617228302929203d2030292c0a20207075626c69635f6b65792054455854204e4f54204e554c4c20434845434b280a20202020747970656f66287075626c69635f6b657929203d2027746578742720414e44206c656e677468287075626c69635f6b657929204245545745454e203120414e4420343039360a20202020414e44206c656e677468287472696d287265706c616365287265706c616365287075626c69635f6b65792c2063686172283133292c202727292c2063686172283130292c202727292929203e20300a20202020414e4420696e737472287075626c69635f6b65792c206368617228302929203d2030292c0a202066696e6765727072696e742054455854204e4f54204e554c4c20434845434b280a20202020747970656f662866696e6765727072696e7429203d2027746578742720414e44206c656e6774682866696e6765727072696e7429203d2036340a20202020414e442066696e6765727072696e74204e4f5420474c4f4220272a5b5e612d66302d395d2a2720414e4420696e7374722866696e6765727072696e742c206368617228302929203d2030292c0a20206b65795f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f66286b65795f696429203d2027746578742720414e44206c656e677468286b65795f696429203d2036340a20202020414e44206b65795f6964204e4f5420474c4f4220272a5b5e612d66302d395d2a2720414e4420696e737472286b65795f69642c206368617228302929203d2030292c0a2020617474656d70745f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f6628617474656d70745f696429203d2027746578742720414e44206c656e67746828617474656d70745f696429204245545745454e203120414e44203235360a20202020414e4420617474656d70745f6964203d207472696d28617474656d70745f69642920414e4420696e73747228617474656d70745f69642c206368617228302929203d2030292c0a20206973737565722054455854204e4f54204e554c4c20434845434b280a20202020747970656f662869737375657229203d2027746578742720414e44206c656e677468287472696d286973737565722929203e20300a20202020414e4420697373756572203d207472696d286973737565722920414e4420696e737472286973737565722c206368617228302929203d2030292c0a2020617574685f636f6e6669675f7265766973696f6e2054455854204e4f54204e554c4c20434845434b280a20202020747970656f6628617574685f636f6e6669675f7265766973696f6e29203d2027746578742720414e44206c656e67746828617574685f636f6e6669675f7265766973696f6e29203d2036340a20202020414e4420617574685f636f6e6669675f7265766973696f6e204e4f5420474c4f4220272a5b5e612d66302d395d2a2720414e4420696e73747228617574685f636f6e6669675f7265766973696f6e2c206368617228302929203d2030292c0a2020637265617465645f61745f6d7320494e5445474552204e4f54204e554c4c20434845434b280a20202020747970656f6628637265617465645f61745f6d7329203d2027696e74656765722720414e4420637265617465645f61745f6d73204245545745454e203020414e442039303037313939323534373430393931292c0a2020554e495155452028636f6f7264696e61746f725f69642c206964656e746974795f6964292c0a2020554e495155452028636f6f7264696e61746f725f69642c206465766963655f6964292c0a2020554e495155452028636f6f7264696e61746f725f69642c206b65795f6964292c0a2020554e495155452028636f6f7264696e61746f725f69642c20617474656d70745f6964290a2920574954484f555420524f574944' AS TEXT), '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) AND (SELECT count(*) FROM sqlite_master WHERE tbl_name = 'coordinator_auth_device_claims' COLLATE NOCASE AND type IN ('index','trigger') AND sql IS NOT NULL) = 3)) + (EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'coordinator_auth_device_claims_insert_collision' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552204946204e4f542045584953545320636f6f7264696e61746f725f617574685f6465766963655f636c61696d735f696e736572745f636f6c6c6973696f6e0a4245464f524520494e53455254204f4e20636f6f7264696e61746f725f617574685f6465766963655f636c61696d730a5748454e2045584953545320280a202053454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6465766963655f636c61696d730a2020574845524520636c61696d5f6964203d204e45572e636c61696d5f6964204f522028636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f696420414e4420280a202020206964656e746974795f6964203d204e45572e6964656e746974795f6964204f52206465766963655f6964203d204e45572e6465766963655f69640a202020204f52206b65795f6964203d204e45572e6b65795f6964204f5220617474656d70745f6964203d204e45572e617474656d70745f69640a202029290a290a424547494e0a202053454c4543542052414953452841424f52542c2027617574685f6465766963655f636c61696d5f636f6c6c6973696f6e27293b0a454e44' AS TEXT), '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)))) + (EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'coordinator_auth_device_claims_immutable_update' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552204946204e4f542045584953545320636f6f7264696e61746f725f617574685f6465766963655f636c61696d735f696d6d757461626c655f7570646174650a4245464f524520555044415445204f4e20636f6f7264696e61746f725f617574685f6465766963655f636c61696d730a424547494e0a202053454c4543542052414953452841424f52542c2027617574685f6465766963655f636c61696d5f696d6d757461626c6527293b0a454e44' AS TEXT), '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)))) + (EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'coordinator_auth_device_claims_immutable_delete' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552204946204e4f542045584953545320636f6f7264696e61746f725f617574685f6465766963655f636c61696d735f696d6d757461626c655f64656c6574650a4245464f52452044454c455445204f4e20636f6f7264696e61746f725f617574685f6465766963655f636c61696d730a424547494e0a202053454c4543542052414953452841424f52542c2027617574685f6465766963655f636c61696d5f696d6d757461626c6527293b0a454e44' AS TEXT), '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)))) AS ready)=10) AND NOT (SELECT (EXISTS (SELECT 1 FROM sqlite_master WHERE (name GLOB 'account_connection_*' OR name GLOB 'account_change_*' OR name GLOB 'connection_*' OR name GLOB 'coordinator_auth_account_connection_*' OR name = 'coordinator_account_change_attempts' OR name = 'coordinator_auth_account_associations' OR name = 'coordinator_auth_link_change_attempts')) OR EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_link_profiles') WHERE lower(name)='source_change_attempt_id') OR EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_link_profiles') WHERE lower(name)='source_order') OR EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_account_profiles') WHERE lower(name)='source_order') OR EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_browser_transactions') WHERE lower(name)='start_order') OR EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_account_links') WHERE lower(name)='signin_floor') OR EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_session_receipts') WHERE lower(name)='source_order') OR EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_account_connection_history') WHERE lower(name)='signin_floor') OR EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_link_attempts') WHERE lower(name)='prior_link_id')) AS present) AND ((SELECT count(*) FROM pragma_table_info('coordinator_auth_link_attempts')) = 29 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_account_links')) = 12 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_audit_log')) = 13 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_browser_transactions')) = 16 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_sessions')) = 12 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_session_receipts')) = 9 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_profiles')) = 12 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_account_profiles')) = 8));
CREATE TABLE coordinator_auth_account_connection_history (
 coordinator_id TEXT NOT NULL, link_id TEXT NOT NULL, issuer TEXT NOT NULL,
 subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 255), identity_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL, controller_attestation_id TEXT,
 auth_config_revision TEXT NOT NULL CHECK(length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER,
 authority_kind TEXT NOT NULL CHECK(authority_kind IN ('controller_attestation','device_claim')),
 device_claim_id TEXT, original_rowid INTEGER NOT NULL CHECK(typeof(original_rowid) = 'integer'),
 ended_at_ms INTEGER NOT NULL CHECK(typeof(ended_at_ms) = 'integer' AND ended_at_ms BETWEEN 0 AND 9007199254740991 AND ended_at_ms >= created_at_ms),
 end_attempt_id TEXT NOT NULL CHECK(length(end_attempt_id) BETWEEN 1 AND 256),
 successor_link_id TEXT CHECK(successor_link_id IS NULL OR (length(successor_link_id) BETWEEN 1 AND 256 AND successor_link_id <> link_id)),
 PRIMARY KEY(coordinator_id, link_id), UNIQUE(coordinator_id, end_attempt_id),
 UNIQUE(coordinator_id, successor_link_id),
 CHECK((authority_kind = 'controller_attestation' AND controller_attestation_id IS NOT NULL AND device_claim_id IS NULL)
 OR (authority_kind = 'device_claim' AND controller_attestation_id IS NULL AND device_claim_id IS NOT NULL))
);
CREATE TRIGGER account_connection_history_insert BEFORE INSERT ON coordinator_auth_account_connection_history
WHEN NEW.successor_link_id IS NOT NULL
 OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history WHERE rowid = NEW.rowid)
 OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history WHERE coordinator_id = NEW.coordinator_id AND (link_id = NEW.link_id OR end_attempt_id = NEW.end_attempt_id))
 OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history WHERE coordinator_id = NEW.coordinator_id AND identity_id = NEW.identity_id AND successor_link_id IS NULL)
 OR NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links c WHERE c.rowid = NEW.original_rowid AND c.coordinator_id IS NEW.coordinator_id AND c.link_id IS NEW.link_id AND c.issuer IS NEW.issuer AND c.subject IS NEW.subject AND c.identity_id IS NEW.identity_id AND c.attempt_id IS NEW.attempt_id AND c.controller_attestation_id IS NEW.controller_attestation_id AND c.auth_config_revision IS NEW.auth_config_revision AND c.created_at_ms IS NEW.created_at_ms AND c.revoked_at_ms IS NEW.revoked_at_ms AND c.authority_kind IS NEW.authority_kind AND c.device_claim_id IS NEW.device_claim_id)
BEGIN SELECT RAISE(ABORT, 'connection_archive_source_invalid'); END;
CREATE TRIGGER account_connection_history_rowid AFTER INSERT ON coordinator_auth_account_connection_history
 WHEN NEW.rowid < 1
 BEGIN SELECT RAISE(ABORT, 'connection_archive_source_invalid'); END;
CREATE TRIGGER account_connection_history_update BEFORE UPDATE ON coordinator_auth_account_connection_history
WHEN NEW.coordinator_id IS NOT OLD.coordinator_id OR NEW.link_id IS NOT OLD.link_id OR NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject OR NEW.identity_id IS NOT OLD.identity_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.controller_attestation_id IS NOT OLD.controller_attestation_id OR NEW.auth_config_revision IS NOT OLD.auth_config_revision OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.authority_kind IS NOT OLD.authority_kind OR NEW.device_claim_id IS NOT OLD.device_claim_id
 OR NEW.rowid IS NOT OLD.rowid
 OR NEW.original_rowid IS NOT OLD.original_rowid OR NEW.ended_at_ms IS NOT OLD.ended_at_ms
 OR NEW.end_attempt_id IS NOT OLD.end_attempt_id
 OR (NEW.revoked_at_ms IS NOT OLD.revoked_at_ms AND (OLD.revoked_at_ms IS NOT NULL OR typeof(NEW.revoked_at_ms) <> 'integer' OR NEW.revoked_at_ms < 0 OR NEW.revoked_at_ms > 9007199254740991))
 OR (NEW.successor_link_id IS NOT OLD.successor_link_id AND (
 OLD.successor_link_id IS NOT NULL OR NEW.successor_link_id IS NULL OR NEW.revoked_at_ms IS NOT NULL
 OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = NEW.coordinator_id AND h.successor_link_id = NEW.successor_link_id AND h.link_id <> OLD.link_id)
 OR NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links c WHERE c.coordinator_id = OLD.coordinator_id AND c.link_id = NEW.successor_link_id AND c.identity_id = OLD.identity_id AND c.revoked_at_ms IS NULL)
 OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = OLD.coordinator_id AND h.identity_id = OLD.identity_id AND h.revoked_at_ms IS NOT NULL)))
BEGIN SELECT RAISE(ABORT, 'connection_history_immutable'); END;
CREATE TRIGGER account_connection_history_delete BEFORE DELETE ON coordinator_auth_account_connection_history
BEGIN SELECT RAISE(ABORT, 'connection_history_immutable'); END;
CREATE TRIGGER account_connection_current_insert BEFORE INSERT ON coordinator_auth_account_links
WHEN EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = NEW.coordinator_id AND (
 h.link_id = NEW.link_id OR (h.issuer = NEW.issuer AND h.subject = NEW.subject AND h.identity_id <> NEW.identity_id)
 OR (h.identity_id = NEW.identity_id AND h.revoked_at_ms IS NOT NULL)))
BEGIN SELECT RAISE(ABORT, 'connection_reserved_or_revoked'); END;
CREATE TRIGGER account_connection_claim_history BEFORE INSERT ON coordinator_auth_device_claims
WHEN EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = NEW.coordinator_id AND h.identity_id = NEW.identity_id)
BEGIN SELECT RAISE(ABORT, 'connection_claim_history_reserved'); END;
CREATE TABLE coordinator_auth_account_connection_orders (
 coordinator_id TEXT PRIMARY KEY NOT NULL,
 last_order INTEGER NOT NULL CHECK(typeof(last_order) = 'integer' AND last_order BETWEEN 0 AND 9007199254740991)
) WITHOUT ROWID;
CREATE TRIGGER account_connection_order_insert BEFORE INSERT ON coordinator_auth_account_connection_orders
WHEN NEW.last_order <> 0 OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_orders WHERE coordinator_id = NEW.coordinator_id)
BEGIN SELECT RAISE(ABORT, 'connection_order_reset'); END;
CREATE TRIGGER account_connection_order_update BEFORE UPDATE ON coordinator_auth_account_connection_orders
WHEN NEW.coordinator_id IS NOT OLD.coordinator_id OR NEW.last_order <> OLD.last_order + 1
BEGIN SELECT RAISE(ABORT, 'connection_order_reset'); END;
CREATE TRIGGER account_connection_order_delete BEFORE DELETE ON coordinator_auth_account_connection_orders
BEGIN SELECT RAISE(ABORT, 'connection_order_reset'); END;
CREATE TABLE coordinator_account_change_attempts (
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
);
CREATE TRIGGER account_change_collision BEFORE INSERT ON coordinator_account_change_attempts
WHEN EXISTS (SELECT 1 FROM coordinator_account_change_attempts WHERE coordinator_id = NEW.coordinator_id AND
 (attempt_id = NEW.attempt_id OR browser_start_hash = NEW.browser_start_hash OR runtime_verifier_hash = NEW.runtime_verifier_hash OR state_hash = NEW.state_hash OR binder_hash = NEW.binder_hash OR completion_secret_hash = NEW.completion_secret_hash))
BEGIN SELECT RAISE(ABORT,'account_change_collision'); END;
CREATE TRIGGER account_change_birth BEFORE UPDATE ON coordinator_account_change_attempts
WHEN NEW.coordinator_id IS NOT OLD.coordinator_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.intent IS NOT OLD.intent OR NEW.target_link_id IS NOT OLD.target_link_id OR NEW.identity_id IS NOT OLD.identity_id OR NEW.issuer IS NOT OLD.issuer OR NEW.target_subject IS NOT OLD.target_subject OR NEW.group_id IS NOT OLD.group_id OR NEW.device_id IS NOT OLD.device_id OR NEW.public_key IS NOT OLD.public_key OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.key_id IS NOT OLD.key_id OR NEW.enrollment_identity_id IS NOT OLD.enrollment_identity_id OR NEW.auth_config_revision IS NOT OLD.auth_config_revision OR NEW.runtime_verifier_hash IS NOT OLD.runtime_verifier_hash OR NEW.browser_start_hash IS NOT OLD.browser_start_hash OR NEW.loopback_redirect IS NOT OLD.loopback_redirect OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT,'account_change_birth_immutable'); END;
CREATE TRIGGER account_change_transition BEFORE UPDATE ON coordinator_account_change_attempts
WHEN OLD.state IN ('completed','cancelled','failed','expired') OR NOT (
 (OLD.state = 'pending' AND NEW.state = 'browser_pending') OR
 (OLD.state = 'browser_pending' AND NEW.state = 'consumed') OR
 (OLD.state = 'consumed' AND ((OLD.intent = 'refresh' AND NEW.state = 'confirmed') OR (OLD.intent = 'disconnect' AND NEW.state = 'verified'))) OR
 (OLD.state = 'verified' AND NEW.state = 'confirmed') OR
 (OLD.state = 'confirmed' AND NEW.state = 'committing') OR
 (OLD.state = 'committing' AND NEW.state = 'completed') OR
 (OLD.state NOT IN ('committing','completed','cancelled','failed','expired') AND NEW.state IN ('cancelled','expired')) OR
 (OLD.state = 'consumed' AND NEW.state = 'failed'))
BEGIN SELECT RAISE(ABORT,'account_change_transition_invalid'); END;
CREATE TRIGGER account_change_receipt_delete BEFORE DELETE ON coordinator_account_change_attempts WHEN OLD.state = 'completed'
BEGIN SELECT RAISE(ABORT,'account_change_receipt_immutable'); END;
CREATE TRIGGER account_change_archive_receipt BEFORE INSERT ON coordinator_auth_account_connection_history
WHEN NOT EXISTS (SELECT 1 FROM coordinator_account_change_attempts a WHERE a.coordinator_id = NEW.coordinator_id
 AND a.attempt_id = NEW.end_attempt_id AND a.state = 'committing' AND a.intent = 'disconnect'
 AND a.target_link_id = NEW.link_id AND a.identity_id = NEW.identity_id AND a.issuer = NEW.issuer AND a.target_subject = NEW.subject)
BEGIN SELECT RAISE(ABORT,'account_change_archive_receipt_invalid'); END;
CREATE INDEX account_connection_history_identity_revoked ON coordinator_auth_account_connection_history(coordinator_id,identity_id,revoked_at_ms);
ALTER TABLE coordinator_auth_link_profiles ADD COLUMN source_change_attempt_id TEXT;
ALTER TABLE coordinator_auth_link_profiles ADD COLUMN source_order INTEGER;
ALTER TABLE coordinator_auth_account_profiles ADD COLUMN source_order INTEGER;
ALTER TABLE coordinator_auth_browser_transactions ADD COLUMN start_order INTEGER;
ALTER TABLE coordinator_auth_account_links ADD COLUMN signin_floor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE coordinator_auth_session_receipts ADD COLUMN source_order INTEGER;
ALTER TABLE coordinator_auth_account_connection_history ADD COLUMN signin_floor INTEGER;
CREATE TRIGGER connection_history_floor_insert BEFORE INSERT ON coordinator_auth_account_connection_history
 WHEN NEW.signin_floor IS NOT (SELECT c.signin_floor FROM coordinator_auth_account_links c WHERE c.coordinator_id=NEW.coordinator_id AND c.link_id=NEW.link_id AND c.rowid=NEW.original_rowid)
 BEGIN SELECT RAISE(ABORT,'connection_archive_floor_invalid'); END;
CREATE TRIGGER connection_history_floor_update BEFORE UPDATE ON coordinator_auth_account_connection_history WHEN NEW.signin_floor IS NOT OLD.signin_floor BEGIN SELECT RAISE(ABORT,'connection_history_immutable'); END;
CREATE TRIGGER connection_link_shared_admission BEFORE INSERT ON coordinator_auth_link_attempts WHEN NOT EXISTS (WITH connection_budget AS MATERIALIZED (
 SELECT group_id,device_id,identity_id,state,created_at_ms,expires_at_ms FROM coordinator_account_change_attempts WHERE coordinator_id = NEW.coordinator_id
 UNION ALL SELECT group_id,device_id,identity_id,state,created_at_ms,expires_at_ms FROM coordinator_auth_link_attempts WHERE coordinator_id = NEW.coordinator_id)
 SELECT 1 WHERE
 (SELECT count(*) FROM connection_budget b WHERE b.group_id = NEW.group_id AND b.device_id = NEW.device_id AND b.state NOT IN ('completed','finalized','session_redeemed','failed','expired','cancelled') AND b.expires_at_ms > NEW.created_at_ms) < 2
 AND (SELECT count(*) FROM connection_budget b WHERE b.identity_id = NEW.identity_id AND b.state NOT IN ('completed','finalized','session_redeemed','failed','expired','cancelled') AND b.expires_at_ms > NEW.created_at_ms) < 3
 AND (SELECT count(*) FROM connection_budget b WHERE b.group_id = NEW.group_id AND b.device_id = NEW.device_id AND b.created_at_ms > NEW.created_at_ms - 3600000) < 6
 AND (SELECT count(*) FROM connection_budget b WHERE b.group_id = NEW.group_id AND b.device_id = NEW.device_id AND b.created_at_ms > NEW.created_at_ms - 2592000000) < 60
 AND (SELECT count(*) FROM connection_budget b WHERE b.state NOT IN ('completed','finalized','session_redeemed')) < 10000) BEGIN SELECT RAISE(ABORT,'connection_attempt_limited'); END;
ALTER TABLE coordinator_auth_link_attempts ADD COLUMN prior_link_id TEXT;
CREATE TRIGGER connection_link_prior_immutable BEFORE UPDATE ON coordinator_auth_link_attempts WHEN NEW.prior_link_id IS NOT OLD.prior_link_id AND (OLD.state <> 'pending' OR OLD.prior_link_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'connection_prior_immutable'); END;
CREATE UNIQUE INDEX connection_history_head ON coordinator_auth_account_connection_history(coordinator_id,identity_id) WHERE successor_link_id IS NULL;
INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT coordinator_id,0 FROM (SELECT coordinator_id FROM coordinator_auth_account_links UNION SELECT coordinator_id FROM coordinator_auth_browser_transactions UNION SELECT coordinator_id FROM coordinator_auth_link_attempts UNION SELECT coordinator_id FROM coordinator_auth_sessions);
UPDATE coordinator_auth_account_connection_orders SET last_order=last_order+1;
UPDATE coordinator_auth_link_profiles SET source_order=0;
UPDATE coordinator_auth_account_profiles SET source_order=1;
UPDATE coordinator_auth_session_receipts AS r SET source_order=1
 WHERE r.source='signin' AND r.attempt_id IS NULL AND EXISTS (
 SELECT 1 FROM coordinator_auth_account_profiles p WHERE p.coordinator_id=r.coordinator_id
 AND p.link_id=r.link_id AND p.source_session_id=r.session_id
 AND p.source_signed_in_at_ms=r.created_at_ms AND p.source_order=1);
CREATE TABLE coordinator_auth_account_connection_unlinks (
 coordinator_id TEXT NOT NULL, attempt_id TEXT NOT NULL, target_link_id TEXT NOT NULL,
 identity_id TEXT NOT NULL, issuer TEXT NOT NULL, target_subject TEXT NOT NULL,
 group_id TEXT NOT NULL, device_id TEXT NOT NULL, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 enrollment_identity_id TEXT, auth_config_revision TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('committing','completed')),
 created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms)='integer' AND created_at_ms BETWEEN 0 AND 9007199254740991),
 completed_at_ms INTEGER,
 PRIMARY KEY(coordinator_id,attempt_id), UNIQUE(coordinator_id,target_link_id),
 CHECK((state='completed')=(completed_at_ms IS NOT NULL)),
 CHECK(completed_at_ms IS NULL OR (typeof(completed_at_ms)='integer' AND completed_at_ms>=created_at_ms AND completed_at_ms<=9007199254740991))
 );
CREATE TRIGGER account_connection_unlink_insert BEFORE INSERT ON coordinator_auth_account_connection_unlinks
 WHEN NEW.state<>'committing' OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_unlinks WHERE rowid=NEW.rowid OR (coordinator_id=NEW.coordinator_id AND (attempt_id=NEW.attempt_id OR target_link_id=NEW.target_link_id)))
 BEGIN SELECT RAISE(ABORT,'account_unlink_collision'); END;
CREATE TRIGGER account_connection_unlink_rowid AFTER INSERT ON coordinator_auth_account_connection_unlinks WHEN NEW.rowid<1
 BEGIN SELECT RAISE(ABORT,'account_unlink_rowid'); END;
CREATE TRIGGER account_connection_unlink_update BEFORE UPDATE ON coordinator_auth_account_connection_unlinks
 WHEN NEW.coordinator_id IS NOT OLD.coordinator_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.target_link_id IS NOT OLD.target_link_id OR NEW.identity_id IS NOT OLD.identity_id OR NEW.issuer IS NOT OLD.issuer OR NEW.target_subject IS NOT OLD.target_subject OR NEW.group_id IS NOT OLD.group_id OR NEW.device_id IS NOT OLD.device_id OR NEW.public_key IS NOT OLD.public_key OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.enrollment_identity_id IS NOT OLD.enrollment_identity_id OR NEW.auth_config_revision IS NOT OLD.auth_config_revision OR NEW.request_hash IS NOT OLD.request_hash OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.rowid IS NOT OLD.rowid OR OLD.state<>'committing' OR NEW.state<>'completed'
 BEGIN SELECT RAISE(ABORT,'account_unlink_immutable'); END;
CREATE TRIGGER account_connection_unlink_delete BEFORE DELETE ON coordinator_auth_account_connection_unlinks
 BEGIN SELECT RAISE(ABORT,'account_unlink_immutable'); END;
DROP TRIGGER account_change_archive_receipt;
CREATE TRIGGER account_change_archive_receipt BEFORE INSERT ON coordinator_auth_account_connection_history
WHEN NOT EXISTS (SELECT 1 FROM coordinator_account_change_attempts a WHERE a.coordinator_id = NEW.coordinator_id
 AND a.attempt_id = NEW.end_attempt_id AND a.state = 'committing' AND a.intent = 'disconnect'
 AND a.target_link_id = NEW.link_id AND a.identity_id = NEW.identity_id AND a.issuer = NEW.issuer AND a.target_subject = NEW.subject)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_connection_unlinks a WHERE a.coordinator_id=NEW.coordinator_id
 AND a.attempt_id=NEW.end_attempt_id AND a.state='committing' AND a.target_link_id=NEW.link_id
 AND a.identity_id=NEW.identity_id AND a.issuer=NEW.issuer AND a.target_subject=NEW.subject)
BEGIN SELECT RAISE(ABORT,'account_change_archive_receipt_invalid'); END;
INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT NULL,0 WHERE NOT (SELECT min(column1) AS ready FROM (VALUES (CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_auth_account_connection_history' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''*[^0-9a-f]*''', 'literal_0'), '''controller_attestation''', 'literal_1'), '''device_claim''', 'literal_2'), '''integer''', 'literal_3'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'435245415445205441424c4520636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f727920280a20636f6f7264696e61746f725f69642054455854204e4f54204e554c4c2c206c696e6b5f69642054455854204e4f54204e554c4c2c206973737565722054455854204e4f54204e554c4c2c0a207375626a6563742054455854204e4f54204e554c4c20434845434b286c656e677468287375626a65637429204245545745454e203120414e4420323535292c206964656e746974795f69642054455854204e4f54204e554c4c2c0a20617474656d70745f69642054455854204e4f54204e554c4c2c20636f6e74726f6c6c65725f6174746573746174696f6e5f696420544558542c0a20617574685f636f6e6669675f7265766973696f6e2054455854204e4f54204e554c4c20434845434b286c656e67746828617574685f636f6e6669675f7265766973696f6e29203d20363420414e4420617574685f636f6e6669675f7265766973696f6e204e4f5420474c4f4220272a5b5e302d39612d665d2a27292c0a20637265617465645f61745f6d7320494e5445474552204e4f54204e554c4c2c207265766f6b65645f61745f6d7320494e54454745522c0a20617574686f726974795f6b696e642054455854204e4f54204e554c4c20434845434b28617574686f726974795f6b696e6420494e202827636f6e74726f6c6c65725f6174746573746174696f6e272c276465766963655f636c61696d2729292c0a206465766963655f636c61696d5f696420544558542c206f726967696e616c5f726f77696420494e5445474552204e4f54204e554c4c20434845434b28747970656f66286f726967696e616c5f726f77696429203d2027696e746567657227292c0a20656e6465645f61745f6d7320494e5445474552204e4f54204e554c4c20434845434b28747970656f6628656e6465645f61745f6d7329203d2027696e74656765722720414e4420656e6465645f61745f6d73204245545745454e203020414e44203930303731393932353437343039393120414e4420656e6465645f61745f6d73203e3d20637265617465645f61745f6d73292c0a20656e645f617474656d70745f69642054455854204e4f54204e554c4c20434845434b286c656e67746828656e645f617474656d70745f696429204245545745454e203120414e4420323536292c0a20737563636573736f725f6c696e6b5f6964205445585420434845434b28737563636573736f725f6c696e6b5f6964204953204e554c4c204f5220286c656e67746828737563636573736f725f6c696e6b5f696429204245545745454e203120414e442032353620414e4420737563636573736f725f6c696e6b5f6964203c3e206c696e6b5f696429292c0a207369676e696e5f666c6f6f7220494e54454745522c0a205052494d415259204b455928636f6f7264696e61746f725f69642c206c696e6b5f6964292c20554e4951554528636f6f7264696e61746f725f69642c20656e645f617474656d70745f6964292c0a20554e4951554528636f6f7264696e61746f725f69642c20737563636573736f725f6c696e6b5f6964292c0a20434845434b2828617574686f726974795f6b696e64203d2027636f6e74726f6c6c65725f6174746573746174696f6e2720414e4420636f6e74726f6c6c65725f6174746573746174696f6e5f6964204953204e4f54204e554c4c20414e44206465766963655f636c61696d5f6964204953204e554c4c290a204f522028617574686f726974795f6b696e64203d20276465766963655f636c61696d2720414e4420636f6e74726f6c6c65725f6174746573746174696f6e5f6964204953204e554c4c20414e44206465766963655f636c61696d5f6964204953204e4f54204e554c4c29290a29' AS TEXT), '''*[^0-9a-f]*''', 'literal_0'), '''controller_attestation''', 'literal_1'), '''device_claim''', 'literal_2'), '''integer''', 'literal_3'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) AND (SELECT count(*) FROM sqlite_master WHERE tbl_name = 'coordinator_auth_account_connection_history' COLLATE NOCASE AND type IN ('index','trigger') AND sql IS NOT NULL) = 9) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_history_insert' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''connection_archive_source_invalid''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f686973746f72795f696e73657274204245464f524520494e53455254204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f72790a5748454e204e45572e737563636573736f725f6c696e6b5f6964204953204e4f54204e554c4c0a204f5220455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f727920574845524520726f776964203d204e45572e726f776964290a204f5220455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f727920574845524520636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f696420414e4420286c696e6b5f6964203d204e45572e6c696e6b5f6964204f5220656e645f617474656d70745f6964203d204e45572e656e645f617474656d70745f696429290a204f5220455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f727920574845524520636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f696420414e44206964656e746974795f6964203d204e45572e6964656e746974795f696420414e4420737563636573736f725f6c696e6b5f6964204953204e554c4c290a204f52204e4f5420455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f6c696e6b73206320574845524520632e726f776964203d204e45572e6f726967696e616c5f726f77696420414e4420632e636f6f7264696e61746f725f6964204953204e45572e636f6f7264696e61746f725f696420414e4420632e6c696e6b5f6964204953204e45572e6c696e6b5f696420414e4420632e697373756572204953204e45572e69737375657220414e4420632e7375626a656374204953204e45572e7375626a65637420414e4420632e6964656e746974795f6964204953204e45572e6964656e746974795f696420414e4420632e617474656d70745f6964204953204e45572e617474656d70745f696420414e4420632e636f6e74726f6c6c65725f6174746573746174696f6e5f6964204953204e45572e636f6e74726f6c6c65725f6174746573746174696f6e5f696420414e4420632e617574685f636f6e6669675f7265766973696f6e204953204e45572e617574685f636f6e6669675f7265766973696f6e20414e4420632e637265617465645f61745f6d73204953204e45572e637265617465645f61745f6d7320414e4420632e7265766f6b65645f61745f6d73204953204e45572e7265766f6b65645f61745f6d7320414e4420632e617574686f726974795f6b696e64204953204e45572e617574686f726974795f6b696e6420414e4420632e6465766963655f636c61696d5f6964204953204e45572e6465766963655f636c61696d5f6964290a424547494e2053454c4543542052414953452841424f52542c2027636f6e6e656374696f6e5f617263686976655f736f757263655f696e76616c696427293b20454e44' AS TEXT), '''connection_archive_source_invalid''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_history_rowid' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''connection_archive_source_invalid''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f686973746f72795f726f77696420414654455220494e53455254204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f72790a205748454e204e45572e726f776964203c20310a20424547494e2053454c4543542052414953452841424f52542c2027636f6e6e656374696f6e5f617263686976655f736f757263655f696e76616c696427293b20454e44' AS TEXT), '''connection_archive_source_invalid''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_history_update' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(sql, '''integer''', 'literal_0'), '''connection_history_immutable''', 'literal_1'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f686973746f72795f757064617465204245464f524520555044415445204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f72790a5748454e204e45572e636f6f7264696e61746f725f6964204953204e4f54204f4c442e636f6f7264696e61746f725f6964204f52204e45572e6c696e6b5f6964204953204e4f54204f4c442e6c696e6b5f6964204f52204e45572e697373756572204953204e4f54204f4c442e697373756572204f52204e45572e7375626a656374204953204e4f54204f4c442e7375626a656374204f52204e45572e6964656e746974795f6964204953204e4f54204f4c442e6964656e746974795f6964204f52204e45572e617474656d70745f6964204953204e4f54204f4c442e617474656d70745f6964204f52204e45572e636f6e74726f6c6c65725f6174746573746174696f6e5f6964204953204e4f54204f4c442e636f6e74726f6c6c65725f6174746573746174696f6e5f6964204f52204e45572e617574685f636f6e6669675f7265766973696f6e204953204e4f54204f4c442e617574685f636f6e6669675f7265766973696f6e204f52204e45572e637265617465645f61745f6d73204953204e4f54204f4c442e637265617465645f61745f6d73204f52204e45572e617574686f726974795f6b696e64204953204e4f54204f4c442e617574686f726974795f6b696e64204f52204e45572e6465766963655f636c61696d5f6964204953204e4f54204f4c442e6465766963655f636c61696d5f69640a204f52204e45572e726f776964204953204e4f54204f4c442e726f7769640a204f52204e45572e6f726967696e616c5f726f776964204953204e4f54204f4c442e6f726967696e616c5f726f776964204f52204e45572e656e6465645f61745f6d73204953204e4f54204f4c442e656e6465645f61745f6d730a204f52204e45572e656e645f617474656d70745f6964204953204e4f54204f4c442e656e645f617474656d70745f69640a204f5220284e45572e7265766f6b65645f61745f6d73204953204e4f54204f4c442e7265766f6b65645f61745f6d7320414e4420284f4c442e7265766f6b65645f61745f6d73204953204e4f54204e554c4c204f5220747970656f66284e45572e7265766f6b65645f61745f6d7329203c3e2027696e746567657227204f52204e45572e7265766f6b65645f61745f6d73203c2030204f52204e45572e7265766f6b65645f61745f6d73203e203930303731393932353437343039393129290a204f5220284e45572e737563636573736f725f6c696e6b5f6964204953204e4f54204f4c442e737563636573736f725f6c696e6b5f696420414e4420280a204f4c442e737563636573736f725f6c696e6b5f6964204953204e4f54204e554c4c204f52204e45572e737563636573736f725f6c696e6b5f6964204953204e554c4c204f52204e45572e7265766f6b65645f61745f6d73204953204e4f54204e554c4c0a204f5220455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f7279206820574845524520682e636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f696420414e4420682e737563636573736f725f6c696e6b5f6964203d204e45572e737563636573736f725f6c696e6b5f696420414e4420682e6c696e6b5f6964203c3e204f4c442e6c696e6b5f6964290a204f52204e4f5420455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f6c696e6b73206320574845524520632e636f6f7264696e61746f725f6964203d204f4c442e636f6f7264696e61746f725f696420414e4420632e6c696e6b5f6964203d204e45572e737563636573736f725f6c696e6b5f696420414e4420632e6964656e746974795f6964203d204f4c442e6964656e746974795f696420414e4420632e7265766f6b65645f61745f6d73204953204e554c4c290a204f5220455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f7279206820574845524520682e636f6f7264696e61746f725f6964203d204f4c442e636f6f7264696e61746f725f696420414e4420682e6964656e746974795f6964203d204f4c442e6964656e746974795f696420414e4420682e7265766f6b65645f61745f6d73204953204e4f54204e554c4c2929290a424547494e2053454c4543542052414953452841424f52542c2027636f6e6e656374696f6e5f686973746f72795f696d6d757461626c6527293b20454e44' AS TEXT), '''integer''', 'literal_0'), '''connection_history_immutable''', 'literal_1'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_history_delete' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''connection_history_immutable''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f686973746f72795f64656c657465204245464f52452044454c455445204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f72790a424547494e2053454c4543542052414953452841424f52542c2027636f6e6e656374696f6e5f686973746f72795f696d6d757461626c6527293b20454e44' AS TEXT), '''connection_history_immutable''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_current_insert' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''connection_reserved_or_revoked''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f63757272656e745f696e73657274204245464f524520494e53455254204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f6c696e6b730a5748454e20455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f7279206820574845524520682e636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f696420414e4420280a20682e6c696e6b5f6964203d204e45572e6c696e6b5f6964204f522028682e697373756572203d204e45572e69737375657220414e4420682e7375626a656374203d204e45572e7375626a65637420414e4420682e6964656e746974795f6964203c3e204e45572e6964656e746974795f6964290a204f522028682e6964656e746974795f6964203d204e45572e6964656e746974795f696420414e4420682e7265766f6b65645f61745f6d73204953204e4f54204e554c4c2929290a424547494e2053454c4543542052414953452841424f52542c2027636f6e6e656374696f6e5f72657365727665645f6f725f7265766f6b656427293b20454e44' AS TEXT), '''connection_reserved_or_revoked''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_claim_history' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''connection_claim_history_reserved''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f636c61696d5f686973746f7279204245464f524520494e53455254204f4e20636f6f7264696e61746f725f617574685f6465766963655f636c61696d730a5748454e20455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f7279206820574845524520682e636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f696420414e4420682e6964656e746974795f6964203d204e45572e6964656e746974795f6964290a424547494e2053454c4543542052414953452841424f52542c2027636f6e6e656374696f6e5f636c61696d5f686973746f72795f726573657276656427293b20454e44' AS TEXT), '''connection_claim_history_reserved''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_auth_account_connection_orders' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''integer''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'435245415445205441424c4520636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f6f726465727320280a20636f6f7264696e61746f725f69642054455854205052494d415259204b4559204e4f54204e554c4c2c0a206c6173745f6f7264657220494e5445474552204e4f54204e554c4c20434845434b28747970656f66286c6173745f6f7264657229203d2027696e74656765722720414e44206c6173745f6f72646572204245545745454e203020414e442039303037313939323534373430393931290a2920574954484f555420524f574944' AS TEXT), '''integer''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) AND (SELECT count(*) FROM sqlite_master WHERE tbl_name = 'coordinator_auth_account_connection_orders' COLLATE NOCASE AND type IN ('index','trigger') AND sql IS NOT NULL) = 3) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_order_insert' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''connection_order_reset''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f6f726465725f696e73657274204245464f524520494e53455254204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f6f72646572730a5748454e204e45572e6c6173745f6f72646572203c3e2030204f5220455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f6f726465727320574845524520636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f6964290a424547494e2053454c4543542052414953452841424f52542c2027636f6e6e656374696f6e5f6f726465725f726573657427293b20454e44' AS TEXT), '''connection_order_reset''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_order_update' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''connection_order_reset''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f6f726465725f757064617465204245464f524520555044415445204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f6f72646572730a5748454e204e45572e636f6f7264696e61746f725f6964204953204e4f54204f4c442e636f6f7264696e61746f725f6964204f52204e45572e6c6173745f6f72646572203c3e204f4c442e6c6173745f6f72646572202b20310a424547494e2053454c4543542052414953452841424f52542c2027636f6e6e656374696f6e5f6f726465725f726573657427293b20454e44' AS TEXT), '''connection_order_reset''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_order_delete' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''connection_order_reset''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f6f726465725f64656c657465204245464f52452044454c455445204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f6f72646572730a424547494e2053454c4543542052414953452841424f52542c2027636f6e6e656374696f6e5f6f726465725f726573657427293b20454e44' AS TEXT), '''connection_order_reset''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_account_change_attempts' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''refresh''', 'literal_0'), '''disconnect''', 'literal_1'), '''pending''', 'literal_2'), '''browser_pending''', 'literal_3'), '''consumed''', 'literal_4'), '''verified''', 'literal_5'), '''confirmed''', 'literal_6'), '''committing''', 'literal_7'), '''completed''', 'literal_8'), '''cancelled''', 'literal_9'), '''failed''', 'literal_10'), '''expired''', 'literal_11'), '''device_cancelled''', 'literal_12'), '''provider_failure''', 'literal_13'), '''integer''', 'literal_14'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'435245415445205441424c4520636f6f7264696e61746f725f6163636f756e745f6368616e67655f617474656d70747320280a20636f6f7264696e61746f725f69642054455854204e4f54204e554c4c2c20617474656d70745f69642054455854204e4f54204e554c4c2c0a20696e74656e742054455854204e4f54204e554c4c20434845434b28696e74656e7420494e20282772656672657368272c27646973636f6e6e6563742729292c0a207461726765745f6c696e6b5f69642054455854204e4f54204e554c4c2c206964656e746974795f69642054455854204e4f54204e554c4c2c206973737565722054455854204e4f54204e554c4c2c207461726765745f7375626a6563742054455854204e4f54204e554c4c2c0a2067726f75705f69642054455854204e4f54204e554c4c2c206465766963655f69642054455854204e4f54204e554c4c2c207075626c69635f6b65792054455854204e4f54204e554c4c2c2066696e6765727072696e742054455854204e4f54204e554c4c2c0a206b65795f69642054455854204e4f54204e554c4c2c20656e726f6c6c6d656e745f6964656e746974795f696420544558542c20617574685f636f6e6669675f7265766973696f6e2054455854204e4f54204e554c4c2c0a2072756e74696d655f76657269666965725f686173682054455854204e4f54204e554c4c2c2062726f777365725f73746172745f686173682054455854204e4f54204e554c4c2c206c6f6f706261636b5f72656469726563742054455854204e4f54204e554c4c2c0a2073746174652054455854204e4f54204e554c4c20434845434b28737461746520494e20282770656e64696e67272c2762726f777365725f70656e64696e67272c27636f6e73756d6564272c277665726966696564272c27636f6e6669726d6564272c27636f6d6d697474696e67272c27636f6d706c65746564272c2763616e63656c6c6564272c276661696c6564272c27657870697265642729292c0a206661696c7572655f726561736f6e205445585420434845434b286661696c7572655f726561736f6e20494e2028276465766963655f63616e63656c6c6564272c2770726f76696465725f6661696c757265272c27657870697265642729292c0a2073746174655f6861736820544558542c2062696e6465725f6861736820544558542c206e6f6e636520544558542c20706b63655f766572696669657220544558542c2062726f777365725f6f7264657220494e54454745522c0a20636f6d706c6574696f6e5f7365637265745f6861736820544558542c20646973706c61795f6e616d6520544558542c20656d61696c20544558542c20656d61696c5f766572696669656420494e54454745522c20706963747572655f75726c20544558542c0a20637265617465645f61745f6d7320494e5445474552204e4f54204e554c4c2c20657870697265735f61745f6d7320494e5445474552204e4f54204e554c4c2c0a20636f6e73756d65645f61745f6d7320494e54454745522c2076657269666965645f61745f6d7320494e54454745522c20636f6e6669726d65645f61745f6d7320494e54454745522c20636f6d706c657465645f61745f6d7320494e54454745522c0a205052494d415259204b455928636f6f7264696e61746f725f69642c617474656d70745f6964292c20554e4951554528636f6f7264696e61746f725f69642c62726f777365725f73746172745f68617368292c0a20554e4951554528636f6f7264696e61746f725f69642c72756e74696d655f76657269666965725f68617368292c20554e4951554528636f6f7264696e61746f725f69642c73746174655f68617368292c0a20554e4951554528636f6f7264696e61746f725f69642c62696e6465725f68617368292c20554e4951554528636f6f7264696e61746f725f69642c636f6d706c6574696f6e5f7365637265745f68617368292c0a20434845434b28747970656f6628637265617465645f61745f6d7329203d2027696e74656765722720414e4420637265617465645f61745f6d73204245545745454e203020414e44203930303731393932353431343039393120414e4420657870697265735f61745f6d73203d20637265617465645f61745f6d73202b20363030303030292c0a20434845434b2862726f777365725f6f72646572204953204e554c4c204f522028747970656f662862726f777365725f6f7264657229203d2027696e74656765722720414e442062726f777365725f6f72646572204245545745454e203120414e44203930303731393932353437343039393129292c0a20434845434b28287374617465203d2027636f6d706c657465642729203d2028636f6d706c657465645f61745f6d73204953204e4f54204e554c4c29292c0a20434845434b28287374617465203d20276661696c65642720414e44206661696c7572655f726561736f6e204953202770726f76696465725f6661696c7572652729204f5220287374617465203d2027657870697265642720414e44206661696c7572655f726561736f6e2049532027657870697265642729204f5220287374617465203d202763616e63656c6c65642720414e44206661696c7572655f726561736f6e20495320276465766963655f63616e63656c6c65642729204f5220287374617465204e4f5420494e2028276661696c6564272c2765787069726564272c2763616e63656c6c6564272920414e44206661696c7572655f726561736f6e204953204e554c4c29292c0a20434845434b287374617465203c3e202770656e64696e6727204f52202873746174655f68617368204953204e554c4c20414e442062696e6465725f68617368204953204e554c4c20414e442062726f777365725f6f72646572204953204e554c4c29292c0a20434845434b287374617465203c3e202762726f777365725f70656e64696e6727204f52202873746174655f68617368204953204e4f54204e554c4c20414e442062696e6465725f68617368204953204e4f54204e554c4c20414e44206e6f6e6365204953204e4f54204e554c4c20414e4420706b63655f7665726966696572204953204e4f54204e554c4c20414e442062726f777365725f6f72646572204953204e4f54204e554c4c29292c0a20434845434b28737461746520494e20282770656e64696e67272c2762726f777365725f70656e64696e672729204f5220286e6f6e6365204953204e554c4c20414e4420706b63655f7665726966696572204953204e554c4c29292c0a20434845434b287374617465204e4f5420494e202827636f6e73756d6564272c277665726966696564272c27636f6e6669726d6564272c27636f6d6d697474696e67272c27636f6d706c657465642729204f522028636f6e73756d65645f61745f6d73204953204e4f54204e554c4c20414e4420636f6e73756d65645f61745f6d73203e3d20637265617465645f61745f6d7320414e4420636f6e73756d65645f61745f6d73203c20657870697265735f61745f6d7329292c0a20434845434b287374617465204e4f5420494e2028277665726966696564272c27636f6e6669726d6564272c27636f6d6d697474696e67272c27636f6d706c657465642729204f52202876657269666965645f61745f6d73204953204e4f54204e554c4c20414e442076657269666965645f61745f6d73203e3d20636f6e73756d65645f61745f6d7320414e442076657269666965645f61745f6d73203c20657870697265735f61745f6d7329292c0a20434845434b287374617465204e4f5420494e202827636f6e6669726d6564272c27636f6d6d697474696e67272c27636f6d706c657465642729204f522028636f6d706c6574696f6e5f7365637265745f68617368204953204e4f54204e554c4c20414e4420636f6e6669726d65645f61745f6d73204953204e4f54204e554c4c20414e4420636f6e6669726d65645f61745f6d73203e3d2076657269666965645f61745f6d7320414e4420636f6e6669726d65645f61745f6d73203c20657870697265735f61745f6d7329292c0a20434845434b287374617465203c3e2027636f6d706c6574656427204f522028636f6d706c657465645f61745f6d73203e3d20636f6e6669726d65645f61745f6d7320414e4420636f6d706c657465645f61745f6d73203c20657870697265735f61745f6d7320414e4420646973706c61795f6e616d65204953204e554c4c20414e4420656d61696c204953204e554c4c20414e4420656d61696c5f7665726966696564204953204e554c4c20414e4420706963747572655f75726c204953204e554c4c29292c0a20434845434b28656d61696c5f7665726966696564204953204e554c4c204f522028656d61696c5f766572696669656420494e2028302c312920414e4420656d61696c204953204e4f54204e554c4c29290a29' AS TEXT), '''refresh''', 'literal_0'), '''disconnect''', 'literal_1'), '''pending''', 'literal_2'), '''browser_pending''', 'literal_3'), '''consumed''', 'literal_4'), '''verified''', 'literal_5'), '''confirmed''', 'literal_6'), '''committing''', 'literal_7'), '''completed''', 'literal_8'), '''cancelled''', 'literal_9'), '''failed''', 'literal_10'), '''expired''', 'literal_11'), '''device_cancelled''', 'literal_12'), '''provider_failure''', 'literal_13'), '''integer''', 'literal_14'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) AND (SELECT count(*) FROM sqlite_master WHERE tbl_name = 'coordinator_account_change_attempts' COLLATE NOCASE AND type IN ('index','trigger') AND sql IS NOT NULL) = 4) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_change_collision' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''account_change_collision''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f6368616e67655f636f6c6c6973696f6e204245464f524520494e53455254204f4e20636f6f7264696e61746f725f6163636f756e745f6368616e67655f617474656d7074730a5748454e20455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f6163636f756e745f6368616e67655f617474656d70747320574845524520636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f696420414e440a2028617474656d70745f6964203d204e45572e617474656d70745f6964204f522062726f777365725f73746172745f68617368203d204e45572e62726f777365725f73746172745f68617368204f522072756e74696d655f76657269666965725f68617368203d204e45572e72756e74696d655f76657269666965725f68617368204f522073746174655f68617368203d204e45572e73746174655f68617368204f522062696e6465725f68617368203d204e45572e62696e6465725f68617368204f5220636f6d706c6574696f6e5f7365637265745f68617368203d204e45572e636f6d706c6574696f6e5f7365637265745f6861736829290a424547494e2053454c4543542052414953452841424f52542c276163636f756e745f6368616e67655f636f6c6c6973696f6e27293b20454e44' AS TEXT), '''account_change_collision''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_change_birth' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''account_change_birth_immutable''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f6368616e67655f6269727468204245464f524520555044415445204f4e20636f6f7264696e61746f725f6163636f756e745f6368616e67655f617474656d7074730a5748454e204e45572e636f6f7264696e61746f725f6964204953204e4f54204f4c442e636f6f7264696e61746f725f6964204f52204e45572e617474656d70745f6964204953204e4f54204f4c442e617474656d70745f6964204f52204e45572e696e74656e74204953204e4f54204f4c442e696e74656e74204f52204e45572e7461726765745f6c696e6b5f6964204953204e4f54204f4c442e7461726765745f6c696e6b5f6964204f52204e45572e6964656e746974795f6964204953204e4f54204f4c442e6964656e746974795f6964204f52204e45572e697373756572204953204e4f54204f4c442e697373756572204f52204e45572e7461726765745f7375626a656374204953204e4f54204f4c442e7461726765745f7375626a656374204f52204e45572e67726f75705f6964204953204e4f54204f4c442e67726f75705f6964204f52204e45572e6465766963655f6964204953204e4f54204f4c442e6465766963655f6964204f52204e45572e7075626c69635f6b6579204953204e4f54204f4c442e7075626c69635f6b6579204f52204e45572e66696e6765727072696e74204953204e4f54204f4c442e66696e6765727072696e74204f52204e45572e6b65795f6964204953204e4f54204f4c442e6b65795f6964204f52204e45572e656e726f6c6c6d656e745f6964656e746974795f6964204953204e4f54204f4c442e656e726f6c6c6d656e745f6964656e746974795f6964204f52204e45572e617574685f636f6e6669675f7265766973696f6e204953204e4f54204f4c442e617574685f636f6e6669675f7265766973696f6e204f52204e45572e72756e74696d655f76657269666965725f68617368204953204e4f54204f4c442e72756e74696d655f76657269666965725f68617368204f52204e45572e62726f777365725f73746172745f68617368204953204e4f54204f4c442e62726f777365725f73746172745f68617368204f52204e45572e6c6f6f706261636b5f7265646972656374204953204e4f54204f4c442e6c6f6f706261636b5f7265646972656374204f52204e45572e637265617465645f61745f6d73204953204e4f54204f4c442e637265617465645f61745f6d73204f52204e45572e657870697265735f61745f6d73204953204e4f54204f4c442e657870697265735f61745f6d730a424547494e2053454c4543542052414953452841424f52542c276163636f756e745f6368616e67655f62697274685f696d6d757461626c6527293b20454e44' AS TEXT), '''account_change_birth_immutable''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_change_transition' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''completed''', 'literal_0'), '''cancelled''', 'literal_1'), '''failed''', 'literal_2'), '''expired''', 'literal_3'), '''pending''', 'literal_4'), '''browser_pending''', 'literal_5'), '''consumed''', 'literal_6'), '''refresh''', 'literal_7'), '''confirmed''', 'literal_8'), '''disconnect''', 'literal_9'), '''verified''', 'literal_10'), '''committing''', 'literal_11'), '''account_change_transition_invalid''', 'literal_12'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f6368616e67655f7472616e736974696f6e204245464f524520555044415445204f4e20636f6f7264696e61746f725f6163636f756e745f6368616e67655f617474656d7074730a5748454e204f4c442e737461746520494e202827636f6d706c65746564272c2763616e63656c6c6564272c276661696c6564272c27657870697265642729204f52204e4f5420280a20284f4c442e7374617465203d202770656e64696e672720414e44204e45572e7374617465203d202762726f777365725f70656e64696e672729204f520a20284f4c442e7374617465203d202762726f777365725f70656e64696e672720414e44204e45572e7374617465203d2027636f6e73756d65642729204f520a20284f4c442e7374617465203d2027636f6e73756d65642720414e442028284f4c442e696e74656e74203d2027726566726573682720414e44204e45572e7374617465203d2027636f6e6669726d65642729204f5220284f4c442e696e74656e74203d2027646973636f6e6e6563742720414e44204e45572e7374617465203d2027766572696669656427292929204f520a20284f4c442e7374617465203d202776657269666965642720414e44204e45572e7374617465203d2027636f6e6669726d65642729204f520a20284f4c442e7374617465203d2027636f6e6669726d65642720414e44204e45572e7374617465203d2027636f6d6d697474696e672729204f520a20284f4c442e7374617465203d2027636f6d6d697474696e672720414e44204e45572e7374617465203d2027636f6d706c657465642729204f520a20284f4c442e7374617465204e4f5420494e202827636f6d6d697474696e67272c27636f6d706c65746564272c2763616e63656c6c6564272c276661696c6564272c2765787069726564272920414e44204e45572e737461746520494e20282763616e63656c6c6564272c2765787069726564272929204f520a20284f4c442e7374617465203d2027636f6e73756d65642720414e44204e45572e7374617465203d20276661696c65642729290a424547494e2053454c4543542052414953452841424f52542c276163636f756e745f6368616e67655f7472616e736974696f6e5f696e76616c696427293b20454e44' AS TEXT), '''completed''', 'literal_0'), '''cancelled''', 'literal_1'), '''failed''', 'literal_2'), '''expired''', 'literal_3'), '''pending''', 'literal_4'), '''browser_pending''', 'literal_5'), '''consumed''', 'literal_6'), '''refresh''', 'literal_7'), '''confirmed''', 'literal_8'), '''disconnect''', 'literal_9'), '''verified''', 'literal_10'), '''committing''', 'literal_11'), '''account_change_transition_invalid''', 'literal_12'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_change_receipt_delete' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(sql, '''completed''', 'literal_0'), '''account_change_receipt_immutable''', 'literal_1'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f6368616e67655f726563656970745f64656c657465204245464f52452044454c455445204f4e20636f6f7264696e61746f725f6163636f756e745f6368616e67655f617474656d707473205748454e204f4c442e7374617465203d2027636f6d706c65746564270a424547494e2053454c4543542052414953452841424f52542c276163636f756e745f6368616e67655f726563656970745f696d6d757461626c6527293b20454e44' AS TEXT), '''completed''', 'literal_0'), '''account_change_receipt_immutable''', 'literal_1'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'account_connection_history_identity_revoked' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(sql, 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(CAST(X'43524541544520494e444558206163636f756e745f636f6e6e656374696f6e5f686973746f72795f6964656e746974795f7265766f6b6564204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f727928636f6f7264696e61746f725f69642c6964656e746974795f69642c7265766f6b65645f61745f6d7329' AS TEXT), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'connection_history_floor_insert' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''connection_archive_floor_invalid''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'435245415445205452494747455220636f6e6e656374696f6e5f686973746f72795f666c6f6f725f696e73657274204245464f524520494e53455254204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f72790a205748454e204e45572e7369676e696e5f666c6f6f72204953204e4f54202853454c45435420632e7369676e696e5f666c6f6f722046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f6c696e6b73206320574845524520632e636f6f7264696e61746f725f69643d4e45572e636f6f7264696e61746f725f696420414e4420632e6c696e6b5f69643d4e45572e6c696e6b5f696420414e4420632e726f7769643d4e45572e6f726967696e616c5f726f776964290a20424547494e2053454c4543542052414953452841424f52542c27636f6e6e656374696f6e5f617263686976655f666c6f6f725f696e76616c696427293b20454e44' AS TEXT), '''connection_archive_floor_invalid''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'connection_history_floor_update' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''connection_history_immutable''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'435245415445205452494747455220636f6e6e656374696f6e5f686973746f72795f666c6f6f725f757064617465204245464f524520555044415445204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f7279205748454e204e45572e7369676e696e5f666c6f6f72204953204e4f54204f4c442e7369676e696e5f666c6f6f7220424547494e2053454c4543542052414953452841424f52542c27636f6e6e656374696f6e5f686973746f72795f696d6d757461626c6527293b20454e44' AS TEXT), '''connection_history_immutable''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'connection_link_shared_admission' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''completed''', 'literal_0'), '''finalized''', 'literal_1'), '''session_redeemed''', 'literal_2'), '''failed''', 'literal_3'), '''expired''', 'literal_4'), '''cancelled''', 'literal_5'), '''connection_attempt_limited''', 'literal_6'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'435245415445205452494747455220636f6e6e656374696f6e5f6c696e6b5f7368617265645f61646d697373696f6e204245464f524520494e53455254204f4e20636f6f7264696e61746f725f617574685f6c696e6b5f617474656d707473205748454e204e4f542045584953545320285749544820636f6e6e656374696f6e5f627564676574204153204d4154455249414c495a454420280a2053454c4543542067726f75705f69642c6465766963655f69642c6964656e746974795f69642c73746174652c637265617465645f61745f6d732c657870697265735f61745f6d732046524f4d20636f6f7264696e61746f725f6163636f756e745f6368616e67655f617474656d70747320574845524520636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f69640a20554e494f4e20414c4c2053454c4543542067726f75705f69642c6465766963655f69642c6964656e746974795f69642c73746174652c637265617465645f61745f6d732c657870697265735f61745f6d732046524f4d20636f6f7264696e61746f725f617574685f6c696e6b5f617474656d70747320574845524520636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f6964290a2053454c45435420312057484552450a202853454c45435420636f756e74282a292046524f4d20636f6e6e656374696f6e5f627564676574206220574845524520622e67726f75705f6964203d204e45572e67726f75705f696420414e4420622e6465766963655f6964203d204e45572e6465766963655f696420414e4420622e7374617465204e4f5420494e202827636f6d706c65746564272c2766696e616c697a6564272c2773657373696f6e5f72656465656d6564272c276661696c6564272c2765787069726564272c2763616e63656c6c6564272920414e4420622e657870697265735f61745f6d73203e204e45572e637265617465645f61745f6d7329203c20320a20414e44202853454c45435420636f756e74282a292046524f4d20636f6e6e656374696f6e5f627564676574206220574845524520622e6964656e746974795f6964203d204e45572e6964656e746974795f696420414e4420622e7374617465204e4f5420494e202827636f6d706c65746564272c2766696e616c697a6564272c2773657373696f6e5f72656465656d6564272c276661696c6564272c2765787069726564272c2763616e63656c6c6564272920414e4420622e657870697265735f61745f6d73203e204e45572e637265617465645f61745f6d7329203c20330a20414e44202853454c45435420636f756e74282a292046524f4d20636f6e6e656374696f6e5f627564676574206220574845524520622e67726f75705f6964203d204e45572e67726f75705f696420414e4420622e6465766963655f6964203d204e45572e6465766963655f696420414e4420622e637265617465645f61745f6d73203e204e45572e637265617465645f61745f6d73202d203336303030303029203c20360a20414e44202853454c45435420636f756e74282a292046524f4d20636f6e6e656374696f6e5f627564676574206220574845524520622e67726f75705f6964203d204e45572e67726f75705f696420414e4420622e6465766963655f6964203d204e45572e6465766963655f696420414e4420622e637265617465645f61745f6d73203e204e45572e637265617465645f61745f6d73202d203235393230303030303029203c2036300a20414e44202853454c45435420636f756e74282a292046524f4d20636f6e6e656374696f6e5f627564676574206220574845524520622e7374617465204e4f5420494e202827636f6d706c65746564272c2766696e616c697a6564272c2773657373696f6e5f72656465656d6564272929203c2031303030302920424547494e2053454c4543542052414953452841424f52542c27636f6e6e656374696f6e5f617474656d70745f6c696d6974656427293b20454e44' AS TEXT), '''completed''', 'literal_0'), '''finalized''', 'literal_1'), '''session_redeemed''', 'literal_2'), '''failed''', 'literal_3'), '''expired''', 'literal_4'), '''cancelled''', 'literal_5'), '''connection_attempt_limited''', 'literal_6'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'connection_link_prior_immutable' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(sql, '''pending''', 'literal_0'), '''connection_prior_immutable''', 'literal_1'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(CAST(X'435245415445205452494747455220636f6e6e656374696f6e5f6c696e6b5f7072696f725f696d6d757461626c65204245464f524520555044415445204f4e20636f6f7264696e61746f725f617574685f6c696e6b5f617474656d707473205748454e204e45572e7072696f725f6c696e6b5f6964204953204e4f54204f4c442e7072696f725f6c696e6b5f696420414e4420284f4c442e7374617465203c3e202770656e64696e6727204f52204f4c442e7072696f725f6c696e6b5f6964204953204e4f54204e554c4c2920424547494e2053454c4543542052414953452841424f52542c27636f6e6e656374696f6e5f7072696f725f696d6d757461626c6527293b20454e44' AS TEXT), '''pending''', 'literal_0'), '''connection_prior_immutable''', 'literal_1'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'connection_history_head' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(sql, 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(CAST(X'43524541544520554e4951554520494e44455820636f6e6e656374696f6e5f686973746f72795f68656164204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f727928636f6f7264696e61746f725f69642c6964656e746974795f69642920574845524520737563636573736f725f6c696e6b5f6964204953204e554c4c' AS TEXT), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_link_profiles') WHERE lower(name)='source_change_attempt_id' AND upper(type)='TEXT' AND "notnull"=0 AND dflt_value IS NULL AND pk=0) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_link_profiles') WHERE lower(name)='source_order' AND upper(type)='INTEGER' AND "notnull"=0 AND dflt_value IS NULL AND pk=0) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_account_profiles') WHERE lower(name)='source_order' AND upper(type)='INTEGER' AND "notnull"=0 AND dflt_value IS NULL AND pk=0) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_browser_transactions') WHERE lower(name)='start_order' AND upper(type)='INTEGER' AND "notnull"=0 AND dflt_value IS NULL AND pk=0) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_account_links') WHERE lower(name)='signin_floor' AND upper(type)='INTEGER' AND "notnull"=1 AND dflt_value IS '0' AND pk=0) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_session_receipts') WHERE lower(name)='source_order' AND upper(type)='INTEGER' AND "notnull"=0 AND dflt_value IS NULL AND pk=0) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_account_connection_history') WHERE lower(name)='signin_floor' AND upper(type)='INTEGER' AND "notnull"=0 AND dflt_value IS NULL AND pk=0) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('coordinator_auth_link_attempts') WHERE lower(name)='prior_link_id' AND upper(type)='TEXT' AND "notnull"=0 AND dflt_value IS NULL AND pk=0) THEN 1 ELSE 0 END),(CASE WHEN (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_attempts')) = 30 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_account_links')) = 13 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_audit_log')) = 13 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_browser_transactions')) = 17 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_sessions')) = 12 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_session_receipts')) = 10 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_profiles')) = 14 AND (SELECT count(*) FROM pragma_table_info('coordinator_auth_account_profiles')) = 9 THEN 1 ELSE 0 END),(CASE WHEN (SELECT
 (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_attempts') WHERE lower(name) = 'authority_kind')
 + (SELECT count(*) FROM pragma_table_info('coordinator_auth_account_links') WHERE lower(name) IN ('authority_kind','device_claim_id'))
 + (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_audit_log') WHERE lower(name) IN ('authority_kind','device_claim_id'))
 + (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_auth_link_profiles')
 + (EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_auth_device_claims' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'435245415445205441424c45204946204e4f542045584953545320636f6f7264696e61746f725f617574685f6465766963655f636c61696d7320280a2020636c61696d5f69642054455854205052494d415259204b4559204e4f54204e554c4c20434845434b280a20202020747970656f6628636c61696d5f696429203d2027746578742720414e44206c656e67746828636c61696d5f696429204245545745454e203120414e44203235360a20202020414e4420636c61696d5f6964203d207472696d28636c61696d5f69642920414e4420696e73747228636c61696d5f69642c206368617228302929203d2030292c0a2020636f6f7264696e61746f725f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f6628636f6f7264696e61746f725f696429203d2027746578742720414e44206c656e67746828636f6f7264696e61746f725f696429204245545745454e203120414e44203235360a20202020414e4420636f6f7264696e61746f725f6964203d207472696d28636f6f7264696e61746f725f69642920414e4420696e73747228636f6f7264696e61746f725f69642c206368617228302929203d2030292c0a20206964656e746974795f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f66286964656e746974795f696429203d2027746578742720414e44206c656e677468286964656e746974795f696429204245545745454e203120414e44203235360a20202020414e44206964656e746974795f6964203d207472696d286964656e746974795f69642920414e4420696e737472286964656e746974795f69642c206368617228302929203d2030292c0a202067726f75705f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f662867726f75705f696429203d2027746578742720414e44206c656e6774682867726f75705f696429204245545745454e203120414e44203235360a20202020414e442067726f75705f6964203d207472696d2867726f75705f69642920414e4420696e7374722867726f75705f69642c206368617228302929203d2030292c0a20206465766963655f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f66286465766963655f696429203d2027746578742720414e44206c656e677468286465766963655f696429204245545745454e203120414e44203235360a20202020414e44206465766963655f6964203d207472696d286465766963655f69642920414e4420696e737472286465766963655f69642c206368617228302929203d2030292c0a20207075626c69635f6b65792054455854204e4f54204e554c4c20434845434b280a20202020747970656f66287075626c69635f6b657929203d2027746578742720414e44206c656e677468287075626c69635f6b657929204245545745454e203120414e4420343039360a20202020414e44206c656e677468287472696d287265706c616365287265706c616365287075626c69635f6b65792c2063686172283133292c202727292c2063686172283130292c202727292929203e20300a20202020414e4420696e737472287075626c69635f6b65792c206368617228302929203d2030292c0a202066696e6765727072696e742054455854204e4f54204e554c4c20434845434b280a20202020747970656f662866696e6765727072696e7429203d2027746578742720414e44206c656e6774682866696e6765727072696e7429203d2036340a20202020414e442066696e6765727072696e74204e4f5420474c4f4220272a5b5e612d66302d395d2a2720414e4420696e7374722866696e6765727072696e742c206368617228302929203d2030292c0a20206b65795f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f66286b65795f696429203d2027746578742720414e44206c656e677468286b65795f696429203d2036340a20202020414e44206b65795f6964204e4f5420474c4f4220272a5b5e612d66302d395d2a2720414e4420696e737472286b65795f69642c206368617228302929203d2030292c0a2020617474656d70745f69642054455854204e4f54204e554c4c20434845434b280a20202020747970656f6628617474656d70745f696429203d2027746578742720414e44206c656e67746828617474656d70745f696429204245545745454e203120414e44203235360a20202020414e4420617474656d70745f6964203d207472696d28617474656d70745f69642920414e4420696e73747228617474656d70745f69642c206368617228302929203d2030292c0a20206973737565722054455854204e4f54204e554c4c20434845434b280a20202020747970656f662869737375657229203d2027746578742720414e44206c656e677468287472696d286973737565722929203e20300a20202020414e4420697373756572203d207472696d286973737565722920414e4420696e737472286973737565722c206368617228302929203d2030292c0a2020617574685f636f6e6669675f7265766973696f6e2054455854204e4f54204e554c4c20434845434b280a20202020747970656f6628617574685f636f6e6669675f7265766973696f6e29203d2027746578742720414e44206c656e67746828617574685f636f6e6669675f7265766973696f6e29203d2036340a20202020414e4420617574685f636f6e6669675f7265766973696f6e204e4f5420474c4f4220272a5b5e612d66302d395d2a2720414e4420696e73747228617574685f636f6e6669675f7265766973696f6e2c206368617228302929203d2030292c0a2020637265617465645f61745f6d7320494e5445474552204e4f54204e554c4c20434845434b280a20202020747970656f6628637265617465645f61745f6d7329203d2027696e74656765722720414e4420637265617465645f61745f6d73204245545745454e203020414e442039303037313939323534373430393931292c0a2020554e495155452028636f6f7264696e61746f725f69642c206964656e746974795f6964292c0a2020554e495155452028636f6f7264696e61746f725f69642c206465766963655f6964292c0a2020554e495155452028636f6f7264696e61746f725f69642c206b65795f6964292c0a2020554e495155452028636f6f7264696e61746f725f69642c20617474656d70745f6964290a2920574954484f555420524f574944' AS TEXT), '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) AND (SELECT count(*) FROM sqlite_master WHERE tbl_name = 'coordinator_auth_device_claims' COLLATE NOCASE AND type IN ('index','trigger') AND sql IS NOT NULL) = 4)) + (EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'coordinator_auth_device_claims_insert_collision' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552204946204e4f542045584953545320636f6f7264696e61746f725f617574685f6465766963655f636c61696d735f696e736572745f636f6c6c6973696f6e0a4245464f524520494e53455254204f4e20636f6f7264696e61746f725f617574685f6465766963655f636c61696d730a5748454e2045584953545320280a202053454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6465766963655f636c61696d730a2020574845524520636c61696d5f6964203d204e45572e636c61696d5f6964204f522028636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f696420414e4420280a202020206964656e746974795f6964203d204e45572e6964656e746974795f6964204f52206465766963655f6964203d204e45572e6465766963655f69640a202020204f52206b65795f6964203d204e45572e6b65795f6964204f5220617474656d70745f6964203d204e45572e617474656d70745f69640a202029290a290a424547494e0a202053454c4543542052414953452841424f52542c2027617574685f6465766963655f636c61696d5f636f6c6c6973696f6e27293b0a454e44' AS TEXT), '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)))) + (EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'coordinator_auth_device_claims_immutable_update' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552204946204e4f542045584953545320636f6f7264696e61746f725f617574685f6465766963655f636c61696d735f696d6d757461626c655f7570646174650a4245464f524520555044415445204f4e20636f6f7264696e61746f725f617574685f6465766963655f636c61696d730a424547494e0a202053454c4543542052414953452841424f52542c2027617574685f6465766963655f636c61696d5f696d6d757461626c6527293b0a454e44' AS TEXT), '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)))) + (EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'coordinator_auth_device_claims_immutable_delete' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552204946204e4f542045584953545320636f6f7264696e61746f725f617574685f6465766963655f636c61696d735f696d6d757461626c655f64656c6574650a4245464f52452044454c455445204f4e20636f6f7264696e61746f725f617574685f6465766963655f636c61696d730a424547494e0a202053454c4543542052414953452841424f52542c2027617574685f6465766963655f636c61696d5f696d6d757461626c6527293b0a454e44' AS TEXT), '''text''', 'literal_0'), '''''', 'literal_1'), '''*[^a-f0-9]*''', 'literal_2'), '''integer''', 'literal_3'), '''auth_device_claim_collision''', 'literal_4'), '''auth_device_claim_immutable''', 'literal_5'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)))) AS ready)=10 THEN 1 ELSE 0 END),(CASE WHEN NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links WHERE typeof(signin_floor)<>'integer' OR signin_floor<0 OR signin_floor>9007199254740991)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions WHERE start_order IS NOT NULL AND (typeof(start_order)<>'integer' OR start_order<1 OR start_order>9007199254740991))
 AND NOT EXISTS (SELECT 1 FROM (SELECT coordinator_id FROM coordinator_auth_account_links UNION SELECT coordinator_id FROM coordinator_auth_browser_transactions UNION SELECT coordinator_id FROM coordinator_auth_sessions) c LEFT JOIN coordinator_auth_account_connection_orders o ON o.coordinator_id=c.coordinator_id WHERE o.last_order IS NULL OR o.last_order<1) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_auth_account_connection_unlinks' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''*[^0-9a-f]*''', 'literal_0'), '''committing''', 'literal_1'), '''completed''', 'literal_2'), '''integer''', 'literal_3'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'435245415445205441424c4520636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f756e6c696e6b7320280a20636f6f7264696e61746f725f69642054455854204e4f54204e554c4c2c20617474656d70745f69642054455854204e4f54204e554c4c2c207461726765745f6c696e6b5f69642054455854204e4f54204e554c4c2c0a206964656e746974795f69642054455854204e4f54204e554c4c2c206973737565722054455854204e4f54204e554c4c2c207461726765745f7375626a6563742054455854204e4f54204e554c4c2c0a2067726f75705f69642054455854204e4f54204e554c4c2c206465766963655f69642054455854204e4f54204e554c4c2c207075626c69635f6b65792054455854204e4f54204e554c4c2c2066696e6765727072696e742054455854204e4f54204e554c4c2c0a20656e726f6c6c6d656e745f6964656e746974795f696420544558542c20617574685f636f6e6669675f7265766973696f6e2054455854204e4f54204e554c4c2c0a20726571756573745f686173682054455854204e4f54204e554c4c20434845434b286c656e67746828726571756573745f68617368293d363420414e4420726571756573745f68617368204e4f5420474c4f4220272a5b5e302d39612d665d2a27292c0a2073746174652054455854204e4f54204e554c4c20434845434b28737461746520494e202827636f6d6d697474696e67272c27636f6d706c657465642729292c0a20637265617465645f61745f6d7320494e5445474552204e4f54204e554c4c20434845434b28747970656f6628637265617465645f61745f6d73293d27696e74656765722720414e4420637265617465645f61745f6d73204245545745454e203020414e442039303037313939323534373430393931292c0a20636f6d706c657465645f61745f6d7320494e54454745522c0a205052494d415259204b455928636f6f7264696e61746f725f69642c617474656d70745f6964292c20554e4951554528636f6f7264696e61746f725f69642c7461726765745f6c696e6b5f6964292c0a20434845434b282873746174653d27636f6d706c6574656427293d28636f6d706c657465645f61745f6d73204953204e4f54204e554c4c29292c0a20434845434b28636f6d706c657465645f61745f6d73204953204e554c4c204f522028747970656f6628636f6d706c657465645f61745f6d73293d27696e74656765722720414e4420636f6d706c657465645f61745f6d733e3d637265617465645f61745f6d7320414e4420636f6d706c657465645f61745f6d733c3d3930303731393932353437343039393129290a2029' AS TEXT), '''*[^0-9a-f]*''', 'literal_0'), '''committing''', 'literal_1'), '''completed''', 'literal_2'), '''integer''', 'literal_3'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) AND (SELECT count(*) FROM sqlite_master WHERE tbl_name = 'coordinator_auth_account_connection_unlinks' COLLATE NOCASE AND type IN ('index','trigger') AND sql IS NOT NULL) = 4) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_unlink_insert' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(sql, '''committing''', 'literal_0'), '''account_unlink_collision''', 'literal_1'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f756e6c696e6b5f696e73657274204245464f524520494e53455254204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f756e6c696e6b730a205748454e204e45572e73746174653c3e27636f6d6d697474696e6727204f5220455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f756e6c696e6b7320574845524520726f7769643d4e45572e726f776964204f522028636f6f7264696e61746f725f69643d4e45572e636f6f7264696e61746f725f696420414e442028617474656d70745f69643d4e45572e617474656d70745f6964204f52207461726765745f6c696e6b5f69643d4e45572e7461726765745f6c696e6b5f69642929290a20424547494e2053454c4543542052414953452841424f52542c276163636f756e745f756e6c696e6b5f636f6c6c6973696f6e27293b20454e44' AS TEXT), '''committing''', 'literal_0'), '''account_unlink_collision''', 'literal_1'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_unlink_rowid' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''account_unlink_rowid''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f756e6c696e6b5f726f77696420414654455220494e53455254204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f756e6c696e6b73205748454e204e45572e726f7769643c310a20424547494e2053454c4543542052414953452841424f52542c276163636f756e745f756e6c696e6b5f726f77696427293b20454e44' AS TEXT), '''account_unlink_rowid''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_unlink_update' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''committing''', 'literal_0'), '''completed''', 'literal_1'), '''account_unlink_immutable''', 'literal_2'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f756e6c696e6b5f757064617465204245464f524520555044415445204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f756e6c696e6b730a205748454e204e45572e636f6f7264696e61746f725f6964204953204e4f54204f4c442e636f6f7264696e61746f725f6964204f52204e45572e617474656d70745f6964204953204e4f54204f4c442e617474656d70745f6964204f52204e45572e7461726765745f6c696e6b5f6964204953204e4f54204f4c442e7461726765745f6c696e6b5f6964204f52204e45572e6964656e746974795f6964204953204e4f54204f4c442e6964656e746974795f6964204f52204e45572e697373756572204953204e4f54204f4c442e697373756572204f52204e45572e7461726765745f7375626a656374204953204e4f54204f4c442e7461726765745f7375626a656374204f52204e45572e67726f75705f6964204953204e4f54204f4c442e67726f75705f6964204f52204e45572e6465766963655f6964204953204e4f54204f4c442e6465766963655f6964204f52204e45572e7075626c69635f6b6579204953204e4f54204f4c442e7075626c69635f6b6579204f52204e45572e66696e6765727072696e74204953204e4f54204f4c442e66696e6765727072696e74204f52204e45572e656e726f6c6c6d656e745f6964656e746974795f6964204953204e4f54204f4c442e656e726f6c6c6d656e745f6964656e746974795f6964204f52204e45572e617574685f636f6e6669675f7265766973696f6e204953204e4f54204f4c442e617574685f636f6e6669675f7265766973696f6e204f52204e45572e726571756573745f68617368204953204e4f54204f4c442e726571756573745f68617368204f52204e45572e637265617465645f61745f6d73204953204e4f54204f4c442e637265617465645f61745f6d73204f52204e45572e726f776964204953204e4f54204f4c442e726f776964204f52204f4c442e73746174653c3e27636f6d6d697474696e6727204f52204e45572e73746174653c3e27636f6d706c65746564270a20424547494e2053454c4543542052414953452841424f52542c276163636f756e745f756e6c696e6b5f696d6d757461626c6527293b20454e44' AS TEXT), '''committing''', 'literal_0'), '''completed''', 'literal_1'), '''account_unlink_immutable''', 'literal_2'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_connection_unlink_delete' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(sql, '''account_unlink_immutable''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f636f6e6e656374696f6e5f756e6c696e6b5f64656c657465204245464f52452044454c455445204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f756e6c696e6b730a20424547494e2053454c4543542052414953452841424f52542c276163636f756e745f756e6c696e6b5f696d6d757461626c6527293b20454e44' AS TEXT), '''account_unlink_immutable''', 'literal_0'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'account_change_archive_receipt' COLLATE NOCASE AND rtrim(replace(replace(replace(replace(replace(replace(replace(replace(sql, '''committing''', 'literal_0'), '''disconnect''', 'literal_1'), '''account_change_archive_receipt_invalid''', 'literal_2'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59)) = rtrim(replace(replace(replace(replace(replace(replace(replace(replace(CAST(X'4352454154452054524947474552206163636f756e745f6368616e67655f617263686976655f72656365697074204245464f524520494e53455254204f4e20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f686973746f72790a5748454e204e4f5420455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f6163636f756e745f6368616e67655f617474656d707473206120574845524520612e636f6f7264696e61746f725f6964203d204e45572e636f6f7264696e61746f725f69640a20414e4420612e617474656d70745f6964203d204e45572e656e645f617474656d70745f696420414e4420612e7374617465203d2027636f6d6d697474696e672720414e4420612e696e74656e74203d2027646973636f6e6e656374270a20414e4420612e7461726765745f6c696e6b5f6964203d204e45572e6c696e6b5f696420414e4420612e6964656e746974795f6964203d204e45572e6964656e746974795f696420414e4420612e697373756572203d204e45572e69737375657220414e4420612e7461726765745f7375626a656374203d204e45572e7375626a656374290a20414e44204e4f5420455849535453202853454c45435420312046524f4d20636f6f7264696e61746f725f617574685f6163636f756e745f636f6e6e656374696f6e5f756e6c696e6b73206120574845524520612e636f6f7264696e61746f725f69643d4e45572e636f6f7264696e61746f725f69640a20414e4420612e617474656d70745f69643d4e45572e656e645f617474656d70745f696420414e4420612e73746174653d27636f6d6d697474696e672720414e4420612e7461726765745f6c696e6b5f69643d4e45572e6c696e6b5f69640a20414e4420612e6964656e746974795f69643d4e45572e6964656e746974795f696420414e4420612e6973737565723d4e45572e69737375657220414e4420612e7461726765745f7375626a6563743d4e45572e7375626a656374290a424547494e2053454c4543542052414953452841424f52542c276163636f756e745f6368616e67655f617263686976655f726563656970745f696e76616c696427293b20454e44' AS TEXT), '''committing''', 'literal_0'), '''disconnect''', 'literal_1'), '''account_change_archive_receipt_invalid''', 'literal_2'), 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))) THEN 1 ELSE 0 END),(CASE WHEN NOT EXISTS (SELECT 1 FROM sqlite_master WHERE (name GLOB 'account_connection_*' OR name GLOB 'account_change_*' OR name GLOB 'connection_*' OR name GLOB 'coordinator_auth_account_connection_*' OR name = 'coordinator_account_change_attempts' OR name = 'coordinator_auth_account_associations' OR name = 'coordinator_auth_link_change_attempts') AND name NOT IN ('coordinator_auth_account_connection_history','account_connection_history_insert','account_connection_history_rowid','account_connection_history_update','account_connection_history_delete','account_connection_current_insert','account_connection_claim_history','coordinator_auth_account_connection_orders','account_connection_order_insert','account_connection_order_update','account_connection_order_delete','coordinator_account_change_attempts','account_change_collision','account_change_birth','account_change_transition','account_change_receipt_delete','account_change_archive_receipt','account_connection_history_identity_revoked','connection_history_floor_insert','connection_history_floor_update','connection_link_shared_admission','connection_link_prior_immutable','connection_history_head','coordinator_auth_account_connection_unlinks','account_connection_unlink_insert','account_connection_unlink_rowid','account_connection_unlink_update','account_connection_unlink_delete','account_change_archive_receipt')) THEN 1 ELSE 0 END)));
