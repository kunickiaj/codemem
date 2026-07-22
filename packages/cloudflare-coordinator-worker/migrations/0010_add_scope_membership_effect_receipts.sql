ALTER TABLE coordinator_scope_membership_audit_log ADD COLUMN effect_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_scope_membership_audit_effect
ON coordinator_scope_membership_audit_log(effect_id) WHERE effect_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS coordinator_scope_membership_effect_receipts (
  effect_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
  request_json TEXT NOT NULL,
  outcome_applied INTEGER NOT NULL CHECK (outcome_applied IN (0, 1)),
  scope_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT,
  status TEXT,
  membership_epoch INTEGER,
  coordinator_id TEXT,
  group_id TEXT,
  manifest_issuer_device_id TEXT,
  manifest_hash TEXT,
  signed_manifest_json TEXT,
  updated_at TEXT,
  created_at TEXT NOT NULL
);
