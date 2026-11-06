import type { Database } from "better-sqlite3";

const REFERENCE_TABLES = [
	{
		name: "memory_file_refs",
		columns: ["memory_id", "file_path", "relation"],
		ddl: `CREATE TABLE IF NOT EXISTS memory_file_refs (
			memory_id INTEGER NOT NULL,
			file_path TEXT NOT NULL,
			relation TEXT NOT NULL CHECK(relation IN ('read', 'modified')),
			PRIMARY KEY (memory_id, file_path, relation),
			FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
		)`,
		index: "idx_memory_file_refs_path",
		indexDdl: "CREATE INDEX IF NOT EXISTS idx_memory_file_refs_path ON memory_file_refs(file_path)",
	},
	{
		name: "memory_concept_refs",
		columns: ["memory_id", "concept"],
		ddl: `CREATE TABLE IF NOT EXISTS memory_concept_refs (
			memory_id INTEGER NOT NULL,
			concept TEXT NOT NULL,
			PRIMARY KEY (memory_id, concept),
			FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
		)`,
		index: "idx_memory_concept_refs_concept",
		indexDdl:
			"CREATE INDEX IF NOT EXISTS idx_memory_concept_refs_concept ON memory_concept_refs(concept)",
	},
] as const;

function validateExistingReferenceTables(db: Database): Set<string> {
	const existing = new Set<string>();
	for (const table of REFERENCE_TABLES) {
		const object = db
			.prepare("SELECT type FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')")
			.get(table.name) as { type: string } | undefined;
		if (!object) continue;
		if (object.type !== "table") {
			throw new Error(`memory_reference_schema_incompatible:${table.name}:expected_table`);
		}
		const columns = db.prepare("SELECT name FROM pragma_table_info(?)").all(table.name) as Array<{
			name: string;
		}>;
		const missing = table.columns.filter((name) => !columns.some((column) => column.name === name));
		if (missing.length > 0) {
			throw new Error(
				`memory_reference_schema_incompatible:${missing.map((name) => `${table.name}.${name}`).join(",")}`,
			);
		}
		existing.add(table.name);
	}
	return existing;
}

function ensureReferenceLookupIndexes(db: Database): void {
	for (const table of REFERENCE_TABLES) {
		try {
			const index = db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
				.get(table.index);
			if (!index) db.exec(table.indexDdl);
		} catch {
			// Lookup indexes improve performance but are not required for reference writes.
		}
	}
}

export function ensureMemoryReferenceSchema(db: Database): void {
	// Validate both existing tables before any repair so malformed schemas remain untouched.
	const existing = validateExistingReferenceTables(db);
	for (const table of REFERENCE_TABLES) {
		if (!existing.has(table.name)) db.exec(table.ddl);
	}
	ensureReferenceLookupIndexes(db);
}
