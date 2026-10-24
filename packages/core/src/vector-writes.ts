/** Supported vector mutations. Callers own the synchronous writer transaction. */
import { type Database, tableExists } from "./db.js";
import { type VectorRowInput, vectorBytes } from "./semantic/semantic-ranking.js";
import { startAudit } from "./semantic/validated-vector-index-audit.js";
import {
	insertRow,
	removeRow,
	requireModel,
	requireVectorMetadata,
} from "./semantic/validated-vector-index-mutations.js";
import {
	finishMutation,
	type IndexedRow,
	invalidateValidatedIndex,
	readState,
} from "./semantic/validated-vector-index-state.js";
import {
	type IndexStatement,
	prepareCountStatements,
	type RemoveStatements,
} from "./semantic/validated-vector-index-statements.js";
import { resolveVectorLayout, type VectorLayout } from "./vector-layout.js";

export interface VectorWriteBatch {
	insert?: { model: string; rows: readonly VectorRowInput[]; expectedCount: number };
	deleteRowIds?: readonly number[];
	deleteMemoryIds?: readonly number[];
	signal?: AbortSignal;
}

interface WriteStatements {
	db: Database;
	layout?: VectorLayout;
	deleteVector?: IndexStatement;
	selectVector?: IndexStatement;
	insertVector?: IndexStatement;
	selectMemoryRows?: IndexStatement;
	metadata?: ReturnType<typeof prepareMetadata>;
}

/** Statement lifetime is one maintenance operation, not one row or connection.
 * Preparing the operation is harmless outside a transaction; every batch requires one.
 */
export function prepareVectorWrites(db: Database) {
	const statements: WriteStatements = { db };
	return (batch: VectorWriteBatch) => writeVectorBatch(statements, batch);
}

/** Explicit model transition: rotate the generation and census old rows as pending.
 * The lifecycle driver audits those rows later; declaring a model never validates them.
 */
export function ensureVectorWriteModel(db: Database, model: string): boolean {
	if (!db.inTransaction) throw new Error("vector_write_transaction_required");
	requireModel(model);
	if (!tableExists(db, "validated_vector_state")) return false;
	const state = readState(db);
	const knownModels: unknown = JSON.parse(state.known_models);
	if (!Array.isArray(knownModels) || !knownModels.every((entry) => typeof entry === "string"))
		throw new Error("invalid_generation_models");
	if (state.audit_started && knownModels.includes(model)) return false;
	startAudit(db, { knownModels: [...new Set([...knownModels, model])] });
	return true;
}

function writeVectorBatch(statements: WriteStatements, batch: VectorWriteBatch) {
	const { db } = statements;
	if (!db.inTransaction) throw new Error("vector_write_transaction_required");
	const prepared = prepareInsertBatch(batch.insert);
	const empty = { deleted: 0, deletedRowIds: [] as number[], inserted: 0 };
	if (!prepared.length && !batch.deleteRowIds?.length && !batch.deleteMemoryIds?.length)
		return empty;
	const layout = resolveVectorLayout(db);
	if (layout.kind === "absent") {
		if (prepared.length) throw new Error("vector_table_required");
		return empty;
	}
	resetLayoutStatements(statements, layout);
	const state = prepareCatalogMutation(statements, batch, prepared);
	const rowIds = collectDeleteRowIds(statements, batch);
	const result = deleteRows(statements, rowIds, {
		rebuild: state !== null && !state.audit_started,
		signal: batch.signal,
	});
	insertRows(statements, prepared, { indexed: state !== null && !result.rebuild });
	if (layout.kind === "legacy") finishLegacyMutation(db, state, result, prepared.length);
	return {
		deleted: result.deletedRowIds.length,
		deletedRowIds: result.deletedRowIds,
		inserted: prepared.length,
	};
}

function finishLegacyMutation(
	db: Database,
	state: ReturnType<typeof readState> | null,
	result: ReturnType<typeof deleteRows>,
	inserted: number,
): void {
	if (!state) return;
	if (!result.deletedRowIds.length && !inserted && !(state.audit_started && result.rebuild)) return;
	if (result.rebuild) invalidateValidatedIndex(db);
	else finishMutation(db);
}

function resetLayoutStatements(statements: WriteStatements, layout: VectorLayout): void {
	if (statements.layout?.kind === layout.kind) return;
	statements.layout = layout;
	statements.deleteVector = undefined;
	statements.selectVector = undefined;
	statements.insertVector = undefined;
	statements.selectMemoryRows = undefined;
	statements.metadata = undefined;
}

function prepareCatalogMutation(
	statements: WriteStatements,
	batch: VectorWriteBatch,
	rows: ReturnType<typeof prepareInsertBatch>,
) {
	const { db } = statements;
	if (!tableExists(db, "validated_vector_state")) {
		if (statements.layout?.kind === "v1") throw new Error("validated_index_not_initialized");
		return null;
	}
	const state = readState(db);
	if (batch.insert) requireDeclaredModel(state.known_models, batch.insert.model);
	if (statements.layout?.kind === "v1" && rows.length && !state.audit_started)
		throw new Error("start_audit_census_required");
	statements.metadata ??= prepareMetadata(db, prepareDeleteVector(statements), statements.layout);
	for (const row of rows) {
		if (!statements.metadata.sourceExists.get(row.memoryId))
			throw new Error("vector_source_memory_missing");
	}
	return state;
}

function collectDeleteRowIds(statements: WriteStatements, batch: VectorWriteBatch): Set<number> {
	const ids = new Set(batch.deleteRowIds ?? []);
	if (!batch.deleteMemoryIds?.length) return ids;
	statements.selectMemoryRows ??= statements.db.prepare(`SELECT rowid FROM memory_vectors
		WHERE memory_id IN (SELECT value FROM json_each(?))`);
	for (const row of statements.selectMemoryRows.all(JSON.stringify(batch.deleteMemoryIds)) as {
		rowid: number;
	}[])
		ids.add(row.rowid);
	return ids;
}

function deleteRows(
	statements: WriteStatements,
	rowIds: Set<number>,
	options: { rebuild: boolean; signal?: AbortSignal },
) {
	let rebuild = options.rebuild;
	const deletedRowIds: number[] = [];
	for (const rowid of rowIds) {
		if (options.signal?.aborted) break;
		const result = deleteRow(statements, rowid, { rebuild });
		rebuild = result.rebuild;
		if (result.deleted) deletedRowIds.push(rowid);
	}
	return { rebuild, deletedRowIds };
}

function deleteRow(statements: WriteStatements, rowid: number, options: { rebuild: boolean }) {
	if (!Number.isSafeInteger(rowid)) throw new RangeError("unsafe_vector_rowid");
	const deleteVector = prepareDeleteVector(statements);
	if (statements.layout?.kind === "v1") {
		statements.selectVector ??= statements.db.prepare(
			"SELECT rowid FROM memory_vectors WHERE rowid = ?",
		);
		const exists = Boolean(statements.selectVector.get(BigInt(rowid)));
		if (exists) deleteVector.run(BigInt(rowid));
		return { deleted: exists, rebuild: false };
	}
	const metadata = statements.metadata;
	if (!metadata) return { deleted: deleteVector.run(BigInt(rowid)).changes > 0, rebuild: false };
	const row = metadata.selectRow.get(rowid) as IndexedRow | undefined;
	const physical = metadata.selectPhysical.get(BigInt(rowid)) as IndexedRow | undefined;
	const rebuild = options.rebuild || !sameIndexedMetadata(row, physical);
	if (row && physical && !rebuild) {
		removeRow(metadata.remove, row);
		return { deleted: true, rebuild };
	}
	return { deleted: deleteVector.run(BigInt(rowid)).changes > 0, rebuild };
}

function insertRows(
	statements: WriteStatements,
	rows: ReturnType<typeof prepareInsertBatch>,
	options: { indexed: boolean },
) {
	for (const row of rows) {
		if (options.indexed && statements.metadata) {
			insertRow(statements.metadata.insert, row, row.model, row.bytes);
			continue;
		}
		statements.insertVector ??= statements.db.prepare(`INSERT INTO memory_vectors
			(embedding,memory_id,chunk_index,content_hash,model) VALUES(?,?,?,?,?)`);
		statements.insertVector.run(
			row.bytes,
			BigInt(row.memoryId),
			BigInt(row.chunkIndex),
			row.contentHash,
			row.model,
		);
	}
	if (statements.layout?.kind === "v1" && rows.length) finishMutation(statements.db);
}

function prepareDeleteVector(statements: WriteStatements): IndexStatement {
	statements.deleteVector ??= statements.db.prepare("DELETE FROM memory_vectors WHERE rowid = ?");
	return statements.deleteVector;
}

function sameIndexedMetadata(
	indexed: IndexedRow | undefined,
	physical: IndexedRow | undefined,
): boolean {
	if (!indexed || !physical) return indexed === physical;
	return (
		indexed.memory_id === physical.memory_id &&
		indexed.model === physical.model &&
		indexed.chunk_index === physical.chunk_index &&
		indexed.content_hash === physical.content_hash
	);
}

function prepareInsertBatch(batch: VectorWriteBatch["insert"]) {
	if (!batch) return [];
	requireModel(batch.model);
	if (!Number.isSafeInteger(batch.expectedCount) || batch.expectedCount !== batch.rows.length)
		throw new TypeError("vector_count_mismatch");
	return batch.rows.map((row) => {
		requireVectorMetadata(row);
		return { ...row, model: batch.model, bytes: vectorBytes(row.vector) };
	});
}

function requireDeclaredModel(knownModels: string, model: string): void {
	const models: unknown = JSON.parse(knownModels);
	if (!Array.isArray(models) || !models.includes(model))
		throw new TypeError("vector_model_not_declared_in_generation");
}

function prepareMetadata(
	db: Database,
	deleteVector: IndexStatement,
	layout: WriteStatements["layout"],
) {
	const counts = prepareCountStatements(db);
	const remove: RemoveStatements = {
		counts,
		deleteVector,
		deleteIndexedRow: db.prepare("DELETE FROM validated_vector_rows WHERE rowid=?"),
		decrementAuditCounts:
			db.prepare(`UPDATE validated_vector_state SET pending_count=pending_count-?,
			invalid_count=invalid_count-? WHERE id=1`),
	};
	return {
		remove,
		insert: {
			counts,
			insertVector: preparePhysicalInsert(db, layout),
			insertIndexedRow: db.prepare(`INSERT INTO validated_vector_rows
				(rowid,memory_id,model,chunk_index,content_hash,audit_state) VALUES(?,?,?,?,?,'valid')`),
		},
		selectRow: db.prepare("SELECT * FROM validated_vector_rows WHERE rowid=?"),
		selectPhysical: db.prepare(
			"SELECT memory_id,model,chunk_index,content_hash FROM memory_vectors WHERE rowid=?",
		),
		sourceExists: db.prepare("SELECT 1 FROM memory_items WHERE id=?"),
	};
}

function preparePhysicalInsert(db: Database, layout: WriteStatements["layout"]): IndexStatement {
	if (layout?.kind === "v1")
		return db.prepare(`INSERT INTO memory_vectors_v1
		(embedding,memory_id,chunk_index,content_hash,model) VALUES(?,?,?,?,?)`);
	return db.prepare(`INSERT INTO memory_vectors
		(embedding,memory_id,chunk_index,content_hash,model) VALUES(?,?,?,?,?)`);
}
