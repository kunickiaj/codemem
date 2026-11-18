import { type Database, tableExists } from "./db.js";
import {
	type ProjectBoundaryMigrationRecordRow,
	projectBoundaryMigrationRecordFromRow,
} from "./project-boundary-migration-records.js";

/*
 * The hold on a migrated Project. While it is set, the recipient reconciler
 * works out what it would change and changes nothing, so a Project keeps the
 * devices the migration copied until a pass finds nothing to change or the
 * admin confirms the summary.
 *
 * The hold is not a stored flag. A Project with a migration record is held
 * unless the hold was cleared at the record's current generation. A newer
 * record therefore sets the hold again with no second write that could be
 * missed, and anything this module cannot read leaves the Project held.
 */

const TABLE = "project_boundary_migrations";
const RECORD_COLUMNS = [
	"boundary_scope_id",
	"source_scope_id",
	"additional_source_scope_ids_json",
	"state",
	"generation",
];
const HOLD_COLUMNS = [
	"hold_cleared_generation",
	"hold_cleared_reason",
	"hold_cleared_at",
	"hold_withdrawn_generation",
	"hold_withdrawn_device_ids_json",
];

/** Why a hold was cleared: nothing to change, the admin's answer, or a recipient change in Projects. */
export type MigrationHoldClearReason = "empty_plan" | "summary_confirmed" | "recipients_changed";

const CLEAR_REASONS: readonly MigrationHoldClearReason[] = [
	"empty_plan",
	"summary_confirmed",
	"recipients_changed",
];

export interface ProjectBoundaryMigrationHold {
	boundaryScopeId: string;
	/** The record's generation. Null when the stored row is not a valid record, which nothing can clear. */
	generation: number | null;
	held: boolean;
	clearedReason: MigrationHoldClearReason | null;
	clearedAt: string | null;
	/**
	 * Devices that belonged to a deactivated or merged person when this hold was
	 * first seen at the current generation. Null until a pass has stored them.
	 */
	withdrawnAtFirstPassDeviceIds: string[] | null;
}

export interface ClearProjectBoundaryMigrationHoldInput {
	boundaryScopeId: string;
	/** The generation the caller read. A hold on any other generation stays set. */
	generation: number;
	reason: MigrationHoldClearReason;
	now?: string;
}

export interface RecordHoldWithdrawnDevicesInput {
	boundaryScopeId: string;
	generation: number;
	deviceIds: readonly string[];
}

interface HoldRow extends ProjectBoundaryMigrationRecordRow {
	hold_cleared_generation: number | null;
	hold_cleared_reason: string | null;
	hold_cleared_at: string | null;
	hold_withdrawn_generation: number | null;
	hold_withdrawn_device_ids_json: string | null;
}

function isCleanId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function assertValidTarget(input: { boundaryScopeId: string; generation: number }): void {
	if (
		!isCleanId(input.boundaryScopeId) ||
		!Number.isSafeInteger(input.generation) ||
		input.generation < 1
	) {
		throw new Error("project_boundary_migration_hold_invalid");
	}
}

/** The additive schema step is fail-open, so a database can hold records without these columns. */
function holdColumnsExist(db: Database): boolean {
	const found = db
		.prepare(
			`SELECT COUNT(*) FROM pragma_table_info(?)
			 WHERE name IN (${HOLD_COLUMNS.map(() => "?").join(", ")})`,
		)
		.pluck()
		.get(TABLE, ...HOLD_COLUMNS);
	return found === HOLD_COLUMNS.length;
}

function readRow(db: Database, boundaryScopeId: string): HoldRow | undefined {
	if (!tableExists(db, TABLE)) return undefined;
	const holdColumns = holdColumnsExist(db)
		? HOLD_COLUMNS
		: HOLD_COLUMNS.map((column) => `NULL AS ${column}`);
	return db
		.prepare(
			`SELECT ${[...RECORD_COLUMNS, ...holdColumns].join(", ")}
			 FROM ${TABLE} WHERE boundary_scope_id = ?`,
		)
		.get(boundaryScopeId) as HoldRow | undefined;
}

/** The stored list, or null when any part of it is not a device ID. Dropping an entry would change who is asked about. */
function storedDeviceIds(raw: string | null): string[] | null {
	if (raw == null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.every(isCleanId) ? parsed : null;
	} catch {
		return null;
	}
}

function holdFromRow(row: HoldRow): ProjectBoundaryMigrationHold {
	const held = {
		boundaryScopeId: row.boundary_scope_id,
		generation: null,
		held: true,
		clearedReason: null,
		clearedAt: null,
		withdrawnAtFirstPassDeviceIds: null,
	};
	const record = projectBoundaryMigrationRecordFromRow(row);
	if (!record) return held;
	const withdrawnAtFirstPassDeviceIds =
		row.hold_withdrawn_generation === record.generation
			? storedDeviceIds(row.hold_withdrawn_device_ids_json)
			: null;
	const current = { ...held, generation: record.generation, withdrawnAtFirstPassDeviceIds };
	const clearedReason = CLEAR_REASONS.find((reason) => reason === row.hold_cleared_reason);
	if (row.hold_cleared_generation !== record.generation || !clearedReason) return current;
	return { ...current, held: false, clearedReason, clearedAt: row.hold_cleared_at };
}

/**
 * The hold for one boundary. Null means the Project has no migration record on
 * this device, so the reconciler treats it as it always has.
 */
export function getProjectBoundaryMigrationHold(
	db: Database,
	boundaryScopeId: string,
): ProjectBoundaryMigrationHold | null {
	const row = readRow(db, boundaryScopeId);
	return row ? holdFromRow(row) : null;
}

/**
 * Clears the hold for the generation the caller read. Returns whether the hold
 * is clear at that generation afterwards. A newer record, an unreadable row, or
 * a database without the hold columns leaves the Project held. The first reason
 * a hold was cleared for is kept. The read and the write share one write
 * transaction, so a newer record cannot arrive between them.
 */
export function clearProjectBoundaryMigrationHold(
	db: Database,
	input: ClearProjectBoundaryMigrationHoldInput,
): boolean {
	assertValidTarget(input);
	if (!CLEAR_REASONS.includes(input.reason)) {
		throw new Error("project_boundary_migration_hold_invalid");
	}
	if (!tableExists(db, TABLE) || !holdColumnsExist(db)) return false;
	return db
		.transaction(() => {
			const hold = getProjectBoundaryMigrationHold(db, input.boundaryScopeId);
			if (hold?.generation !== input.generation) return false;
			if (!hold.held) return true;
			db.prepare(
				`UPDATE ${TABLE}
			 SET hold_cleared_generation = generation, hold_cleared_reason = ?, hold_cleared_at = ?
			 WHERE boundary_scope_id = ? AND generation = ?`,
			).run(
				input.reason,
				input.now ?? new Date().toISOString(),
				input.boundaryScopeId,
				input.generation,
			);
			return true;
		})
		.immediate();
}

/**
 * Stores the devices that already belonged to a deactivated or merged person
 * when the hold is first seen at this generation, and returns the stored list.
 * The first pass wins: a later call returns what the first stored, so a person
 * withdrawn afterwards is never added. Returns null when the record is at
 * another generation or cannot be read.
 */
export function recordHoldWithdrawnDevices(
	db: Database,
	input: RecordHoldWithdrawnDevicesInput,
): string[] | null {
	assertValidTarget(input);
	if (!input.deviceIds.every(isCleanId)) {
		throw new Error("project_boundary_migration_hold_invalid");
	}
	if (!tableExists(db, TABLE) || !holdColumnsExist(db)) return null;
	const deviceIds = [...new Set(input.deviceIds)].toSorted();
	return db
		.transaction(() => {
			const hold = getProjectBoundaryMigrationHold(db, input.boundaryScopeId);
			if (hold?.generation !== input.generation) return null;
			if (hold.withdrawnAtFirstPassDeviceIds) return hold.withdrawnAtFirstPassDeviceIds;
			db.prepare(
				`UPDATE ${TABLE}
			 SET hold_withdrawn_generation = generation, hold_withdrawn_device_ids_json = ?
			 WHERE boundary_scope_id = ? AND generation = ?`,
			).run(JSON.stringify(deviceIds), input.boundaryScopeId, input.generation);
			return deviceIds;
		})
		.immediate();
}
