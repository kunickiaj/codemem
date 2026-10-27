-- Bindings are immutable, but the collision trigger ignored rowid: INSERT OR
-- REPLACE with an existing rowid could delete a binding without firing its
-- DELETE trigger (recursive triggers are off). Replace it and reject rowid < 1.
-- Mirror of packages/core/src/coordinator-device-ownership-schema.ts.
DROP TRIGGER IF EXISTS coordinator_device_ownership_insert_collision;
CREATE TRIGGER coordinator_device_ownership_insert_collision
BEFORE INSERT ON coordinator_device_ownership_bindings
WHEN EXISTS (
  SELECT 1 FROM coordinator_device_ownership_bindings
  WHERE rowid = NEW.rowid OR device_id = NEW.device_id OR key_id = NEW.key_id
    OR binding_id = NEW.binding_id
)
BEGIN
  SELECT RAISE(ABORT, 'device_ownership_collision');
END;

-- An automatic rowid reads as -1 before insert; positive rowids keep that from matching a row.
CREATE TRIGGER IF NOT EXISTS coordinator_device_ownership_rowid
AFTER INSERT ON coordinator_device_ownership_bindings
WHEN NEW.rowid < 1
BEGIN
  SELECT RAISE(ABORT, 'device_ownership_rowid');
END;
