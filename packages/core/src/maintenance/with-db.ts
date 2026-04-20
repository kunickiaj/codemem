/* Shared withDb helper — resolves the dbPath, opens a connection, asserts
 * the schema is ready, then runs the callback with guaranteed cleanup. */

import { assertSchemaReady, connect, type Database, resolveDbPath } from "../db.js";

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
