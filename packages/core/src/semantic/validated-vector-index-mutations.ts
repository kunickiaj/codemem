import type { Database } from "../db.js";
import { type VectorRowInput, vectorBytes } from "./semantic-ranking.js";
import {
	changeCounts,
	finishMutation,
	type IndexedRow,
	readState,
	requireGenerationModel,
	requireWriter,
	type VectorCatalog,
} from "./validated-vector-index-state.js";
import {
	type IndexStatement,
	type InsertStatements,
	prepareCountStatements,
	prepareInsertStatements,
	prepareRemoveStatements,
	type RemoveStatements,
} from "./validated-vector-index-statements.js";

interface MemoryModelStatements {
	rows: IndexStatement;
	remove: RemoveStatements;
}

export interface ValidatedBatch {
	writerVersion: 1;
	expectedModel: string;
	model: string;
	expectedCount: number;
	mode: "append" | "replace-memory-model";
	rows: readonly VectorRowInput[];
}

export function requireModel(model: string): void {
	if (typeof model !== "string" || !model.trim()) throw new TypeError("vector_model_required");
}

export function requireVectorMetadata(row: Omit<VectorRowInput, "vector">): void {
	if (
		!Number.isSafeInteger(row.memoryId) ||
		row.memoryId <= 0 ||
		!Number.isSafeInteger(row.chunkIndex) ||
		row.chunkIndex < 0 ||
		typeof row.contentHash !== "string" ||
		!row.contentHash.trim()
	) {
		throw new TypeError("invalid_vector_metadata");
	}
}

export function removeRow(statements: RemoveStatements, row: IndexedRow): void {
	statements.deleteVector.run(BigInt(row.rowid));
	statements.deleteIndexedRow.run(row.rowid);
	changeCounts(statements.counts, row.memory_id, row.model, -1);
	statements.decrementAuditCounts.run(
		Number(row.audit_state === "pending"),
		Number(row.audit_state === "invalid"),
	);
}

export function insertRow(
	statements: InsertStatements,
	row: Omit<VectorRowInput, "vector">,
	model: string,
	bytes: Buffer,
): void {
	const result = statements.insertVector.run(
		bytes,
		BigInt(row.memoryId),
		BigInt(row.chunkIndex),
		row.contentHash,
		model,
	);
	const rowid = Number(result.lastInsertRowid);
	if (!Number.isSafeInteger(rowid)) throw new RangeError("unsafe_vector_rowid");
	statements.insertIndexedRow.run(rowid, row.memoryId, model, row.chunkIndex, row.contentHash);
	changeCounts(statements.counts, row.memoryId, model, 1);
}

function removeMemoryModel(
	statements: MemoryModelStatements,
	memoryId: number,
	model: string | null,
): void {
	const rows = statements.rows.all(model, memoryId) as IndexedRow[];
	for (const row of rows) removeRow(statements.remove, row);
}

export function writeValidatedBatch(db: Database, batch: ValidatedBatch): VectorCatalog {
	requireWriter(batch.writerVersion);
	requireModel(batch.model);
	if (batch.expectedModel !== batch.model) throw new TypeError("vector_model_mismatch");
	if (!Number.isSafeInteger(batch.expectedCount) || batch.expectedCount !== batch.rows.length) {
		throw new TypeError("vector_count_mismatch");
	}
	if (batch.mode !== "append" && batch.mode !== "replace-memory-model") {
		throw new TypeError("invalid_vector_write_mode");
	}
	const prepared = batch.rows.map((row) => {
		requireVectorMetadata(row);
		return { ...row, bytes: vectorBytes(row.vector) };
	});
	return db.transaction(() => {
		const state = readState(db);
		requireGenerationModel(state, batch.model);
		if (batch.mode === "replace-memory-model" && !state.audit_started) {
			throw new Error("start_audit_census_required");
		}
		const counts = prepareCountStatements(db);
		const insert = prepareInsertStatements(db, counts);
		const sourceExists = db.prepare("SELECT 1 FROM memory_items WHERE id=?");
		let removal: MemoryModelStatements | undefined;
		if (batch.mode === "replace-memory-model") {
			removal = {
				rows: db.prepare("SELECT * FROM validated_vector_rows WHERE model IS ? AND memory_id=?"),
				remove: prepareRemoveStatements(db, counts),
			};
		}
		const ids = new Set(prepared.map((row) => row.memoryId));
		for (const id of ids) {
			if (!sourceExists.get(id)) {
				throw new Error("vector_source_memory_missing");
			}
			if (removal) removeMemoryModel(removal, id, batch.model);
		}
		for (const row of prepared) insertRow(insert, row, batch.model, row.bytes);
		return finishMutation(db);
	})();
}

export function deleteValidatedVectors(
	db: Database,
	options: { writerVersion: 1; memoryId: number; model: string | null },
): VectorCatalog {
	requireWriter(options.writerVersion);
	if (!Number.isSafeInteger(options.memoryId) || options.memoryId < 1)
		throw new TypeError("invalid_memory_id");
	if (options.model !== null) requireModel(options.model);
	return db.transaction(() => {
		if (!readState(db).audit_started) throw new Error("start_audit_census_required");
		removeMemoryModel(
			{
				rows: db.prepare("SELECT * FROM validated_vector_rows WHERE model IS ? AND memory_id=?"),
				remove: prepareRemoveStatements(db, prepareCountStatements(db)),
			},
			options.memoryId,
			options.model,
		);
		return finishMutation(db);
	})();
}
