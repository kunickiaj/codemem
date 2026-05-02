CREATE TABLE IF NOT EXISTS coordinator_scope_membership_audit_log (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
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
