import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeviceIdentity, initTestSchema, MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";
import { clearBackgroundRefreshes, settleBackgroundRefreshes } from "./background-refresh.js";

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
	// Forget cached coordinator answers, including a refresh that never finishes.
	clearBackgroundRefreshes();
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

describe("sync status reads", () => {
	it("reads without writing to the store", async () => {
		await app.request("/api/sync/status");
		const prepare = vi.spyOn(store.db, "prepare");
		const exec = vi.spyOn(store.db, "exec");

		const response = await app.request("/api/sync/status");

		expect(response.status).toBe(200);
		const statements = [...prepare.mock.calls, ...exec.mock.calls].map(([sql]) => String(sql));
		expect(statements.filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql))).toEqual(
			[],
		);
	});
});

/** Turns on a coordinator for the test store, with a fresh device identity. */
function enableCoordinator(settings: Record<string, unknown> = {}): void {
	const keysDir = join(directory, "keys");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	writeFileSync(
		join(directory, "config.json"),
		JSON.stringify({
			sync_enabled: true,
			sync_coordinator_url: "https://coord.example.test",
			sync_coordinator_group: "team-a",
			...settings,
		}),
	);
	ensureDeviceIdentity(store.db, { keysDir });
}

/** A coordinator that answers every request at once, listing `peers` for `url`. */
function answeringCoordinator(peersByUrl: Record<string, Array<Record<string, unknown>>> = {}) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const origin = new URL(url).origin;
		if (url.includes("/v1/presence")) return Response.json({ ok: true, addresses: [] });
		if (url.includes("/v1/peers")) return Response.json({ items: peersByUrl[origin] ?? [] });
		return Response.json({ items: [] });
	});
}

async function readCoordinatorStatus(): Promise<Record<string, unknown>> {
	const response = await app.request("/api/sync/status");
	return ((await response.json()) as { coordinator: Record<string, unknown> }).coordinator;
}

describe("sync status coordinator cache", () => {
	it("refreshes by the presence renewal deadline when the presence TTL is short", async () => {
		enableCoordinator({ sync_coordinator_presence_ttl_s: 20 });
		const fetchMock = answeringCoordinator();
		vi.stubGlobal("fetch", fetchMock);
		const presenceCalls = () =>
			fetchMock.mock.calls.filter(([input]) => String(input).includes("/v1/presence")).length;
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			await readCoordinatorStatus();
			await settleBackgroundRefreshes();
			const afterFirstRefresh = presenceCalls();
			expect(afterFirstRefresh).toBe(1);

			// A 20-second TTL renews presence every 10 seconds, sooner than the 30-second reuse.
			vi.setSystemTime(Date.now() + 11_000);
			await readCoordinatorStatus();
			await settleBackgroundRefreshes();

			expect(presenceCalls()).toBe(afterFirstRefresh + 1);
		} finally {
			vi.useRealTimers();
			await settleBackgroundRefreshes();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});

	it("never serves one coordinator configuration's answer for another", async () => {
		enableCoordinator();
		const peerA = { device_id: "peer-a", fingerprint: "fp-a", addresses: [], stale: false };
		vi.stubGlobal("fetch", answeringCoordinator({ "https://coord.example.test": [peerA] }));
		try {
			await readCoordinatorStatus();
			await settleBackgroundRefreshes();
			expect(await readCoordinatorStatus()).toMatchObject({
				coordinator_url: "https://coord.example.test",
				discovered_devices: [{ device_id: "peer-a" }],
			});

			// The new coordinator never answers; its first read must not show the old one.
			vi.stubGlobal(
				"fetch",
				vi.fn(() => new Promise<Response>(() => {})),
			);
			enableCoordinator({ sync_coordinator_url: "https://other-coord.example.test" });
			const switched = await readCoordinatorStatus();

			expect(switched).toMatchObject({
				coordinator_url: "https://other-coord.example.test",
				presence_status: "unknown",
				discovered_devices: [],
				status_refreshed_at: null,
			});
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});
});

describe("sync status coordinator answers", () => {
	it("answers from memory while the coordinator is slow, then shows its answer and age", async () => {
		enableCoordinator();
		const answers: Array<() => void> = [];
		// Answer each coordinator request as the background refresh makes it.
		const answerUntilRefreshed = async () => {
			let done = false;
			const refresh = settleBackgroundRefreshes().then(() => {
				done = true;
			});
			while (!done) {
				answers.shift()?.();
				await new Promise((resolve) => setImmediate(resolve));
			}
			await refresh;
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(input: RequestInfo | URL) =>
					new Promise<Response>((resolve) => {
						const url = String(input);
						const body = url.includes("/v1/presence") ? { ok: true, addresses: [] } : { items: [] };
						answers.push(() => resolve(new Response(JSON.stringify(body), { status: 200 })));
					}),
			),
		);
		try {
			const response = await Promise.race([
				app.request("/api/sync/status"),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
			]);

			if (!response) throw new Error("sync status waited for the coordinator");
			const { coordinator } = (await response.json()) as { coordinator: Record<string, unknown> };
			expect(coordinator).toMatchObject({
				presence_status: "unknown",
				status_refreshed_at: null,
				status_refreshing: true,
			});

			await answerUntilRefreshed();
			const refreshed = (await (await app.request("/api/sync/status")).json()) as {
				coordinator: Record<string, unknown>;
			};
			expect(refreshed.coordinator).toMatchObject({
				presence_status: "posted",
				status_refreshing: false,
			});
			expect(refreshed.coordinator.status_refreshed_at).toEqual(expect.any(String));
			expect(refreshed.coordinator.status_age_ms).toEqual(expect.any(Number));
		} finally {
			await answerUntilRefreshed();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});

	it("refreshes when a discovered peer's presence expires and never serves it as fresh", async () => {
		enableCoordinator();
		const expiresAt = new Date(Date.now() + 400).toISOString();
		const peer = { device_id: "peer-expiring", fingerprint: "fp-expiring", addresses: [] };
		let held: Array<() => void> | null = null;
		const answer = (url: string) => {
			if (url.includes("/v1/presence")) return { ok: true, addresses: [] };
			if (url.includes("/v1/peers")) {
				return { items: [{ ...peer, expires_at: expiresAt, stale: false }] };
			}
			return { items: [] };
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const body = JSON.stringify(answer(String(input)));
				if (held) await new Promise<void>((resolve) => held?.push(resolve));
				return new Response(body, { status: 200 });
			}),
		);
		type Coordinator = {
			fresh_peer_count: number;
			stale_peer_count: number;
			status_refreshing: boolean;
			discovered_devices: Array<{ device_id: string; stale: boolean }>;
		};
		const readCoordinator = async () =>
			((await (await app.request("/api/sync/status")).json()) as { coordinator: Coordinator })
				.coordinator;
		try {
			await app.request("/api/sync/status");
			await settleBackgroundRefreshes();
			expect(await readCoordinator()).toMatchObject({
				fresh_peer_count: 1,
				discovered_devices: [{ device_id: "peer-expiring", stale: false }],
			});
			const callsBeforeExpiry = vi.mocked(fetch).mock.calls.length;

			held = [];
			await new Promise((resolve) => setTimeout(resolve, 500));
			const afterExpiry = await readCoordinator();

			expect(afterExpiry).toMatchObject({
				fresh_peer_count: 0,
				stale_peer_count: 1,
				status_refreshing: true,
				discovered_devices: [{ device_id: "peer-expiring", stale: true }],
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(callsBeforeExpiry);
		} finally {
			const pending = held ?? [];
			held = null;
			let done = false;
			const refresh = settleBackgroundRefreshes().then(() => {
				done = true;
			});
			while (!done) {
				pending.shift()?.();
				await new Promise((resolve) => setImmediate(resolve));
			}
			await refresh;
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});
});
