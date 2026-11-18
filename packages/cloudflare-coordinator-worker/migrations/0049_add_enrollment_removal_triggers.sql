-- Device removals (0.50): the triggers on enrolled_devices that apply the removal
-- tombstones of migration 0048 to every enrollment writer. Mirror of
-- ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS in packages/core/src/coordinator-device-removal.ts.
-- Until this migration is applied, enrollment writers store key IDs and a removal
-- cannot be recorded.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_removal_insert
BEFORE INSERT ON enrolled_devices
BEGIN
  SELECT RAISE(ABORT, 'enrollment_key_id_required')
    WHERE NEW.key_id IS NULL AND EXISTS (SELECT 1 FROM coordinator_device_removals);
  SELECT RAISE(ABORT, 'device_removed')
    WHERE EXISTS (SELECT 1 FROM coordinator_device_removals t WHERE t.lifted_at IS NULL AND (
      t.device_id = NEW.device_id
      OR (NEW.key_id <> '' AND t.key_id = NEW.key_id)
      OR (NEW.key_id = '' AND t.public_key = NEW.public_key)));
END;

-- Only a real change is checked. A writer that restates the group, device ID, key, or
-- key ID of an untouched row is not stopped by a tombstone that matches the device elsewhere.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_removal_update
BEFORE UPDATE OF group_id, device_id, public_key, key_id ON enrolled_devices
WHEN NEW.group_id IS NOT OLD.group_id OR NEW.device_id IS NOT OLD.device_id
  OR NEW.public_key IS NOT OLD.public_key OR NEW.key_id IS NOT OLD.key_id
BEGIN
  SELECT RAISE(ABORT, 'enrollment_key_id_required')
    WHERE NEW.key_id IS NULL AND EXISTS (SELECT 1 FROM coordinator_device_removals);
  SELECT RAISE(ABORT, 'device_removed')
    WHERE EXISTS (SELECT 1 FROM coordinator_device_removals t WHERE t.lifted_at IS NULL AND (
      t.device_id = NEW.device_id
      OR (NEW.key_id <> '' AND t.key_id = NEW.key_id)
      OR (NEW.key_id = '' AND t.public_key = NEW.public_key)));
END;

-- A writer that changes key text without restating the key ID would leave an ID that no
-- longer describes the key, and tombstones match by that ID. An opaque key has no ID to
-- go stale and is matched by its text, so a change from one opaque text to another passes.
-- A text is opaque unless, as the key parser reads it, its first token is exactly
-- ssh-ed25519. A restated ID with an equal value cannot be told from an ID that was left
-- alone, so a writer that keeps the ID value resets it to the empty string first.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_key_id_stale
BEFORE UPDATE OF public_key ON enrolled_devices
WHEN NEW.public_key IS NOT OLD.public_key AND NEW.key_id IS OLD.key_id
  AND NOT (NEW.key_id IS '' AND NOT (substr(ltrim(NEW.public_key, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)), 1, 11) = 'ssh-ed25519' AND (length(ltrim(NEW.public_key, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))) = 11
    OR instr(char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279), substr(ltrim(NEW.public_key, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)), 12, 1)) > 0)))
BEGIN
  SELECT RAISE(ABORT, 'enrollment_key_id_stale');
END;

-- Conflict replacement deletes the other row without firing its DELETE trigger
-- when recursive triggers are off, so a colliding write aborts first.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_insert_collision
BEFORE INSERT ON enrolled_devices
WHEN EXISTS (
  SELECT 1 FROM enrolled_devices
  WHERE rowid = NEW.rowid OR (group_id = NEW.group_id AND device_id = NEW.device_id)
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment_collision');
END;

-- An automatic rowid reads as -1 before insert; positive rowids keep that from matching a row.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_rowid
AFTER INSERT ON enrolled_devices
WHEN NEW.rowid < 1
BEGIN
  SELECT RAISE(ABORT, 'enrollment_rowid');
END;

-- A row moved below 1 would match the -1 that every later automatic insert reads before
-- insert, and the collision check would abort that insert. No column list, as below.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_rowid_update
BEFORE UPDATE ON enrolled_devices
WHEN NEW.rowid < 1
BEGIN
  SELECT RAISE(ABORT, 'enrollment_rowid');
END;

-- No column list: a list would miss an update that names the row ID as _rowid_ or oid.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_update_collision
BEFORE UPDATE ON enrolled_devices
WHEN EXISTS (
  SELECT 1 FROM enrolled_devices
  WHERE rowid <> OLD.rowid
    AND (rowid = NEW.rowid OR (group_id = NEW.group_id AND device_id = NEW.device_id))
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment_collision');
END;

CREATE TRIGGER IF NOT EXISTS enrolled_devices_removal_delete
BEFORE DELETE ON enrolled_devices
WHEN NOT EXISTS (
  SELECT 1 FROM coordinator_device_removals t
  WHERE t.lifted_at IS NULL AND t.group_id = OLD.group_id
    AND t.device_id = OLD.device_id AND t.public_key = OLD.public_key
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment_delete_requires_removal');
END;

-- A null key ID matches no tombstone by key, so a row from before the column is not
-- enabled until its writer states the key ID, as an insert must.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_removal_enable
BEFORE UPDATE OF enabled ON enrolled_devices
WHEN NEW.enabled = 1
BEGIN
  SELECT RAISE(ABORT, 'enrollment_key_id_required')
    WHERE NEW.key_id IS NULL AND EXISTS (SELECT 1 FROM coordinator_device_removals);
  SELECT RAISE(ABORT, 'device_removed')
    WHERE EXISTS (SELECT 1 FROM coordinator_device_removals t
      WHERE t.group_id = NEW.group_id AND t.lifted_at IS NULL AND (
      t.device_id = NEW.device_id
      OR (NEW.key_id <> '' AND t.key_id = NEW.key_id)
      OR (NEW.key_id = '' AND t.public_key = NEW.public_key)));
END;
