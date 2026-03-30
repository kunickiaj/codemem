CREATE TABLE IF NOT EXISTS coordinator_reciprocal_approvals (
  request_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  requesting_device_id TEXT NOT NULL,
  requested_device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
