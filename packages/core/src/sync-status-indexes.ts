import type { Database } from "better-sqlite3";

const STATUS_INDEXES = [
	{
		name: "idx_memory_items_embeddable_active",
		// Match the count predicate exactly. Index active so the planner can use
		// its equality constraint without ANALYZE, rather than prefer a table lookup.
		ddl: `CREATE INDEX IF NOT EXISTS idx_memory_items_embeddable_active
			ON memory_items(active)
			WHERE active = 1
				AND TRIM(COALESCE(title, '') || COALESCE(body_text, '')) != ''`,
	},
	{
		name: "idx_replication_ops_type_device_created",
		ddl: `CREATE INDEX IF NOT EXISTS idx_replication_ops_type_device_created
			ON replication_ops(op_type, device_id, created_at)`,
	},
];

/** Optional access paths for exact status counts, maintained by native SQLite writers. */
export function ensureSyncStatusIndexes(db: Database): void {
	if (db.readonly) return;
	for (const index of STATUS_INDEXES) {
		try {
			if (
				db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index.name)
			)
				continue;
			db.exec(index.ddl);
		} catch {
			// Locked, query-only and partial legacy databases retain their original
			// reads and retry installation on the next writable compatibility check.
		}
	}
}
