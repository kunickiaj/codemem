/** Inert ledger schema: only future verified, atomic enrollment writes may populate it. */
export const COORDINATOR_DEVICE_OWNERSHIP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_device_ownership_bindings (
  device_id TEXT PRIMARY KEY NOT NULL CHECK(
    typeof(device_id) = 'text' AND length(trim(device_id)) > 0 AND instr(device_id, char(0)) = 0),
  key_id TEXT NOT NULL UNIQUE CHECK(
    typeof(key_id) = 'text' AND length(key_id) = 64 AND key_id NOT GLOB '*[^a-f0-9]*'
    AND instr(key_id, char(0)) = 0),
  identity_id TEXT NOT NULL CHECK(
    typeof(identity_id) = 'text' AND length(trim(identity_id)) > 0 AND instr(identity_id, char(0)) = 0),
  coordinator_id TEXT NOT NULL CHECK(
    typeof(coordinator_id) = 'text' AND length(trim(coordinator_id)) > 0 AND instr(coordinator_id, char(0)) = 0),
  binding_id TEXT NOT NULL UNIQUE CHECK(
    typeof(binding_id) = 'text' AND length(trim(binding_id)) > 0 AND instr(binding_id, char(0)) = 0),
  provenance TEXT NOT NULL CHECK(
    typeof(provenance) = 'text' AND provenance IN ('owner_enrollment', 'reviewed_legacy_migration')),
  source_ref TEXT NOT NULL CHECK(
    typeof(source_ref) = 'text' AND length(trim(source_ref)) > 0 AND instr(source_ref, char(0)) = 0),
  bound_at TEXT NOT NULL CHECK(
    typeof(bound_at) = 'text' AND length(trim(bound_at)) > 0 AND instr(bound_at, char(0)) = 0)
);

-- REPLACE's implicit deletes may skip DELETE triggers when recursive triggers are off.
CREATE TRIGGER IF NOT EXISTS coordinator_device_ownership_insert_collision
BEFORE INSERT ON coordinator_device_ownership_bindings
WHEN EXISTS (
  SELECT 1 FROM coordinator_device_ownership_bindings
  WHERE device_id = NEW.device_id OR key_id = NEW.key_id OR binding_id = NEW.binding_id
)
BEGIN
  SELECT RAISE(ABORT, 'device_ownership_collision');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_ownership_immutable_update
BEFORE UPDATE ON coordinator_device_ownership_bindings
BEGIN
  SELECT RAISE(ABORT, 'device_ownership_immutable');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_device_ownership_immutable_delete
BEFORE DELETE ON coordinator_device_ownership_bindings
BEGIN
  SELECT RAISE(ABORT, 'device_ownership_immutable');
END;
`;
