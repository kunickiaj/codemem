import type { Statement } from "better-sqlite3";
import type { Database } from "../db.js";
import { resolveVectorLayout } from "../vector-layout.js";

export type IndexStatement = Statement<unknown[]>;

export interface CountStatements {
	insertModel: IndexStatement;
	updateModelCount: IndexStatement;
	insertVersion: IndexStatement;
	updateVersionCount: IndexStatement;
}

export interface InsertStatements {
	counts: CountStatements;
	insertVector: IndexStatement;
	insertIndexedRow: IndexStatement;
}

export interface RemoveStatements {
	counts: CountStatements;
	deleteVector: IndexStatement;
	deleteIndexedRow: IndexStatement;
	decrementAuditCounts: IndexStatement;
}

export interface AuditStateStatements {
	updateRowState: IndexStatement;
	updateAuditCounts: IndexStatement;
}

/** These sets belong to one synchronous operation, never a connection-wide cache. */
export function prepareCountStatements(db: Database): CountStatements {
	return {
		insertModel:
			db.prepare(`INSERT OR IGNORE INTO validated_vector_models(model_null,model_key,model,count)
		VALUES(?,?,?,0)`),
		updateModelCount: db.prepare(
			`UPDATE validated_vector_models SET count=count+? WHERE model_null=? AND model_key=?`,
		),
		insertVersion:
			db.prepare(`INSERT OR IGNORE INTO validated_vector_versions(memory_id,model_null,model_key,model,version,count)
		VALUES(?,?,?,?,0,0)`),
		updateVersionCount:
			db.prepare(`UPDATE validated_vector_versions SET version=version+1,count=count+?
		WHERE memory_id=? AND model_null=? AND model_key=?`),
	};
}

export function prepareInsertStatements(db: Database, counts: CountStatements): InsertStatements {
	const table = physicalVectorTable(db);
	return {
		counts,
		insertVector: db.prepare(`INSERT INTO ${table}
		(embedding,memory_id,chunk_index,content_hash,model) VALUES(?,?,?,?,?)`),
		insertIndexedRow: db.prepare(`INSERT INTO validated_vector_rows
		(rowid,memory_id,model,chunk_index,content_hash,audit_state) VALUES(?,?,?,?,?,'valid')`),
	};
}

export function prepareRemoveStatements(db: Database, counts: CountStatements): RemoveStatements {
	const table = physicalVectorTable(db);
	return {
		counts,
		deleteVector: db.prepare(`DELETE FROM ${table} WHERE rowid=?`),
		deleteIndexedRow: db.prepare("DELETE FROM validated_vector_rows WHERE rowid=?"),
		decrementAuditCounts:
			db.prepare(`UPDATE validated_vector_state SET pending_count=pending_count-?,
		invalid_count=invalid_count-? WHERE id=1`),
	};
}

function physicalVectorTable(db: Database): "memory_vectors" | "memory_vectors_v1" {
	const layout = resolveVectorLayout(db);
	if (layout.kind === "absent") throw new Error("vector_table_required");
	// The v1 compatibility view owns legacy-delete bookkeeping and rejects inserts.
	return layout.physicalName;
}

export function prepareAuditStateStatements(db: Database): AuditStateStatements {
	return {
		updateRowState: db.prepare(
			"UPDATE validated_vector_rows SET audit_state=?,reason=? WHERE rowid=?",
		),
		updateAuditCounts: db.prepare(`UPDATE validated_vector_state SET pending_count=pending_count+?,
		invalid_count=invalid_count+? WHERE id=1`),
	};
}
