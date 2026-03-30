CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrolled_devices (
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, device_id)
);

CREATE TABLE IF NOT EXISTS presence_records (
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  addresses_json TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (group_id, device_id)
);

CREATE TABLE IF NOT EXISTS request_nonces (
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, nonce)
);

CREATE TABLE IF NOT EXISTS coordinator_invites (
  invite_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  policy TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  team_name_snapshot TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS coordinator_join_requests (
  request_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  display_name TEXT,
  token TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
);

CREATE TABLE IF NOT EXISTS coordinator_reciprocal_approvals (
  request_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  requesting_device_id TEXT NOT NULL,
  requested_device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
