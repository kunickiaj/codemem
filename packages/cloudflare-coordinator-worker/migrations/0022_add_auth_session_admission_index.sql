CREATE INDEX IF NOT EXISTS idx_auth_sessions_link_config_expiry
  ON coordinator_auth_sessions(coordinator_id, link_id, auth_config_revision, expires_at_ms);
