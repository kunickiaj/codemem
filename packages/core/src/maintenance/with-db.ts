/* Shared withDb helper for maintenance job modules — resolves the dbPath,
 * opens a connection, asserts the schema is ready, then runs the callback
 * with guaranteed cleanup. Extracted from maintenance.ts as part of the
 * maintenance/ split (tracked under codemem-ug38). */

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
