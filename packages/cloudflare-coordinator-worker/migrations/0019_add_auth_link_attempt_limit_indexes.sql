CREATE INDEX IF NOT EXISTS idx_auth_link_attempts_device_created
 ON coordinator_auth_link_attempts(coordinator_id, group_id, device_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_auth_link_attempts_identity_expiry
 ON coordinator_auth_link_attempts(coordinator_id, identity_id, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_auth_link_attempts_state_expiry
 ON coordinator_auth_link_attempts(coordinator_id, state, expires_at_ms);
