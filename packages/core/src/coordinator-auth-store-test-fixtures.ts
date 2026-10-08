import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import type { CoordinatorAuthControllerReviewInput } from "./coordinator-auth-controller.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";

export type Store = BetterSqliteCoordinatorStore | D1CoordinatorStore;
export type Backend = "SQLite" | "D1";
export type Fixture = { store: Store; db: SqliteDatabase };

// The existing D1 suite's adapter is private. Keep this local equivalent small:
// every statement runs against SQLite and batch preserves D1 atomicity.
export function sqliteD1(
	db: SqliteDatabase,
	hooks: {
		beforeFirst?: () => void;
		beforeRead?: (query: string, values: readonly unknown[]) => void;
		beforeWrite?: (query: string, values: readonly unknown[]) => void;
		beforeBatch?: (statements: readonly { query: string; values: readonly unknown[] }[]) => void;
	} = {},
): D1DatabaseLike {
	const executions = new WeakMap<D1PreparedStatementLike, () => unknown>();
	const bindings = new WeakMap<
		D1PreparedStatementLike,
		() => { query: string; values: readonly unknown[] }
	>();
	return {
		prepare(query) {
			const statement = db.prepare(query);
			let values: unknown[] = [];
			const run = () => {
				if (statement.reader) {
					hooks.beforeRead?.(query, values);
					return { results: statement.all(...values), meta: { changes: 0 } };
				}
				hooks.beforeWrite?.(query, values);
				return { meta: { changes: statement.run(...values).changes } };
			};
			const adapter: D1PreparedStatementLike = {
				bind(...bound) {
					values = bound;
					return adapter;
				},
				async first<T>() {
					hooks.beforeFirst?.();
					hooks.beforeRead?.(query, values);
					return (statement.get(...values) as T | undefined) ?? null;
				},
				async all<T>() {
					hooks.beforeRead?.(query, values);
					return { results: statement.all(...values) as T[] };
				},
				async raw<T>() {
					return statement.raw(true).all(...values) as T[];
				},
				async run() {
					return run();
				},
			};
			executions.set(adapter, run);
			bindings.set(adapter, () => ({ query, values }));
			return adapter;
		},
		async batch(statements) {
			hooks.beforeBatch?.(
				statements.map((statement) => {
					const binding = bindings.get(statement);
					if (!binding) throw new Error("Unknown test statement");
					return binding();
				}),
			);
			return db.transaction(() =>
				statements.map((statement) => {
					const run = executions.get(statement);
					if (!run) throw new Error("Unknown test statement");
					return run();
				}),
			)();
		},
	};
}

export function setupStore(
	backend: Backend,
	options: { authClock?: () => number; databasePath?: string } = {},
): Fixture {
	if (backend === "SQLite") {
		const store = new BetterSqliteCoordinatorStore(options.databasePath ?? ":memory:", options);
		return { store, db: store.db };
	}
	const db = new Database(options.databasePath ?? ":memory:");
	try {
		const worker = join(import.meta.dirname, "../../cloudflare-coordinator-worker");
		db.exec(readFileSync(join(worker, "schema.sql"), "utf8"));
		return { store: new D1CoordinatorStore(sqliteD1(db), options), db };
	} catch (error) {
		db.close();
		throw error;
	}
}

export function review(
	overrides: Partial<CoordinatorAuthControllerReviewInput> = {},
): CoordinatorAuthControllerReviewInput {
	return {
		attestationId: "attestation-a",
		coordinatorId: "coordinator-a",
		identityId: "identity-a",
		groupId: "group-a",
		deviceId: "device-a",
		publicKey: "fixture-public-key\nexact-key-line",
		fingerprint: "a".repeat(64),
		reviewReceiptId: "receipt-a",
		evidenceDigest: "b".repeat(64),
		...overrides,
	};
}

export async function enroll(store: Store, input = review()) {
	await store.createGroup(input.groupId);
	await store.enrollDevice(input.groupId, {
		deviceId: input.deviceId,
		publicKey: input.publicKey,
		fingerprint: input.fingerprint,
	});
}
