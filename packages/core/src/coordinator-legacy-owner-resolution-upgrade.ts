import { lstatSync } from "node:fs";
import Database from "better-sqlite3";
import { readConnectionSchemaState } from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { readLegacyOwnerResolutionSchemaState } from "./coordinator-legacy-owner-resolution-metadata.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS } from "./coordinator-legacy-owner-resolution-schema.js";

const accountPrerequisite =
	"Current coordinator account schema required. Inspect the database and run codemem coordinator upgrade-account-schema --db-path '<coordinator.sqlite>' before installing owner-resolution storage.";

function openExistingFile(path: string): Database.Database {
	try {
		if (!path || path === ":memory:" || path.startsWith("file:") || !lstatSync(path).isFile())
			throw new Error("invalid_file");
		return new Database(path, { fileMustExist: true });
	} catch {
		throw new Error("Select an existing regular coordinator SQLite file, not a symlink or URI.");
	}
}

function schemaReader(db: Database.Database): Pick<AuthLinkBackend, "first"> {
	return {
		first: async <T>({ sql, values }: AuthLinkStatement) =>
			(db.prepare(sql).get(...values) as T | undefined) ?? null,
	};
}

async function requireAccountSchema(backend: Pick<AuthLinkBackend, "first">): Promise<void> {
	try {
		if ((await readConnectionSchemaState(backend)) === "ready") return;
	} catch {
		// Unrecognized files must take the normal account-schema path, never receipt DDL.
	}
	throw new Error(accountPrerequisite);
}

function rejectNameCollisions(db: Database.Database): void {
	for (const sql of LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS) {
		// These trusted declarations include leading whitespace and SQL comments.
		const name = /\bCREATE (?:TABLE|INDEX|TRIGGER) IF NOT EXISTS (\w+)/u.exec(sql)?.[1];
		if (!name) throw new Error("Unsupported owner-resolution schema statement.");
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? COLLATE NOCASE").get(name))
			throw new Error(
				"Unsupported owner-resolution schema name collision; inspect without repair.",
			);
	}
}

async function installMissingSchema(db: Database.Database): Promise<void> {
	const backend = schemaReader(db);
	await requireAccountSchema(backend);
	const state = await readLegacyOwnerResolutionSchemaState(backend);
	if (state === "ready") return;
	if (state !== "missing")
		throw new Error("Unsupported or partial owner-resolution schema; inspect without repair.");
	rejectNameCollisions(db);
	for (const sql of LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS) db.exec(sql);
	if ((await readLegacyOwnerResolutionSchemaState(backend)) !== "ready")
		throw new Error("Owner-resolution schema failed exact post-install readiness checks.");
}

/** Explicit operator operation: install empty inert receipt storage, never ownership
 * or access. Operators must pause writers, drain attempts and back up first. */
export async function upgradeCoordinatorOwnerResolutionSchemaFile(path: string): Promise<void> {
	const db = openExistingFile(path);
	try {
		// This private, unshared connection holds the writer lock across readiness awaits.
		// Do not use db.transaction(async): it commits at the first await.
		db.exec("BEGIN IMMEDIATE");
		await installMissingSchema(db);
		db.exec("COMMIT");
	} catch (error) {
		if (db.inTransaction) db.exec("ROLLBACK");
		throw error;
	} finally {
		db.close();
	}
}
