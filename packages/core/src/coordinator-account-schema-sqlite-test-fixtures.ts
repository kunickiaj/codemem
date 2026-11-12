// Historical account-management schema states, for tests of the upgrade from them. Each is
// built the way an earlier release left a database, not by bypassing the installer.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { onTestFinished } from "vitest";
import {
	BetterSqliteCoordinatorStore,
	initializeBaseSchema,
} from "./better-sqlite-coordinator-store.js";
import type { CoordinatorAuthLinkOptions } from "./coordinator-auth-link-contract.js";

/** Creates the coordinator file at `path` with only the schema earlier releases created. */
export function createV2CoordinatorFile(path: string): void {
	const created = new Database(path);
	try {
		created.pragma("journal_mode = WAL");
		initializeBaseSchema(created);
	} finally {
		created.close();
	}
}

/**
 * `setupStore("SQLite")` for a coordinator file as earlier releases left it: V2
 * authentication without account management. The store opens it only as an existing
 * file, so startup does not change its schema. The file is removed when the current
 * test finishes.
 */
export function setupV2Store(options: CoordinatorAuthLinkOptions = {}): {
	store: BetterSqliteCoordinatorStore;
	db: SqliteDatabase;
	path: string;
} {
	const directory = mkdtempSync(join(tmpdir(), "codemem-v2-coordinator-"));
	const path = join(directory, "coordinator.sqlite");
	createV2CoordinatorFile(path);
	const store = new BetterSqliteCoordinatorStore(path, { ...options, existingOnly: true });
	onTestFinished(() => {
		if (store.db.open) store.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return { store, db: store.db, path };
}
