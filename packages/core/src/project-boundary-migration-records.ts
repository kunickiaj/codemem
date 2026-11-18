import { type Database, tableExists } from "./db.js";

/*
 * This device's copy of the coordinator's migration records: which older scope
 * a Project moved out of, and which boundary it moved into. A record is the
 * evidence that a memory may change scope when a snapshot is applied. The
 * table is part of the schema from version 22. Storing a record never touches
 * the hold columns beside it (project-boundary-migration-hold.ts).
 */

export type ProjectBoundaryMigrationState = "committed" | "rolled_back" | "detached";

const STATES: readonly ProjectBoundaryMigrationState[] = ["committed", "rolled_back", "detached"];

export interface ProjectBoundaryMigrationRecord {
	boundaryScopeId: string;
	sourceScopeId: string;
	/** A second older setup whose memories move too, named after the admin's answer. */
	additionalSourceScopeIds: string[];
	state: ProjectBoundaryMigrationState;
	generation: number;
}

export interface RecordProjectBoundaryMigrationInput {
	boundaryScopeId: string;
	sourceScopeId: string;
	additionalSourceScopeIds?: string[];
	state: ProjectBoundaryMigrationState;
	generation: number;
	now?: string;
}

/** The record columns of a stored row, as SQLite returns them. */
export interface ProjectBoundaryMigrationRecordRow {
	boundary_scope_id: string;
	source_scope_id: string;
	additional_source_scope_ids_json: string;
	state: string;
	generation: number;
}

function cleanScopeId(value: unknown): string | null {
	return typeof value === "string" && value.trim() === value && value.length > 0 ? value : null;
}

function scopeIdList(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((value) => cleanScopeId(value) ?? []);
	} catch {
		return [];
	}
}

/** Reads a stored row as a record, or null when the writer would not have accepted it. */
export function projectBoundaryMigrationRecordFromRow(
	row: ProjectBoundaryMigrationRecordRow,
): ProjectBoundaryMigrationRecord | null {
	const state = STATES.find((candidate) => candidate === row.state);
	const boundaryScopeId = cleanScopeId(row.boundary_scope_id);
	const sourceScopeId = cleanScopeId(row.source_scope_id);
	const additionalSourceScopeIds = scopeIdList(row.additional_source_scope_ids_json);
	// The same shape the writer accepts. A row that fails it covers nothing.
	if (
		!state ||
		!boundaryScopeId ||
		!sourceScopeId ||
		!Number.isSafeInteger(row.generation) ||
		row.generation < 1 ||
		[sourceScopeId, ...additionalSourceScopeIds].includes(boundaryScopeId)
	) {
		return null;
	}
	return {
		boundaryScopeId,
		sourceScopeId,
		additionalSourceScopeIds,
		state,
		generation: row.generation,
	};
}

/**
 * Every record this device holds. The additive schema step is fail-open, so a
 * database it could not upgrade has no table, and that reads as no records.
 */
export function listProjectBoundaryMigrationRecords(
	db: Database,
): ProjectBoundaryMigrationRecord[] {
	if (!tableExists(db, "project_boundary_migrations")) return [];
	const rows = db
		.prepare(
			`SELECT boundary_scope_id, source_scope_id, additional_source_scope_ids_json, state, generation
			 FROM project_boundary_migrations ORDER BY boundary_scope_id`,
		)
		.all() as ProjectBoundaryMigrationRecordRow[];
	return rows.flatMap((row) => projectBoundaryMigrationRecordFromRow(row) ?? []);
}

function validatedInput(input: RecordProjectBoundaryMigrationInput) {
	const boundaryScopeId = cleanScopeId(input.boundaryScopeId);
	const sourceScopeId = cleanScopeId(input.sourceScopeId);
	const additional = (input.additionalSourceScopeIds ?? []).map(cleanScopeId);
	if (
		!boundaryScopeId ||
		!sourceScopeId ||
		!STATES.includes(input.state) ||
		!Number.isSafeInteger(input.generation) ||
		input.generation < 1 ||
		additional.some((scopeId) => scopeId == null)
	) {
		throw new Error("project_boundary_migration_record_invalid");
	}
	const sources = [...new Set(additional as string[])].filter((scope) => scope !== sourceScopeId);
	// A boundary cannot be its own source, or one snapshot would cover both directions.
	if ([sourceScopeId, ...sources].includes(boundaryScopeId)) {
		throw new Error("project_boundary_migration_record_invalid");
	}
	return { boundaryScopeId, sourceScopeId, sources: sources.toSorted() };
}

/**
 * Stores the coordinator's record for one boundary. A record with an older
 * generation than the stored one is ignored, so a late read cannot bring a
 * rolled-back migration back. Returns whether the stored record changed.
 */
export function recordProjectBoundaryMigration(
	db: Database,
	input: RecordProjectBoundaryMigrationInput,
): boolean {
	const record = validatedInput(input);
	const now = input.now ?? new Date().toISOString();
	const written = db
		.prepare(
			`INSERT INTO project_boundary_migrations(
			 boundary_scope_id, source_scope_id, additional_source_scope_ids_json, state, generation,
			 created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(boundary_scope_id) DO UPDATE SET
			  source_scope_id = excluded.source_scope_id,
			  additional_source_scope_ids_json = excluded.additional_source_scope_ids_json,
			  state = excluded.state,
			  generation = excluded.generation,
			  updated_at = excluded.updated_at
			 WHERE excluded.generation > project_boundary_migrations.generation`,
		)
		.run(
			record.boundaryScopeId,
			record.sourceScopeId,
			JSON.stringify(record.sources),
			input.state,
			input.generation,
			now,
			now,
		);
	return written.changes > 0;
}

function sourceScopeIds(record: ProjectBoundaryMigrationRecord): string[] {
	return [record.sourceScopeId, ...record.additionalSourceScopeIds];
}

export interface ScopeMove {
	fromScopeId: string;
	toScopeId: string;
}

/**
 * A committed record covers a move into the boundary, and a rolled-back one the
 * move back. A detached record, left by undoing an attach, covers nothing yet:
 * the boundary held memories before the attach, and telling those apart needs a
 * record of what this device itself moved, which it does not keep.
 */
function recordCoversMove(record: ProjectBoundaryMigrationRecord, move: ScopeMove): boolean {
	const sources = sourceScopeIds(record);
	if (record.state === "committed") {
		return move.toScopeId === record.boundaryScopeId && sources.includes(move.fromScopeId);
	}
	if (record.state === "rolled_back") {
		return move.fromScopeId === record.boundaryScopeId && sources.includes(move.toScopeId);
	}
	return false;
}

/** Whether a record says a memory may move from one scope to the other in this direction. */
export function migrationRecordCoversMove(
	records: readonly ProjectBoundaryMigrationRecord[],
	move: ScopeMove,
): boolean {
	return records.some((record) => recordCoversMove(record, move));
}
