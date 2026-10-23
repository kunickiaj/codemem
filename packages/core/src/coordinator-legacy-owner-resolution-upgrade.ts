import { lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { readConnectionSchemaState } from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { readLegacyOwnerResolutionSchemaState } from "./coordinator-legacy-owner-resolution-metadata.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS } from "./coordinator-legacy-owner-resolution-schema.js";

const accountPrerequisite =
	"Current coordinator account schema required. Inspect the database and run codemem coordinator upgrade-account-schema --db-path '<coordinator.sqlite>' before installing owner-resolution storage.";

const fileSelectionError =
	"Select an existing regular coordinator SQLite file, not a symlink or URI, in a protected operator-owned folder. Stop writers and inspect file and parent ownership/permissions before retrying.";
const changedSelectionError =
	"Coordinator database path, identity or permissions changed during maintenance. Stop writers, inspect the selected file and its parent folders, and retry from a protected operator-owned folder.";

type FileSelection = {
	path: string;
	canonical: string;
	file: Stats;
	parents: { path: string; stat: Stats }[];
};

function sameIdentity(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.mode === right.mode
	);
}

function parentPaths(path: string): string[] {
	const paths: string[] = [];
	for (let parent = dirname(path); ; parent = dirname(parent)) {
		paths.push(parent);
		if (parent === dirname(parent)) return paths;
	}
}

function requireProtectedParents(parents: FileSelection["parents"], uid: number): void {
	for (const { path, stat } of parents) {
		if (stat.uid !== uid && stat.uid !== 0) throw new Error(fileSelectionError);
		// Parent symlinks (including macOS /var) are checked along both original and
		// canonical routes. Their permission bits do not control target access.
		if (stat.isSymbolicLink()) continue;
		if (!stat.isDirectory()) throw new Error(fileSelectionError);
		if (!(stat.mode & 0o022)) continue;
		const child = parents.find((entry) => dirname(entry.path) === path && entry.path !== path);
		// A root-owned sticky temp directory is acceptable only above a protected,
		// operator-owned directory, never directly above the selected database.
		if (
			stat.uid === 0 &&
			stat.mode & 0o1000 &&
			child?.stat.isDirectory() &&
			child.stat.uid === uid &&
			!(child.stat.mode & 0o022)
		)
			continue;
		throw new Error(fileSelectionError);
	}
}

function selectExistingFile(path: string): FileSelection {
	try {
		if (!path || path === ":memory:" || path.startsWith("file:"))
			throw new Error(fileSelectionError);
		// Capture the original selection before resolving any parent aliases.
		const file = lstatSync(path);
		const uid = process.getuid?.();
		if (!file.isFile() || uid === undefined || file.uid !== uid || file.mode & 0o022)
			throw new Error(fileSelectionError);
		const canonical = realpathSync(path);
		const canonicalFile = lstatSync(canonical);
		if (!canonicalFile.isFile() || !sameIdentity(file, canonicalFile))
			throw new Error(changedSelectionError);
		const parents = [...new Set([...parentPaths(resolve(path)), ...parentPaths(canonical)])].map(
			(path) => ({ path, stat: lstatSync(path) }),
		);
		requireProtectedParents(parents, uid);
		if (lstatSync(dirname(canonical)).uid !== uid) throw new Error(fileSelectionError);
		return { path: resolve(path), canonical, file, parents };
	} catch {
		throw new Error(fileSelectionError);
	}
}

function verifySelection(selection: FileSelection, db?: Database.Database): void {
	try {
		for (const path of [selection.path, selection.canonical]) {
			const current = lstatSync(path);
			if (!current.isFile() || !sameIdentity(selection.file, current))
				throw new Error(changedSelectionError);
		}
		if (realpathSync(selection.path) !== selection.canonical)
			throw new Error(changedSelectionError);
		for (const parent of selection.parents) {
			if (!sameIdentity(parent.stat, lstatSync(parent.path)))
				throw new Error(changedSelectionError);
		}
		if (!db) return;
		const main = (db.pragma("database_list") as { name: string; file: string }[]).find(
			(row) => row.name === "main",
		);
		// SQLite reports a filename, NOT the identity of its opened file descriptor.
		// These pathname checks detect observed changes, not hostile swap-and-restore.
		if (!main?.file || resolve(main.file) !== selection.canonical)
			throw new Error(changedSelectionError);
	} catch {
		throw new Error(changedSelectionError);
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

async function installMissingSchema(
	db: Database.Database,
	selection: FileSelection,
): Promise<void> {
	const backend = schemaReader(db);
	await requireAccountSchema(backend);
	const state = await readLegacyOwnerResolutionSchemaState(backend);
	verifySelection(selection, db);
	if (state === "ready") return;
	if (state !== "missing")
		throw new Error("Unsupported or partial owner-resolution schema; inspect without repair.");
	rejectNameCollisions(db);
	verifySelection(selection, db);
	for (const sql of LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS) db.exec(sql);
	if ((await readLegacyOwnerResolutionSchemaState(backend)) !== "ready")
		throw new Error("Owner-resolution schema failed exact post-install readiness checks.");
}

/** Explicit operator operation: install empty inert receipt storage, never ownership
 * or access. Operators must pause writers, drain attempts and back up first. */
export async function upgradeCoordinatorOwnerResolutionSchemaFile(path: string): Promise<void> {
	const selection = selectExistingFile(path);
	verifySelection(selection);
	const db = new Database(selection.canonical, { fileMustExist: true });
	try {
		verifySelection(selection, db);
		// This private, unshared connection holds the writer lock across readiness awaits.
		// Do not use db.transaction(async): it commits at the first await.
		db.exec("BEGIN IMMEDIATE");
		await installMissingSchema(db, selection);
		verifySelection(selection, db);
		db.exec("COMMIT");
	} catch (error) {
		if (db.inTransaction) db.exec("ROLLBACK");
		throw error;
	} finally {
		db.close();
	}
}
