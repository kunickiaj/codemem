import { statSync } from "node:fs";
import {
	type DatabaseFileIdentity,
	databaseFileAt,
	isSameDatabaseFile,
} from "./database-file-identity.js";
import { assertSchemaReadyReadOnly, getSchemaVersion, SCHEMA_VERSION, tableExists } from "./db.js";
import { withOfflineDeviceDatabase } from "./device-database-open.js";
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
	withOfflineDeviceDatabase(selected.path, (db) => {
		// In rollback-journal mode an idle client releases its shared lock.
		// Never convert journal modes here to manufacture a successful check.
		if (db.pragma("journal_mode", { simple: true }) !== "wal")
			throw new Error("Offline preparation requires an existing WAL store.");
		requireSelectedFile(path, selected);
		if (getSchemaVersion(db) !== SCHEMA_VERSION || !tableExists(db, "memory_fts"))
			throw new Error("Offline preparation requires the current device store schema.");
		assertSchemaReadyReadOnly(db);
		installTransitionedTables(db);
		// The rest of the transaction uses released names on the converted store.
		selectProjectStorage(db);
		prepareScopeServingStore(db, preparation, envelopes);
		requireSelectedFile(path, selected);
	});
}
