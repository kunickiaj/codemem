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
import {
	connectionOrderAllocation,
	orderedBrowserStartStatements,
} from "./coordinator-account-connection-session.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
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
 * `connectCoordinator(":memory:")` as earlier releases ran it: the same connection
 * settings, with only the V2 schema those releases created. The deferred V3 lifecycle
 * upgrade's predecessor is this schema.
 */
export function connectV2Coordinator(): SqliteDatabase {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	db.pragma("synchronous = NORMAL");
	initializeBaseSchema(db);
	return db;
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

/**
 * Reopens a seeded V2 coordinator file through ordinary store startup, as the coordinator
 * restarting on this release would. Removal stays with the `setupV2Store` that created it.
 */
export async function reopenCoordinator(
	coordinator: { store: BetterSqliteCoordinatorStore; path: string },
	options: CoordinatorAuthLinkOptions = {},
): Promise<{ store: BetterSqliteCoordinatorStore; db: SqliteDatabase; path: string }> {
	await coordinator.store.close();
	const store = new BetterSqliteCoordinatorStore(coordinator.path, options);
	onTestFinished(() => {
		if (store.db.open) store.db.close();
	});
	return { store, db: store.db, path: coordinator.path };
}

function hasConnectionOrders(db: SqliteDatabase): boolean {
	const row = db
		.prepare(
			"SELECT count(*) AS n FROM pragma_table_info('coordinator_auth_browser_transactions') WHERE name = 'start_order'",
		)
		.get() as { n: number };
	return row.n === 1;
}

function runAll(db: SqliteDatabase, statements: AuthLinkStatement[]): void {
	db.transaction(() => {
		for (const { sql, values } of statements) db.prepare(sql).run(...values);
	})();
}

/**
 * Seeds one browser transaction as a real start writes it on this database's schema. On
 * the current account schema the production start statements allocate the coordinator's
 * next connection order and stamp it on the row. On V2 only `insert` runs.
 */
export function seedBrowserStart(
	db: SqliteDatabase,
	insert: AuthLinkStatement,
	coordinatorId: string,
	transactionHash: string,
): void {
	runAll(
		db,
		hasConnectionOrders(db)
			? orderedBrowserStartStatements([insert], coordinatorId, transactionHash)
			: [insert],
	);
}

/**
 * Moves seeded browser transactions to another coordinator as if that coordinator had
 * started them: each gets the new coordinator's next connection order on the current
 * account schema. On V2 only the coordinator changes.
 */
export function reassignBrowserStarts(
	db: SqliteDatabase,
	where: { sql: string; values: unknown[] },
	coordinatorId: string,
): void {
	const hashes = db
		.prepare(
			`SELECT browser_transaction_hash AS hash FROM coordinator_auth_browser_transactions WHERE ${where.sql}`,
		)
		.all(...where.values) as { hash: string }[];
	const ordered = hasConnectionOrders(db);
	runAll(
		db,
		hashes.flatMap(({ hash }) => {
			const move = {
				sql: `UPDATE coordinator_auth_browser_transactions SET coordinator_id = ?${ordered ? ", start_order = NULL" : ""} WHERE browser_transaction_hash = ?`,
				values: [coordinatorId, hash],
			};
			return ordered ? orderedBrowserStartStatements([move], coordinatorId, hash) : [move];
		}),
	);
}

/**
 * Sessions and links exist only after their coordinator's browser starts. Tests that seed
 * them directly call this for the coordinator's order row, which the current account
 * schema requires once it has any. Allocates the first order only when the row is
 * missing; no-op on V2.
 */
export function seedConnectionOrder(db: SqliteDatabase, coordinatorId: string): void {
	if (!hasConnectionOrders(db)) return;
	const present = db
		.prepare("SELECT 1 FROM coordinator_auth_account_connection_orders WHERE coordinator_id = ?")
		.get(coordinatorId);
	if (!present) runAll(db, connectionOrderAllocation(coordinatorId));
}
