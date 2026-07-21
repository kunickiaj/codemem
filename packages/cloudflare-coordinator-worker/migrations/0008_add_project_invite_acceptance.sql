ALTER TABLE coordinator_invites ADD COLUMN token_digest TEXT;
ALTER TABLE coordinator_invites ADD COLUMN inviter_actor_id TEXT;
ALTER TABLE coordinator_invites ADD COLUMN inviter_display_name TEXT;
ALTER TABLE coordinator_invites ADD COLUMN inviter_device_id TEXT;
ALTER TABLE coordinator_invites ADD COLUMN pending_person_id TEXT;
ALTER TABLE coordinator_invites ADD COLUMN project_summaries_json TEXT;
ALTER TABLE coordinator_invites ADD COLUMN project_intent_json TEXT;
ALTER TABLE coordinator_invites ADD COLUMN consumed_at TEXT;
ALTER TABLE coordinator_invites ADD COLUMN bound_device_id TEXT;
ALTER TABLE coordinator_invites ADD COLUMN bound_public_key TEXT;
ALTER TABLE coordinator_invites ADD COLUMN bound_fingerprint TEXT;
ALTER TABLE coordinator_invites ADD COLUMN recipient_actor_id TEXT;
ALTER TABLE coordinator_invites ADD COLUMN recipient_display_name TEXT;
ALTER TABLE coordinator_invites ADD COLUMN recipient_device_display_name TEXT;
ALTER TABLE coordinator_invites ADD COLUMN trust_state TEXT;
ALTER TABLE coordinator_invites ADD COLUMN bootstrap_grant_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_invites_token_digest
ON coordinator_invites(token_digest) WHERE token_digest IS NOT NULL;

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
