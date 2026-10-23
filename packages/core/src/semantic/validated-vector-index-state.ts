/** Persisted format-v1 metadata. Raw/older writers require invalidation and rebuild. */
import { randomUUID } from "node:crypto";
import { type Database, tableExists } from "../db.js";
import type { MaintenanceJobSnapshot } from "../maintenance-jobs.js";
import { readModelJob } from "./semantic-ranking.js";
import type { AuditStateStatements, CountStatements } from "./validated-vector-index-statements.js";

export interface VectorCatalog {
	generationId: string;
	revision: number;
	status: "building" | "needsrepair" | "ready";
	writerVersion: 1;
	models: { model: string | null; count: number }[];
	migration: Pick<MaintenanceJobSnapshot, "status" | "metadata"> | null;
}
export interface CandidateVersion {
	memoryId: number;
	model: string;
	version: number;
	count: number;
}
export interface State {
	generation_id: string;
	revision: number;
	status: VectorCatalog["status"];
	writer_version: number;
	audit_started: number;
	known_models: string;
	pending_count: number;
	invalid_count: number;
}
export interface IndexedRow {
	rowid: number;
	memory_id: number;
	model: string | null;
	chunk_index: number;
	content_hash: string;
	audit_state: "pending" | "valid" | "invalid";
	reason: string | null;
}
export interface AuditProgress {
	catalog: VectorCatalog;
	checked: number;
	remaining: number;
	invalid: number;
	diagnostics: {
		rowid: number;
		reason: string;
		memoryId?: number;
		model?: string | null;
		action?: "pruned";
	}[];
}

export function snapshot<T>(db: Database, read: () => T): T {
	if (db.inTransaction) return read();
	return db.transaction(read)();
}

export function readState(db: Database): State {
	const state = db.prepare("SELECT * FROM validated_vector_state WHERE id = 1").get() as State;
	if (state?.writer_version !== 1) throw new Error("validated_index_format_required");
	return state;
}

export function readCatalog(db: Database): VectorCatalog | null {
	return snapshot(db, () => {
		if (!tableExists(db, "validated_vector_state")) return null;
		const state = readState(db);
		const models = db
			.prepare(`SELECT model, count FROM validated_vector_models
			WHERE count > 0 ORDER BY model_null, model_key`)
			.all() as VectorCatalog["models"];
		return {
			generationId: state.generation_id,
			revision: state.revision,
			status: state.status,
			writerVersion: 1,
			models,
			migration: readModelJob(db),
		};
	});
}

export function requireCatalog(db: Database): VectorCatalog {
	const catalog = readCatalog(db);
	if (!catalog) throw new Error("validated_index_not_initialized");
	return catalog;
}

/** Completed audits can supply valid evidence while other derived rows await repair. */
export function isSearchableVectorCatalog(
	db: Database,
	catalog: VectorCatalog | null,
): catalog is VectorCatalog {
	if (catalog?.writerVersion !== 1) return false;
	if (catalog.status === "ready") return catalog.models.some(({ count }) => count > 0);
	if (catalog.status !== "needsrepair") return false;
	return Boolean(
		db.prepare("SELECT 1 FROM validated_vector_rows WHERE audit_state='valid' LIMIT 1").get(),
	);
}

export function readSearchableModelLabels(
	db: Database,
	catalog: VectorCatalog,
): Array<string | null> {
	const labels = catalog.models.map(({ model }) => model);
	if (catalog.status !== "needsrepair") return labels;
	const valid = db.prepare(
		"SELECT 1 FROM validated_vector_rows WHERE model IS ? AND audit_state='valid' LIMIT 1",
	);
	return labels.filter((model) => Boolean(valid.get(model)));
}

export function requireWriter(version: number): void {
	if (version !== 1) throw new TypeError("validated_writer_version_required");
}

export function requireGenerationModel(state: State, model: string): void {
	if (!state.audit_started) return;
	const knownModels: unknown = JSON.parse(state.known_models);
	if (!Array.isArray(knownModels) || !knownModels.includes(model)) {
		throw new TypeError("vector_model_not_declared_in_generation");
	}
}

export function initializeValidatedIndex(
	db: Database,
	options: { allWritersUpgraded: true; writerVersion: 1 },
): VectorCatalog {
	if (options.allWritersUpgraded !== true) throw new TypeError("all_writers_must_be_upgraded");
	requireWriter(options.writerVersion);
	return db.transaction(() => {
		db.exec(`
			CREATE TABLE IF NOT EXISTS validated_vector_state (
			 id INTEGER PRIMARY KEY CHECK(id=1), generation_id TEXT NOT NULL,
			 revision INTEGER NOT NULL, writer_version INTEGER NOT NULL,
			 status TEXT NOT NULL, audit_started INTEGER NOT NULL DEFAULT 0,
			 known_models TEXT NOT NULL DEFAULT '[]', pending_count INTEGER NOT NULL DEFAULT 0,
			 invalid_count INTEGER NOT NULL DEFAULT 0);
			CREATE TABLE IF NOT EXISTS validated_vector_models (
			 model_null INTEGER NOT NULL, model_key TEXT NOT NULL, model TEXT,
			 count INTEGER NOT NULL CHECK(count>=0), PRIMARY KEY(model_null,model_key));
			CREATE TABLE IF NOT EXISTS validated_vector_versions (
			 memory_id INTEGER NOT NULL, model_null INTEGER NOT NULL, model_key TEXT NOT NULL,
			 model TEXT, version INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count>=0),
			 PRIMARY KEY(memory_id,model_null,model_key));
			CREATE TABLE IF NOT EXISTS validated_vector_rows (
			 rowid INTEGER PRIMARY KEY, memory_id INTEGER NOT NULL, model TEXT,
			 chunk_index INTEGER NOT NULL, content_hash TEXT, audit_state TEXT NOT NULL,
			 reason TEXT);
			CREATE INDEX IF NOT EXISTS validated_vector_rows_model_memory
			 ON validated_vector_rows(model,memory_id);
			CREATE INDEX IF NOT EXISTS validated_vector_rows_state
			 ON validated_vector_rows(audit_state,rowid);
			CREATE INDEX IF NOT EXISTS validated_vector_rows_model_state_memory
			 ON validated_vector_rows(model,audit_state,memory_id);
		`);
		db.prepare(`INSERT OR IGNORE INTO validated_vector_state
			(id,generation_id,revision,writer_version,status) VALUES(1,?,0,1,'building')`).run(
			randomUUID(),
		);
		return requireCatalog(db);
	})();
}

export function invalidateValidatedIndex(db: Database): VectorCatalog {
	return db.transaction(() => {
		readState(db);
		db.prepare(`UPDATE validated_vector_state SET generation_id=?, revision=revision+1,
			status='building',audit_started=0 WHERE id=1`).run(randomUUID());
		return requireCatalog(db);
	})();
}

export function refreshStatus(db: Database): void {
	db.exec(`UPDATE validated_vector_state SET status=CASE
		WHEN audit_started=0 OR pending_count>0 THEN 'building'
		WHEN invalid_count>0 THEN 'needsrepair' ELSE 'ready' END WHERE id=1`);
}

export function finishMutation(db: Database): VectorCatalog {
	db.exec("UPDATE validated_vector_state SET revision=revision+1 WHERE id=1");
	refreshStatus(db);
	return requireCatalog(db);
}

export function changeCounts(
	statements: CountStatements,
	memoryId: number,
	model: string | null,
	delta: number,
): void {
	const nullKey = Number(model === null);
	const key = model ?? "";
	statements.insertModel.run(nullKey, key, model);
	statements.updateModelCount.run(delta, nullKey, key);
	statements.insertVersion.run(memoryId, nullKey, key, model);
	statements.updateVersionCount.run(delta, memoryId, nullKey, key);
}

export function updateAuditState(
	statements: AuditStateStatements,
	row: IndexedRow,
	state: IndexedRow["audit_state"],
	reason: string | null = null,
): void {
	statements.updateRowState.run(state, reason, row.rowid);
	const pending = Number(state === "pending") - Number(row.audit_state === "pending");
	const invalid = Number(state === "invalid") - Number(row.audit_state === "invalid");
	statements.updateAuditCounts.run(pending, invalid);
}

export function progress(
	db: Database,
	checked = 0,
	diagnostics: AuditProgress["diagnostics"] = [],
): AuditProgress {
	const state = readState(db);
	return {
		catalog: requireCatalog(db),
		checked,
		remaining: state.pending_count,
		invalid: state.invalid_count,
		diagnostics,
	};
}

export function requireLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
		throw new RangeError("audit_limit_must_be_1_to_1000");
	}
}

export function readCandidateVersions(
	db: Database,
	options: { memoryIds: readonly number[]; models: readonly string[] },
): CandidateVersion[] {
	return snapshot(db, () => {
		if (!tableExists(db, "validated_vector_state")) return [];
		readState(db);
		return db
			.prepare(`SELECT memory_id AS memoryId,model,version,count FROM validated_vector_versions
			WHERE memory_id IN (SELECT value FROM json_each(?)) AND model_null=0
			AND model_key IN (SELECT value FROM json_each(?)) ORDER BY memory_id,model_key`)
			.all(JSON.stringify(options.memoryIds), JSON.stringify(options.models)) as CandidateVersion[];
	});
}
