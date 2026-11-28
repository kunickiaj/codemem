/**
 * The only constructors of device store connections. Every handle selects the
 * store's on-disk names before any other statement runs, so code written against
 * the released names reads a transitioned store, and a store with mixed names is
 * refused. `device-database-open.test.ts` fails when another module constructs a
 * better-sqlite3 or node:sqlite connection outside its reviewed list.
 */
import Database from "better-sqlite3";
import { selectProjectStorage } from "./project-storage-connection.js";
import { contentStorageShape } from "./transitioned-store-tables.js";

/** Open only. Read-only identity checks must never bootstrap or repair a profile. */
export function openDeviceDatabase(path: string, options?: Database.Options): Database.Database {
	const db = new Database(path, options);
	try {
		selectProjectStorage(db);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

/** Which names an existing store uses, read without changing it. */
export function readDeviceStorageShape(path: string): "legacy" | "transitioned" {
	const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
	try {
		return contentStorageShape(db);
	} finally {
		db.close();
	}
}

/** The maintenance connection must select exclusive locking before reading even sqlite_schema. */
export function withOfflineDeviceDatabase(
	path: string,
	work: (db: Database.Database) => void,
): void {
	const db = new Database(path, { fileMustExist: true, timeout: 0 });
	try {
		if (db.pragma("locking_mode=EXCLUSIVE", { simple: true }) !== "exclusive")
			throw new Error("Could not select exclusive locking for the device store.");
		db.pragma("foreign_keys=ON");
		db.transaction(() => {
			selectProjectStorage(db);
			work(db);
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
