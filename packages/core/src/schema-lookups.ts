/**
 * Whether a table or a column exists, remembered per connection.
 *
 * Code that still supports older stores asks this before it reads a table, and read paths
 * ask it many times over. One prompt pack asked about 5,400 times for a table and 2,600
 * times for a column. Each question compiled and ran a statement, about 85 ms per pack.
 *
 * The answers are kept until the schema changes. SQLite counts schema changes in
 * `PRAGMA schema_version`, whichever connection or process makes them, so every lookup
 * reads that counter, which takes under a microsecond, and forgets the answers when it has
 * moved.
 *
 * Nothing is remembered inside a transaction. A rolled-back schema change puts the counter
 * back, and another connection's change could then bring it to the value the rolled-back
 * answers were stored under.
 */
import type { Database, Statement } from "better-sqlite3";
import { physicalTableName } from "./project-storage-connection.js";

interface SchemaLookups {
	schemaVersion: number;
	readSchemaVersion: Statement<[], number>;
	answers: Map<string, boolean>;
}

const lookupsByConnection = new WeakMap<Database, SchemaLookups>();

/** The answers that hold for the schema as it is now, or null when none may be kept. */
function currentAnswers(db: Database): Map<string, boolean> | null {
	if (db.inTransaction) return null;
	let lookups = lookupsByConnection.get(db);
	if (!lookups) {
		lookups = {
			schemaVersion: -1,
			readSchemaVersion: db.prepare<[], number>("PRAGMA schema_version").pluck(),
			answers: new Map(),
		};
		lookupsByConnection.set(db, lookups);
	}
	const schemaVersion = Number(lookups.readSchemaVersion.get());
	if (schemaVersion !== lookups.schemaVersion) {
		lookups.answers.clear();
		lookups.schemaVersion = schemaVersion;
	}
	return lookups.answers;
}

function remembered(db: Database, key: string, read: () => boolean): boolean {
	const answers = currentAnswers(db);
	if (!answers) return read();
	const known = answers.get(key);
	if (known !== undefined) return known;
	const answer = read();
	answers.set(key, answer);
	return answer;
}

/** Check if a table exists in the database. */
export function tableExists(db: Database, table: string): boolean {
	return remembered(
		db,
		JSON.stringify([table]),
		() =>
			db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get(physicalTableName(db, table)) !== undefined,
	);
}

/** Check if an index or trigger with this name exists. */
export function schemaObjectExists(db: Database, type: "index" | "trigger", name: string): boolean {
	return remembered(
		db,
		// Three parts, so a key never matches a table or column lookup.
		JSON.stringify(["sqlite_master", type, name]),
		() =>
			db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !==
			undefined,
	);
}

/** Check if a column exists in a table. */
export function columnExists(db: Database, table: string, column: string): boolean {
	if (!tableExists(db, table)) return false;
	return remembered(
		db,
		JSON.stringify([table, column]),
		() =>
			db
				.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ? LIMIT 1")
				.get(physicalTableName(db, table), column) !== undefined,
	);
}
