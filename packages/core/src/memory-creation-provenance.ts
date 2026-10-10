import type { Database } from "./db.js";
import { getVerifiedMemorySource } from "./memory-source-identity.js";

// Actor/workspace aliases and replication clocks may change during local adoption.
// Scope and user-facing content must still match the immutable creation snapshot.
const CREATION_CONTENT_SQL = `json_array(memory_items.kind, memory_items.title,
	memory_items.subtitle, memory_items.body_text, memory_items.confidence,
	memory_items.tags_text, memory_items.visibility, memory_items.workspace_kind,
	memory_items.origin_source, memory_items.trust_state, memory_items.narrative,
	memory_items.facts, memory_items.concepts, memory_items.files_read,
	memory_items.files_modified, memory_items.user_prompt_id, memory_items.prompt_number,
	memory_items.project, memory_items.active, memory_items.deleted_at,
	json_remove(CASE WHEN json_valid(memory_items.metadata_json)
		THEN memory_items.metadata_json ELSE '{}' END, '$.clock_device_id', '$.import_key'))`;

function hasTable(db: Database, name: string): boolean {
	return (
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
		undefined
	);
}

function ensureCreationProvenanceSchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS memory_local_creation_snapshots (
		entity_id TEXT PRIMARY KEY NOT NULL REFERENCES memory_source_bindings(entity_id),
		scope_id TEXT,
		content_json TEXT NOT NULL,
		source_public_key TEXT,
		source_fingerprint TEXT,
		created_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS memory_foreign_revisions (
		entity_id TEXT PRIMARY KEY NOT NULL REFERENCES memory_source_bindings(entity_id),
		write_path TEXT NOT NULL CHECK(write_path IN ('replication', 'bootstrap', 'import')),
		created_at TEXT NOT NULL
	);`);
	for (const table of ["memory_local_creation_snapshots", "memory_foreign_revisions"]) {
		db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
			BEGIN SELECT RAISE(ABORT, 'memory_creation_provenance_immutable'); END;
			CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
			BEGIN SELECT RAISE(ABORT, 'memory_creation_provenance_immutable'); END;
			CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
			WHEN EXISTS (SELECT 1 FROM ${table} WHERE entity_id = NEW.entity_id)
			BEGIN SELECT RAISE(ABORT, 'memory_creation_provenance_immutable'); END;`);
	}
}

/** Only a genuine creation/copy transaction can record the original row. No backfill. */
export function recordLocalCreationSnapshot(db: Database, memoryId: number): void {
	if (!db.inTransaction) throw new Error("memory_source_transaction_required");
	const row = db.prepare("SELECT import_key FROM memory_items WHERE id = ?").get(memoryId) as
		| { import_key: string | null }
		| undefined;
	if (
		!row?.import_key ||
		getVerifiedMemorySource(db, row.import_key)?.evidence !== "local_creation"
	)
		return;
	ensureCreationProvenanceSchema(db);
	let publicKeySql = "NULL";
	let fingerprintSql = "NULL";
	if (hasTable(db, "sync_device")) {
		publicKeySql =
			"(SELECT public_key FROM sync_device WHERE device_id = (SELECT source_device_id FROM memory_source_bindings WHERE entity_id = memory_items.import_key))";
		fingerprintSql =
			"(SELECT fingerprint FROM sync_device WHERE device_id = (SELECT source_device_id FROM memory_source_bindings WHERE entity_id = memory_items.import_key))";
	}
	db.prepare(`INSERT INTO memory_local_creation_snapshots(entity_id, scope_id, content_json, source_public_key, source_fingerprint, created_at)
		SELECT import_key, scope_id, ${CREATION_CONTENT_SQL},
		${publicKeySql}, ${fingerprintSql},
		? FROM memory_items WHERE id = ?`).run(new Date().toISOString(), memoryId);
}

/** The inbound write path, not peer-supplied clocks/origins, records permanent negative proof. */
export function recordForeignMemoryRevision(
	db: Database,
	entityId: string,
	writePath: "replication" | "bootstrap" | "import",
): void {
	if (!db.inTransaction) throw new Error("memory_source_transaction_required");
	if (!hasRecordedLocalCreation(db, entityId)) return;
	ensureCreationProvenanceSchema(db);
	if (db.prepare("SELECT 1 FROM memory_foreign_revisions WHERE entity_id = ?").get(entityId))
		return;
	db.prepare(
		"INSERT INTO memory_foreign_revisions(entity_id, write_path, created_at) VALUES (?, ?, ?)",
	).run(entityId, writePath, new Date().toISOString());
}

/** Preservation evidence only: this must not authorize a read or mutation. */
export function hasRecordedLocalCreation(db: Database, entityId: string): boolean {
	return (
		hasTable(db, "memory_source_bindings") &&
		getVerifiedMemorySource(db, entityId)?.evidence === "local_creation"
	);
}

/** Read-only SQL, using primary-key lookups for both creation and negative facts. */
export function matchingLocalCreationClause(db: Database): string | null {
	if (!hasTable(db, "memory_local_creation_snapshots") || !hasTable(db, "memory_foreign_revisions"))
		return null;
	let keyMatchSql = "creation.source_public_key IS NULL";
	if (hasTable(db, "sync_device"))
		keyMatchSql = `(creation.source_public_key IS NULL OR EXISTS (SELECT 1 FROM sync_device creation_device
			WHERE creation_device.device_id = (SELECT source_device_id FROM memory_source_bindings WHERE entity_id = creation.entity_id)
			AND creation_device.public_key = creation.source_public_key
			AND creation_device.fingerprint = creation.source_fingerprint))`;
	return `EXISTS (SELECT 1 FROM memory_local_creation_snapshots creation
		WHERE creation.entity_id = memory_items.import_key
		AND creation.scope_id IS memory_items.scope_id
		AND creation.content_json = ${CREATION_CONTENT_SQL}
		AND ${keyMatchSql}
		AND NOT EXISTS (SELECT 1 FROM memory_foreign_revisions foreign_revision
			WHERE foreign_revision.entity_id = creation.entity_id))`;
}

export function hasMatchingLocalCreation(
	db: Database,
	entityId: string,
	sourceIds: readonly string[],
): boolean {
	if (!sourceIds.length) return false;
	const clause = matchingLocalCreationClause(db);
	if (!clause) return false;
	const binding = getVerifiedMemorySource(db, entityId);
	if (binding?.evidence !== "local_creation" || !sourceIds.includes(binding.sourceDeviceId))
		return false;
	return (
		db.prepare(`SELECT 1 FROM memory_items WHERE import_key = ? AND ${clause}`).get(entityId) !==
		undefined
	);
}
