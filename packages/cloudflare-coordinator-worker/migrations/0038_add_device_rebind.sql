-- ADR 0005 Section 8 device rebinding: additive tables only; no existing table changes.
-- Mirror of packages/core/src/coordinator-device-rebind-schema.ts.
-- Amended before any deployment or release (review digest now required at start).
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
