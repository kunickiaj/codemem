/**
 * Memories this device has stored more than one copy of in one scope.
 *
 * Once a key and scope are seen with duplicates, they stay recorded here, so
 * sync keeps withholding them after copies disappear one by one, for example
 * when an access cleanup deletes one of them and the other looks servable. Only
 * an explicit repair (`codemem sync duplicates repair`) that finds exactly one
 * copy left clears the record. Triggers record duplicates from every write path:
 * a new row, and a row whose import key or scope changes.
 */

import type { Database } from "./db.js";
import { columnExists, tableExists } from "./schema-lookups.js";

/** A memory seen with more than one copy in one scope, with the copies stored now. */
export interface AmbiguousMemoryCopies {
	scope_id: string | null;
	memory_ids: number[];
}

export type AmbiguousCopyRepair =
	| { status: "repaired"; scope_id: string | null }
	| { status: "not_found" }
	| { status: "not_ambiguous" }
	| { status: "copies_remain"; memory_ids: number[] };

const RECORD_DUPLICATE = `INSERT OR IGNORE INTO memory_ambiguous_copies(import_key, scope_key, first_seen_at)
	VALUES (NEW.import_key, COALESCE(NEW.scope_id, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
/**
 * Copies stored under the new row's key in its scope. The unary plus keeps SQLite
 * off the scope index, which would scan the whole scope on every insert, so the
 * count reads the import key index instead.
 */
export const SIBLING_COUNT_SQL = `SELECT COUNT(*) FROM memory_items
	WHERE import_key = NEW.import_key AND +scope_id IS NEW.scope_id`;
const HAS_SIBLING = `NEW.import_key IS NOT NULL AND (${SIBLING_COUNT_SQL}) > 1`;

const CREATE_TRIGGERS = `CREATE TRIGGER IF NOT EXISTS memory_ambiguous_copies_on_insert
	AFTER INSERT ON memory_items WHEN ${HAS_SIBLING}
	BEGIN ${RECORD_DUPLICATE}; END;
	CREATE TRIGGER IF NOT EXISTS memory_ambiguous_copies_on_move
	AFTER UPDATE OF import_key, scope_id ON memory_items WHEN ${HAS_SIBLING}
	BEGIN ${RECORD_DUPLICATE}; END;`;

/**
 * Creates the record and its triggers. The transaction that creates the table
 * also records the duplicates already stored, so later opens only restore
 * missing triggers. A store whose memories have no key or scope column yet
 * gets the record on the first open after they are added.
 */
export function ensureMemoryCopyAmbiguitySchema(db: Database): void {
	if (
		!columnExists(db, "memory_items", "import_key") ||
		!columnExists(db, "memory_items", "scope_id")
	)
		return;
	if (tableExists(db, "memory_ambiguous_copies")) {
		db.exec(CREATE_TRIGGERS);
		return;
	}
	db.transaction(() => {
		db.exec(`CREATE TABLE memory_ambiguous_copies (
			import_key TEXT NOT NULL,
			scope_key TEXT NOT NULL,
			first_seen_at TEXT NOT NULL,
			PRIMARY KEY (import_key, scope_key)
		);
		INSERT INTO memory_ambiguous_copies(import_key, scope_key, first_seen_at)
		SELECT import_key, COALESCE(scope_id, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		FROM memory_items WHERE import_key IS NOT NULL
		GROUP BY import_key, COALESCE(scope_id, '') HAVING COUNT(*) > 1;`);
		db.exec(CREATE_TRIGGERS);
	})();
}

/** Whether the key was seen with duplicates in this scope, or in any scope when none is named. */
export function ambiguousCopiesRecorded(
	db: Database,
	importKey: string,
	scopeId?: string | null,
): boolean {
	if (!tableExists(db, "memory_ambiguous_copies")) return false;
	if (scopeId === undefined)
		return (
			db.prepare("SELECT 1 FROM memory_ambiguous_copies WHERE import_key = ?").get(importKey) !==
			undefined
		);
	return (
		db
			.prepare("SELECT 1 FROM memory_ambiguous_copies WHERE import_key = ? AND scope_key = ?")
			.get(importKey, scopeId ?? "") !== undefined
	);
}

/** The scopes each of these keys is recorded as ambiguous in, in one query. */
export function recordedAmbiguousScopes(
	db: Database,
	importKeys: readonly string[],
): Array<{ import_key: string; scope_id: string | null }> {
	if (importKeys.length === 0 || !tableExists(db, "memory_ambiguous_copies")) return [];
	const rows = db
		.prepare(
			`SELECT import_key, scope_key FROM memory_ambiguous_copies
			 WHERE import_key IN (${importKeys.map(() => "?").join(", ")})`,
		)
		.all(...importKeys) as Array<{ import_key: string; scope_key: string }>;
	return rows.map((row) => ({ import_key: row.import_key, scope_id: row.scope_key || null }));
}

/** The recorded memories, with the copies stored now, in the order first recorded. */
export function listAmbiguousMemoryCopies(db: Database): AmbiguousMemoryCopies[] {
	if (!tableExists(db, "memory_ambiguous_copies")) return [];
	const groups = db
		.prepare(
			`SELECT record.scope_key, GROUP_CONCAT(memory.id) AS ids
			 FROM memory_ambiguous_copies AS record
			 LEFT JOIN memory_items AS memory
			   ON memory.import_key = record.import_key
			  AND COALESCE(memory.scope_id, '') = record.scope_key
			 GROUP BY record.import_key, record.scope_key
			 ORDER BY record.first_seen_at, record.import_key`,
		)
		.all() as Array<{ scope_key: string; ids: string | null }>;
	return groups.map((group) => ({
		scope_id: group.scope_key || null,
		memory_ids: (group.ids ?? "")
			.split(",")
			.filter(Boolean)
			.map(Number)
			.sort((left, right) => left - right),
	}));
}

/**
 * Clears the record for the memory's key and scope once the memory is the only
 * copy left there. Sync then serves and applies that copy again.
 */
export function repairAmbiguousMemoryCopy(db: Database, memoryId: number): AmbiguousCopyRepair {
	return db.transaction((): AmbiguousCopyRepair => {
		const survivor = db
			.prepare("SELECT import_key, scope_id FROM memory_items WHERE id = ?")
			.get(memoryId) as { import_key: string | null; scope_id: string | null } | undefined;
		if (!survivor?.import_key) return { status: "not_found" };
		if (!ambiguousCopiesRecorded(db, survivor.import_key, survivor.scope_id))
			return { status: "not_ambiguous" };
		const copies = db
			.prepare("SELECT id FROM memory_items WHERE import_key = ? AND scope_id IS ? ORDER BY id")
			.pluck()
			.all(survivor.import_key, survivor.scope_id) as number[];
		if (copies.length !== 1) return { status: "copies_remain", memory_ids: copies };
		db.prepare("DELETE FROM memory_ambiguous_copies WHERE import_key = ? AND scope_key = ?").run(
			survivor.import_key,
			survivor.scope_id ?? "",
		);
		return { status: "repaired", scope_id: survivor.scope_id };
	})();
}
