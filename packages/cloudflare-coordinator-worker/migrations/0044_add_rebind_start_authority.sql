-- Existing attempts retain NULL and their original admission rules.
ALTER TABLE coordinator_device_rebind_attempts ADD COLUMN start_authority_json TEXT CHECK (start_authority_json IS NULL OR json_valid(start_authority_json));
DROP TRIGGER coordinator_device_rebind_attempt_pins;
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
