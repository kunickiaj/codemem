import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import { createD1CoordinatorApp } from "./d1-coordinator-runtime.js";
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
	constructor(private readonly db: DatabaseType) {}

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

describe("createD1CoordinatorApp", () => {
	let tmpDir: string;
	let db: DatabaseType;
	let d1db: D1DatabaseLike;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "d1-coord-runtime-test-"));
		db = connectCoordinator(join(tmpDir, "coordinator.sqlite"));
		d1db = new SqliteD1Database(db);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("serves coordinator admin data from the D1-backed adapter", async () => {
		const store = new D1CoordinatorStore(d1db);
		await store.createGroup("g1", "Team Alpha");
		await store.enrollDevice("g1", {
			deviceId: "d1",
			fingerprint: "fp1",
			publicKey: "pk1",
			displayName: "Laptop",
		});
		await store.close();

		const app = createD1CoordinatorApp({
			db: d1db,
			adminSecret: "test-secret",
			now: () => "2026-03-28T00:00:00Z",
		});

		const res = await app.request("/v1/admin/devices?group_id=g1", {
			headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			items: [
				{
					group_id: "g1",
					device_id: "d1",
					public_key: "pk1",
					fingerprint: "fp1",
					display_name: "Laptop",
					enabled: 1,
					created_at: expect.any(String),
				},
			],
		});
	});

	it("uses injected runtime admin secret instead of process env", async () => {
		const app = createD1CoordinatorApp({
			db: d1db,
			adminSecret: null,
			now: () => "2026-03-28T00:00:00Z",
		});

		const res = await app.request("/v1/admin/devices?group_id=g1", {
			headers: { "X-Codemem-Coordinator-Admin": "ignored" },
		});

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "admin_not_configured" });
	});
});
