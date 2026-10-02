CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  display_name TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrolled_devices (
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  identity_id TEXT,
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

-- Keeps the per-request expiry sweep off a full table scan; see migration
-- 0014_add_request_nonces_created_at_index.sql.
CREATE INDEX IF NOT EXISTS idx_request_nonces_created_at
ON request_nonces(created_at);

CREATE TABLE IF NOT EXISTS coordinator_invites (
  invite_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  policy TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  team_name_snapshot TEXT,
  revoked_at TEXT,
  operation_id TEXT,
  reviewed_project_set_digest TEXT,
  token_digest TEXT,
  inviter_actor_id TEXT,
  inviter_display_name TEXT,
  inviter_device_id TEXT,
  pending_person_id TEXT,
  project_summaries_json TEXT,
  project_intent_json TEXT,
  consumed_at TEXT,
  bound_device_id TEXT,
  bound_public_key TEXT,
  bound_fingerprint TEXT,
  recipient_actor_id TEXT,
  recipient_display_name TEXT,
  recipient_device_display_name TEXT,
  trust_state TEXT,
  bootstrap_grant_id TEXT,
  invite_kind TEXT,
  policy_team_id TEXT,
  target_identity_id TEXT,
  assigned_identity_id TEXT,
  reviewed_preview_digest TEXT,
  reviewed_intent_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_invites_operation_id
ON coordinator_invites(operation_id) WHERE operation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_invites_token_digest
ON coordinator_invites(token_digest) WHERE token_digest IS NOT NULL;

-- Serves listInvites' group filter and created_at ordering from one seek; see
-- migration 0015_add_coordinator_invites_group_created_index.sql.
CREATE INDEX IF NOT EXISTS idx_coordinator_invites_group_created
ON coordinator_invites(group_id, created_at DESC);

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
  pending_pair_low_device_id TEXT,
  pending_pair_high_device_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

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

CREATE TABLE IF NOT EXISTS coordinator_scope_membership_audit_log (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_id TEXT,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_reciprocal_pending_pair
ON coordinator_reciprocal_approvals(group_id, pending_pair_low_device_id, pending_pair_high_device_id)
WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS coordinator_legacy_team_completions (
  group_id TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,
  manifest_version INTEGER NOT NULL CHECK (manifest_version = 1),
  manifest_json TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, candidate_ref)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_legacy_team_completions_group
ON coordinator_legacy_team_completions(group_id, completed_at, candidate_ref);

-- Empty by design: enrollment labels do not constitute admin-reviewed authority.
-- No foreign keys: retain revoked proofs even after enrollment removal.
CREATE TABLE IF NOT EXISTS coordinator_auth_controller_attestations (
	attestation_id TEXT NOT NULL,
	coordinator_id TEXT NOT NULL,
	identity_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	public_key TEXT NOT NULL,
	fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
	review_receipt_id TEXT NOT NULL,
	evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
	enrollment_identity_id TEXT,
	revision INTEGER NOT NULL DEFAULT 1 CHECK (revision = 1),
	created_at TEXT NOT NULL,
	revoked_at TEXT,
	PRIMARY KEY (coordinator_id, attestation_id),
	UNIQUE (coordinator_id, group_id, device_id, fingerprint),
	UNIQUE (coordinator_id, review_receipt_id)
);

CREATE TABLE IF NOT EXISTS coordinator_auth_link_attempts (
 coordinator_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 public_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
 controller_attestation_id TEXT NOT NULL,
 controller_review_receipt_id TEXT NOT NULL,
 controller_revision INTEGER NOT NULL CHECK (controller_revision = 1),
 issuer TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 runtime_verifier_hash TEXT NOT NULL CHECK (length(runtime_verifier_hash) = 64 AND runtime_verifier_hash NOT GLOB '*[^0-9a-f]*'),
 loopback_redirect TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending','browser_claimed','oidc_verified','confirmed','finalized','session_redeemed','expired','failed')),
 browser_transaction_hash TEXT CHECK (browser_transaction_hash IS NULL OR (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*')),
 account_subject TEXT CHECK (account_subject IS NULL OR length(account_subject) BETWEEN 1 AND 255),
 completion_secret_hash TEXT CHECK (completion_secret_hash IS NULL OR (length(completion_secret_hash) = 64 AND completion_secret_hash NOT GLOB '*[^0-9a-f]*')),
 link_id TEXT,
 failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN ('device_cancelled','browser_cancelled','provider_failure','config_failure')),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0 AND created_at_ms <= 9007199254140991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms = created_at_ms + 600000),
 claimed_at_ms INTEGER,
 oidc_verified_at_ms INTEGER,
 confirmed_at_ms INTEGER,
 finalized_at_ms INTEGER,
 failed_at_ms INTEGER,
 PRIMARY KEY (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, runtime_verifier_hash),
 UNIQUE (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, completion_secret_hash),
 UNIQUE (coordinator_id, link_id),
 CHECK (state <> 'pending' OR (browser_transaction_hash IS NULL AND account_subject IS NULL AND completion_secret_hash IS NULL AND link_id IS NULL)),
 CHECK (state NOT IN ('browser_claimed','oidc_verified','confirmed','finalized','session_redeemed') OR browser_transaction_hash IS NOT NULL),
 CHECK (state NOT IN ('oidc_verified','confirmed','finalized','session_redeemed') OR account_subject IS NOT NULL),
 CHECK (state NOT IN ('confirmed','finalized','session_redeemed') OR completion_secret_hash IS NOT NULL),
 CHECK ((state IN ('finalized','session_redeemed') AND link_id IS NOT NULL AND finalized_at_ms IS NOT NULL) OR (state NOT IN ('finalized','session_redeemed') AND link_id IS NULL AND finalized_at_ms IS NULL)),
 CHECK ((state = 'failed' AND failure_reason IS NOT NULL AND failed_at_ms IS NOT NULL) OR (state <> 'failed' AND failure_reason IS NULL AND failed_at_ms IS NULL))
);
CREATE TABLE IF NOT EXISTS coordinator_auth_account_links (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
 identity_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 controller_attestation_id TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL,
 revoked_at_ms INTEGER,
 PRIMARY KEY (coordinator_id, link_id),
 UNIQUE (coordinator_id, issuer, subject),
 UNIQUE (coordinator_id, identity_id),
 UNIQUE (coordinator_id, attempt_id)
);
CREATE TABLE IF NOT EXISTS coordinator_auth_link_audit_log (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK (action IN ('link_created','link_revoked')),
 attempt_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
 controller_attestation_id TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL,
 PRIMARY KEY (coordinator_id, link_id, action)
);
