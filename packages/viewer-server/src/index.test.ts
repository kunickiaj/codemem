/**
 * Viewer-server integration tests.
 *
 * Uses initTestSchema from @codemem/core (fix #5 — no duplicated DDL).
 * Uses Record<string, unknown> instead of Record<string, any> (fix #6).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureDeviceIdentity,
	initTestSchema,
	insertTestSession,
	MemoryStore,
} from "@codemem/core";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestStore(): { store: MemoryStore; cleanup: () => void } {
	const tmpDir = mkdtempSync(join(tmpdir(), "codemem-viewer-store-test-"));
	const dbPath = join(tmpDir, "test.sqlite");
	const rawDb = new Database(dbPath);
	initTestSchema(rawDb);
	rawDb
		.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run("test-device-001", "test-public-key", "test-fingerprint", new Date().toISOString());
	rawDb.close();
	const store = new MemoryStore(dbPath);
	return {
		store,
		cleanup: () => {
			store.close();
			rmSync(tmpDir, { recursive: true, force: true });
		},
	};
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
	let storeCleanup: (() => void) | null = null;

	const app = createApp({
		sweeper: (opts?.sweeper ?? null) as never,
		storeFactory: () => {
			if (!store) {
				const created = createTestStore();
				store = created.store;
				storeCleanup = created.cleanup;
			}
			return store;
		},
	});

	return {
		app,
		getStore: () => store,
		cleanup: () => {
			storeCleanup?.();
			store = null;
			storeCleanup = null;
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

	describe("GET /api/pack", () => {
		it("uses async pack builder path", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const expected = {
					context: "semantic context",
					items: [],
					item_ids: [],
					pack_text: "",
					metrics: {
						total_items: 0,
						pack_tokens: 0,
						fallback_used: true,
						sources: { fts: 0, semantic: 0, fuzzy: 0 },
					},
				};

				const asyncSpy = vi.spyOn(store, "buildMemoryPackAsync").mockResolvedValue(expected);
				const syncSpy = vi.spyOn(store, "buildMemoryPack").mockImplementation(() => {
					throw new Error("sync pack builder should not be called");
				});

				const res = await app.request("/api/pack?context=semantic%20context");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toEqual(expected);
				expect(asyncSpy).toHaveBeenCalledTimes(1);
				expect(syncSpy).not.toHaveBeenCalled();
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/observer-status", () => {
		it("returns live observer status and suppresses stale failures after success", async () => {
			const { store, cleanup } = createTestStore();
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
				cleanup();
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

		it("exposes /v1/status sync endpoint (auth-gated)", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/v1/status");
				expect(res.status).toBe(401);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("unauthorized");
			} finally {
				cleanup();
			}
		});

		it("exposes /v1/ops sync endpoint (auth-gated)", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const getRes = await app.request("/v1/ops");
				expect(getRes.status).toBe(401);
				const postRes = await app.request("/v1/ops", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ops: [] }),
				});
				expect(postRes.status).toBe(401);
			} finally {
				cleanup();
			}
		});

		it("returns real sync config and coordinator status details", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/presence")) {
					return new Response(JSON.stringify({ ok: true, addresses: ["http://1.2.3.4:7337"] }), {
						status: 200,
					});
				}
				if (url.includes("/v1/peers")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									device_id: "peer-1",
									fingerprint: "fp1",
									addresses: ["http://10.0.0.2:7337"],
									stale: false,
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.includes("/v1/admin/join-requests")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									request_id: "req-1",
									device_id: "joiner-1",
									fingerprint: "fpj",
									status: "pending",
								},
							],
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			globalThis.fetch = fetchMock as typeof fetch;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_enabled: true,
					sync_host: "127.0.0.1",
					sync_port: 7337,
					sync_interval_s: 45,
					sync_projects_include: ["codemem"],
					sync_projects_exclude: ["junk"],
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
					sync_coordinator_admin_secret: "secret",
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				const res = await app.request("/api/sync/status?includeDiagnostics=1");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, any>;
				expect(body.enabled).toBe(true);
				expect(body.interval_s).toBe(45);
				expect(body.project_filter_active).toBe(true);
				expect(body.project_filter).toEqual({ include: ["codemem"], exclude: ["junk"] });
				expect(body.coordinator.enabled).toBe(true);
				expect(body.coordinator.configured).toBe(true);
				expect(body.coordinator.groups).toEqual(["team-a"]);
				expect(body.join_requests).toHaveLength(1);
				expect(body.join_requests[0].request_id).toBe("req-1");
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
				delete process.env.CODEMEM_SYNC_ENABLED;
			}
		});

		it("respects env-only sync configuration in status output", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevEnabled = process.env.CODEMEM_SYNC_ENABLED;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_SYNC_ENABLED = "1";
			writeFileSync(configPath, JSON.stringify({ sync_enabled: false }));
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.enabled).toBe(true);
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevEnabled == null) delete process.env.CODEMEM_SYNC_ENABLED;
				else process.env.CODEMEM_SYNC_ENABLED = prevEnabled;
			}
		});

		it("returns real legacy device and sharing review summaries", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({ sync_enabled: true, sync_projects_include: ["codemem"] }),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				store.db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("codemem", sessionId);
				store.db
					.prepare(
						"INSERT OR REPLACE INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES (?, ?, 0, 'active', ?, ?)",
					)
					.run("actor:peer", "Peer Person", new Date().toISOString(), new Date().toISOString());
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, name, actor_id, claimed_local_actor, created_at) VALUES (?, ?, ?, 0, ?)",
					)
					.run("peer-actor", "Peer Device", "actor:peer", new Date().toISOString());
				insertTestMemory(store, {
					sessionId,
					kind: "feature",
					title: "Shared memory",
					bodyText: "body",
					metadata: { source: "observer" },
				});
				store.db
					.prepare(
						`UPDATE memory_items SET actor_id = ?, actor_display_name = ?, visibility = 'shared', workspace_id = 'shared:default', trust_state = 'trusted' WHERE title = ?`,
					)
					.run(store.actorId, store.actorDisplayName, "Shared memory");
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Legacy memory",
					bodyText: "legacy",
					actorId: null,
					originDeviceId: "legacy-peer-1",
					metadata: { source: "observer" },
				});
				store.db
					.prepare(
						`UPDATE memory_items SET actor_id = NULL, actor_display_name = ?, workspace_id = ?, trust_state = 'legacy_unknown' WHERE title = ?`,
					)
					.run("Legacy synced peer", "shared:legacy", "Legacy memory");
				const res = await app.request("/api/sync/status?includeDiagnostics=1&project=codemem");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, any>;
				expect(body.legacy_devices).toHaveLength(1);
				expect(body.legacy_devices[0].origin_device_id).toBe("legacy-peer-1");
				expect(body.sharing_review).toHaveLength(1);
				expect(body.sharing_review[0].peer_device_id).toBe("peer-actor");
				expect(body.sharing_review[0].actor_display_name).toBe("Peer Person");
				expect(body.sharing_review[0].shareable_count).toBe(1);
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("creates coordinator invites through the viewer route", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/invites")) {
					return new Response(
						JSON.stringify({
							encoded: "invite-blob",
							link: "https://example.test/invite",
							payload: { group_id: "team-a" },
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			globalThis.fetch = fetchMock as typeof fetch;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
					sync_coordinator_admin_secret: "secret",
				}),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/invites/create", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ group_id: "team-a", policy: "auto_admit", ttl_hours: 24 }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.encoded).toBe("invite-blob");
				expect(body.link).toBe("https://example.test/invite");
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("imports coordinator invites through the viewer route", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const invitePayload = {
				v: 1,
				kind: "coordinator_team_invite",
				coordinator_url: "https://coord.example.test",
				group_id: "team-a",
				policy: "approval_required",
				token: "tok-123",
				expires_at: new Date(Date.now() + 86_400_000).toISOString(),
				team_name: "Team A",
			};
			const invite = Buffer.from(JSON.stringify(invitePayload), "utf8").toString("base64url");
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/join")) {
					return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			globalThis.fetch = fetchMock as typeof fetch;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			writeFileSync(configPath, JSON.stringify({ actor_display_name: "Adam" }));
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				const res = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.group_id).toBe("team-a");
				expect(body.status).toBe("pending");
				const writtenConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<
					string,
					unknown
				>;
				expect(writtenConfig.sync_coordinator_url).toBe("https://coord.example.test");
				expect(writtenConfig.sync_coordinator_group).toBe("team-a");
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("reviews join requests through the viewer route", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const requestBody = init?.body
					? JSON.parse(new TextDecoder().decode(init.body as ArrayBufferView))
					: {};
				if (url.includes("/v1/admin/join-requests/approve") && requestBody.request_id === "req-1") {
					return new Response(
						JSON.stringify({ request: { request_id: "req-1", status: "approved" } }),
						{ status: 200 },
					);
				}
				if (
					url.includes("/v1/admin/join-requests/approve") &&
					requestBody.request_id === "missing"
				) {
					return new Response(JSON.stringify({ error: "request_not_found" }), { status: 404 });
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			globalThis.fetch = fetchMock as typeof fetch;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_admin_secret: "secret",
				}),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/join-requests/review", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ request_id: "req-1", action: "approve" }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, any>;
				expect(body.ok).toBe(true);
				expect(body.request.request_id).toBe("req-1");
				expect(body.request.status).toBe("approved");

				const missing = await app.request("/api/sync/join-requests/review", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ request_id: "missing", action: "approve" }),
				});
				expect(missing.status).toBe(404);
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});
	});
});
