import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";

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
	`CREATE TRIGGER IF NOT EXISTS enrolled_devices_removal_enable
BEFORE UPDATE OF enabled ON enrolled_devices
WHEN NEW.enabled = 1 AND EXISTS (
  SELECT 1 FROM coordinator_device_removals t
  WHERE t.group_id = NEW.group_id AND ${NEW_ROW_TOMBSTONE_MATCH_SQL}
)
BEGIN
  SELECT RAISE(ABORT, 'device_removed');
END;`,
]);

export const ENROLLMENT_REMOVAL_TRIGGERS_SQL = `\n${ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS.join("\n\n")}\n`;

export const ENROLLMENT_REMOVAL_TRIGGER_NAMES: readonly string[] = Object.freeze([
	"enrolled_devices_removal_insert",
	"enrolled_devices_removal_update",
	"enrolled_devices_key_id_stale",
	"enrolled_devices_insert_collision",
	"enrolled_devices_rowid",
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

export const DEVICE_REMOVAL_FILL_DEFAULT_LIMIT = 200;
export const DEVICE_REMOVAL_FILL_MAX_LIMIT = 500;

export const ENROLLMENT_KEY_ID_UNFILLED_SQL = `SELECT rowid AS row_id, public_key
FROM enrolled_devices WHERE key_id IS NULL ORDER BY rowid LIMIT ?`;

/**
 * Bind one JSON array of `{ row_id, public_key, key_id }` twice. The key text is
 * pinned, so a row whose key changed after the read stays unfilled.
 */
export const ENROLLMENT_KEY_ID_FILL_SQL = `UPDATE enrolled_devices SET key_id = (
  SELECT json_extract(j.value, '$.key_id') FROM json_each(?) j
  WHERE json_extract(j.value, '$.row_id') = enrolled_devices.rowid
    AND json_extract(j.value, '$.public_key') = enrolled_devices.public_key)
WHERE key_id IS NULL AND EXISTS (
  SELECT 1 FROM json_each(?) j
  WHERE json_extract(j.value, '$.row_id') = enrolled_devices.rowid
    AND json_extract(j.value, '$.public_key') = enrolled_devices.public_key)`;

export interface UnfilledEnrollmentKey {
	row_id: number;
	public_key: string;
}

export function enrollmentKeyIdFillLimit(limit: unknown): number {
	if (limit === undefined) return DEVICE_REMOVAL_FILL_DEFAULT_LIMIT;
	if (!Number.isSafeInteger(limit) || (limit as number) < 1) throw new Error("invalid_input");
	return Math.min(limit as number, DEVICE_REMOVAL_FILL_MAX_LIMIT);
}

export interface CoordinatorFillEnrollmentKeyIdsResult {
	/** Rows filled by this call. */
	readonly filled: number;
	/** True when unfilled rows remain after this call. */
	readonly remaining: boolean;
}

export interface CoordinatorRemoveEnrollmentInput {
	groupId: string;
	deviceId: string;
	/** Audit metadata only; it proves nothing about ownership. */
	actorId?: string | null;
}

export interface CoordinatorDeviceRemovalEntry {
	readonly removal_seq: number;
	readonly group_id: string;
	readonly device_id: string;
}

export type CoordinatorRemoveEnrollmentResult =
	| { kind: "removed"; removal_id: string; removals: CoordinatorDeviceRemovalEntry[] }
	| { kind: "not_enrolled" };

export interface CoordinatorDeviceRemovalStore {
	/** Fills `enrolled_devices.key_id` for at most `limit` unfilled rows. */
	fillEnrollmentKeyIds(options?: {
		limit?: number;
	}): Promise<CoordinatorFillEnrollmentKeyIdsResult>;
	/** Removes one enrollment of one group and records its tombstone. No expansion by key. */
	removeEnrollment(
		input: CoordinatorRemoveEnrollmentInput,
	): Promise<CoordinatorRemoveEnrollmentResult>;
}

interface RemovalStatement {
	sql: string;
	values: (string | number | null)[];
	read?: boolean;
}

export interface DeviceRemovalBackend {
	/** All statements, including reads, execute in one transaction. */
	batch(statements: RemovalStatement[]): Promise<unknown[]>;
	all(statement: RemovalStatement): Promise<unknown>;
}

function incompleteResult(): never {
	throw new Error("device_removal_incomplete");
}

/** A schema without the tombstone table or the key ID column cannot record a removal. */
function removalBackendFailure(error: unknown): never {
	const message = error instanceof Error ? error.message : "";
	if (/no such table: coordinator_device_removals|no such column: (e\.)?key_id/u.test(message))
		throw new Error("device_removal_unavailable");
	throw new Error("device_removal_incomplete");
}

function resultRows<T>(result: unknown): T[] {
	if (
		!result ||
		typeof result !== "object" ||
		("success" in result && result.success === false) ||
		!("results" in result) ||
		!Array.isArray(result.results)
	)
		return incompleteResult();
	return result.results as T[];
}

function resultChanges(result: unknown): number {
	if (
		!result ||
		typeof result !== "object" ||
		("success" in result && result.success === false) ||
		!("meta" in result) ||
		!result.meta ||
		typeof result.meta !== "object" ||
		!("changes" in result.meta) ||
		!Number.isSafeInteger(result.meta.changes) ||
		(result.meta.changes as number) < 0
	)
		return incompleteResult();
	return result.meta.changes as number;
}

const NO_UNFILLED_KEY_ID_SQL = "NOT EXISTS (SELECT 1 FROM enrolled_devices WHERE key_id IS NULL)";
/** Bind the removal ID, group ID, and device ID, in that order. */
const OWN_TOMBSTONE_SQL = `EXISTS (SELECT 1 FROM coordinator_device_removals t
WHERE t.removal_id = ? AND t.group_id = ? AND t.device_id = ? AND t.lifted_at IS NULL)`;

/** The tombstone precedes the enrollment delete, which the delete trigger requires. */
function singleRemovalStatements(
	input: Required<CoordinatorRemoveEnrollmentInput>,
	removalId: string,
	now: string,
): RemovalStatement[] {
	const target = [input.groupId, input.deviceId];
	const own = [removalId, ...target];
	return [
		{
			sql: `INSERT INTO coordinator_device_removals(removal_id, group_id, device_id, public_key,
fingerprint, key_id, identity_id, display_name, actor_id, removed_at)
SELECT ?, e.group_id, e.device_id, e.public_key, e.fingerprint, NULLIF(e.key_id, ''),
e.identity_id, e.display_name, ?, ? FROM enrolled_devices e
WHERE e.group_id = ? AND e.device_id = ? AND ${NO_UNFILLED_KEY_ID_SQL}`,
			values: [removalId, input.actorId, now, ...target],
		},
		{
			sql: `DELETE FROM presence_records WHERE group_id = ? AND device_id = ? AND ${OWN_TOMBSTONE_SQL}`,
			values: [...target, ...own],
		},
		{
			sql: `DELETE FROM coordinator_reciprocal_approvals WHERE group_id = ?
AND (requesting_device_id = ? OR requested_device_id = ?) AND ${OWN_TOMBSTONE_SQL}`,
			values: [input.groupId, input.deviceId, input.deviceId, ...own],
		},
		{
			sql: `DELETE FROM enrolled_devices WHERE group_id = ? AND device_id = ? AND ${OWN_TOMBSTONE_SQL}`,
			values: [...target, ...own],
		},
		{
			sql: `SELECT removal_seq, group_id, device_id FROM coordinator_device_removals
WHERE removal_id = ? ORDER BY removal_seq`,
			values: [removalId],
			read: true,
		},
		{
			sql: `SELECT (SELECT COUNT(*) FROM enrolled_devices WHERE key_id IS NULL) AS unfilled,
(SELECT COUNT(*) FROM enrolled_devices WHERE group_id = ? AND device_id = ?) AS enrolled`,
			values: target,
			read: true,
		},
	];
}

function captureRemoval(input: unknown): Required<CoordinatorRemoveEnrollmentInput> {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const { groupId, deviceId } = source;
	const actorId = source.actorId ?? null;
	if (
		typeof groupId !== "string" ||
		typeof deviceId !== "string" ||
		(actorId !== null && !isAuthControllerId(actorId))
	)
		throw new Error("invalid_input");
	return { groupId, deviceId, actorId };
}

/** Internal storage capability. The caller authenticates the administrator. */
export class DeviceRemovalOperations implements CoordinatorDeviceRemovalStore {
	constructor(
		private readonly backend: DeviceRemovalBackend,
		private readonly clock: () => number = Date.now,
	) {}

	async fillEnrollmentKeyIds(
		options: { limit?: number } = {},
	): Promise<CoordinatorFillEnrollmentKeyIdsResult> {
		const limit = enrollmentKeyIdFillLimit(options.limit);
		const unfilled = resultRows<UnfilledEnrollmentKey>(
			await this.backend
				.all({ sql: ENROLLMENT_KEY_ID_UNFILLED_SQL, values: [limit + 1], read: true })
				.catch(removalBackendFailure),
		);
		const page = unfilled.slice(0, limit);
		if (page.length === 0) return { filled: 0, remaining: false };
		const entries = await Promise.all(
			page.map(async (row) => ({
				row_id: row.row_id,
				public_key: row.public_key,
				key_id: enrollmentKeyIdColumn(await ed25519KeyIdForRevocation(row.public_key)),
			})),
		);
		const json = JSON.stringify(entries);
		const results = await this.backend
			.batch([{ sql: ENROLLMENT_KEY_ID_FILL_SQL, values: [json, json] }])
			.catch(removalBackendFailure);
		if (results.length !== 1) return incompleteResult();
		const filled = resultChanges(results[0]);
		return { filled, remaining: unfilled.length > limit || filled < page.length };
	}

	/**
	 * Single-group removal: one enrollment, no expansion by key. It refuses with
	 * `device_removal_unavailable` while any enrollment has an unfilled key ID.
	 */
	async removeEnrollment(
		raw: CoordinatorRemoveEnrollmentInput,
	): Promise<CoordinatorRemoveEnrollmentResult> {
		const input = captureRemoval(raw);
		const removalId = globalThis.crypto.randomUUID();
		const statements = singleRemovalStatements(
			input,
			removalId,
			new Date(this.clock()).toISOString(),
		);
		const results = await this.backend.batch(statements).catch(removalBackendFailure);
		if (results.length !== statements.length) return incompleteResult();
		const writes = results.slice(0, 4).map(resultChanges);
		const removals = resultRows<CoordinatorDeviceRemovalEntry>(results[4]);
		const state = resultRows<{ unfilled: number; enrolled: number }>(results[5])[0];
		if (!state) return incompleteResult();
		if (removals.length === 0) {
			if (writes.some((count) => count !== 0)) return incompleteResult();
			if (state.enrolled > 0 && state.unfilled > 0) throw new Error("device_removal_unavailable");
			if (state.enrolled > 0) return incompleteResult();
			return { kind: "not_enrolled" };
		}
		if (removals.length !== 1 || writes[0] !== 1 || writes[3] !== 1 || state.enrolled !== 0)
			return incompleteResult();
		return { kind: "removed", removal_id: removalId, removals };
	}
}
