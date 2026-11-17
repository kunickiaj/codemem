import type { AuthLinkBackend } from "./coordinator-auth-link.js";

/**
 * Removal tombstones. One row records each deleted enrollment and stays active
 * until a lift sets `lifted_at` and exactly one of the two `lifted_by_*` columns.
 * `removal_seq` is the only value that orders a removal against an invitation.
 */
export const DEVICE_REMOVAL_SCHEMA_SQL = `
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
`;

/** Additive columns of existing tables. Rows that predate a column keep null. */
export const DEVICE_REMOVAL_COLUMNS: readonly { table: string; column: string; sql: string }[] =
	Object.freeze(
		[
			{ table: "coordinator_invites", column: "issued_after_removal_seq", type: "INTEGER" },
			{ table: "coordinator_join_requests", column: "issued_after_removal_seq", type: "INTEGER" },
			{ table: "enrolled_devices", column: "key_id", type: "TEXT" },
		].map(({ table, column, type }) => ({
			table,
			column,
			sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`,
		})),
	);

export const DEVICE_REMOVAL_MIGRATION_NAME = "0048_add_device_removals.sql";

/** Every trigger of DEVICE_REMOVAL_SCHEMA_SQL. Readiness requires each of them by name. */
export const DEVICE_REMOVAL_TRIGGER_NAMES: readonly string[] = Object.freeze([
	"coordinator_device_removals_insert",
	"coordinator_device_removals_update",
	"coordinator_device_removals_delete",
	"coordinator_device_removals_rowid",
]);

const hasColumnSql = ({ table, column }: { table: string; column: string }) =>
	`EXISTS (SELECT 1 FROM pragma_table_info('${table}') WHERE name = '${column}')`;

/**
 * `ready` is 1 when the tombstone table, its active-tombstone index, each of its
 * triggers, and the three columns exist. Every object is required by name, so
 * an object that a later release adds next to them does not change the answer.
 */
export const DEVICE_REMOVAL_SCHEMA_READINESS_SQL = `SELECT (
	EXISTS (SELECT 1 FROM sqlite_master
		WHERE type = 'table' AND name = 'coordinator_device_removals')
	AND EXISTS (SELECT 1 FROM sqlite_master
		WHERE type = 'index' AND name = 'idx_coordinator_device_removals_active')
	AND ${DEVICE_REMOVAL_TRIGGER_NAMES.map(
		(name) => `EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = '${name}')`,
	).join("\n\tAND ")}
	AND ${DEVICE_REMOVAL_COLUMNS.map(hasColumnSql).join("\n\tAND ")}) AS ready`;

/** Whether migration 0048, or SQLite initialization, has installed device removal storage. */
export async function hasDeviceRemovalSchema(
	backend: Pick<AuthLinkBackend, "first">,
): Promise<boolean> {
	const row = await backend.first<{ ready: number }>({
		sql: DEVICE_REMOVAL_SCHEMA_READINESS_SQL,
		values: [],
	});
	return row?.ready === 1;
}
