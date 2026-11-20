import type { Database } from "better-sqlite3";

export function ensurePeerProjectFilterManagementSchema(db: Database): void {
	if (
		db
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE name = 'peer_project_filter_management' AND type = 'table'",
			)
			.get()
	) {
		return;
	}
	db.exec(
		"CREATE TABLE IF NOT EXISTS peer_project_filter_management (id INTEGER PRIMARY KEY CHECK (id = 1))",
	);
}

/** Preserve this store's filter policy before its configured coordinator URL is cleared. */
export function rememberPeerProjectFilterManagement(db: Database): void {
	db.prepare(
		"INSERT INTO peer_project_filter_management (id) VALUES (1) ON CONFLICT(id) DO NOTHING",
	).run();
}

/** A store that disconnected before the marker existed may still have coordinator history. */
export function hasPeerProjectFilterManagement(db: Database): boolean {
	return (
		db
			.prepare(
				`SELECT EXISTS (SELECT 1 FROM peer_project_filter_management)
		     OR EXISTS (SELECT 1 FROM replication_scopes WHERE authority_type = 'coordinator')
		     OR EXISTS (SELECT 1 FROM scope_membership_cache_state)`,
			)
			.pluck()
			.get() === 1
	);
}
