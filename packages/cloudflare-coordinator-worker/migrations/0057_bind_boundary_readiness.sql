ALTER TABLE groups ADD COLUMN readiness_coordinator_id TEXT;
CREATE TABLE IF NOT EXISTS coordinator_readiness_bindings (
  group_id TEXT NOT NULL, device_id TEXT NOT NULL, record_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL, generation TEXT NOT NULL, key_id TEXT NOT NULL, public_key TEXT NOT NULL,
  sequence INTEGER NOT NULL, refresh_revision INTEGER NOT NULL, filter_evidence TEXT NOT NULL,
  PRIMARY KEY (group_id, device_id)
);
