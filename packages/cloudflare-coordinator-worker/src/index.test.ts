import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectCoordinator } from "../../core/src/better-sqlite-coordinator-store.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "../../core/src/d1-coordinator-store.js";
import { createCloudflareCoordinatorWorker } from "./index.js";

type SqliteDatabase = ReturnType<typeof connectCoordinator>;
type SqliteStatement = {
	get: (...values: unknown[]) => unknown;
	run: (...values: unknown[]) => { changes: number };
	all: (...values: unknown[]) => unknown[];
	raw: (value: boolean) => { all: (...values: unknown[]) => unknown[] };
};

class SqliteD1Statement implements D1PreparedStatementLike {
	private bound: unknown[] = [];

	constructor(private readonly statement: SqliteStatement) {}

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
	constructor(private readonly db: SqliteDatabase) {}

	prepare(query: string): D1PreparedStatementLike {
		return new SqliteD1Statement(this.db.prepare(query) as unknown as SqliteStatement);
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

describe("createCloudflareCoordinatorWorker", () => {
	let tmpDir: string;
	let db: SqliteDatabase;
	let d1db: D1DatabaseLike;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "cloudflare-coord-worker-test-"));
		db = connectCoordinator(join(tmpDir, "coordinator.sqlite"));
		d1db = new SqliteD1Database(db);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns missing_d1_binding when the worker env is incomplete", async () => {
		const worker = createCloudflareCoordinatorWorker();
		const res = await worker.fetch(
			new Request("https://coord.example.test/v1/peers?group_id=g1"),
			{},
		);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "missing_d1_binding" });
	});

	it("serves coordinator admin data through the worker entrypoint", async () => {
		const store = new D1CoordinatorStore(d1db);
		await store.createGroup("g1", "Team Alpha");
		await store.enrollDevice("g1", {
			deviceId: "d1",
			fingerprint: "fp1",
			publicKey: "pk1",
			displayName: "Laptop",
		});
		await store.close();

		const worker = createCloudflareCoordinatorWorker({
			now: () => "2026-03-28T00:00:00Z",
		});

		const res = await worker.fetch(
			new Request("https://coord.example.test/v1/admin/devices?group_id=g1", {
				headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
			}),
			{ COORDINATOR_DB: d1db, CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret" },
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			items: [
				{
					group_id: "g1",
					device_id: "d1",
					fingerprint: "fp1",
					display_name: "Laptop",
					enabled: 1,
					created_at: expect.any(String),
				},
			],
		});
	});
});
