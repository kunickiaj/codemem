-- Retain one audit event per finalized attempt; no cascading deletion.
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
