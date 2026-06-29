/* Shared withDb helpers — resolve the dbPath, open a connection, assert the
 * schema is ready, then run the callback with guaranteed cleanup. */

import {
	assertSchemaReady,
	connect,
	connectReadOnly,
	type Database,
	resolveDbPath,
} from "../db.js";

export function withDb<T>(
	dbPath: string | undefined,
	fn: (db: Database, resolvedPath: string) => T,
): T {
	const resolvedPath = resolveDbPath(dbPath);
	const db = connect(resolvedPath);
	try {
		assertSchemaReady(db);
		return fn(db, resolvedPath);
	} finally {
		db.close();
	}
}

/**
 * Read-only variant of {@link withDb}. Opens the database read-only so reports
 * can inspect read-only snapshots / read-only directories without creating
 * directories, enabling WAL, or bootstrapping schema.
 */
export function withReadOnlyDb<T>(
	dbPath: string | undefined,
	fn: (db: Database, resolvedPath: string) => T,
): T {
	const resolvedPath = resolveDbPath(dbPath);
	const db = connectReadOnly(resolvedPath);
	try {
		return fn(db, resolvedPath);
	} finally {
		db.close();
	}
}
