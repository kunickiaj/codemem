CREATE TABLE IF NOT EXISTS coordinator_scopes (
  scope_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'user',
  authority_type TEXT NOT NULL DEFAULT 'coordinator',
  coordinator_id TEXT,
  group_id TEXT,
  manifest_issuer_device_id TEXT,
  membership_epoch INTEGER NOT NULL DEFAULT 0,
  manifest_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coordinator_scopes_status
ON coordinator_scopes(status);

CREATE INDEX IF NOT EXISTS idx_coordinator_scopes_authority_group
ON coordinator_scopes(coordinator_id, group_id);

CREATE TABLE IF NOT EXISTS coordinator_scope_memberships (
  scope_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  membership_epoch INTEGER NOT NULL DEFAULT 0,
  coordinator_id TEXT,
  group_id TEXT,
  manifest_issuer_device_id TEXT,
  manifest_hash TEXT,
  signed_manifest_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_scope_memberships_device_status
ON coordinator_scope_memberships(device_id, status);

CREATE INDEX IF NOT EXISTS idx_coordinator_scope_memberships_scope_status
ON coordinator_scope_memberships(scope_id, status);

CREATE INDEX IF NOT EXISTS idx_coordinator_scope_memberships_authority_group
ON coordinator_scope_memberships(coordinator_id, group_id);
