/**
 * Viewer-server integration tests.
 *
 * Uses initTestSchema from @codemem/core (fix #5 — no duplicated DDL).
 * Uses Record<string, unknown> instead of Record<string, any> (fix #6).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@codemem/core";
import {
	buildAuthHeaders,
	connect,
	ensureDeviceIdentity,
	initTestSchema,
	insertTestSession,
	loadPublicKey,
	MemoryStore,
	startMaintenanceJob,
	updateMaintenanceJob,
	VERSION,
} from "@codemem/core";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createApp, createSyncApp } from "./index.js";

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
		scopeId?: string | null;
	},
): number {
	const now = options.createdAt ?? new Date().toISOString();
	const result = store.db
		.prepare(
			`INSERT INTO memory_items (
				session_id, kind, title, subtitle, body_text, confidence, tags_text, active,
				created_at, updated_at, metadata_json, actor_id, actor_display_name, visibility,
				workspace_id, workspace_kind, origin_device_id, origin_source, trust_state,
				facts, narrative, concepts, files_read, files_modified, prompt_number, rev, import_key,
				scope_id
			) VALUES (?, ?, ?, NULL, ?, 0.5, '', ?, ?, ?, ?, ?, ?, 'shared', 'shared:default', 'shared', ?, ?, 'trusted', NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)`,
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
			options.scopeId ?? null,
		);
	return Number(result.lastInsertRowid);
}

/** Create a test Hono app backed by a fresh in-memory DB. */
function createTestApp(opts?: {
	sweeper?: unknown;
	syncRequestRateLimit?: {
		readLimit?: number;
		mutationLimit?: number;
		unauthenticatedReadLimit?: number;
		unauthenticatedMutationLimit?: number;
	};
	getSyncRuntimeStatus?: () => {
		phase: "starting" | "running" | "stopping" | "error" | "disabled" | null;
		detail?: string | null;
	} | null;
}) {
	let store: MemoryStore | null = null;
	let storeCleanup: (() => void) | null = null;

	const storeFactory = () => {
		if (!store) {
			const created = createTestStore();
			store = created.store;
			storeCleanup = created.cleanup;
		}
		return store;
	};

	const app = createApp({
		sweeper: (opts?.sweeper ?? null) as never,
		storeFactory,
		getSyncRuntimeStatus: opts?.getSyncRuntimeStatus,
	});

	const syncApp = createSyncApp({
		storeFactory,
		syncRequestRateLimit: opts?.syncRequestRateLimit,
	});

	return {
		app,
		syncApp,
		getStore: () => store,
		cleanup: () => {
			storeCleanup?.();
			store = null;
			storeCleanup = null;
		},
	};
}

function createAuthenticatedSyncPeer(
	store: MemoryStore,
	input: {
		url: string;
		method?: "GET" | "POST";
		bodyBytes?: Buffer;
	},
): { headers: Record<string, string>; keysDir: string; peerDeviceId: string; cleanup: () => void } {
	const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
	const peerDb = connect(join(peerDir, "peer.sqlite"));
	const peerKeysDir = join(peerDir, "keys");
	try {
		initTestSchema(peerDb);
		const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
		const peerPublicKey = loadPublicKey(peerKeysDir);
		if (!peerPublicKey) throw new Error("peer public key missing");
		const peerFingerprint = peerDb.prepare("SELECT fingerprint FROM sync_device LIMIT 1").get() as
			| { fingerprint: string }
			| undefined;
		if (!peerFingerprint?.fingerprint) throw new Error("peer fingerprint missing");
		store.db
			.prepare(
				`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(peerDeviceId, peerFingerprint.fingerprint, peerPublicKey, new Date().toISOString());
		return {
			headers: buildAuthHeaders({
				deviceId: peerDeviceId,
				method: input.method ?? "GET",
				url: input.url,
				bodyBytes: input.bodyBytes ?? Buffer.alloc(0),
				keysDir: peerKeysDir,
			}),
			keysDir: peerKeysDir,
			peerDeviceId,
			cleanup: () => {
				peerDb.close();
				rmSync(peerDir, { recursive: true, force: true });
			},
		};
	} catch (err) {
		peerDb.close();
		rmSync(peerDir, { recursive: true, force: true });
		throw err;
	}
}

function grantSyncScopeToDevices(store: MemoryStore, scopeId: string, deviceIds: string[]): void {
	const now = "2026-01-01T00:00:00Z";
	store.db
		.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)
			 ON CONFLICT(scope_id) DO UPDATE SET updated_at = excluded.updated_at`,
		)
		.run(scopeId, scopeId, now, now);
	for (const deviceId of deviceIds) {
		store.db
			.prepare(
				`INSERT INTO scope_memberships(
					scope_id, device_id, role, status, membership_epoch, updated_at
				 ) VALUES (?, ?, 'member', 'active', 1, ?)
				 ON CONFLICT(scope_id, device_id) DO UPDATE SET updated_at = excluded.updated_at`,
			)
			.run(scopeId, deviceId, now);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("viewer-server", () => {
	it("createApp fails with a clear build hint when viewer assets are missing", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-viewer-static-missing-"));
		const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
		process.env.CODEMEM_VIEWER_STATIC_DIR = tmpDir;
		try {
			expect(() =>
				createApp({
					storeFactory: () => createTestStore().store,
				}),
			).toThrow(/Run `pnpm build` from the repo root before starting the viewer\./);
		} finally {
			if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
			else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("sync UI api routes all exist in the viewer sync router", () => {
		const root = join(import.meta.dirname, "../../..");
		const apiSource = readFileSync(join(root, "packages/ui/src/lib/api.ts"), "utf8");
		const routeSource = readFileSync(
			join(root, "packages/viewer-server/src/routes/sync.ts"),
			"utf8",
		);
		const uiRoutes = [
			...apiSource.matchAll(/fetch\('(\/api\/sync\/[^']+)'/g),
			...apiSource.matchAll(/fetchJson\('(\/api\/sync\/[^']+)'/g),
		].map((match) => match[1]);
		const concreteServerRoutes = [
			...routeSource.matchAll(/app\.(?:get|post|delete)\("(\/api\/sync\/[^"]+)"/g),
		].map((match) => match[1]);
		const normalizedServerRoutes = new Set(
			concreteServerRoutes.map((route) => route.replace(/:\w+/g, "__param__")),
		);
		expect(
			uiRoutes
				.map((route) => route.replace(/\?.*$/, ""))
				.map((route) => route.replace(/`\$\{[^}]+\}`/g, "__param__"))
				.every((route) => normalizedServerRoutes.has(route)),
		).toBe(true);
	});

	describe("GET /api/stats", () => {
		it("returns database stats", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/stats");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toHaveProperty("database");
				expect(typeof body.viewer_pid).toBe("number");
				const db = body.database as Record<string, unknown>;
				expect(db).toHaveProperty("path");
				expect(db).toHaveProperty("sessions");
				expect(db).toHaveProperty("memory_items");
			} finally {
				cleanup();
			}
		});

		it("counts only visible memory scopes in memory stats", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Visible stats memory",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Hidden stats memory",
					scopeId: "unauthorized-team",
				});

				const res = await app.request("/api/stats");
				expect(res.status).toBe(200);
				const body = (await res.json()) as { database: Record<string, number> };
				expect(body.database.memory_items).toBe(1);
				expect(body.database.active_memory_items).toBe(1);
			} finally {
				cleanup();
			}
		});

		it("keeps active maintenance jobs in stable started order", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				startMaintenanceJob(store.db, {
					kind: "job-a",
					title: "Job A",
					message: "A",
					progressTotal: 10,
				});
				startMaintenanceJob(store.db, {
					kind: "job-b",
					title: "Job B",
					message: "B",
					progressTotal: 10,
				});
				updateMaintenanceJob(store.db, "job-b", {
					message: "B updated",
					progressCurrent: 5,
				});

				const res = await app.request("/api/stats");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const jobs = body.maintenance_jobs as Array<Record<string, unknown>>;
				expect(jobs.map((job) => job.kind)).toEqual(["job-a", "job-b"]);
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/runtime", () => {
		it("returns viewer runtime version info", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/runtime");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.version).toBe(VERSION);
				expect(body).not.toHaveProperty("commit");
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/usage", () => {
		it("returns recent pack rows for the current scope", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				store.db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("codemem", sessionId);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Usage-visible memory",
				});
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 123, 0, 456, ?, ?)`,
					)
					.run(
						sessionId,
						"2026-03-26T23:30:00Z",
						JSON.stringify({ pack_tokens: 123, exact_duplicates_collapsed: 4 }),
					);

				const res = await app.request("/api/usage?project=codemem");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const recentPacks = body.recent_packs as Array<Record<string, unknown>>;
				expect(recentPacks).toHaveLength(1);
				expect(recentPacks[0]).toMatchObject({
					session_id: sessionId,
					event: "pack",
					tokens_read: 123,
					tokens_saved: 456,
				});
				expect(recentPacks[0]?.metadata_json).toMatchObject({
					exact_duplicates_collapsed: 4,
				});
			} finally {
				cleanup();
			}
		});

		it("removes hidden memory ids from recent pack metadata", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const sessionId = insertTestSession(store.db);
				const visibleId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Visible pack item",
					scopeId: "authorized-team",
				});
				const hiddenId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Hidden pack item",
					scopeId: "unauthorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 123, 0, 456, ?, ?)`,
					)
					.run(
						sessionId,
						"2026-03-26T23:30:00Z",
						JSON.stringify({
							pack_item_ids: [visibleId, hiddenId],
							added_ids: [visibleId, hiddenId],
							removed_ids: [hiddenId],
							retained_ids: [String(visibleId), String(hiddenId)],
						}),
					);
				const hiddenSessionId = insertTestSession(store.db);
				const hiddenOnlyId = insertTestMemory(store, {
					sessionId: hiddenSessionId,
					kind: "discovery",
					title: "Hidden only pack item",
					scopeId: "unauthorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 999, 0, 999, ?, ?)`,
					)
					.run(
						hiddenSessionId,
						"2026-03-27T23:30:00Z",
						JSON.stringify({ pack_item_ids: [hiddenOnlyId], project: "secret-project" }),
					);

				const res = await app.request("/api/usage");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					recent_packs: Array<{ metadata_json: unknown }>;
					totals: { count: number; tokens_read: number; tokens_saved: number };
				};
				expect(body.recent_packs).toHaveLength(1);
				expect(body.totals).toMatchObject({ count: 1, tokens_read: 123, tokens_saved: 456 });
				expect(body.recent_packs[0]?.metadata_json).toMatchObject({
					pack_item_ids: [visibleId],
					added_ids: [visibleId],
					removed_ids: [],
					retained_ids: [visibleId],
				});
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
					const sessionId = insertTestSession(store.db);
					insertTestMemory(store, {
						sessionId,
						kind: "discovery",
						title: "Visible session memory",
					});
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

		it("only lists projects backed by visible memory scopes", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);

				const visibleSessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("visible-project", visibleSessionId);
				insertTestMemory(store, {
					sessionId: visibleSessionId,
					kind: "discovery",
					title: "Visible scoped memory",
					scopeId: "authorized-team",
				});

				const hiddenSessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("secret-project", hiddenSessionId);
				insertTestMemory(store, {
					sessionId: hiddenSessionId,
					kind: "discovery",
					title: "Hidden scoped memory",
					scopeId: "unauthorized-team",
				});

				const projectsRes = await app.request("/api/projects");
				expect(projectsRes.status).toBe(200);
				const projectsBody = (await projectsRes.json()) as { projects: string[] };
				expect(projectsBody.projects).toEqual(["visible-project"]);

				const sessionsRes = await app.request("/api/sessions");
				expect(sessionsRes.status).toBe(200);
				const sessionsBody = (await sessionsRes.json()) as {
					items: Array<{ id: number; project: string }>;
				};
				expect(sessionsBody.items.map((item) => item.id)).toEqual([visibleSessionId]);
			} finally {
				cleanup();
			}
		});
	});

	describe("memory feed routes", () => {
		it("applies sharing-domain visibility to memory list endpoints", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const sessionId = insertTestSession(store.db);

				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Visible observation",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Hidden observation",
					scopeId: "unauthorized-team",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Visible summary",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Hidden summary",
					scopeId: "unauthorized-team",
				});

				const observationsRes = await app.request("/api/observations");
				expect(observationsRes.status).toBe(200);
				const observations = (await observationsRes.json()) as {
					items: Array<{ title: string }>;
				};
				expect(observations.items.map((item) => item.title)).toEqual(["Visible observation"]);

				const summariesRes = await app.request("/api/summaries");
				expect(summariesRes.status).toBe(200);
				const summaries = (await summariesRes.json()) as { items: Array<{ title: string }> };
				expect(summaries.items.map((item) => item.title)).toEqual(["Visible summary"]);

				const memoryRes = await app.request("/api/memory?limit=10");
				expect(memoryRes.status).toBe(200);
				const memory = (await memoryRes.json()) as { items: Array<{ title: string }> };
				expect(memory.items.map((item) => item.title).sort()).toEqual([
					"Visible observation",
					"Visible summary",
				]);
			} finally {
				cleanup();
			}
		});

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
				const mineItems = (
					(await mineRes.json()) as { items: Array<{ title: string; owned_by_self?: boolean }> }
				).items;
				expect(mineItems.map((item) => item.title)).toEqual(["Mine"]);
				expect(mineItems[0]?.owned_by_self).toBe(true);

				const theirsRes = await app.request("/api/observations?scope=theirs");
				expect(theirsRes.status).toBe(200);
				const theirsItems = (
					(await theirsRes.json()) as { items: Array<{ title: string; owned_by_self?: boolean }> }
				).items;
				expect(theirsItems.map((item) => item.title).sort()).toEqual([
					"Null owned fields",
					"Theirs",
				]);
				expect(theirsItems.every((item) => item.owned_by_self === false)).toBe(true);
			} finally {
				cleanup();
			}
		});

		it("moves an owned memory to a new project via /api/memories/project", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Memory on wrong project",
				});

				const res = await app.request("/api/memories/project", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId, project: "new-project" }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					session_id: number;
					project: string;
					moved_memory_count: number;
				};
				expect(body.project).toBe("new-project");
				expect(body.session_id).toBe(sessionId);
				expect(body.moved_memory_count).toBe(1);

				const row = store.db
					.prepare("SELECT project FROM sessions WHERE id = ?")
					.get(sessionId) as { project: string };
				expect(row.project).toBe("new-project");
			} finally {
				cleanup();
			}
		});

		it("rejects /api/memories/project with empty project", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Memory",
				});

				const res = await app.request("/api/memories/project", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId, project: "   " }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as { error?: string };
				expect(body.error).toContain("project");
			} finally {
				cleanup();
			}
		});

		it("does not mutate memories outside visible sharing domains", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("secret-project", sessionId);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Hidden local-owned memory",
					scopeId: "unauthorized-team",
				});

				for (const [path, body] of [
					["/api/memories/project", { memory_id: memoryId, project: "new-project" }],
					["/api/memories/visibility", { memory_id: memoryId, visibility: "private" }],
					["/api/memories/forget", { memory_id: memoryId }],
				] as const) {
					const res = await app.request(path, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Origin: "http://127.0.0.1:38888",
						},
						body: JSON.stringify(body),
					});
					expect(res.status).toBe(404);
					expect(await res.json()).toEqual({ error: "memory not found" });
				}

				const row = store.db
					.prepare(
						`SELECT memory_items.active, memory_items.visibility, sessions.project
						 FROM memory_items JOIN sessions ON sessions.id = memory_items.session_id
						 WHERE memory_items.id = ?`,
					)
					.get(memoryId) as { active: number; visibility: string; project: string };
				expect(row).toMatchObject({ active: 1, visibility: "shared", project: "secret-project" });
			} finally {
				cleanup();
			}
		});

		it("forgets an owned memory via the viewer API", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "bugfix",
					title: "Owned memory",
				});

				const forgetRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId }),
				});
				expect(forgetRes.status).toBe(200);
				expect(await forgetRes.json()).toEqual({ status: "ok" });

				const observationsRes = await app.request("/api/observations");
				expect(observationsRes.status).toBe(200);
				const observations = (
					(await observationsRes.json()) as { items: Array<{ id?: number; title: string }> }
				).items;
				expect(observations.map((item) => item.title)).not.toContain("Owned memory");

				const row = store.db
					.prepare("SELECT active, deleted_at FROM memory_items WHERE id = ?")
					.get(memoryId) as { active: number; deleted_at: string | null };
				expect(row.active).toBe(0);
				expect(row.deleted_at).toBeTruthy();
			} finally {
				cleanup();
			}
		});

		it("treats repeated forget requests as a no-op success", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Already forgotten",
				});

				const firstRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId }),
				});
				expect(firstRes.status).toBe(200);

				const rowAfterFirstForget = store.db
					.prepare("SELECT rev, deleted_at FROM memory_items WHERE id = ?")
					.get(memoryId) as { rev: number; deleted_at: string | null };

				const secondRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId }),
				});
				expect(secondRes.status).toBe(200);
				expect(await secondRes.json()).toEqual({ status: "ok" });

				const rowAfterSecondForget = store.db
					.prepare("SELECT rev, deleted_at FROM memory_items WHERE id = ?")
					.get(memoryId) as { rev: number; deleted_at: string | null };
				expect(rowAfterSecondForget.rev).toBe(rowAfterFirstForget.rev);
				expect(rowAfterSecondForget.deleted_at).toBe(rowAfterFirstForget.deleted_at);
			} finally {
				cleanup();
			}
		});

		it("rejects forgetting a memory not owned by this device", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "feature",
					title: "Peer memory",
					actorId: "peer:other",
					originDeviceId: "peer-device-002",
				});

				const forgetRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId }),
				});
				expect(forgetRes.status).toBe(403);
				const body = (await forgetRes.json()) as { error: string };
				expect(body.error).toBe("memory not owned by this device");
			} finally {
				cleanup();
			}
		});

		it("treats metadata-only local provenance as owned for forget requests", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "decision",
					title: "Metadata-owned memory",
					actorId: null,
					originDeviceId: null,
					metadata: {
						actor_id: "local:test-device-001",
						origin_device_id: "test-device-001",
					},
				});

				const forgetRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: memoryId }),
				});
				expect(forgetRes.status).toBe(200);
				expect(await forgetRes.json()).toEqual({ status: "ok" });
			} finally {
				cleanup();
			}
		});

		it("validates forget requests", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const invalidIdRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: "abc" }),
				});
				expect(invalidIdRes.status).toBe(400);
				expect(await invalidIdRes.json()).toEqual({ error: "memory_id must be int" });

				const missingRes = await app.request("/api/memories/forget", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({ memory_id: 99999 }),
				});
				expect(missingRes.status).toBe(404);
				expect(await missingRes.json()).toEqual({ error: "memory not found" });
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

				const aliasLocation = aliasRes.headers.get("location");
				if (!aliasLocation) throw new Error("expected alias redirect to include Location header");
				const res = await app.request(aliasLocation);
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
				expect(new Set(summaries.map((item) => item.kind))).toEqual(new Set(["session_summary"]));

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

		it("excludes hidden sharing domains from session memory counts", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Visible count memory",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Hidden count memory",
					scopeId: "unauthorized-team",
				});

				const res = await app.request("/api/session");
				expect(res.status).toBe(200);
				const body = (await res.json()) as { memories: number; observations: number };
				expect(body.memories).toBe(1);
				expect(body.observations).toBe(1);
			} finally {
				cleanup();
			}
		});

		it("gates prompt and artifact aggregate counts by visible memory sessions", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);

				const seedProjectSession = (project: string, scopeId: string) => {
					const sessionId = insertTestSession(store.db);
					store.db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run(project, sessionId);
					insertTestMemory(store, {
						sessionId,
						kind: "discovery",
						title: `${project} memory`,
						scopeId,
					});
					store.db
						.prepare(
							`INSERT INTO user_prompts(session_id, project, prompt_text, created_at, created_at_epoch, metadata_json)
							 VALUES (?, ?, 'prompt', ?, 0, '{}')`,
						)
						.run(sessionId, project, "2026-01-01T00:00:00Z");
					store.db
						.prepare(
							`INSERT INTO artifacts(session_id, kind, path, content_text, content_hash, created_at, metadata_json)
							 VALUES (?, 'note', ?, 'artifact', 'hash', ?, '{}')`,
						)
						.run(sessionId, `${project}.txt`, "2026-01-01T00:00:00Z");
				};

				seedProjectSession("visible-project", "authorized-team");
				seedProjectSession("secret-project", "unauthorized-team");

				const hiddenRes = await app.request("/api/session?project=secret-project");
				expect(hiddenRes.status).toBe(200);
				expect(await hiddenRes.json()).toMatchObject({
					artifacts: 0,
					memories: 0,
					observations: 0,
					prompts: 0,
					total: 0,
				});

				const visibleRes = await app.request("/api/session?project=visible-project");
				expect(visibleRes.status).toBe(200);
				expect(await visibleRes.json()).toMatchObject({
					artifacts: 1,
					memories: 1,
					observations: 1,
					prompts: 1,
					total: 3,
				});
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

	describe("GET /api/artifacts", () => {
		it("requires a visible memory in the session before returning local artifacts", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);

				const visibleSessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId: visibleSessionId,
					kind: "discovery",
					title: "Visible artifact session memory",
					scopeId: "authorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO artifacts(session_id, kind, path, content_text, content_hash, created_at, metadata_json)
						 VALUES (?, 'note', 'visible.txt', 'visible artifact', 'visible-hash', ?, '{}')`,
					)
					.run(visibleSessionId, "2026-01-01T00:00:00Z");

				const hiddenSessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId: hiddenSessionId,
					kind: "discovery",
					title: "Hidden artifact session memory",
					scopeId: "unauthorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO artifacts(session_id, kind, path, content_text, content_hash, created_at, metadata_json)
						 VALUES (?, 'note', 'hidden.txt', 'hidden artifact', 'hidden-hash', ?, '{}')`,
					)
					.run(hiddenSessionId, "2026-01-01T00:00:00Z");

				const mixedSessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId: mixedSessionId,
					kind: "discovery",
					title: "Mixed visible artifact memory",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId: mixedSessionId,
					kind: "discovery",
					title: "Mixed hidden artifact memory",
					scopeId: "unauthorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO artifacts(session_id, kind, path, content_text, content_hash, created_at, metadata_json)
						 VALUES (?, 'note', 'mixed.txt', 'mixed artifact', 'mixed-hash', ?, '{}')`,
					)
					.run(mixedSessionId, "2026-01-01T00:00:00Z");

				const visibleRes = await app.request(`/api/artifacts?session_id=${visibleSessionId}`);
				expect(visibleRes.status).toBe(200);
				const visibleBody = (await visibleRes.json()) as { items: Array<{ path: string }> };
				expect(visibleBody.items.map((item) => item.path)).toEqual(["visible.txt"]);

				const hiddenRes = await app.request(`/api/artifacts?session_id=${hiddenSessionId}`);
				expect(hiddenRes.status).toBe(404);
				expect(await hiddenRes.json()).toEqual({ error: "session not found" });

				const mixedRes = await app.request(`/api/artifacts?session_id=${mixedSessionId}`);
				expect(mixedRes.status).toBe(404);
				expect(await mixedRes.json()).toEqual({ error: "session not found" });
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
						fallback: "recent" as const,
						limit: 10,
						token_budget: null,
						project: null,
						pack_item_ids: [],
						mode: "default" as const,
						added_ids: [],
						removed_ids: [],
						retained_ids: [],
						pack_token_delta: 0,
						pack_delta_available: false,
						work_tokens: 0,
						work_tokens_unique: 0,
						tokens_saved: 0,
						compression_ratio: null,
						overhead_tokens: null,
						avoided_work_tokens: 0,
						avoided_work_saved: 0,
						avoided_work_ratio: null,
						avoided_work_known_items: 0,
						avoided_work_unknown_items: 0,
						avoided_work_sources: {},
						work_source: "estimate" as const,
						work_usage_items: 0,
						work_estimate_items: 0,
						savings_reliable: true,
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

	describe("POST /api/pack/trace", () => {
		it("uses async pack trace builder path", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const expected = {
					version: 1 as const,
					inputs: {
						query: "semantic context",
						project: "test-project",
						working_set_files: ["packages/ui/src/app.ts"],
						token_budget: null,
						limit: 10,
					},
					mode: {
						selected: "task" as const,
						reasons: ["query matched task hints"],
					},
					retrieval: {
						candidate_count: 0,
						candidates: [],
					},
					assembly: {
						deduped_ids: [],
						collapsed_groups: [],
						trimmed_ids: [],
						trim_reasons: [],
						sections: {
							summary: [],
							timeline: [],
							observations: [],
						},
					},
					output: {
						estimated_tokens: 0,
						truncated: false,
						section_counts: {
							summary: 0,
							timeline: 0,
							observations: 0,
						},
						pack_text: "",
					},
				};

				const asyncSpy = vi.spyOn(store, "buildMemoryPackTraceAsync").mockResolvedValue(expected);

				const res = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						context: "semantic context",
						project: "test-project",
						working_set_files: ["packages/ui/src/app.ts"],
					}),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toEqual(expected);
				expect(asyncSpy).toHaveBeenCalledTimes(1);
				expect(asyncSpy).toHaveBeenCalledWith("semantic context", 10, null, {
					project: "test-project",
					working_set_paths: ["packages/ui/src/app.ts"],
				});
			} finally {
				cleanup();
			}
		});

		it("rejects invalid trace payloads", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const invalidJson = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{not-json",
				});
				expect(invalidJson.status).toBe(400);
				expect(await invalidJson.json()).toEqual({ error: "invalid json body" });

				const missingContext = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ project: "test-project" }),
				});
				expect(missingContext.status).toBe(400);
				expect(await missingContext.json()).toEqual({ error: "context required" });

				const nonStringContext = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ context: { bad: true } }),
				});
				expect(nonStringContext.status).toBe(400);
				expect(await nonStringContext.json()).toEqual({ error: "context required" });

				const badLimit = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ context: "semantic context", limit: 3.5 }),
				});
				expect(badLimit.status).toBe(400);
				expect(await badLimit.json()).toEqual({ error: "limit must be a positive int" });

				const badBudget = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ context: "semantic context", token_budget: 2.5 }),
				});
				expect(badBudget.status).toBe(400);
				expect(await badBudget.json()).toEqual({ error: "token_budget must be int" });

				const badWorkingSet = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						context: "semantic context",
						working_set_files: "packages/ui/src/app.ts",
					}),
				});
				expect(badWorkingSet.status).toBe(400);
				expect(await badWorkingSet.json()).toEqual({
					error: "working_set_files must be an array of strings",
				});

				const mixedWorkingSet = await app.request("/api/pack/trace", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						context: "semantic context",
						working_set_files: ["packages/ui/src/app.ts", 123],
					}),
				});
				expect(mixedWorkingSet.status).toBe(400);
				expect(await mixedWorkingSet.json()).toEqual({
					error: "working_set_files must be an array of strings",
				});
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

		it("redacts sensitive config values from config responses", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = "coord-secret";
			writeFileSync(
				configPath,
				JSON.stringify({
					observer_auth_file: "~/.codemem/token.txt",
					observer_auth_command: ["print-token"],
					observer_headers: { Authorization: "Bearer abc" },
				}),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const config = body.config as Record<string, unknown>;
				const effective = body.effective as Record<string, unknown>;
				expect(config.observer_auth_file).toBe("[redacted]");
				expect(config.observer_auth_command).toBe("[redacted]");
				expect(config.observer_headers).toBe("[redacted]");
				expect(effective.sync_coordinator_admin_secret).toBe("[redacted]");
				expect(body.protected_keys).toEqual(
					expect.arrayContaining([
						"claude_command",
						"observer_auth_file",
						"observer_auth_command",
						"observer_headers",
						"observer_base_url",
						"sync_coordinator_url",
					]),
				);
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = prevSecret;
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

		it("returns tiered observer routing fields from config", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previous = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({
					observer_tier_routing_enabled: true,
					observer_simple_model: "gpt-5.4-mini",
					observer_rich_model: "gpt-5.4",
				}),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const config = body.config as Record<string, unknown>;
				const effective = body.effective as Record<string, unknown>;
				expect(config.observer_tier_routing_enabled).toBe(true);
				expect(config.observer_simple_model).toBe("gpt-5.4-mini");
				expect(config.observer_rich_model).toBe("gpt-5.4");
				expect(config).not.toHaveProperty("observer_rich_openai_use_responses");
				expect(effective.observer_tier_routing_enabled).toBe(true);
			} finally {
				cleanup();
				if (previous == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previous;
			}
		});

		it("writes tiered observer routing config", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previous = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(configPath, JSON.stringify({ observer_rich_openai_use_responses: true }));
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({
						config: {
							observer_tier_routing_enabled: true,
							observer_simple_model: "gpt-5.4-mini",
							observer_simple_temperature: 0.2,
							observer_rich_model: "gpt-5.4",
							observer_rich_temperature: 0.1,
							observer_rich_reasoning_effort: "medium",
							observer_rich_reasoning_summary: "auto",
							observer_rich_max_output_tokens: 12000,
						},
					}),
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const config = body.config as Record<string, unknown>;
				expect(config.observer_tier_routing_enabled).toBe(true);
				expect(config).not.toHaveProperty("observer_rich_openai_use_responses");
				const saved = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
				expect(saved).not.toHaveProperty("observer_rich_openai_use_responses");
				expect(saved.observer_simple_temperature).toBe(0.2);
				expect(saved.observer_rich_temperature).toBe(0.1);
				expect(saved.observer_rich_max_output_tokens).toBe(12000);
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
					body: JSON.stringify({ config: { sync_enabled: "yes" } }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("sync_enabled must be boolean");
			} finally {
				cleanup();
			}
		});

		it("rejects invalid tiered observer routing values", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_simple_temperature: "hot" } }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("observer_simple_temperature must be non-negative number");
			} finally {
				cleanup();
			}
		});

		it("rejects protected config mutations from the viewer API", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_auth_command: ["print-token"] } }),
				});
				expect(res.status).toBe(403);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe(
					"observer_auth_command cannot be changed from the viewer API; edit the config file or environment instead",
				);
			} finally {
				cleanup();
			}
		});

		it("ignores unchanged protected keys during full config saves", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previous = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({
					observer_model: "old-model",
					observer_auth_command: ["print-token"],
					sync_coordinator_url: "https://coord.example.test",
				}),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({
						config: {
							observer_model: "new-model",
							observer_auth_command: "[redacted]",
							sync_coordinator_url: "https://coord.example.test",
						},
					}),
				});
				expect(res.status).toBe(200);
				const saved = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
				expect(saved.observer_model).toBe("new-model");
				expect(saved.observer_auth_command).toEqual(["print-token"]);
				expect(saved.sync_coordinator_url).toBe("https://coord.example.test");
			} finally {
				cleanup();
				if (previous == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previous;
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

		it("surfaces inbound scope-rejection summary per peer", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(
						`INSERT INTO sync_peers (
							peer_device_id, name, claimed_local_actor, created_at
						) VALUES (?, ?, 0, ?)`,
					)
					.run("peer-rej", "Peer Rej", new Date().toISOString());
				store.db.exec(`
					CREATE TABLE IF NOT EXISTS sync_scope_rejections (
						id INTEGER PRIMARY KEY AUTOINCREMENT,
						peer_device_id TEXT,
						op_id TEXT NOT NULL,
						entity_type TEXT NOT NULL,
						entity_id TEXT NOT NULL,
						scope_id TEXT,
						reason TEXT NOT NULL,
						created_at TEXT NOT NULL
					);
				`);
				const recent = new Date().toISOString();
				const insert = store.db.prepare(
					`INSERT INTO sync_scope_rejections(
						peer_device_id, op_id, entity_type, entity_id, scope_id, reason, created_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				);
				insert.run(
					"peer-rej",
					"op-1",
					"memory_item",
					"key:a",
					"acme-work",
					"missing_scope",
					recent,
				);
				insert.run(
					"peer-rej",
					"op-2",
					"memory_item",
					"key:b",
					"acme-work",
					"missing_scope",
					recent,
				);
				insert.run("peer-rej", "op-3", "memory_item", "key:c", "acme-work", "stale_epoch", recent);

				const res = await app.request("/api/sync/peers");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					items: Array<{
						peer_device_id: string;
						scope_rejections: {
							total: number;
							by_reason: Record<string, number>;
							last_at: string | null;
						};
					}>;
				};
				const peer = body.items.find((p) => p.peer_device_id === "peer-rej");
				expect(peer?.scope_rejections.total).toBe(3);
				expect(peer?.scope_rejections.by_reason).toEqual({
					missing_scope: 2,
					stale_epoch: 1,
				});
				expect(peer?.scope_rejections.last_at).toBe(recent);
			} finally {
				cleanup();
			}
		});

		it("returns scope-rejection records for a peer without exposing payloads", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db.exec(`
					CREATE TABLE IF NOT EXISTS sync_scope_rejections (
						id INTEGER PRIMARY KEY AUTOINCREMENT,
						peer_device_id TEXT,
						op_id TEXT NOT NULL,
						entity_type TEXT NOT NULL,
						entity_id TEXT NOT NULL,
						scope_id TEXT,
						reason TEXT NOT NULL,
						created_at TEXT NOT NULL
					);
				`);
				const insert = store.db.prepare(
					`INSERT INTO sync_scope_rejections(
						peer_device_id, op_id, entity_type, entity_id, scope_id, reason, created_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				);
				const now = new Date().toISOString();
				insert.run("peer-x", "op-old", "memory_item", "key:1", "acme", "missing_scope", now);
				insert.run("peer-x", "op-new", "memory_item", "key:2", "acme", "stale_epoch", now);
				insert.run("peer-y", "op-other", "memory_item", "key:3", "other", "scope_mismatch", now);

				const res = await app.request("/api/sync/peers/peer-x/scope-rejections");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					peer_device_id: string;
					summary: { total: number; by_reason: Record<string, number> };
					items: Array<Record<string, unknown>>;
				};
				expect(body.peer_device_id).toBe("peer-x");
				expect(body.summary.total).toBe(2);
				expect(body.summary.by_reason).toEqual({
					missing_scope: 1,
					stale_epoch: 1,
				});
				expect(body.items).toHaveLength(2);
				for (const item of body.items) {
					expect(item).not.toHaveProperty("payload_json");
					expect(item.peer_device_id).toBe("peer-x");
				}
			} finally {
				cleanup();
			}
		});

		it("rejects scope-rejections lookup with missing peer id", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/peers/%20/scope-rejections");
				expect(res.status).toBe(400);
				const body = (await res.json()) as { error: string };
				expect(body.error).toBe("missing_peer_device_id");
			} finally {
				cleanup();
			}
		});

		it("clamps absurd sinceMinutes values instead of throwing on Date overflow", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				// Number.MAX_SAFE_INTEGER minutes would push the computed
				// timestamp past the JS Date range and make toISOString()
				// throw RangeError → 500. The handler must clamp first.
				const res = await app.request(
					`/api/sync/peers/peer-x/scope-rejections?sinceMinutes=${Number.MAX_SAFE_INTEGER}`,
				);
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					summary: { total: number };
					items: unknown[];
				};
				expect(body.summary.total).toBe(0);
				expect(body.items).toEqual([]);
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

		it("does not expose /v1/status on viewer app (moved to sync listener)", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/v1/status");
				// Should return SPA fallback (200 html), not 401 — route is gone from viewer
				expect(res.status).toBe(200);
				const ct = res.headers.get("content-type") ?? "";
				expect(ct).toContain("text/html");
			} finally {
				cleanup();
			}
		});

		it("exposes /v1/status on sync app (auth-gated)", async () => {
			const { syncApp, cleanup } = createTestApp();
			try {
				const res = await syncApp.request("/v1/status");
				expect(res.status).toBe(401);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("unauthorized");
			} finally {
				cleanup();
			}
		});

		it("allows /v1/status with a valid bootstrap grant", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-bootstrap-grant-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			let peerDeviceIdValue = "";
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/bootstrap-grants/grant-1")) {
					return new Response(
						JSON.stringify({
							grant: {
								grant_id: "grant-1",
								group_id: "g1",
								seed_device_id: "test-device-001",
								worker_device_id: peerDeviceIdValue,
								expires_at: "2099-01-01T00:00:00Z",
								created_at: "2026-01-01T00:00:00Z",
								created_by: "admin",
								revoked_at: null,
							},
							worker_enrollment: {
								group_id: "g1",
								device_id: peerDeviceIdValue,
								public_key: peerPublicKeyValue,
								fingerprint: peerFingerprintValue,
								display_name: "Peer Bootstrap",
								enabled: 1,
								created_at: "2026-01-01T00:00:00Z",
							},
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			let peerPublicKeyValue = "";
			let peerFingerprintValue = "";
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const peerDb = connect(peerDbPath);
				try {
					initTestSchema(peerDb);
					const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
					peerDeviceIdValue = peerDeviceId;
					peerPublicKeyValue = loadPublicKey(peerKeysDir) ?? "";
					const peerFingerprint = peerDb
						.prepare("SELECT fingerprint FROM sync_device LIMIT 1")
						.get() as { fingerprint: string } | undefined;
					peerFingerprintValue = peerFingerprint?.fingerprint ?? "";
					const url = "http://localhost/v1/status";
					const headers = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peerKeysDir,
						bootstrapGrantId: "grant-1",
					});
					const res = await syncApp.request(url, { headers });
					expect(res.status).toBe(200);
				} finally {
					peerDb.close();
				}
			} finally {
				cleanup();
				rmSync(peerDir, { recursive: true, force: true });
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
			}
		});

		it("rate limits repeated sync listener requests", async () => {
			const { syncApp, cleanup } = createTestApp({
				syncRequestRateLimit: { unauthenticatedReadLimit: 1 },
			});
			try {
				expect((await syncApp.request("/v1/status")).status).toBe(401);
				const limited = await syncApp.request("/v1/status");
				expect(limited.status).toBe(429);
				expect(limited.headers.get("retry-after")).toBeTruthy();
				expect(await limited.json()).toEqual({
					error: "rate_limited",
					retry_after_s: expect.any(Number),
				});
			} finally {
				cleanup();
			}
		});

		it("does not let unauthorized sync requests consume a verified peer bucket", async () => {
			const { syncApp, getStore, cleanup } = createTestApp({
				syncRequestRateLimit: { readLimit: 1, unauthenticatedReadLimit: 1 },
			});
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				expect((await syncApp.request("/v1/status")).status).toBe(401);
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const peerDb = connect(peerDbPath);
				try {
					initTestSchema(peerDb);
					const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
					const peerPublicKey = loadPublicKey(peerKeysDir);
					if (!peerPublicKey) throw new Error("peer public key missing");
					const peerFingerprint = peerDb
						.prepare("SELECT fingerprint FROM sync_device LIMIT 1")
						.get() as { fingerprint: string } | undefined;
					if (!peerFingerprint?.fingerprint) throw new Error("peer fingerprint missing");

					store.db
						.prepare(
							`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
							 VALUES (?, ?, ?, ?)`,
						)
						.run(
							peerDeviceId,
							peerFingerprint.fingerprint,
							peerPublicKey,
							new Date().toISOString(),
						);

					const url = "http://localhost/v1/status";
					const headers = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peerKeysDir,
					});

					const res = await syncApp.request(url, { headers });
					expect(res.status).toBe(200);
					const body = (await res.json()) as Record<string, unknown>;
					expect(body.protocol_version).toBe("2");
					expect(body.sync_capability).toBe("aware");
					expect(body.sync_reset).toMatchObject({ scope_id: null });
				} finally {
					peerDb.close();
				}
			} finally {
				cleanup();
				rmSync(peerDir, { recursive: true, force: true });
			}
		});

		it("exposes /v1/ops on sync app (auth-gated)", async () => {
			const { syncApp, cleanup } = createTestApp();
			try {
				const getRes = await syncApp.request("/v1/ops");
				expect(getRes.status).toBe(401);
				const postRes = await syncApp.request("/v1/ops", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ops: [] }),
				});
				expect(postRes.status).toBe(401);
			} finally {
				cleanup();
			}
		});

		it("does not allow a bootstrap grant to access /v1/ops", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-bootstrap-grant-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			let peerDeviceIdValue = "";
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/bootstrap-grants/grant-1")) {
					return new Response(
						JSON.stringify({
							grant: {
								grant_id: "grant-1",
								group_id: "g1",
								seed_device_id: "test-device-001",
								worker_device_id: peerDeviceIdValue,
								expires_at: "2099-01-01T00:00:00Z",
								created_at: "2026-01-01T00:00:00Z",
								created_by: "admin",
								revoked_at: null,
							},
							worker_enrollment: {
								group_id: "g1",
								device_id: peerDeviceIdValue,
								public_key: peerPublicKeyValue,
								fingerprint: peerFingerprintValue,
								display_name: "Peer Bootstrap",
								enabled: 1,
								created_at: "2026-01-01T00:00:00Z",
							},
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			let peerPublicKeyValue = "";
			let peerFingerprintValue = "";
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const peerDb = connect(peerDbPath);
				try {
					initTestSchema(peerDb);
					const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
					peerDeviceIdValue = peerDeviceId;
					peerPublicKeyValue = loadPublicKey(peerKeysDir) ?? "";
					const peerFingerprint = peerDb
						.prepare("SELECT fingerprint FROM sync_device LIMIT 1")
						.get() as { fingerprint: string } | undefined;
					peerFingerprintValue = peerFingerprint?.fingerprint ?? "";
					const url = "http://localhost/v1/ops";
					const headers = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "POST",
						url,
						bodyBytes: Buffer.from(JSON.stringify({ ops: [] })),
						keysDir: peerKeysDir,
						bootstrapGrantId: "grant-1",
					});
					const res = await syncApp.request(url, {
						method: "POST",
						headers: {
							...headers,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ ops: [] }),
					});
					expect(res.status).toBe(401);
				} finally {
					peerDb.close();
				}
			} finally {
				cleanup();
				rmSync(peerDir, { recursive: true, force: true });
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
			}
		});

		it("rejects bootstrap grants whose worker enrollment does not match the granted worker", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-bootstrap-grant-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			let peerDeviceIdValue = "";
			let peerPublicKeyValue = "";
			let peerFingerprintValue = "";
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/bootstrap-grants/grant-1")) {
					return new Response(
						JSON.stringify({
							grant: {
								grant_id: "grant-1",
								group_id: "g1",
								seed_device_id: "test-device-001",
								worker_device_id: peerDeviceIdValue,
								expires_at: "2099-01-01T00:00:00Z",
								created_at: "2026-01-01T00:00:00Z",
								created_by: "admin",
								revoked_at: null,
							},
							worker_enrollment: {
								group_id: "g1",
								device_id: "different-worker-id",
								public_key: peerPublicKeyValue,
								fingerprint: peerFingerprintValue,
								display_name: "Peer Bootstrap",
								enabled: 1,
								created_at: "2026-01-01T00:00:00Z",
							},
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const peerDb = connect(peerDbPath);
				try {
					initTestSchema(peerDb);
					const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
					peerDeviceIdValue = peerDeviceId;
					peerPublicKeyValue = loadPublicKey(peerKeysDir) ?? "";
					const peerFingerprint = peerDb
						.prepare("SELECT fingerprint FROM sync_device LIMIT 1")
						.get() as { fingerprint: string } | undefined;
					peerFingerprintValue = peerFingerprint?.fingerprint ?? "";
					const url = "http://localhost/v1/status";
					const headers = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peerKeysDir,
						bootstrapGrantId: "grant-1",
					});
					const res = await syncApp.request(url, { headers });
					expect(res.status).toBe(401);
					// Wire response must use generic reason, not the specific
					// bootstrap_grant_worker_enrollment_mismatch — prevents info-disclosure.
					const body = (await res.json()) as Record<string, unknown>;
					expect(body.error).toBe("unauthorized");
					expect(body).not.toHaveProperty("reason");
				} finally {
					peerDb.close();
				}
			} finally {
				cleanup();
				rmSync(peerDir, { recursive: true, force: true });
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
			}
		});

		it("rejects oversized sync request bodies before auth processing", async () => {
			const { syncApp, cleanup } = createTestApp();
			try {
				const hugeBody = JSON.stringify({ ops: [], padding: "x".repeat(1_048_600) });
				const res = await syncApp.request("/v1/ops", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: hugeBody,
				});
				expect(res.status).toBe(413);
				expect(await res.json()).toEqual({ error: "payload_too_large" });
			} finally {
				cleanup();
			}
		});

		it("exposes /v1/snapshot on sync app (auth-gated)", async () => {
			const { syncApp, cleanup } = createTestApp();
			try {
				const res = await syncApp.request("/v1/snapshot?generation=1&snapshot_id=test");
				expect(res.status).toBe(401);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("unauthorized");
			} finally {
				cleanup();
			}
		});

		it("returns 400 for /v1/snapshot without required params", async () => {
			const { syncApp, cleanup } = createTestApp();
			try {
				// Missing generation
				const res = await syncApp.request("/v1/snapshot?snapshot_id=test");
				// Will be 401 without auth, but let's verify the endpoint exists
				expect([400, 401]).toContain(res.status);
			} finally {
				cleanup();
			}
		});

		it("returns reset_required metadata for stale peer cursors", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const peerDb = connect(peerDbPath);
				try {
					initTestSchema(peerDb);
					const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
					const peerPublicKey = loadPublicKey(peerKeysDir);
					if (!peerPublicKey) throw new Error("peer public key missing");
					const peerFingerprint = peerDb
						.prepare("SELECT fingerprint FROM sync_device LIMIT 1")
						.get() as { fingerprint: string } | undefined;
					if (!peerFingerprint?.fingerprint) throw new Error("peer fingerprint missing");

					store.db
						.prepare(
							`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
							 VALUES (?, ?, ?, ?)`,
						)
						.run(
							peerDeviceId,
							peerFingerprint.fingerprint,
							peerPublicKey,
							new Date().toISOString(),
						);

					store.db
						.prepare(
							`INSERT OR REPLACE INTO sync_reset_state(id, generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at)
							 VALUES (1, ?, ?, ?, ?, ?)`,
						)
						.run(
							7,
							"snapshot-7",
							"2026-01-01T00:00:02Z|base-op",
							"2026-01-01T00:00:03Z|floor-op",
							new Date().toISOString(),
						);

					const url =
						"http://localhost/v1/ops?since=2026-01-01T00:00:01Z%7Cold&limit=50&generation=7&snapshot_id=snapshot-7&baseline_cursor=2026-01-01T00:00:02Z%7Cbase-op";
					const headers = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peerKeysDir,
					});

					const res = await syncApp.request(url, { headers });
					expect(res.status).toBe(409);
					const body = (await res.json()) as Record<string, unknown>;
					expect(body.error).toBe("reset_required");
					expect(body.reset_required).toBe(true);
					expect(body.sync_capability).toBe("aware");
					expect(body.reason).toBe("stale_cursor");
					expect(body.generation).toBe(7);
					expect(body.snapshot_id).toBe("snapshot-7");
					expect(body.retained_floor_cursor).toBe("2026-01-01T00:00:03Z|floor-op");
				} finally {
					peerDb.close();
				}
			} finally {
				cleanup();
				rmSync(peerDir, { recursive: true, force: true });
			}
		});

		it("requires explicit reset boundary metadata on incremental sync requests", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const peerDb = connect(peerDbPath);
				try {
					initTestSchema(peerDb);
					const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
					const peerPublicKey = loadPublicKey(peerKeysDir);
					if (!peerPublicKey) throw new Error("peer public key missing");
					const peerFingerprint = peerDb
						.prepare("SELECT fingerprint FROM sync_device LIMIT 1")
						.get() as { fingerprint: string } | undefined;
					if (!peerFingerprint?.fingerprint) throw new Error("peer fingerprint missing");

					store.db
						.prepare(
							`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
							 VALUES (?, ?, ?, ?)`,
						)
						.run(
							peerDeviceId,
							peerFingerprint.fingerprint,
							peerPublicKey,
							new Date().toISOString(),
						);

					store.db
						.prepare(
							`INSERT OR REPLACE INTO sync_reset_state(id, generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at)
							 VALUES (1, ?, ?, ?, ?, ?)`,
						)
						.run(
							9,
							"snapshot-9",
							"2026-01-01T00:00:02Z|base-op",
							"2026-01-01T00:00:03Z|floor-op",
							new Date().toISOString(),
						);

					const url = "http://localhost/v1/ops?since=2026-01-01T00:00:03Z%7Cfloor-op&limit=50";
					const headers = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peerKeysDir,
					});

					const res = await syncApp.request(url, { headers });
					expect(res.status).toBe(409);
					const body = (await res.json()) as Record<string, unknown>;
					expect(body.error).toBe("reset_required");
					expect(body.reset_required).toBe(true);
					expect(body.sync_capability).toBe("aware");
					expect(body.reason).toBe("boundary_mismatch");
					expect(body.generation).toBe(9);
					expect(body.snapshot_id).toBe("snapshot-9");
					expect(body.baseline_cursor).toBe("2026-01-01T00:00:02Z|base-op");
				} finally {
					peerDb.close();
				}
			} finally {
				cleanup();
				rmSync(peerDir, { recursive: true, force: true });
			}
		});

		it("returns reset_required when GET /v1/ops receives an empty scope_id", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/ops?scope_id=&limit=50";
				peer = createAuthenticatedSyncPeer(store, { url });

				const res = await syncApp.request(url, { headers: peer.headers });

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "aware",
					reason: "missing_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required when GET /v1/ops receives an unsupported scope_id", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/ops?scope_id=acme-work&limit=50";
				peer = createAuthenticatedSyncPeer(store, { url });

				const res = await syncApp.request(url, { headers: peer.headers });

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "aware",
					reason: "unsupported_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required when GET /v1/snapshot receives an unsupported scope_id", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/snapshot?scope_id=acme-work&generation=1&snapshot_id=test";
				peer = createAuthenticatedSyncPeer(store, { url });

				const res = await syncApp.request(url, { headers: peer.headers });

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "aware",
					reason: "unsupported_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required when GET /v1/snapshot receives an empty scope_id", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/snapshot?scope_id=&generation=1&snapshot_id=test";
				peer = createAuthenticatedSyncPeer(store, { url });

				const res = await syncApp.request(url, { headers: peer.headers });

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "aware",
					reason: "missing_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required when POST /v1/ops receives an unsupported body scope_id", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/ops";
				const bodyText = JSON.stringify({ ops: [], scope_id: "acme-work" });
				const bodyBytes = Buffer.from(bodyText);
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST", bodyBytes });

				const res = await syncApp.request(url, {
					method: "POST",
					headers: { ...peer.headers, "Content-Type": "application/json" },
					body: bodyText,
				});

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "aware",
					reason: "unsupported_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required for unsupported POST scope_id before missing ops validation", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/ops";
				const bodyText = JSON.stringify({ scope_id: "acme-work" });
				const bodyBytes = Buffer.from(bodyText);
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST", bodyBytes });

				const res = await syncApp.request(url, {
					method: "POST",
					headers: { ...peer.headers, "Content-Type": "application/json" },
					body: bodyText,
				});

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "aware",
					reason: "unsupported_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required for empty POST scope_id before missing ops validation", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/ops";
				const bodyText = JSON.stringify({ scope_id: "" });
				const bodyBytes = Buffer.from(bodyText);
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST", bodyBytes });

				const res = await syncApp.request(url, {
					method: "POST",
					headers: { ...peer.headers, "Content-Type": "application/json" },
					body: bodyText,
				});

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "aware",
					reason: "missing_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required for unsupported POST scope_id before oversized ops validation", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/ops";
				const bodyText = JSON.stringify({
					scope_id: "acme-work",
					ops: Array.from({ length: 2001 }, () => null),
				});
				const bodyBytes = Buffer.from(bodyText);
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST", bodyBytes });

				const res = await syncApp.request(url, {
					method: "POST",
					headers: { ...peer.headers, "Content-Type": "application/json" },
					body: bodyText,
				});

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "aware",
					reason: "unsupported_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("advertises capability on incremental /v1/ops responses", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const peerDb = connect(peerDbPath);
				try {
					initTestSchema(peerDb);
					const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
					const peerPublicKey = loadPublicKey(peerKeysDir);
					if (!peerPublicKey) throw new Error("peer public key missing");
					const peerFingerprint = peerDb
						.prepare("SELECT fingerprint FROM sync_device LIMIT 1")
						.get() as { fingerprint: string } | undefined;
					if (!peerFingerprint?.fingerprint) throw new Error("peer fingerprint missing");
					const now = new Date().toISOString();

					store.db
						.prepare(
							`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
							 VALUES (?, ?, ?, ?)`,
						)
						.run(peerDeviceId, peerFingerprint.fingerprint, peerPublicKey, now);

					store.db
						.prepare(
							`INSERT OR REPLACE INTO sync_reset_state(id, generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at)
							 VALUES (1, ?, ?, ?, ?, ?)`,
						)
						.run(3, "snapshot-3", null, null, now);

					const url = "http://localhost/v1/ops?since=&limit=50&generation=3&snapshot_id=snapshot-3";
					const headers = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peerKeysDir,
					});

					const res = await syncApp.request(url, { headers });
					expect(res.status).toBe(200);
					const body = (await res.json()) as Record<string, unknown>;
					expect(body.reset_required).toBe(false);
					expect(body.sync_capability).toBe("aware");
					expect(body.scope_id).toBeNull();
					expect(body.ops).toEqual([]);
				} finally {
					peerDb.close();
				}
			} finally {
				cleanup();
				rmSync(peerDir, { recursive: true, force: true });
			}
		});

		it("filters local-only outbound /v1/ops before project filters", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = "2026-01-01T00:00:00Z";
				store.db
					.prepare(
						`INSERT OR REPLACE INTO sync_reset_state(
							id, generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at
						 ) VALUES (1, ?, ?, ?, ?, ?)`,
					)
					.run(3, "snapshot-3", null, null, now);
				store.db
					.prepare(
						`INSERT INTO replication_ops(
							op_id, entity_type, entity_id, op_type, payload_json, clock_rev,
							clock_updated_at, clock_device_id, device_id, created_at, scope_id
						 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						"local-default-outbound-op",
						"memory_item",
						"local-default-outbound-key",
						"upsert",
						JSON.stringify({
							project: "proj-a",
							scope_id: "local-default",
							visibility: "shared",
						}),
						1,
						now,
						"test-device-001",
						"test-device-001",
						now,
						"local-default",
					);

				const url = "http://localhost/v1/ops?since=&limit=50&generation=3&snapshot_id=snapshot-3";
				peer = createAuthenticatedSyncPeer(store, { url });
				store.db
					.prepare("UPDATE sync_peers SET projects_include_json = ? WHERE peer_device_id = ?")
					.run('["proj-a"]', peer.peerDeviceId);

				const res = await syncApp.request(url, { headers: peer.headers });

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.ops).toEqual([]);
				expect(body.skipped).toBe(1);
				expect(body.next_cursor).toBe("2026-01-01T00:00:00Z|local-default-outbound-op");
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("serves paginated memory bootstrap pages with tombstones", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const sessionId = insertTestSession(store.db);
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active, deleted_at, visibility, metadata_json)
						 VALUES (?, 'discovery', ?, 'body', ?, ?, ?, 1, ?, ?, ?, ?)`,
					)
					.run(
						sessionId,
						"key-a",
						now,
						now,
						"key-a",
						1,
						null,
						"shared",
						JSON.stringify({ clock_device_id: "dev-a" }),
					);
				store.db
					.prepare(
						`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active, deleted_at, visibility, metadata_json)
						 VALUES (?, 'discovery', ?, 'body', ?, ?, ?, 1, ?, ?, ?, ?)`,
					)
					.run(
						sessionId,
						"key-b",
						now,
						now,
						"key-b",
						0,
						now,
						"shared",
						JSON.stringify({ clock_device_id: "dev-a" }),
					);

				store.db
					.prepare(
						`INSERT OR REPLACE INTO sync_reset_state(id, generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at)
						 VALUES (1, ?, ?, ?, ?, ?)`,
					)
					.run(
						11,
						"snapshot-11",
						"2026-01-01T00:00:02Z|base-op",
						"2026-01-01T00:00:03Z|floor-op",
						now,
					);

				const peerDb = connect(peerDbPath);
				try {
					initTestSchema(peerDb);
					const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
					const peerPublicKey = loadPublicKey(peerKeysDir);
					if (!peerPublicKey) throw new Error("peer public key missing");
					const peerFingerprint = peerDb
						.prepare("SELECT fingerprint FROM sync_device LIMIT 1")
						.get() as { fingerprint: string } | undefined;
					if (!peerFingerprint?.fingerprint) throw new Error("peer fingerprint missing");

					store.db
						.prepare(
							`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
							 VALUES (?, ?, ?, ?)`,
						)
						.run(peerDeviceId, peerFingerprint.fingerprint, peerPublicKey, now);

					const url =
						"http://localhost/v1/snapshot?limit=2&generation=11&snapshot_id=snapshot-11&baseline_cursor=2026-01-01T00:00:02Z%7Cbase-op";
					const headers = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peerKeysDir,
					});

					const res = await syncApp.request(url, { headers });
					expect(res.status).toBe(200);
					const body = (await res.json()) as Record<string, unknown>;
					expect(body.generation).toBe(11);
					expect(body.snapshot_id).toBe("snapshot-11");
					expect(body.sync_capability).toBe("aware");
					expect(body.scope_id).toBeNull();
					const items = body.items as Array<Record<string, unknown>>;
					expect(items.map((item) => item.entity_id)).toEqual(["key-a", "key-b"]);
					expect(items[1]?.op_type).toBe("delete");
				} finally {
					peerDb.close();
				}
			} finally {
				cleanup();
				rmSync(peerDir, { recursive: true, force: true });
			}
		});

		it("does not expose viewer routes on sync app", async () => {
			const { syncApp, cleanup } = createTestApp();
			try {
				const statsRes = await syncApp.request("/api/stats");
				expect(statsRes.status).toBe(404);

				const peersRes = await syncApp.request("/api/sync/peers");
				expect(peersRes.status).toBe(404);

				const obsRes = await syncApp.request("/api/observations");
				expect(obsRes.status).toBe(404);
			} finally {
				cleanup();
			}
		});

		it("accepts capability metadata on POST /v1/ops bodies", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const peerDb = connect(peerDbPath);
				try {
					initTestSchema(peerDb);
					const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
					const peerPublicKey = loadPublicKey(peerKeysDir);
					if (!peerPublicKey) throw new Error("peer public key missing");
					const peerFingerprint = peerDb
						.prepare("SELECT fingerprint FROM sync_device LIMIT 1")
						.get() as { fingerprint: string } | undefined;
					if (!peerFingerprint?.fingerprint) throw new Error("peer fingerprint missing");

					store.db
						.prepare(
							`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
							 VALUES (?, ?, ?, ?)`,
						)
						.run(
							peerDeviceId,
							peerFingerprint.fingerprint,
							peerPublicKey,
							new Date().toISOString(),
						);

					const url = "http://localhost/v1/ops";
					const payload = { ops: [], sync_capability: "aware" };
					const bodyText = JSON.stringify(payload);
					const bodyBytes = Buffer.from(bodyText);
					const headers = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "POST",
						url,
						bodyBytes,
						keysDir: peerKeysDir,
					});

					const res = await syncApp.request(url, {
						method: "POST",
						headers: {
							...headers,
							"Content-Type": "application/json",
						},
						body: bodyText,
					});
					expect(res.status).toBe(200);
					const body = (await res.json()) as Record<string, unknown>;
					expect(body.sync_capability).toBe("aware");
					expect(body.scope_id).toBeNull();
				} finally {
					peerDb.close();
				}
			} finally {
				cleanup();
				rmSync(peerDir, { recursive: true, force: true });
			}
		});

		it("accepts non-empty legacy pushes from unsupported peers", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/ops";
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST" });
				const now = "2026-01-01T00:00:00Z";
				const payload = {
					sync_capability: "unsupported",
					ops: [
						{
							op_id: "legacy-push-op",
							entity_type: "memory_item",
							entity_id: "legacy-push-key",
							op_type: "upsert",
							payload_json: JSON.stringify({
								body_text: "Legacy push body",
								created_at: now,
								kind: "discovery",
								title: "Legacy push title",
								updated_at: now,
								visibility: "shared",
							}),
							clock_rev: 1,
							clock_updated_at: now,
							clock_device_id: peer.peerDeviceId,
							device_id: peer.peerDeviceId,
							created_at: now,
						},
					],
				};
				const bodyText = JSON.stringify(payload);
				const bodyBytes = Buffer.from(bodyText);
				const headers = buildAuthHeaders({
					deviceId: peer.peerDeviceId,
					method: "POST",
					url,
					bodyBytes,
					keysDir: peer.keysDir,
				});

				const res = await syncApp.request(url, {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: bodyText,
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({ applied: 1, skipped: 0, rejected: 0 });
				expect(
					store.db
						.prepare("SELECT title, scope_id FROM memory_items WHERE import_key = ?")
						.get("legacy-push-key"),
				).toMatchObject({ title: "Legacy push title", scope_id: null });
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("does not outbound-scope-filter scoped pushes from unsupported peers", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/ops";
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST" });
				const now = "2026-01-01T00:00:00Z";
				const payload = {
					sync_capability: "unsupported",
					ops: [
						{
							op_id: "unsupported-scoped-push-op",
							entity_type: "memory_item",
							entity_id: "unsupported-scoped-push-key",
							op_type: "upsert",
							payload_json: JSON.stringify({
								body_text: "Unsupported scoped push body",
								created_at: now,
								kind: "discovery",
								scope_id: "local-default",
								title: "Unsupported scoped push title",
								updated_at: now,
								visibility: "shared",
							}),
							clock_rev: 1,
							clock_updated_at: now,
							clock_device_id: peer.peerDeviceId,
							device_id: peer.peerDeviceId,
							created_at: now,
							scope_id: "local-default",
						},
					],
				};
				const bodyText = JSON.stringify(payload);
				const bodyBytes = Buffer.from(bodyText);
				const headers = buildAuthHeaders({
					deviceId: peer.peerDeviceId,
					method: "POST",
					url,
					bodyBytes,
					keysDir: peer.keysDir,
				});

				const res = await syncApp.request(url, {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: bodyText,
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({ applied: 1, skipped: 0, rejected: 0 });
				expect(
					store.db
						.prepare("SELECT title, scope_id FROM memory_items WHERE import_key = ?")
						.get("unsupported-scoped-push-key"),
				).toMatchObject({ title: "Unsupported scoped push title", scope_id: "local-default" });
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("filters pushed ops by peer project filters before applying", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/ops";
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST" });
				store.db
					.prepare("UPDATE sync_peers SET projects_include_json = ? WHERE peer_device_id = ?")
					.run('["allowed-project"]', peer.peerDeviceId);
				grantSyncScopeToDevices(store, "acme-work", ["test-device-001", peer.peerDeviceId]);

				const now = "2026-01-01T00:00:00Z";
				const makeOp = (opId: string, project: string) => ({
					op_id: opId,
					entity_type: "memory_item",
					entity_id: `${opId}-key`,
					op_type: "upsert",
					payload_json: JSON.stringify({
						body_text: `${project} body`,
						created_at: now,
						kind: "discovery",
						project,
						scope_id: "acme-work",
						title: `${project} title`,
						updated_at: now,
						visibility: "shared",
					}),
					clock_rev: 1,
					clock_updated_at: now,
					clock_device_id: peer.peerDeviceId,
					device_id: peer.peerDeviceId,
					created_at: now,
					scope_id: "acme-work",
				});
				const payload = {
					ops: [makeOp("allowed-op", "allowed-project"), makeOp("blocked-op", "blocked-project")],
				};
				const bodyText = JSON.stringify(payload);
				const bodyBytes = Buffer.from(bodyText);
				const headers = buildAuthHeaders({
					deviceId: peer.peerDeviceId,
					method: "POST",
					url,
					bodyBytes,
					keysDir: peer.keysDir,
				});

				const res = await syncApp.request(url, {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: bodyText,
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({ applied: 1, skipped: 1, rejected: 0 });
				expect(
					store.db
						.prepare("SELECT title FROM memory_items WHERE import_key = ?")
						.get("allowed-op-key"),
				).toMatchObject({ title: "allowed-project title" });
				expect(
					store.db.prepare("SELECT 1 FROM memory_items WHERE import_key = ?").get("blocked-op-key"),
				).toBeUndefined();
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("filters null-payload pushed deletes by the existing memory project", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const url = "http://localhost/v1/ops";
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST" });
				store.db
					.prepare("UPDATE sync_peers SET projects_include_json = ? WHERE peer_device_id = ?")
					.run('["allowed-project"]', peer.peerDeviceId);
				grantSyncScopeToDevices(store, "acme-work", ["test-device-001", peer.peerDeviceId]);

				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("blocked-project", sessionId);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "blocked delete target",
				});
				store.db
					.prepare("UPDATE memory_items SET import_key = ?, rev = 1, scope_id = ? WHERE id = ?")
					.run("blocked-delete-key", "acme-work", memoryId);

				const now = "2026-01-01T00:00:00Z";
				const payload = {
					sync_capability: "aware",
					ops: [
						{
							op_id: "blocked-delete-op",
							entity_type: "memory_item",
							entity_id: "blocked-delete-key",
							op_type: "delete",
							payload_json: null,
							clock_rev: 2,
							clock_updated_at: now,
							clock_device_id: peer.peerDeviceId,
							device_id: peer.peerDeviceId,
							created_at: now,
							scope_id: "acme-work",
						},
					],
				};
				const bodyText = JSON.stringify(payload);
				const bodyBytes = Buffer.from(bodyText);
				const headers = buildAuthHeaders({
					deviceId: peer.peerDeviceId,
					method: "POST",
					url,
					bodyBytes,
					keysDir: peer.keysDir,
				});

				const res = await syncApp.request(url, {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: bodyText,
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({ applied: 0, skipped: 1, rejected: 0 });
				expect(
					store.db
						.prepare("SELECT active, deleted_at FROM memory_items WHERE import_key = ?")
						.get("blocked-delete-key"),
				).toMatchObject({ active: 1, deleted_at: null });
				expect(
					store.db
						.prepare("SELECT 1 FROM replication_ops WHERE op_id = ?")
						.get("blocked-delete-op"),
				).toBeUndefined();
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("hard-rejects inbound scope failures without claimed_local_actor bypass", async () => {
			const { syncApp, getStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				await syncApp.request("/v1/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const peerDb = connect(peerDbPath);
				try {
					initTestSchema(peerDb);
					const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
					const peerPublicKey = loadPublicKey(peerKeysDir);
					if (!peerPublicKey) throw new Error("peer public key missing");
					const peerFingerprint = peerDb
						.prepare("SELECT fingerprint FROM sync_device LIMIT 1")
						.get() as { fingerprint: string } | undefined;
					if (!peerFingerprint?.fingerprint) throw new Error("peer fingerprint missing");

					store.db
						.prepare(
							`INSERT INTO sync_peers(
								peer_device_id, pinned_fingerprint, public_key, claimed_local_actor, created_at
							 ) VALUES (?, ?, ?, 1, ?)`,
						)
						.run(
							peerDeviceId,
							peerFingerprint.fingerprint,
							peerPublicKey,
							new Date().toISOString(),
						);
					const localDevice = store.db.prepare("SELECT device_id FROM sync_device LIMIT 1").get() as
						| { device_id: string }
						| undefined;
					if (!localDevice?.device_id) throw new Error("local sync device missing");
					store.db
						.prepare(
							`INSERT INTO replication_scopes(
								scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
							 ) VALUES (?, ?, 'personal', 'coordinator', 1, 'active', ?, ?)`,
						)
						.run(
							"personal:actor-1",
							"Personal actor",
							new Date().toISOString(),
							new Date().toISOString(),
						);
					store.db
						.prepare(
							`INSERT INTO scope_memberships(
								scope_id, device_id, role, status, membership_epoch, updated_at
							 ) VALUES (?, ?, 'member', 'active', 1, ?)`,
						)
						.run("personal:actor-1", localDevice.device_id, new Date().toISOString());
					const sessionId = insertTestSession(store.db);
					const sharedMemoryId = insertTestMemory(store, {
						sessionId,
						kind: "discovery",
						title: "shared tombstone target",
					});
					store.db
						.prepare("UPDATE memory_items SET import_key = ?, rev = 1 WHERE id = ?")
						.run("shared-delete-key", sharedMemoryId);

					const url = "http://localhost/v1/ops";
					const now = "2026-01-01T00:00:00Z";
					const payload = {
						sync_capability: "aware",
						ops: [
							{
								op_id: "private-op-1",
								entity_type: "memory_item",
								entity_id: "private-key-1",
								op_type: "upsert",
								payload_json: JSON.stringify({
									actor_id: "actor-1",
									body_text: "private body",
									created_at: now,
									kind: "discovery",
									scope_id: "personal:actor-1",
									title: "private title",
									updated_at: now,
									workspace_id: "personal:actor-1",
									workspace_kind: "personal",
								}),
								clock_rev: 1,
								clock_updated_at: now,
								clock_device_id: peerDeviceId,
								device_id: peerDeviceId,
								created_at: now,
								scope_id: "personal:actor-1",
							},
							{
								op_id: "private-delete-1",
								entity_type: "memory_item",
								entity_id: "private-key-1",
								op_type: "delete",
								payload_json: null,
								clock_rev: 2,
								clock_updated_at: now,
								clock_device_id: peerDeviceId,
								device_id: peerDeviceId,
								created_at: "2026-01-01T00:00:01Z",
								scope_id: "personal:actor-1",
							},
							{
								op_id: "shared-delete-1",
								entity_type: "memory_item",
								entity_id: "shared-delete-key",
								op_type: "delete",
								payload_json: null,
								clock_rev: 2,
								clock_updated_at: now,
								clock_device_id: peerDeviceId,
								device_id: peerDeviceId,
								created_at: "2026-01-01T00:00:02Z",
								scope_id: null,
							},
						],
					};
					const bodyText = JSON.stringify(payload);
					const bodyBytes = Buffer.from(bodyText);
					const headers = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "POST",
						url,
						bodyBytes,
						keysDir: peerKeysDir,
					});

					const res = await syncApp.request(url, {
						method: "POST",
						headers: { ...headers, "Content-Type": "application/json" },
						body: bodyText,
					});
					expect(res.status).toBe(403);
					const body = (await res.json()) as Record<string, unknown>;
					expect(body).toMatchObject({
						error: "scope_rejected",
						reason: "sender_not_member",
					});
					expect(body.rejections).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ op_id: "private-op-1", reason: "sender_not_member" }),
							expect.objectContaining({ op_id: "private-delete-1", reason: "sender_not_member" }),
							expect.objectContaining({ op_id: "shared-delete-1", reason: "missing_scope" }),
						]),
					);
					const deleted = store.db
						.prepare("SELECT active, deleted_at FROM memory_items WHERE import_key = ?")
						.get("shared-delete-key") as { active: number; deleted_at: string | null } | undefined;
					expect(deleted?.active).toBe(1);
					expect(deleted?.deleted_at).toBeNull();
					const logged = store.db
						.prepare("SELECT reason, count(*) AS count FROM sync_scope_rejections GROUP BY reason")
						.all() as Array<{ reason: string; count: number }>;
					expect(logged).toEqual(
						expect.arrayContaining([
							{ reason: "sender_not_member", count: 2 },
							{ reason: "missing_scope", count: 1 },
						]),
					);
				} finally {
					peerDb.close();
				}
			} finally {
				cleanup();
				rmSync(peerDir, { recursive: true, force: true });
			}
		});

		it("sync app does not apply CORS origin guard on POST", async () => {
			const { syncApp, cleanup } = createTestApp();
			try {
				// POST with a non-loopback origin — sync app should return 401 (auth),
				// not 403 (CORS rejection), since it has no origin guard middleware.
				const res = await syncApp.request("/v1/ops", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "https://evil.example.com",
					},
					body: JSON.stringify({ ops: [] }),
				});
				expect(res.status).toBe(401);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.error).toBe("unauthorized");
			} finally {
				cleanup();
			}
		});

		it("lists bootstrap grants through viewer sync routes", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/bootstrap-grants?group_id=g1")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									grant_id: "grant-1",
									group_id: "g1",
									seed_device_id: "seed-1",
									worker_device_id: "worker-1",
									expires_at: "2099-01-01T00:00:00Z",
									created_at: "2026-01-01T00:00:00Z",
									created_by: "admin",
									revoked_at: null,
								},
							],
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const res = await app.request("/api/sync/bootstrap-grants?group_id=g1");
					expect(res.status).toBe(200);
					expect(await res.json()).toEqual({
						items: [expect.objectContaining({ grant_id: "grant-1", group_id: "g1" })],
					});
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
			}
		});

		it("revokes bootstrap grants through viewer sync routes", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/bootstrap-grants/revoke")) {
					return new Response(JSON.stringify({ ok: true, grant_id: "grant-1" }), { status: 200 });
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const res = await app.request("/api/sync/bootstrap-grants/revoke", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ grant_id: "grant-1" }),
					});
					expect(res.status).toBe(200);
					expect(await res.json()).toEqual({ ok: true, grant_id: "grant-1" });
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
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
				const res = await app.request(
					"/api/sync/status?includeDiagnostics=1&includeJoinRequests=1",
				);
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					enabled: boolean;
					interval_s: number;
					project_filter_active: boolean;
					project_filter: { include: string[]; exclude: string[] };
				};
				expect(body.enabled).toBe(true);
				expect(body.interval_s).toBe(45);
				expect(body.project_filter_active).toBe(true);
				expect(body.project_filter).toEqual({ include: ["codemem"], exclude: ["junk"] });
				expect(body.coordinator.enabled).toBe(true);
				expect(body.coordinator.configured).toBe(true);
				expect(body.coordinator.groups).toEqual(["team-a"]);
				expect(body.join_requests).toHaveLength(1);
				expect(body.join_requests[0].request_id).toBe("req-1");

				const second = await app.request(
					"/api/sync/status?includeDiagnostics=1&includeJoinRequests=1",
				);
				expect(second.status).toBe(200);

				const calls = fetchMock.mock.calls.map(([input]) => String(input));
				const presenceCalls = calls.filter((url) => url.includes("/v1/presence"));
				expect(presenceCalls).toHaveLength(1);
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

		it("returns pairing payload addresses that the CLI accept flow can use", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_enabled: true,
					sync_host: "127.0.0.1",
					sync_port: 7337,
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				const res = await app.request("/api/sync/pairing?includeDiagnostics=1");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					device_id: string;
					fingerprint: string;
					public_key: string | null;
					addresses: string[];
				};
				expect(body.device_id).toBeTruthy();
				expect(body.fingerprint).toBeTruthy();
				expect(body.public_key).toBeTruthy();
				expect(body.addresses).toEqual(["127.0.0.1:7337"]);
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("skips coordinator join request lookup unless includeJoinRequests=1", async () => {
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
					return new Response(JSON.stringify({ items: [] }), { status: 200 });
				}
				if (url.includes("/v1/admin/join-requests")) {
					return new Response(JSON.stringify({ items: [] }), { status: 200 });
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
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).not.toHaveProperty("join_requests");

				const calls = fetchMock.mock.calls.map(([input]) => String(input));
				const joinRequestCalls = calls.filter((url) => url.includes("/v1/admin/join-requests"));
				expect(joinRequestCalls).toHaveLength(0);
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

		it("does not expose join requests without diagnostics", async () => {
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
					return new Response(JSON.stringify({ items: [] }), { status: 200 });
				}
				if (url.includes("/v1/admin/join-requests")) {
					return new Response(
						JSON.stringify({ items: [{ request_id: "req-1", token: "secret-token" }] }),
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

				const res = await app.request("/api/sync/status?includeJoinRequests=1");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).not.toHaveProperty("join_requests");

				const calls = fetchMock.mock.calls.map(([input]) => String(input));
				const joinRequestCalls = calls.filter((url) => url.includes("/v1/admin/join-requests"));
				expect(joinRequestCalls).toHaveLength(0);
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
			const prevRetentionEnabled = process.env.CODEMEM_SYNC_RETENTION_ENABLED;
			const prevRetentionAge = process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS;
			const prevRetentionSize = process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_SYNC_ENABLED = "1";
			process.env.CODEMEM_SYNC_RETENTION_ENABLED = "1";
			process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS = "14";
			process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB = "256";
			writeFileSync(configPath, JSON.stringify({ sync_enabled: false }));
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.enabled).toBe(true);
				expect(body.retention).toEqual(
					expect.objectContaining({
						enabled: true,
						max_age_days: 14,
						max_size_mb: 256,
						retained_floor_cursor: null,
					}),
				);
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevEnabled == null) delete process.env.CODEMEM_SYNC_ENABLED;
				else process.env.CODEMEM_SYNC_ENABLED = prevEnabled;
				if (prevRetentionEnabled == null) delete process.env.CODEMEM_SYNC_RETENTION_ENABLED;
				else process.env.CODEMEM_SYNC_RETENTION_ENABLED = prevRetentionEnabled;
				if (prevRetentionAge == null) delete process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS;
				else process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS = prevRetentionAge;
				if (prevRetentionSize == null) delete process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB;
				else process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB = prevRetentionSize;
			}
		});

		it("surfaces runtime sync startup state before daemon settles", async () => {
			const { app, cleanup } = createTestApp({
				getSyncRuntimeStatus: () => ({
					phase: "starting",
					detail: "Running initial sync in background",
				}),
			});
			try {
				const res = await app.request("/api/sync/status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.daemon_state).toBe("starting");
				expect(body.daemon_detail).toBe("Running initial sync in background");
			} finally {
				cleanup();
			}
		});

		it("includes detailed maintenance summaries only when diagnostics are enabled", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/sync/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				startMaintenanceJob(store.db, {
					kind: "vector_model_migration",
					title: "Re-indexing memories",
					message: "Building new embeddings",
					progressTotal: 10,
					metadata: { source_model: "old-model", target_model: "new-model" },
				});

				const res = await app.request("/api/sync/status?includeDiagnostics=1");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const status = body.status as Record<string, unknown>;
				const jobs = status.background_maintenance as Array<Record<string, unknown>>;
				expect(jobs).toHaveLength(1);
				expect(jobs[0]).toMatchObject({
					kind: "vector_model_migration",
					title: "Re-indexing memories",
					message: "Building new embeddings",
					metadata: { source_model: "old-model", target_model: "new-model" },
				});
			} finally {
				cleanup();
			}
		});

		it("redacts maintenance details when diagnostics are disabled", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/sync/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				startMaintenanceJob(store.db, {
					kind: "vector_model_migration",
					title: "Re-indexing memories",
					message: "Building new embeddings",
					progressTotal: 10,
					metadata: { source_model: "old-model", target_model: "new-model" },
				});

				const res = await app.request("/api/sync/status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const status = body.status as Record<string, unknown>;
				const jobs = status.background_maintenance as Array<Record<string, unknown>>;
				expect(jobs).toHaveLength(1);
				expect(jobs[0]).toMatchObject({
					kind: "vector_model_migration",
					title: "Re-indexing memories",
				});
				expect(jobs[0]).not.toHaveProperty("message");
				expect(jobs[0]).not.toHaveProperty("metadata");
			} finally {
				cleanup();
			}
		});

		it("includes semantic-index diagnostics in sync status output", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/sync/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				startMaintenanceJob(store.db, {
					kind: "vector_model_migration",
					title: "Re-indexing memories",
					status: "pending",
					message: "Queued vector catch-up for synced bootstrap data",
					progressTotal: 4,
					metadata: {
						trigger: "sync_bootstrap",
						processed_embeddable: 1,
						embeddable_total: 4,
					},
				});

				const res = await app.request("/api/sync/status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.semantic_index).toMatchObject({
					state: "pending",
					pending_memory_count: 3,
					maintenance_job: { status: "pending" },
				});
				const status = body.status as Record<string, unknown>;
				expect(status.semantic_index).toMatchObject({
					state: "pending",
					pending_memory_count: 3,
				});
			} finally {
				cleanup();
			}
		});

		it("uses cheap semantic diagnostics for non-diagnostic sync status requests", async () => {
			const diagnosticsSpy = vi.spyOn(core, "getSemanticIndexDiagnostics");
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/status");
				expect(res.status).toBe(200);
				expect(diagnosticsSpy).toHaveBeenCalled();
				const call = diagnosticsSpy.mock.calls.at(0);
				expect(call?.[1]?.fastCounts).not.toBe(false);
			} finally {
				diagnosticsSpy.mockRestore();
				cleanup();
			}
		});

		it("keeps the cheap semantic diagnostics path when sync diagnostics are explicitly requested", async () => {
			// The deep per-memory vec0 probe blocks the event loop, so the
			// sync status endpoint always uses the fast count path regardless
			// of `includeDiagnostics`. See codemem-00jn.
			const diagnosticsSpy = vi.spyOn(core, "getSemanticIndexDiagnostics");
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/status?includeDiagnostics=1");
				expect(res.status).toBe(200);
				expect(diagnosticsSpy).toHaveBeenCalled();
				const call = diagnosticsSpy.mock.calls.at(0);
				expect(call?.[1]?.fastCounts).not.toBe(false);
			} finally {
				diagnosticsSpy.mockRestore();
				cleanup();
			}
		});

		it("redacts semantic-index job details when diagnostics are disabled", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/sync/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				startMaintenanceJob(store.db, {
					kind: "vector_model_migration",
					title: "Re-indexing memories",
					status: "pending",
					message: "Queued vector catch-up for synced bootstrap data",
					progressTotal: 4,
					metadata: {
						processed_embeddable: 1,
						embeddable_total: 4,
					},
				});

				const res = await app.request("/api/sync/status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.semantic_index).toMatchObject({
					state: "pending",
					summary: "Semantic-index catch-up is pending",
					maintenance_job: {
						status: "pending",
						message: null,
						error: null,
					},
				});
			} finally {
				cleanup();
			}
		});

		it("includes retention telemetry in sync status output", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/sync/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(
						`INSERT INTO sync_retention_state(id, last_run_at, last_duration_ms, last_deleted_ops, last_estimated_bytes_before, last_estimated_bytes_after, retained_floor_cursor, last_error, last_error_at)
						 VALUES (1, ?, 1200, 42, 1000, 900, 'floor-cursor', 'boom', ?)`,
					)
					.run(new Date().toISOString(), new Date().toISOString());

				const prevRetentionEnabled = process.env.CODEMEM_SYNC_RETENTION_ENABLED;
				const prevMaxAge = process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS;
				const prevMaxSize = process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB;
				process.env.CODEMEM_SYNC_RETENTION_ENABLED = "1";
				process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS = "14";
				process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB = "256";
				try {
					const res = await app.request("/api/sync/status");
					const body = (await res.json()) as Record<string, unknown>;
					const retention = body.retention as Record<string, unknown>;
					expect(retention.enabled).toBe(true);
					expect(retention.max_age_days).toBe(14);
					expect(retention.max_size_mb).toBe(256);
					expect(retention.last_deleted_ops).toBe(42);
					expect(retention.retained_floor_cursor).toBe("floor-cursor");
					expect(retention.last_error).toBe("boom");
				} finally {
					if (prevRetentionEnabled === undefined) delete process.env.CODEMEM_SYNC_RETENTION_ENABLED;
					else process.env.CODEMEM_SYNC_RETENTION_ENABLED = prevRetentionEnabled;
					if (prevMaxAge === undefined) delete process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS;
					else process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS = prevMaxAge;
					if (prevMaxSize === undefined) delete process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB;
					else process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB = prevMaxSize;
				}
			} finally {
				cleanup();
			}
		});

		it("does not let latest needs_attention metadata override live starting state", async () => {
			const { app, getStore, cleanup } = createTestApp({
				getSyncRuntimeStatus: () => ({
					phase: "starting",
					detail: "Running initial sync in background",
				}),
			});
			try {
				await app.request("/api/sync/status");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(
						`INSERT INTO sync_attempts(peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error)
						 VALUES ('peer-1', ?, ?, 0, 0, 0, ?)`,
					)
					.run(
						new Date().toISOString(),
						new Date().toISOString(),
						"needs_attention:local_unsynced_shared_memory:2",
					);

				const res = await app.request("/api/sync/status");
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.daemon_state).toBe("starting");
				expect(body.daemon_detail).toBe("Running initial sync in background");
			} finally {
				cleanup();
			}
		});

		it("retries coordinator presence immediately after not_enrolled status", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			let presenceCalls = 0;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/presence")) {
					presenceCalls += 1;
					if (presenceCalls === 1) {
						return new Response(JSON.stringify({ error: "unknown_device" }), { status: 401 });
					}
					return new Response(JSON.stringify({ ok: true, addresses: ["http://1.2.3.4:7337"] }), {
						status: 200,
					});
				}
				if (url.includes("/v1/peers")) {
					return new Response(JSON.stringify({ items: [] }), { status: 200 });
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
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });

				type PresenceBody = { coordinator: { presence_status: string } };
				const first = await app.request("/api/sync/status?includeDiagnostics=1");
				expect(first.status).toBe(200);
				const firstBody = (await first.json()) as PresenceBody;
				expect(firstBody.coordinator.presence_status).toBe("not_enrolled");

				const second = await app.request("/api/sync/status?includeDiagnostics=1");
				expect(second.status).toBe(200);
				const secondBody = (await second.json()) as PresenceBody;
				expect(secondBody.coordinator.presence_status).toBe("posted");
				expect(presenceCalls).toBe(2);
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

		it("returns read-only coordinator discovered devices and counts", async () => {
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
									device_id: "peer-fresh",
									display_name: "Fresh Device",
									fingerprint: "fp-fresh",
									public_key: "peer-public-key",
									addresses: ["http://10.0.0.5:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
								},
								{
									device_id: "peer-stale",
									display_name: "Stale Device",
									fingerprint: "fp-stale",
									addresses: [],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() - 60_000).toISOString(),
									stale: true,
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
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
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
				const body = (await res.json()) as {
					coordinator: {
						discovered_peer_count: number;
						fresh_peer_count: number;
						stale_peer_count: number;
						discovered_devices: Array<Record<string, unknown>>;
					};
				};
				expect(body.coordinator.discovered_peer_count).toBe(2);
				expect(body.coordinator.fresh_peer_count).toBe(1);
				expect(body.coordinator.stale_peer_count).toBe(1);
				expect(body.coordinator.discovered_devices).toEqual([
					expect.objectContaining({
						device_id: "peer-fresh",
						display_name: "Fresh Device",
						stale: false,
					}),
					expect.objectContaining({
						device_id: "peer-stale",
						display_name: "Stale Device",
						stale: true,
					}),
				]);
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("redacts discovered coordinator device metadata without diagnostics", async () => {
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
									device_id: "peer-fresh",
									display_name: "Fresh Device",
									fingerprint: "fp-fresh",
									public_key: "peer-public-key",
									groups: ["team-a"],
									addresses: ["http://10.0.0.5:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
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
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				const res = await app.request("/api/sync/status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					coordinator: { discovered_devices: Array<Record<string, unknown>> };
				};
				expect(body.coordinator.discovered_devices).toEqual([
					expect.objectContaining({
						device_id: "peer-fresh",
						display_name: "Fresh Device",
						groups: ["team-a"],
						stale: false,
						fingerprint: null,
						addresses: [],
					}),
				]);
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("surfaces reciprocal approval state on discovered coordinator devices", async () => {
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
									device_id: "peer-incoming",
									display_name: "Needs Your Approval",
									fingerprint: "fp-incoming",
									groups: ["team-a"],
									addresses: ["http://10.0.0.5:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
								},
								{
									device_id: "peer-outgoing",
									display_name: "Waiting On Them",
									fingerprint: "fp-outgoing",
									groups: ["team-a"],
									addresses: ["http://10.0.0.6:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.includes("direction=incoming")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									request_id: "req-incoming",
									group_id: "team-a",
									requesting_device_id: "peer-incoming",
									requested_device_id: "local-device",
									status: "pending",
									created_at: new Date().toISOString(),
									resolved_at: null,
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.includes("direction=outgoing")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									request_id: "req-outgoing",
									group_id: "team-a",
									requesting_device_id: "local-device",
									requested_device_id: "peer-outgoing",
									status: "pending",
									created_at: new Date().toISOString(),
									resolved_at: null,
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
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });
				expect(deviceId).toBeTruthy();
				const res = await app.request("/api/sync/status?includeDiagnostics=1");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					coordinator: { discovered_devices: Array<Record<string, unknown>> };
				};
				expect(body.coordinator.discovered_devices).toEqual([
					expect.objectContaining({
						device_id: "peer-incoming",
						needs_local_approval: true,
						waiting_for_peer_approval: false,
						incoming_reciprocal_request_id: "req-incoming",
					}),
					expect.objectContaining({
						device_id: "peer-outgoing",
						needs_local_approval: false,
						waiting_for_peer_approval: true,
						outgoing_reciprocal_request_id: "req-outgoing",
					}),
				]);
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("accepts a discovered coordinator device into sync peers", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/v1/peers")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									device_id: "peer-fresh",
									display_name: "Fresh Device",
									fingerprint: "fp-fresh",
									public_key: "peer-public-key",
									addresses: ["http://10.0.0.5:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.endsWith("/v1/reciprocal-approvals")) {
					const requestBody = init?.body
						? JSON.parse(new TextDecoder().decode(init.body as ArrayBufferView))
						: {};
					expect(requestBody).toEqual({
						group_id: "team-a",
						requested_device_id: "peer-fresh",
					});
					return new Response(
						JSON.stringify({
							ok: true,
							request: {
								request_id: "req-1",
								group_id: "team-a",
								requesting_device_id: "local-device",
								requested_device_id: "peer-fresh",
								status: "pending",
								created_at: new Date().toISOString(),
								resolved_at: null,
							},
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
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-fresh", fingerprint: "fp-fresh" }),
				});
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({
					ok: true,
					peer_device_id: "peer-fresh",
					created: true,
					updated: false,
					name: "Fresh Device",
					needs_scope_review: true,
				});
				const peerRow = store.db
					.prepare(
						"SELECT peer_device_id, name, pinned_fingerprint, public_key, addresses_json, last_error FROM sync_peers WHERE peer_device_id = ?",
					)
					.get("peer-fresh") as Record<string, unknown> | undefined;
				expect(peerRow).toEqual(
					expect.objectContaining({
						peer_device_id: "peer-fresh",
						name: "Fresh Device",
						pinned_fingerprint: "fp-fresh",
						public_key: "peer-public-key",
						last_error: null,
					}),
				);
				expect(JSON.parse(String(peerRow?.addresses_json ?? "[]"))).toEqual([
					"http://10.0.0.5:7337",
				]);
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("does not persist a local peer when reciprocal approval publish fails", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/peers")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									device_id: "peer-fresh",
									display_name: "Fresh Device",
									fingerprint: "fp-fresh",
									public_key: "peer-public-key",
									groups: ["team-a"],
									addresses: ["http://10.0.0.5:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.endsWith("/v1/reciprocal-approvals")) {
					return new Response(JSON.stringify({ error: "coordinator_down" }), { status: 503 });
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
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-fresh", fingerprint: "fp-fresh" }),
				});
				expect(res.status).toBe(502);
				expect(await res.json()).toEqual({
					error: "coordinator_lookup_failed",
					detail: "coordinator reciprocal approval create failed (503: coordinator_down)",
				});
				const peerRow = store.db
					.prepare("SELECT peer_device_id FROM sync_peers WHERE peer_device_id = ?")
					.get("peer-fresh");
				expect(peerRow).toBeUndefined();
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("rejects accepting a discovered device when multiple coordinator groups match", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/peers?group_id=team-a")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									device_id: "peer-fresh",
									display_name: "Fresh Device",
									fingerprint: "fp-fresh",
									public_key: "peer-public-key",
									addresses: ["http://10.0.0.5:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.includes("/v1/peers?group_id=team-b")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									device_id: "peer-fresh",
									display_name: "Fresh Device",
									fingerprint: "fp-fresh",
									public_key: "peer-public-key",
									addresses: ["http://10.0.0.6:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
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
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_groups: ["team-a", "team-b"],
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-fresh", fingerprint: "fp-fresh" }),
				});
				expect(res.status).toBe(409);
				expect(await res.json()).toEqual({
					error: "ambiguous_coordinator_group",
					detail:
						"This device is visible through multiple coordinator groups. Review the team setup before approving it here.",
				});
				expect(fetchMock).not.toHaveBeenCalledWith(
					expect.stringMatching(/\/v1\/reciprocal-approvals$/),
					expect.anything(),
				);
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("renames an existing sync peer through the viewer route", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
					)
					.run("peer-rename", "Old Device", "fp-rename", new Date().toISOString());

				const res = await app.request("/api/sync/peers/rename", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-rename", name: "Desk Mini" }),
				});

				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ ok: true });

				const peerRow = store.db
					.prepare("SELECT name FROM sync_peers WHERE peer_device_id = ?")
					.get("peer-rename") as { name: string } | undefined;
				expect(peerRow?.name).toBe("Desk Mini");
			} finally {
				cleanup();
			}
		});

		it("assigns a sync peer to the local actor through the identity route", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				await app.request("/api/sync/actors");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
					)
					.run("peer-local", "Peer", "fp-local", new Date().toISOString());
				const localActor = store.db
					.prepare("SELECT actor_id FROM actors WHERE is_local = 1 LIMIT 1")
					.get() as { actor_id: string } | undefined;
				if (!localActor) throw new Error("local actor missing");

				const res = await app.request("/api/sync/peers/identity", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-local", actor_id: localActor.actor_id }),
				});

				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({
					ok: true,
					actor_id: localActor.actor_id,
					claimed_local_actor: true,
				});
			} finally {
				cleanup();
			}
		});

		it("updates peer project scope through the viewer route", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
					)
					.run("peer-scope", "Scoped Peer", "fp-scope", new Date().toISOString());

				const res = await app.request("/api/sync/peers/scope", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						peer_device_id: "peer-scope",
						include: ["proj-a"],
						exclude: ["proj-b"],
					}),
				});

				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({
					ok: true,
					project_scope: {
						include: ["proj-a"],
						exclude: ["proj-b"],
						effective_include: ["proj-a"],
						effective_exclude: ["proj-b"],
						inherits_global: false,
					},
				});
			} finally {
				cleanup();
			}
		});

		it("runs sync for all peers through the compatibility sync route", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(configPath, JSON.stringify({ sync_enabled: true }));
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?, ?)",
					)
					.run(
						"peer-run",
						"Peer Run",
						"fp-run",
						JSON.stringify(["http://127.0.0.1:65535"]),
						new Date().toISOString(),
					);
				const res = await app.request("/api/sync/run", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					items: Array<{ peer_device_id: string; ok: boolean }>;
				};
				expect(body.items).toHaveLength(1);
				expect(body.items[0]?.peer_device_id).toBe("peer-run");
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("claims a legacy device identity through the viewer route", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "legacy memory",
					actorId: null,
					originDeviceId: "legacy-device-a",
					metadata: {},
				});
				const res = await app.request("/api/sync/legacy-devices/claim", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ origin_device_id: "legacy-device-a" }),
				});
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({
					ok: true,
					origin_device_id: "legacy-device-a",
					updated: 1,
				});
			} finally {
				cleanup();
			}
		});

		it("returns effective global scope when a peer inherits global filters", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_projects_include: ["global-a"],
					sync_projects_exclude: ["global-b"],
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
					)
					.run("peer-global", "Global Peer", "fp-global", new Date().toISOString());
				const res = await app.request("/api/sync/peers?includeDiagnostics=1");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					items: Array<{ project_scope: Record<string, unknown> }>;
				};
				expect(body.items[0]?.project_scope).toEqual({
					include: [],
					exclude: [],
					effective_include: ["global-a"],
					effective_exclude: ["global-b"],
					inherits_global: true,
				});
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("identifies claimed local actor peers that need a personal scope grant", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO sync_peers(peer_device_id, name, actor_id, claimed_local_actor, created_at)
						 VALUES (?, ?, ?, 1, ?)`,
					)
					.run("peer-claim", "Peer Claim", store.actorId, now);

				const missingRes = await app.request("/api/sync/peers?includeDiagnostics=1");
				expect(missingRes.status).toBe(200);
				const missingBody = (await missingRes.json()) as {
					items: Array<{ claimed_local_actor_scope: Record<string, unknown> | null }>;
				};
				expect(missingBody.items[0]?.claimed_local_actor_scope).toMatchObject({
					scope_id: `personal:${store.actorId}`,
					authorized: false,
					state: "not_authorized",
					action_required: true,
				});

				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES (?, ?, 'user', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(`personal:${store.actorId}`, "Personal", now, now);
				store.db
					.prepare(
						`INSERT INTO scope_memberships(
							scope_id, device_id, role, status, membership_epoch, updated_at
						 ) VALUES (?, ?, 'member', 'active', 1, ?)`,
					)
					.run(`personal:${store.actorId}`, "peer-claim", now);

				const authorizedRes = await app.request("/api/sync/peers?includeDiagnostics=1");
				expect(authorizedRes.status).toBe(200);
				const authorizedBody = (await authorizedRes.json()) as {
					items: Array<{ claimed_local_actor_scope: Record<string, unknown> | null }>;
				};
				expect(authorizedBody.items[0]?.claimed_local_actor_scope).toMatchObject({
					scope_id: `personal:${store.actorId}`,
					authorized: true,
					state: "authorized",
					action_required: false,
				});
			} finally {
				cleanup();
			}
		});

		it("creates, renames, and merges actors through viewer routes", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				await app.request("/api/sync/actors");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const createRes = await app.request("/api/sync/actors", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ display_name: "Adam shadow" }),
				});
				expect(createRes.status).toBe(200);
				const created = (await createRes.json()) as { actor_id: string; display_name: string };
				expect(created.display_name).toBe("Adam shadow");

				const renameRes = await app.request("/api/sync/actors/rename", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ actor_id: created.actor_id, display_name: "Adam remote" }),
				});
				expect(renameRes.status).toBe(200);
				expect((await renameRes.json()).display_name).toBe("Adam remote");

				const localActor = store.db
					.prepare("SELECT actor_id FROM actors WHERE is_local = 1 LIMIT 1")
					.get() as { actor_id: string } | undefined;
				if (!localActor) throw new Error("local actor missing");
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, actor_id, created_at) VALUES (?, ?, ?, ?, ?)",
					)
					.run("peer-merge", "Peer Merge", "fp-merge", created.actor_id, new Date().toISOString());

				const mergeRes = await app.request("/api/sync/actors/merge", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						primary_actor_id: localActor.actor_id,
						secondary_actor_id: created.actor_id,
					}),
				});
				expect(mergeRes.status).toBe(200);
				expect(await mergeRes.json()).toEqual({ merged_count: 1 });

				const mergedActor = store.db
					.prepare("SELECT status, merged_into_actor_id FROM actors WHERE actor_id = ?")
					.get(created.actor_id) as
					| { status: string; merged_into_actor_id: string | null }
					| undefined;
				expect(mergedActor).toEqual({
					status: "merged",
					merged_into_actor_id: localActor.actor_id,
				});
			} finally {
				cleanup();
			}
		});

		it("maps claimed_local_actor=true to the local actor id when no actor id is provided", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				await app.request("/api/sync/actors");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
					)
					.run("peer-claim", "Peer Claim", "fp-claim", new Date().toISOString());
				const res = await app.request("/api/sync/peers/identity", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-claim", claimed_local_actor: true }),
				});
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({
					ok: true,
					actor_id: store.actorId,
					claimed_local_actor: true,
				});
			} finally {
				cleanup();
			}
		});

		it("rejects merging the local actor into another actor", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				await app.request("/api/sync/actors");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const createRes = await app.request("/api/sync/actors", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ display_name: "Other Person" }),
				});
				const created = (await createRes.json()) as { actor_id: string };
				const res = await app.request("/api/sync/actors/merge", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						primary_actor_id: created.actor_id,
						secondary_actor_id: store.actorId,
					}),
				});
				expect(res.status).toBe(409);
				expect(await res.json()).toEqual({ error: "cannot merge this device's own local actor" });
			} finally {
				cleanup();
			}
		});

		it("updates an existing peer when the discovered fingerprint matches", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/v1/peers")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									device_id: "peer-fresh",
									display_name: "Fresh Device",
									fingerprint: "fp-fresh",
									public_key: "peer-public-key",
									addresses: ["http://10.0.0.5:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.endsWith("/v1/reciprocal-approvals")) {
					const requestBody = init?.body
						? JSON.parse(new TextDecoder().decode(init.body as ArrayBufferView))
						: {};
					expect(requestBody).toEqual({
						group_id: "team-a",
						requested_device_id: "peer-fresh",
					});
					return new Response(
						JSON.stringify({
							ok: true,
							request: {
								request_id: "req-update",
								group_id: "team-a",
								requesting_device_id: "local-device",
								requested_device_id: "peer-fresh",
								status: "pending",
								created_at: new Date().toISOString(),
								resolved_at: null,
							},
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
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, addresses_json, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(
						"peer-fresh",
						"Old Name",
						"fp-fresh",
						JSON.stringify(["http://old.example:7337"]),
						"offline",
						new Date().toISOString(),
					);
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-fresh", fingerprint: "fp-fresh" }),
				});
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({
					ok: true,
					peer_device_id: "peer-fresh",
					created: false,
					updated: true,
					name: "Fresh Device",
					needs_scope_review: true,
				});
				const peerRow = store.db
					.prepare(
						"SELECT name, pinned_fingerprint, addresses_json, last_error FROM sync_peers WHERE peer_device_id = ?",
					)
					.get("peer-fresh") as Record<string, unknown> | undefined;
				expect(peerRow).toEqual(
					expect.objectContaining({
						name: "Fresh Device",
						pinned_fingerprint: "fp-fresh",
						last_error: "offline",
					}),
				);
				expect(JSON.parse(String(peerRow?.addresses_json ?? "[]"))).toEqual([
					"http://old.example:7337",
					"http://10.0.0.5:7337",
				]);
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("rejects accepting a discovered device when an existing peer is pinned to another fingerprint", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/peers")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									device_id: "peer-fresh",
									display_name: "Fresh Device",
									fingerprint: "fp-new",
									public_key: "peer-public-key",
									addresses: ["http://10.0.0.5:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
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
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
					)
					.run("peer-fresh", "Old Peer", "fp-old", new Date().toISOString());
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-fresh", fingerprint: "fp-new" }),
				});
				expect(res.status).toBe(409);
				expect(await res.json()).toEqual({
					error: "peer_conflict",
					detail:
						"An existing peer with this device id is pinned to a different fingerprint. Remove or repair the old peer before accepting this discovered device.",
				});
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("returns 404 when the discovered device is no longer present", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/peers")) {
					return new Response(JSON.stringify({ items: [] }), { status: 200 });
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
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-fresh", fingerprint: "fp-fresh" }),
				});
				expect(res.status).toBe(404);
				expect(await res.json()).toEqual({
					error: "discovered_peer_not_found",
					detail:
						"That discovered device is no longer available. Refresh sync status and try again.",
				});
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("returns 400 when coordinator sync is not configured", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(configPath, JSON.stringify({ sync_enabled: false }));
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-fresh", fingerprint: "fp-fresh" }),
				});
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					error: "coordinator_not_configured",
					detail: "Coordinator must be configured before accepting discovered peers.",
				});
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("accepts discovered peers when only plural coordinator groups are configured", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/v1/peers?group_id=team-a")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									device_id: "peer-fresh",
									display_name: "Fresh Device",
									fingerprint: "fp-fresh",
									public_key: "peer-public-key",
									addresses: ["http://10.0.0.5:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.endsWith("/v1/reciprocal-approvals")) {
					const requestBody = init?.body
						? JSON.parse(new TextDecoder().decode(init.body as ArrayBufferView))
						: {};
					expect(requestBody).toEqual({
						group_id: "team-a",
						requested_device_id: "peer-fresh",
					});
					return new Response(
						JSON.stringify({
							ok: true,
							request: {
								request_id: "req-2",
								group_id: "team-a",
								requesting_device_id: "local-device",
								requested_device_id: "peer-fresh",
								status: "pending",
								created_at: new Date().toISOString(),
								resolved_at: null,
							},
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
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_groups: ["team-a"],
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-fresh", fingerprint: "fp-fresh" }),
				});
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual(
					expect.objectContaining({
						ok: true,
						peer_device_id: "peer-fresh",
						created: true,
						updated: false,
						name: "Fresh Device",
						needs_scope_review: true,
					}),
				);
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("returns 502 when coordinator lookup fails during acceptance", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const fetchMock = vi.fn(
				async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
			);
			const prevFetch = globalThis.fetch;
			globalThis.fetch = fetchMock as typeof fetch;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_enabled: true,
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
				}),
			);
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ peer_device_id: "peer-fresh", fingerprint: "fp-fresh" }),
				});
				expect(res.status).toBe(502);
				expect(await res.json()).toEqual({
					error: "coordinator_lookup_failed",
					detail: "coordinator lookup failed (401: unauthorized)",
				});
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
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
				const body = (await res.json()) as {
					legacy_devices: Array<{ origin_device_id: string }>;
					sharing_review: Array<{
						peer_device_id: string;
						actor_display_name: string;
						shareable_count: number;
					}>;
				};
				expect(body.legacy_devices).toHaveLength(1);
				expect(body.legacy_devices[0]?.origin_device_id).toBe("legacy-peer-1");
				expect(body.sharing_review).toHaveLength(1);
				expect(body.sharing_review[0]?.peer_device_id).toBe("peer-actor");
				expect(body.sharing_review[0]?.actor_display_name).toBe("Peer Person");
				expect(body.sharing_review[0]?.shareable_count).toBe(1);
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
				expect(body.warnings).toEqual([]);
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("creates coordinator invites through the coordinator admin route", async () => {
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
				const res = await app.request("/api/coordinator/admin/invites", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ policy: "auto_admit", ttl_hours: 24 }),
				});
				expect(res.status).toBe(200);
				expect(await res.json()).toMatchObject({
					encoded: "invite-blob",
					group_id: "team-a",
					status: expect.objectContaining({ readiness: "ready", active_group: "team-a" }),
				});
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("returns invite warnings for private-looking coordinator URLs", async () => {
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
					sync_coordinator_url: "http://100.103.98.49:7347",
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
				expect(body.warnings).toEqual([
					"Invite uses a CGNAT/Tailscale-style coordinator IP address. This can be correct for Tailnet-only teams, but other teammates may not be able to join unless they share that network.",
				]);
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

		it("returns a clearer timeout error when invite import cannot reach the coordinator in time", async () => {
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
			const fetchMock = vi.fn(async () => {
				const error = new Error("The operation was aborted due to timeout");
				Object.assign(error, { name: "TimeoutError" });
				throw error;
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
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					error:
						"Invite import timed out contacting the coordinator at https://coord.example.test. Check that this machine can reach that URL and try again.",
				});
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("returns a clearer reachability error when invite import cannot contact the coordinator", async () => {
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
			const fetchMock = vi.fn(async () => {
				const error = new TypeError("fetch failed");
				throw error;
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
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					error:
						"Invite import could not reach the coordinator at https://coord.example.test. Check the invite URL and this machine's network access before retrying.",
				});
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("accepts a device pairing payload and writes the peer row", async () => {
			const peerKeysDir = mkdtempSync(join(tmpdir(), "codemem-pair-peer-keys-"));
			const peerDbDir = mkdtempSync(join(tmpdir(), "codemem-pair-peer-db-"));
			const peerDbPath = join(peerDbDir, "peer.sqlite");
			const peerDb = new Database(peerDbPath);
			initTestSchema(peerDb);
			const [peerDeviceId, peerFingerprint] = ensureDeviceIdentity(peerDb, {
				keysDir: peerKeysDir,
			});
			const peerPublicKey = loadPublicKey(peerKeysDir) ?? "";
			peerDb.close();
			const pairingPayload = {
				device_id: peerDeviceId,
				fingerprint: peerFingerprint,
				public_key: peerPublicKey,
				addresses: ["http://10.10.10.10:7337"],
			};
			const invite = Buffer.from(JSON.stringify(pairingPayload), "utf8").toString("base64");

			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const res = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					ok: true,
					type: "pair",
					peer_device_id: peerDeviceId,
				});
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const row = store.db
					.prepare(
						"SELECT peer_device_id, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?",
					)
					.get(peerDeviceId) as
					| { peer_device_id?: string; pinned_fingerprint?: string }
					| undefined;
				expect(row?.peer_device_id).toBe(peerDeviceId);
				expect(row?.pinned_fingerprint).toBe(peerFingerprint);
			} finally {
				cleanup();
			}
		});

		it("accepts a raw JSON pairing payload without base64 wrapping", async () => {
			const peerKeysDir = mkdtempSync(join(tmpdir(), "codemem-pair-peer-keys-"));
			const peerDbDir = mkdtempSync(join(tmpdir(), "codemem-pair-peer-db-"));
			const peerDbPath = join(peerDbDir, "peer.sqlite");
			const peerDb = new Database(peerDbPath);
			initTestSchema(peerDb);
			const [peerDeviceId, peerFingerprint] = ensureDeviceIdentity(peerDb, {
				keysDir: peerKeysDir,
			});
			const peerPublicKey = loadPublicKey(peerKeysDir) ?? "";
			peerDb.close();
			const pairingJson = JSON.stringify({
				device_id: peerDeviceId,
				fingerprint: peerFingerprint,
				public_key: peerPublicKey,
				addresses: ["http://10.10.10.10:7337"],
			});
			const { app, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const res = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite: pairingJson }),
				});
				expect(res.status).toBe(200);
				expect(await res.json()).toMatchObject({ type: "pair", peer_device_id: peerDeviceId });
			} finally {
				cleanup();
			}
		});

		it("unwraps the shell pairing command and accepts the embedded payload", async () => {
			const peerKeysDir = mkdtempSync(join(tmpdir(), "codemem-pair-peer-keys-"));
			const peerDbDir = mkdtempSync(join(tmpdir(), "codemem-pair-peer-db-"));
			const peerDbPath = join(peerDbDir, "peer.sqlite");
			const peerDb = new Database(peerDbPath);
			initTestSchema(peerDb);
			const [peerDeviceId, peerFingerprint] = ensureDeviceIdentity(peerDb, {
				keysDir: peerKeysDir,
			});
			const peerPublicKey = loadPublicKey(peerKeysDir) ?? "";
			peerDb.close();
			const pairingPayload = {
				device_id: peerDeviceId,
				fingerprint: peerFingerprint,
				public_key: peerPublicKey,
				addresses: ["http://10.10.10.10:7337"],
			};
			const b64 = Buffer.from(JSON.stringify(pairingPayload), "utf8").toString("base64");
			const shellWrapper = `echo '${b64}' | base64 -d | codemem sync pair --accept-file -`;

			const { app, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const res = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite: shellWrapper }),
				});
				expect(res.status).toBe(200);
				expect(await res.json()).toMatchObject({ type: "pair", peer_device_id: peerDeviceId });
			} finally {
				cleanup();
			}
		});

		it("rejects a pairing payload whose fingerprint does not match its public key", async () => {
			const peerKeysDir = mkdtempSync(join(tmpdir(), "codemem-pair-peer-keys-"));
			const peerDbDir = mkdtempSync(join(tmpdir(), "codemem-pair-peer-db-"));
			const peerDbPath = join(peerDbDir, "peer.sqlite");
			const peerDb = new Database(peerDbPath);
			initTestSchema(peerDb);
			const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
			const peerPublicKey = loadPublicKey(peerKeysDir) ?? "";
			peerDb.close();
			const tampered = {
				device_id: peerDeviceId,
				fingerprint: "ff".repeat(32), // wrong
				public_key: peerPublicKey,
				addresses: ["http://10.10.10.10:7337"],
			};
			const invite = Buffer.from(JSON.stringify(tampered), "utf8").toString("base64");
			const { app, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const res = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite }),
				});
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({ error: "Pairing payload fingerprint mismatch" });
			} finally {
				cleanup();
			}
		});

		it("reports coordinator admin readiness states", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevAdminSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				writeFileSync(configPath, JSON.stringify({}));
				const { app, cleanup } = createTestApp();
				try {
					const missing = await app.request("/api/coordinator/admin/status");
					expect(missing.status).toBe(200);
					expect(await missing.json()).toMatchObject({
						readiness: "not_configured",
						coordinator_url: null,
						has_admin_secret: false,
						has_groups: false,
					});
				} finally {
					cleanup();
				}

				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
					}),
				);
				const { app: partialApp, cleanup: cleanupPartial } = createTestApp();
				try {
					const partial = await partialApp.request("/api/coordinator/admin/status");
					expect(partial.status).toBe(200);
					expect(await partial.json()).toMatchObject({
						readiness: "partial",
						coordinator_url: "https://coord.example.test",
						active_group: "team-a",
						has_admin_secret: false,
						has_groups: true,
					});
				} finally {
					cleanupPartial();
				}

				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				const { app: readyApp, cleanup: cleanupReady } = createTestApp();
				try {
					const ready = await readyApp.request("/api/coordinator/admin/status");
					expect(ready.status).toBe(200);
					expect(await ready.json()).toMatchObject({
						readiness: "ready",
						coordinator_url: "https://coord.example.test",
						active_group: "team-a",
						has_admin_secret: true,
						has_groups: true,
					});
				} finally {
					cleanupReady();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevAdminSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = prevAdminSecret;
			}
		});

		it("lists coordinator join requests through the admin route", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/join-requests?group_id=team-a")) {
					return new Response(
						JSON.stringify({
							items: [{ request_id: "req-1", group_id: "team-a", device_id: "device-1" }],
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const res = await app.request("/api/coordinator/admin/join-requests");
					expect(res.status).toBe(200);
					expect(await res.json()).toMatchObject({
						group_id: "team-a",
						items: [expect.objectContaining({ request_id: "req-1" })],
						status: expect.objectContaining({ readiness: "ready" }),
					});
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
			}
		});

		it("lists coordinator groups through the admin route", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/groups")) {
					return new Response(
						JSON.stringify({
							items: [
								{ group_id: "team-a", display_name: "Team A" },
								{ group_id: "nerdworld", display_name: "Nerdworld" },
							],
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const res = await app.request("/api/coordinator/admin/groups");
					expect(res.status).toBe(200);
					expect(await res.json()).toMatchObject({
						items: [
							expect.objectContaining({ group_id: "team-a" }),
							expect.objectContaining({ group_id: "nerdworld" }),
						],
						status: expect.objectContaining({ readiness: "ready" }),
					});
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
			}
		});

		it("runs coordinator group lifecycle actions through the admin routes", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (
					url.includes("/v1/admin/groups") &&
					!url.includes("rename") &&
					!url.includes("archive") &&
					!url.includes("unarchive")
				) {
					return new Response(
						JSON.stringify({
							group: { group_id: "team-a", display_name: "Team A", archived_at: null },
						}),
						{ status: 200 },
					);
				}
				if (url.includes("/v1/admin/groups/rename")) {
					return new Response(
						JSON.stringify({
							group: { group_id: "team-a", display_name: "Renamed", archived_at: null },
						}),
						{ status: 200 },
					);
				}
				if (url.includes("/v1/admin/groups/archive")) {
					return new Response(
						JSON.stringify({
							group: {
								group_id: "team-a",
								display_name: "Renamed",
								archived_at: "2026-04-14T00:00:00Z",
							},
						}),
						{ status: 200 },
					);
				}
				if (url.includes("/v1/admin/groups/unarchive")) {
					return new Response(
						JSON.stringify({
							group: { group_id: "team-a", display_name: "Renamed", archived_at: null },
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const created = await app.request("/api/coordinator/admin/groups", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ group_id: "team-a", display_name: "Team A" }),
					});
					expect(created.status).toBe(200);
					const renamed = await app.request("/api/coordinator/admin/groups/team-a/rename", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ display_name: "Renamed" }),
					});
					expect(renamed.status).toBe(200);
					const archived = await app.request("/api/coordinator/admin/groups/team-a/archive", {
						method: "POST",
					});
					expect(archived.status).toBe(200);
					const unarchived = await app.request("/api/coordinator/admin/groups/team-a/unarchive", {
						method: "POST",
					});
					expect(unarchived.status).toBe(200);
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
			}
		});

		it("gates coordinator Sharing domain admin routes without an admin secret", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			const prevFetch = globalThis.fetch;
			const fetchMock = vi.fn();
			try {
				process.env.CODEMEM_CONFIG = configPath;
				delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const res = await app.request("/api/coordinator/admin/groups/team-a/scopes");
					expect(res.status).toBe(400);
					expect(await res.json()).toMatchObject({
						error: "coordinator_admin_secret_missing",
						status: { readiness: "partial", has_admin_secret: false },
					});
					expect(fetchMock).not.toHaveBeenCalled();
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = prevSecret;
				globalThis.fetch = prevFetch;
			}
		});

		it("proxies coordinator Sharing domain metadata routes without relaying memory payloads", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			const bodyJson = (init: RequestInit | undefined): Record<string, unknown> => {
				const body = init?.body;
				if (body instanceof Uint8Array) {
					return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
				}
				if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
				return {};
			};
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/groups/team-a/scopes?include_inactive=1")) {
					return new Response(
						JSON.stringify({
							items: [{ scope_id: "scope-a", group_id: "team-a", label: "Scope A" }],
						}),
						{ status: 200 },
					);
				}
				if (url.endsWith("/v1/admin/groups/team-a/scopes")) {
					return new Response(
						JSON.stringify({
							scope: { scope_id: "scope-b", group_id: "team-a", label: "Scope B" },
						}),
						{ status: 201 },
					);
				}
				if (url.endsWith("/v1/admin/groups/team-a/scopes/scope-b")) {
					return new Response(
						JSON.stringify({
							scope: { scope_id: "scope-b", group_id: "team-a", label: "Renamed" },
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = "secret";
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const listed = await app.request(
						"/api/coordinator/admin/groups/team-a/scopes?include_inactive=1",
					);
					expect(listed.status).toBe(200);
					expect(await listed.json()).toMatchObject({
						group_id: "team-a",
						items: [expect.objectContaining({ scope_id: "scope-a" })],
					});

					const created = await app.request("/api/coordinator/admin/groups/team-a/scopes", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							scope_id: "scope-b",
							label: "Scope B",
							membership_epoch: 2,
							memory_payload: { id: 1 },
						}),
					});
					expect(created.status).toBe(200);
					const createdBody = (await created.json()) as Record<string, unknown>;
					expect(createdBody).toMatchObject({
						status: { has_admin_secret: true },
					});
					expect(createdBody).not.toHaveProperty("sync_coordinator_admin_secret");
					expect(Object.values(createdBody.status as Record<string, unknown>)).not.toContain(
						"secret",
					);

					const updated = await app.request("/api/coordinator/admin/groups/team-a/scopes/scope-b", {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ label: "Renamed", memory_items: [{ id: 1 }] }),
					});
					expect(updated.status).toBe(200);

					const calls = fetchMock.mock.calls;
					expect(calls).toHaveLength(3);
					for (const call of calls) {
						const init = call[1] as RequestInit | undefined;
						const headers = init?.headers as Record<string, string> | undefined;
						expect(headers?.["X-Codemem-Coordinator-Admin"]).toBe("secret");
					}
					const createBody = bodyJson(calls[1]?.[1] as RequestInit | undefined);
					expect(createBody).toMatchObject({ scope_id: "scope-b", membership_epoch: 2 });
					expect(createBody).not.toHaveProperty("memory_payload");
					const updateBody = bodyJson(calls[2]?.[1] as RequestInit | undefined);
					expect(updateBody).toMatchObject({ label: "Renamed" });
					expect(updateBody).not.toHaveProperty("memory_items");
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = prevSecret;
				globalThis.fetch = prevFetch;
			}
		});

		it("proxies coordinator Sharing domain membership routes without relaying memory payloads", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			const bodyJson = (init: RequestInit | undefined): Record<string, unknown> => {
				const body = init?.body;
				if (body instanceof Uint8Array) {
					return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
				}
				if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
				return {};
			};
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/groups/team-a/scopes/scope-a/members?include_revoked=1")) {
					return new Response(
						JSON.stringify({
							items: [{ scope_id: "scope-a", group_id: "team-a", device_id: "device-1" }],
						}),
						{ status: 200 },
					);
				}
				if (url.endsWith("/v1/admin/groups/team-a/scopes/scope-a/members")) {
					return new Response(
						JSON.stringify({
							membership: { scope_id: "scope-a", group_id: "team-a", device_id: "device-1" },
						}),
						{ status: 201 },
					);
				}
				if (url.endsWith("/v1/admin/groups/team-a/scopes/scope-a/members/device-1/revoke")) {
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = "secret";
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const listed = await app.request(
						"/api/coordinator/admin/groups/team-a/scopes/scope-a/members?include_revoked=1",
					);
					expect(listed.status).toBe(200);
					expect(await listed.json()).toMatchObject({
						group_id: "team-a",
						scope_id: "scope-a",
						items: [expect.objectContaining({ device_id: "device-1" })],
					});

					const granted = await app.request(
						"/api/coordinator/admin/groups/team-a/scopes/scope-a/members",
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								device_id: "device-1",
								role: "reader",
								membership_epoch: 3,
								memory_payload: { id: 1 },
							}),
						},
					);
					expect(granted.status).toBe(200);

					const revoked = await app.request(
						"/api/coordinator/admin/groups/team-a/scopes/scope-a/members/device-1/revoke",
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ membership_epoch: 4, memory_items: [{ id: 1 }] }),
						},
					);
					expect(revoked.status).toBe(200);

					const calls = fetchMock.mock.calls;
					expect(calls).toHaveLength(3);
					const grantBody = bodyJson(calls[1]?.[1] as RequestInit | undefined);
					expect(grantBody).toMatchObject({ device_id: "device-1", role: "reader" });
					expect(grantBody).not.toHaveProperty("memory_payload");
					const revokeBody = bodyJson(calls[2]?.[1] as RequestInit | undefined);
					expect(revokeBody).toMatchObject({ membership_epoch: 4 });
					expect(revokeBody).not.toHaveProperty("memory_items");
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = prevSecret;
				globalThis.fetch = prevFetch;
			}
		});

		it("reviews coordinator join requests through the admin route", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/join-requests/approve")) {
					return new Response(
						JSON.stringify({ request: { request_id: "req-1", status: "approved" } }),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const res = await app.request("/api/coordinator/admin/join-requests/req-1/approve", {
						method: "POST",
					});
					expect(res.status).toBe(200);
					expect(await res.json()).toMatchObject({
						ok: true,
						request: { request_id: "req-1", status: "approved" },
						status: expect.objectContaining({ readiness: "ready" }),
					});
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
			}
		});

		it("lists coordinator devices through the admin route", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/devices?group_id=team-a&include_disabled=1")) {
					return new Response(
						JSON.stringify({
							items: [{ device_id: "device-1", group_id: "team-a", display_name: "Laptop" }],
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const res = await app.request("/api/coordinator/admin/devices?include_disabled=1");
					expect(res.status).toBe(200);
					expect(await res.json()).toMatchObject({
						group_id: "team-a",
						items: [expect.objectContaining({ device_id: "device-1", display_name: "Laptop" })],
						status: expect.objectContaining({ readiness: "ready" }),
					});
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
			}
		});

		it("runs coordinator device admin actions through the admin routes", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/devices/rename")) {
					return new Response(
						JSON.stringify({
							device: { device_id: "device-1", group_id: "team-a", display_name: "Renamed" },
						}),
						{ status: 200 },
					);
				}
				if (url.includes("/v1/admin/devices/disable")) {
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				}
				if (url.includes("/v1/admin/devices/enable")) {
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				}
				if (url.includes("/v1/admin/devices/remove")) {
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			});
			const prevFetch = globalThis.fetch;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const renamed = await app.request("/api/coordinator/admin/devices/device-1/rename", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ display_name: "Renamed" }),
					});
					expect(renamed.status).toBe(200);
					expect(await renamed.json()).toMatchObject({
						ok: true,
						device: expect.objectContaining({ device_id: "device-1", display_name: "Renamed" }),
					});

					const disabled = await app.request("/api/coordinator/admin/devices/device-1/disable", {
						method: "POST",
					});
					expect(disabled.status).toBe(200);
					expect(await disabled.json()).toMatchObject({ ok: true, device_id: "device-1" });

					const enabled = await app.request("/api/coordinator/admin/devices/device-1/enable", {
						method: "POST",
					});
					expect(enabled.status).toBe(200);
					expect(await enabled.json()).toMatchObject({ ok: true, device_id: "device-1" });

					const removed = await app.request("/api/coordinator/admin/devices/device-1/remove", {
						method: "POST",
					});
					expect(removed.status).toBe(200);
					expect(await removed.json()).toMatchObject({ ok: true, device_id: "device-1" });
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
			}
		});

		it("reads and writes local coordinator group preferences without admin secret", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				// No admin secret: preferences are a local-only setting and must
				// remain reachable without coordinator-admin privileges.
				delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
					}),
				);
				const { app, cleanup } = createTestApp();
				try {
					const initial = await app.request("/api/coordinator/admin/groups/team-a/preferences");
					expect(initial.status).toBe(200);
					expect(await initial.json()).toMatchObject({
						preferences: {
							coordinator_id: "https://coord.example.test",
							group_id: "team-a",
							auto_seed_scope: true,
							updated_at: null,
						},
					});
					const saved = await app.request("/api/coordinator/admin/groups/team-a/preferences", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							projects_include: ["work/*"],
							auto_seed_scope: false,
						}),
					});
					expect(saved.status).toBe(200);
					expect(await saved.json()).toMatchObject({
						preferences: {
							projects_include: ["work/*"],
							auto_seed_scope: false,
						},
					});
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = prevSecret;
			}
		});

		it("allows manual enroll-peer without admin secret and gates discovered-mode", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_group: "team-a",
						// No sync_coordinator_admin_secret: manual mode must still work.
					}),
				);
				const { app, cleanup } = createTestApp();
				try {
					// Manual mode is local-only and should succeed without the secret.
					const manualRes = await app.request("/api/coordinator/admin/groups/team-a/enroll-peer", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							mode: "manual",
							peer_device_id: "peer-local-manual",
							peer_public_key: "pk",
						}),
					});
					expect(manualRes.status).toBe(200);
					expect(await manualRes.json()).toMatchObject({ ok: true, created: true });

					// Discovered mode calls the coordinator and must be gated.
					const discoveredRes = await app.request(
						"/api/coordinator/admin/groups/team-a/enroll-peer",
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								mode: "discovered",
								peer_device_id: "peer-remote",
								fingerprint: "fp",
							}),
						},
					);
					expect(discoveredRes.status).toBe(400);
					expect(await discoveredRes.json()).toMatchObject({
						error: "coordinator_admin_secret_missing",
					});
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = prevSecret;
			}
		});

		it("returns 409 when manual enroll-peer collides with an existing peer", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			try {
				process.env.CODEMEM_CONFIG = configPath;
				writeFileSync(
					configPath,
					JSON.stringify({
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
					store.db
						.prepare(
							"INSERT INTO sync_peers(peer_device_id, name, public_key, created_at) VALUES (?, ?, ?, ?)",
						)
						.run("peer-dup", "Existing", "pk", new Date().toISOString());
					const res = await app.request("/api/coordinator/admin/groups/team-a/enroll-peer", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							mode: "manual",
							peer_device_id: "peer-dup",
							peer_public_key: "pk",
						}),
					});
					expect(res.status).toBe(409);
					expect(await res.json()).toMatchObject({ error: "peer_exists" });
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("deletes sync peers through the viewer route", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare("INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES (?, ?, ?)")
					.run("peer-delete-me", "Old Peer", new Date().toISOString());
				store.db
					.prepare(
						"INSERT INTO replication_cursors(peer_device_id, last_applied_cursor, last_acked_cursor, updated_at) VALUES (?, ?, ?, ?)",
					)
					.run("peer-delete-me", "cursor-1", "cursor-1", new Date().toISOString());
				const res = await app.request("/api/sync/peers/peer-delete-me", { method: "DELETE" });
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ ok: true });
				const remaining = store.db
					.prepare("SELECT peer_device_id FROM sync_peers WHERE peer_device_id = ?")
					.get("peer-delete-me");
				const cursor = store.db
					.prepare("SELECT peer_device_id FROM replication_cursors WHERE peer_device_id = ?")
					.get("peer-delete-me");
				expect(remaining).toBeUndefined();
				expect(cursor).toBeUndefined();
			} finally {
				cleanup();
			}
		});

		it("returns 404 when deleting a missing sync peer", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/peers/missing-peer", { method: "DELETE" });
				expect(res.status).toBe(404);
				expect(await res.json()).toEqual({ error: "peer not found" });
			} finally {
				cleanup();
			}
		});
	});
});
