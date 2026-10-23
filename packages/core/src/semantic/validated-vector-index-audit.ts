import { randomUUID } from "node:crypto";
import type { Database } from "../db.js";
import { inspectBytes } from "./semantic-ranking.js";
import { requireModel, requireVectorMetadata } from "./validated-vector-index-mutations.js";
import {
	type AuditProgress,
	finishMutation,
	type IndexedRow,
	progress,
	readState,
	refreshStatus,
	requireCatalog,
	requireLimit,
	updateAuditState,
	type VectorCatalog,
} from "./validated-vector-index-state.js";
import {
	type IndexStatement,
	prepareAuditStateStatements,
} from "./validated-vector-index-statements.js";

/** One metadata census per generation; vector blobs are read only by bounded audit batches. */
export function startAudit(
	db: Database,
	options: { knownModels: readonly string[] },
): VectorCatalog {
	for (const model of options.knownModels) requireModel(model);
	return db.transaction(() => {
		readState(db);
		db.exec(`DELETE FROM validated_vector_rows;
			INSERT INTO validated_vector_rows(rowid,memory_id,model,chunk_index,content_hash,audit_state)
			 SELECT rowid,memory_id,model,chunk_index,content_hash,'pending' FROM memory_vectors;
			DELETE FROM validated_vector_models;
			INSERT INTO validated_vector_models(model_null,model_key,model,count)
			 SELECT model IS NULL,COALESCE(model,''),model,COUNT(*) FROM validated_vector_rows GROUP BY model;
			UPDATE validated_vector_versions SET count=0,version=version+1;
			INSERT INTO validated_vector_versions(memory_id,model_null,model_key,model,version,count)
			 SELECT memory_id,model IS NULL,COALESCE(model,''),model,1,COUNT(*)
			 FROM validated_vector_rows GROUP BY memory_id,model
			 ON CONFLICT(memory_id,model_null,model_key) DO UPDATE SET count=excluded.count;`);
		db.prepare(`UPDATE validated_vector_state SET generation_id=?,revision=revision+1,
			audit_started=1,known_models=?,pending_count=(SELECT COUNT(*) FROM validated_vector_rows),
			invalid_count=0 WHERE id=1`).run(
			randomUUID(),
			JSON.stringify([...new Set(options.knownModels)]),
		);
		refreshStatus(db);
		return requireCatalog(db);
	})();
}

function rowRejection(
	statements: { sourceExists: IndexStatement; vector: IndexStatement },
	row: IndexedRow,
	knownModels: Set<string>,
): string | null {
	if (row.model === null || !knownModels.has(row.model)) return "model";
	try {
		requireVectorMetadata({
			memoryId: row.memory_id,
			chunkIndex: row.chunk_index,
			contentHash: row.content_hash,
		});
	} catch {
		return "metadata";
	}
	if (!statements.sourceExists.get(row.memory_id)) return "metadata";
	const vector = statements.vector.get(BigInt(row.rowid)) as { embedding: Buffer } | undefined;
	if (!vector) throw new Error("audit_vector_row_missing_restart_required");
	return inspectBytes(vector.embedding);
}

export function auditBatch(db: Database, options: { limit: number }): AuditProgress {
	requireLimit(options.limit);
	return db
		.transaction(() => {
			const state = readState(db);
			if (!state.audit_started) throw new Error("start_audit_required");
			const knownModels = new Set<string>(JSON.parse(state.known_models));
			const rows = db
				.prepare(`SELECT * FROM validated_vector_rows
			WHERE audit_state='pending' ORDER BY rowid LIMIT ?`)
				.all(options.limit) as IndexedRow[];
			const reads = {
				sourceExists: db.prepare("SELECT 1 FROM memory_items WHERE id=?"),
				vector: db.prepare("SELECT embedding FROM memory_vectors WHERE rowid=?"),
			};
			const auditState = prepareAuditStateStatements(db);
			const diagnostics: AuditProgress["diagnostics"] = [];
			for (const row of rows) {
				const reason = rowRejection(reads, row, knownModels);
				updateAuditState(auditState, row, reason ? "invalid" : "valid", reason);
				if (reason) diagnostics.push({ rowid: row.rowid, reason });
			}
			finishMutation(db);
			return progress(db, rows.length, diagnostics);
		})
		.immediate();
}
