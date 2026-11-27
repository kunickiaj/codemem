import type { Database } from "better-sqlite3";
import { repositoryIdentitySql } from "./project.js";

/**
 * The recorded repository identity of a session, from its metadata. Queries must use
 * this exact text, unaliased, for SQLite to match it to the index below.
 */
export const SESSION_REPOSITORY_IDENTITY_SQL = repositoryIdentitySql("metadata_json");

const INDEX_NAME = "idx_sessions_repository_evidence";

/**
 * Every query that maps checkout folders to repositories reads each session's folder,
 * git remote and recorded identity. Without this index it scans every session and parses
 * its metadata JSON, about 60 ms per read on a store with 27,000 sessions, and the Viewer
 * reads it several times for one stored memory or one status request. With it, those
 * reads scan only this index.
 */
export function ensureSessionsRepositoryEvidenceIndex(db: Database): void {
	if (db.readonly) return;
	try {
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX_NAME))
			return;
		const columns = new Set(
			(db.prepare("SELECT name FROM pragma_table_info('sessions')").pluck().all() as string[]) ??
				[],
		);
		if (!columns.has("cwd") || !columns.has("git_remote") || !columns.has("metadata_json")) return;
		db.exec(
			`CREATE INDEX IF NOT EXISTS ${INDEX_NAME}
			 ON sessions(cwd, git_remote, ${SESSION_REPOSITORY_IDENTITY_SQL})`,
		);
	} catch {
		// Locked, query-only and partial legacy databases keep scanning sessions and retry
		// on the next writable compatibility check.
	}
}
