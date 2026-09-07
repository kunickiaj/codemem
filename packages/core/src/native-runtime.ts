import Database from "better-sqlite3";

type RequiredNativeDatabaseFactory = () => { close(): void };

/**
 * Verify that codemem's required SQLite native binding loads in this runtime.
 *
 * This intentionally avoids sqlite-vec and user database paths so callers can
 * run it before starting or replacing a long-lived process.
 */
export function probeRequiredNativeRuntime(
	createDatabase: RequiredNativeDatabaseFactory = () => new Database(":memory:"),
): void {
	const db = createDatabase();
	db.close();
}
