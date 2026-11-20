import type { Database } from "better-sqlite3";

/**
 * Independent of pairing and Identity lifetime. Removing a connection must not
 * turn its Project restrictions into unrestricted inheritance on recreation.
 * Explicit replacement lists still require the normal filter authorization.
 */
export const PEER_PROJECT_FILTER_RETENTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS peer_project_filter_retention (
	peer_device_id TEXT PRIMARY KEY NOT NULL,
	projects_include_json TEXT,
	projects_exclude_json TEXT
);

CREATE TRIGGER IF NOT EXISTS peer_project_filters_retain_before_delete
BEFORE DELETE ON sync_peers
BEGIN
	INSERT INTO peer_project_filter_retention (
		peer_device_id, projects_include_json, projects_exclude_json
	) VALUES (OLD.peer_device_id, OLD.projects_include_json, OLD.projects_exclude_json)
	ON CONFLICT(peer_device_id) DO UPDATE SET
		projects_include_json = excluded.projects_include_json,
		projects_exclude_json = excluded.projects_exclude_json;
END;

CREATE TRIGGER IF NOT EXISTS peer_project_filters_restore_after_insert
AFTER INSERT ON sync_peers
WHEN NEW.projects_include_json IS NULL AND NEW.projects_exclude_json IS NULL
BEGIN
	UPDATE sync_peers SET
		projects_include_json = (
			SELECT projects_include_json FROM peer_project_filter_retention
			WHERE peer_device_id = NEW.peer_device_id
		),
		projects_exclude_json = (
			SELECT projects_exclude_json FROM peer_project_filter_retention
			WHERE peer_device_id = NEW.peer_device_id
		)
	WHERE peer_device_id = NEW.peer_device_id
		AND EXISTS (
			SELECT 1 FROM peer_project_filter_retention WHERE peer_device_id = NEW.peer_device_id
		);
END;
`;

export const PEER_PROJECT_FILTER_RETENTION_TRIGGER_NAMES = [
	"peer_project_filters_retain_before_delete",
	"peer_project_filters_restore_after_insert",
] as const;

/** Normal additive initialization only. Readers and pairing writers never create storage. */
export function ensurePeerProjectFilterRetentionSchema(db: Database): void {
	if (
		!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sync_peers' AND type = 'table'").get()
	) {
		return;
	}
	const objects = db
		.prepare(
			`SELECT COUNT(*) FROM sqlite_master
			 WHERE (type = 'table' AND name = 'peer_project_filter_retention')
			    OR (type = 'trigger' AND name IN (?, ?))`,
		)
		.pluck()
		.get(...PEER_PROJECT_FILTER_RETENTION_TRIGGER_NAMES);
	if (objects === 3) return;
	// Failure propagates: a writable store without retention must not start and
	// allow a deletion that loses a pairing's restrictions.
	db.transaction(() => db.exec(PEER_PROJECT_FILTER_RETENTION_SCHEMA_SQL)).immediate();
}

export interface RetainedPeerProjectFilters {
	projects_include_json: string | null;
	projects_exclude_json: string | null;
}

/** A removed pairing's last lists, or null when none were retained on this store. */
export function readRetainedPeerProjectFilters(
	db: Database,
	peerDeviceId: string,
): RetainedPeerProjectFilters | null {
	const present = db
		.prepare(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'peer_project_filter_retention'",
		)
		.get();
	if (!present) return null;
	return (
		(db
			.prepare(
				`SELECT projects_include_json, projects_exclude_json FROM peer_project_filter_retention
				 WHERE peer_device_id = ?`,
			)
			.get(peerDeviceId) as RetainedPeerProjectFilters | undefined) ?? null
	);
}
