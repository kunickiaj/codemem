import type { Database } from "./db.js";

export interface RepositoryWorkspaceEvidence {
	cwd: string;
	recordedIdentitiesJson: string;
	filesystemIdentity: string | null;
	filesystemAnchor: string | null;
	anchorMtimeNs: string | null;
	checkedAtMs: number;
}

interface RepositoryDiscoveryState {
	source_revision: number;
	indexed_revision: number;
}

export function ensureRepositoryDiscoveryIndex(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS repository_discovery_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			source_revision INTEGER NOT NULL DEFAULT 0,
			indexed_revision INTEGER NOT NULL DEFAULT -1
		);
		INSERT OR IGNORE INTO repository_discovery_state(id) VALUES (1);
		CREATE TABLE IF NOT EXISTS repository_workspace_evidence (
			cwd TEXT PRIMARY KEY,
			recorded_identities_json TEXT NOT NULL,
			filesystem_identity TEXT,
			filesystem_anchor TEXT,
			anchor_mtime_ns TEXT,
			checked_at_ms INTEGER NOT NULL
		);
		CREATE TRIGGER IF NOT EXISTS trg_repository_discovery_session_insert
		AFTER INSERT ON sessions BEGIN
			UPDATE repository_discovery_state SET source_revision = source_revision + 1 WHERE id = 1;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_repository_discovery_session_update
		AFTER UPDATE OF cwd, git_remote, metadata_json ON sessions BEGIN
			UPDATE repository_discovery_state SET source_revision = source_revision + 1 WHERE id = 1;
		END;
		CREATE TRIGGER IF NOT EXISTS trg_repository_discovery_session_delete
		AFTER DELETE ON sessions BEGIN
			UPDATE repository_discovery_state SET source_revision = source_revision + 1 WHERE id = 1;
		END;
	`);
}

export function repositoryDiscoveryRevision(db: Database): number | null {
	try {
		const triggers = db
			.prepare(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (
				'trg_repository_discovery_session_insert',
				'trg_repository_discovery_session_update',
				'trg_repository_discovery_session_delete'
			)`)
			.pluck()
			.get() as number;
		if (triggers !== 3) return null;
		const row = db
			.prepare("SELECT source_revision FROM repository_discovery_state WHERE id = 1")
			.get() as { source_revision: number } | undefined;
		return row?.source_revision ?? null;
	} catch {
		return null;
	}
}

export function loadRepositoryDiscoveryEvidence(
	db: Database,
): RepositoryWorkspaceEvidence[] | null {
	try {
		return db.transaction(() => {
			const state = db
				.prepare(
					"SELECT source_revision, indexed_revision FROM repository_discovery_state WHERE id = 1",
				)
				.get() as RepositoryDiscoveryState | undefined;
			if (!state || state.source_revision !== state.indexed_revision) return null;
			return db
				.prepare(`SELECT cwd, recorded_identities_json AS recordedIdentitiesJson,
				filesystem_identity AS filesystemIdentity, filesystem_anchor AS filesystemAnchor,
				anchor_mtime_ns AS anchorMtimeNs, checked_at_ms AS checkedAtMs
				FROM repository_workspace_evidence ORDER BY cwd`)
				.all() as RepositoryWorkspaceEvidence[];
		})();
	} catch {
		return null;
	}
}

export function replaceRepositoryDiscoveryEvidence(
	db: Database,
	expectedRevision: number,
	rows: RepositoryWorkspaceEvidence[],
): boolean {
	return db
		.transaction(() => {
			if (repositoryDiscoveryRevision(db) !== expectedRevision) return false;
			db.prepare("DELETE FROM repository_workspace_evidence").run();
			const insert = db.prepare(`INSERT INTO repository_workspace_evidence(
			cwd, recorded_identities_json, filesystem_identity, filesystem_anchor,
			anchor_mtime_ns, checked_at_ms
		) VALUES (?, ?, ?, ?, ?, ?)`);
			for (const row of rows) {
				insert.run(
					row.cwd,
					row.recordedIdentitiesJson,
					row.filesystemIdentity,
					row.filesystemAnchor,
					row.anchorMtimeNs,
					row.checkedAtMs,
				);
			}
			db.prepare("UPDATE repository_discovery_state SET indexed_revision = ? WHERE id = 1").run(
				expectedRevision,
			);
			return true;
		})
		.immediate();
}
