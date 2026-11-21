CREATE TABLE IF NOT EXISTS coordinator_device_rejoin_attempts (
 coordinator_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 origin TEXT NOT NULL,
 device_id TEXT NOT NULL,
 public_key TEXT NOT NULL,
 key_id TEXT NOT NULL CHECK (length(key_id) = 64 AND key_id NOT GLOB '*[^0-9a-f]*'),
 fingerprint TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 binding_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL,
 removal_digest TEXT NOT NULL,
 own_tombstones_json TEXT NOT NULL CHECK (json_type(own_tombstones_json) = 'array'),
 alias_removal_seqs_json TEXT NOT NULL CHECK (json_type(alias_removal_seqs_json) = 'array'),
 browser_start_hash TEXT NOT NULL CHECK (length(browser_start_hash) = 64 AND browser_start_hash NOT GLOB '*[^0-9a-f]*'),
 browser_transaction_hash TEXT,
 browser_binder_hash TEXT CHECK (browser_binder_hash IS NULL OR
  (length(browser_binder_hash) = 64 AND browser_binder_hash NOT GLOB '*[^0-9a-f]*')),
 loopback_redirect TEXT NOT NULL,
 link_id TEXT,
 link_authority_kind TEXT CHECK (link_authority_kind IN
  ('controller_attestation', 'qualified_device_claim', 'device_claim')),
 link_generation INTEGER,
 destinations_json TEXT CHECK (destinations_json IS NULL OR json_type(destinations_json) = 'array'),
 non_destinations_json TEXT CHECK (non_destinations_json IS NULL OR json_type(non_destinations_json) = 'array'),
 confirmation_hash TEXT,
 completion_secret_hash TEXT CHECK (completion_secret_hash IS NULL OR
  (length(completion_secret_hash) = 64 AND completion_secret_hash NOT GLOB '*[^0-9a-f]*')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
  ('pending', 'browser_claimed', 'oidc_verified', 'confirmed', 'finalized', 'expired', 'failed')),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0),
 expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 600000),
 finalized_at_ms INTEGER,
 final_receipt_json TEXT CHECK (final_receipt_json IS NULL OR json_type(final_receipt_json) = 'object'),
 PRIMARY KEY (coordinator_id, attempt_id),
 CHECK (state NOT IN ('confirmed', 'finalized') OR (link_id IS NOT NULL
  AND link_authority_kind IS NOT NULL AND link_generation IS NOT NULL
  AND destinations_json IS NOT NULL AND non_destinations_json IS NOT NULL
  AND confirmation_hash IS NOT NULL AND completion_secret_hash IS NOT NULL)),
 CHECK ((state = 'finalized') = (finalized_at_ms IS NOT NULL)),
 CHECK ((state = 'finalized') = (final_receipt_json IS NOT NULL)),
 CHECK (finalized_at_ms IS NULL OR (typeof(finalized_at_ms) = 'integer'
  AND finalized_at_ms >= created_at_ms AND finalized_at_ms < expires_at_ms))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_coordinator_device_rejoin_attempts_device
 ON coordinator_device_rejoin_attempts (coordinator_id, device_id, created_at_ms);

-- An attempt ID replay cannot replace a receipt, even with recursive triggers off.
CREATE TRIGGER IF NOT EXISTS coordinator_device_rejoin_attempt_collision
BEFORE INSERT ON coordinator_device_rejoin_attempts
WHEN EXISTS (SELECT 1 FROM coordinator_device_rejoin_attempts
 WHERE coordinator_id = NEW.coordinator_id AND attempt_id = NEW.attempt_id)
BEGIN
 SELECT RAISE(ABORT, 'device_rejoin_attempt_collision');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_rejoin_attempt_pins
BEFORE UPDATE ON coordinator_device_rejoin_attempts
WHEN OLD.state IN ('finalized', 'expired', 'failed')
 OR NEW.coordinator_id IS NOT OLD.coordinator_id OR NEW.attempt_id IS NOT OLD.attempt_id
 OR NEW.origin IS NOT OLD.origin OR NEW.device_id IS NOT OLD.device_id
 OR NEW.public_key IS NOT OLD.public_key OR NEW.key_id IS NOT OLD.key_id
 OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.identity_id IS NOT OLD.identity_id
 OR NEW.binding_id IS NOT OLD.binding_id OR NEW.issuer IS NOT OLD.issuer
 OR NEW.auth_config_revision IS NOT OLD.auth_config_revision
 OR NEW.removal_digest IS NOT OLD.removal_digest
 OR NEW.own_tombstones_json IS NOT OLD.own_tombstones_json
 OR NEW.alias_removal_seqs_json IS NOT OLD.alias_removal_seqs_json
 OR NEW.browser_start_hash IS NOT OLD.browser_start_hash
 OR NEW.loopback_redirect IS NOT OLD.loopback_redirect
 OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR (OLD.browser_transaction_hash IS NOT NULL AND NEW.browser_transaction_hash IS NOT OLD.browser_transaction_hash)
 OR (OLD.browser_binder_hash IS NOT NULL AND NEW.browser_binder_hash IS NOT OLD.browser_binder_hash)
 OR (OLD.link_id IS NOT NULL AND NEW.link_id IS NOT OLD.link_id)
 OR (OLD.link_authority_kind IS NOT NULL AND NEW.link_authority_kind IS NOT OLD.link_authority_kind)
 OR (OLD.link_generation IS NOT NULL AND NEW.link_generation IS NOT OLD.link_generation)
 OR (OLD.destinations_json IS NOT NULL AND NEW.destinations_json IS NOT OLD.destinations_json)
 OR (OLD.non_destinations_json IS NOT NULL AND NEW.non_destinations_json IS NOT OLD.non_destinations_json)
 OR (OLD.confirmation_hash IS NOT NULL AND NEW.confirmation_hash IS NOT OLD.confirmation_hash)
 OR (OLD.completion_secret_hash IS NOT NULL AND NEW.completion_secret_hash IS NOT OLD.completion_secret_hash)
 OR NOT (NEW.state = OLD.state OR NEW.state IN ('expired', 'failed')
  OR (OLD.state = 'pending' AND NEW.state = 'browser_claimed')
  OR (OLD.state = 'browser_claimed' AND NEW.state = 'oidc_verified')
  OR (OLD.state = 'oidc_verified' AND NEW.state = 'confirmed')
  OR (OLD.state = 'confirmed' AND NEW.state = 'finalized'))
BEGIN
 SELECT RAISE(ABORT, 'device_rejoin_attempt_immutable');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_rejoin_attempt_retained
BEFORE DELETE ON coordinator_device_rejoin_attempts
WHEN OLD.state = 'finalized'
BEGIN
 SELECT RAISE(ABORT, 'device_rejoin_attempt_immutable');
END;

CREATE TABLE IF NOT EXISTS coordinator_device_rejoin_audit_log (
 coordinator_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 binding_id TEXT NOT NULL,
 group_count INTEGER NOT NULL CHECK (typeof(group_count) = 'integer' AND group_count > 0),
 finalized_at_ms INTEGER NOT NULL CHECK (typeof(finalized_at_ms) = 'integer' AND finalized_at_ms >= 0),
 PRIMARY KEY (coordinator_id, event_id),
 UNIQUE (coordinator_id, attempt_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_coordinator_device_rejoin_audit_identity
 ON coordinator_device_rejoin_audit_log (coordinator_id, identity_id, finalized_at_ms, event_id);

CREATE TRIGGER IF NOT EXISTS coordinator_device_rejoin_audit_collision
BEFORE INSERT ON coordinator_device_rejoin_audit_log
WHEN EXISTS (SELECT 1 FROM coordinator_device_rejoin_audit_log
 WHERE coordinator_id = NEW.coordinator_id AND (event_id = NEW.event_id OR attempt_id = NEW.attempt_id))
BEGIN
 SELECT RAISE(ABORT, 'device_rejoin_audit_collision');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_rejoin_audit_no_update
BEFORE UPDATE ON coordinator_device_rejoin_audit_log
BEGIN
 SELECT RAISE(ABORT, 'device_rejoin_audit_immutable');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_rejoin_audit_no_delete
BEFORE DELETE ON coordinator_device_rejoin_audit_log
BEGIN
 SELECT RAISE(ABORT, 'device_rejoin_audit_immutable');
END;
