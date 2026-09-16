import type { Database } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

/** Current schema version this TS runtime was built against. */
export const SCHEMA_VERSION = 20;

export const REQUIRED_TABLES = [
	"memory_items",
	"sessions",
	"artifacts",
	"raw_events",
	"raw_event_sessions",
	"usage_events",
] as const;

export const REQUIRED_BOOTSTRAPPED_TABLES = [
	...REQUIRED_TABLES,
	"memory_fts",
	"coordinator_enrollment_reconciliation_issues",
	// The legacy_team_setup_* tables are deliberately NOT listed: they are
	// created additively by `ensureLegacyTeamSetupDraftSchema` on every
	// connection path. Listing them would make a valid older bootstrapped
	// schema look partial and skip WAL/pragma connection setup for the first
	// post-upgrade connection.
] as const;

/** Check if embeddings are disabled via environment variable. */
export function isEmbeddingDisabled(): boolean {
	const val = process.env.CODEMEM_EMBEDDING_DISABLED?.toLowerCase();
	return val === "1" || val === "true" || val === "yes";
}

/** Load sqlite-vec and verify that the extension is callable. */
export function loadSqliteVec(db: Database): void {
	if (isEmbeddingDisabled()) return;
	sqliteVec.load(db);
	const row = db.prepare("SELECT vec_version() AS v").get() as { v: string } | undefined;
	if (!row?.v) throw new Error("sqlite-vec loaded but version check failed");
}

/** Read the schema `user_version` pragma, returning zero for an empty database. */
export function getSchemaVersion(db: Database): number {
	const row = db.pragma("user_version", { simple: true });
	return typeof row === "number" ? row : 0;
}

export const IDENTITY_DEVICE_ASSIGNMENT_TRIGGERS_DDL = `
	DROP TRIGGER IF EXISTS trg_identity_devices_assignment_version;
	CREATE TRIGGER trg_identity_devices_assignment_version
	AFTER UPDATE OF identity_id ON identity_devices
	WHEN NEW.identity_id <> OLD.identity_id
	BEGIN
		UPDATE identity_devices
		SET assignment_version = OLD.assignment_version + 1
		WHERE device_id = NEW.device_id;
	END;
	DROP TRIGGER IF EXISTS trg_identity_devices_purge_decisions;
	CREATE TRIGGER trg_identity_devices_purge_decisions
	AFTER DELETE ON identity_devices
	BEGIN
		DELETE FROM policy_team_device_decisions WHERE device_id = OLD.device_id;
	END;
`;
