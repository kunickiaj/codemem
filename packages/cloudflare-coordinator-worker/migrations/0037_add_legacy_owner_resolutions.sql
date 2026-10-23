-- Inert historical-label receipts, not credentials or proof of authority.
CREATE TABLE IF NOT EXISTS coordinator_legacy_owner_resolutions (
 coordinator_id TEXT NOT NULL CHECK (typeof(coordinator_id) = 'text' AND length(coordinator_id) BETWEEN 1 AND 256 AND length(trim(coordinator_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(coordinator_id, char(0)) = 0),
 resolution_id TEXT NOT NULL CHECK (typeof(resolution_id) = 'text' AND length(resolution_id) BETWEEN 1 AND 256 AND length(trim(resolution_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(resolution_id, char(0)) = 0),
 resolution_version INTEGER NOT NULL CHECK (typeof(resolution_version) = 'integer' AND resolution_version = 1),
 device_id TEXT NOT NULL CHECK (typeof(device_id) = 'text' AND length(device_id) BETWEEN 1 AND 256 AND length(trim(device_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(device_id, char(0)) = 0),
 key_id TEXT NOT NULL CHECK (typeof(key_id) = 'text' AND length(key_id) = 64 AND key_id NOT GLOB '*[^0-9a-f]*' AND instr(key_id, char(0)) = 0),
 owner_identity_id TEXT NOT NULL CHECK (typeof(owner_identity_id) = 'text' AND length(owner_identity_id) BETWEEN 1 AND 256 AND length(trim(owner_identity_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(owner_identity_id, char(0)) = 0),
 purpose TEXT NOT NULL CHECK (purpose = 'existing_account_owner'),
 scope TEXT NOT NULL CHECK (scope = 'historical_included_owner_labels_only'),
 source_attestation_id TEXT NOT NULL CHECK (typeof(source_attestation_id) = 'text' AND length(source_attestation_id) BETWEEN 1 AND 256 AND length(trim(source_attestation_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_attestation_id, char(0)) = 0),
 source_group_id TEXT NOT NULL CHECK (typeof(source_group_id) = 'text' AND length(source_group_id) BETWEEN 1 AND 256 AND length(trim(source_group_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_group_id, char(0)) = 0),
 source_controller_revision INTEGER NOT NULL CHECK (typeof(source_controller_revision) = 'integer' AND source_controller_revision = 1),
 source_public_key TEXT NOT NULL CHECK (typeof(source_public_key) = 'text' AND length(source_public_key) BETWEEN 1 AND 4096 AND length(trim(source_public_key, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_public_key, char(0)) = 0),
 source_fingerprint TEXT NOT NULL CHECK (typeof(source_fingerprint) = 'text' AND length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*' AND instr(source_fingerprint, char(0)) = 0),
 source_enrollment_identity_id TEXT CHECK (source_enrollment_identity_id IS NULL OR (typeof(source_enrollment_identity_id) = 'text' AND length(source_enrollment_identity_id) BETWEEN 1 AND 256 AND length(trim(source_enrollment_identity_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_enrollment_identity_id, char(0)) = 0)),
 source_created_at TEXT NOT NULL CHECK (typeof(source_created_at) = 'text' AND length(source_created_at) BETWEEN 1 AND 256 AND length(trim(source_created_at, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_created_at, char(0)) = 0),
 source_review_receipt_id TEXT NOT NULL CHECK (typeof(source_review_receipt_id) = 'text' AND length(source_review_receipt_id) BETWEEN 1 AND 256 AND length(trim(source_review_receipt_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_review_receipt_id, char(0)) = 0),
 source_evidence_digest TEXT NOT NULL CHECK (typeof(source_evidence_digest) = 'text' AND length(source_evidence_digest) = 64 AND source_evidence_digest NOT GLOB '*[^0-9a-f]*' AND instr(source_evidence_digest, char(0)) = 0),
 resolution_evidence_digest TEXT NOT NULL CHECK (typeof(resolution_evidence_digest) = 'text' AND length(resolution_evidence_digest) = 64 AND resolution_evidence_digest NOT GLOB '*[^0-9a-f]*' AND instr(resolution_evidence_digest, char(0)) = 0),
 reviewed_weak_labels_json TEXT NOT NULL CHECK (typeof(reviewed_weak_labels_json) = 'text' AND length(CAST(reviewed_weak_labels_json AS BLOB)) <= 131072 AND CASE WHEN json_valid(reviewed_weak_labels_json) THEN json_type(reviewed_weak_labels_json) = 'array' ELSE 0 END),
 created_at TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND length(created_at) BETWEEN 1 AND 256 AND length(trim(created_at, char(9)||char(10)||char(13)||' ')) > 0 AND instr(created_at, char(0)) = 0),
 PRIMARY KEY (coordinator_id, resolution_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_legacy_owner_resolutions_device
 ON coordinator_legacy_owner_resolutions (coordinator_id, device_id);

CREATE INDEX IF NOT EXISTS idx_legacy_owner_resolutions_key
 ON coordinator_legacy_owner_resolutions (coordinator_id, key_id);

-- Reject before REPLACE can erase a receipt, even with recursive triggers off.
-- Separate indexed probes keep device-OR-key conflicts coordinator-scoped.
CREATE TRIGGER IF NOT EXISTS legacy_owner_resolution_insert_collision
BEFORE INSERT ON coordinator_legacy_owner_resolutions
WHEN EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions
 WHERE coordinator_id = NEW.coordinator_id AND resolution_id = NEW.resolution_id)
 OR EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions
 WHERE coordinator_id = NEW.coordinator_id AND device_id = NEW.device_id AND owner_identity_id <> NEW.owner_identity_id)
 OR EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions
 WHERE coordinator_id = NEW.coordinator_id AND key_id = NEW.key_id AND owner_identity_id <> NEW.owner_identity_id)
BEGIN SELECT RAISE(ABORT, 'legacy_owner_resolution_collision'); END;

CREATE TRIGGER IF NOT EXISTS legacy_owner_resolution_immutable_update
BEFORE UPDATE ON coordinator_legacy_owner_resolutions
BEGIN SELECT RAISE(ABORT, 'legacy_owner_resolution_immutable'); END;

CREATE TRIGGER IF NOT EXISTS legacy_owner_resolution_immutable_delete
BEFORE DELETE ON coordinator_legacy_owner_resolutions
BEGIN SELECT RAISE(ABORT, 'legacy_owner_resolution_immutable'); END;
