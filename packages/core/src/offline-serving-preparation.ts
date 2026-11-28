import { statSync } from "node:fs";
import Database from "better-sqlite3";
import {
	type DatabaseFileIdentity,
	databaseFileAt,
	isSameDatabaseFile,
} from "./database-file-identity.js";
import { assertSchemaReadyReadOnly, getSchemaVersion, SCHEMA_VERSION, tableExists } from "./db.js";
import { selectProjectStorage } from "./project-storage-connection.js";
import { prepareScopeServingStore } from "./scope-serving-proof-store.js";
import { installTransitionedTables } from "./transitioned-store-tables.js";

function requireSelectedFile(path: string, selected: DatabaseFileIdentity): void {
	if (!isSameDatabaseFile(selected, databaseFileAt(path)) || statSync(selected.path).nlink !== 1)
		throw new Error("Select the same single-link device store throughout the transition.");
}

/**
 * The operator must already have stopped serving, drained refreshes and backed
 * up the store. File locks cannot account for bytes already read into memory.
 * No startup, CLI or coordinator route invokes this operation.
 */
export function prepareOfflineScopeServingStore(
	path: string,
	preparation: Parameters<typeof prepareScopeServingStore>[1],
	envelopes: Parameters<typeof prepareScopeServingStore>[2],
): void {
	const selected = databaseFileAt(path);
	if (!selected) throw new Error("Select an existing device store by its absolute path.");
	requireSelectedFile(path, selected);
	// connect() runs bootstrap/repair and accesses WAL. Exclusive locking mode
	// must be selected on a fresh handle before its first database access.
	const db = new Database(selected.path, { fileMustExist: true, timeout: 0 });
	try {
		if (db.pragma("locking_mode=EXCLUSIVE", { simple: true }) !== "exclusive")
			throw new Error("Could not select exclusive locking for the device store.");
		db.pragma("foreign_keys=ON");
		db.transaction(() => {
			// In rollback-journal mode an idle client releases its shared lock.
			// Never convert journal modes here to manufacture a successful check.
			if (db.pragma("journal_mode", { simple: true }) !== "wal")
				throw new Error("Offline preparation requires an existing WAL store.");
			requireSelectedFile(path, selected);
			selectProjectStorage(db);
			if (getSchemaVersion(db) !== SCHEMA_VERSION || !tableExists(db, "memory_fts"))
				throw new Error("Offline preparation requires the current device store schema.");
			assertSchemaReadyReadOnly(db);
			installTransitionedTables(db);
			prepareScopeServingStore(db, preparation, envelopes);
			requireSelectedFile(path, selected);
		}).exclusive();
	} catch (error) {
		if (error instanceof Database.SqliteError && error.code === "SQLITE_BUSY")
			throw new Error("The device store is in use. Stop its clients before preparing it.", {
				cause: error,
			});
		throw error;
	} finally {
		db.close();
	}
}
