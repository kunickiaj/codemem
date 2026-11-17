-- Device removals (0.50): tombstones for removed enrollments, the removal
-- sequence an invitation was issued after, and the canonical key ID of each
-- enrollment. Mirror of packages/core/src/coordinator-device-removal.ts.
-- Existing enrollments keep a null key_id until the coordinator fills it, because
-- SQL cannot compute the key ID. Removal stays unavailable until then.
-- The triggers on enrolled_devices are not part of this migration yet.
ALTER TABLE coordinator_invites ADD COLUMN issued_after_removal_seq INTEGER;
ALTER TABLE coordinator_join_requests ADD COLUMN issued_after_removal_seq INTEGER;
ALTER TABLE enrolled_devices ADD COLUMN key_id TEXT;

CREATE TABLE IF NOT EXISTS coordinator_device_removals (
  removal_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  removal_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  key_id TEXT,
  identity_id TEXT,
  display_name TEXT,
  actor_id TEXT,
  removed_at TEXT NOT NULL,
  lifted_at TEXT,
  lifted_by_invite_id TEXT,
  lifted_by_attempt_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_device_removals_active
  ON coordinator_device_removals(group_id, device_id) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_coordinator_device_removals_device
  ON coordinator_device_removals(device_id);
CREATE INDEX IF NOT EXISTS idx_coordinator_device_removals_key
  ON coordinator_device_removals(key_id) WHERE key_id IS NOT NULL;

-- A tombstone starts active. REPLACE's implicit deletes may skip DELETE triggers
-- when recursive triggers are off, so a colliding insert aborts before it can replace.
CREATE TRIGGER IF NOT EXISTS coordinator_device_removals_insert
BEFORE INSERT ON coordinator_device_removals
WHEN NEW.lifted_at IS NOT NULL OR NEW.lifted_by_invite_id IS NOT NULL
  OR NEW.lifted_by_attempt_id IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM coordinator_device_removals
    WHERE removal_seq = NEW.removal_seq
      OR (lifted_at IS NULL AND group_id = NEW.group_id AND device_id = NEW.device_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'device_removal_collision');
END;

-- The only update is the single lift of an active row. No column list, so an
-- update that names the row ID as rowid, _rowid_, or oid is covered too.
CREATE TRIGGER IF NOT EXISTS coordinator_device_removals_update
BEFORE UPDATE ON coordinator_device_removals
WHEN NOT (
  OLD.lifted_at IS NULL AND OLD.lifted_by_invite_id IS NULL AND OLD.lifted_by_attempt_id IS NULL
  AND NEW.lifted_at IS NOT NULL
  AND (NEW.lifted_by_invite_id IS NULL) <> (NEW.lifted_by_attempt_id IS NULL)
  AND NEW.removal_seq IS OLD.removal_seq AND NEW.removal_id IS OLD.removal_id
  AND NEW.group_id IS OLD.group_id AND NEW.device_id IS OLD.device_id
  AND NEW.public_key IS OLD.public_key AND NEW.fingerprint IS OLD.fingerprint
  AND NEW.key_id IS OLD.key_id AND NEW.identity_id IS OLD.identity_id
  AND NEW.display_name IS OLD.display_name AND NEW.actor_id IS OLD.actor_id
  AND NEW.removed_at IS OLD.removed_at
)
BEGIN
  SELECT RAISE(ABORT, 'device_removal_immutable');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_removals_delete
BEFORE DELETE ON coordinator_device_removals
BEGIN
  SELECT RAISE(ABORT, 'device_removal_immutable');
END;

-- An automatic removal_seq reads as -1 before insert. Positive values keep that from matching a row.
CREATE TRIGGER IF NOT EXISTS coordinator_device_removals_rowid
AFTER INSERT ON coordinator_device_removals
WHEN NEW.removal_seq < 1
BEGIN
  SELECT RAISE(ABORT, 'device_removal_rowid');
END;
