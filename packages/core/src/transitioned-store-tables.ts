import type { Database, Statement } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
	physicalSql,
	renamedOptionalTables,
	renamedRequiredTables,
	transitionedNames,
} from "./transitioned-store-names.js";

type SchemaRow = { name: string; type: string; sql: string | null };

// The connection's own methods, before any shape-aware wrapper: these functions
// read and write on-disk names.
function physicalAll(db: Database, sql: string): Record<string, unknown>[] {
	const prepare = Object.getPrototypeOf(db).prepare as Database["prepare"];
	return (prepare.call(db, sql) as Statement<unknown[]>).all() as Record<string, unknown>[];
}

function physicalExec(db: Database, sql: string): void {
	(Object.getPrototypeOf(db).exec as Database["exec"]).call(db, sql);
}

function schemaObjects(db: Database): Map<string, SchemaRow> {
	const rows = physicalAll(db, "SELECT name, type, sql FROM main.sqlite_schema") as SchemaRow[];
	return new Map(rows.map((row) => [row.name, row]));
}

// Every connection reads these names first, so the query lists them instead of
// reading the whole schema.
const shapeQuery = `SELECT name, type, sql FROM main.sqlite_schema WHERE name IN (${Object.entries(
	transitionedNames,
)
	.flat()
	.map((name) => `'${name}'`)
	.join(",")})`;

// The additive schema step of released sync passes (0.49.1 through
// 0.50.0-beta.4) creates these two tables whenever they are missing, before it
// fails on the moved tables. They stay empty because filling them needs memory
// rows those releases cannot read. Current code never reads them.
const recreatedByReleasedSync = new Set<string>(["memory_concept_refs", "memory_file_refs"]);

function isEmptyRecreation(db: Database, row: SchemaRow): boolean {
	if (!recreatedByReleasedSync.has(row.name) || row.type !== "table") return false;
	if (/^\s*CREATE\s+VIRTUAL\b/i.test(row.sql ?? "")) return false;
	return physicalAll(db, `SELECT 1 FROM "${row.name}" LIMIT 1`).length === 0;
}

/** A partially converted store must not be treated as an ordinary store. */
export function contentStorageShape(db: Database): "legacy" | "transitioned" {
	const objects = new Map(
		(physicalAll(db, shapeQuery) as SchemaRow[]).map((row) => [row.name, row]),
	);
	const entries = Object.entries(transitionedNames);
	if (!entries.some(([, physical]) => objects.has(physical))) return "legacy";
	const complete =
		entries.every(([legacy]) => {
			const row = objects.get(legacy);
			return !row || isEmptyRecreation(db, row);
		}) &&
		[...renamedRequiredTables, "memory_fts" as const].every(
			(name) => objects.get(transitionedNames[name])?.type === "table",
		);
	if (complete) return "transitioned";
	throw new Error("Incomplete or conflicting Project storage format.");
}

function isVec0(row: SchemaRow | undefined): row is SchemaRow & { sql: string } {
	return row?.type === "table" && /\bUSING\s+vec0\s*\(/i.test(row.sql ?? "");
}

function ensureVecModule(db: Database): void {
	try {
		physicalAll(db, "SELECT vec_version()");
	} catch {
		// Moving the index needs the module even when embeddings are turned off.
		sqliteVec.load(db);
	}
}

function rowCount(db: Database, table: string): unknown {
	return physicalAll(db, `SELECT COUNT(*) AS n FROM "${table}"`)[0]?.n;
}

/**
 * sqlite-vec does not rename its shadow tables, so embeddings are copied into a
 * table created under the new name with the same rowids, and the old table is
 * dropped. The read-only compatibility view and its triggers move with it.
 */
function moveVectorIndex(db: Database, objects: Map<string, SchemaRow>): void {
	const tables = (["memory_vectors_v1", "memory_vectors"] as const).filter((name) =>
		isVec0(objects.get(name)),
	);
	const view = objects.get("memory_vectors");
	const compatibility =
		view?.type === "view"
			? [
					view,
					...[...objects.values()].filter(
						(row) => row.type === "trigger" && /\bON\s+memory_vectors\b/i.test(row.sql ?? ""),
					),
				]
			: [];
	if (view && !tables.length)
		throw new Error("Project storage conversion found vector objects without their index.");
	if (compatibility.length) physicalExec(db, "DROP VIEW memory_vectors");
	for (const legacy of tables) {
		const physical = transitionedNames[legacy];
		physicalExec(db, physicalSql((objects.get(legacy) as SchemaRow & { sql: string }).sql));
		const columns = physicalAll(db, `SELECT name FROM pragma_table_info('${legacy}')`).map(
			({ name }) => `"${String(name).replaceAll('"', '""')}"`,
		);
		const list = ["rowid", ...columns].join(", ");
		physicalExec(db, `INSERT INTO "${physical}" (${list}) SELECT ${list} FROM "${legacy}"`);
		if (rowCount(db, legacy) !== rowCount(db, physical))
			throw new Error("Project storage conversion lost vector rows.");
		physicalExec(db, `DROP TABLE "${legacy}"`);
	}
	for (const row of compatibility) if (row.sql) physicalExec(db, physicalSql(row.sql));
}

const FTS_DDL = `CREATE VIRTUAL TABLE project_memory_fts USING fts5(
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
END;`;

/** Caller owns the offline window and commits proof preparation in this transaction. */
export function installTransitionedTables(db: Database): void {
	if (!db.inTransaction || db.pragma("locking_mode", { simple: true }) !== "exclusive")
		throw new Error("Project storage conversion requires the exclusive maintenance transaction.");
	if (contentStorageShape(db) === "transitioned") return;
	if (db.pragma("legacy_alter_table", { simple: true }) !== 0)
		throw new Error("Project storage conversion requires SQLite reference updates.");
	const objects = schemaObjects(db);
	if (!renamedRequiredTables.every((name) => objects.get(name)?.type === "table"))
		throw new Error("Project storage conversion requires the current device store schema.");
	// Renames reparse every schema entry, including the vector table and its view.
	if ([...objects.values()].some(isVec0)) ensureVecModule(db);

	// FTS5 stores the external-content table name as a module argument. RENAME
	// updates ordinary references but does not retarget that argument.
	physicalExec(
		db,
		`DROP TRIGGER memory_items_ai;
		DROP TRIGGER memory_items_au;
		DROP TRIGGER memory_items_ad;
		DROP TABLE memory_fts;`,
	);
	const present = renamedOptionalTables.filter((name) => objects.get(name)?.type === "table");
	for (const name of [...renamedRequiredTables, ...present])
		physicalExec(db, `ALTER TABLE "${name}" RENAME TO "${transitionedNames[name]}"`);
	moveVectorIndex(db, objects);
	physicalExec(db, FTS_DDL);
	if (contentStorageShape(db) !== "transitioned")
		throw new Error("Project storage conversion left a released name in place.");
}
