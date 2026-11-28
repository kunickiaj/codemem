import type { Database } from "better-sqlite3";

// These names are the on-disk format. Never expose permanent views or
// triggers under a released name that route reads or writes to these tables.
export const transitionedTables = {
	memory_items: "project_memory_items",
	memory_fts: "project_memory_fts",
	replication_ops: "project_replication_ops",
	sync_device: "project_sync_device",
} as const;

export type TransitionedTable = keyof typeof transitionedTables;

/** A partially converted store must not be treated as an ordinary store. */
export function contentStorageShape(db: Database): "legacy" | "transitioned" {
	const rows = db
		.prepare(`SELECT name, type FROM main.sqlite_schema
		WHERE name IN ('memory_items','memory_fts','sync_device','replication_ops',
		'project_memory_items','project_memory_fts','project_sync_device','project_replication_ops')`)
		.all() as { name: string; type: string }[];
	const names = new Map(rows.map(({ name, type }) => [name, type]));
	if (!Object.values(transitionedTables).some((name) => names.has(name))) return "legacy";
	if (
		Object.entries(transitionedTables).every(
			([old, next]) => !names.has(old) && names.get(next) === "table",
		)
	)
		return "transitioned";
	throw new Error("Incomplete or conflicting Project storage format.");
}

/** Caller owns the offline window and commits proof preparation in this transaction. */
export function installTransitionedTables(db: Database): void {
	if (!db.inTransaction || db.pragma("locking_mode", { simple: true }) !== "exclusive")
		throw new Error("Project storage conversion requires the exclusive maintenance transaction.");
	if (contentStorageShape(db) === "transitioned") return;
	if (db.pragma("legacy_alter_table", { simple: true }) !== 0)
		throw new Error("Project storage conversion requires SQLite reference updates.");

	// FTS5 stores the external-content table name as a module argument.
	// RENAME updates ordinary foreign keys but does not retarget that argument.
	db.exec(`DROP TRIGGER memory_items_ai;
		DROP TRIGGER memory_items_au;
		DROP TRIGGER memory_items_ad;
		DROP TABLE memory_fts;
		ALTER TABLE memory_items RENAME TO project_memory_items;
		ALTER TABLE replication_ops RENAME TO project_replication_ops;
		ALTER TABLE sync_device RENAME TO project_sync_device;
		CREATE VIRTUAL TABLE project_memory_fts USING fts5(
			title, body_text, tags_text, content='project_memory_items', content_rowid='id'
		);
		INSERT INTO project_memory_fts(project_memory_fts) VALUES('rebuild');
		CREATE TRIGGER project_memory_items_ai AFTER INSERT ON project_memory_items BEGIN
			INSERT INTO project_memory_fts(rowid,title,body_text,tags_text)
			VALUES(new.id,new.title,new.body_text,new.tags_text);
		END;
		CREATE TRIGGER project_memory_items_au AFTER UPDATE ON project_memory_items BEGIN
			INSERT INTO project_memory_fts(project_memory_fts,rowid,title,body_text,tags_text)
			VALUES('delete',old.id,old.title,old.body_text,old.tags_text);
			INSERT INTO project_memory_fts(rowid,title,body_text,tags_text)
			VALUES(new.id,new.title,new.body_text,new.tags_text);
		END;
		CREATE TRIGGER project_memory_items_ad AFTER DELETE ON project_memory_items BEGIN
			INSERT INTO project_memory_fts(project_memory_fts,rowid,title,body_text,tags_text)
			VALUES('delete',old.id,old.title,old.body_text,old.tags_text);
		END;`);
}
