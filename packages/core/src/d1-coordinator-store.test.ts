import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import { runCoordinatorStoreContract } from "./coordinator-store-test-harness.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";

class SqliteD1Statement implements D1PreparedStatementLike {
	private bound: unknown[] = [];

	constructor(private readonly statement: Statement) {}

	bind(...values: unknown[]): D1PreparedStatementLike {
		this.bound = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		return (this.statement.get(...this.bound) as T | undefined) ?? null;
	}

	async run(): Promise<unknown> {
		const result = this.statement.run(...this.bound);
		return { meta: { changes: result.changes } };
	}

	executeRunSync(): unknown {
		const result = this.statement.run(...this.bound);
		return { meta: { changes: result.changes } };
	}

	async all<T = unknown>(): Promise<{ results?: T[] }> {
		return { results: this.statement.all(...this.bound) as T[] };
	}

	async raw<T = unknown>(): Promise<T[]> {
		return this.statement.raw(true).all(...this.bound) as T[];
	}
}

class SqliteD1Database implements D1DatabaseLike {
	constructor(protected readonly db: DatabaseType) {}

	prepare(query: string): D1PreparedStatementLike {
		return new SqliteD1Statement(this.db.prepare(query));
	}

	async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
		return this.db.transaction(() => {
			const results: unknown[] = [];
			for (const statement of statements) {
				if (!(statement instanceof SqliteD1Statement)) {
					throw new Error("Unsupported D1 statement test double.");
				}
				results.push(statement.executeRunSync());
			}
			return results;
		})();
	}
}

class RacingReciprocalApprovalStatement implements D1PreparedStatementLike {
	private bound: unknown[] = [];
	private injected = false;

	constructor(
		private readonly db: DatabaseType,
		private readonly query: string,
	) {}

	bind(...values: unknown[]): D1PreparedStatementLike {
		this.bound = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		return (this.db.prepare(this.query).get(...this.bound) as T | undefined) ?? null;
	}

	async run(): Promise<unknown> {
		if (!this.injected) {
			this.injected = true;
			const [, groupId, requestingDeviceId, requestedDeviceId, low, high, createdAt] = this
				.bound as [string, string, string, string, string, string, string];
			this.db
				.prepare(`INSERT INTO coordinator_reciprocal_approvals(
					request_id,
					group_id,
					requesting_device_id,
					requested_device_id,
					pending_pair_low_device_id,
					pending_pair_high_device_id,
					status,
					created_at,
					resolved_at
				) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`)
				.run("race-existing", groupId, requestedDeviceId, requestingDeviceId, low, high, createdAt);
		}
		const result = this.db.prepare(this.query).run(...this.bound);
		return { meta: { changes: result.changes } };
	}

	async all<T = unknown>(): Promise<{ results?: T[] }> {
		return { results: this.db.prepare(this.query).all(...this.bound) as T[] };
	}

	async raw<T = unknown>(): Promise<T[]> {
		return this.db
			.prepare(this.query)
			.raw(true)
			.all(...this.bound) as T[];
	}
}

class RacingSqliteD1Database extends SqliteD1Database {
	override prepare(query: string): D1PreparedStatementLike {
		if (query.includes("INSERT INTO coordinator_reciprocal_approvals(")) {
			return new RacingReciprocalApprovalStatement(this.db, query);
		}
		return super.prepare(query);
	}
}

describe("D1CoordinatorStore", () => {
	function setupStore() {
		const tmpDir = mkdtempSync(join(tmpdir(), "d1-coord-test-"));
		const db = connectCoordinator(join(tmpDir, "coordinator.sqlite"));
		db.exec(`
			DROP TABLE IF EXISTS coordinator_reciprocal_approvals;
			DROP TABLE IF EXISTS coordinator_join_requests;
			DROP TABLE IF EXISTS coordinator_invites;
			DROP TABLE IF EXISTS request_nonces;
			DROP TABLE IF EXISTS presence_records;
			DROP TABLE IF EXISTS enrolled_devices;
			DROP TABLE IF EXISTS groups;
		`);
		db.exec(
			readFileSync(
				join(import.meta.dirname, "../../cloudflare-coordinator-worker/schema.sql"),
				"utf8",
			),
		);
		const store = new D1CoordinatorStore(new SqliteD1Database(db));
		return {
			store,
			db,
			cleanup: async () => {
				await store.close();
				db.close();
				rmSync(tmpDir, { recursive: true, force: true });
			},
		};
	}

	runCoordinatorStoreContract("contract", () => {
		const { store, cleanup } = setupStore();
		return { store, cleanup };
	});

	it("converges to completed when a reverse pending row appears during insert", async () => {
		const { db, cleanup } = setupStore();
		const racingStore = new D1CoordinatorStore(new RacingSqliteD1Database(db));
		try {
			await racingStore.createGroup("g1");
			const result = await racingStore.createReciprocalApproval({
				groupId: "g1",
				requestingDeviceId: "d1",
				requestedDeviceId: "d2",
			});
			expect(result).toEqual(
				expect.objectContaining({
					request_id: "race-existing",
					status: "completed",
					requesting_device_id: "d2",
					requested_device_id: "d1",
				}),
			);
			await racingStore.close();
		} finally {
			await cleanup();
		}
	});

	it("dedupes mirrored pending rows before creating the pending-pair unique index", async () => {
		const { db, cleanup } = setupStore();
		const migrationPath = join(
			import.meta.dirname,
			"../../cloudflare-coordinator-worker/migrations/0003_harden_reciprocal_approval_pending_pairs.sql",
		);
		try {
			if (!existsSync(migrationPath)) {
				throw new Error(`missing migration fixture: ${migrationPath}`);
			}
			db.exec("DROP TABLE IF EXISTS coordinator_reciprocal_approvals");
			db.exec(`
				CREATE TABLE coordinator_reciprocal_approvals (
					request_id TEXT PRIMARY KEY,
					group_id TEXT NOT NULL,
					requesting_device_id TEXT NOT NULL,
					requested_device_id TEXT NOT NULL,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					resolved_at TEXT
				)
			`);
			db.prepare(
				`INSERT INTO coordinator_reciprocal_approvals(
					request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run("req-a", "g1", "d1", "d2", "pending", "2026-03-29T00:00:00Z", null);
			db.prepare(
				`INSERT INTO coordinator_reciprocal_approvals(
					request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run("req-b", "g1", "d2", "d1", "pending", "2026-03-29T00:00:01Z", null);

			db.exec(readFileSync(migrationPath, "utf8"));

			const migratedRows = db
				.prepare(
					`SELECT request_id, status, pending_pair_low_device_id, pending_pair_high_device_id, resolved_at
					 FROM coordinator_reciprocal_approvals ORDER BY request_id ASC`,
				)
				.all() as Array<Record<string, unknown>>;
			expect(migratedRows).toEqual([
				expect.objectContaining({
					request_id: "req-a",
					status: "completed",
					pending_pair_low_device_id: "d1",
					pending_pair_high_device_id: "d2",
					resolved_at: "2026-03-29T00:00:00Z",
				}),
				expect.objectContaining({
					request_id: "req-b",
					status: "completed",
					pending_pair_low_device_id: "d1",
					pending_pair_high_device_id: "d2",
					resolved_at: "2026-03-29T00:00:01Z",
				}),
			]);
			const indexInfo = db
				.prepare(`PRAGMA index_list('coordinator_reciprocal_approvals')`)
				.all() as Array<Record<string, unknown>>;
			expect(indexInfo).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "idx_coordinator_reciprocal_pending_pair", unique: 1 }),
				]),
			);
		} finally {
			await cleanup();
		}
	});

	it("normalizes and validates bootstrap grant input consistently", async () => {
		const { store, cleanup } = setupStore();
		try {
			const grant = await store.createBootstrapGrant({
				groupId: " g1 ",
				seedDeviceId: " seed-1 ",
				workerDeviceId: " worker-1 ",
				expiresAt: " 2099-01-01T00:00:00Z ",
				createdBy: " admin ",
			});
			expect(grant).toEqual(
				expect.objectContaining({
					group_id: "g1",
					seed_device_id: "seed-1",
					worker_device_id: "worker-1",
					expires_at: "2099-01-01T00:00:00Z",
					created_by: "admin",
				}),
			);

			await expect(
				store.createBootstrapGrant({
					groupId: "   ",
					seedDeviceId: "seed-1",
					workerDeviceId: "worker-1",
					expiresAt: "2099-01-01T00:00:00Z",
				}),
			).rejects.toThrow("groupId, seedDeviceId, workerDeviceId, and expiresAt are required.");
		} finally {
			await cleanup();
		}
	});
});
