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

/**
 * SQL fragments with which a writer stores one extra column. On a coordinator
 * schema without device removal storage they are empty, so every enrollment and
 * invitation writer keeps working there exactly as before.
 */
export interface RemovalColumnSql {
	/** `, column` for an INSERT column list. */
	readonly column: string;
	/** `, value` for the matching position of the INSERT values. */
	readonly value: string;
	/** `, column = value` for an UPDATE. */
	readonly assignment: string;
}

const NO_REMOVAL_COLUMN: RemovalColumnSql = Object.freeze({
	column: "",
	value: "",
	assignment: "",
});

function removalColumnSql(ready: boolean, column: string, value: string): RemovalColumnSql {
	if (!ready) return NO_REMOVAL_COLUMN;
	return { column: `, ${column}`, value: `, ${value}`, assignment: `, ${column} = ${value}` };
}

/** `enrolled_devices.key_id` from `value`, by default one bound parameter. */
export function enrollmentKeyIdSql(ready: boolean, value = "?"): RemovalColumnSql {
	return removalColumnSql(ready, "key_id", value);
}

/** An active tombstone that matches the NEW enrollment row of a trigger. */
const NEW_ROW_TOMBSTONE_MATCH_SQL = `t.lifted_at IS NULL AND (
      t.device_id = NEW.device_id
      OR (NEW.key_id <> '' AND t.key_id = NEW.key_id)
      OR (NEW.key_id = '' AND t.public_key = NEW.public_key))`;

/**
 * Every character that String.prototype.trim removes, and that the key parser
 * splits tokens on, as one SQL string.
 */
const KEY_TEXT_SPACE_SQL = `char(${[
	9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
	8202, 8232, 8233, 8239, 8287, 12288, 65279,
].join(", ")})`;

/**
 * True when the key parser takes `text` for an SSH Ed25519 key, well formed or
 * not: after the leading space is trimmed, the text is exactly `ssh-ed25519` or
 * starts with it followed by a space character. The comparison is case
 * sensitive, as the parser's is.
 */
function readsAsEd25519Sql(text: string): string {
	const trimmed = `ltrim(${text}, ${KEY_TEXT_SPACE_SQL})`;
	return `substr(${trimmed}, 1, 11) = 'ssh-ed25519' AND (length(${trimmed}) = 11
    OR instr(${KEY_TEXT_SPACE_SQL}, substr(${trimmed}, 12, 1)) > 0)`;
}

/**
 * Checks on `enrolled_devices` that hold for every writer, including an older
 * release that opens a migrated database directly. They need the tombstone
 * table and the `key_id` column. They are a second check behind the statement
 * checks of each writer, and they do not evaluate invitations.
 *
 * Schema initialization and migration 0048 do not install them yet. A raw
 * delete of an enrollment, and a raw change to an Ed25519 key that leaves
 * `key_id` alone, both abort under them, and many existing suites arrange their
 * state that way.
 */
export const ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS: readonly string[] = Object.freeze([
	`CREATE TRIGGER IF NOT EXISTS enrolled_devices_removal_insert
BEFORE INSERT ON enrolled_devices
BEGIN
  SELECT RAISE(ABORT, 'enrollment_key_id_required')
    WHERE NEW.key_id IS NULL AND EXISTS (SELECT 1 FROM coordinator_device_removals);
  SELECT RAISE(ABORT, 'device_removed')
    WHERE EXISTS (SELECT 1 FROM coordinator_device_removals t WHERE ${NEW_ROW_TOMBSTONE_MATCH_SQL});
END;`,
	`-- Only a real change is checked. A writer that restates the group, device ID, key, or
-- key ID of an untouched row is not stopped by a tombstone that matches the device elsewhere.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_removal_update
BEFORE UPDATE OF group_id, device_id, public_key, key_id ON enrolled_devices
WHEN NEW.group_id IS NOT OLD.group_id OR NEW.device_id IS NOT OLD.device_id
  OR NEW.public_key IS NOT OLD.public_key OR NEW.key_id IS NOT OLD.key_id
BEGIN
  SELECT RAISE(ABORT, 'enrollment_key_id_required')
    WHERE NEW.key_id IS NULL AND EXISTS (SELECT 1 FROM coordinator_device_removals);
  SELECT RAISE(ABORT, 'device_removed')
    WHERE EXISTS (SELECT 1 FROM coordinator_device_removals t WHERE ${NEW_ROW_TOMBSTONE_MATCH_SQL});
END;`,
	`-- A writer that changes key text without restating the key ID would leave an ID that no
-- longer describes the key, and tombstones match by that ID. An opaque key has no ID to
-- go stale and is matched by its text, so a change from one opaque text to another passes.
-- A text is opaque unless, as the key parser reads it, its first token is exactly
-- ssh-ed25519. A restated ID with an equal value cannot be told from an ID that was left
-- alone, so a writer that keeps the ID value resets it to the empty string first.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_key_id_stale
BEFORE UPDATE OF public_key ON enrolled_devices
WHEN NEW.public_key IS NOT OLD.public_key AND NEW.key_id IS OLD.key_id
  AND NOT (NEW.key_id IS '' AND NOT (${readsAsEd25519Sql("NEW.public_key")}))
BEGIN
  SELECT RAISE(ABORT, 'enrollment_key_id_stale');
END;`,
	`-- Conflict replacement deletes the other row without firing its DELETE trigger
-- when recursive triggers are off, so a colliding write aborts first.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_insert_collision
BEFORE INSERT ON enrolled_devices
WHEN EXISTS (
  SELECT 1 FROM enrolled_devices
  WHERE rowid = NEW.rowid OR (group_id = NEW.group_id AND device_id = NEW.device_id)
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment_collision');
END;`,
	`-- An automatic rowid reads as -1 before insert; positive rowids keep that from matching a row.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_rowid
AFTER INSERT ON enrolled_devices
WHEN NEW.rowid < 1
BEGIN
  SELECT RAISE(ABORT, 'enrollment_rowid');
END;`,
	`-- A row moved below 1 would match the -1 that every later automatic insert reads before
-- insert, and the collision check would abort that insert. No column list, as below.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_rowid_update
BEFORE UPDATE ON enrolled_devices
WHEN NEW.rowid < 1
BEGIN
  SELECT RAISE(ABORT, 'enrollment_rowid');
END;`,
	`-- No column list: a list would miss an update that names the row ID as _rowid_ or oid.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_update_collision
BEFORE UPDATE ON enrolled_devices
WHEN EXISTS (
  SELECT 1 FROM enrolled_devices
  WHERE rowid <> OLD.rowid
    AND (rowid = NEW.rowid OR (group_id = NEW.group_id AND device_id = NEW.device_id))
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment_collision');
END;`,
	`CREATE TRIGGER IF NOT EXISTS enrolled_devices_removal_delete
BEFORE DELETE ON enrolled_devices
WHEN NOT EXISTS (
  SELECT 1 FROM coordinator_device_removals t
  WHERE t.lifted_at IS NULL AND t.group_id = OLD.group_id
    AND t.device_id = OLD.device_id AND t.public_key = OLD.public_key
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment_delete_requires_removal');
END;`,
	`-- A null key ID matches no tombstone by key, so a row from before the column is not
-- enabled until its writer states the key ID, as an insert must.
CREATE TRIGGER IF NOT EXISTS enrolled_devices_removal_enable
BEFORE UPDATE OF enabled ON enrolled_devices
WHEN NEW.enabled = 1
BEGIN
  SELECT RAISE(ABORT, 'enrollment_key_id_required')
    WHERE NEW.key_id IS NULL AND EXISTS (SELECT 1 FROM coordinator_device_removals);
  SELECT RAISE(ABORT, 'device_removed')
    WHERE EXISTS (SELECT 1 FROM coordinator_device_removals t
      WHERE t.group_id = NEW.group_id AND ${NEW_ROW_TOMBSTONE_MATCH_SQL});
END;`,
]);

export const ENROLLMENT_REMOVAL_TRIGGERS_SQL = `\n${ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS.join("\n\n")}\n`;

export const ENROLLMENT_REMOVAL_TRIGGER_NAMES: readonly string[] = Object.freeze([
	"enrolled_devices_removal_insert",
	"enrolled_devices_removal_update",
	"enrolled_devices_key_id_stale",
	"enrolled_devices_insert_collision",
	"enrolled_devices_rowid",
	"enrolled_devices_rowid_update",
	"enrolled_devices_update_collision",
	"enrolled_devices_removal_delete",
	"enrolled_devices_removal_enable",
]);

/**
 * The one statement that inserts an invitation, on both stores. With removal
 * storage it also records, as `issued_after_removal_seq`, the highest removal
 * sequence at that moment, or 0. It takes 24 bound values in column order.
 */
export function inviteInsertSql(hasRemovalSchema: boolean): string {
	const removalSeq = removalColumnSql(
		hasRemovalSchema,
		"issued_after_removal_seq",
		"COALESCE((SELECT MAX(removal_seq) FROM coordinator_device_removals), 0)",
	);
	return `INSERT INTO coordinator_invites(
	invite_id, group_id, token, policy, expires_at, created_at, created_by,
	team_name_snapshot, revoked_at, operation_id, reviewed_project_set_digest,
	token_digest, inviter_actor_id, inviter_display_name, inviter_device_id,
	pending_person_id, project_summaries_json, project_intent_json, trust_state,
	invite_kind, policy_team_id, target_identity_id, assigned_identity_id,
	reviewed_preview_digest, reviewed_intent_json${removalSeq.column}
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
	${removalSeq.value})`;
}

/**
 * `issued_after_removal_seq` of a new join request, copied from its invitation.
 * When ready, bind the group ID, the plaintext token, and its digest, in that order.
 */
export function joinRequestRemovalSeqSql(ready: boolean): RemovalColumnSql {
	return removalColumnSql(
		ready,
		"issued_after_removal_seq",
		`(SELECT i.issued_after_removal_seq FROM coordinator_invites i
WHERE i.group_id = ? AND (i.token = ? OR i.token_digest = ?) LIMIT 1)`,
	);
}

/**
 * `enrolled_devices.key_id` for a canonical key ID: the ID itself, or an empty
 * string for a key that is not SSH Ed25519. Null is reserved for unfilled rows.
 */
export function enrollmentKeyIdColumn(keyId: string | null): string {
	return keyId ?? "";
}
