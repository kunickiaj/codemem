import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTestSchema, MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";

let directory: string;
let previousConfig: string | undefined;
let store: MemoryStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-status-read-plan-"));
	const dbPath = join(directory, "mem.sqlite");
	previousConfig = process.env.CODEMEM_CONFIG;
	writeFileSync(join(directory, "config.json"), JSON.stringify({ sync_enabled: false }));
	process.env.CODEMEM_CONFIG = join(directory, "config.json");
	const database = new Database(dbPath);
	initTestSchema(database);
	database.close();
	store = new MemoryStore(dbPath);
	app = createApp({ storeFactory: () => store });
});

afterEach(() => {
	vi.restoreAllMocks();
	store.close();
	if (previousConfig === undefined) delete process.env.CODEMEM_CONFIG;
	else process.env.CODEMEM_CONFIG = previousConfig;
	rmSync(directory, { recursive: true, force: true });
});

describe("sync status indexed reads", () => {
	it("uses the existing effective-time index and keeps unfinished attempts last", async () => {
		const insert = store.db.prepare(
			`INSERT INTO sync_attempts(peer_device_id, started_at, finished_at, ok, ops_in, ops_out)
			 VALUES (?, ?, ?, 1, 0, 0)`,
		);
		insert.run("unfinished", "2026-02-01T00:00:00Z", null);
		insert.run("finished-first", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
		insert.run("finished-last", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z");
		const prepare = vi.spyOn(store.db, "prepare");

		const response = await app.request("/api/sync/status");
		const payload = (await response.json()) as { attempts: Array<{ peer_device_id: string }> };

		expect(payload.attempts.map((attempt) => attempt.peer_device_id)).toEqual([
			"finished-last",
			"finished-first",
			"unfinished",
		]);
		const sql = prepare.mock.calls
			.map(([query]) => String(query))
			.find((query) => /FROM\s+"?sync_attempts"?\s+WHERE finished_at IS NOT NULL/u.test(query));
		expect(sql).toBeDefined();
		const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
		expect(plan.some(({ detail }) => detail.includes("idx_sync_attempts_occurred"))).toBe(true);
	});

	it("uses the existing successful-attempt index for recent peer totals", async () => {
		const now = new Date().toISOString();
		store.db
			.prepare("INSERT INTO sync_peers(peer_device_id, created_at) VALUES (?, ?)")
			.run("peer-recent", now);
		const insert = store.db.prepare(
			`INSERT INTO sync_attempts(peer_device_id, started_at, finished_at, ok, ops_in, ops_out)
			 VALUES ('peer-recent', ?, ?, ?, ?, ?)`,
		);
		insert.run(now, now, 1, 3, 5);
		insert.run(now, now, 0, 10, 10);
		insert.run(now, null, 1, 10, 10);
		insert.run("2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z", 1, 10, 10);
		const prepare = vi.spyOn(store.db, "prepare");
		const response = await app.request("/api/sync/status");
		const payload = (await response.json()) as {
			peers: Array<{ peer_device_id: string; recent_ops: { in: number; out: number } }>;
		};
		expect(payload.peers.find((peer) => peer.peer_device_id === "peer-recent")?.recent_ops).toEqual(
			{
				in: 3,
				out: 5,
			},
		);

		const sql = prepare.mock.calls
			.map(([query]) => String(query))
			.find((query) => query.includes("SUM(ops_in)") && query.includes("GROUP BY peer_device_id"));
		expect(sql).toBeDefined();
		const plan = store.db
			.prepare(`EXPLAIN QUERY PLAN ${sql}`)
			.all("2026-01-01T00:00:00Z") as Array<{ detail: string }>;
		expect(plan.some(({ detail }) => detail.includes("idx_sync_attempts_success_occurred"))).toBe(
			true,
		);
	});

	it("falls back to a full scan when diagnostic indexes were not created", async () => {
		store.db.exec("DROP INDEX idx_sync_attempts_occurred");
		store.db.exec("DROP INDEX idx_sync_attempts_success_occurred");
		const now = new Date().toISOString();
		store.db
			.prepare(
				`INSERT INTO sync_attempts(peer_device_id, started_at, finished_at, ok, ops_in, ops_out)
				 VALUES ('finished', ?, ?, 1, 0, 0)`,
			)
			.run(now, now);
		const response = await app.request("/api/sync/status");
		const payload = (await response.json()) as { attempts: Array<{ peer_device_id: string }> };
		expect(response.status).toBe(200);
		expect(payload.attempts[0]?.peer_device_id).toBe("finished");
		expect(
			store.db
				.prepare(
					`SELECT name FROM sqlite_master
					 WHERE name IN ('idx_sync_attempts_occurred', 'idx_sync_attempts_success_occurred')`,
				)
				.all(),
		).toEqual([]);
	});
});

describe("legacy review status", () => {
	it("does not discover project candidates when there are no legacy-review memories", async () => {
		const prepare = vi.spyOn(store.db, "prepare");
		const response = await app.request("/api/sync/status");
		const payload = (await response.json()) as {
			legacy_shared_review: { groups: unknown[]; memory_count: number };
		};

		expect(payload.legacy_shared_review.groups).toEqual([]);
		expect(payload.legacy_shared_review.memory_count).toBe(0);
		expect(
			prepare.mock.calls.some(([query]) =>
				String(query).includes("ORDER BY s.started_at DESC, s.id DESC"),
			),
		).toBe(false);
	});

	it("still discovers projects when a legacy-review memory exists", async () => {
		const now = new Date().toISOString();
		const session = store.db
			.prepare("INSERT INTO sessions(started_at, cwd, project) VALUES (?, ?, ?)")
			.run(now, "/tmp/project-review-fixture", "project-review-fixture");
		store.db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				 visibility, workspace_id, workspace_kind, active, scope_id, metadata_json)
				 VALUES (?, 'discovery', 'Legacy memory', 'Body', ?, ?, 'shared', 'shared:default',
				 'shared', 1, 'legacy-shared-review', '{}')`,
			)
			.run(Number(session.lastInsertRowid), now, now);
		const prepare = vi.spyOn(store.db, "prepare");
		const response = await app.request("/api/sync/status");
		const payload = (await response.json()) as {
			legacy_shared_review: { memory_count: number };
		};
		expect(payload.legacy_shared_review.memory_count).toBe(1);
		expect(
			prepare.mock.calls.some(([query]) =>
				String(query).includes("ORDER BY s.started_at DESC, s.id DESC"),
			),
		).toBe(true);
	});
});

describe("sync status attempt limits", () => {
	it("keeps unfinished rows out when there are enough finished attempts", async () => {
		const insert = store.db.prepare(
			`INSERT INTO sync_attempts(peer_device_id, started_at, finished_at, ok, ops_in, ops_out)
			 VALUES (?, ?, ?, 1, 0, 0)`,
		);
		insert.run("unfinished", "2026-12-01T00:00:00Z", null);
		for (let day = 1; day <= 26; day++) {
			const at = `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
			insert.run(`finished-${day}`, at, at);
		}
		const prepare = vi.spyOn(store.db, "prepare");
		const response = await app.request("/api/sync/status");
		const payload = (await response.json()) as { attempts: Array<{ peer_device_id: string }> };

		expect(payload.attempts.map(({ peer_device_id }) => peer_device_id)).toEqual([
			"finished-26",
			"finished-25",
			"finished-24",
			"finished-23",
			"finished-22",
		]);
		expect(
			prepare.mock.calls.some(([sql]) =>
				/SELECT peer_device_id, ok, error, started_at, finished_at,[\s\S]+WHERE finished_at IS NULL/u.test(
					String(sql),
				),
			),
		).toBe(false);
	});
});
