import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";

export type VectorLayout =
	| { kind: "absent" }
	| { kind: "legacy"; physicalName: "memory_vectors"; rowidsName: "memory_vectors_rowids" }
	| { kind: "v1"; physicalName: "memory_vectors_v1"; rowidsName: "memory_vectors_v1_rowids" };

export const VECTOR_V1_DDL = `CREATE VIRTUAL TABLE memory_vectors_v1 USING vec0(
	embedding float[384], memory_id INTEGER, chunk_index INTEGER, content_hash TEXT, model TEXT
);`;

// Keep the format-v1 catalog/version contract shared with the validated index.
export const VALIDATED_VECTOR_SCHEMA_DDL = `
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
 chunk_index INTEGER NOT NULL, content_hash TEXT, audit_state TEXT NOT NULL, reason TEXT);
CREATE INDEX IF NOT EXISTS validated_vector_rows_model_memory
 ON validated_vector_rows(model,memory_id);
CREATE INDEX IF NOT EXISTS validated_vector_rows_state
 ON validated_vector_rows(audit_state,rowid);
CREATE INDEX IF NOT EXISTS validated_vector_rows_model_state_memory
 ON validated_vector_rows(model,audit_state,memory_id);`;

export const VECTOR_COMPATIBILITY_DDL = `
CREATE VIEW memory_vectors AS
 SELECT rowid AS rowid,embedding,memory_id,chunk_index,content_hash,model FROM memory_vectors_v1;
CREATE TRIGGER memory_vectors_reject_insert INSTEAD OF INSERT ON memory_vectors
 BEGIN SELECT RAISE(ABORT,'vector_writer_upgrade_required'); END;
CREATE TRIGGER memory_vectors_reject_update INSTEAD OF UPDATE ON memory_vectors
 BEGIN SELECT RAISE(ABORT,'vector_writer_upgrade_required'); END;
CREATE TRIGGER memory_vectors_compat_delete INSTEAD OF DELETE ON memory_vectors
BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM validated_vector_rows WHERE rowid=OLD.rowid
  AND memory_id IS OLD.memory_id AND model IS OLD.model
  AND chunk_index IS OLD.chunk_index AND content_hash IS OLD.content_hash)
  THEN RAISE(ABORT,'vector_index_metadata_missing') END;
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM validated_vector_models
  WHERE model_null=(OLD.model IS NULL) AND model_key=COALESCE(OLD.model,'') AND count>0)
  OR NOT EXISTS (SELECT 1 FROM validated_vector_versions WHERE memory_id=OLD.memory_id
   AND model_null=(OLD.model IS NULL) AND model_key=COALESCE(OLD.model,'') AND count>0)
  OR NOT EXISTS (SELECT 1 FROM validated_vector_state WHERE id=1 AND writer_version=1)
  THEN RAISE(ABORT,'vector_index_metadata_missing') END;
 UPDATE validated_vector_models SET count=count-1
  WHERE model_null=(OLD.model IS NULL) AND model_key=COALESCE(OLD.model,'');
 UPDATE validated_vector_versions SET count=count-1,version=version+1
  WHERE memory_id=OLD.memory_id AND model_null=(OLD.model IS NULL)
   AND model_key=COALESCE(OLD.model,'');
 UPDATE validated_vector_state SET revision=revision+1,
  pending_count=pending_count-(SELECT audit_state='pending' FROM validated_vector_rows WHERE rowid=OLD.rowid),
  invalid_count=invalid_count-(SELECT audit_state='invalid' FROM validated_vector_rows WHERE rowid=OLD.rowid)
  WHERE id=1;
 DELETE FROM validated_vector_rows WHERE rowid=OLD.rowid;
 DELETE FROM memory_vectors_v1 WHERE rowid=OLD.rowid;
 UPDATE validated_vector_state SET status=CASE
  WHEN audit_started=0 OR pending_count>0 THEN 'building'
  WHEN invalid_count>0 THEN 'needsrepair' ELSE 'ready' END WHERE id=1;
END;`;

const METADATA_TABLES = [
	"validated_vector_state",
	"validated_vector_rows",
	"validated_vector_models",
	"validated_vector_versions",
] as const;

function normalizedDdl(sql: string): string {
	return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

function compatibilityFenceExists(db: Database): boolean {
	const read = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?");
	const names = [
		"memory_vectors",
		"memory_vectors_reject_insert",
		"memory_vectors_reject_update",
		"memory_vectors_compat_delete",
	];
	const definitions = VECTOR_COMPATIBILITY_DDL.trim().split(/(?=CREATE (?:VIEW|TRIGGER) )/);
	return names.every((name, index) => {
		const row = read.get(name) as { sql: string } | undefined;
		return row !== undefined && normalizedDdl(row.sql) === normalizedDdl(definitions[index] ?? "");
	});
}

/** Only return identifiers selected from this fixed set, never caller SQL. */
export function resolveVectorLayout(db: Database): VectorLayout {
	const objects = db
		.prepare(
			"SELECT name,type FROM sqlite_schema WHERE name IN ('memory_vectors','memory_vectors_v1','memory_vectors_v1_rowids')",
		)
		.all() as { name: string; type: string }[];
	const legacy = objects.find((object) => object.name === "memory_vectors");
	if (legacy?.type === "table") {
		if (objects.some((object) => object.name === "memory_vectors_v1"))
			throw new Error("vector_layout_inconsistent");
		return { kind: "legacy", physicalName: "memory_vectors", rowidsName: "memory_vectors_rowids" };
	}
	if (!objects.length) return { kind: "absent" };
	const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?");
	if (
		legacy?.type !== "view" ||
		!objects.some((object) => object.name === "memory_vectors_v1" && object.type === "table") ||
		!objects.some((object) => object.name === "memory_vectors_v1_rowids") ||
		!METADATA_TABLES.every((name) => exists.get(name))
	) {
		throw new Error("vector_layout_inconsistent");
	}
	const state = db.prepare("SELECT writer_version FROM validated_vector_state WHERE id=1").get() as
		| { writer_version: number }
		| undefined;
	if (state?.writer_version !== 1) throw new Error("validated_index_format_required");
	if (!compatibilityFenceExists(db)) throw new Error("vector_layout_writer_fence_missing");
	return { kind: "v1", physicalName: "memory_vectors_v1", rowidsName: "memory_vectors_v1_rowids" };
}

export function vectorStoreExists(db: Database): boolean {
	try {
		return resolveVectorLayout(db).kind !== "absent";
	} catch {
		return false;
	}
}

/** Fresh stores never create the legacy writable name. No imports from db/bootstrap. */
export function createEmptyVectorLayout(db: Database): void {
	db.transaction(() => {
		db.exec(VECTOR_V1_DDL);
		db.exec(VALIDATED_VECTOR_SCHEMA_DDL);
		db.prepare(`INSERT INTO validated_vector_state
		 (id,generation_id,revision,writer_version,status,audit_started) VALUES(1,?,0,1,'ready',1)`).run(
			randomUUID(),
		);
		db.exec(VECTOR_COMPATIBILITY_DDL);
	}).immediate();
}
