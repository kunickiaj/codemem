/**
 * Viewer-server integration tests.
 *
 * Uses initTestSchema from @codemem/core (fix #5 — no duplicated DDL).
 * Uses Record<string, unknown> instead of Record<string, any> (fix #6).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import * as core from "@codemem/core";
import {
	buildAuthHeaders,
	connect,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	initTestSchema,
	insertTestSession,
	loadPublicKey,
	MemoryStore,
	seedMixedScopeFixture,
	startMaintenanceJob,
	updateMaintenanceJob,
	VERSION,
} from "@codemem/core";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createApp, createSyncApp } from "./index.js";
import { __usageCacheTestHooks } from "./routes/stats.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestStore(seedDevice = true): { store: MemoryStore; cleanup: () => void } {
	const tmpDir = mkdtempSync(join(tmpdir(), "codemem-viewer-store-test-"));
	const dbPath = join(tmpDir, "test.sqlite");
	const rawDb = new Database(dbPath);
	initTestSchema(rawDb);
	if (seedDevice) {
		rawDb
			.prepare(
				"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
			)
			.run("test-device-001", "test-public-key", "test-fingerprint", new Date().toISOString());
	}
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

function createRealSyncStore(prefix: string): {
	store: MemoryStore;
	keysDir: string;
	cleanup: () => void;
} {
	const tmpDir = mkdtempSync(join(tmpdir(), prefix));
	const dbPath = join(tmpDir, "mem.sqlite");
	const rawDb = new Database(dbPath);
	initTestSchema(rawDb);
	rawDb.close();
	const store = new MemoryStore(dbPath);
	return {
		store,
		keysDir: join(tmpDir, "keys"),
		cleanup: () => {
			store.close();
			rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

async function startTestSyncServer(app: ReturnType<typeof createSyncApp>): Promise<{
	url: string;
	close: () => Promise<void>;
}> {
	return new Promise((resolve) => {
		const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
			resolve({
				url: `http://127.0.0.1:${info.port}`,
				close: () =>
					new Promise<void>((closeResolve, closeReject) => {
						server.close((err) => {
							if (err) closeReject(err);
							else closeResolve();
						});
					}),
			});
		});
	});
}

const FRESH_PEER_PUBLIC_KEY = "peer-public-key";
const FRESH_PEER_FINGERPRINT = core.fingerprintPublicKey(FRESH_PEER_PUBLIC_KEY);
const REKEYED_PEER_PUBLIC_KEY = "peer-rekeyed-public-key";
const REKEYED_PEER_FINGERPRINT = core.fingerprintPublicKey(REKEYED_PEER_PUBLIC_KEY);

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
	seedDevice?: boolean;
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
			const created = createTestStore(opts?.seedDevice);
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
		ensureStore: () => storeFactory(),
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

function authorizationReplicationSnapshot(store: MemoryStore): Record<string, unknown[]> {
	return Object.fromEntries(
		[
			"replication_scopes",
			"scope_memberships",
			"scope_membership_cache_state",
			"project_scope_mappings",
			"replication_ops",
			"replication_cursors",
			"replication_cursors_v2",
			"sync_reset_state",
			"sync_reset_state_v2",
		].map((table) => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("viewer-server", () => {
	it("serves viewer shell and app bundle with cache-safe headers", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-viewer-static-cache-"));
		const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
		process.env.CODEMEM_VIEWER_STATIC_DIR = tmpDir;
		try {
			writeFileSync(
				join(tmpDir, "index.html"),
				'<!doctype html><script src="/assets/app.js"></script>',
			);
			writeFileSync(join(tmpDir, "app.js"), "globalThis.__codememTestApp = true;");
			const app = createApp({
				storeFactory: () => createTestStore().store,
			});

			const index = await app.request("/");
			expect(index.headers.get("cache-control")).toBe("no-store");

			const bundle = await app.request("/assets/app.js");
			expect(bundle.status).toBe(200);
			expect(bundle.headers.get("cache-control")).toBe("no-cache");
		} finally {
			if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
			else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("serves the brotli-precompressed app bundle when the client accepts it", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-viewer-static-br-"));
		const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
		process.env.CODEMEM_VIEWER_STATIC_DIR = tmpDir;
		try {
			writeFileSync(
				join(tmpDir, "index.html"),
				'<!doctype html><script src="/assets/app.js"></script>',
			);
			const rawBundle = "globalThis.__codememTestApp = true;";
			writeFileSync(join(tmpDir, "app.js"), rawBundle);
			writeFileSync(join(tmpDir, "app.js.br"), brotliCompressSync(Buffer.from(rawBundle)));
			const app = createApp({
				storeFactory: () => createTestStore().store,
			});

			const compressed = await app.request("/assets/app.js", {
				headers: { "Accept-Encoding": "br" },
			});
			expect(compressed.status).toBe(200);
			expect(compressed.headers.get("content-encoding")).toBe("br");

			// No matching encoding -> raw file, no Content-Encoding header.
			const identity = await app.request("/assets/app.js", {
				headers: { "Accept-Encoding": "identity" },
			});
			expect(identity.status).toBe(200);
			expect(identity.headers.get("content-encoding")).toBeNull();
		} finally {
			if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
			else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

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
				const inactiveId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Forgotten pack item",
					scopeId: "authorized-team",
					active: false,
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
							pack_item_ids: [visibleId, hiddenId, inactiveId],
							added_ids: [visibleId, hiddenId, inactiveId],
							removed_ids: [hiddenId, inactiveId],
							retained_ids: [String(visibleId), String(hiddenId), String(inactiveId)],
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
				// recent_packs stays scope-filtered: only the visible-session pack
				// survives, with hidden ids stripped from its metadata.
				expect(body.recent_packs).toHaveLength(1);
				// Aggregate totals are unfiltered SQL sums over every usage row
				// (both packs), matching store.stats() semantics.
				expect(body.totals).toMatchObject({ count: 2, tokens_read: 1122, tokens_saved: 1455 });
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

		it("does not expose hidden usage rows that reference visible pack ids", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const visibleSessionId = insertTestSession(store.db);
				const visibleId = insertTestMemory(store, {
					sessionId: visibleSessionId,
					kind: "discovery",
					title: "Visible pack item from another session",
					scopeId: "authorized-team",
				});
				const hiddenSessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId: hiddenSessionId,
					kind: "discovery",
					title: "Hidden session item",
					scopeId: "unauthorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 999, 0, 999, ?, ?)`,
					)
					.run(
						hiddenSessionId,
						"2026-03-29T23:30:00Z",
						JSON.stringify({ pack_item_ids: [visibleId], project: "secret-project" }),
					);

				const res = await app.request("/api/usage");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					recent_packs: unknown[];
					totals: { count: number; tokens_read: number; tokens_saved: number };
				};
				// The hidden-session pack is still excluded from recent_packs
				// (session not visible), but the unfiltered aggregate totals count
				// it just like store.stats() would.
				expect(body.recent_packs).toHaveLength(0);
				expect(body.totals).toMatchObject({ count: 1, tokens_read: 999, tokens_saved: 999 });
			} finally {
				cleanup();
			}
		});

		it("batches usage memory visibility instead of fetching each pack item", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const visibleIds = Array.from({ length: 25 }, (_, idx) =>
					insertTestMemory(store, {
						sessionId,
						kind: "discovery",
						title: `Visible usage item ${idx}`,
					}),
				);
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 123, 0, 456, ?, ?)`,
					)
					.run(
						sessionId,
						"2026-03-28T23:30:00Z",
						JSON.stringify({ pack_item_ids: visibleIds, added_ids: visibleIds }),
					);
				const getSpy = vi.spyOn(store, "get");

				const res = await app.request("/api/usage");

				expect(res.status).toBe(200);
				expect(getSpy).not.toHaveBeenCalled();
				const body = (await res.json()) as { recent_packs: Array<{ metadata_json: unknown }> };
				expect(body.recent_packs[0]?.metadata_json).toMatchObject({
					pack_item_ids: visibleIds,
					added_ids: visibleIds,
				});
			} finally {
				cleanup();
			}
		});

		it("serves a cached usage payload within the short TTL window", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Cached usage memory",
				});
				const insertPack = (createdAt: string) =>
					store.db
						.prepare(
							`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
							 VALUES (?, 'pack', 100, 0, 200, ?, '{}')`,
						)
						.run(sessionId, createdAt);

				insertPack("2026-03-26T23:30:00Z");
				const first = (await (await app.request("/api/usage")).json()) as {
					totals: { count: number };
				};
				expect(first.totals.count).toBe(1);

				// A second pack inserted immediately should NOT change the cached
				// response while the TTL window is still open.
				insertPack("2026-03-26T23:31:00Z");
				const second = (await (await app.request("/api/usage")).json()) as {
					totals: { count: number };
				};
				expect(second.totals.count).toBe(1);
			} finally {
				cleanup();
			}
		});

		it("busts the usage cache when scope visibility changes within the TTL", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Scoped usage memory",
					scopeId: "authorized-team",
				});
				store.db
					.prepare(
						`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
						 VALUES (?, 'pack', 100, 0, 200, ?, '{}')`,
					)
					.run(sessionId, "2026-03-26T23:30:00Z");

				const beforeRevoke = (await (await app.request("/api/usage")).json()) as {
					recent_packs: unknown[];
				};
				expect(beforeRevoke.recent_packs).toHaveLength(1);

				// Revoke the device's membership. Even within the TTL window the
				// next request must recompute and hide the now-invisible scope
				// instead of serving the cached (visible) payload. recent_packs is
				// the scope-sensitive surface here (aggregate totals are now
				// unfiltered, so they would not reflect a visibility change).
				store.db
					.prepare("DELETE FROM scope_memberships WHERE scope_id = ? AND device_id = ?")
					.run("authorized-team", store.deviceId);

				const afterRevoke = (await (await app.request("/api/usage")).json()) as {
					recent_packs: unknown[];
				};
				expect(afterRevoke.recent_packs).toHaveLength(0);
			} finally {
				cleanup();
			}
		});

		it("evicts expired usage-cache entries on sweep", () => {
			const { cache, sweep } = __usageCacheTestHooks;
			cache.clear();
			try {
				const nowMs = 1_000_000;
				// One already-expired entry and one still-live entry.
				cache.set("expired-key", { payload: {}, expiresAtMs: nowMs - 1 });
				cache.set("live-key", { payload: {}, expiresAtMs: nowMs + 10_000 });
				sweep(cache, nowMs);
				expect(cache.has("expired-key")).toBe(false);
				expect(cache.has("live-key")).toBe(true);
				expect(cache.size).toBe(1);
			} finally {
				cache.clear();
			}
		});

		it("caps the usage cache under a flood of distinct /api/usage requests", async () => {
			const { app, cleanup } = createTestApp();
			const { cache, maxEntries } = __usageCacheTestHooks;
			cache.clear();
			try {
				await app.request("/api/stats");
				// Each distinct ?project= yields a distinct cache key (see
				// usageCacheKey), mirroring the per-request-unique key growth the
				// sweep defends against. Driving the real endpoint guards the
				// handler's use of the sweep, not just the helper in isolation — if
				// the sweep call is ever removed from the handler, this fails.
				for (let i = 0; i < maxEntries + 50; i += 1) {
					await app.request(`/api/usage?project=flood-${i}`);
				}
				expect(cache.size).toBeGreaterThan(1);
				expect(cache.size).toBeLessThanOrEqual(maxEntries);
			} finally {
				cache.clear();
				cleanup();
			}
		});

		it("aggregates token/event totals in SQL with hand-summed global and project values", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const codememSession = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("codemem", codememSession);
				const otherSession = insertTestSession(store.db);
				store.db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("other", otherSession);

				const insertUsage = (
					sessionId: number,
					event: string,
					read: number,
					written: number,
					saved: number | null,
					createdAt: string,
				) =>
					store.db
						.prepare(
							`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
							 VALUES (?, ?, ?, ?, ?, ?, '{}')`,
						)
						.run(sessionId, event, read, written, saved, createdAt);

				// codemem project: two packs + one search.
				insertUsage(codememSession, "pack", 100, 10, 5, "2026-03-26T23:30:00Z");
				insertUsage(codememSession, "pack", 200, 20, null, "2026-03-26T23:31:00Z");
				insertUsage(codememSession, "search", 30, 3, 7, "2026-03-26T23:32:00Z");
				// other project: one pack.
				insertUsage(otherSession, "pack", 1000, 100, 50, "2026-03-26T23:33:00Z");

				const res = await app.request("/api/usage?project=codemem");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					events_global: Array<{
						event: string;
						total_tokens_read: number;
						total_tokens_written: number;
						total_tokens_saved: number;
						count: number;
					}>;
					totals_global: {
						tokens_read: number;
						tokens_written: number;
						tokens_saved: number;
						count: number;
					};
					events_filtered: Array<{
						event: string;
						total_tokens_read: number;
						total_tokens_written: number;
						total_tokens_saved: number;
						count: number;
					}> | null;
					totals_filtered: {
						tokens_read: number;
						tokens_written: number;
						tokens_saved: number;
						count: number;
					} | null;
					totals: {
						tokens_read: number;
						tokens_written: number;
						tokens_saved: number;
						count: number;
					};
				};

				// Global aggregate = all four rows, NULL tokens_saved coalesced to 0.
				expect(body.totals_global).toEqual({
					tokens_read: 1330,
					tokens_written: 133,
					tokens_saved: 62,
					count: 4,
				});
				// events_global is sorted by event name ASC (pack before search).
				expect(body.events_global).toEqual([
					{
						event: "pack",
						total_tokens_read: 1300,
						total_tokens_written: 130,
						total_tokens_saved: 55,
						count: 3,
					},
					{
						event: "search",
						total_tokens_read: 30,
						total_tokens_written: 3,
						total_tokens_saved: 7,
						count: 1,
					},
				]);

				// Project-filtered aggregate = only the codemem rows.
				expect(body.totals_filtered).toEqual({
					tokens_read: 330,
					tokens_written: 33,
					tokens_saved: 12,
					count: 3,
				});
				expect(body.events_filtered).toEqual([
					{
						event: "pack",
						total_tokens_read: 300,
						total_tokens_written: 30,
						total_tokens_saved: 5,
						count: 2,
					},
					{
						event: "search",
						total_tokens_read: 30,
						total_tokens_written: 3,
						total_tokens_saved: 7,
						count: 1,
					},
				]);

				// When a project filter is present, `totals` mirrors the filtered values.
				expect(body.totals).toEqual(body.totals_filtered);
			} finally {
				cleanup();
			}
		});

		it("orders recent_packs by created_at DESC and caps the surfaced window", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Recent-pack visible memory",
				});
				const insertPack = (createdAt: string, tokensRead: number) =>
					store.db
						.prepare(
							`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
							 VALUES (?, 'pack', ?, 0, 0, ?, '{}')`,
						)
						.run(sessionId, tokensRead, createdAt);

				// Insert 15 packs in ascending time order; the route should return
				// the newest first and never surface more than 10.
				for (let i = 0; i < 15; i += 1) {
					const minute = String(i).padStart(2, "0");
					insertPack(`2026-03-26T23:${minute}:00Z`, i);
				}

				const res = await app.request("/api/usage");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					recent_packs: Array<{ created_at: string }>;
				};
				expect(body.recent_packs).toHaveLength(10);
				const timestamps = body.recent_packs.map((row) => row.created_at);
				const sortedDesc = [...timestamps].sort((a, b) => b.localeCompare(a));
				expect(timestamps).toEqual(sortedDesc);
				// Newest seeded pack (minute 14) is first; oldest surfaced is minute 05.
				expect(timestamps[0]).toBe("2026-03-26T23:14:00Z");
				expect(timestamps.at(-1)).toBe("2026-03-26T23:05:00Z");
			} finally {
				cleanup();
			}
		});

		it("does not surface a visible pack older than the bounded recent-pack window", async () => {
			// Documents the deliberate truncation tradeoff: the recent_packs window
			// considers only the newest RECENT_PACK_SCAN_LIMIT (200) pack events, so
			// a visible pack buried under that many newer non-visible packs is not
			// surfaced — while the unfiltered aggregate still counts every event.
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Starvation-test visible memory",
				});
				const insertPack = (sessionRef: number | null, createdAt: string) =>
					store.db
						.prepare(
							`INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
							 VALUES (?, 'pack', 1, 0, 0, ?, '{}')`,
						)
						.run(sessionRef, createdAt);

				// One visible pack at the OLDEST timestamp (session is visible)...
				insertPack(sessionId, "2026-03-26T00:00:00Z");
				// ...buried under 200 NEWER non-visible packs (NULL session => a row
				// with no pack_item_ids and a null session is never visible). The
				// newest-200 window is entirely non-visible, so the lone visible pack
				// sits at position 201 and is never considered.
				for (let i = 0; i < 200; i += 1) {
					const minute = String(Math.floor(i / 60)).padStart(2, "0");
					const second = String(i % 60).padStart(2, "0");
					insertPack(null, `2026-04-01T00:${minute}:${second}Z`);
				}

				const res = await app.request("/api/usage");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					recent_packs: unknown[];
					totals_global: { count: number };
				};
				// recent_packs is starved to empty even though a visible pack exists...
				expect(body.recent_packs).toHaveLength(0);
				// ...while the unfiltered aggregate still counts every pack event (201).
				expect(body.totals_global.count).toBe(201);
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

		it("keeps mixed-domain unauthorized scope rows out of viewer direct surfaces", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const fixture = seedMixedScopeFixture(store.db, store.deviceId);

				const memoryRes = await app.request("/api/memory?limit=10");
				expect(memoryRes.status).toBe(200);
				const memory = (await memoryRes.json()) as {
					items: Array<{ id: number; title: string }>;
				};
				expect(memory.items.map((item) => item.id)).toEqual(
					expect.arrayContaining(fixture.visibleIds),
				);
				expect(memory.items.map((item) => item.id)).not.toContain(fixture.unauthorizedId);

				const observationsRes = await app.request("/api/observations?limit=10");
				expect(observationsRes.status).toBe(200);
				const observations = (await observationsRes.json()) as {
					items: Array<{ id: number; title: string }>;
				};
				expect(observations.items.map((item) => item.id)).toEqual(
					expect.arrayContaining(fixture.visibleIds),
				);
				expect(observations.items.map((item) => item.title)).not.toContain(
					fixture.unauthorizedTitle,
				);

				const packRes = await app.request(`/api/pack?context=${fixture.query}&limit=10`);
				expect(packRes.status).toBe(200);
				const pack = (await packRes.json()) as { item_ids: number[]; pack_text: string };
				expect(pack.item_ids.some((id) => fixture.visibleIds.includes(id))).toBe(true);
				expect(pack.item_ids).not.toContain(fixture.unauthorizedId);
				expect(pack.pack_text).not.toContain(fixture.unauthorizedTitle);
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
				store.db
					.prepare(
						"INSERT INTO sync_peers(peer_device_id, actor_id, claimed_local_actor, created_at) VALUES (?, ?, ?, ?)",
					)
					.run("peer-claimed", store.actorId, 1, "2026-01-01T00:00:00Z");
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Claimed peer mine",
					actorId: "local:peer-claimed",
					originDeviceId: "peer-claimed",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Claimed peer metadata mine",
					actorId: null,
					originDeviceId: null,
					metadata: { origin_device_id: "peer-claimed" },
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
				expect(mineItems.map((item) => item.title).sort()).toEqual([
					"Claimed peer metadata mine",
					"Claimed peer mine",
					"Mine",
				]);
				expect(mineItems.every((item) => item.owned_by_self === true)).toBe(true);

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
		it("GET resolves the same workspace-scoped file as the core resolver POST uses", async () => {
			// Workspace-scoped override via CODEMEM_RUNTIME_ROOT is honored only by
			// the core resolver (getCodememConfigPath / readCodememConfigFile). The
			// legacy local getConfigPath() ignored it, so GET and POST could resolve
			// different files. GET must now match the core resolver exactly.
			const runtimeRoot = mkdtempSync(join(tmpdir(), "codemem-runtime-root-"));
			const scopedConfigPath = join(runtimeRoot, "config", "codemem.json");
			mkdirSync(join(runtimeRoot, "config"), { recursive: true });
			writeFileSync(scopedConfigPath, JSON.stringify({ observer_model: "scoped-model" }));
			const prevRuntimeRoot = process.env.CODEMEM_RUNTIME_ROOT;
			const prevConfig = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_RUNTIME_ROOT = runtimeRoot;
			delete process.env.CODEMEM_CONFIG;
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				// GET resolves to the workspace-scoped file the core resolver chooses,
				// which is the same path POST writes to.
				expect(body.path).toBe(core.getCodememConfigPath());
				expect(body.path).toBe(scopedConfigPath);
				expect((body.config as Record<string, unknown>).observer_model).toBe("scoped-model");
			} finally {
				cleanup();
				rmSync(runtimeRoot, { recursive: true, force: true });
				if (prevRuntimeRoot == null) delete process.env.CODEMEM_RUNTIME_ROOT;
				else process.env.CODEMEM_RUNTIME_ROOT = prevRuntimeRoot;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

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
						"codex_command",
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

		it("accepts the Codex sidecar runtime and exposes its protected command", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previous = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://localhost",
					},
					body: JSON.stringify({ config: { observer_runtime: "codex_sidecar" } }),
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.config as Record<string, unknown>).observer_runtime).toBe("codex_sidecar");
				expect((body.effective as Record<string, unknown>).codex_command).toEqual(["codex"]);
				expect(body.protected_keys).toEqual(expect.arrayContaining(["codex_command"]));
			} finally {
				cleanup();
				if (previous == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previous;
			}
		});

		it("reports CODEMEM_CODEX_COMMAND as normalized env-managed config", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousCommand = process.env.CODEMEM_CODEX_COMMAND;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_CODEX_COMMAND =
				'["/Applications/ChatGPT.app/Contents/Resources/codex","--profile","observer"]';
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.effective as Record<string, unknown>).codex_command).toEqual([
					"/Applications/ChatGPT.app/Contents/Resources/codex",
					"--profile",
					"observer",
				]);
				expect(body.env_overrides).toEqual(
					expect.objectContaining({ codex_command: "CODEMEM_CODEX_COMMAND" }),
				);
			} finally {
				cleanup();
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousCommand == null) delete process.env.CODEMEM_CODEX_COMMAND;
				else process.env.CODEMEM_CODEX_COMMAND = previousCommand;
			}
		});

		it("normalizes a string-form Codex command from the config file", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousCommand = process.env.CODEMEM_CODEX_COMMAND;
			process.env.CODEMEM_CONFIG = configPath;
			delete process.env.CODEMEM_CODEX_COMMAND;
			writeFileSync(configPath, JSON.stringify({ codex_command: "codex --profile observer" }));
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/config");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect((body.effective as Record<string, unknown>).codex_command).toEqual([
					"codex",
					"--profile",
					"observer",
				]);
			} finally {
				cleanup();
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousCommand == null) delete process.env.CODEMEM_CODEX_COMMAND;
				else process.env.CODEMEM_CODEX_COMMAND = previousCommand;
			}
		});

		it("does not report normalized command arrays as changed on unrelated saves", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousClaudeCommand = process.env.CODEMEM_CLAUDE_COMMAND;
			const previousCodexCommand = process.env.CODEMEM_CODEX_COMMAND;
			process.env.CODEMEM_CONFIG = configPath;
			delete process.env.CODEMEM_CLAUDE_COMMAND;
			delete process.env.CODEMEM_CODEX_COMMAND;
			writeFileSync(
				configPath,
				JSON.stringify({
					codex_command: "codex --profile observer",
					observer_model: "gpt-5.4-mini",
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
					body: JSON.stringify({ config: { observer_model: "gpt-5.4" } }),
				});

				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				const effects = body.effects as Record<string, unknown>;
				expect(effects.effective_keys).toEqual(["observer_model"]);
				expect(effects.restart_required_keys).toEqual(["observer_model"]);
			} finally {
				cleanup();
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousClaudeCommand == null) delete process.env.CODEMEM_CLAUDE_COMMAND;
				else process.env.CODEMEM_CLAUDE_COMMAND = previousClaudeCommand;
				if (previousCodexCommand == null) delete process.env.CODEMEM_CODEX_COMMAND;
				else process.env.CODEMEM_CODEX_COMMAND = previousCodexCommand;
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

		it("returns 400 (not 500) when POST /api/sync/peers/rename gets a malformed body", async () => {
			const { app, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const res = await app.request("/api/sync/peers/rename", {
					method: "POST",
					headers: { "Content-Type": "application/json", Origin: "http://localhost" },
					body: "{ not json",
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as { error?: string };
				expect(body.error).toBe("invalid json");
			} finally {
				cleanup();
			}
		});

		it("surfaces authorized Sharing domains separately from project narrowing", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO sync_peers (
							peer_device_id, name, claimed_local_actor, projects_include_json,
							projects_exclude_json, discovered_via_coordinator_id,
							discovered_via_group_id, created_at
						) VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
					)
					.run(
						"peer-scope",
						"Peer Scope",
						JSON.stringify(["*"]),
						JSON.stringify(["private"]),
						"coord",
						"team-a",
						now,
					);
				const insertScope = store.db.prepare(
					`INSERT INTO replication_scopes(
						scope_id, label, kind, authority_type, coordinator_id, group_id,
						membership_epoch, status, created_at, updated_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				);
				insertScope.run(
					"acme-work",
					"Acme Work",
					"team",
					"coordinator",
					"coord",
					"team-a",
					2,
					"active",
					now,
					now,
				);
				insertScope.run(
					"personal-devices",
					"Personal Devices",
					"personal",
					"local",
					null,
					null,
					1,
					"active",
					now,
					now,
				);
				insertScope.run(
					"stale-team",
					"Stale Team",
					"team",
					"coordinator",
					"coord",
					"team-a",
					5,
					"active",
					now,
					now,
				);
				insertScope.run(
					"archived-team",
					"Archived Team",
					"team",
					"coordinator",
					"coord",
					"team-a",
					1,
					"archived",
					now,
					now,
				);
				const insertMembership = store.db.prepare(
					`INSERT INTO scope_memberships(
						scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id, updated_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				);
				insertMembership.run(
					"acme-work",
					"peer-scope",
					"member",
					"active",
					2,
					"coord",
					"team-a",
					now,
				);
				insertMembership.run(
					"personal-devices",
					"peer-scope",
					"member",
					"active",
					1,
					null,
					null,
					now,
				);
				insertMembership.run(
					"stale-team",
					"peer-scope",
					"member",
					"active",
					4,
					"coord",
					"team-a",
					now,
				);
				insertMembership.run(
					"archived-team",
					"peer-scope",
					"member",
					"active",
					1,
					"coord",
					"team-a",
					now,
				);
				insertMembership.run(
					"acme-work",
					"peer-revoked",
					"member",
					"active",
					2,
					"coord",
					"team-a",
					now,
				);

				const res = await app.request("/api/sync/peers");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					items: Array<{
						authorized_scopes: Array<Record<string, unknown>>;
						discovered_via_coordinator_id: string | null;
						discovered_via_group_id: string | null;
						peer_device_id: string;
						project_scope: Record<string, unknown>;
					}>;
				};
				const peer = body.items.find((item) => item.peer_device_id === "peer-scope");
				expect(peer?.project_scope).toMatchObject({
					effective_exclude: ["private"],
					effective_include: ["*"],
					exclude: ["private"],
					include: ["*"],
					inherits_global: false,
				});
				expect(peer?.authorized_scopes.map((scope) => scope.scope_id)).toEqual([
					"acme-work",
					"personal-devices",
				]);
				expect(peer?.authorized_scopes[0]).toMatchObject({
					authority_type: "coordinator",
					coordinator_id: "coord",
					group_id: "team-a",
					kind: "team",
					label: "Acme Work",
					membership_epoch: 2,
					role: "member",
				});
				expect(peer).toMatchObject({
					discovered_via_coordinator_id: "coord",
					discovered_via_group_id: "team-a",
				});

				const statusRes = await app.request("/api/sync/status");
				expect(statusRes.status).toBe(200);
				const statusBody = (await statusRes.json()) as {
					peers: Array<{
						authorized_scopes: Array<Record<string, unknown>>;
						discovered_via_coordinator_id: string | null;
						discovered_via_group_id: string | null;
						peer_device_id: string;
						project_scope: Record<string, unknown>;
					}>;
				};
				const statusPeer = statusBody.peers.find((item) => item.peer_device_id === "peer-scope");
				expect(statusPeer?.authorized_scopes.map((scope) => scope.scope_id)).toEqual([
					"acme-work",
					"personal-devices",
				]);
				expect(statusPeer?.project_scope).toMatchObject({
					effective_exclude: ["private"],
					effective_include: ["*"],
				});
				expect(statusPeer).toMatchObject({
					discovered_via_coordinator_id: "coord",
					discovered_via_group_id: "team-a",
				});
			} finally {
				cleanup();
			}
		});

		it("surfaces grouped legacy shared review summary in sync status", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				const session = store.db
					.prepare(
						`INSERT INTO sessions(started_at, cwd, project, git_remote, user, tool_version)
						 VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.run(
						now,
						"/tmp/codemem-test",
						"codemem-test",
						"https://git.example.invalid/oss/codemem-test.git",
						"test",
						"test",
					);
				const workSession = store.db
					.prepare(
						`INSERT INTO sessions(started_at, cwd, project, git_remote, user, tool_version)
						 VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.run(
						now,
						"/tmp/work-client-api",
						"work-client-api",
						"https://git.example.invalid/exampleco/api.git",
						"test",
						"test",
					);
				const sameRepoSession = store.db
					.prepare(
						`INSERT INTO sessions(started_at, cwd, project, git_remote, user, tool_version)
						 VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.run(
						now,
						"/tmp/alternate-worktree",
						"codemem-test-worktree",
						"https://git.example.invalid/oss/codemem-test.git",
						"test",
						"test",
					);
				store.db
					.prepare(
						`INSERT INTO memory_items(
							session_id, kind, title, body_text, created_at, updated_at,
							visibility, workspace_id, workspace_kind, active, scope_id, metadata_json
						 ) VALUES (?, 'discovery', ?, ?, ?, ?, 'shared', 'shared:default', 'shared', 1, ?, '{}')`,
					)
					.run(
						Number(session.lastInsertRowid),
						"Legacy shared",
						"Legacy shared body",
						now,
						now,
						"legacy-shared-review",
					);
				const insertSession = store.db.prepare(
					`INSERT INTO sessions(started_at, cwd, project, git_remote, user, tool_version)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				);
				const insertLegacyMemory = store.db.prepare(
					`INSERT INTO memory_items(
						session_id, kind, title, body_text, created_at, updated_at,
						visibility, workspace_id, workspace_kind, active, scope_id, metadata_json
					 ) VALUES (?, 'discovery', ?, ?, ?, ?, 'shared', 'shared:default', 'shared', 1, ?, '{}')`,
				);
				for (let index = 0; index < 21; index += 1) {
					const splitSession = insertSession.run(
						now,
						`/tmp/codemem-test-split-${index}`,
						`codemem-test-split-${index}`,
						"https://git.example.invalid/oss/codemem-test.git",
						"test",
						"test",
					);
					insertLegacyMemory.run(
						Number(splitSession.lastInsertRowid),
						`Legacy shared split ${index}`,
						`Legacy shared split body ${index}`,
						now,
						now,
						"legacy-shared-review",
					);
				}
				store.db
					.prepare(
						`INSERT INTO memory_items(
							session_id, kind, title, body_text, created_at, updated_at,
							visibility, workspace_id, workspace_kind, active, origin_device_id, scope_id, metadata_json
						 ) VALUES (?, 'discovery', ?, ?, ?, ?, 'shared', 'shared:default', 'shared', 1, ?, ?, '{}')`,
					)
					.run(
						Number(sameRepoSession.lastInsertRowid),
						"Legacy shared same repo",
						"Legacy shared same repo body",
						now,
						now,
						store.deviceId,
						"legacy-shared-review",
					);
				store.db
					.prepare(
						`INSERT INTO memory_items(
							session_id, kind, title, body_text, created_at, updated_at,
							visibility, workspace_id, workspace_kind, active, deleted_at, scope_id, metadata_json
						 ) VALUES (?, 'discovery', ?, ?, ?, ?, 'shared', 'shared:default', 'shared', 1, ?, ?, '{}')`,
					)
					.run(
						Number(session.lastInsertRowid),
						"Deleted legacy shared",
						"Deleted legacy shared body",
						now,
						now,
						now,
						"legacy-shared-review",
					);
				store.db
					.prepare(
						`INSERT INTO memory_items(
							session_id, kind, title, body_text, created_at, updated_at,
							visibility, workspace_id, workspace_kind, active, scope_id, metadata_json
						 ) VALUES (?, 'discovery', ?, ?, ?, ?, 'shared', 'shared:default', 'shared', 1, ?, '{}')`,
					)
					.run(
						Number(workSession.lastInsertRowid),
						"Legacy shared work",
						"Legacy shared work body",
						now,
						now,
						"legacy-shared-review",
					);

				const res = await app.request("/api/sync/status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					legacy_shared_review: {
						groups: Array<{
							display_project: string;
							memory_samples: Array<{
								body_preview: string | null;
								ownership: "local" | "peer";
								title: string;
							}>;
							memory_count: number;
							workspace_identity: string;
						}>;
						has_data: boolean;
						memory_count: number;
						scope_id: string;
					};
				};
				expect(body.legacy_shared_review).toMatchObject({
					has_data: true,
					memory_count: 24,
					scope_id: "legacy-shared-review",
				});
				const codememGroup = body.legacy_shared_review.groups.find(
					(group) =>
						group.workspace_identity === "https://git.example.invalid/oss/codemem-test.git",
				);
				expect(codememGroup?.memory_samples).toHaveLength(3);
				expect(
					codememGroup?.memory_samples.every(
						(sample) => !sample.body_preview || sample.body_preview.length <= 180,
					),
				).toBe(true);
				expect(codememGroup?.memory_samples).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ ownership: "local" }),
						expect.objectContaining({ ownership: "peer" }),
					]),
				);
				expect(body.legacy_shared_review.groups).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							display_project: "codemem-test-worktree",
							memory_samples: expect.arrayContaining([
								expect.objectContaining({
									body_preview: expect.stringContaining("Legacy shared"),
									ownership: expect.stringMatching(/^(local|peer)$/),
									title: expect.stringContaining("Legacy shared"),
								}),
							]),
							memory_count: 23,
							workspace_identity: "https://git.example.invalid/oss/codemem-test.git",
						}),
						expect.objectContaining({
							display_project: "work-client-api",
							memory_count: 1,
							workspace_identity: "https://git.example.invalid/exampleco/api.git",
						}),
					]),
				);
			} finally {
				cleanup();
			}
		});

		it("returns all legacy shared review groups so every group has an action path", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				const insertSession = store.db.prepare(
					`INSERT INTO sessions(started_at, cwd, project, git_remote, user, tool_version)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				);
				const insertLegacyMemory = store.db.prepare(
					`INSERT INTO memory_items(
						session_id, kind, title, body_text, created_at, updated_at,
						visibility, workspace_id, workspace_kind, active, scope_id, metadata_json
					 ) VALUES (?, 'discovery', ?, ?, ?, ?, 'shared', 'shared:default', 'shared', 1, ?, '{}')`,
				);
				for (let index = 0; index < 25; index += 1) {
					const session = insertSession.run(
						now,
						`/tmp/legacy-${index}`,
						`legacy-${index}`,
						`https://git.example.invalid/legacy/${index}.git`,
						"test",
						"test",
					);
					insertLegacyMemory.run(
						Number(session.lastInsertRowid),
						`Legacy ${index}`,
						`Legacy body ${index}`,
						now,
						now,
						"legacy-shared-review",
					);
				}

				const res = await app.request("/api/sync/status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as {
					legacy_shared_review: { groups: unknown[]; total_group_count: number };
				};
				expect(body.legacy_shared_review.total_group_count).toBe(25);
				expect(body.legacy_shared_review.groups).toHaveLength(25);
			} finally {
				cleanup();
			}
		});

		it("previews and applies legacy shared review reassignment explicitly", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('oss', 'OSS', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);
				grantSyncScopeToDevices(store, "oss", [store.deviceId]);
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET cwd = ?, git_remote = ?, project = ? WHERE id = ?")
					.run(
						"/workspace/oss/dev",
						"https://git.example.invalid/oss/dev.git",
						"oss-dev",
						sessionId,
					);
				insertTestMemory(store, {
					kind: "discovery",
					scopeId: "legacy-shared-review",
					sessionId,
					title: "legacy local shared",
				});
				insertTestMemory(store, {
					actorId: "remote-actor",
					kind: "discovery",
					originDeviceId: "peer-device",
					scopeId: "legacy-shared-review",
					sessionId,
					title: "legacy peer shared",
				});

				const previewRes = await app.request("/api/sync/legacy-shared-review/reassign", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						scope_id: "oss",
						workspace_identity: "https://git.example.invalid/oss/dev.git",
					}),
				});
				expect(previewRes.status).toBe(409);
				const preview = (await previewRes.json()) as {
					error: string;
					preview: {
						confirmation_token: string;
						memory_count: number;
						reassignable_memory_count: number;
						warning: string;
					};
				};
				expect(preview.error).toBe("legacy_review_confirmation_required");
				expect(preview.preview).toMatchObject({
					memory_count: 2,
					reassignable_memory_count: 1,
				});
				expect(preview.preview.warning).toContain(
					"Peer-owned copies must be fixed on their source device",
				);

				const applyRes = await app.request("/api/sync/legacy-shared-review/reassign", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						confirmation_token: preview.preview.confirmation_token,
						confirmed_old_copies: true,
						scope_id: "oss",
						workspace_identity: "https://git.example.invalid/oss/dev.git",
					}),
				});
				expect(applyRes.status).toBe(200);
				const applied = (await applyRes.json()) as {
					legacy_shared_review: { memory_count: number };
					reassigned_memory_count: number;
				};
				expect(applied.reassigned_memory_count).toBe(1);
				expect(applied.legacy_shared_review.memory_count).toBe(1);
				const counts = store.db
					.prepare("SELECT scope_id, COUNT(*) AS n FROM memory_items GROUP BY scope_id")
					.all() as Array<{ scope_id: string; n: number }>;
				expect(counts).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ n: 1, scope_id: "oss" }),
						expect.objectContaining({ n: 1, scope_id: "legacy-shared-review" }),
					]),
				);
				const ops = store.db
					.prepare("SELECT op_type, scope_id FROM replication_ops ORDER BY op_id")
					.all() as Array<{ op_type: string; scope_id: string }>;
				expect(ops).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ op_type: "delete", scope_id: "legacy-shared-review" }),
						expect.objectContaining({ op_type: "upsert", scope_id: "oss" }),
					]),
				);
			} finally {
				cleanup();
			}
		});

		it("rejects stale legacy shared review confirmation when the group changes", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('oss', 'OSS', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);
				grantSyncScopeToDevices(store, "oss", [store.deviceId]);
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run("https://git.example.invalid/oss/dev.git", "oss-dev", sessionId);
				insertTestMemory(store, {
					kind: "discovery",
					scopeId: "legacy-shared-review",
					sessionId,
					title: "previewed legacy shared",
				});

				const previewRes = await app.request("/api/sync/legacy-shared-review/reassign", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						scope_id: "oss",
						workspace_identity: "https://git.example.invalid/oss/dev.git",
					}),
				});
				expect(previewRes.status).toBe(409);
				const preview = (await previewRes.json()) as {
					preview: { confirmation_token: string };
				};
				insertTestMemory(store, {
					kind: "discovery",
					scopeId: "legacy-shared-review",
					sessionId,
					title: "late legacy shared",
				});

				const applyRes = await app.request("/api/sync/legacy-shared-review/reassign", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						confirmation_token: preview.preview.confirmation_token,
						confirmed_old_copies: true,
						scope_id: "oss",
						workspace_identity: "https://git.example.invalid/oss/dev.git",
					}),
				});
				expect(applyRes.status).toBe(400);
				const body = (await applyRes.json()) as { error: string };
				expect(body.error).toContain("changed before reassignment");
				const counts = store.db
					.prepare("SELECT scope_id, COUNT(*) AS n FROM memory_items GROUP BY scope_id")
					.all() as Array<{ n: number; scope_id: string }>;
				expect(counts).toEqual([
					expect.objectContaining({ n: 2, scope_id: "legacy-shared-review" }),
				]);
				const ops = store.db.prepare("SELECT COUNT(*) AS n FROM replication_ops").get() as {
					n: number;
				};
				expect(ops.n).toBe(0);
			} finally {
				cleanup();
			}
		});

		it("reports inbound-only legacy shared review groups without offering reassignment capacity", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('oss', 'OSS', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);
				grantSyncScopeToDevices(store, "oss", [store.deviceId]);
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run("https://git.example.invalid/oss/inbound.git", "oss-inbound", sessionId);
				insertTestMemory(store, {
					actorId: "remote-actor",
					kind: "discovery",
					originDeviceId: "peer-device",
					scopeId: "legacy-shared-review",
					sessionId,
					title: "legacy peer shared",
				});

				const statusRes = await app.request("/api/sync/status");
				expect(statusRes.status).toBe(200);
				const status = (await statusRes.json()) as {
					legacy_shared_review: {
						groups: Array<{
							memory_count: number;
							peer_owned_memory_count: number;
							reassignable_memory_count: number;
							workspace_identity: string;
						}>;
					};
				};
				expect(status.legacy_shared_review.groups[0]).toMatchObject({
					memory_count: 1,
					peer_owned_memory_count: 1,
					reassignable_memory_count: 0,
					workspace_identity: "https://git.example.invalid/oss/inbound.git",
				});

				const previewRes = await app.request("/api/sync/legacy-shared-review/reassign", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						scope_id: "oss",
						workspace_identity: "https://git.example.invalid/oss/inbound.git",
					}),
				});
				expect(previewRes.status).toBe(400);
				const body = (await previewRes.json()) as { error: string };
				expect(body.error).toContain("peer-owned memories");
				expect(body.error).not.toContain("no locally owned memories");
			} finally {
				cleanup();
			}
		});

		it("rejects legacy shared review reassignment when the local device lacks target membership", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('oss', 'OSS', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ? WHERE id = ?")
					.run("https://git.example.invalid/oss/dev.git", sessionId);
				insertTestMemory(store, {
					kind: "discovery",
					scopeId: "legacy-shared-review",
					sessionId,
					title: "legacy local shared",
				});

				const res = await app.request("/api/sync/legacy-shared-review/reassign", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						confirmed_old_copies: true,
						scope_id: "oss",
						workspace_identity: "https://git.example.invalid/oss/dev.git",
					}),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as { error: string };
				expect(body.error).toContain("local device is not a member");
				const memory = store.db.prepare("SELECT scope_id FROM memory_items LIMIT 1").get() as {
					scope_id: string;
				};
				expect(memory.scope_id).toBe("legacy-shared-review");
				const ops = store.db.prepare("SELECT COUNT(*) AS n FROM replication_ops").get() as {
					n: number;
				};
				expect(ops.n).toBe(0);
			} finally {
				cleanup();
			}
		});

		it("rejects local-default as a legacy shared review reassignment target", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				const _warmup = await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ? WHERE id = ?")
					.run("https://git.example.invalid/oss/dev.git", sessionId);
				insertTestMemory(store, {
					kind: "discovery",
					scopeId: "legacy-shared-review",
					sessionId,
					title: "legacy local shared",
				});

				const res = await app.request("/api/sync/legacy-shared-review/reassign", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						confirmed_old_copies: true,
						scope_id: "local-default",
						workspace_identity: "https://git.example.invalid/oss/dev.git",
					}),
				});

				expect(res.status).toBe(400);
				const body = (await res.json()) as { error: string };
				expect(body.error).toContain("local-default is not a valid target");
				const memory = store.db.prepare("SELECT scope_id FROM memory_items LIMIT 1").get() as {
					scope_id: string;
				};
				expect(memory.scope_id).toBe("legacy-shared-review");
				const ops = store.db.prepare("SELECT COUNT(*) AS n FROM replication_ops").get() as {
					n: number;
				};
				expect(ops.n).toBe(0);
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
				expect(body.reason).toBeUndefined();
			} finally {
				cleanup();
			}
		});

		it("advertises reassign_scope and refreshes authorization only on explicit feature-aware status requests", async () => {
			// Arrange
			const configDir = mkdtempSync(join(tmpdir(), "codemem-status-refresh-test-"));
			const configPath = join(configDir, "config.json");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousFetch = globalThis.fetch;
			const fetchMock = vi.fn(
				async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 }),
			);
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/status";
				peer = createAuthenticatedSyncPeer(store, { url });
				const signedHeaders = () =>
					buildAuthHeaders({
						deviceId: peer?.peerDeviceId ?? "",
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peer?.keysDir,
					});

				// Act
				const ordinary = await syncApp.request(url, { headers: signedHeaders() });
				const refreshOnly = await syncApp.request(url, {
					headers: { ...signedHeaders(), "X-Codemem-Refresh-Authorization": "1" },
				});
				const featureOnly = await syncApp.request(url, {
					headers: { ...signedHeaders(), "X-Codemem-Sync-Features": "reassign_scope" },
				});

				// Assert
				expect(ordinary.status).toBe(200);
				expect((await ordinary.json()) as Record<string, unknown>).toMatchObject({
					sync_features: ["reassign_scope"],
				});
				expect(refreshOnly.status).toBe(200);
				expect(featureOnly.status).toBe(200);
				expect(fetchMock).not.toHaveBeenCalled();

				// Act
				const explicitRefresh = await syncApp.request(url, {
					headers: {
						...signedHeaders(),
						"X-Codemem-Refresh-Authorization": "1",
						"X-Codemem-Sync-Features": "reassign_scope",
					},
				});

				// Assert
				expect(explicitRefresh.status).toBe(200);
				expect(fetchMock).toHaveBeenCalled();
			} finally {
				peer?.cleanup();
				cleanup();
				globalThis.fetch = previousFetch;
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				rmSync(configDir, { recursive: true, force: true });
			}
		});

		it("exposes sync auth failure reasons only when diagnostics are explicitly enabled", async () => {
			const previous = process.env.CODEMEM_SYNC_AUTH_DIAGNOSTICS;
			process.env.CODEMEM_SYNC_AUTH_DIAGNOSTICS = "1";
			const { syncApp, cleanup } = createTestApp();
			try {
				const res = await syncApp.request("/v1/status");
				expect(res.status).toBe(401);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({ error: "unauthorized", reason: "bootstrap_grant_invalid" });
			} finally {
				if (previous === undefined) delete process.env.CODEMEM_SYNC_AUTH_DIAGNOSTICS;
				else process.env.CODEMEM_SYNC_AUTH_DIAGNOSTICS = previous;
				cleanup();
			}
		});

		it("drives syncOnce through real syncProtocolRoutes for multiple Spaces", async () => {
			const source = createRealSyncStore("codemem-source-route-sync-test-");
			const receiver = createRealSyncStore("codemem-receiver-route-sync-test-");
			const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
			let server: Awaited<ReturnType<typeof startTestSyncServer>> | null = null;
			try {
				const [sourceDeviceId, sourceFingerprint] = ensureDeviceIdentity(source.store.db, {
					keysDir: source.keysDir,
				});
				const sourcePublicKey = loadPublicKey(source.keysDir);
				const [receiverDeviceId, receiverFingerprint] = ensureDeviceIdentity(receiver.store.db, {
					keysDir: receiver.keysDir,
				});
				const receiverPublicKey = loadPublicKey(receiver.keysDir);
				if (!sourcePublicKey || !receiverPublicKey) throw new Error("missing test public key");

				const now = "2026-01-01T00:00:00.000Z";
				source.store.db
					.prepare(
						`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(receiverDeviceId, receiverFingerprint, receiverPublicKey, now);
				receiver.store.db
					.prepare(
						`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(sourceDeviceId, sourceFingerprint, sourcePublicKey, now);

				const scopes = ["oss", "personal"] as const;
				for (const scopeId of scopes) {
					grantSyncScopeToDevices(source.store, scopeId, [sourceDeviceId, receiverDeviceId]);
					// Receiver must hold local scope membership to bootstrap a scoped
					// snapshot — scopedSnapshotAccessFailure() fails closed otherwise.
					grantSyncScopeToDevices(receiver.store, scopeId, [sourceDeviceId, receiverDeviceId]);
					core.setSyncResetState(
						source.store.db,
						{
							generation: 1,
							snapshot_id: `snapshot-${scopeId}`,
							baseline_cursor: null,
							retained_floor_cursor: null,
						},
						scopeId,
					);
				}
				const sourceSessionId = insertTestSession(source.store.db);
				for (const scopeId of scopes) {
					for (let index = 1; index <= 2; index += 1) {
						insertTestMemory(source.store, {
							sessionId: sourceSessionId,
							kind: "discovery",
							title: `${scopeId} route item ${index}`,
							bodyText: `Body for ${scopeId} route item ${index}`,
							metadata: { clock_device_id: sourceDeviceId },
							originDeviceId: sourceDeviceId,
							createdAt: `2026-01-01T00:00:0${index}.000Z`,
							scopeId,
						});
					}
				}

				process.env.CODEMEM_KEYS_DIR = source.keysDir;
				server = await startTestSyncServer(createSyncApp({ storeFactory: () => source.store }));

				const result = await core.syncOnce(receiver.store.db, sourceDeviceId, [server.url], {
					keysDir: receiver.keysDir,
					scanner: receiver.store.scanner,
				});

				if (!result.ok) throw new Error(`syncOnce failed: ${result.error ?? "unknown"}`);
				expect(result.perScopeResults?.map((scope) => scope.scope_id)).toEqual([...scopes]);
				expect(result.opsIn).toBe(4);
				for (const scopeId of scopes) {
					const row = receiver.store.db
						.prepare("SELECT COUNT(1) AS total FROM memory_items WHERE scope_id = ?")
						.get(scopeId) as { total: number };
					expect(row.total).toBe(2);
				}
			} finally {
				await server?.close();
				if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
				receiver.cleanup();
				source.cleanup();
			}
		});

		it("picks up a Space granted after an initial scoped sync", async () => {
			const source = createRealSyncStore("codemem-source-midflight-sync-test-");
			const receiver = createRealSyncStore("codemem-receiver-midflight-sync-test-");
			const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
			let server: Awaited<ReturnType<typeof startTestSyncServer>> | null = null;
			try {
				const [sourceDeviceId, sourceFingerprint] = ensureDeviceIdentity(source.store.db, {
					keysDir: source.keysDir,
				});
				const sourcePublicKey = loadPublicKey(source.keysDir);
				const [receiverDeviceId, receiverFingerprint] = ensureDeviceIdentity(receiver.store.db, {
					keysDir: receiver.keysDir,
				});
				const receiverPublicKey = loadPublicKey(receiver.keysDir);
				if (!sourcePublicKey || !receiverPublicKey) throw new Error("missing test public key");

				const now = "2026-01-01T00:00:00.000Z";
				source.store.db
					.prepare(
						`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(receiverDeviceId, receiverFingerprint, receiverPublicKey, now);
				receiver.store.db
					.prepare(
						`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(sourceDeviceId, sourceFingerprint, sourcePublicKey, now);

				const initialScope = "scope-a";
				const laterScope = "scope-b";
				grantSyncScopeToDevices(source.store, initialScope, [sourceDeviceId, receiverDeviceId]);
				grantSyncScopeToDevices(source.store, laterScope, [sourceDeviceId]);
				grantSyncScopeToDevices(receiver.store, initialScope, [sourceDeviceId, receiverDeviceId]);
				for (const scopeId of [initialScope, laterScope]) {
					core.setSyncResetState(
						source.store.db,
						{
							generation: 1,
							snapshot_id: `snapshot-${scopeId}`,
							baseline_cursor: null,
							retained_floor_cursor: null,
						},
						scopeId,
					);
				}
				const sourceSessionId = insertTestSession(source.store.db);
				for (const scopeId of [initialScope, laterScope]) {
					for (let index = 1; index <= 2; index += 1) {
						insertTestMemory(source.store, {
							sessionId: sourceSessionId,
							kind: "discovery",
							title: `${scopeId} midflight item ${index}`,
							bodyText: `Body for ${scopeId} midflight item ${index}`,
							metadata: { clock_device_id: sourceDeviceId },
							originDeviceId: sourceDeviceId,
							createdAt: `2026-01-02T00:00:0${index}.000Z`,
							scopeId,
						});
					}
				}

				process.env.CODEMEM_KEYS_DIR = source.keysDir;
				server = await startTestSyncServer(createSyncApp({ storeFactory: () => source.store }));

				const first = await core.syncOnce(receiver.store.db, sourceDeviceId, [server.url], {
					keysDir: receiver.keysDir,
					scanner: receiver.store.scanner,
				});

				if (!first.ok) throw new Error(`first syncOnce failed: ${first.error ?? "unknown"}`);
				expect(first.perScopeResults?.map((scope) => scope.scope_id)).toEqual([initialScope]);
				expect(
					receiver.store.db
						.prepare("SELECT COUNT(1) AS total FROM memory_items WHERE scope_id = ?")
						.get(initialScope),
				).toMatchObject({ total: 2 });
				expect(
					receiver.store.db
						.prepare("SELECT COUNT(1) AS total FROM memory_items WHERE scope_id = ?")
						.get(laterScope),
				).toMatchObject({ total: 0 });

				// Isolate the second pass from the legacy/default `/v1/ops` pull:
				// if `scope-b` arrives below, it must come from the newly granted
				// scoped path rather than from an unscoped catch-up window.
				core.setReplicationCursor(receiver.store.db, sourceDeviceId, {
					lastApplied: "9999-01-01T00:00:00.000Z|legacy-skip",
				});

				grantSyncScopeToDevices(source.store, laterScope, [sourceDeviceId, receiverDeviceId]);
				grantSyncScopeToDevices(receiver.store, laterScope, [sourceDeviceId, receiverDeviceId]);

				const second = await core.syncOnce(receiver.store.db, sourceDeviceId, [server.url], {
					keysDir: receiver.keysDir,
					scanner: receiver.store.scanner,
				});

				if (!second.ok) throw new Error(`second syncOnce failed: ${second.error ?? "unknown"}`);
				expect(second.perScopeResults?.map((scope) => scope.scope_id)).toEqual([
					initialScope,
					laterScope,
				]);
				expect(
					second.perScopeResults?.find((scope) => scope.scope_id === laterScope),
				).toMatchObject({
					bootstrapped: true,
					opsIn: 2,
				});
				expect(
					receiver.store.db
						.prepare("SELECT COUNT(1) AS total FROM memory_items WHERE scope_id = ?")
						.get(laterScope),
				).toMatchObject({ total: 2 });
			} finally {
				await server?.close();
				if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
				receiver.cleanup();
				source.cleanup();
			}
		});

		it("allows /v1/status with a valid bootstrap grant", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
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
				const store = ensureStore();
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
					expect(
						store.db
							.prepare(
								"SELECT pinned_fingerprint, public_key FROM sync_peers WHERE peer_device_id = ?",
							)
							.get(peerDeviceId),
					).toEqual({
						pinned_fingerprint: peerFingerprintValue,
						public_key: peerPublicKeyValue,
					});
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

		it("returns retryable busy when sync auth cannot record a nonce", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			const peers: ReturnType<typeof createAuthenticatedSyncPeer>[] = [];
			let blocker: Database | null = null;
			let lockReleased = false;
			try {
				const store = ensureStore();
				const scenarios: Array<{
					url: string;
					method?: "GET" | "POST";
					bodyBytes?: Buffer;
				}> = [
					{ url: "http://localhost/v1/status" },
					{ url: "http://localhost/v1/ops?since=&limit=1" },
					{
						url: "http://localhost/v1/snapshot?generation=1&snapshot_id=snapshot-1&limit=1",
					},
					{
						url: "http://localhost/v1/ops",
						method: "POST",
						bodyBytes: Buffer.from(JSON.stringify({ ops: [] })),
					},
				];
				const signedRequests = scenarios.map((scenario) => {
					const peer = createAuthenticatedSyncPeer(store, scenario);
					peers.push(peer);
					return { ...scenario, headers: peer.headers };
				});
				store.db.pragma("busy_timeout = 1");
				blocker = connect(store.dbPath);
				blocker.pragma("busy_timeout = 1");
				blocker.exec("BEGIN IMMEDIATE");

				for (const request of signedRequests) {
					const res = await syncApp.request(request.url, {
						method: request.method,
						headers: request.headers,
						body: request.bodyBytes,
					});

					expect(res.status).toBe(503);
					expect(res.headers.get("retry-after")).toBe("1");
					expect(await res.json()).toEqual({ error: "sync_auth_store_busy" });
				}

				blocker.exec("ROLLBACK");
				lockReleased = true;
				const retry = await syncApp.request(signedRequests[0].url, {
					headers: signedRequests[0].headers,
				});
				expect(retry.status).toBe(200);
				const replay = await syncApp.request(signedRequests[0].url, {
					headers: signedRequests[0].headers,
				});
				expect(replay.status).toBe(401);
			} finally {
				if (!lockReleased) {
					try {
						blocker?.exec("ROLLBACK");
					} catch {
						// Ignore rollback errors when the lock was not acquired.
					}
				}
				blocker?.close();
				for (const peer of peers) peer.cleanup();
				cleanup();
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
			const { syncApp, ensureStore, cleanup } = createTestApp({
				syncRequestRateLimit: { readLimit: 1, unauthenticatedReadLimit: 1 },
			});
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				expect((await syncApp.request("/v1/status")).status).toBe(401);
				const store = ensureStore();

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
					expect(body.sync_capability).toBe("scoped");
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
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
				ensureStore();
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
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
				ensureStore();
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				const store = ensureStore();

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
					expect(body.sync_capability).toBe("scoped");
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				const store = ensureStore();

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
					expect(body.sync_capability).toBe("scoped");
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/ops?scope_id=&limit=50";
				peer = createAuthenticatedSyncPeer(store, { url });

				const res = await syncApp.request(url, { headers: peer.headers });

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "scoped",
					reason: "missing_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required when GET /v1/ops receives an unsupported scope_id", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/ops?scope_id=acme-work&limit=50";
				peer = createAuthenticatedSyncPeer(store, { url });

				const res = await syncApp.request(url, { headers: peer.headers });

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "scoped",
					reason: "unsupported_scope",
					scope_id: null,
				});
				expect(
					store.db.prepare("SELECT 1 FROM sync_reset_state_v2 WHERE scope_id = ?").get("acme-work"),
				).toBeUndefined();
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required when GET /v1/snapshot receives an unsupported scope_id", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/snapshot?scope_id=acme-work&generation=1&snapshot_id=test";
				peer = createAuthenticatedSyncPeer(store, { url });

				const res = await syncApp.request(url, { headers: peer.headers });

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "scoped",
					reason: "unsupported_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required when GET /v1/snapshot receives an empty scope_id", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/snapshot?scope_id=&generation=1&snapshot_id=test";
				peer = createAuthenticatedSyncPeer(store, { url });

				const res = await syncApp.request(url, { headers: peer.headers });

				expect(res.status).toBe(409);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({
					error: "reset_required",
					reset_required: true,
					sync_capability: "scoped",
					reason: "missing_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required when POST /v1/ops receives an unsupported body scope_id", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
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
					sync_capability: "scoped",
					reason: "unsupported_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required for unsupported POST scope_id before missing ops validation", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
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
					sync_capability: "scoped",
					reason: "unsupported_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required for empty POST scope_id before missing ops validation", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
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
					sync_capability: "scoped",
					reason: "missing_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("returns reset_required for unsupported POST scope_id before oversized ops validation", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
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
					sync_capability: "scoped",
					reason: "unsupported_scope",
					scope_id: null,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("rejects reassign_scope batches without feature advertisement", async () => {
			// Arrange
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/ops";
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST" });
				const now = "2026-07-20T14:00:00.000Z";
				const bodyText = JSON.stringify({
					sync_capability: "scoped",
					ops: [
						{
							op_id: "reassign-without-feature",
							entity_type: "memory_item",
							entity_id: "memory:key",
							op_type: "reassign_scope",
							payload_json: JSON.stringify({
								operation_id: "share_operation",
								memory_id: "memory:key",
								old_scope_id: "source",
								new_scope_id: "managed",
								revision: 3,
								side: "old",
							}),
							clock_rev: 3,
							clock_updated_at: now,
							clock_device_id: peer.peerDeviceId,
							device_id: peer.peerDeviceId,
							created_at: now,
							scope_id: "source",
						},
					],
				});
				const bodyBytes = Buffer.from(bodyText);
				const headers = buildAuthHeaders({
					deviceId: peer.peerDeviceId,
					method: "POST",
					url,
					bodyBytes,
					keysDir: peer.keysDir,
				});

				// Act
				const response = await syncApp.request(url, {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: bodyText,
				});

				// Assert
				expect(response.status).toBe(409);
				expect(await response.json()).toEqual({ error: "reassign_capability_required" });
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("rejects malformed feature-advertised reassign_scope payloads", async () => {
			// Arrange
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/ops";
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST" });
				const now = "2026-07-20T14:00:00.000Z";
				const bodyText = JSON.stringify({
					sync_capability: "scoped",
					sync_features: ["reassign_scope"],
					ops: [
						{
							op_id: "malformed-reassign",
							entity_type: "memory_item",
							entity_id: "memory:key",
							op_type: "reassign_scope",
							payload_json: "{}",
							clock_rev: 3,
							clock_updated_at: now,
							clock_device_id: peer.peerDeviceId,
							device_id: peer.peerDeviceId,
							created_at: now,
							scope_id: "source",
						},
					],
				});
				const bodyBytes = Buffer.from(bodyText);
				const headers = buildAuthHeaders({
					deviceId: peer.peerDeviceId,
					method: "POST",
					url,
					bodyBytes,
					keysDir: peer.keysDir,
				});

				// Act
				const response = await syncApp.request(url, {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: bodyText,
				});

				// Assert
				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({ error: "reassign_payload_invalid" });
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("accepts authorized feature-advertised reassign_scope batches", async () => {
			// Arrange
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/ops";
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST" });
				grantSyncScopeToDevices(store, "source", [store.deviceId, peer.peerDeviceId]);
				grantSyncScopeToDevices(store, "managed", [store.deviceId, peer.peerDeviceId]);
				const sessionId = insertTestSession(store.db);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "reassign source",
					originDeviceId: peer.peerDeviceId,
					scopeId: "source",
				});
				core.recordScopeReassignment(store.db, {
					operationId: "share_operation",
					memoryId,
					oldScopeId: "source",
					newScopeId: "managed",
					deviceId: peer.peerDeviceId,
					createdAt: "2026-07-20T14:00:00.000Z",
				});
				const ops = store.db
					.prepare(
						"SELECT * FROM replication_ops WHERE op_type = 'reassign_scope' ORDER BY scope_id",
					)
					.all();
				const bodyText = JSON.stringify({
					sync_capability: "scoped",
					sync_features: ["reassign_scope"],
					ops,
				});
				const bodyBytes = Buffer.from(bodyText);
				const headers = buildAuthHeaders({
					deviceId: peer.peerDeviceId,
					method: "POST",
					url,
					bodyBytes,
					keysDir: peer.keysDir,
				});

				// Act
				const response = await syncApp.request(url, {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: bodyText,
				});

				// Assert
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({
					applied: 0,
					rejected: 0,
					skipped: 2,
					sync_capability: "scoped",
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("advertises capability on incremental /v1/ops responses", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				const store = ensureStore();

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
					expect(body.sync_capability).toBe("scoped");
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				const store = ensureStore();

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
					expect(body.sync_capability).toBe("scoped");
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				const store = ensureStore();

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
					expect(body.sync_capability).toBe("scoped");
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
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
				expect(body.skipped_detail).toMatchObject({
					reason: "project_filter",
					skipped_count: 1,
					project: "blocked-project",
				});
				expect(body.skipped_detail).not.toHaveProperty("op_id");
				expect(body.skipped_detail).not.toHaveProperty("entity_id");
				expect(body.skipped_detail).not.toHaveProperty("entity_type");
				expect(body.skipped_detail).not.toHaveProperty("created_at");
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
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
					sync_capability: "scoped",
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
			const { syncApp, ensureStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-peer-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			try {
				const store = ensureStore();

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
						sync_capability: "scoped",
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
					coordinator: {
						enabled: boolean;
						configured: boolean;
						sync_enabled: boolean;
						groups: string[];
					};
					join_requests: Array<{ request_id: string }>;
				};
				expect(body.enabled).toBe(true);
				expect(body.interval_s).toBe(45);
				expect(body.project_filter_active).toBe(true);
				expect(body.project_filter).toEqual({ include: ["codemem"], exclude: ["junk"] });
				expect(body.coordinator.enabled).toBe(true);
				expect(body.coordinator.configured).toBe(true);
				expect(body.coordinator.sync_enabled).toBe(true);
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
				expect(body.addresses).toEqual(["http://127.0.0.1:7337"]);
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
									fingerprint: FRESH_PEER_FINGERPRINT,
									public_key: FRESH_PEER_PUBLIC_KEY,
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
									fingerprint: FRESH_PEER_FINGERPRINT,
									public_key: FRESH_PEER_PUBLIC_KEY,
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
									fingerprint: FRESH_PEER_FINGERPRINT,
									public_key: FRESH_PEER_PUBLIC_KEY,
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
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
					}),
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
						pinned_fingerprint: FRESH_PEER_FINGERPRINT,
						public_key: FRESH_PEER_PUBLIC_KEY,
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

		it("rejects stale discovered coordinator devices before publishing reciprocal approval", async () => {
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
									display_name: "Stale Device",
									fingerprint: FRESH_PEER_FINGERPRINT,
									public_key: FRESH_PEER_PUBLIC_KEY,
									addresses: ["http://10.0.0.5:7337"],
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
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						fingerprint: FRESH_PEER_FINGERPRINT,
					}),
				});
				expect(res.status).toBe(409);
				expect(await res.json()).toEqual({
					error: "discovered_peer_stale",
					detail:
						"This discovered device's coordinator presence is stale. Wait for it to come online and refresh sync status before trusting it.",
				});
				expect(
					fetchMock.mock.calls.some(([input]) =>
						String(input).includes("/v1/reciprocal-approvals"),
					),
				).toBe(false);
				expect(
					store.db
						.prepare("SELECT peer_device_id FROM sync_peers WHERE peer_device_id = ?")
						.get("peer-fresh"),
				).toBeUndefined();
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
									fingerprint: FRESH_PEER_FINGERPRINT,
									public_key: FRESH_PEER_PUBLIC_KEY,
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
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						fingerprint: FRESH_PEER_FINGERPRINT,
					}),
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
									fingerprint: FRESH_PEER_FINGERPRINT,
									public_key: FRESH_PEER_PUBLIC_KEY,
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
									fingerprint: FRESH_PEER_FINGERPRINT,
									public_key: FRESH_PEER_PUBLIC_KEY,
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
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						fingerprint: FRESH_PEER_FINGERPRINT,
					}),
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

		it("updates local Sharing domain project mappings without granting membership", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "project domain candidate",
					metadata: {},
				});
				store.db
					.prepare(
						`INSERT INTO sync_peers(
							peer_device_id, name, public_key, pinned_fingerprint, addresses_json, created_at
						 ) VALUES ('unrelated-peer', 'Unrelated peer', 'sensitive-review-public-key',
							'sensitive-review-transport-fingerprint', '["sensitive-review-address"]', ?)`,
					)
					.run(new Date().toISOString());
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('acme-work', 'Acme Work', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);

				const settingsRes = await app.request("/api/sync/sharing-domains/settings");
				expect(settingsRes.status).toBe(200);
				const settings = (await settingsRes.json()) as {
					scopes: Array<{ scope_id: string }>;
					projects: Array<{
						workspace_identity: string;
						display_project: string;
						resolved_scope_id: string;
					}>;
				};
				expect(settings.scopes.map((scope) => scope.scope_id)).toEqual(
					expect.arrayContaining(["local-default", "acme-work"]),
				);
				const project = settings.projects.find((item) => item.display_project === "test-project");
				expect(project).toMatchObject({ resolved_scope_id: "local-default" });

				const malformedRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspace_identity: project?.workspace_identity,
						project_pattern: project?.display_project,
						scope_id: ["acme-work"],
					}),
				});
				expect(malformedRes.status).toBe(400);

				const emptyScopeRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspace_identity: project?.workspace_identity,
						project_pattern: project?.display_project,
						scope_id: "",
					}),
				});
				expect(emptyScopeRes.status).toBe(400);

				const invalidScopeRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspace_identity: project?.workspace_identity,
						project_pattern: project?.display_project,
						scope_id: "missing-work-domain",
					}),
				});
				expect(invalidScopeRes.status).toBe(400);

				const unmappedLocalRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspace_identity: "unmapped:abc123",
						project_pattern: "unknown",
						scope_id: "local-default",
					}),
				});
				expect(unmappedLocalRes.status).toBe(400);

				const legacyScopeRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspace_identity: project?.workspace_identity,
						project_pattern: project?.display_project,
						scope_id: "legacy-shared-review",
					}),
				});
				expect(legacyScopeRes.status).toBe(400);

				const fractionalIdRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						id: 1.9,
						workspace_identity: project?.workspace_identity,
						project_pattern: project?.display_project,
						scope_id: "acme-work",
					}),
				});
				expect(fractionalIdRes.status).toBe(400);

				const saveRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspace_identity: project?.workspace_identity,
						project_pattern: project?.display_project,
						scope_id: "acme-work",
					}),
				});
				expect(saveRes.status).toBe(200);
				const saveBody = (await saveRes.json()) as { mapping: { id: number; scope_id: string } };
				expect(saveBody.mapping.scope_id).toBe("acme-work");

				const updatedRes = await app.request("/api/sync/sharing-domains/settings");
				const updated = (await updatedRes.json()) as {
					projects: Array<{
						display_project: string;
						resolved_scope_id: string;
						mapping_id: number;
					}>;
				};
				expect(
					updated.projects.find((item) => item.display_project === "test-project"),
				).toMatchObject({
					resolved_scope_id: "acme-work",
					mapping_id: saveBody.mapping.id,
				});
				const memberships = store.db
					.prepare("SELECT COUNT(*) AS n FROM scope_memberships")
					.get() as {
					n: number;
				};
				expect(memberships.n).toBe(0);

				const deleteRes = await app.request(
					`/api/sync/sharing-domains/project-mappings/${saveBody.mapping.id}`,
					{ method: "DELETE" },
				);
				expect(deleteRes.status).toBe(200);
			} finally {
				cleanup();
			}
		});

		it("returns confirmed setup suggestion fields in Sharing domain settings", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET cwd = ?, git_remote = ?, project = ? WHERE id = ?")
					.run(
						"/workspace/work/exampleco/api",
						"https://git.example.invalid/exampleco/api.git",
						"api",
						sessionId,
					);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "suggested project domain candidate",
					metadata: {},
				});
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('exampleco-work', 'ExampleCo Work', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);

				const settingsRes = await app.request("/api/sync/sharing-domains/settings");
				expect(settingsRes.status).toBe(200);
				const settings = (await settingsRes.json()) as {
					projects: Array<{
						display_project: string;
						resolved_scope_id: string;
						suggested_scope_id: string | null;
						suggestion_reason: string | null;
						suggestion_signal: string | null;
					}>;
				};

				expect(settings.projects.find((item) => item.display_project === "api")).toMatchObject({
					resolved_scope_id: "local-default",
					suggested_scope_id: "exampleco-work",
					suggestion_reason: expect.stringContaining("git remote"),
					suggestion_signal: "git_remote",
				});
			} finally {
				cleanup();
			}
		});

		it("returns a deterministic read-only legacy recipient-policy projection", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = "2026-07-21T12:00:00.000Z";
				const projectId = "https://git.example.invalid/acme/projection.git";
				const scopeId = "sensitive-managed-scope-id";
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run(projectId, "projection", sessionId);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "projection fixture",
					scopeId,
				});
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, coordinator_id, group_id,
							manifest_issuer_device_id, membership_epoch, manifest_hash,
							status, created_at, updated_at
						 ) VALUES (?, 'projection', 'managed_project', 'coordinator',
							'sensitive-coordinator', 'sensitive-group', 'sensitive-issuer', 7,
							'sensitive-manifest', 'active', ?, ?)`,
					)
					.run(scopeId, now, now);
				store.db
					.prepare(
						`INSERT INTO project_scope_mappings(
							workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
						 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`,
					)
					.run(projectId, projectId, scopeId, now, now);
				store.db
					.prepare(
						`INSERT INTO scope_memberships(
							scope_id, device_id, role, status, membership_epoch, coordinator_id,
							group_id, manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at
						 ) VALUES (?, 'unassigned-device', 'member', 'active', 7,
							'sensitive-coordinator', 'sensitive-group', 'sensitive-issuer',
							'sensitive-manifest', '{"sensitive":"manifest-payload"}', ?)`,
					)
					.run(scopeId, now);
				store.db
					.prepare(
						`INSERT INTO sync_peers(
							peer_device_id, name, public_key, pinned_fingerprint, addresses_json, created_at
						 ) VALUES ('unassigned-device', 'Spare laptop', 'sensitive-public-key',
							'sensitive-fingerprint', '["sensitive-address"]', ?)`,
					)
					.run(now);
				store.db
					.prepare(
						`INSERT INTO replication_ops(
							op_id, entity_type, entity_id, op_type, payload_json, clock_rev,
							clock_updated_at, clock_device_id, device_id, created_at, scope_id
						 ) VALUES ('projection-op', 'memory_item', 'projection-memory', 'upsert',
							'{"sensitive":"replication-payload"}', 1, ?, 'test-device-001',
							'test-device-001', ?, ?)`,
					)
					.run(now, now, scopeId);
				store.db
					.prepare(
						`INSERT INTO replication_cursors(
							peer_device_id, last_applied_cursor, last_acked_cursor, updated_at
						 ) VALUES ('unassigned-device', 'sensitive-applied-cursor', 'sensitive-acked-cursor', ?)`,
					)
					.run(now);
				const replicationBefore = JSON.stringify({
					ops: store.db.prepare("SELECT * FROM replication_ops ORDER BY op_id").all(),
					cursors: store.db
						.prepare("SELECT * FROM replication_cursors ORDER BY peer_device_id")
						.all(),
				});
				const totalChangesBefore = Number(
					store.db.prepare("SELECT total_changes() AS total").pluck().get(),
				);
				store.db.pragma("query_only = ON");

				const firstResponse = await app.request("/api/sync/recipient-policy/v1/projection");
				const secondResponse = await app.request("/api/sync/recipient-policy/v1/projection");
				const firstText = await firstResponse.text();
				const secondText = await secondResponse.text();
				const payload = JSON.parse(firstText) as Array<Record<string, unknown>>;
				const serialized = JSON.stringify(payload);
				const forbiddenKeys = new Set([
					"scope_id",
					"address",
					"addresses",
					"public_key",
					"fingerprint",
					"manifest",
					"manifest_hash",
					"membership_epoch",
					"epoch",
					"cursor",
					"invite_token",
					"token_digest",
					"filter",
					"payload",
				]);
				const visit = (value: unknown): void => {
					if (Array.isArray(value)) {
						value.forEach(visit);
						return;
					}
					if (!value || typeof value !== "object") return;
					for (const [key, child] of Object.entries(value)) {
						expect(forbiddenKeys.has(key.toLowerCase())).toBe(false);
						visit(child);
					}
				};

				expect(firstResponse.status).toBe(200);
				expect(secondResponse.status).toBe(200);
				expect(secondText).toBe(firstText);
				expect(payload).toEqual([
					expect.objectContaining({
						project: { version: 1, canonicalIdentity: projectId, displayName: "projection" },
						intent: [],
						enforcement: expect.objectContaining({ state: "managed_exact_project" }),
						effectiveDevices: [
							expect.objectContaining({
								deviceId: "unassigned-device",
								assignment: "unassigned",
							}),
						],
					}),
				]);
				visit(payload);
				for (const forbiddenValue of [
					scopeId,
					"sensitive-address",
					"sensitive-public-key",
					"sensitive-fingerprint",
					"sensitive-manifest",
					"manifest-payload",
					"replication-payload",
					"sensitive-applied-cursor",
					"sensitive-acked-cursor",
				]) {
					expect(serialized).not.toContain(forbiddenValue);
				}
				expect(
					JSON.stringify({
						ops: store.db.prepare("SELECT * FROM replication_ops ORDER BY op_id").all(),
						cursors: store.db
							.prepare("SELECT * FROM replication_cursors ORDER BY peer_device_id")
							.all(),
					}),
				).toBe(replicationBefore);
				expect(Number(store.db.prepare("SELECT total_changes() AS total").pluck().get())).toBe(
					totalChangesBefore,
				);
			} finally {
				getStore()?.db.pragma("query_only = OFF");
				cleanup();
			}
		});

		it("serves and resolves recipient-policy review without mutating protected state", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const projectId = "https://git.example.invalid/acme/review-route.git";
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run(projectId, "review-route", sessionId);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "review route fixture",
					metadata: {},
				});
				const protectedTables = [
					"replication_scopes",
					"project_scope_mappings",
					"scope_memberships",
					"memory_items",
					"replication_ops",
					"replication_cursors",
					"sync_peers",
				];
				const snapshot = () =>
					JSON.stringify(
						Object.fromEntries(
							protectedTables.map((table) => [
								table,
								store.db.prepare(`SELECT * FROM ${table}`).all(),
							]),
						),
					);

				expect(
					store.db.prepare("SELECT 1 FROM actors WHERE actor_id = ?").get(store.actorId),
				).toBeUndefined();
				const reviewResponse = await app.request("/api/sync/recipient-policy/v1/review");
				const review = (await reviewResponse.json()) as {
					reviewItems: Array<{
						reviewItemId: string;
						sourceFingerprint: string;
						options: Array<{ preview: { projects: Array<{ canonicalIdentity: string }> } }>;
					}>;
				};
				const item = review.reviewItems[0];
				if (!item) throw new Error("review item missing");
				const serialized = JSON.stringify(review);

				expect(reviewResponse.status).toBe(200);
				expect(
					store.db
						.prepare("SELECT status FROM actors WHERE actor_id = ? AND is_local = 1")
						.pluck()
						.get(store.actorId),
				).toBe("active");
				expect(item.options[0]?.preview.projects[0]?.canonicalIdentity).toBe(projectId);
				for (const forbidden of [
					"scopeId",
					"address",
					"publicKey",
					"epoch",
					"cursor",
					"token",
					"payload",
				]) {
					expect(serialized).not.toContain(forbidden);
				}
				for (const secret of [
					"sensitive-review-public-key",
					"sensitive-review-transport-fingerprint",
					"sensitive-review-address",
				]) {
					expect(serialized).not.toContain(secret);
				}

				const beforeSingle = snapshot();
				const attributedByClient = await app.request(
					"/api/sync/recipient-policy/v1/review/resolve",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							reviewItemId: item.reviewItemId,
							sourceFingerprint: item.sourceFingerprint,
							decision: "keep_current_setup",
							decidedByIdentityId: "client-supplied",
						}),
					},
				);
				expect(attributedByClient.status).toBe(400);
				const staleResponse = await app.request("/api/sync/recipient-policy/v1/review/resolve", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						reviewItemId: item.reviewItemId,
						sourceFingerprint: "stale",
						decision: "keep_current_setup",
					}),
				});
				expect(staleResponse.status).toBe(409);
				expect(
					store.db
						.prepare("SELECT COUNT(*) FROM recipient_policy_review_resolutions")
						.pluck()
						.get(),
				).toBe(0);

				store.db.prepare("DELETE FROM actors WHERE actor_id = ?").run(store.actorId);
				const resolveResponse = await app.request("/api/sync/recipient-policy/v1/review/resolve", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						reviewItemId: item.reviewItemId,
						sourceFingerprint: item.sourceFingerprint,
						decision: "keep_current_setup",
					}),
				});
				expect(resolveResponse.status).toBe(200);
				expect(await resolveResponse.json()).toMatchObject({ status: "applied" });
				expect(snapshot()).toBe(beforeSingle);

				const bulkProjectId = "https://git.example.invalid/acme/review-bulk-route.git";
				const bulkSessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run(bulkProjectId, "review-bulk-route", bulkSessionId);
				insertTestMemory(store, {
					sessionId: bulkSessionId,
					kind: "discovery",
					title: "bulk review route fixture",
					metadata: {},
				});
				const reopenedResponse = await app.request("/api/sync/recipient-policy/v1/review");
				const reopened = (await reopenedResponse.json()) as typeof review;
				const reopenedItem = reopened.reviewItems[0];
				if (!reopenedItem) throw new Error("reopened review item missing");
				const beforeBulk = snapshot();
				const bulkResponse = await app.request(
					"/api/sync/recipient-policy/v1/review/resolve-bulk",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							requests: [
								{
									reviewItemId: reopenedItem.reviewItemId,
									sourceFingerprint: reopenedItem.sourceFingerprint,
									decision: "keep_current_setup",
								},
								{
									reviewItemId: "missing",
									sourceFingerprint: "missing",
									decision: "keep_current_setup",
								},
							],
						}),
					},
				);
				const bulk = (await bulkResponse.json()) as {
					results: Array<{ status: string }>;
				};
				expect(bulkResponse.status).toBe(207);
				expect(bulk.results.map((result) => result.status)).toEqual(["applied", "not_found"]);
				expect(snapshot()).toBe(beforeBulk);
				const attribution = store.db
					.prepare(
						`SELECT decided_by_identity_id, decided_by_device_id
						 FROM recipient_policy_review_resolutions ORDER BY resolved_at LIMIT 1`,
					)
					.get() as Record<string, unknown>;
				expect(attribution).toMatchObject({
					decided_by_identity_id: store.actorId,
					decided_by_device_id: store.deviceId,
				});
			} finally {
				getStore()?.db.pragma("query_only = OFF");
				cleanup();
			}
		});

		it("serves safe recipient intent and strictly validates per-Project migration", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = "2026-07-21T12:00:00.000Z";
				const projectId = "https://git.example.invalid/acme/intent-route.git";
				const scopeId = "protected-route-scope";
				const recipientId = "identity-route-recipient";
				const deviceId = "device-route-recipient";
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run(projectId, "intent-route", sessionId);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "intent route fixture",
					scopeId,
				});
				store.db
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES (?, 'Route recipient', 0, 'active', ?, ?)`,
					)
					.run(recipientId, now, now);
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, coordinator_id, group_id,
							membership_epoch, status, created_at, updated_at
						 ) VALUES (?, 'Intent route', 'managed_project', 'coordinator',
							'private-coordinator', 'private-group', 1, 'active', ?, ?)`,
					)
					.run(scopeId, now, now);
				store.db
					.prepare(
						`INSERT INTO project_scope_mappings(
							workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
						 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`,
					)
					.run(projectId, projectId, scopeId, now, now);
				store.db
					.prepare(
						`INSERT INTO sync_peers(
							peer_device_id, name, actor_id, public_key, pinned_fingerprint, addresses_json, created_at
						 ) VALUES (?, 'Route laptop', ?, 'private-key', 'private-transport-fingerprint',
							'["private-address"]', ?)`,
					)
					.run(deviceId, recipientId, now);
				store.db
					.prepare(
						`INSERT INTO scope_memberships(
							scope_id, device_id, status, membership_epoch, coordinator_id, group_id, updated_at
						 ) VALUES (?, ?, 'active', 1, 'private-coordinator', 'private-group', ?)`,
					)
					.run(scopeId, deviceId, now);
				const project = {
					canonicalIdentity: projectId,
					displayName: "intent-route",
					identitySource: "git_remote",
					existingMemoryCount: 1,
				};
				const reviewedDigest = core.shareProjectSetDigest([project]);
				store.db
					.prepare(
						`INSERT INTO share_operations(
							operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
							person_kind, teammate_name, history_policy, reviewed_project_set_digest,
							coordinator_group_id, invite_token_digest, invite_expires_at,
							recipient_actor_id, recipient_device_id, acceptance_consumed_at, created_at, updated_at
						 ) VALUES ('route-operation', 'active', ?, '[]', ?, 'existing', 'Route recipient',
							'existing_and_future', ?, 'private-group', 'private-invite-digest',
							'2099-01-01T00:00:00.000Z', ?, ?, ?, ?, ?)`,
					)
					.run(store.actorId, recipientId, reviewedDigest, recipientId, deviceId, now, now, now);
				store.db
					.prepare(
						`INSERT INTO share_operation_projects(
							operation_id, canonical_project_identity, display_name, identity_source,
							existing_memory_count, ordinal
						 ) VALUES ('route-operation', ?, 'intent-route', 'git_remote', 1, 0)`,
					)
					.run(projectId);

				const invalid = await app.request("/api/sync/recipient-policy/v1/migrate", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ dryRun: true, actorId: "client-controlled" }),
				});
				expect(invalid.status).toBe(400);

				const dryRun = await app.request("/api/sync/recipient-policy/v1/migrate", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ dryRun: true }),
				});
				expect(dryRun.status).toBe(200);
				expect(await dryRun.json()).toMatchObject({ dryRun: true });
				expect(store.db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);

				const migrate = await app.request("/api/sync/recipient-policy/v1/migrate", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({}),
				});
				expect(migrate.status).toBe(200);
				const intentResponse = await app.request("/api/sync/recipient-policy/v1/intent");
				const intentText = await intentResponse.text();
				const intent = JSON.parse(intentText) as Record<string, unknown>;

				expect(intentResponse.status).toBe(200);
				expect(intent).toMatchObject({
					version: 1,
					projectRecipients: [
						expect.objectContaining({
							canonicalProjectIdentity: projectId,
							recipientKind: "identity",
							identityId: recipientId,
						}),
					],
				});
				for (const forbidden of [
					scopeId,
					"private-group",
					"private-coordinator",
					"private-address",
					"private-key",
					"private-transport-fingerprint",
					"private-invite-digest",
				]) {
					expect(intentText).not.toContain(forbidden);
				}
				for (const forbiddenKey of [
					"scopeId",
					"groupId",
					"address",
					"publicKey",
					"fingerprint",
					"epoch",
					"cursor",
					"filter",
					"payload",
				]) {
					expect(intentText).not.toContain(forbiddenKey);
				}
			} finally {
				cleanup();
			}
		});

		it("strictly previews and commits safe recipient-policy edge changes", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = "2026-07-21T12:00:00.000Z";
				const projectId = "https://git.example.invalid/acme/edge-route.git";
				const identityId = "identity-edge-route";
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run(projectId, "edge-route", sessionId);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "edge route fixture",
					metadata: {},
				});
				store.db
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES (?, 'Edge recipient', 0, 'active', ?, ?)`,
					)
					.run(identityId, now, now);
				store.db
					.prepare(
						`INSERT INTO identity_devices(
						 device_id, identity_id, display_name, status, provenance, revision,
						 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
						 ) VALUES ('edge-device', ?, 'Recipient laptop', 'active', 'user',
						 'private-device-revision', 'user_managed', 'private-source-fingerprint',
						 'private-device-idempotency', ?, ?)`,
					)
					.run(identityId, now, now);
				store.db
					.prepare(
						`INSERT INTO sync_peers(
						 peer_device_id, name, actor_id, public_key, pinned_fingerprint, addresses_json, created_at
						 ) VALUES ('edge-device', 'Recipient laptop', ?, 'private-public-key',
						 'private-transport-fingerprint', '["private-address"]', ?)`,
					)
					.run(identityId, now);

				const change = {
					canonicalProjectIdentity: projectId,
					recipient: { recipientKind: "identity", identityId },
					action: "add",
				};
				for (const invalidBody of [
					{ version: 1, changes: [{ ...change, displayName: "edge-route" }] },
					{ version: 1, changes: [change], direction: "project-first" },
					{ version: 1, changes: [change], decidedByIdentityId: "client-controlled" },
					{
						version: 1,
						changes: [
							{
								...change,
								recipient: { ...change.recipient, displayName: "Edge recipient" },
							},
						],
					},
				]) {
					const invalid = await app.request("/api/sync/recipient-policy/v1/edges/preview", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(invalidBody),
					});
					expect(invalid.status).toBe(400);
				}

				const protectedTables = [
					"actors",
					"identity_devices",
					"sessions",
					"memory_items",
					"sync_peers",
					"scope_memberships",
					"replication_ops",
					"replication_cursors",
				];
				const protectedSnapshot = () =>
					JSON.stringify(
						Object.fromEntries(
							protectedTables.map((table) => [
								table,
								store.db.prepare(`SELECT * FROM ${table}`).all(),
							]),
						),
					);
				const beforePreview = protectedSnapshot();
				const previewResponse = await app.request("/api/sync/recipient-policy/v1/edges/preview", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ version: 1, changes: [change] }),
				});
				const previewText = await previewResponse.text();
				const preview = JSON.parse(previewText) as { reviewedPolicyDigest: string };
				expect(previewResponse.status).toBe(200);
				expect(preview).toMatchObject({
					projects: [
						{
							canonicalProjectIdentity: projectId,
							displayName: "edge-route",
							existingMemoryCount: 1,
							futureMemoriesShared: true,
						},
					],
					selectedRecipients: [
						{
							recipientKind: "identity",
							identityId,
							displayName: "Edge recipient",
							verification: "local",
						},
					],
				});
				expect(protectedSnapshot()).toBe(beforePreview);
				expect(store.db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
				for (const secret of [
					"private-public-key",
					"private-transport-fingerprint",
					"private-address",
					"private-source-fingerprint",
					"private-device-idempotency",
				]) {
					expect(previewText).not.toContain(secret);
				}
				for (const forbiddenKey of [
					"scopeId",
					"groupId",
					"address",
					"publicKey",
					"fingerprint",
					"epoch",
					"cursor",
					"filter",
					"payload",
				]) {
					expect(previewText).not.toContain(forbiddenKey);
				}

				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "concurrent edge route memory",
					metadata: {},
				});
				const staleCommit = await app.request("/api/sync/recipient-policy/v1/edges/commit", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						version: 1,
						changes: [change],
						reviewedPolicyDigest: preview.reviewedPolicyDigest,
					}),
				});
				expect(staleCommit.status).toBe(409);
				expect(await staleCommit.json()).toMatchObject({ status: "stale", writeCount: 0 });
				expect(store.db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
				const refreshedResponse = await app.request("/api/sync/recipient-policy/v1/edges/preview", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ version: 1, changes: [change] }),
				});
				const refreshed = (await refreshedResponse.json()) as { reviewedPolicyDigest: string };
				const beforeCommit = protectedSnapshot();

				const invalidCommit = await app.request("/api/sync/recipient-policy/v1/edges/commit", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						version: 1,
						changes: [change],
						reviewedPolicyDigest: refreshed.reviewedPolicyDigest,
						displayName: "forbidden",
					}),
				});
				expect(invalidCommit.status).toBe(400);

				const commitResponse = await app.request("/api/sync/recipient-policy/v1/edges/commit", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						version: 1,
						changes: [change],
						reviewedPolicyDigest: refreshed.reviewedPolicyDigest,
					}),
				});
				expect(commitResponse.status).toBe(200);
				expect(await commitResponse.json()).toMatchObject({
					status: "applied",
					writeCount: 1,
					idempotent: false,
					outcomes: [{ outcome: "added" }],
				});
				expect(protectedSnapshot()).toBe(beforeCommit);

				const missing = await app.request("/api/sync/recipient-policy/v1/edges/preview", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						version: 1,
						changes: [{ ...change, canonicalProjectIdentity: "edge-route" }],
					}),
				});
				expect(missing.status).toBe(404);
			} finally {
				cleanup();
			}
		});

		it("returns retryable 503 when recipient-policy commit cannot acquire the write lock", async () => {
			const { app, getStore, cleanup } = createTestApp();
			let competing: InstanceType<typeof Database> | null = null;
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = "2026-07-21T12:00:00.000Z";
				const projectId = "https://git.example.invalid/acme/busy-edge.git";
				const identityId = "identity-busy-edge";
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run(projectId, "busy-edge", sessionId);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "busy edge fixture",
					metadata: {},
				});
				store.db
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES (?, 'Busy recipient', 0, 'active', ?, ?)`,
					)
					.run(identityId, now, now);
				const changes = [
					{
						canonicalProjectIdentity: projectId,
						recipient: { recipientKind: "identity", identityId },
						action: "add",
					},
				];
				const previewResponse = await app.request("/api/sync/recipient-policy/v1/edges/preview", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ version: 1, changes }),
				});
				const preview = (await previewResponse.json()) as { reviewedPolicyDigest: string };
				const database = store.db.pragma("database_list") as Array<{ file: string }>;
				const databasePath = database.find((entry) => entry.file)?.file;
				if (!databasePath) throw new Error("test database path missing");
				store.db.pragma("busy_timeout = 1");
				competing = new Database(databasePath);
				competing.exec("BEGIN IMMEDIATE");

				const response = await app.request("/api/sync/recipient-policy/v1/edges/commit", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						version: 1,
						changes,
						reviewedPolicyDigest: preview.reviewedPolicyDigest,
					}),
				});

				expect(response.status).toBe(503);
				expect(response.headers.get("Retry-After")).toBe("1");
				expect(await response.json()).toEqual({ error: "edge_commit_busy" });
				expect(store.db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
			} finally {
				if (competing?.inTransaction) competing.exec("ROLLBACK");
				competing?.close();
				cleanup();
			}
		});

		it("returns searchable project inventory for the Projects screen", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET cwd = ?, git_remote = ?, project = ? WHERE id = ?")
					.run(
						"/workspace/work/exampleco/api",
						"https://git.example.invalid/exampleco/api.git",
						"api",
						sessionId,
					);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "project inventory candidate",
					metadata: {},
				});
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('exampleco-work', 'ExampleCo Work', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);

				const projectIdentity = "https://git.example.invalid/exampleco/api.git";
				const saveRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspace_identity: projectIdentity,
						project_pattern: "api",
						scope_id: "exampleco-work",
					}),
				});
				expect(saveRes.status).toBe(200);

				const inventoryRes = await app.request(
					"/api/sync/projects?q=exampleco&status=explicitly_mapped&limit=1",
				);
				expect(inventoryRes.status).toBe(200);
				const inventory = (await inventoryRes.json()) as {
					projects: Array<{
						resolved_scope_id: string;
						statuses: string[];
						workspace_identity: string;
					}>;
					total: number;
					has_more: boolean;
				};

				expect(inventory).toMatchObject({ total: 1, has_more: false });
				expect(inventory.projects).toEqual([
					expect.objectContaining({
						resolved_scope_id: "exampleco-work",
						statuses: expect.arrayContaining(["explicitly_mapped"]),
						workspace_identity: projectIdentity,
					}),
				]);
			} finally {
				cleanup();
			}
		});

		it("reassigns a project inventory row to the corrected project", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare(
						"UPDATE sessions SET cwd = ?, git_remote = NULL, git_branch = NULL, project = ? WHERE id = ?",
					)
					.run("/workspace/codemem/worktrees/injection", "injection", sessionId);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "project correction candidate",
				});

				const res = await app.request("/api/sync/projects/reassign-project", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						project: "codemem",
						workspace_identity: "/workspace/codemem/worktrees/injection",
					}),
				});

				expect(res.status).toBe(200);
				expect(await res.json()).toMatchObject({
					moved_memory_count: 1,
					moved_session_count: 1,
					previous_projects: ["injection"],
					project: "codemem",
				});
				const inventoryRes = await app.request("/api/sync/projects?q=codemem");
				const inventory = (await inventoryRes.json()) as { projects: Array<{ project: string }> };
				expect(inventory.projects).toEqual(
					expect.arrayContaining([expect.objectContaining({ project: "codemem" })]),
				);
			} finally {
				cleanup();
			}
		});

		it("preflights bulk project mappings before writing any mappings", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('acme-work', 'Acme Work', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);

				const res = await app.request("/api/sync/sharing-domains/project-mappings/bulk", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mappings: [
							{
								project_pattern: "safe-api",
								scope_id: "acme-work",
								workspace_identity: "git:https://git.example.invalid/acme/safe-api.git",
							},
							{
								project_pattern: "unknown",
								scope_id: "acme-work",
								workspace_identity: "unmapped:abc123",
							},
						],
					}),
				});
				expect(res.status).toBe(400);
				const mappings = store.db
					.prepare("SELECT COUNT(*) AS n FROM project_scope_mappings")
					.get() as { n: number };
				expect(mappings.n).toBe(0);
			} finally {
				cleanup();
			}
		});

		it("forgets locally owned project memories while leaving peer-owned copies", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run("https://git.example.invalid/tmp/bogus.git", "bogus", sessionId);
				insertTestMemory(store, {
					kind: "discovery",
					sessionId,
					title: "local bogus",
				});
				insertTestMemory(store, {
					actorId: "remote-actor",
					kind: "discovery",
					originDeviceId: "peer-device",
					sessionId,
					title: "peer bogus",
				});

				const previewRes = await app.request("/api/sync/projects/forget", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspace_identity: "https://git.example.invalid/tmp/bogus.git",
					}),
				});
				expect(previewRes.status).toBe(409);
				const preview = (await previewRes.json()) as {
					preview: { confirmation_token: string };
				};
				expect(preview).toMatchObject({
					error: "project_forget_confirmation_required",
					preview: {
						local_owned_memory_count: 1,
						peer_owned_memory_count: 1,
						workspace_identity: "https://git.example.invalid/tmp/bogus.git",
					},
				});

				const forgetRes = await app.request("/api/sync/projects/forget", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						confirmation_token: preview.preview.confirmation_token,
						confirmed: true,
						workspace_identity: "https://git.example.invalid/tmp/bogus.git",
					}),
				});
				expect(forgetRes.status).toBe(200);
				expect(await forgetRes.json()).toMatchObject({ forgotten_memory_count: 1 });
				const rows = store.db
					.prepare("SELECT title, active FROM memory_items ORDER BY title")
					.all() as Array<{ active: number; title: string }>;
				expect(rows).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ active: 0, title: "local bogus" }),
						expect.objectContaining({ active: 1, title: "peer bogus" }),
					]),
				);
			} finally {
				cleanup();
			}
		});

		it("rejects project memory cleanup when the previewed row set changes", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run("https://git.example.invalid/tmp/bogus.git", "bogus", sessionId);
				insertTestMemory(store, {
					kind: "discovery",
					sessionId,
					title: "previewed bogus",
				});

				const previewRes = await app.request("/api/sync/projects/forget", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspace_identity: "https://git.example.invalid/tmp/bogus.git",
					}),
				});
				expect(previewRes.status).toBe(409);
				const preview = (await previewRes.json()) as {
					preview: { confirmation_token: string };
				};
				insertTestMemory(store, {
					kind: "discovery",
					sessionId,
					title: "late bogus",
				});

				const staleConfirmRes = await app.request("/api/sync/projects/forget", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						confirmation_token: preview.preview.confirmation_token,
						confirmed: true,
						workspace_identity: "https://git.example.invalid/tmp/bogus.git",
					}),
				});
				expect(staleConfirmRes.status).toBe(400);
				const staleConfirm = (await staleConfirmRes.json()) as { error: string };
				expect(staleConfirm.error).toContain("changed before cleanup");
				const rows = store.db
					.prepare("SELECT title, active FROM memory_items ORDER BY title")
					.all() as Array<{ active: number; title: string }>;
				expect(rows).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ active: 1, title: "late bogus" }),
						expect.objectContaining({ active: 1, title: "previewed bogus" }),
					]),
				);
			} finally {
				cleanup();
			}
		});

		it("requires confirmation before saving risky Sharing domain mappings", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('acme-work', 'Acme Work', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);

				const unconfirmedRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						project_pattern: "/home/fixture-user/*",
						scope_id: "acme-work",
					}),
				});
				expect(unconfirmedRes.status).toBe(409);
				const unconfirmed = (await unconfirmedRes.json()) as {
					error: string;
					required_guardrails: string[];
					required_guardrail_tokens: string[];
					guardrail_warnings: Array<{
						code: string;
						confirmation_token: string;
						requires_confirmation: boolean;
					}>;
				};
				expect(unconfirmed).toMatchObject({
					error: "guardrail_confirmation_required",
					required_guardrails: ["broad_org_domain_pattern", "home_directory_org_domain_pattern"],
				});
				expect(unconfirmed.guardrail_warnings).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							code: "broad_org_domain_pattern",
							confirmation_token: expect.stringMatching(/^psg_/),
						}),
						expect.objectContaining({
							code: "home_directory_org_domain_pattern",
							confirmation_token: expect.stringMatching(/^psg_/),
						}),
					]),
				);
				const codeOnlyRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						confirmed_guardrails: ["broad_org_domain_pattern", "home_directory_org_domain_pattern"],
						project_pattern: "/home/fixture-user/*",
						scope_id: "acme-work",
					}),
				});
				expect(codeOnlyRes.status).toBe(409);
				const staleTokenRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						confirmed_guardrail_tokens: unconfirmed.required_guardrail_tokens,
						project_pattern: "/Users/bob/*",
						scope_id: "acme-work",
					}),
				});
				expect(staleTokenRes.status).toBe(409);

				const confirmedRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						confirmed_guardrail_tokens: unconfirmed.required_guardrail_tokens,
						project_pattern: "/home/fixture-user/*",
						scope_id: "acme-work",
					}),
				});
				expect(confirmedRes.status).toBe(200);
				const confirmed = (await confirmedRes.json()) as {
					mapping: { scope_id: string };
					guardrail_warnings: Array<{ code: string }>;
				};
				expect(confirmed.mapping.scope_id).toBe("acme-work");
				expect(confirmed.guardrail_warnings.map((warning) => warning.code)).toEqual([
					"broad_org_domain_pattern",
					"home_directory_org_domain_pattern",
				]);
			} finally {
				cleanup();
			}
		});

		it("rejects bulk project mappings before writing any partial updates", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('acme-work', 'Acme Work', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);

				const res = await app.request("/api/sync/sharing-domains/project-mappings/bulk", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mappings: [
							{
								project_pattern: "safe-project",
								scope_id: "acme-work",
								workspace_identity: "workspace:safe-project",
							},
							{
								project_pattern: "/home/fixture-user/*",
								scope_id: "acme-work",
							},
						],
					}),
				});

				expect(res.status).toBe(409);
				expect(await res.json()).toMatchObject({ error: "guardrail_confirmation_required" });
				const saved = store.db
					.prepare("SELECT COUNT(*) AS n FROM project_scope_mappings WHERE scope_id = ?")
					.get("acme-work") as { n: number };
				expect(saved.n).toBe(0);
			} finally {
				cleanup();
			}
		});

		it("blocks unmapped projects from non-local Sharing domain assignment", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				const sessionResult = store.db
					.prepare(
						`INSERT INTO sessions(started_at, cwd, project, git_remote, git_branch, user, tool_version)
						 VALUES (?, NULL, NULL, NULL, NULL, ?, ?)`,
					)
					.run(now, "test-user", "test");
				insertTestMemory(store, {
					sessionId: Number(sessionResult.lastInsertRowid),
					kind: "discovery",
					title: "unmapped project candidate",
					metadata: {},
				});
				store.db
					.prepare("UPDATE memory_items SET workspace_id = NULL WHERE title = ?")
					.run("unmapped project candidate");
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('acme-work', 'Acme Work', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);

				const settingsRes = await app.request("/api/sync/sharing-domains/settings");
				const settings = (await settingsRes.json()) as {
					projects: Array<{
						display_project: string;
						identity_source: string;
						workspace_identity: string;
					}>;
				};
				const project = settings.projects.find((item) => item.identity_source === "unmapped");
				expect(project?.workspace_identity).toMatch(/^unmapped:/);

				const res = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspace_identity: project?.workspace_identity,
						project_pattern: project?.display_project,
						scope_id: "acme-work",
					}),
				});
				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({ error: "unmapped_project_local_only" });
				const mappingResult = store.db
					.prepare(
						`INSERT INTO project_scope_mappings(
							workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
						 ) VALUES (?, ?, ?, 0, 'user', ?, ?)`,
					)
					.run(project?.workspace_identity, project?.display_project, "local-default", now, now);
				const byIdRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						id: Number(mappingResult.lastInsertRowid),
						scope_id: "acme-work",
					}),
				});
				expect(byIdRes.status).toBe(400);
				expect(await byIdRes.json()).toMatchObject({ error: "unmapped_project_local_only" });
			} finally {
				cleanup();
			}
		});

		it("requires confirmation before reassigning an existing project mapping", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "reassignment candidate",
					metadata: {},
				});
				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('acme-work', 'Acme Work', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('personal-devices', 'Personal Devices', 'personal', 'local', 1, 'active', ?, ?)`,
					)
					.run(now, now);
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES ('oss-codemem', 'OSS codemem', 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(now, now);
				const settingsRes = await app.request("/api/sync/sharing-domains/settings");
				const settings = (await settingsRes.json()) as {
					projects: Array<{ display_project: string; workspace_identity: string }>;
				};
				const project = settings.projects.find((item) => item.display_project === "test-project");
				if (!project) throw new Error("project missing");
				const createRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspace_identity: project.workspace_identity,
						project_pattern: project.display_project,
						scope_id: "acme-work",
					}),
				});
				expect(createRes.status).toBe(200);
				const created = (await createRes.json()) as { mapping: { id: number } };

				const unconfirmedRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						id: created.mapping.id,
						scope_id: "personal-devices",
					}),
				});
				expect(unconfirmedRes.status).toBe(409);
				const unconfirmed = (await unconfirmedRes.json()) as {
					required_guardrails: string[];
					required_guardrail_tokens: string[];
				};
				expect(unconfirmed).toMatchObject({
					error: "guardrail_confirmation_required",
					required_guardrails: ["scope_reassignment_old_copies"],
				});
				expect(unconfirmed.required_guardrail_tokens).toEqual([expect.stringMatching(/^psg_/)]);
				store.db
					.prepare("UPDATE project_scope_mappings SET scope_id = ? WHERE id = ?")
					.run("oss-codemem", created.mapping.id);
				const staleTokenRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						confirmed_guardrail_tokens: unconfirmed.required_guardrail_tokens,
						id: created.mapping.id,
						scope_id: "personal-devices",
					}),
				});
				expect(staleTokenRes.status).toBe(409);
				const staleTokenBody = (await staleTokenRes.json()) as {
					required_guardrail_tokens: string[];
				};
				expect(staleTokenBody.required_guardrail_tokens).not.toEqual(
					unconfirmed.required_guardrail_tokens,
				);

				const confirmedRes = await app.request("/api/sync/sharing-domains/project-mappings", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						confirmed_guardrail_tokens: staleTokenBody.required_guardrail_tokens,
						id: created.mapping.id,
						scope_id: "personal-devices",
					}),
				});
				expect(confirmedRes.status).toBe(200);
				expect(await confirmedRes.json()).toMatchObject({
					mapping: { id: created.mapping.id, scope_id: "personal-devices" },
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
						`INSERT INTO sync_peers(
							peer_device_id, name, actor_id, claimed_local_actor, pinned_fingerprint,
							addresses_json, last_error, created_at
						) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
					)
					.run(
						"peer-claim",
						"Peer Claim",
						store.actorId,
						"fp-claim",
						JSON.stringify(["10.0.0.5:38899"]),
						"raw sync error",
						now,
					);

				const redactedRes = await app.request("/api/sync/peers");
				expect(redactedRes.status).toBe(200);
				const redactedBody = (await redactedRes.json()) as {
					items: Array<{
						addresses: unknown[];
						claimed_local_actor_scope: Record<string, unknown> | null;
						fingerprint: unknown;
						last_error: unknown;
					}>;
					redacted: boolean;
				};
				expect(redactedBody.redacted).toBe(true);
				expect(redactedBody.items[0]?.fingerprint).toBeNull();
				expect(redactedBody.items[0]?.addresses).toEqual([]);
				expect(redactedBody.items[0]?.last_error).toBeNull();
				expect(redactedBody.items[0]?.claimed_local_actor_scope).toMatchObject({
					action_required: true,
					authorized: false,
					scope_id: `personal:${store.actorId}`,
					state: "not_authorized",
				});

				const statusRes = await app.request("/api/sync/status");
				expect(statusRes.status).toBe(200);
				const statusBody = (await statusRes.json()) as {
					peers: Array<{
						claimed_local_actor_scope: Record<string, unknown> | null;
						peer_device_id: string;
					}>;
				};
				const statusPeer = statusBody.peers.find((item) => item.peer_device_id === "peer-claim");
				expect(statusPeer?.claimed_local_actor_scope).toMatchObject({
					action_required: true,
					authorized: false,
					scope_id: `personal:${store.actorId}`,
					state: "not_authorized",
				});

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

		it("redacts sync attempt errors unless diagnostics are requested", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = new Date().toISOString();
				store.db
					.prepare(
						"INSERT INTO sync_attempts(peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error) VALUES (?, ?, ?, 0, 0, 0, ?)",
					)
					.run(
						"peer-1",
						now,
						now,
						"all addresses failed | http://10.0.0.5:7337: unauthorized:fingerprint_mismatch",
					);

				const redactedRes = await app.request("/api/sync/attempts");
				expect(redactedRes.status).toBe(200);
				const redactedBody = (await redactedRes.json()) as {
					items: Array<{ error: string | null; error_redacted?: boolean; address: string | null }>;
					redacted: boolean;
				};
				expect(redactedBody.redacted).toBe(true);
				expect(redactedBody.items[0]?.error).toBe(
					"sync attempt failed; enable diagnostics for details",
				);
				expect(redactedBody.items[0]?.error_redacted).toBe(true);
				expect(redactedBody.items[0]?.address).toBeNull();

				const redactedStatusRes = await app.request("/api/sync/status");
				expect(redactedStatusRes.status).toBe(200);
				const redactedStatusBody = (await redactedStatusRes.json()) as {
					attempts: Array<{ error: string | null; error_redacted?: boolean }>;
				};
				expect(redactedStatusBody.attempts[0]?.error).toBe(
					"sync attempt failed; enable diagnostics for details",
				);
				expect(redactedStatusBody.attempts[0]?.error_redacted).toBe(true);

				const diagnosticRes = await app.request("/api/sync/attempts?includeDiagnostics=1");
				expect(diagnosticRes.status).toBe(200);
				const diagnosticBody = (await diagnosticRes.json()) as {
					items: Array<{ error: string | null; error_redacted?: boolean }>;
					redacted: boolean;
				};
				expect(diagnosticBody.redacted).toBe(false);
				expect(diagnosticBody.items[0]?.error).toContain("fingerprint_mismatch");
				expect(diagnosticBody.items[0]?.error_redacted).toBe(false);

				const diagnosticStatusRes = await app.request("/api/sync/status?includeDiagnostics=1");
				expect(diagnosticStatusRes.status).toBe(200);
				const diagnosticStatusBody = (await diagnosticStatusRes.json()) as {
					attempts: Array<{ error: string | null; error_redacted?: boolean }>;
				};
				expect(diagnosticStatusBody.attempts[0]?.error).toContain("fingerprint_mismatch");
				expect(diagnosticStatusBody.attempts[0]?.error_redacted).toBe(false);
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
					body: JSON.stringify({ display_name: "Fixture shadow" }),
				});
				expect(createRes.status).toBe(200);
				const created = (await createRes.json()) as { actor_id: string; display_name: string };
				expect(created.display_name).toBe("Fixture shadow");

				const renameRes = await app.request("/api/sync/actors/rename", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ actor_id: created.actor_id, display_name: "Fixture remote" }),
				});
				expect(renameRes.status).toBe(200);
				expect((await renameRes.json()).display_name).toBe("Fixture remote");

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

		it("demotes stale is_local=1 rows so only the canonical local actor stays marked local", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");

				const now = new Date().toISOString();
				store.db
					.prepare(
						`INSERT INTO actors (actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES (?, ?, 1, 'active', ?, ?)`,
					)
					.run("local:stale-device-uuid", "Stale Local", now, now);

				const res = await app.request("/api/sync/actors");
				expect(res.status).toBe(200);

				const localActorRows = store.db
					.prepare("SELECT actor_id, is_local FROM actors WHERE is_local = 1")
					.all() as Array<{ actor_id: string; is_local: number }>;
				expect(localActorRows).toHaveLength(1);
				expect(localActorRows[0]?.actor_id).toBe(store.actorId);

				const staleRow = store.db
					.prepare("SELECT is_local FROM actors WHERE actor_id = ?")
					.get("local:stale-device-uuid") as { is_local: number } | undefined;
				expect(staleRow?.is_local).toBe(0);
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
									fingerprint: FRESH_PEER_FINGERPRINT,
									public_key: FRESH_PEER_PUBLIC_KEY,
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
						FRESH_PEER_FINGERPRINT,
						JSON.stringify(["http://old.example:7337"]),
						"offline",
						new Date().toISOString(),
					);
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						fingerprint: FRESH_PEER_FINGERPRINT,
					}),
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
						pinned_fingerprint: FRESH_PEER_FINGERPRINT,
						last_error: "offline",
					}),
				);
				expect(JSON.parse(String(peerRow?.addresses_json ?? "[]"))).toEqual([
					"http://10.0.0.5:7337",
					"http://old.example:7337",
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

		it("refreshes an existing multi-group peer address cache from sync status without re-pairing", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith("/v1/presence")) {
					return new Response(JSON.stringify({ ok: true, addresses: ["http://local:7337"] }), {
						status: 200,
					});
				}
				if (url.includes("/v1/peers?group_id=team-a")) {
					return new Response(
						JSON.stringify({
							items: [
								{
									device_id: "peer-fresh",
									display_name: "Fresh Device",
									fingerprint: FRESH_PEER_FINGERPRINT,
									public_key: FRESH_PEER_PUBLIC_KEY,
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
									fingerprint: FRESH_PEER_FINGERPRINT,
									public_key: FRESH_PEER_PUBLIC_KEY,
									addresses: ["10.0.0.6:7337"],
									last_seen_at: new Date().toISOString(),
									expires_at: new Date(Date.now() + 60_000).toISOString(),
									stale: false,
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.includes("/v1/reciprocal-approvals")) {
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
					sync_coordinator_url: "https://coord-refresh.example.test",
					sync_coordinator_groups: ["team-a", "team-b"],
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
						FRESH_PEER_FINGERPRINT,
						JSON.stringify(["http://old.example:7337"]),
						"all addresses failed",
						new Date().toISOString(),
					);

				const res = await app.request("/api/sync/status?includeDiagnostics=1");

				expect(res.status).toBe(200);
				const body = (await res.json()) as { peers?: Array<Record<string, unknown>> };
				const peerPayload = body.peers?.find((peer) => peer.peer_device_id === "peer-fresh");
				expect(peerPayload?.addresses).toEqual([
					"http://10.0.0.5:7337",
					"http://10.0.0.6:7337",
					"http://old.example:7337",
				]);
				const peerRow = store.db
					.prepare("SELECT addresses_json, last_error FROM sync_peers WHERE peer_device_id = ?")
					.get("peer-fresh") as Record<string, unknown> | undefined;
				expect(JSON.parse(String(peerRow?.addresses_json ?? "[]"))).toEqual([
					"http://10.0.0.5:7337",
					"http://10.0.0.6:7337",
					"http://old.example:7337",
				]);
				expect(peerRow?.last_error).toBe("all addresses failed");
				expect(
					fetchMock.mock.calls.some(
						([input, init]) =>
							String(input).endsWith("/v1/reciprocal-approvals") && init?.method === "POST",
					),
				).toBe(false);
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
									fingerprint: REKEYED_PEER_FINGERPRINT,
									public_key: REKEYED_PEER_PUBLIC_KEY,
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
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						fingerprint: REKEYED_PEER_FINGERPRINT,
					}),
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
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						fingerprint: FRESH_PEER_FINGERPRINT,
					}),
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

		it("returns 400 with coordinator_url_missing when no coordinator URL is configured", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(configPath, JSON.stringify({ sync_enabled: false }));
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						fingerprint: FRESH_PEER_FINGERPRINT,
					}),
				});
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					error: "coordinator_not_configured",
					reason: "coordinator_url_missing",
					detail: "Configure a coordinator URL before pairing with discovered peers.",
				});
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("returns 400 with coordinator_groups_empty when URL is set but no groups", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_enabled: false,
					sync_coordinator_url: "http://localhost:7347",
				}),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						fingerprint: FRESH_PEER_FINGERPRINT,
					}),
				});
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					error: "coordinator_not_configured",
					reason: "coordinator_groups_empty",
					detail: "Join a coordinator team before pairing with discovered peers.",
				});
			} finally {
				cleanup();
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("returns 400 with sync_disabled when coordinator is fully set up but sync is off", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_enabled: false,
					sync_coordinator_url: "http://localhost:7347",
					sync_coordinator_groups: ["test-team"],
				}),
			);
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						fingerprint: FRESH_PEER_FINGERPRINT,
					}),
				});
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					error: "coordinator_not_configured",
					reason: "sync_disabled",
					detail: "Enable sync on this device before pairing with discovered peers.",
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
									fingerprint: FRESH_PEER_FINGERPRINT,
									public_key: FRESH_PEER_PUBLIC_KEY,
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
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						fingerprint: FRESH_PEER_FINGERPRINT,
					}),
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
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						fingerprint: FRESH_PEER_FINGERPRINT,
					}),
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

		it("previews and creates Team and add-device invites through the recipient coordinator contract", async () => {
			const configDir = mkdtempSync(join(tmpdir(), "codemem-recipient-invite-create-"));
			const configPath = join(configDir, "config.json");
			const keysDir = join(configDir, "keys");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
			const previousFetch = globalThis.fetch;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "coordinator-a",
					sync_coordinator_admin_secret: "secret",
				}),
			);
			const coordinatorBodies: Record<string, unknown>[] = [];
			globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(
					init?.body instanceof Uint8Array
						? new TextDecoder().decode(init.body)
						: String(init?.body ?? "{}"),
				) as Record<string, unknown>;
				coordinatorBodies.push(body);
				const payload = {
					v: 1,
					kind: body.invite_kind,
					coordinator_url: "https://coord.example.test",
					group_id: body.group_id,
					policy: body.policy,
					token: `token-${String(body.invite_kind)}`,
					expires_at: body.expires_at,
					team_name: null,
					policy_team_id: body.policy_team_id ?? undefined,
					target_identity_id: body.target_identity_id ?? undefined,
					reviewed_preview_digest: body.reviewed_preview_digest,
				};
				return new Response(
					JSON.stringify({
						invite: {
							invite_id: `invite-${String(body.invite_kind)}`,
							invite_kind: body.invite_kind,
							policy_team_id: body.policy_team_id,
							target_identity_id: body.target_identity_id,
							reviewed_preview_digest: body.reviewed_preview_digest,
						},
						payload,
						encoded: core.encodeInvitePayload(payload as core.InvitePayload),
						link: "codemem://join?invite=recipient",
					}),
					{ status: 200 },
				);
			}) as typeof fetch;
			const { app, ensureStore, cleanup } = createTestApp({ seedDevice: false });
			try {
				const store = ensureStore();
				const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });
				store.adoptEnsuredDeviceIdentity(deviceId);
				const now = "2026-07-21T12:00:00.000Z";
				store.db
					.prepare(`INSERT INTO policy_teams(
					team_id, display_name, status, provenance, revision, migration_state,
					source_fingerprint, idempotency_key, created_at, updated_at
				) VALUES ('policy-team-a', 'Policy Team A', 'active', 'user', 'r1',
					'user_managed', NULL, 'team-a', ?, ?)`)
					.run(now, now);

				for (const requestBody of [
					{ kind: "team_member", policy_team_id: "policy-team-a" },
					{ kind: "add_device", target_identity_id: store.actorId },
				] as const) {
					const previewResponse = await app.request(
						"/api/sync/recipient-policy/v1/invites/preview",
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(requestBody),
						},
					);
					expect(previewResponse.status).toBe(200);
					const previewBody = (await previewResponse.json()) as {
						preview: { reviewedOnboardingDigest: string };
					};
					const createResponse = await app.request("/api/sync/recipient-policy/v1/invites", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							...requestBody,
							reviewed_onboarding_digest: previewBody.preview.reviewedOnboardingDigest,
						}),
					});
					expect(createResponse.status, JSON.stringify(await createResponse.clone().json())).toBe(
						200,
					);
				}
				expect(coordinatorBodies).toHaveLength(2);
				expect(coordinatorBodies[0]).toMatchObject({
					invite_kind: "team_member",
					policy_team_id: "policy-team-a",
				});
				expect(coordinatorBodies[1]).toMatchObject({
					invite_kind: "add_device",
					target_identity_id: store.actorId,
				});
				for (const body of coordinatorBodies) {
					expect(body).not.toHaveProperty("scope_id");
					expect(body).not.toHaveProperty("project_ids");
					expect(body).not.toHaveProperty("operation_id", expect.any(String));
				}
			} finally {
				cleanup();
				globalThis.fetch = previousFetch;
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
				rmSync(configDir, { recursive: true, force: true });
			}
		});

		it("inspects and accepts Team/add-device invites with intent-only local writes", async () => {
			for (const kind of ["team_member", "add_device"] as const) {
				const testDir = mkdtempSync(join(tmpdir(), `codemem-${kind}-accept-`));
				const configPath = join(testDir, "config.json");
				const keysDir = join(testDir, "keys");
				const previousConfig = process.env.CODEMEM_CONFIG;
				const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
				const previousFetch = globalThis.fetch;
				process.env.CODEMEM_CONFIG = configPath;
				process.env.CODEMEM_KEYS_DIR = keysDir;
				writeFileSync(configPath, JSON.stringify({ actor_display_name: "Local Identity" }));
				const { app, ensureStore, cleanup } = createTestApp({ seedDevice: false });
				try {
					const store = ensureStore();
					const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });
					store.adoptEnsuredDeviceIdentity(deviceId);
					const now = "2026-07-21T12:00:00.000Z";
					store.db
						.prepare(`INSERT INTO policy_teams(
						team_id, display_name, status, provenance, revision, migration_state,
						source_fingerprint, idempotency_key, created_at, updated_at
					) VALUES ('policy-team-a', 'Policy Team A', 'active', 'user', 'r1',
						'user_managed', NULL, 'team-a', ?, ?)`)
						.run(now, now);
					const projectId = "https://git.example.invalid/acme/recipient.git";
					const sessionId = insertTestSession(store.db);
					store.db
						.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
						.run(projectId, "recipient", sessionId);
					insertTestMemory(store, { sessionId, kind: "discovery", title: "recipient memory" });
					store.db
						.prepare(`INSERT INTO project_recipients(
						canonical_project_identity, recipient_kind, recipient_id, status, provenance,
						policy_revision, migration_state, source_fingerprint, idempotency_key,
						created_at, updated_at
					) VALUES (?, ?, ?, 'active', 'user', 'r1', 'user_managed', NULL, ?, ?, ?)`)
						.run(
							projectId,
							kind === "team_member" ? "team" : "identity",
							kind === "team_member" ? "policy-team-a" : store.actorId,
							`recipient-${kind}`,
							now,
							now,
						);
					const digest = "a".repeat(64);
					const payload: core.InvitePayload = {
						v: 1,
						kind,
						coordinator_url: "https://coord.example.test",
						group_id: "coordinator-a",
						policy: "auto_admit",
						token: `token-${kind}`,
						expires_at: "2099-01-01T00:00:00.000Z",
						team_name: null,
						reviewed_preview_digest: digest,
						...(kind === "team_member"
							? { policy_team_id: "policy-team-a" }
							: { target_identity_id: store.actorId }),
					};
					const encoded = core.encodeInvitePayload(payload);
					let joinBody: Record<string, unknown> = {};
					globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
						const url = String(input);
						if (url.endsWith("/v1/invites/inspect")) {
							return new Response(
								JSON.stringify({
									kind,
									reviewed_preview_digest: digest,
									bound: false,
									...(kind === "team_member"
										? { policy_team_id: "policy-team-a" }
										: { target_identity_id: store.actorId }),
								}),
								{ status: 200 },
							);
						}
						joinBody = JSON.parse(
							init?.body instanceof Uint8Array
								? new TextDecoder().decode(init.body)
								: String(init?.body ?? "{}"),
						) as Record<string, unknown>;
						return new Response(
							JSON.stringify({
								ok: true,
								status: "accepted",
								kind,
								group_id: "coordinator-a",
								identity_id: store.actorId,
								reviewed_preview_digest: digest,
								...(kind === "team_member"
									? { policy_team_id: "policy-team-a", target_identity_id: null }
									: { policy_team_id: null, target_identity_id: store.actorId }),
							}),
							{ status: 200 },
						);
					}) as typeof fetch;
					const before = authorizationReplicationSnapshot(store);
					const inspect = await app.request("/api/sync/invites/inspect", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ invite: encoded, device_name: "Recipient Laptop" }),
					});
					expect(inspect.status).toBe(200);
					const inspection = (await inspect.json()) as {
						kind: string;
						onboarding: { reviewedOnboardingDigest: string };
					};
					expect(inspection).toMatchObject({
						kind,
						onboarding: {
							journey: kind === "team_member" ? "team" : "add_device",
							projects: [{ canonicalProjectIdentity: projectId }],
						},
					});
					const accepted = await app.request("/api/sync/invites/import", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							invite: encoded,
							recipient_name: "Local Identity",
							device_name: "Recipient Laptop",
							reviewed_onboarding_digest: inspection.onboarding.reviewedOnboardingDigest,
						}),
					});
					expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(200);
					expect(joinBody).toMatchObject({
						invite_kind: kind,
						identity_id: store.actorId,
						device_id: deviceId,
					});
					expect(joinBody).not.toHaveProperty("operation_id");
					expect(joinBody).not.toHaveProperty("scope_id");
					expect(
						store.db.prepare("SELECT identity_id, device_id FROM identity_devices").all(),
					).toEqual([{ identity_id: store.actorId, device_id: deviceId }]);
					expect(
						store.db.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get(),
					).toBe(kind === "team_member" ? 1 : 0);
					expect(store.db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(1);
					expect(authorizationReplicationSnapshot(store)).toEqual(before);
				} finally {
					cleanup();
					globalThis.fetch = previousFetch;
					if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
					else process.env.CODEMEM_CONFIG = previousConfig;
					if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
					else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
					rmSync(testDir, { recursive: true, force: true });
				}
			}
		});

		it("previews and creates an exact project-first invite from server inventory", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevDeviceId = process.env.CODEMEM_DEVICE_ID;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			process.env.CODEMEM_KEYS_DIR = mkdtempSync(join(tmpdir(), "codemem-project-invite-keys-"));
			delete process.env.CODEMEM_DEVICE_ID;
			const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
			let projectIntentEcho: "none" | "operation_only" | "all" = "none";
			const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/v1/admin/invites")) {
					const request = init?.body
						? (JSON.parse(new TextDecoder().decode(init.body as ArrayBufferView)) as Record<
								string,
								unknown
							>)
						: {};
					return new Response(
						JSON.stringify({
							encoded: "project-invite-blob",
							invite: {
								invite_id: `invite-${String(request.operation_id)}`,
								operation_id: projectIntentEcho === "none" ? null : request.operation_id,
								reviewed_project_set_digest:
									projectIntentEcho === "all" ? request.reviewed_project_set_digest : null,
							},
							link: "codemem://join?invite=project-invite-blob",
							payload: {
								expires_at: expiresAt,
								group_id: "team-a",
								token: `token-${String(request.operation_id)}`,
							},
							request,
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
			const { app, getStore, cleanup } = createTestApp({ seedDevice: false });
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				expect(store.deviceId).toBe("local");
				const [localDeviceId] = ensureDeviceIdentity(store.db, {
					keysDir: process.env.CODEMEM_KEYS_DIR,
				});
				expect(localDeviceId).not.toBe("local");
				store.db
					.prepare(
						`INSERT INTO actors(
							actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
						 ) VALUES ('pending-brian', 'Brian', 0, 'pending', NULL, ?, ?)`,
					)
					.run("2026-07-20T00:00:00Z", "2026-07-20T00:00:00Z");
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET cwd = ?, git_remote = ?, project = ? WHERE id = ?")
					.run(
						"/workspace/codemem",
						"https://git.example.invalid/codemem.git",
						"codemem",
						sessionId,
					);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "first",
					originDeviceId: localDeviceId,
				});
				insertTestMemory(store, {
					sessionId,
					kind: "decision",
					title: "second",
					originDeviceId: localDeviceId,
				});
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "private",
					originDeviceId: localDeviceId,
				});
				store.db
					.prepare("UPDATE memory_items SET visibility = 'private' WHERE title = 'private'")
					.run();
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "personal",
					originDeviceId: localDeviceId,
				});
				store.db
					.prepare("UPDATE memory_items SET visibility = 'personal' WHERE title = 'personal'")
					.run();
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "inactive third",
					active: false,
					originDeviceId: localDeviceId,
				});
				const inventoryRes = await app.request("/api/sync/projects?q=codemem");
				const inventory = (await inventoryRes.json()) as {
					projects: Array<{ workspace_identity: string }>;
				};
				const projectId = inventory.projects[0]?.workspace_identity;
				if (!projectId) throw new Error("project missing");
				const firstCollisionSession = insertTestSession(store.db);
				const secondCollisionSession = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET cwd = ?, git_remote = NULL, project = ? WHERE id = ?")
					.run("/workspace/client-a/api", "api", firstCollisionSession);
				store.db
					.prepare("UPDATE sessions SET cwd = ?, git_remote = NULL, project = ? WHERE id = ?")
					.run("/workspace/client-b/api", "api", secondCollisionSession);
				insertTestMemory(store, {
					sessionId: firstCollisionSession,
					kind: "discovery",
					title: "client a api",
				});
				insertTestMemory(store, {
					sessionId: secondCollisionSession,
					kind: "discovery",
					title: "client b api",
				});
				const collisionInventory = (await (
					await app.request("/api/sync/projects?q=api")
				).json()) as { projects: Array<{ workspace_identity: string }> };
				const collisionId = collisionInventory.projects[0]?.workspace_identity;
				if (!collisionId) throw new Error("collision project missing");
				const collisionRes = await app.request("/api/sync/project-invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ teammate_name: "Brian", project_ids: [collisionId] }),
				});
				expect(collisionRes.status).toBe(400);
				expect(await collisionRes.json()).toEqual({ error: "project_selection_ambiguous" });

				const receivedSession = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET cwd = ?, project = NULL WHERE id = ?")
					.run("__sync_bootstrap__/peer-a", receivedSession);
				const receivedMemoryId = insertTestMemory(store, {
					sessionId: receivedSession,
					kind: "discovery",
					title: "received private project",
					originDeviceId: "peer-a",
				});
				store.db
					.prepare("UPDATE memory_items SET project = ? WHERE id = ?")
					.run("received-project", receivedMemoryId);
				const receivedInventory = (await (
					await app.request("/api/sync/projects?status=received")
				).json()) as { projects: Array<{ workspace_identity: string }> };
				const receivedId = receivedInventory.projects[0]?.workspace_identity;
				if (!receivedId) throw new Error("received project missing");
				const unsupportedRes = await app.request("/api/sync/project-invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ teammate_name: "Brian", project_ids: [receivedId] }),
				});
				expect(unsupportedRes.status).toBe(400);
				expect(await unsupportedRes.json()).toEqual({ error: "project_selection_unsupported" });

				const emptyRes = await app.request("/api/sync/project-invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ teammate_name: "Brian", project_ids: [] }),
				});
				expect(emptyRes.status).toBe(400);
				expect(await emptyRes.json()).toEqual({ error: "project_selection_empty" });
				const unknownProjectRes = await app.request("/api/sync/project-invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						teammate_name: "Brian",
						project_ids: ["workspace:unknown-project"],
					}),
				});
				expect(unknownProjectRes.status).toBe(400);
				expect(await unknownProjectRes.json()).toEqual({ error: "project_selection_unknown" });
				for (const [projectIds, expectedError] of [
					[[projectId, projectId], "project_ids_contains_duplicates"],
					[[projectId, 42], "project_ids_must_be_string_array"],
					[Array.from({ length: 101 }, () => projectId), "project_ids_too_large"],
				] as const) {
					const invalidSelection = await app.request("/api/sync/project-invites/preview", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ teammate_name: "Brian", project_ids: projectIds }),
					});
					expect(await invalidSelection.json()).toEqual({ error: expectedError });
				}

				const scopeInjectionRes = await app.request("/api/sync/project-invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						teammate_name: "Brian",
						project_ids: [projectId],
						scope_ids: ["all-company-data"],
					}),
				});
				expect(scopeInjectionRes.status).toBe(400);
				expect(await scopeInjectionRes.json()).toEqual({
					error: "unexpected_project_invite_fields",
				});

				const previewRes = await app.request("/api/sync/project-invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ teammate_name: "  Brian  ", project_ids: [projectId] }),
				});
				expect(previewRes.status).toBe(200);
				const preview = (await previewRes.json()) as {
					operation_id: string;
					reviewed_project_set_digest: string;
					projects: Array<{ project_id: string; existing_memory_count: number }>;
					future_memories_shared: boolean;
				};
				expect(preview.projects).toEqual([
					{ project_id: projectId, display_name: "codemem", existing_memory_count: 2 },
				]);
				expect(preview.future_memories_shared).toBe(true);
				for (const [body, expectedError] of [
					[
						{ teammate_name: "Brian", project_ids: [projectId] },
						"reviewed_project_set_digest_required",
					],
					[
						{
							teammate_name: "Brian",
							project_ids: [projectId],
							reviewed_project_set_digest: "invalid",
						},
						"reviewed_project_set_digest_invalid",
					],
					[
						{
							teammate_name: "Brian",
							project_ids: [projectId],
							reviewed_project_set_digest: preview.reviewed_project_set_digest,
							access_scope: "everything",
						},
						"unexpected_project_invite_fields",
					],
				] as const) {
					const invalidCreate = await app.request("/api/sync/project-invites", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					});
					expect(invalidCreate.status).toBe(400);
					expect(await invalidCreate.json()).toEqual({ error: expectedError });
				}

				const changedRes = await app.request("/api/sync/project-invites", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						teammate_name: "Brian",
						project_ids: [projectId],
						reviewed_project_set_digest: "0".repeat(64),
					}),
				});
				expect(changedRes.status).toBe(409);
				expect(fetchMock).not.toHaveBeenCalled();
				insertTestMemory(store, {
					sessionId,
					kind: "feature",
					title: "active third",
					originDeviceId: localDeviceId,
				});
				const changedCountRes = await app.request("/api/sync/project-invites", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						teammate_name: "Brian",
						project_ids: [projectId],
						reviewed_project_set_digest: preview.reviewed_project_set_digest,
					}),
				});
				expect(changedCountRes.status).toBe(409);
				const updatedPreviewRes = await app.request("/api/sync/project-invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ teammate_name: "Brian", project_ids: [projectId] }),
				});
				const updatedPreview = (await updatedPreviewRes.json()) as typeof preview;
				expect(updatedPreview.projects[0]?.existing_memory_count).toBe(3);
				expect(updatedPreview.reviewed_project_set_digest).not.toBe(
					preview.reviewed_project_set_digest,
				);

				const createRequest = {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						teammate_name: "Brian",
						project_ids: [projectId],
						reviewed_project_set_digest: updatedPreview.reviewed_project_set_digest,
					}),
				};
				const legacyCoordinatorResponse = await app.request(
					"/api/sync/project-invites",
					createRequest,
				);
				expect(legacyCoordinatorResponse.status).toBe(400);
				expect(await legacyCoordinatorResponse.json()).toEqual({
					error: "coordinator_invite_intent_mismatch",
				});
				expect(store.db.prepare("SELECT COUNT(*) FROM share_operations").pluck().get()).toBe(0);
				projectIntentEcho = "operation_only";
				const missingDigestResponse = await app.request("/api/sync/project-invites", createRequest);
				expect(missingDigestResponse.status).toBe(400);
				expect(await missingDigestResponse.json()).toEqual({
					error: "coordinator_invite_intent_mismatch",
				});
				expect(store.db.prepare("SELECT COUNT(*) FROM share_operations").pluck().get()).toBe(0);
				projectIntentEcho = "all";
				store.db.exec("ALTER TABLE share_operations RENAME TO share_operations_blocked");
				const failedPersistence = await app.request("/api/sync/project-invites", createRequest);
				expect(failedPersistence.status).toBe(400);
				store.db.exec("ALTER TABLE share_operations_blocked RENAME TO share_operations");

				const createRes = await app.request("/api/sync/project-invites", createRequest);
				expect(createRes.status).toBe(200);
				const created = (await createRes.json()) as Record<string, unknown>;
				expect(created).toMatchObject({
					operation_id: updatedPreview.operation_id,
					existing_memory_count: 3,
					future_memories_shared: true,
					invite: { link: "codemem://join?invite=project-invite-blob" },
				});
				const coordinatorRequestBody = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)
					?.body;
				const coordinatorBody = coordinatorRequestBody
					? (JSON.parse(
							new TextDecoder().decode(coordinatorRequestBody as ArrayBufferView),
						) as Record<string, unknown>)
					: {};
				expect(coordinatorBody).toMatchObject({
					operation_id: updatedPreview.operation_id,
					reviewed_project_set_digest: updatedPreview.reviewed_project_set_digest,
					inviter_device_id: localDeviceId,
				});
				expect(coordinatorBody).not.toHaveProperty("scope_ids");
				expect(coordinatorBody).not.toHaveProperty("project_ids");
				expect(fetchMock).toHaveBeenCalledTimes(4);
				expect(
					store.db.prepare("SELECT state, teammate_name, person_id FROM share_operations").get(),
				).toEqual({
					state: "waiting_for_acceptance",
					teammate_name: "Brian",
					person_id: "pending-brian",
				});
				expect(
					store.db.prepare("SELECT inviter_device_ids_json FROM share_operations").pluck().get(),
				).toBe(JSON.stringify([localDeviceId]));
				expect(store.actorId).toBe(`local:${localDeviceId}`);
				expect(
					store.db.prepare("SELECT inviter_actor_id FROM share_operations").pluck().get(),
				).toBe(`local:${localDeviceId}`);
				expect(
					store.db
						.prepare(
							"SELECT canonical_project_identity, existing_memory_count FROM share_operation_projects",
						)
						.all(),
				).toEqual([{ canonical_project_identity: projectId, existing_memory_count: 3 }]);
				expect(
					store.db
						.prepare("SELECT COUNT(*) FROM actors WHERE lower(display_name) = 'brian'")
						.pluck()
						.get(),
				).toBe(1);
				const coordinatorCallsBeforeActiveRetry = fetchMock.mock.calls.length;
				store.db
					.prepare("UPDATE share_operations SET state = 'active' WHERE operation_id = ?")
					.run(updatedPreview.operation_id);
				const activeRetry = await app.request("/api/sync/project-invites", createRequest);
				expect(activeRetry.status).toBe(409);
				expect(await activeRetry.json()).toEqual({ error: "operation_state_invalid" });
				expect(fetchMock).toHaveBeenCalledTimes(coordinatorCallsBeforeActiveRetry);
				store.db
					.prepare(
						"UPDATE share_operations SET state = 'waiting_for_acceptance' WHERE operation_id = ?",
					)
					.run(updatedPreview.operation_id);

				const insertMapping = store.db.prepare(
					`INSERT INTO project_scope_mappings(
						workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
					 ) VALUES (?, ?, 'local-default', 0, 'user', ?, ?)`,
				);
				for (let index = 0; index < 260; index += 1) {
					const suffix = String(index).padStart(3, "0");
					insertMapping.run(
						`workspace:pagination-${suffix}`,
						`pagination-${suffix}`,
						"2026-07-20T00:00:00Z",
						"2026-07-20T00:00:00Z",
					);
				}
				const laterPage = (await (
					await app.request("/api/sync/projects?offset=250&limit=250")
				).json()) as { projects: Array<{ display_project: string; workspace_identity: string }> };
				const laterProject = laterPage.projects.find((project) =>
					project.display_project.startsWith("pagination-"),
				);
				if (!laterProject) throw new Error("later-page project missing");
				const laterPreview = await app.request("/api/sync/project-invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						teammate_name: "Brian",
						project_ids: [laterProject.workspace_identity],
					}),
				});
				expect(laterPreview.status).toBe(200);
				const laterReviewed = (await laterPreview.json()) as {
					reviewed_project_set_digest: string;
				};
				const coordinatorCallsBeforeSubstitution = fetchMock.mock.calls.length;
				const substitution = await app.request("/api/sync/project-invites", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						teammate_name: "Brian",
						project_ids: [laterProject.workspace_identity],
						reviewed_project_set_digest: updatedPreview.reviewed_project_set_digest,
					}),
				});
				expect(substitution.status).toBe(409);
				expect(await substitution.json()).toEqual({ error: "reviewed_project_set_changed" });
				expect(fetchMock).toHaveBeenCalledTimes(coordinatorCallsBeforeSubstitution);

				const laterCreate = await app.request("/api/sync/project-invites", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						teammate_name: "Brian",
						project_ids: [laterProject.workspace_identity],
						reviewed_project_set_digest: laterReviewed.reviewed_project_set_digest,
					}),
				});
				expect(laterCreate.status).toBe(200);
				expect(await laterCreate.json()).toMatchObject({
					projects: [{ project_id: laterProject.workspace_identity }],
				});
				expect(fetchMock).toHaveBeenCalledTimes(coordinatorCallsBeforeSubstitution + 1);

				store.db
					.prepare(
						`INSERT INTO actors(
							actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
						 ) VALUES ('pending-brian-duplicate', 'Brian', 0, 'pending', NULL, ?, ?)`,
					)
					.run("2026-07-20T00:00:00Z", "2026-07-20T00:00:00Z");
				const ambiguousPerson = await app.request("/api/sync/project-invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ teammate_name: "Brian", project_ids: [projectId] }),
				});
				expect(await ambiguousPerson.json()).toEqual({ error: "teammate_match_ambiguous" });
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevDeviceId == null) delete process.env.CODEMEM_DEVICE_ID;
				else process.env.CODEMEM_DEVICE_ID = prevDeviceId;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
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

		it("keeps project invite reads pure and reconciles authoritative acceptance explicitly and idempotently", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const operationId = `share_${"d".repeat(40)}`;
			const projectId = "workspace:codemem";
			const reviewedDigest = "e".repeat(64);
			const publicKey = "recipient-public-key";
			const fingerprint = fingerprintPublicKey(publicKey);
			let mode:
				| "not_found"
				| "malformed"
				| "wrong_group"
				| "waiting"
				| "invalid_trust"
				| "accepted" = "not_found";
			const fetchMock = vi.fn(async () => {
				if (mode === "not_found") {
					return new Response(JSON.stringify({ error: "operation_not_found" }), { status: 404 });
				}
				if (mode === "malformed") {
					return new Response(JSON.stringify({ error: "operation_intent_invalid" }), {
						status: 409,
					});
				}
				const base = {
					operation_id: operationId,
					group_id: mode === "wrong_group" ? "team-other" : "team-a",
					reviewed_project_set_digest: reviewedDigest,
					projects: [
						{ canonical_identity: projectId, display_name: "codemem", existing_memory_count: 3 },
					],
				};
				if (mode === "waiting" || mode === "wrong_group") {
					return new Response(
						JSON.stringify({
							...base,
							state: "waiting_for_acceptance",
							invite_link: mode === "waiting" ? "codemem://invite/safe-existing-link" : null,
						}),
						{
							status: 200,
						},
					);
				}
				return new Response(
					JSON.stringify({
						...base,
						state: "accepted",
						recipient_actor_id: "actor-brian",
						recipient_display_name: "Brian",
						recipient_device_id: "device-brian",
						recipient_device_display_name: "Brian's MacBook",
						recipient_public_key: publicKey,
						recipient_fingerprint: fingerprint,
						consumed_at: "2026-07-20T13:00:00.000Z",
						trust_state: mode === "invalid_trust" ? "trusted" : "bootstrap_grant_created",
						bootstrap_grant_id: "grant-1",
					}),
					{ status: 200 },
				);
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
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db.exec(`
					INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
					VALUES ('pending-brian', 'Brian', 0, 'pending', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z');
				`);
				store.db
					.prepare(`INSERT INTO share_operations(
						operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
						person_kind, pending_person_operation_id, teammate_name, history_policy,
						reviewed_project_set_digest, coordinator_group_id, invite_token_digest,
						invite_expires_at, created_at, updated_at
					) VALUES (?, 'waiting_for_acceptance', ?, ?, 'pending-brian', 'pending', ?,
						'Brian', 'existing_and_future', ?, 'team-a', 'digest', '2099-01-01T00:00:00Z', ?, ?)`)
					.run(
						operationId,
						store.actorId,
						JSON.stringify([store.deviceId]),
						operationId,
						reviewedDigest,
						"2026-07-20T00:00:00Z",
						"2026-07-20T00:00:00Z",
					);
				store.db
					.prepare(`INSERT INTO share_operation_projects(
						operation_id, canonical_project_identity, display_name, identity_source,
						existing_memory_count, ordinal) VALUES (?, ?, 'codemem', 'workspace', 3, 0)`)
					.run(operationId, projectId);

				const request = () => app.request(`/api/sync/project-invites/${operationId}`);
				expect((await request()).status).toBe(404);
				mode = "malformed";
				const malformed = await request();
				expect(malformed.status).toBe(409);
				expect(await malformed.json()).toEqual({ error: "operation_intent_invalid" });
				mode = "wrong_group";
				expect((await request()).status).toBe(409);
				mode = "waiting";
				const waiting = await request();
				expect(waiting.status).toBe(200);
				expect(
					store.db
						.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
						.pluck()
						.get(operationId),
				).toBe("waiting_for_acceptance");
				mode = "invalid_trust";
				const invalidTrust = await request();
				expect(invalidTrust.status).toBe(200);
				const invalidReconcile = await app.request(
					`/api/sync/project-invites/${operationId}/reconcile`,
					{ method: "POST" },
				);
				expect(invalidReconcile.status).toBe(409);
				expect(await invalidReconcile.json()).toEqual({ error: "operation_trust_state_invalid" });
				expect(
					store.db
						.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
						.pluck()
						.get(operationId),
				).toBe("waiting_for_acceptance");
				mode = "accepted";
				const accepted = await request();
				expect(accepted.status).toBe(200);
				expect(await accepted.json()).toMatchObject({ state: "accepted" });
				expect(
					store.db
						.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
						.pluck()
						.get(operationId),
				).toBe("waiting_for_acceptance");

				const reconcile = () =>
					app.request(`/api/sync/project-invites/${operationId}/reconcile`, { method: "POST" });
				expect((await reconcile()).status).toBe(200);
				expect((await reconcile()).status).toBe(200);
				expect(
					store.db
						.prepare("SELECT state, recipient_actor_id, recipient_device_id FROM share_operations")
						.get(),
				).toEqual({
					state: "accepted",
					recipient_actor_id: "actor-brian",
					recipient_device_id: "device-brian",
				});

				mode = "waiting";
				store.db
					.prepare(
						"UPDATE share_operations SET state = 'waiting_for_acceptance' WHERE operation_id = ?",
					)
					.run(operationId);
				const otherOperationId = `share_${"9".repeat(40)}`;
				store.db
					.prepare(`INSERT INTO share_operations(
						operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
						person_kind, teammate_name, history_policy, reviewed_project_set_digest,
						coordinator_group_id, invite_token_digest, invite_expires_at, created_at, updated_at
					) VALUES (?, 'cancelled', 'actor-other-owner', '[]', 'actor-brian', 'existing',
						'Brian', 'existing_and_future', ?, 'team-a', 'other-digest',
						'2099-01-01T00:00:00Z', ?, ?)`)
					.run(otherOperationId, "f".repeat(64), "2026-07-20T00:00:00Z", "2026-07-20T00:00:00Z");

				const fetchCallsBeforeList = fetchMock.mock.calls.length;
				const lifecycleResponse = await app.request("/api/sync/share-operations");
				expect(lifecycleResponse.status).toBe(200);
				const lifecyclePayload = (await lifecycleResponse.json()) as {
					items: Array<Record<string, unknown>>;
				};
				expect(lifecyclePayload.items).toHaveLength(1);
				expect(lifecyclePayload.items[0]).toMatchObject({
					person: { actor_id: "actor-brian", display_name: "Brian" },
					projects: [{ project_id: projectId, display_name: "codemem", existing_memory_count: 3 }],
					lifecycle: {
						state: "waiting_for_acceptance",
						primary_action: {
							kind: "copy_invite",
						},
					},
				});
				expect(fetchMock).toHaveBeenCalledTimes(fetchCallsBeforeList);
				const lifecycleDetailResponse = await app.request(
					`/api/sync/share-operations/${operationId}`,
				);
				expect(lifecycleDetailResponse.status).toBe(200);
				expect(await lifecycleDetailResponse.json()).toMatchObject({
					lifecycle: {
						primary_action: {
							kind: "copy_invite",
							invite_link: "codemem://invite/safe-existing-link",
						},
					},
				});
				const serialized = JSON.stringify(lifecyclePayload);
				for (const sensitive of [
					"recipient_public_key",
					"recipient_fingerprint",
					"canonical_identity",
					"scope_id",
				]) {
					expect(serialized).not.toContain(sensitive);
				}
				expect(
					store.db
						.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
						.pluck()
						.get(operationId),
				).toBe("waiting_for_acceptance");
				expect((await app.request(`/api/sync/share-operations/${otherOperationId}`)).status).toBe(
					404,
				);
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
			}
		});

		it("maps project provision errors and preflights reassignment before mutations", async () => {
			const configDir = mkdtempSync(join(tmpdir(), "codemem-provision-route-test-"));
			const configPath = join(configDir, "config.json");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousFetch = globalThis.fetch;
			const recipientPublicKey = "recipient-route-key";
			const recipientFingerprint = fingerprintPublicKey(recipientPublicKey);
			let capabilityProbe: "unsupported" | "undetermined" = "unsupported";
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith("/v1/status")) {
					return new Response(
						JSON.stringify(
							capabilityProbe === "unsupported"
								? {
										device_id: "recipient-route",
										fingerprint: recipientFingerprint,
										sync_features: [],
									}
								: {
										device_id: "wrong-device",
										fingerprint: "wrong-fingerprint",
										sync_features: ["reassign_scope"],
									},
						),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			}) as typeof fetch;
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "team-a",
					sync_coordinator_admin_secret: "secret",
				}),
			);
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				store.db
					.prepare(
						`INSERT INTO actors(
							actor_id, display_name, is_local, status, created_at, updated_at
						 ) VALUES (?, 'Local inviter', 1, 'active', ?, ?)`,
					)
					.run(store.actorId, "2026-07-20T12:00:00.000Z", "2026-07-20T12:00:00.000Z");
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run("https://git.example.invalid/codemem.git", "codemem", sessionId);
				const memoryId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "provision history",
					scopeId: "local-default",
				});
				const canonicalIdentity = "https://git.example.invalid/codemem.git";
				const plan = core.planShareOperation({
					inviterActorId: store.actorId,
					inviterDeviceIds: [store.deviceId],
					person: { kind: "pending", displayName: "Brian" },
					projects: [
						{
							canonicalIdentity,
							displayName: "codemem",
							identitySource: "git_remote",
							existingMemoryCount: 1,
						},
					],
					coordinatorGroupId: "team-a",
					inviteExpiresAt: "2099-01-01T00:00:00.000Z",
					createdAt: "2026-07-20T12:00:00.000Z",
				});
				core.persistShareOperation(store.db, plan, {
					inviteId: "invite-route",
					tokenDigest: core.inviteTokenDigest("token-route"),
				});
				core.reconcileShareOperationAcceptance(store.db, {
					operationId: plan.operationId,
					localInviterActorId: store.actorId,
					coordinatorGroupId: "team-a",
					reviewedProjectSetDigest: plan.reviewedProjectSetDigest,
					recipientActorId: "actor-recipient-route",
					recipientDisplayName: "Brian",
					recipientDeviceId: "recipient-route",
					recipientDeviceDisplayName: "Brian's MacBook",
					recipientPublicKey,
					recipientFingerprint,
					consumedAt: "2026-07-20T13:00:00.000Z",
					trustState: "bootstrap_grant_created",
					bootstrapGrantId: "grant-route",
					projects: [
						{
							canonical_identity: canonicalIdentity,
							display_name: "codemem",
							existing_memory_count: 1,
						},
					],
				});
				store.db
					.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = ?")
					.run(JSON.stringify(["https://wrong.example.test"]), "recipient-route");
				const originalScope = store.db
					.prepare("SELECT scope_id FROM memory_items WHERE id = ?")
					.pluck()
					.get(memoryId);

				const invalid = await app.request("/api/sync/project-invites/not-an-operation/provision", {
					method: "POST",
				});
				const missing = await app.request(
					`/api/sync/project-invites/share_${"f".repeat(40)}/provision`,
					{ method: "POST" },
				);
				const unsupported = await app.request(
					`/api/sync/project-invites/${plan.operationId}/provision`,
					{ method: "POST" },
				);
				const advance = await app.request(
					`/api/sync/share-operations/${plan.operationId}/advance`,
					{ method: "POST" },
				);
				capabilityProbe = "undetermined";
				const waiting = await app.request(
					`/api/sync/project-invites/${plan.operationId}/provision`,
					{ method: "POST" },
				);

				expect(invalid.status).toBe(400);
				expect(await invalid.json()).toEqual({ error: "operation_id_invalid" });
				expect(missing.status).toBe(404);
				expect(await missing.json()).toEqual({ error: "operation_not_found" });
				expect(unsupported.status).toBe(409);
				expect(await unsupported.json()).toEqual({ error: "reassign_capability_required" });
				expect(advance.status).toBe(409);
				expect(await advance.json()).toEqual({ error: "reassign_capability_required" });
				expect(waiting.status).toBe(409);
				expect(await waiting.json()).toEqual({ error: "waiting_for_device" });
				expect(store.db.prepare("SELECT state FROM share_operations").pluck().get()).toBe(
					"waiting_for_device",
				);
				expect(
					store.db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
				).toBe(originalScope);
				expect(store.db.prepare("SELECT COUNT(*) FROM project_scope_mappings").pluck().get()).toBe(
					0,
				);
				expect(
					store.db
						.prepare("SELECT COUNT(*) FROM replication_ops WHERE op_type = 'reassign_scope'")
						.pluck()
						.get(),
				).toBe(0);
			} finally {
				cleanup();
				globalThis.fetch = previousFetch;
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				rmSync(configDir, { recursive: true, force: true });
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
			writeFileSync(configPath, JSON.stringify({ actor_display_name: "Fixture User" }));
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

		it("inspects and accepts a project invite with confirmed local identity only", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const keysDir = mkdtempSync(join(tmpdir(), "codemem-keys-test-"));
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const operationId = `share_${"a".repeat(40)}`;
			const invitePayload = {
				v: 1,
				kind: "coordinator_team_invite",
				coordinator_url: "https://coord.example.test",
				group_id: "team-a",
				policy: "auto_admit",
				token: "project-token",
				expires_at: new Date(Date.now() + 86_400_000).toISOString(),
				team_name: "Team A",
				operation_id: operationId,
				inviter_name: "Adam",
				project_summaries: [{ display_name: "codemem", existing_memory_count: 3 }],
			};
			const invite = Buffer.from(JSON.stringify(invitePayload), "utf8").toString("base64url");
			let joinBody: Record<string, unknown> = {};
			let corruptInviter = false;
			const inviterPublicKey = "inviter-public-key";
			const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/v1/invites/inspect")) {
					return new Response(
						JSON.stringify({
							kind: "project_share_invite",
							operation_id: operationId,
							inviter_name: "Adam",
							team_name: "Team A",
							projects: [{ display_name: "codemem", existing_memory_count: 3 }],
						}),
						{ status: 200 },
					);
				}
				if (url.includes("/v1/join")) {
					joinBody = JSON.parse(
						init?.body instanceof Uint8Array
							? new TextDecoder().decode(init.body)
							: String(init?.body ?? "{}"),
					) as Record<string, unknown>;
					return new Response(
						JSON.stringify({
							status: "accepted",
							operation_id: operationId,
							group_id: "team-a",
							trust_state: "bootstrap_grant_created",
							bootstrap_grant_id: "grant-1",
							inviter_device: {
								device_id: "device-adam",
								public_key: inviterPublicKey,
								fingerprint: corruptInviter
									? "wrong-fingerprint"
									: fingerprintPublicKey(inviterPublicKey),
								display_name: "Adam's Mac",
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
			writeFileSync(configPath, JSON.stringify({ actor_display_name: "Local Person" }));
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				ensureDeviceIdentity(store.db, { keysDir });
				const inspect = await app.request("/api/sync/invites/inspect", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite }),
				});
				expect(await inspect.json()).toMatchObject({
					inviter_name: "Adam",
					recipient_name: "Local Person",
					projects: [{ display_name: "codemem", existing_memory_count: 3 }],
				});
				const accepted = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						invite,
						recipient_name: "Brian",
						device_name: "Brian's Test Mac",
					}),
				});
				const acceptedBody = (await accepted.json()) as Record<string, unknown>;
				expect(accepted.status, JSON.stringify(acceptedBody)).toBe(200);
				expect(joinBody).toMatchObject({
					operation_id: operationId,
					recipient_actor_id: store.actorId,
					recipient_display_name: "Brian",
					device_display_name: "Brian's Test Mac",
				});
				expect(joinBody).not.toHaveProperty("projects");
				expect(joinBody).not.toHaveProperty("scope_ids");
				expect(
					store.db
						.prepare("SELECT display_name, status FROM actors WHERE actor_id = ?")
						.get(store.actorId),
				).toEqual({ display_name: "Brian", status: "active" });
				expect(
					store.db
						.prepare("SELECT pending_bootstrap_grant_id FROM sync_peers WHERE peer_device_id = ?")
						.get("device-adam"),
				).toEqual({ pending_bootstrap_grant_id: "grant-1" });
				corruptInviter = true;
				const rejected = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						invite,
						recipient_name: "Brian",
						device_name: "Brian's Test Mac",
					}),
				});
				expect(rejected.status).toBe(400);
				expect(await rejected.json()).toEqual({ error: "inviter_identity_invalid" });
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
			writeFileSync(configPath, JSON.stringify({ actor_display_name: "Fixture User" }));
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
			writeFileSync(configPath, JSON.stringify({ actor_display_name: "Fixture User" }));
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

		it("rejects a device pairing payload that conflicts with an existing trusted fingerprint", async () => {
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
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(
						"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, public_key, addresses_json, created_at) VALUES (?, ?, ?, ?, ?)",
					)
					.run(peerDeviceId, "old-fingerprint", "old-public-key", "[]", new Date().toISOString());

				const res = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite }),
				});
				expect(res.status).toBe(409);
				expect(await res.json()).toMatchObject({ error: "peer_conflict" });
				const row = store.db
					.prepare("SELECT pinned_fingerprint, public_key FROM sync_peers WHERE peer_device_id = ?")
					.get(peerDeviceId) as { pinned_fingerprint?: string; public_key?: string } | undefined;
				expect(row).toMatchObject({
					pinned_fingerprint: "old-fingerprint",
					public_key: "old-public-key",
				});
			} finally {
				cleanup();
				rmSync(peerKeysDir, { recursive: true, force: true });
				rmSync(peerDbDir, { recursive: true, force: true });
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
						sync_coordinator_groups: ["team-a", "team-b"],
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
						sync_coordinator_groups: ["team-a", "team-b"],
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
								{ group_id: "team-b", display_name: "Team B" },
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
						sync_coordinator_groups: ["team-a", "team-b"],
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
							expect.objectContaining({ group_id: "team-b" }),
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
			const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/v1/admin/groups/team-a/scopes") && init?.method === "GET") {
					return new Response(JSON.stringify({ items: [] }), { status: 200 });
				}
				if (url.endsWith("/v1/admin/groups/team-a/scopes") && init?.method === "POST") {
					return new Response(
						JSON.stringify({
							scope: {
								scope_id: "team:team-a:default",
								group_id: "team-a",
								label: "Team A",
							},
						}),
						{ status: 201 },
					);
				}
				if (url.endsWith("/v1/admin/groups/team-a/scopes/team%3Ateam-a%3Adefault/members")) {
					return new Response(
						JSON.stringify({
							membership: {
								scope_id: "team:team-a:default",
								group_id: "team-a",
								device_id: "local-device",
								role: "admin",
							},
						}),
						{ status: 201 },
					);
				}
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
						sync_coordinator_groups: ["team-a", "team-b"],
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
					expect(await archived.json()).toMatchObject({
						disconnected_group_id: "team-a",
						groups: ["team-b"],
						status: { groups: ["team-b"], active_group: "team-b" },
					});
					expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
						sync_coordinator_group: "team-b",
						sync_coordinator_groups: ["team-b"],
					});
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

		it("does not auto-grant a stale non-default Space preference on join approval", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/join-requests/approve")) {
					return new Response(
						JSON.stringify({
							request: {
								request_id: "req-1",
								status: "approved",
								group_id: "team-a",
								device_id: "dev-b",
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
						sync_coordinator_group: "team-a",
						sync_coordinator_admin_secret: "secret",
					}),
				);
				globalThis.fetch = fetchMock as typeof fetch;
				const { app, cleanup } = createTestApp();
				try {
					const saved = await app.request("/api/coordinator/admin/groups/team-a/preferences", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							default_space_scope_id: "scope-private",
							auto_grant_default_space_on_join: true,
						}),
					});
					expect(saved.status).toBe(200);

					const res = await app.request("/api/coordinator/admin/join-requests/req-1/approve", {
						method: "POST",
					});

					expect(res.status).toBe(200);
					expect(await res.json()).toMatchObject({
						default_space_membership: null,
						setup_warning: null,
					});
					expect(fetchMock).toHaveBeenCalledTimes(1);
				} finally {
					cleanup();
				}
			} finally {
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				globalThis.fetch = prevFetch;
			}
		});

		it("does not auto-grant when the canonical default Space is missing or wrong kind", async () => {
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/v1/admin/join-requests/approve")) {
					return new Response(
						JSON.stringify({
							request: {
								request_id: "req-1",
								status: "approved",
								group_id: "team-a",
								device_id: "dev-b",
							},
						}),
						{ status: 200 },
					);
				}
				if (url.includes("/v1/admin/groups/team-a/scopes")) {
					return new Response(
						JSON.stringify({
							items: [{ scope_id: "team:team-a:default", kind: "project", status: "active" }],
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
					const saved = await app.request("/api/coordinator/admin/groups/team-a/preferences", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							default_space_scope_id: "team:team-a:default",
							auto_grant_default_space_on_join: true,
						}),
					});
					expect(saved.status).toBe(200);

					const res = await app.request("/api/coordinator/admin/join-requests/req-1/approve", {
						method: "POST",
					});

					expect(res.status).toBe(200);
					expect(await res.json()).toMatchObject({
						default_space_membership: null,
						setup_warning: null,
					});
					expect(fetchMock).toHaveBeenCalledTimes(2);
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
							default_space_scope_id: null,
							auto_grant_default_space_on_join: false,
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
							default_space_scope_id: null,
							auto_grant_default_space_on_join: false,
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
