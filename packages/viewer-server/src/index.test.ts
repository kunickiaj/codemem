/**
 * Viewer-server integration tests.
 *
 * Uses initTestSchema from @codemem/core (fix #5 — no duplicated DDL).
 * Uses Record<string, unknown> instead of Record<string, any> (fix #6).
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTestSchema, insertTestSession, type MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create an in-memory MemoryStore backed by a fresh test schema.
 * The caller must close() when done.
 */
function createTestStore(): MemoryStore {
	// Create raw DB, init schema, then wrap in MemoryStore via its constructor
	// MemoryStore constructor calls connect() which creates a new DB.
	// Instead, we need to use the store directly with a test DB path.
	// Use :memory: via a temporary approach.
	const rawDb = new Database(":memory:");
	initTestSchema(rawDb);

	// MemoryStore expects a file path; for tests we create a thin wrapper
	// that reuses the raw DB.
	// Since MemoryStore.constructor calls connect() internally, we need to
	// create a store-compatible object. For now, create a real MemoryStore
	// using a temp file, but that's slow. Instead, create a lightweight
	// test harness.
	//
	// Actually, MemoryStore from core re-opens the db. For in-memory tests,
	// we need to work around this. The cleanest approach: insert test data
	// into the raw DB, then use it directly for assertions.

	// Return the raw DB wrapped to match the subset of MemoryStore we need.
	return {
		db: rawDb,
		dbPath: ":memory:",
		deviceId: "test-device-001",
		actorId: "local:test-device-001",
		actorDisplayName: "Test User",
		stats() {
			return {
				database: {
					path: ":memory:",
					size_bytes: 0,
					sessions: 0,
					memory_items: 0,
					active_memory_items: 0,
					artifacts: 0,
					vector_rows: 0,
					raw_events: 0,
				},
			};
		},
		close() {
			rawDb.close();
		},
	} as unknown as MemoryStore;
}

function insertTestMemory(
	store: MemoryStore,
	options: {
		sessionId: number;
		kind: string;
		title: string;
		bodyText?: string;
		metadata?: Record<string, unknown>;
		actorId?: string | null;
		originDeviceId?: string | null;
		createdAt?: string;
		active?: boolean;
	},
) {
	const now = options.createdAt ?? new Date().toISOString();
	store.db
		.prepare(
			`INSERT INTO memory_items (
				session_id, kind, title, subtitle, body_text, confidence, tags_text, active,
				created_at, updated_at, metadata_json, actor_id, actor_display_name, visibility,
				workspace_id, workspace_kind, origin_device_id, origin_source, trust_state,
				facts, narrative, concepts, files_read, files_modified, prompt_number, rev, import_key
			) VALUES (?, ?, ?, NULL, ?, 0.5, '', ?, ?, ?, ?, ?, ?, 'shared', 'shared:default', 'shared', ?, ?, 'trusted', NULL, NULL, NULL, NULL, NULL, NULL, 1, ?)`,
		)
		.run(
			options.sessionId,
			options.kind,
			options.title,
			options.bodyText ?? options.title,
			options.active === false ? 0 : 1,
			now,
			now,
			JSON.stringify(options.metadata ?? {}),
			options.actorId === undefined ? "local:test-device-001" : options.actorId,
			options.actorId == null || options.actorId === "local:test-device-001"
				? "Test User"
				: options.actorId,
			options.originDeviceId === undefined ? "test-device-001" : options.originDeviceId,
			String(options.metadata?.source ?? "test"),
			`${options.kind}-${options.title}-${now}`,
		);
}

/** Create a test Hono app backed by a fresh in-memory DB. */
function createTestApp(opts?: { sweeper?: unknown }) {
	let store: MemoryStore | null = null;

	const app = createApp({
		sweeper: (opts?.sweeper ?? null) as never,
		storeFactory: () => {
			// Reuse the same store for the lifetime of the test
			if (!store) {
				store = createTestStore();
			}
			return store;
		},
	});

	return {
		app,
		getStore: () => store,
		cleanup: () => {
			if (store) {
				store.close();
				store = null;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("viewer-server", () => {
	describe("GET /api/stats", () => {
		it("returns database stats", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/stats");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("database");
				const db = body.database as Record<string, unknown>;
				expect(db).toHaveProperty("path");
				expect(db).toHaveProperty("sessions");
				expect(db).toHaveProperty("memory_items");
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/sessions", () => {
		it("returns sessions list", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				// Force store creation
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (store) {
					insertTestSession(store.db);
				}
				const res = await app.request("/api/sessions");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("items");
				const items = body.items as Record<string, unknown>[];
				expect(items.length).toBeGreaterThanOrEqual(1);
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/projects", () => {
		it("returns empty projects for fresh DB", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/projects");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("projects");
			} finally {
				cleanup();
			}
		});
	});

	describe("memory feed routes", () => {
		it("applies mine/theirs scope filters to observations", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "bugfix",
					title: "Mine",
					actorId: "local:test-device-001",
					originDeviceId: "test-device-001",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "feature",
					title: "Theirs",
					actorId: "peer:other",
					originDeviceId: "peer-device-002",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Null owned fields",
					actorId: null,
					originDeviceId: null,
					metadata: { source: "observer" },
				});

				const mineRes = await app.request("/api/observations?scope=mine");
				expect(mineRes.status).toBe(200);
				const mineItems = ((await mineRes.json()) as { items: Array<{ title: string }> }).items;
				expect(mineItems.map((item) => item.title)).toEqual(["Mine"]);

				const theirsRes = await app.request("/api/observations?scope=theirs");
				expect(theirsRes.status).toBe(200);
				const theirsItems = ((await theirsRes.json()) as { items: Array<{ title: string }> }).items;
				expect(theirsItems.map((item) => item.title).sort()).toEqual([
					"Null owned fields",
					"Theirs",
				]);
			} finally {
				cleanup();
			}
		});

		it("preserves query parameters on the /api/memories alias", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "bugfix",
					title: "Mine",
					bodyText: "Owned by local actor",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "feature",
					title: "Theirs",
					bodyText: "Owned by remote actor",
					actorId: "peer:other",
					originDeviceId: "peer-device-002",
				});

				const aliasRes = await app.request(
					"/api/memories?project=test-project&scope=mine&limit=1&offset=0",
				);
				expect(aliasRes.status).toBe(301);
				expect(aliasRes.headers.get("location")).toBe(
					"/api/observations?project=test-project&scope=mine&limit=1&offset=0",
				);

				const res = await app.request(aliasRes.headers.get("location")!);
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					items: Array<{ title: string }>;
					pagination: { limit: number; offset: number };
				};
				expect(body.items.map((item) => item.title)).toEqual(["Mine"]);
				expect(body.pagination.limit).toBe(1);
				expect(body.pagination.offset).toBe(0);
			} finally {
				cleanup();
			}
		});

		it("routes observer summaries into summaries and excludes them from observations", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Observer summary memory",
					bodyText: "## Request\nFix feed\n\n## Completed\nShipped route fix",
					metadata: {
						is_summary: true,
						source: "observer_summary",
						request: "Fix feed",
						completed: "Shipped route fix",
					},
				});
				insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Legacy summary",
					metadata: { request: "Legacy request" },
				});
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Regular change",
					metadata: { source: "observer" },
				});

				const summariesRes = await app.request("/api/summaries");
				expect(summariesRes.status).toBe(200);
				const summaries = (
					(await summariesRes.json()) as { items: Array<{ title: string; kind: string }> }
				).items;
				expect(summaries).toHaveLength(2);
				expect(summaries.map((item) => item.title).sort()).toEqual([
					"Legacy summary",
					"Observer summary memory",
				]);

				const observationsRes = await app.request("/api/observations");
				expect(observationsRes.status).toBe(200);
				const observations = ((await observationsRes.json()) as { items: Array<{ title: string }> })
					.items;
				expect(observations.map((item) => item.title)).toContain("Regular change");
				expect(observations.map((item) => item.title)).not.toContain("Observer summary memory");
				expect(observations.map((item) => item.title)).not.toContain("Legacy summary");
			} finally {
				cleanup();
			}
		});

		it("keeps session observation counts aligned with active feed items", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "bugfix",
					title: "Active observation",
					bodyText: "Still visible",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "bugfix",
					title: "Inactive observation",
					bodyText: "Soft deleted",
					active: false,
				});
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Observer summary memory",
					bodyText: "## Request\nCount summary\n\n## Completed\nDone",
					metadata: { is_summary: true, source: "observer_summary" },
				});

				const res = await app.request("/api/session");
				expect(res.status).toBe(200);
				const body = (await res.json()) as { observations: number };
				expect(body.observations).toBe(1);
			} finally {
				cleanup();
			}
		});

		it("tolerates malformed metadata when classifying summaries", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Broken metadata row",
					bodyText: "Should still render as observation",
				});
				store.db
					.prepare("UPDATE memory_items SET metadata_json = ? WHERE title = ?")
					.run("{not-json", "Broken metadata row");

				const observationsRes = await app.request("/api/observations");
				expect(observationsRes.status).toBe(200);
				const observations = ((await observationsRes.json()) as { items: Array<{ title: string }> })
					.items;
				expect(observations.map((item) => item.title)).toContain("Broken metadata row");

				const summariesRes = await app.request("/api/summaries");
				expect(summariesRes.status).toBe(200);
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/observer-status", () => {
		it("returns live observer status and suppresses stale failures after success", async () => {
			const store = createTestStore();
			try {
				(
					store as MemoryStore & {
						rawEventBacklogTotals: () => { pending: number; sessions: number };
						latestRawEventFlushFailure: () => Record<string, unknown> | null;
					}
				).rawEventBacklogTotals = () => ({ pending: 0, sessions: 0 });
				(
					store as MemoryStore & {
						latestRawEventFlushFailure: () => Record<string, unknown> | null;
					}
				).latestRawEventFlushFailure = () => ({
					observer_provider: "openai",
					observer_model: "gpt-4.1-mini",
					error_message: "OpenAI returned no usable output for raw-event processing.",
					updated_at: "2026-03-20T10:57:37Z",
				});
				const activeStatus = {
					provider: "opencode",
					model: "gpt-5.4-mini",
					runtime: "api_http",
					auth: { type: "sdk_client", hasToken: true, source: "cache" },
					lastError: null,
				};
				const appWithObserver = createApp({
					storeFactory: () => store,
					sweeper: { authBackoffStatus: () => ({ active: false, remainingS: 0 }) } as never,
					observer: { getStatus: () => activeStatus } as never,
				});
				const res = await appWithObserver.request("/api/observer-status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.active).toEqual({
					...activeStatus,
					auth: {
						...activeStatus.auth,
						method: "sdk_client",
						token_present: true,
					},
				});
				expect(body.available_credentials).toHaveProperty("opencode");
				expect(
					(body.available_credentials as Record<string, { env_var: boolean }>).opencode.env_var,
				).toBe(false);
				expect(body).toHaveProperty("queue");
				expect(body.latest_failure).toBeNull();
			} finally {
				store.close();
			}
		});
	});

	describe("/api/config", () => {
		it("returns provider options from real opencode config prefixes", async () => {
			const tmpHome = mkdtempSync(join(tmpdir(), "codemem-home-test-"));
			const opencodeConfigDir = join(tmpHome, ".config", "opencode");
			const prevHome = process.env.HOME;
			const prevConfig = process.env.CODEMEM_CONFIG;
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			process.env.HOME = tmpHome;
			process.env.CODEMEM_CONFIG = configPath;
			mkdirSync(opencodeConfigDir, { recursive: true });
			writeFileSync(
				join(opencodeConfigDir, "opencode.jsonc"),
				JSON.stringify({ model: "openai/gpt-5.4", small_model: "opencode/gpt-5-nano" }),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.providers).toEqual(["anthropic", "openai", "opencode"]);
			} finally {
				cleanup();
				if (prevHome == null) delete process.env.HOME;
				else process.env.HOME = prevHome;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("writes config and returns effects", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const notifyConfigChanged = vi.fn();
			const previous = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			const { app, cleanup } = createTestApp({ sweeper: { notifyConfigChanged } });
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({
						config: { observer_model: "gpt-4.1-mini", raw_events_sweeper_interval_s: 12 },
					}),
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.config as Record<string, unknown>).observer_model).toBe("gpt-4.1-mini");
				expect((body.effects as Record<string, unknown>).hot_reloaded_keys).toEqual([
					"raw_events_sweeper_interval_s",
				]);
				expect(notifyConfigChanged).toHaveBeenCalledTimes(1);
				expect(readFileSync(configPath, "utf8")).toContain('"observer_model": "gpt-4.1-mini"');
			} finally {
				cleanup();
				if (previous == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previous;
			}
		});

		it("accepts built-in observer providers on a clean config", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevHome = process.env.HOME;
			const tmpHome = mkdtempSync(join(tmpdir(), "codemem-home-test-"));
			process.env.CODEMEM_CONFIG = configPath;
			process.env.HOME = tmpHome;
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_provider: "anthropic" } }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.config as Record<string, unknown>).observer_provider).toBe("anthropic");
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevHome == null) delete process.env.HOME;
				else process.env.HOME = prevHome;
			}
		});

		it("clears hot-reload env override when interval key is removed", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevInterval = process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS = "12000";
			const notifyConfigChanged = vi.fn();
			const { app, cleanup } = createTestApp({ sweeper: { notifyConfigChanged } });
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { raw_events_sweeper_interval_s: null } }),
				});
				expect(res.status).toBe(200);
				expect(process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS).toBeUndefined();
				expect(notifyConfigChanged).toHaveBeenCalledTimes(1);
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevInterval == null) delete process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS;
				else process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS = prevInterval;
			}
		});

		it("returns warnings for env-overridden keys", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevModel = process.env.CODEMEM_OBSERVER_MODEL;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_OBSERVER_MODEL = "env-model";
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_model: "saved-model" } }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.effective as Record<string, unknown>).observer_model).toBe("env-model");
				expect((body.effects as Record<string, unknown>).ignored_by_env_keys).toEqual([
					"observer_model",
				]);
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevModel == null) delete process.env.CODEMEM_OBSERVER_MODEL;
				else process.env.CODEMEM_OBSERVER_MODEL = prevModel;
			}
		});

		it("validates payload types", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_headers: { Authorization: 123 } } }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("observer_headers must be object of string values");
			} finally {
				cleanup();
			}
		});

		it("rejects non-object config wrapper payloads", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: "bad" }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("config must be an object");
			} finally {
				cleanup();
			}
		});

		it("parses integer fields strictly", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_max_chars: "123abc" } }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("observer_max_chars must be int");
			} finally {
				cleanup();
			}
		});
	});

	describe("CORS middleware", () => {
		it("allows POST without Origin header (CLI/programmatic callers)", async () => {
			// Matches Python's reject_if_unsafe policy — no Origin + no suspicious
			// browser signals = CLI caller, allowed through.
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ memory_id: 1, visibility: "shared" }),
				});
				// Should NOT be 403 — CLI callers don't send Origin
				expect(res.status).not.toBe(403);
			} finally {
				cleanup();
			}
		});

		it("rejects POST without Origin but with cross-site Sec-Fetch-Site", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Sec-Fetch-Site": "cross-site",
					},
					body: JSON.stringify({ memory_id: 1, visibility: "shared" }),
				});
				expect(res.status).toBe(403);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("forbidden");
			} finally {
				cleanup();
			}
		});

		it("rejects POST with non-loopback Origin", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify({ memory_id: 1, visibility: "shared" }),
				});
				expect(res.status).toBe(403);
			} finally {
				cleanup();
			}
		});

		it("allows POST with loopback Origin", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: 999, visibility: "shared" }),
				});
				// Should get past CORS (404 or 400 expected, not 403)
				expect(res.status).not.toBe(403);
			} finally {
				cleanup();
			}
		});

		it("allows GET without Origin header", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/stats");
				expect(res.status).toBe(200);
			} finally {
				cleanup();
			}
		});

		it("returns 400 for invalid JSON on visibility updates", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/memories/visibility", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: "{bad json",
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("invalid JSON");
			} finally {
				cleanup();
			}
		});
	});

	describe("viewer HTML", () => {
		it("returns HTML at root with viewer page", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/");
				expect(res.status).toBe(200);
				const html = await res.text();
				expect(html).toContain("<title>codemem viewer</title>");
				expect(html).toContain("<!doctype html>");
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/sync/peers", () => {
		it("returns empty peers list", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				// Ensure store + actors table exist
				const _warmup = await app.request("/api/stats");
				const _store = getStore();
				const res = await app.request("/api/sync/peers");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("items");
				expect(body.redacted).toBe(true);
			} finally {
				cleanup();
			}
		});

		it("treats naive sync timestamps as UTC", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				// sync_peers table already created by initTestSchema
				const now = new Date(Date.now() - 30_000).toISOString().replace(/\.\d{3}Z$/, "");
				store.db
					.prepare(
						`INSERT INTO sync_peers (
							peer_device_id, name, last_sync_at, claimed_local_actor, created_at
						) VALUES (?, ?, ?, 0, ?)`,
					)
					.run("peer-1", "Peer One", now, now);

				const res = await app.request("/api/sync/status?diag=1");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					status: { peers: Record<string, Record<string, unknown>> };
				};
				expect(body.status.peers["peer-1"]?.peer_state).toBe("online");
				expect(body.status.peers["peer-1"]?.sync_status).toBe("ok");
			} finally {
				cleanup();
			}
		});
	});
});
