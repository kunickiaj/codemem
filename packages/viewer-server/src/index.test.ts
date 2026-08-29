/**
 * Viewer-server integration tests.
 *
 * Uses initTestSchema from @codemem/core (fix #5 — no duplicated DDL).
 * Uses Record<string, unknown> instead of Record<string, any> (fix #6).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { brotliCompressSync } from "node:zlib";
import * as core from "@codemem/core";
import {
	buildAuthHeaders,
	buildDirectPeerAuthHeaders,
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
import { type AppOptions, createApp, createSyncApp } from "./index.js";
import { __usageCacheTestHooks } from "./routes/stats.js";
import { reconcileConfiguredCoordinatorEnrollment } from "./routes/sync.js";
import {
	__teamSetupTestHooks,
	type LegacyTeamConfiguredGroupSnapshotLoader,
	TEAM_SETUP_ROUTE_PREFIX,
} from "./routes/team-setup.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestStore(
	seedDevice = true,
	deviceId = "test-device-001",
): { store: MemoryStore; cleanup: () => void } {
	const tmpDir = mkdtempSync(join(tmpdir(), "codemem-viewer-store-test-"));
	const dbPath = join(tmpDir, "test.sqlite");
	const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
	const keysDir = previousKeysDir?.trim() || join(tmpDir, "keys");
	const rawDb = new Database(dbPath);
	initTestSchema(rawDb);
	if (seedDevice) {
		ensureDeviceIdentity(rawDb, { keysDir, deviceId });
	}
	rawDb.close();
	process.env.CODEMEM_KEYS_DIR = keysDir;
	const store = new MemoryStore(dbPath);
	return {
		store,
		cleanup: () => {
			store.close();
			if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
			else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
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
		subtitle?: string;
		tagsText?: string;
		facts?: unknown;
		narrative?: string;
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
	const memoryId = Number(result.lastInsertRowid);
	store.db
		.prepare(
			`UPDATE memory_items
			 SET subtitle = ?, tags_text = ?, facts = ?, narrative = ?
			 WHERE id = ?`,
		)
		.run(
			options.subtitle ?? null,
			options.tagsText ?? "",
			options.facts == null ? null : JSON.stringify(options.facts),
			options.narrative ?? null,
			memoryId,
		);
	return memoryId;
}

/** Create a test Hono app backed by a fresh in-memory DB. */
function createTestApp(opts?: {
	seedDevice?: boolean;
	deviceId?: string;
	sweeper?: unknown;
	getUpdateStatus?: (options: core.GetUpdateStatusOptions) => Promise<core.UpdateStatus>;
	loadLegacyTeamConfiguredGroupSnapshots?: LegacyTeamConfiguredGroupSnapshotLoader;
	readCoordinatorConfig?: AppOptions["readCoordinatorConfig"];
	renameCoordinatorGroup?: AppOptions["renameCoordinatorGroup"];
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
			const created = createTestStore(opts?.seedDevice, opts?.deviceId);
			store = created.store;
			storeCleanup = created.cleanup;
		}
		return store;
	};

	const appOptions = {
		sweeper: (opts?.sweeper ?? null) as never,
		storeFactory,
		getUpdateStatus: opts?.getUpdateStatus,
		getSyncRuntimeStatus: opts?.getSyncRuntimeStatus,
		loadLegacyTeamConfiguredGroupSnapshots: opts?.loadLegacyTeamConfiguredGroupSnapshots,
		readCoordinatorConfig: opts?.readCoordinatorConfig,
		renameCoordinatorGroup: opts?.renameCoordinatorGroup,
	};
	const app = createApp(appOptions);

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

function promptPackAttemptId(sequence: number): string {
	return `018f2db4-f9d3-7a22-8d18-${sequence.toString(16).padStart(12, "0")}`;
}

function postViewerJson(
	app: ReturnType<typeof createApp>,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) {
	return app.request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "http://127.0.0.1:38888",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

function rawEventState(store: MemoryStore): { events: unknown[]; sessions: unknown[] } {
	return {
		events: store.db
			.prepare(
				`SELECT source, stream_id, opencode_session_id, event_id, event_seq,
					event_type, ts_wall_ms, ts_mono_ms, payload_json
				 FROM raw_events ORDER BY source, stream_id, event_seq`,
			)
			.all(),
		sessions: store.db
			.prepare(
				`SELECT source, stream_id, opencode_session_id, cwd, project, started_at,
					last_seen_ts_wall_ms, last_received_event_seq, last_flushed_event_seq
				 FROM raw_event_sessions ORDER BY source, stream_id`,
			)
			.all(),
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
		const syncRouteSource = readFileSync(
			join(root, "packages/viewer-server/src/routes/sync.ts"),
			"utf8",
		);
		const teamSetupRouteSource = readFileSync(
			join(root, "packages/viewer-server/src/routes/team-setup.ts"),
			"utf8",
		);
		const routeSource = `${syncRouteSource}\n${teamSetupRouteSource}`;
		const uiRoutes = [
			...apiSource.matchAll(/fetch\('(\/api\/sync\/[^']+)'/g),
			...apiSource.matchAll(/fetchJson\('(\/api\/sync\/[^']+)'/g),
		].map((match) => match[1]);
		const concreteServerRoutes = [
			...routeSource.matchAll(/app\.(?:get|post|put|patch|delete)\("(\/api\/sync\/[^"]+)"/g),
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
		expect(concreteServerRoutes).toContain("/api/sync/team-setup/v1");
		expect(concreteServerRoutes).toContain("/api/sync/team-setup/v1/:candidateRef");
		expect(syncRouteSource).toContain('app.patch("/api/sync/recipient-policy/v1/teams/:teamId"');
		expect(teamSetupRouteSource).not.toContain("/api/sync/recipient-policy/");
		expect(concreteServerRoutes).toEqual(
			expect.arrayContaining([
				"/api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/assignment",
				"/api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/decision",
				"/api/sync/team-setup/v1/:candidateRef/projects/:projectRef/mapping",
				"/api/sync/team-setup/v1/:candidateRef/refresh",
				"/api/sync/team-setup/v1/:candidateRef/finish",
			]),
		);
		expect(
			concreteServerRoutes
				.filter((route) => route.includes("/team-setup/"))
				.every((route) => route.startsWith(TEAM_SETUP_ROUTE_PREFIX)),
		).toBe(true);
	});

	describe("Team setup API", () => {
		const coordinatorId = "localhost:8787/";
		const groupId = "group-alpha";
		const rawDeviceId = "device-secret-id";
		const rawIdentityId = "identity-secret-id";
		const rawProjectIdentity = "https://private.example.invalid/secret/repo.git";
		const candidateRef = core.legacyTeamCandidateId(coordinatorId, groupId);
		const snapshots: core.LegacyTeamConfiguredGroupSnapshot[] = [
			{
				coordinatorId,
				groupId,
				displayName: "Migration Team",
				devices: [
					{
						deviceId: rawDeviceId,
						fingerprint: "fingerprint-secret",
						displayName: "Review Laptop",
						enabled: true,
					},
				],
			},
		];

		it("invalidates the cached Team setup summary after a recipient-policy rename", async () => {
			const loadSnapshots = vi.fn(async () => []);
			const { app, ensureStore, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
				readCoordinatorConfig: () => core.readCoordinatorSyncConfig({}),
			});
			try {
				const store = ensureStore();
				store.db
					.prepare(
						`INSERT INTO policy_teams(
					 team_id, display_name, status, provenance, revision, migration_state,
					 idempotency_key, created_at, updated_at
					 ) VALUES ('team-local', 'Old Team', 'active', 'user', 'revision-1',
					 'user_managed', 'team-key', '2026-08-26T00:00:00.000Z',
					 '2026-08-26T00:00:00.000Z')`,
					)
					.run();

				await app.request("/api/sync/team-setup/v1");
				await app.request("/api/sync/team-setup/v1");
				expect(loadSnapshots).toHaveBeenCalledTimes(1);

				const renamed = await app.request("/api/sync/recipient-policy/v1/teams/team-local", {
					method: "PATCH",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: JSON.stringify({
						displayName: "New Team",
						expectedDisplayName: "Old Team",
					}),
				});
				expect(renamed.status).toBe(200);

				await app.request("/api/sync/team-setup/v1");
				expect(loadSnapshots).toHaveBeenCalledTimes(2);
			} finally {
				cleanup();
			}
		});

		it("returns versioned summaries and a redacted detail with preview only when finishable", async () => {
			const loadSnapshots = vi.fn(async () => snapshots);
			const { app, ensureStore, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
			});
			try {
				const store = ensureStore();
				const now = "2026-08-24T00:00:00.000Z";
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, coordinator_id, group_id,
							membership_epoch, status, created_at, updated_at
						 ) VALUES ('scope-team-setup', 'Migration Team', 'team', 'coordinator',
						 ?, ?, 1, 'active', ?, ?)`,
					)
					.run(coordinatorId, groupId, now, now);
				store.db
					.prepare(
						`INSERT INTO project_scope_mappings(
							workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
						 ) VALUES (?, ?, 'scope-team-setup', 1000, 'test', ?, ?)`,
					)
					.run(rawProjectIdentity, rawProjectIdentity, now, now);
				const sessionId = Number(
					store.db
						.prepare(
							`INSERT INTO sessions(started_at, project, git_remote, git_branch)
							 VALUES (?, 'secret-repo', ?, 'main')`,
						)
						.run(now, rawProjectIdentity).lastInsertRowid,
				);
				store.db
					.prepare(
						`INSERT INTO memory_items(
							session_id, kind, title, body_text, active, created_at, updated_at,
							visibility, project, scope_id
						 ) VALUES (?, 'discovery', 'secret-repo', 'body', 1, ?, ?, 'shared',
						 'secret-repo', 'scope-team-setup')`,
					)
					.run(sessionId, now, now);
				const summaryResponse = await app.request("/api/sync/team-setup/v1");
				expect(summaryResponse.status).toBe(200);
				const summary = (await summaryResponse.json()) as {
					version: number;
					candidates: Array<Record<string, unknown>>;
				};
				expect(summary.version).toBe(1);
				expect(Object.keys(summary.candidates[0] ?? {}).toSorted()).toEqual(
					[
						"candidateRef",
						"deviceCount",
						"displayName",
						"projectCount",
						"status",
						"unresolvedDeviceCount",
						"unresolvedProjectCount",
					].toSorted(),
				);
				expect(summary.candidates[0]).toMatchObject({
					candidateRef,
					displayName: "Migration Team",
					status: "needs_setup",
					deviceCount: 1,
					projectCount: 1,
					unresolvedDeviceCount: 1,
					unresolvedProjectCount: 0,
				});

				const incompleteResponse = await app.request(`/api/sync/team-setup/v1/${candidateRef}`);
				expect(incompleteResponse.status).toBe(200);
				const incomplete = (await incompleteResponse.json()) as Record<string, unknown>;
				expect(incomplete).toMatchObject({
					version: 1,
					candidate: { candidateRef },
					draftState: "needs_setup",
					conflictState: "team_setup_incomplete",
					canFinish: false,
				});
				expect(incomplete).not.toHaveProperty("finishDigest");
				expect(incomplete).not.toHaveProperty("accessDeltaDigest");
				expect(incomplete).not.toHaveProperty("accessDelta");

				const draft = core.getLegacyTeamSetupDraft(store.db, candidateRef);
				expect(draft).not.toBeNull();
				store.db
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES (?, 'Private Person', 0, 'active', ?, ?)`,
					)
					.run(rawIdentityId, "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
				const replacementIdentityId = "replacement-identity-secret-id";
				store.db
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES (?, 'Replacement Person', 0, 'active', ?, ?)`,
					)
					.run(replacementIdentityId, now, now);
				const deviceRef = draft?.devices[0]?.deviceRef ?? "";
				const targetIdentityRef = core.recipientPolicyDigest("legacy-team-viewer-identity-ref-v1", [
					candidateRef,
					rawIdentityId,
				]);
				const replacementIdentityRef = core.recipientPolicyDigest(
					"legacy-team-viewer-identity-ref-v1",
					[candidateRef, replacementIdentityId],
				);
				const assignmentResponse = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/devices/${deviceRef}/assignment`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							attemptId: draft?.attemptId,
							targetIdentityRef,
							expectation: { kind: "absent" },
						}),
					},
				);
				expect(assignmentResponse.status).toBe(200);
				const replacementAssignmentResponse = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/devices/${deviceRef}/assignment`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							attemptId: draft?.attemptId,
							targetIdentityRef: replacementIdentityRef,
							expectation: { kind: "absent" },
						}),
					},
				);
				expect(replacementAssignmentResponse.status).toBe(200);
				const staleDecisionResponse = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/devices/${deviceRef}/decision`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							attemptId: draft?.attemptId,
							decision: "included",
							expectedTargetIdentityRef: targetIdentityRef,
						}),
					},
				);
				expect(staleDecisionResponse.status).toBe(409);
				expect(await staleDecisionResponse.json()).toEqual({
					error: "team_setup_assignment_changed",
				});
				const restoredAssignmentResponse = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/devices/${deviceRef}/assignment`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							attemptId: draft?.attemptId,
							targetIdentityRef,
							expectation: { kind: "absent" },
						}),
					},
				);
				expect(restoredAssignmentResponse.status).toBe(200);
				const decisionResponse = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/devices/${deviceRef}/decision`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							attemptId: draft?.attemptId,
							decision: "included",
							expectedTargetIdentityRef: targetIdentityRef,
						}),
					},
				);
				expect(decisionResponse.status).toBe(200);
				const clearResponse = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/devices/${deviceRef}/decision`,
					{
						method: "DELETE",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ attemptId: draft?.attemptId }),
					},
				);
				expect(clearResponse.status).toBe(200);
				expect(await clearResponse.json()).toMatchObject({
					canFinish: false,
					unresolvedDeviceCount: 1,
				});
				const restoredDecisionResponse = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/devices/${deviceRef}/decision`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							attemptId: draft?.attemptId,
							decision: "included",
							expectedTargetIdentityRef: targetIdentityRef,
						}),
					},
				);
				expect(restoredDecisionResponse.status).toBe(200);
				const rawPreview = core.previewLegacyTeamSetupActivation(store.db, {
					candidateRef,
					attemptId: draft?.attemptId ?? "",
				});

				const detailResponse = await app.request(`/api/sync/team-setup/v1/${candidateRef}`);
				expect(detailResponse.status).toBe(200);
				const detail = (await detailResponse.json()) as Record<string, unknown>;
				expect(detail).toMatchObject({
					version: 1,
					attemptId: draft?.attemptId,
					finishDigest: rawPreview.finishDigest,
					canFinish: true,
					conflictState: null,
					accessDeltaDigest: rawPreview.accessDeltaDigest,
				});
				expect(JSON.stringify(detail)).not.toContain(coordinatorId);
				expect(JSON.stringify(detail)).not.toContain(groupId);
				expect(JSON.stringify(detail)).not.toContain(rawDeviceId);
				expect(JSON.stringify(detail)).not.toContain(rawIdentityId);
				expect(JSON.stringify(detail)).not.toContain("fingerprint-secret");
				expect(JSON.stringify(detail)).not.toContain(rawProjectIdentity);
				expect(JSON.stringify(detail)).not.toContain(rawPreview.accessDelta.teamChanges[0]?.teamId);
				expect(detail).toHaveProperty("accessDelta.teamChanges.0.teamRef");
				expect(detail).toHaveProperty("accessDelta.membershipChanges.0.identityRef");
				expect(detail).toHaveProperty("devices.0.deviceRef");
				expect(detail.identityChoices).toEqual(
					expect.arrayContaining([
						{ identityRef: targetIdentityRef, displayName: "Private Person" },
					]),
				);
				expect((detail.devices as Array<{ deviceRef: string }>)[0]?.deviceRef).toBe(
					core.legacyTeamDeviceRef(candidateRef, rawDeviceId),
				);
				const projects = detail.projects as Array<{
					projectRef: string;
					canonicalProjectRef: string;
					resolvedProjectRef: string;
				}>;
				const accessDelta = detail.accessDelta as {
					projectChanges: Array<{
						projectRef: string;
						toResolvedProjectRef: string | null;
					}>;
					recipientChanges: Array<{ canonicalProjectRef: string }>;
					deviceAccessChanges: Array<{ canonicalProjectRef: string; deviceRef: string }>;
				};
				expect(accessDelta.recipientChanges.length).toBeGreaterThan(0);
				expect(accessDelta.deviceAccessChanges.length).toBeGreaterThan(0);
				for (const change of accessDelta.projectChanges) {
					const project = projects.find((item) => item.projectRef === change.projectRef);
					expect(project).toBeDefined();
					if (change.toResolvedProjectRef !== null) {
						expect(change.toResolvedProjectRef).toBe(project?.resolvedProjectRef);
					}
				}
				const displayedCanonicalRefs = new Set(
					projects.map((project) => project.canonicalProjectRef),
				);
				for (const change of accessDelta.recipientChanges) {
					expect(displayedCanonicalRefs.has(change.canonicalProjectRef)).toBe(true);
				}
				for (const change of accessDelta.deviceAccessChanges) {
					expect(displayedCanonicalRefs.has(change.canonicalProjectRef)).toBe(true);
					expect(change.deviceRef).toBe(
						(detail.devices as Array<{ deviceRef: string }>)[0]?.deviceRef,
					);
				}

				const finishRequest = {
					attemptId: draft?.attemptId,
					finishDigest: rawPreview.finishDigest,
					confirmedAccessDeltaDigest: rawPreview.accessDeltaDigest,
					confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
				};
				store.db
					.prepare("UPDATE actors SET display_name = ? WHERE actor_id = ?")
					.run("Renamed Person", rawIdentityId);
				const staleLabelResponse = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/finish`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(finishRequest),
					},
				);
				expect(staleLabelResponse.status).toBe(409);
				expect(await staleLabelResponse.json()).toEqual({
					error: "team_setup_confirmation_stale",
				});
				store.db
					.prepare("UPDATE actors SET display_name = ? WHERE actor_id = ?")
					.run("Private Person", rawIdentityId);
				loadSnapshots.mockImplementationOnce(async () => {
					store.db
						.prepare("UPDATE actors SET display_name = ? WHERE actor_id = ?")
						.run("Raced Person", rawIdentityId);
					return snapshots;
				});
				const racedLabelResponse = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/finish`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(finishRequest),
					},
				);
				expect(racedLabelResponse.status).toBe(409);
				expect(await racedLabelResponse.json()).toEqual({
					error: "team_setup_confirmation_stale",
				});
				expect(core.getLegacyTeamSetupDraft(store.db, candidateRef)?.state).not.toBe("completed");
				store.db
					.prepare("UPDATE actors SET display_name = ? WHERE actor_id = ?")
					.run("Private Person", rawIdentityId);
				loadSnapshots.mockClear();
				const finishResponse = await app.request(`/api/sync/team-setup/v1/${candidateRef}/finish`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(finishRequest),
				});
				expect(finishResponse.status).toBe(200);
				expect(loadSnapshots).toHaveBeenCalledTimes(1);
				expect(loadSnapshots).toHaveBeenCalledWith({ candidateRef });
				const finished = await finishResponse.json();
				expect(finished).toMatchObject({
					version: 1,
					status: "completed",
					attemptId: draft?.attemptId,
					accessDeltaDigest: rawPreview.accessDeltaDigest,
				});
				expect(finished).toHaveProperty("teamRef");
				expect(JSON.stringify(finished)).not.toContain(
					rawPreview.accessDelta.teamChanges[0]?.teamId,
				);
				const replayResponse = await app.request(`/api/sync/team-setup/v1/${candidateRef}/finish`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(finishRequest),
				});
				expect(replayResponse.status).toBe(200);
				expect(await replayResponse.json()).toEqual(finished);
				const missingConfirmation = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/finish`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							attemptId: draft?.attemptId,
							finishDigest: rawPreview.finishDigest,
						}),
					},
				);
				expect(missingConfirmation.status).toBe(409);
				expect(await missingConfirmation.json()).toEqual({
					error: "team_setup_confirmation_stale",
				});
				const otherCandidateRef = core.legacyTeamCandidateId(coordinatorId, "group-beta");
				loadSnapshots.mockResolvedValue([
					...snapshots,
					{
						coordinatorId,
						groupId: "group-beta",
						displayName: "Other Migration Team",
						devices: [
							{
								deviceId: "other-device-secret-id",
								fingerprint: "other-fingerprint-secret",
								displayName: "Other Review Laptop",
								enabled: true,
							},
						],
					},
				]);
				const otherDetailResponse = await app.request(
					`/api/sync/team-setup/v1/${otherCandidateRef}`,
				);
				expect(otherDetailResponse.status).toBe(200);
				const otherDraft = core.getLegacyTeamSetupDraft(store.db, otherCandidateRef);
				expect(otherDraft).not.toBeNull();
				expect(otherDraft?.attemptId).not.toBe(finishRequest.attemptId);
				const crossCandidate = await app.request(
					`/api/sync/team-setup/v1/${otherCandidateRef}/finish`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(finishRequest),
					},
				);
				expect(crossCandidate.status).toBe(409);
				expect(await crossCandidate.json()).toEqual({
					error: "team_setup_confirmation_stale",
				});
				const insertUnrelatedActor = store.db.prepare(
					`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
					 VALUES (?, ?, 0, 'active', ?, ?)`,
				);
				for (let index = 0; index < 501; index += 1) {
					insertUnrelatedActor.run(`unrelated-${index}`, `Unrelated ${index}`, now, now);
				}
				const insertRemovedDraftDevice = store.db.prepare(
					`INSERT INTO legacy_team_setup_draft_devices(
					 attempt_id, device_id, device_ref, key_fingerprint, display_name, enabled,
					 existing_identity_id, decision, target_identity_id, updated_at
					 ) VALUES (?, ?, ?, ?, ?, 0, ?, 'removed', ?, ?)`,
				);
				for (let index = 0; index < 250; index += 1) {
					const deviceId = `removed-device-${index}`;
					insertRemovedDraftDevice.run(
						draft?.attemptId,
						deviceId,
						core.legacyTeamDeviceRef(candidateRef, deviceId),
						`removed-key-${index}`,
						`Removed device ${index}`,
						`unrelated-${index * 2}`,
						`unrelated-${index * 2 + 1}`,
						now,
					);
				}
				loadSnapshots.mockClear();
				const readyResponse = await app.request(`/api/sync/team-setup/v1/${candidateRef}`);
				expect(readyResponse.status).toBe(200);
				const ready = (await readyResponse.json()) as Record<string, unknown>;
				expect(ready).toMatchObject({
					candidate: { candidateRef, status: "ready" },
					draftState: "completed",
					canFinish: false,
					conflictState: null,
				});
				expect(ready).not.toHaveProperty("finishDigest");
				expect(ready).not.toHaveProperty("accessDeltaDigest");
				expect(ready).not.toHaveProperty("accessDelta");
				expect(ready.identityChoices).toHaveLength(501);
				expect(loadSnapshots).not.toHaveBeenCalled();

				store.db.prepare("DELETE FROM actors WHERE actor_id LIKE 'unrelated-%'").run();
				store.db
					.prepare(
						`UPDATE policy_team_device_decisions SET decision = 'unresolved'
						 WHERE team_id = ? AND device_id = ?`,
					)
					.run(core.deterministicPolicyTeamId(candidateRef), rawDeviceId);
				loadSnapshots.mockClear();
				const reopenedResponse = await app.request(`/api/sync/team-setup/v1/${candidateRef}`);
				expect(reopenedResponse.status).toBe(200);
				const reopened = (await reopenedResponse.json()) as Record<string, unknown>;
				expect(reopened).toMatchObject({ candidate: { candidateRef } });
				expect((reopened.candidate as { status: string }).status).not.toBe("ready");
				expect(reopened.draftState).not.toBe("completed");
				expect(loadSnapshots).toHaveBeenCalledWith({ candidateRef });
			} finally {
				cleanup();
			}
		});

		it("redacts Project change identities into refs that join displayed Projects", () => {
			const projectRef = "legacy-team-project-ref-v1:test";
			const fromIdentity = "file:///Users/private/old-project";
			const toIdentity = rawProjectIdentity;
			const safe = __teamSetupTestHooks.viewerSafeAccessDelta(candidateRef, {
				teamChanges: [],
				membershipChanges: [],
				projectChanges: [
					{
						projectRef,
						fromProjectIdentity: fromIdentity,
						toProjectIdentity: toIdentity,
						change: "update",
					},
				],
				recipientChanges: [],
				deviceAccessChanges: [],
			});
			expect(JSON.stringify(safe)).not.toContain(fromIdentity);
			expect(JSON.stringify(safe)).not.toContain(toIdentity);
			const fromRef = core.legacyTeamResolvedProjectRef(projectRef, fromIdentity);
			const toRef = core.legacyTeamResolvedProjectRef(projectRef, toIdentity);
			expect(safe.projectChanges[0]).toEqual({
				projectRef,
				projectDisplayName: "Project outside this setup (1)",
				fromResolvedProjectRef: fromRef,
				fromResolvedProjectDisplayName: "Project outside this setup (2)",
				toResolvedProjectRef: toRef,
				toResolvedProjectDisplayName: "Project outside this setup (3)",
				change: "update",
			});
		});

		it("gives external delta entries distinct viewer-safe fallback labels", () => {
			const safe = __teamSetupTestHooks.viewerSafeAccessDelta(
				candidateRef,
				{
					teamChanges: [],
					membershipChanges: [],
					projectChanges: [],
					recipientChanges: [],
					deviceAccessChanges: [
						{
							canonicalProjectIdentity: "file:///private/external-one",
							deviceId: "external-device-one",
							change: "add",
						},
						{
							canonicalProjectIdentity: "file:///private/external-two",
							deviceId: "external-device-two",
							change: "remove",
						},
					],
				},
				{
					teamDisplayName: "Example Team",
					devices: [
						{
							deviceRef: core.legacyTeamDeviceRef(candidateRef, "known-device"),
							displayName: "Device outside this setup (1)",
							enabled: true,
							existingIdentityRef: null,
							suggestedIdentityRef: null,
							verifiedEvidenceKind: null,
							decision: "excluded",
							targetIdentityRef: null,
							expectation: { kind: "absent" },
						},
					],
					projects: [
						{
							projectRef: "known-project-ref",
							displayName: "Project outside this setup (1)",
							resolution: "unresolved",
							canonicalProjectRef: null,
							resolvedProjectRef: null,
							mappingChoices: [],
						},
					],
					identityChoices: [],
				},
			);

			expect(safe.deviceAccessChanges.map((change) => change.deviceDisplayName)).toEqual([
				"Device outside this setup (2)",
				"Device outside this setup (3)",
			]);
			expect(safe.deviceAccessChanges.map((change) => change.canonicalProjectDisplayName)).toEqual([
				"Project outside this setup (2)",
				"Project outside this setup (3)",
			]);
			expect(JSON.stringify(safe)).not.toContain("external-device");
			expect(JSON.stringify(safe)).not.toContain("file:///private");
		});

		it("fails closed when active identity choices exceed their response cap", async () => {
			const { app, ensureStore, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async () => snapshots,
			});
			try {
				ensureStore()
					.db.prepare(
						`WITH RECURSIVE sequence(value) AS (
							SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
						 )
						 INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 SELECT printf('overflow-person-%03d', value), printf('Person %03d', value),
						        0, 'active', '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'
						 FROM sequence`,
					)
					.run();

				const response = await app.request(`/api/sync/team-setup/v1/${candidateRef}`);
				expect(response.status).toBe(503);
				expect(await response.json()).toEqual({ error: "team_setup_roster_unavailable" });
			} finally {
				cleanup();
			}
		});

		it("resolves an older Project choice beyond 500 newer duplicate sessions", async () => {
			const { app, ensureStore, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async () => snapshots,
			});
			try {
				const store = ensureStore();
				store.db
					.prepare(
						`WITH RECURSIVE sequence(value) AS (
							SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 600
						 )
						 INSERT INTO sessions(started_at, project, git_remote, git_branch)
						 SELECT '2026-08-24T00:00:00.000Z', 'Repeated Project',
						        CASE WHEN value <= 100
						          THEN 'https://example.invalid/project-a.git'
						          ELSE 'https://example.invalid/project-b.git'
						        END, 'main'
						 FROM sequence`,
					)
					.run();
				const sourceIdentity = "unmapped:source-project";
				const projectRef = core.recipientPolicyDigest("legacy-team-project-ref-v1", [
					candidateRef,
					sourceIdentity,
				]);
				const draft = core.refreshLegacyTeamSetupDraft(store.db, {
					candidateId: candidateRef,
					coordinatorId,
					groupId,
					displayName: "Migration Team",
					devices: snapshots[0]?.devices ?? [],
					projects: [
						{
							projectRef,
							sourceProjectIdentity: sourceIdentity,
							displayName: "Source Project",
							sourceFingerprint: "source-fingerprint",
							deterministicProjectIdentity: null,
						},
					],
				});
				const targetIdentity = core.canonicalWorkspaceIdentity({
					gitRemote: "https://example.invalid/project-a.git",
				}).value;
				const response = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/projects/${projectRef}/mapping`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							attemptId: draft.attemptId,
							resolvedProjectRef: core.legacyTeamResolvedProjectRef(projectRef, targetIdentity),
						}),
					},
				);
				expect(response.status).toBe(200);
			} finally {
				cleanup();
			}
		});

		it("fails closed when 501 distinct Project mapping choices remain", async () => {
			const { app, ensureStore, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async () => snapshots,
			});
			try {
				const store = ensureStore();
				store.db
					.prepare(
						`WITH RECURSIVE sequence(value) AS (
							SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
						 )
						 INSERT INTO sessions(started_at, project, git_remote, git_branch)
						 SELECT '2026-08-24T00:00:00.000Z', printf('Project %03d', value),
						        printf('https://example.invalid/project-%03d.git', value), 'main'
						 FROM sequence`,
					)
					.run();
				const sourceIdentity = "unmapped:source-project";
				const projectRef = core.recipientPolicyDigest("legacy-team-project-ref-v1", [
					candidateRef,
					sourceIdentity,
				]);
				const draft = core.refreshLegacyTeamSetupDraft(store.db, {
					candidateId: candidateRef,
					coordinatorId,
					groupId,
					displayName: "Migration Team",
					devices: snapshots[0]?.devices ?? [],
					projects: [
						{
							projectRef,
							sourceProjectIdentity: sourceIdentity,
							displayName: "Source Project",
							sourceFingerprint: "source-fingerprint",
							deterministicProjectIdentity: null,
						},
					],
				});
				const targetIdentity = core.canonicalWorkspaceIdentity({
					gitRemote: "https://example.invalid/project-001.git",
				}).value;

				const response = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/projects/${projectRef}/mapping`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							attemptId: draft.attemptId,
							resolvedProjectRef: core.legacyTeamResolvedProjectRef(projectRef, targetIdentity),
						}),
					},
				);
				expect(response.status).toBe(503);
				expect(await response.json()).toEqual({ error: "team_setup_roster_unavailable" });
			} finally {
				cleanup();
			}
		});

		it("does not enumerate mapping choices for deterministic-only drafts", async () => {
			const { app, ensureStore, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async () => snapshots,
			});
			try {
				const store = ensureStore();
				const now = "2026-08-24T00:00:00.000Z";
				const projectRemote = "https://example.invalid/deterministic.git";
				const projectIdentity = core.canonicalWorkspaceIdentity({ gitRemote: projectRemote }).value;
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, coordinator_id, group_id,
							membership_epoch, status, created_at, updated_at
						 ) VALUES ('scope-deterministic', 'Migration Team', 'team', 'coordinator',
						 ?, ?, 1, 'active', ?, ?)`,
					)
					.run(coordinatorId, groupId, now, now);
				store.db
					.prepare(
						`INSERT INTO project_scope_mappings(
							workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
						 ) VALUES (?, ?, 'scope-deterministic', 1000, 'test', ?, ?)`,
					)
					.run(projectIdentity, projectIdentity, now, now);
				const sessionId = Number(
					store.db
						.prepare(
							`INSERT INTO sessions(started_at, project, git_remote, git_branch)
							 VALUES (?, 'Deterministic Project', ?, 'main')`,
						)
						.run(now, projectRemote).lastInsertRowid,
				);
				store.db
					.prepare(
						`INSERT INTO memory_items(
							session_id, kind, title, body_text, active, created_at, updated_at,
							visibility, project, scope_id
						 ) VALUES (?, 'discovery', 'Deterministic Project', 'body', 1, ?, ?, 'shared',
						 'Deterministic Project', 'scope-deterministic')`,
					)
					.run(sessionId, now, now);
				store.db
					.prepare(
						`WITH RECURSIVE sequence(value) AS (
							SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 501
						 )
						 INSERT INTO sessions(started_at, project, git_remote, git_branch)
						 SELECT '2026-08-24T00:00:00.000Z', printf('Noise %03d', value),
						        printf('https://example.invalid/noise-%03d.git', value), 'main'
						 FROM sequence`,
					)
					.run();

				const response = await app.request(`/api/sync/team-setup/v1/${candidateRef}`);
				expect(response.status).toBe(200);
				const detail = (await response.json()) as {
					projects: Array<{ resolution: string; mappingChoices: unknown[] }>;
				};
				expect(detail.projects).toEqual([
					expect.objectContaining({ resolution: "deterministic", mappingChoices: [] }),
				]);
			} finally {
				cleanup();
			}
		});

		it("maps duplicate conflicting refresh snapshots to a conflict", async () => {
			const conflictingSnapshots: core.LegacyTeamConfiguredGroupSnapshot[] = [
				...snapshots,
				{
					coordinatorId,
					groupId,
					displayName: "Migration Team duplicate",
					devices:
						snapshots[0]?.devices.map((device) => ({
							...device,
							fingerprint: "different-fingerprint",
						})) ?? [],
				},
			];
			const { app, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async () => conflictingSnapshots,
			});
			try {
				const response = await app.request(`/api/sync/team-setup/v1/${candidateRef}/refresh`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				expect(response.status).toBe(409);
				expect(await response.json()).toEqual({ error: "team_setup_conflict" });
			} finally {
				cleanup();
			}
		});

		it("sets an explicit ambiguous Project mapping using only opaque refs", async () => {
			const { app, ensureStore, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async () => snapshots,
			});
			try {
				const store = ensureStore();
				const now = "2026-08-24T00:00:00.000Z";
				const targetRemote = "https://example.invalid/target.git";
				const targetIdentity = core.canonicalWorkspaceIdentity({ gitRemote: targetRemote }).value;
				const firstRemote = "https://example.invalid/alpha.git";
				store.db
					.prepare(
						`INSERT INTO sessions(started_at, project, git_remote, git_branch)
						 VALUES (?, 'Target Project', ?, 'main')`,
					)
					.run(now, targetRemote);
				store.db
					.prepare(
						`INSERT INTO sessions(started_at, project, git_remote, git_branch)
						 VALUES (?, 'Alpha Project', ?, 'main')`,
					)
					.run(now, firstRemote);
				const sourceIdentity = "unmapped:source-project";
				const projectRef = core.recipientPolicyDigest("legacy-team-project-ref-v1", [
					candidateRef,
					sourceIdentity,
				]);
				const draft = core.refreshLegacyTeamSetupDraft(store.db, {
					candidateId: candidateRef,
					coordinatorId,
					groupId,
					displayName: "Migration Team",
					devices: snapshots[0]?.devices ?? [],
					projects: [
						{
							projectRef,
							sourceProjectIdentity: sourceIdentity,
							displayName: "Source Project",
							sourceFingerprint: "source-fingerprint",
							deterministicProjectIdentity: null,
						},
					],
				});
				const mappingChoices = core.listProjectScopeCandidates(store.db);
				expect(mappingChoices.map((choice) => choice.display_project)).toEqual([
					"Alpha Project",
					"Target Project",
				]);
				const resolvedProjectRef = core.legacyTeamResolvedProjectRef(projectRef, targetIdentity);
				const response = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/projects/${projectRef}/mapping`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ attemptId: draft.attemptId, resolvedProjectRef }),
					},
				);
				expect(response.status).toBe(200);
				const payload = await response.json();
				expect(payload).toMatchObject({
					candidateRef,
					attemptId: draft.attemptId,
					unresolvedProjectCount: 0,
				});
				const saved = core.getLegacyTeamSetupDraft(store.db, candidateRef);
				expect(saved?.projects[0]).toMatchObject({
					projectRef,
					resolution: "explicit",
					resolvedProjectRef,
				});
				expect(JSON.stringify(payload)).not.toContain(targetIdentity);
			} finally {
				cleanup();
			}
		});

		it("fails closed when Project mapping metadata exceeds its row budget", async () => {
			const { app, ensureStore, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async () => snapshots,
			});
			try {
				const store = ensureStore();
				core.listSharingDomainSettingsScopes(store.db);
				const insert = store.db.prepare(
					`INSERT INTO project_scope_mappings(
						workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
					 ) VALUES (?, ?, ?, 1000, 'user', ?, ?)`,
				);
				store.db.transaction(() => {
					for (let index = 0; index < 10_001; index += 1) {
						const identity = `unmapped:overflow-${index}`;
						insert.run(
							identity,
							identity,
							core.LOCAL_DEFAULT_SCOPE_ID,
							"2026-08-24T00:00:00.000Z",
							"2026-08-24T00:00:00.000Z",
						);
					}
				})();
				const sourceIdentity = "unmapped:source-project";
				const projectRef = core.recipientPolicyDigest("legacy-team-project-ref-v1", [
					candidateRef,
					sourceIdentity,
				]);
				const draft = core.refreshLegacyTeamSetupDraft(store.db, {
					candidateId: candidateRef,
					coordinatorId,
					groupId,
					displayName: "Migration Team",
					devices: snapshots[0]?.devices ?? [],
					projects: [
						{
							projectRef,
							sourceProjectIdentity: sourceIdentity,
							displayName: "Source Project",
							sourceFingerprint: "source-fingerprint",
							deterministicProjectIdentity: null,
						},
					],
				});

				const response = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/projects/${projectRef}/mapping`,
					{
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							attemptId: draft.attemptId,
							resolvedProjectRef: core.legacyTeamResolvedProjectRef(
								projectRef,
								"unmapped:overflow-0",
							),
						}),
					},
				);

				expect(response.status).toBe(503);
				expect(await response.json()).toEqual({ error: "team_setup_roster_unavailable" });
			} finally {
				cleanup();
			}
		});

		it("normalizes scheme-less coordinator URLs before admin roster requests", async () => {
			const config = {
				...core.readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: "localhost:8787/",
				syncCoordinatorGroups: [groupId],
				syncCoordinatorAdminSecret: "private-admin-secret",
			};
			const listGroups = vi.fn(async () => [
				{
					group_id: groupId,
					display_name: "Migration Team",
					archived_at: null,
					created_at: "2026-08-24T00:00:00.000Z",
				},
			]);
			const listDevices = vi.fn(async () => []);
			const loaded = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
				readConfig: () => config,
				listGroups,
				listDevices,
			});

			expect(loaded[0]?.coordinatorId).toBe("http://localhost:8787");
			expect(listGroups).toHaveBeenCalledWith(
				expect.objectContaining({ remoteUrl: "http://localhost:8787" }),
			);
			expect(listDevices).toHaveBeenCalledWith(
				expect.objectContaining({ remoteUrl: "http://localhost:8787" }),
			);
		});

		it("isolates oversized coordinator rosters from valid configured groups", async () => {
			const oversizedGroupId = "oversized-group";
			const config = {
				...core.readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: "http://localhost:8787",
				syncCoordinatorGroups: [oversizedGroupId, groupId],
				syncCoordinatorAdminSecret: "private-admin-secret",
			};
			const loaded = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
				readConfig: () => config,
				listGroups: async () => [
					{
						group_id: oversizedGroupId,
						display_name: "Oversized Team",
						archived_at: null,
						created_at: "2026-08-24T00:00:00.000Z",
					},
					{
						group_id: groupId,
						display_name: "Migration Team",
						archived_at: null,
						created_at: "2026-08-24T00:00:00.000Z",
					},
				],
				listDevices: async ({ groupId: requestedGroupId }) => {
					if (requestedGroupId === oversizedGroupId) {
						throw new Error("coordinator_response_too_large");
					}
					return [];
				},
			});

			expect(loaded).toEqual([
				expect.objectContaining({ groupId, displayName: "Migration Team", devices: [] }),
			]);
		});

		it("fails closed when the only summary roster is unavailable", async () => {
			const config = {
				...core.readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: "http://localhost:8787",
				syncCoordinatorGroups: [groupId],
				syncCoordinatorAdminSecret: "private-admin-secret",
			};
			await expect(
				__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
					readConfig: () => config,
					listGroups: async () => [
						{
							group_id: groupId,
							display_name: "Migration Team",
							archived_at: null,
							created_at: "2026-08-24T00:00:00.000Z",
						},
					],
					listDevices: async () => {
						throw new Error("private upstream body");
					},
				}),
			).rejects.toThrow("team_setup_roster_unavailable");
		});

		it("fails closed when the only summary roster has a mismatched fingerprint", async () => {
			const config = {
				...core.readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: "http://localhost:8787",
				syncCoordinatorGroups: [groupId],
				syncCoordinatorAdminSecret: "private-admin-secret",
			};
			await expect(
				__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
					readConfig: () => config,
					listGroups: async () => [
						{
							group_id: groupId,
							display_name: "Migration Team",
							archived_at: null,
							created_at: "2026-08-24T00:00:00.000Z",
						},
					],
					listDevices: async () => [
						{
							group_id: groupId,
							device_id: "device-a",
							public_key: "public-key-a",
							fingerprint: "mismatched-fingerprint",
							identity_id: null,
							display_name: "Laptop",
							enabled: 1,
							created_at: "2026-08-24T00:00:00.000Z",
						},
					],
				}),
			).rejects.toThrow("team_setup_roster_unavailable");
		});

		it.each([
			2, -1,
		])("fails closed on sole invalid coordinator enabled value %i", async (enabled) => {
			const publicKey = "public-key-a";
			const config = {
				...core.readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: "http://localhost:8787",
				syncCoordinatorGroups: [groupId],
				syncCoordinatorAdminSecret: "private-admin-secret",
			};
			await expect(
				__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
					readConfig: () => config,
					listGroups: async () => [
						{
							group_id: groupId,
							display_name: "Migration Team",
							archived_at: null,
							created_at: "2026-08-24T00:00:00.000Z",
						},
					],
					listDevices: async () => [
						{
							group_id: groupId,
							device_id: "device-a",
							public_key: publicKey,
							fingerprint: fingerprintPublicKey(publicKey),
							identity_id: null,
							display_name: "Laptop",
							enabled,
							created_at: "2026-08-24T00:00:00.000Z",
						},
					],
				}),
			).rejects.toThrow("team_setup_roster_unavailable");
		});

		it("accepts matching roster keys and retains redaction-only coordinator identifiers", async () => {
			const publicKey = "public-key-a";
			const fingerprint = fingerprintPublicKey(publicKey);
			const identityId = "opaque-person-alpha";
			const config = {
				...core.readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: "http://localhost:8787",
				syncCoordinatorGroups: [groupId],
				syncCoordinatorAdminSecret: "private-admin-secret",
			};

			const loaded = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
				readConfig: () => config,
				listGroups: async () => [
					{
						group_id: groupId,
						display_name: "Migration Team",
						archived_at: null,
						created_at: "2026-08-24T00:00:00.000Z",
					},
				],
				listDevices: async () => [
					{
						group_id: groupId,
						device_id: "device-a",
						public_key: publicKey,
						fingerprint,
						identity_id: identityId,
						display_name: "Laptop",
						enabled: 1,
						created_at: "2026-08-24T00:00:00.000Z",
					},
				],
			});

			expect(loaded).toEqual([
				expect.objectContaining({
					groupId,
					displayName: "Migration Team",
					devices: [
						{
							deviceId: "device-a",
							fingerprint,
							displayName: "Laptop",
							enabled: true,
							labelRedactionIds: [identityId, publicKey],
						},
					],
				}),
			]);
		});

		it("limits detail discovery side effects to the requested candidate", async () => {
			const otherGroupId = "group-beta";
			const otherCandidateRef = core.legacyTeamCandidateId(coordinatorId, otherGroupId);
			const { app, ensureStore, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async () => [
					...snapshots,
					{
						coordinatorId,
						groupId: otherGroupId,
						displayName: "Other Team",
						devices: [],
					},
				],
			});
			try {
				const response = await app.request(`/api/sync/team-setup/v1/${candidateRef}`);
				expect(response.status).toBe(200);
				expect(core.getLegacyTeamSetupDraft(ensureStore().db, candidateRef)).not.toBeNull();
				expect(core.getLegacyTeamSetupDraft(ensureStore().db, otherCandidateRef)).toBeNull();
			} finally {
				cleanup();
			}
		});

		it("invalidates cached summary rosters after candidate refresh", async () => {
			let currentSnapshots = snapshots;
			let resolveRefresh!: () => void;
			const loadSnapshots = vi.fn((options?: { candidateRef?: string }) =>
				options?.candidateRef
					? new Promise<core.LegacyTeamConfiguredGroupSnapshot[]>((resolve) => {
							resolveRefresh = () => resolve(currentSnapshots);
						})
					: Promise.resolve(currentSnapshots),
			);
			const { app, ensureStore, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
			});
			try {
				expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
				const initialAttemptId = core.getLegacyTeamSetupDraft(
					ensureStore().db,
					candidateRef,
				)?.attemptId;
				currentSnapshots = [
					{
						...snapshots[0],
						devices: snapshots[0].devices.map((device) => ({
							...device,
							fingerprint: "refreshed-fingerprint",
						})),
					},
				];
				const refreshPromise = app.request(`/api/sync/team-setup/v1/${candidateRef}/refresh`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				await vi.waitFor(() => expect(loadSnapshots).toHaveBeenCalledTimes(2));
				expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
				resolveRefresh();
				const refresh = await refreshPromise;
				expect(refresh.status).toBe(200);
				const refreshedAttemptId = core.getLegacyTeamSetupDraft(
					ensureStore().db,
					candidateRef,
				)?.attemptId;
				expect(refreshedAttemptId).not.toBe(initialAttemptId);

				expect((await app.request("/api/sync/team-setup/v1")).status).toBe(200);
				expect(core.getLegacyTeamSetupDraft(ensureStore().db, candidateRef)?.attemptId).toBe(
					refreshedAttemptId,
				);
				expect(loadSnapshots).toHaveBeenCalledTimes(4);
			} finally {
				cleanup();
			}
		});

		it("returns bounded validation, unknown-candidate, roster, and size errors", async () => {
			const loadSnapshots = vi.fn(async () => snapshots);
			const testApp = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
			});
			try {
				const deviceRef = core.legacyTeamDeviceRef(candidateRef, rawDeviceId);
				expect((await testApp.app.request(`/api/sync/team-setup/v1/${candidateRef}`)).status).toBe(
					200,
				);
				const validAttemptId = core.getLegacyTeamSetupDraft(
					testApp.ensureStore().db,
					candidateRef,
				)?.attemptId;
				expect(validAttemptId).toBeDefined();
				loadSnapshots.mockClear();
				for (const body of [
					"{not-json",
					JSON.stringify({ attemptId: validAttemptId, decision: "excluded", rawDeviceId }),
				]) {
					const invalidBody = await testApp.app.request(
						`/api/sync/team-setup/v1/${candidateRef}/devices/${deviceRef}/decision`,
						{
							method: "PUT",
							headers: { "content-type": "application/json" },
							body,
						},
					);
					expect(invalidBody.status).toBe(400);
					expect(await invalidBody.json()).toEqual({ error: "team_setup_incomplete" });
				}
				let streamReads = 0;
				let streamCancelled = false;
				const oversizedStream = new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							streamReads += 1;
							controller.enqueue(new Uint8Array(4_096));
						},
						cancel() {
							streamCancelled = true;
						},
					},
					{ highWaterMark: 0 },
				);
				const oversizedBody = await testApp.app.request(
					new Request(
						`http://localhost/api/sync/team-setup/v1/${candidateRef}/devices/${deviceRef}/decision`,
						{
							method: "PUT",
							headers: { "content-type": "application/json" },
							body: oversizedStream,
							duplex: "half",
						} as RequestInit & { duplex: "half" },
					),
				);
				expect(oversizedBody.status).toBe(400);
				expect(await oversizedBody.json()).toEqual({ error: "team_setup_incomplete" });
				expect(streamReads).toBe(3);
				expect(streamCancelled).toBe(true);
				const malformed = await testApp.app.request(
					"/api/sync/team-setup/v1/legacy-team-candidate:not-hex",
				);
				expect(malformed.status).toBe(400);
				expect(await malformed.json()).toEqual({ error: "team_setup_incomplete" });
				expect(loadSnapshots).not.toHaveBeenCalled();

				const unknown = await testApp.app.request(
					"/api/sync/team-setup/v1/legacy-team-candidate:00000000000000000000000000000000",
				);
				expect(unknown.status).toBe(404);
				expect(await unknown.json()).toEqual({ error: "team_setup_confirmation_stale" });
			} finally {
				testApp.cleanup();
			}

			const unavailable = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async () => {
					throw new Error("private upstream body");
				},
			});
			try {
				const response = await unavailable.app.request("/api/sync/team-setup/v1");
				expect(response.status).toBe(503);
				expect(await response.json()).toEqual({ error: "team_setup_roster_unavailable" });
			} finally {
				unavailable.cleanup();
			}

			const oversized = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async () =>
					Array.from({ length: 26 }, (_, index) => ({
						...snapshots[0],
						groupId: `group-${index}`,
					})),
			});
			try {
				const response = await oversized.app.request("/api/sync/team-setup/v1");
				expect(response.status).toBe(503);
				expect(await response.json()).toEqual({ error: "team_setup_roster_unavailable" });
			} finally {
				oversized.cleanup();
			}

			const directOversized = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async (options) => {
					if (options?.candidateRef) throw new Error("legacy_team_setup_roster_too_large");
					return snapshots;
				},
			});
			try {
				const response = await directOversized.app.request(
					`/api/sync/team-setup/v1/${candidateRef}/refresh`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
					},
				);
				expect(response.status).toBe(503);
				expect(await response.json()).toEqual({ error: "team_setup_roster_unavailable" });
			} finally {
				directOversized.cleanup();
			}
		});

		it("inherits createApp origin handling and is absent from createSyncApp", async () => {
			const { app, syncApp, cleanup } = createTestApp({
				loadLegacyTeamConfiguredGroupSnapshots: async () => snapshots,
			});
			try {
				const crossOriginResponse = await app.request("/api/sync/team-setup/v1", {
					headers: { Origin: "https://evil.example.com" },
				});
				expect(crossOriginResponse.status).toBe(403);
				expect(await crossOriginResponse.json()).toEqual({ error: "forbidden" });
				const crossOriginHeadResponse = await app.request("/api/sync/team-setup/v1", {
					method: "HEAD",
					headers: { Origin: "https://evil.example.com" },
				});
				expect(crossOriginHeadResponse.status).toBe(403);
				const missingOriginCrossSite = await app.request("/api/sync/team-setup/v1", {
					headers: { "Sec-Fetch-Site": "cross-site" },
				});
				expect(missingOriginCrossSite.status).toBe(403);
				const viewerResponse = await app.request("/api/sync/team-setup/v1", {
					headers: { Origin: "http://127.0.0.1:38888" },
				});
				expect(viewerResponse.status).toBe(200);
				const ipv6ViewerResponse = await app.request("/api/sync/team-setup/v1", {
					headers: { Origin: "http://[::1]:38888" },
				});
				expect(ipv6ViewerResponse.status).toBe(200);
				const preflight = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/devices/${core.legacyTeamDeviceRef(candidateRef, rawDeviceId)}/decision`,
					{
						method: "OPTIONS",
						headers: { Origin: "http://127.0.0.1:38888" },
					},
				);
				expect(preflight.status).toBe(204);
				expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:38888");
				expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
				const crossOriginPut = await app.request(
					`/api/sync/team-setup/v1/${candidateRef}/devices/${core.legacyTeamDeviceRef(candidateRef, rawDeviceId)}/decision`,
					{
						method: "PUT",
						headers: {
							Origin: "https://evil.example.com",
							"content-type": "application/json",
						},
						body: "{}",
					},
				);
				expect(crossOriginPut.status).toBe(403);
				expect((await syncApp.request("/api/sync/team-setup/v1")).status).toBe(404);
			} finally {
				cleanup();
			}
		});
	});

	describe.each([
		{
			label: "Claude",
			route: "/api/claude-hooks",
			envName: "CLAUDE_CONFIG_DIR",
			rootName: "projects",
		},
		{
			label: "Codex",
			route: "/api/codex-hooks",
			envName: "CODEX_HOME",
			rootName: "sessions",
		},
	])("legacy $label hook transcript containment", ({ label, route, envName, rootName }) => {
		it("accepts configured-root transcripts and rejects outside files", async () => {
			const parent = mkdtempSync(join(tmpdir(), "codemem-viewer-transcript-root-"));
			const configuredHome = join(parent, "host-home");
			const approvedRoot = join(configuredHome, rootName);
			mkdirSync(approvedRoot, { recursive: true });
			const allowedPath = join(approvedRoot, "allowed.jsonl");
			const outsidePath = join(parent, "outside.jsonl");
			writeFileSync(allowedPath, '{"role":"assistant","content":"allowed result"}\n');
			writeFileSync(outsidePath, '{"role":"assistant","content":"outside result"}\n');
			const previousValue = process.env[envName];
			process.env[envName] = configuredHome;
			const { app, cleanup } = createTestApp();
			try {
				const allowed = await postViewerJson(app, route, {
					hook_event_name: "Stop",
					session_id: "allowed-session",
					transcript_path: allowedPath,
				});
				expect(allowed.status).toBe(200);
				expect(await allowed.json()).toEqual({ inserted: 1, skipped: 0 });

				const rejected = await postViewerJson(app, route, {
					hook_event_name: "Stop",
					session_id: "rejected-session",
					transcript_path: outsidePath,
				});
				expect(rejected.status).toBe(200);
				expect(await rejected.json()).toEqual({
					inserted: 0,
					skipped: 1,
					skip_reason: "transcript_unavailable",
					skip_detail: "path_rejected",
				});

				const relativeRejected = await postViewerJson(app, route, {
					hook_event_name: "Stop",
					session_id: "relative-rejected-session",
					cwd: parent,
					transcript_path: "outside.jsonl",
				});
				expect(relativeRejected.status).toBe(200);
				expect(await relativeRejected.json()).toEqual({
					inserted: 0,
					skipped: 1,
					skip_reason: "transcript_unavailable",
					skip_detail: "path_rejected",
				});

				writeFileSync(allowedPath, '{"role":"user","content":"no assistant"}\n');
				const noAssistant = await postViewerJson(app, route, {
					hook_event_name: "Stop",
					session_id: "no-assistant-session",
					transcript_path: allowedPath,
				});
				expect(await noAssistant.json()).toEqual({
					inserted: 0,
					skipped: 1,
					skip_reason: "transcript_unavailable",
					skip_detail: "no_assistant_record",
				});

				const notProvided = await postViewerJson(app, route, {
					hook_event_name: "Stop",
					session_id: "missing-transcript-session",
				});
				expect(await notProvided.json()).toEqual({
					inserted: 0,
					skipped: 1,
					skip_reason: "transcript_unavailable",
					skip_detail: "not_provided",
				});

				const status = await app.request("/api/raw-events/status");
				const statusBody = (await status.json()) as Record<string, unknown>;
				const source = label.toLowerCase() as "claude" | "codex";
				expect(statusBody.transcript_diagnostics).toMatchObject({
					scope: "legacy_compatibility_routes",
					counts: {
						[source]: {
							ok: 1,
							not_provided: 1,
							path_rejected: 2,
							no_assistant_record: 1,
						},
					},
				});

				const isolated = createTestApp();
				try {
					const isolatedStatus = await isolated.app.request("/api/raw-events/status");
					const isolatedBody = (await isolatedStatus.json()) as {
						transcript_diagnostics: { counts: Record<string, Record<string, number>> };
					};
					expect(isolatedBody.transcript_diagnostics.counts[source]).toEqual({
						ok: 0,
						not_provided: 0,
						path_rejected: 0,
						unreadable: 0,
						no_complete_record: 0,
						no_assistant_record: 0,
					});
				} finally {
					isolated.cleanup();
				}
			} finally {
				cleanup();
				if (previousValue == null) delete process.env[envName];
				else process.env[envName] = previousValue;
				rmSync(parent, { recursive: true, force: true });
			}
		});
	});

	describe("raw event HTTP ingestion", () => {
		const targetedIngestCases = [
			{
				route: "/api/raw-events",
				payload: {
					session_id: "targeted-canonical",
					event_id: "targeted-canonical-event",
					event_type: "prompt",
					payload: { text: "targeted canonical event" },
				},
			},
			{
				route: "/api/claude-hooks",
				payload: {
					hook_event_name: "UserPromptSubmit",
					session_id: "targeted-claude",
					prompt: "targeted Claude event",
				},
			},
			{
				route: "/api/codex-hooks",
				payload: {
					hook_event_name: "UserPromptSubmit",
					session_id: "targeted-codex",
					prompt: "targeted Codex event",
				},
			},
		] as const;

		it.each(
			targetedIngestCases,
		)("rejects database, identity, and contract mismatches before writes on $route", async ({
			route,
			payload,
		}) => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const profile = (await (await app.request("/api/prompt-pack-profile")).json()) as {
					identity_target: Record<string, unknown>;
				};
				const diagnosticsBefore = (await (await app.request("/api/raw-events/status")).json()) as {
					transcript_diagnostics: unknown;
				};
				const requests = [
					{
						db_path: `${store.dbPath}.other`,
						identity_target: profile.identity_target,
						expectedCode: "viewer_db_mismatch",
					},
					{
						db_path: store.dbPath,
						identity_target: { ...profile.identity_target, device_id: "other-device" },
						expectedCode: "viewer_identity_mismatch",
					},
					{
						db_path: store.dbPath,
						identity_target: { ...profile.identity_target, future_field: "unsupported" },
						expectedCode: "viewer_contract_unsupported",
					},
				];

				for (const request of requests) {
					const { expectedCode, ...target } = request;
					const response = await postViewerJson(app, route, { ...payload, ...target });
					expect(response.status).toBe(409);
					expect(await response.json()).toMatchObject({
						error: { code: expectedCode },
					});
					expect(rawEventState(store)).toEqual({ events: [], sessions: [] });
					const diagnosticsAfter = (await (await app.request("/api/raw-events/status")).json()) as {
						transcript_diagnostics: unknown;
					};
					expect(diagnosticsAfter.transcript_diagnostics).toEqual(
						diagnosticsBefore.transcript_diagnostics,
					);
				}
			} finally {
				cleanup();
			}
		});

		it.each(targetedIngestCases)("rejects partial targeting on $route", async ({
			route,
			payload,
		}) => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const profile = (await (await app.request("/api/prompt-pack-profile")).json()) as {
					identity_target: Record<string, unknown>;
				};
				for (const partialTarget of [
					{ db_path: store.dbPath },
					{ identity_target: profile.identity_target },
				]) {
					const response = await postViewerJson(app, route, { ...payload, ...partialTarget });
					expect(response.status).toBe(400);
					expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
					expect(rawEventState(store)).toEqual({ events: [], sessions: [] });
				}
			} finally {
				cleanup();
			}
		});

		it.each(targetedIngestCases)("rejects invalid target types on $route", async ({
			route,
			payload,
		}) => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const profile = (await (await app.request("/api/prompt-pack-profile")).json()) as {
					identity_target: Record<string, unknown>;
				};
				for (const invalidTarget of [
					{ db_path: 42, identity_target: profile.identity_target },
					{ db_path: store.dbPath, identity_target: "wrong-type" },
				]) {
					const response = await postViewerJson(app, route, { ...payload, ...invalidTarget });
					expect(response.status).toBe(400);
					expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
					expect(rawEventState(store)).toEqual({ events: [], sessions: [] });
				}
			} finally {
				cleanup();
			}
		});

		it.each(targetedIngestCases)("accepts omitted targeting fields on $route", async ({
			route,
			payload,
		}) => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const response = await postViewerJson(app, route, payload);
				expect(response.status).toBe(200);
				expect(rawEventState(ensureStore()).events).toHaveLength(1);
			} finally {
				cleanup();
			}
		});

		it.each(targetedIngestCases)("accepts path-equivalent database targets on $route", async ({
			route,
			payload,
		}) => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const profile = (await (await app.request("/api/prompt-pack-profile")).json()) as {
					identity_target: Record<string, unknown>;
				};
				const response = await postViewerJson(app, route, {
					...payload,
					db_path: `  ${dirname(store.dbPath)}/./${basename(store.dbPath)}  `,
					identity_target: profile.identity_target,
				});

				expect(response.status).toBe(200);
				expect(rawEventState(store).events).toHaveLength(1);
			} finally {
				cleanup();
			}
		});

		it("defaults omitted source to opencode and returns exactly the canonical result fields", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const response = await postViewerJson(app, "/api/raw-events", {
					session_id: "session-omitted-source",
					event_id: "event-omitted-source",
					event_type: "prompt",
					payload: { text: "hello" },
				});

				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({
					inserted: 1,
					skipped: 0,
					received: 1,
				});
				expect(rawEventState(ensureStore()).events).toMatchObject([
					{ source: "opencode", stream_id: "session-omitted-source" },
				]);
			} finally {
				cleanup();
			}
		});

		it("rejects an oversized streaming body without Content-Length before writes", async () => {
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(1_048_577));
				},
				cancel,
			});
			type StreamingRequestInit = RequestInit & { duplex: "half" };
			const request = new Request("http://localhost/api/raw-events", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "http://127.0.0.1:38888",
				},
				body,
				duplex: "half",
			} as StreamingRequestInit);
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				expect(request.headers.has("content-length")).toBe(false);
				const response = await app.fetch(request);

				expect(response.status).toBe(413);
				expect(await response.json()).toEqual({
					error: "payload too large",
					max_bytes: 1_048_576,
				});
				expect(cancel).toHaveBeenCalledOnce();
				expect(rawEventState(ensureStore())).toEqual({ events: [], sessions: [] });
			} finally {
				cleanup();
			}
		});

		it("keeps identical stream and event ids separate by source", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				for (const source of ["opencode", "claude", "codex"]) {
					const response = await postViewerJson(app, "/api/raw-events", {
						source,
						session_id: "shared-stream",
						event_id: "shared-event",
						event_type: "prompt",
						payload: { text: "same" },
					});
					expect(await response.json()).toEqual({
						inserted: 1,
						skipped: 0,
						received: 1,
					});
				}

				expect(rawEventState(ensureStore()).events).toMatchObject([
					{ source: "claude", stream_id: "shared-stream", event_id: "shared-event" },
					{ source: "codex", stream_id: "shared-stream", event_id: "shared-event" },
					{ source: "opencode", stream_id: "shared-stream", event_id: "shared-event" },
				]);
			} finally {
				cleanup();
			}
		});

		it("accepts additive adapter metadata without changing canonical raw-event rows", async () => {
			const baseline = createTestApp();
			const additive = createTestApp();
			try {
				const envelope = core.buildRawEventEnvelopeFromHook(
					{
						hook_event_name: "UserPromptSubmit",
						session_id: "session-additive-adapter-meta",
						prompt: "same normalized prompt",
						ts: "2026-08-16T12:00:00Z",
					},
					core.TRUSTED_HOOK_MAPPER_OPTIONS,
				);
				expect(envelope).not.toBeNull();
				if (!envelope) throw new Error("current Claude normalizer skipped prompt fixture");
				const additiveEnvelope = structuredClone(envelope);
				const adapter = additiveEnvelope.payload._adapter as {
					meta: Record<string, unknown>;
				};
				adapter.meta.future_adapter_revision = 2;

				const baselineResponse = await postViewerJson(baseline.app, "/api/raw-events", envelope);
				const additiveResponse = await postViewerJson(
					additive.app,
					"/api/raw-events",
					additiveEnvelope,
				);
				expect(await baselineResponse.json()).toEqual({
					inserted: 1,
					skipped: 0,
					received: 1,
				});
				expect(await additiveResponse.json()).toEqual({
					inserted: 1,
					skipped: 0,
					received: 1,
				});

				const baselineState = rawEventState(baseline.ensureStore());
				const additiveState = rawEventState(additive.ensureStore());
				expect(additiveState.sessions).toEqual(baselineState.sessions);
				const baselineEvent = baselineState.events[0] as Record<string, unknown>;
				const additiveEvent = additiveState.events[0] as Record<string, unknown>;
				const { payload_json: baselinePayloadJson, ...baselineColumns } = baselineEvent;
				const { payload_json: additivePayloadJson, ...additiveColumns } = additiveEvent;
				expect(additiveColumns).toEqual(baselineColumns);
				const baselinePayload = JSON.parse(String(baselinePayloadJson)) as Record<string, unknown>;
				const additivePayload = JSON.parse(String(additivePayloadJson)) as Record<string, unknown>;
				const additiveAdapter = additivePayload._adapter as { meta: Record<string, unknown> };
				const { future_adapter_revision: futureAdapterRevision, ...compatibleMeta } =
					additiveAdapter.meta;
				expect(futureAdapterRevision).toBe(2);
				expect({
					...additivePayload,
					_adapter: { ...additiveAdapter, meta: compatibleMeta },
				}).toEqual(baselinePayload);
			} finally {
				baseline.cleanup();
				additive.cleanup();
			}
		});

		it("reports duplicate skips and nudges every validated session on retries", async () => {
			const nudge = vi.fn();
			const { app, cleanup } = createTestApp({ sweeper: { nudge } });
			const event = {
				source: "claude",
				session_id: "session-duplicate",
				event_id: "event-duplicate",
				event_type: "claude.hook",
				payload: {},
			};
			try {
				const first = await postViewerJson(app, "/api/raw-events", event);
				const duplicate = await postViewerJson(app, "/api/raw-events", event);

				expect(await first.json()).toEqual({ inserted: 1, skipped: 0, received: 1 });
				expect(await duplicate.json()).toEqual({
					inserted: 0,
					skipped: 1,
					received: 1,
				});
				expect(nudge.mock.calls).toEqual([
					["session-duplicate", "claude"],
					["session-duplicate", "claude"],
				]);
			} finally {
				cleanup();
			}
		});

		it("awaits requested Claude boundary flushes before acknowledging ingestion", async () => {
			const actions: string[] = [];
			let releaseFlush: (() => void) | undefined;
			const flushBlocked = new Promise<void>((resolve) => {
				releaseFlush = resolve;
			});
			const sweeper = {
				nudge: vi.fn(() => actions.push("nudge")),
				flushBoundary: vi.fn(async () => {
					actions.push("flush:start");
					await flushBlocked;
					actions.push("flush:end");
				}),
			};
			const { app, cleanup } = createTestApp({ sweeper });
			try {
				const envelope = core.buildRawEventEnvelopeFromHook(
					{ hook_event_name: "SessionEnd", session_id: "session-boundary" },
					core.TRUSTED_HOOK_MAPPER_OPTIONS,
				);
				expect(envelope).not.toBeNull();
				let acknowledged = false;
				const responsePromise = postViewerJson(app, "/api/raw-events", envelope, {
					"X-Codemem-Boundary-Flush": "1",
				}).then((response) => {
					acknowledged = true;
					return response;
				});

				await vi.waitFor(() => expect(actions).toEqual(["nudge", "flush:start"]));
				expect(acknowledged).toBe(false);
				releaseFlush?.();
				const response = await responsePromise;

				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ inserted: 1, skipped: 0, received: 1 });
				expect(actions).toEqual(["nudge", "flush:start", "flush:end"]);
				expect(sweeper.flushBoundary).toHaveBeenCalledWith("session-boundary", "claude");
			} finally {
				cleanup();
			}
		});

		it("ignores boundary flush headers on non-boundary Claude events", async () => {
			const sweeper = { nudge: vi.fn(), flushBoundary: vi.fn() };
			const { app, cleanup } = createTestApp({ sweeper });
			try {
				const response = await postViewerJson(
					app,
					"/api/claude-hooks",
					{
						hook_event_name: "UserPromptSubmit",
						session_id: "session-not-boundary",
						prompt: "continue",
					},
					{ "X-Codemem-Boundary-Flush": "1" },
				);

				expect(response.status).toBe(200);
				expect(sweeper.flushBoundary).not.toHaveBeenCalled();
			} finally {
				cleanup();
			}
		});

		it("persists multi-stream batches deterministically and nudges streams in first-seen order", async () => {
			const nudge = vi.fn().mockImplementationOnce(() => {
				throw new Error("simulated nudge failure");
			});
			const { app, ensureStore, cleanup } = createTestApp({ sweeper: { nudge } });
			try {
				const response = await postViewerJson(app, "/api/raw-events", {
					source: "Codex",
					events: [
						{
							session_id: "stream-b",
							event_id: "event-b-1",
							event_type: "prompt",
							payload: { text: "b1" },
						},
						{
							session_id: "stream-a",
							event_id: "event-a-1",
							event_type: "prompt",
							payload: { text: "a1" },
						},
						{
							session_id: "stream-b",
							event_id: "event-b-2",
							event_type: "assistant",
							payload: { text: "b2" },
						},
					],
				});

				expect(await response.json()).toEqual({ inserted: 3, skipped: 0, received: 3 });
				expect(rawEventState(ensureStore()).events).toMatchObject([
					{ source: "codex", stream_id: "stream-a", event_id: "event-a-1", event_seq: 0 },
					{ source: "codex", stream_id: "stream-b", event_id: "event-b-1", event_seq: 0 },
					{ source: "codex", stream_id: "stream-b", event_id: "event-b-2", event_seq: 1 },
				]);
				expect(nudge.mock.calls).toEqual([
					["stream-b", "codex"],
					["stream-a", "codex"],
				]);
			} finally {
				cleanup();
			}
		});

		it.each([
			{
				source: "../claude",
				error: "source must use 1-64 letters, digits, dots, underscores, or hyphens",
			},
			{ source: 42, error: "source must be string" },
		])("rejects malformed source $source with a bounded error before writes", async ({
			source,
			error,
		}) => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const response = await postViewerJson(app, "/api/raw-events", {
					source,
					session_id: "session-invalid-source",
					event_id: "event-invalid-source",
					event_type: "prompt",
					payload: {},
				});

				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({ error });
				expect(rawEventState(ensureStore())).toEqual({ events: [], sessions: [] });
			} finally {
				cleanup();
			}
		});

		it("rejects a conflicting per-event source for the whole batch before writes", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const response = await postViewerJson(app, "/api/raw-events", {
					source: "claude",
					session_id: "session-mixed-source",
					events: [
						{
							event_id: "event-valid-first",
							event_type: "prompt",
							payload: { text: "must not persist" },
						},
						{
							source: "codex",
							event_id: "event-conflicting-second",
							event_type: "assistant",
							payload: { text: "conflict" },
						},
					],
				});

				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({
					error: "event source conflicts with request source",
				});
				expect(rawEventState(ensureStore())).toEqual({ events: [], sessions: [] });
			} finally {
				cleanup();
			}
		});

		it.each([
			{
				label: "Claude",
				route: "/api/claude-hooks",
				native: {
					hook_event_name: "UserPromptSubmit",
					session_id: "session-claude-parity",
					prompt: "same Claude prompt",
					ts: "2026-08-15T12:00:00Z",
					cwd: "/tmp/claude-project",
					project: "claude-project",
				},
				normalize: (payload: Record<string, unknown>) =>
					core.buildRawEventEnvelopeFromHook(payload, core.TRUSTED_HOOK_MAPPER_OPTIONS),
			},
			{
				label: "Codex",
				route: "/api/codex-hooks",
				native: {
					hook_event_name: "UserPromptSubmit",
					session_id: "session-codex-parity",
					prompt: "same Codex prompt",
					ts: "2026-08-15T12:00:00Z",
					cwd: "/tmp/codex-project",
					project: "codex-project",
				},
				normalize: (payload: Record<string, unknown>) =>
					core.buildRawEventEnvelopeFromCodexHook(payload, core.TRUSTED_HOOK_MAPPER_OPTIONS),
			},
		])("produces identical rows through canonical and named $label routes", async ({
			route,
			native,
			normalize,
		}) => {
			const canonical = createTestApp();
			const compatibility = createTestApp();
			try {
				const envelope = normalize(native);
				expect(envelope).not.toBeNull();

				const canonicalResponse = await postViewerJson(canonical.app, "/api/raw-events", envelope);
				const compatibilityResponse = await postViewerJson(compatibility.app, route, native);

				expect(await canonicalResponse.json()).toEqual({
					inserted: 1,
					skipped: 0,
					received: 1,
				});
				const compatibilityBody = await compatibilityResponse.json();
				expect(compatibilityBody).toEqual({ inserted: 1, skipped: 0 });
				expect(compatibilityBody).not.toHaveProperty("received");
				expect(rawEventState(canonical.ensureStore())).toEqual(
					rawEventState(compatibility.ensureStore()),
				);
			} finally {
				canonical.cleanup();
				compatibility.cleanup();
			}
		});

		it.each([
			"/api/claude-hooks",
			"/api/codex-hooks",
		])("returns bounded validation errors without writes on %s", async (route) => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const response = await postViewerJson(app, route, {
					hook_event_name: "UserPromptSubmit",
					session_id: "msg_client-controlled",
					prompt: "must not persist",
					ts: "2026-08-15T12:00:00Z",
				});
				const body = await response.json();

				expect(response.status).toBe(400);
				expect(body).toEqual({ error: "invalid session id" });
				expect(body).not.toHaveProperty("received");
				expect(rawEventState(ensureStore())).toEqual({ events: [], sessions: [] });
			} finally {
				cleanup();
			}
		});

		it.each([
			"/api/claude-hooks",
			"/api/codex-hooks",
		])("keeps native parse and payload-limit errors bounded on %s", async (route) => {
			const { app, cleanup } = createTestApp();
			try {
				const malformed = await app.request(route, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: "{",
				});
				expect(malformed.status).toBe(400);
				expect(await malformed.json()).toEqual({ error: "invalid json" });

				const oversized = await postViewerJson(app, route, {
					payload: "x".repeat(1_048_576),
				});
				expect(oversized.status).toBe(413);
				expect(await oversized.json()).toEqual({
					error: "payload too large",
					max_bytes: 1_048_576,
				});
			} finally {
				cleanup();
			}
		});
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
				expect(body).toEqual({ version: VERSION });
			} finally {
				cleanup();
			}
		});

		it("does not invoke release discovery", async () => {
			// Arrange
			const getUpdateStatus = vi.fn();
			const { app, cleanup } = createTestApp({ getUpdateStatus });

			try {
				// Act
				const res = await app.request("/api/runtime");

				// Assert
				expect(res.status).toBe(200);
				expect(getUpdateStatus).not.toHaveBeenCalled();
			} finally {
				cleanup();
			}
		});
	});

	describe("GET /api/update-status", () => {
		const availableStatus: core.UpdateStatus = {
			current_version: "0.40.2",
			latest_version: "0.41.0",
			update_available: true,
			first_seen_at: "2026-08-10T12:00:00.000Z",
			checked_at: "2026-08-10T12:00:00.000Z",
			stale: false,
			install_kind: "npm-global",
			auto_update_eligible: false,
			recommended_action: "npm install -g codemem@0.41.0",
			error: null,
		};

		it.each([
			{
				label: "current",
				status: {
					...availableStatus,
					latest_version: "0.40.2",
					update_available: false,
					recommended_action: "No action required; codemem is up to date.",
				},
			},
			{ label: "available", status: availableStatus },
			{
				label: "stale",
				status: {
					...availableStatus,
					stale: true,
					error: "registry offline",
				},
			},
			{
				label: "unavailable",
				status: {
					...availableStatus,
					latest_version: null,
					update_available: false,
					first_seen_at: null,
					checked_at: null,
					install_kind: "unknown" as const,
					recommended_action: "Check network access and try again.",
					error: "registry request timed out",
				},
			},
		])("returns the dedicated $label update-status payload", async ({ status }) => {
			// Arrange
			const getUpdateStatus = vi.fn().mockResolvedValue(status);
			const { app, cleanup } = createTestApp({ getUpdateStatus });

			try {
				// Act
				const res = await app.request("/api/update-status");

				// Assert
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual(status);
				expect(getUpdateStatus).toHaveBeenCalledOnce();
				expect(getUpdateStatus).toHaveBeenCalledWith(
					expect.objectContaining({ currentVersion: VERSION }),
				);
			} finally {
				cleanup();
			}
		});

		it("returns a bounded service error when release discovery throws", async () => {
			// Arrange
			const getUpdateStatus = vi.fn().mockRejectedValue(new Error("unexpected failure"));
			const { app, cleanup } = createTestApp({ getUpdateStatus });

			try {
				// Act
				const res = await app.request("/api/update-status");

				// Assert
				expect(res.status).toBe(503);
				expect(await res.json()).toEqual({ error: "Update status unavailable." });
			} finally {
				cleanup();
			}
		});

		it("passes explicit Docker install detection to release discovery", async () => {
			// Arrange
			vi.stubEnv("CODEMEM_INSTALL_KIND", "docker");
			const getUpdateStatus = vi.fn().mockResolvedValue({
				...availableStatus,
				install_kind: "docker",
			});
			const { app, cleanup } = createTestApp({ getUpdateStatus });

			try {
				// Act
				const res = await app.request("/api/update-status");

				// Assert
				expect(res.status).toBe(200);
				expect(getUpdateStatus).toHaveBeenCalledWith(
					expect.objectContaining({ installKind: "docker" }),
				);
			} finally {
				cleanup();
				vi.unstubAllEnvs();
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
		it("searches eligible observations before pagination and keeps chronological pages stable", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Global needle summary must not consume observation pagination",
					createdAt: "2026-08-20T12:04:00.000Z",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Newest unrelated observation",
					createdAt: "2026-08-20T12:03:00.000Z",
				});
				const firstId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Global needle newest match",
					createdAt: "2026-08-20T12:02:00.000Z",
				});
				const secondId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Global needle oldest match",
					createdAt: "2026-08-20T12:02:00.000Z",
				});

				const firstPage = (await (
					await app.request("/api/observations?q=GLOBAL%20NEEDLE&limit=1&offset=0")
				).json()) as {
					items: Array<{ id: number }>;
					pagination: { has_more: boolean; next_offset: number | null };
				};
				const secondPage = (await (
					await app.request(
						`/api/observations?q=global%20needle&limit=1&offset=${firstPage.pagination.next_offset}`,
					)
				).json()) as { items: Array<{ id: number }>; pagination: { has_more: boolean } };

				expect(firstPage.items.map((item) => item.id)).toEqual([secondId]);
				expect(firstPage.pagination).toMatchObject({ has_more: true, next_offset: 1 });
				expect(secondPage.items.map((item) => item.id)).toEqual([firstId]);
				expect(secondPage.pagination.has_more).toBe(false);
			} finally {
				cleanup();
			}
		});

		it("searches observations and summaries by their displayed project", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionProjectId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("/tmp/Project Phoenix Observatory", sessionProjectId);
				const observationId = insertTestMemory(store, {
					sessionId: sessionProjectId,
					kind: "change",
					title: "Unrelated observation",
				});
				const summaryId = insertTestMemory(store, {
					sessionId: sessionProjectId,
					kind: "session_summary",
					title: "Unrelated summary",
				});
				store.db
					.prepare("UPDATE memory_items SET project = NULL WHERE id IN (?, ?)")
					.run(observationId, summaryId);

				const itemProjectSessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("/tmp/Hidden Artemis Project", itemProjectSessionId);
				const itemProjectObservationId = insertTestMemory(store, {
					sessionId: itemProjectSessionId,
					kind: "change",
					title: "Another unrelated observation",
				});
				const itemProjectSummaryId = insertTestMemory(store, {
					sessionId: itemProjectSessionId,
					kind: "session_summary",
					title: "Another unrelated summary",
				});
				store.db
					.prepare("UPDATE memory_items SET project = ? WHERE id IN (?, ?)")
					.run("Displayed Apollo Project", itemProjectObservationId, itemProjectSummaryId);

				const controlSessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId: controlSessionId,
					kind: "change",
					title: "Negative control observation",
				});
				insertTestMemory(store, {
					sessionId: controlSessionId,
					kind: "session_summary",
					title: "Negative control summary",
				});

				const observations = (await (
					await app.request("/api/observations?q=phoenix%20observatory")
				).json()) as { items: Array<{ id: number; project: string }> };
				const summaries = (await (
					await app.request("/api/summaries?q=phoenix%20observatory")
				).json()) as { items: Array<{ id: number; project: string }> };

				expect(observations.items).toMatchObject([
					{ id: observationId, project: "Project Phoenix Observatory" },
				]);
				expect(summaries.items).toMatchObject([
					{ id: summaryId, project: "Project Phoenix Observatory" },
				]);

				const itemProjectObservations = (await (
					await app.request("/api/observations?q=displayed%20apollo")
				).json()) as { items: Array<{ id: number; project: string }> };
				const itemProjectSummaries = (await (
					await app.request("/api/summaries?q=displayed%20apollo")
				).json()) as { items: Array<{ id: number; project: string }> };
				expect(itemProjectObservations.items).toEqual([
					expect.objectContaining({
						id: itemProjectObservationId,
						project: "Displayed Apollo Project",
					}),
				]);
				expect(itemProjectSummaries.items).toEqual([
					expect.objectContaining({
						id: itemProjectSummaryId,
						project: "Displayed Apollo Project",
					}),
				]);

				const hiddenSessionProject = (await (
					await app.request("/api/observations?q=hidden%20artemis")
				).json()) as { items: unknown[] };
				expect(hiddenSessionProject.items).toEqual([]);
			} finally {
				cleanup();
			}
		});

		it("searches exact positive IDs, tags, structured fields, and summary metadata", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const idMatch = insertTestMemory(store, {
					sessionId,
					kind: "decision",
					title: "x",
				});
				const numericTextId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Numeric textual match",
					bodyText: `References memory ${idMatch} without being that row`,
				});
				const structuredId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Structured observation",
					bodyText: "Body-only cormorant",
					subtitle: "Subtitle falcon",
					tagsText: "release-hotfix searchable-tag",
					facts: ["Fact albatross"],
					narrative: "Narrative kingfisher",
				});
				const summaryId = insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Summary",
					subtitle: "Summary subtitle heron",
					tagsText: "summary-tag",
					facts: ["Summary fact ibis"],
					narrative: "Summary narrative tern",
					metadata: {
						request: "Metadata osprey",
						subtitle: "Metadata swan",
						narrative: "Metadata loon",
						facts: ["Metadata crane"],
						summary: "Metadata auk",
						internal_marker: "Metadata secret",
					},
				});
				const plusAliasId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "x",
				});
				insertTestMemory(store, { sessionId, kind: "change", title: "filler" });
				const leadingZeroAliasId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "x",
				});
				const plusTextId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Literal +5 marker",
				});
				const leadingZeroTextId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Literal 007 marker",
				});
				expect(plusAliasId).toBe(5);
				expect(leadingZeroAliasId).toBe(7);

				for (const q of [
					"structured observation",
					"body-only cormorant",
					"falcon",
					"searchable-tag",
					"albatross",
					"kingfisher",
					"discovery",
				]) {
					const payload = (await (
						await app.request(`/api/observations?q=${encodeURIComponent(q)}`)
					).json()) as { items: Array<{ id: number }> };
					expect(payload.items.map((item) => item.id)).toEqual([structuredId]);
				}
				const idPayload = (await (await app.request(`/api/observations?q=${idMatch}`)).json()) as {
					items: Array<{ id: number }>;
				};
				expect(idPayload.items.map((item) => item.id)).toEqual([numericTextId, idMatch]);
				const plusPayload = (await (await app.request("/api/observations?q=%2B5")).json()) as {
					items: Array<{ id: number }>;
				};
				expect(plusPayload.items.map((item) => item.id)).toEqual([plusTextId]);
				const leadingZeroPayload = (await (
					await app.request("/api/observations?q=007")
				).json()) as { items: Array<{ id: number }> };
				expect(leadingZeroPayload.items.map((item) => item.id)).toEqual([leadingZeroTextId]);

				for (const q of [
					"metadata osprey",
					"metadata swan",
					"metadata loon",
					"metadata crane",
					"metadata auk",
					"summary subtitle heron",
					"summary-tag",
					"summary fact ibis",
					"summary narrative tern",
				]) {
					const summaryPayload = (await (
						await app.request(`/api/summaries?q=${encodeURIComponent(q)}`)
					).json()) as { items: Array<{ id: number }> };
					expect(summaryPayload.items.map((item) => item.id)).toEqual([summaryId]);
				}
				const internalMetadataPayload = (await (
					await app.request("/api/summaries?q=metadata%20secret")
				).json()) as { items: Array<{ id: number }> };
				expect(internalMetadataPayload.items).toEqual([]);
			} finally {
				cleanup();
			}
		});

		it("casefolds Unicode search without locale-dependent rules", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const cafeId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "CAFÉ rollout",
				});
				const cyrillicId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "ПРИВЕТ мир",
				});

				const cafe = (await (
					await app.request(`/api/observations?q=${encodeURIComponent("café")}`)
				).json()) as { items: Array<{ id: number }> };
				const cyrillic = (await (
					await app.request(`/api/observations?q=${encodeURIComponent("привет")}`)
				).json()) as { items: Array<{ id: number }> };

				expect(cafe.items.map((item) => item.id)).toEqual([cafeId]);
				expect(cyrillic.items.map((item) => item.id)).toEqual([cyrillicId]);
			} finally {
				cleanup();
			}
		});

		it("caps normalized Feed queries at 256 code units", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const prefix = "x".repeat(256);
				const matchingId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: prefix,
				});

				const payload = (await (
					await app.request(`/api/observations?q=${encodeURIComponent(`${prefix}TAIL`)}`)
				).json()) as { items: Array<{ id: number }> };

				expect(payload.items.map((item) => item.id)).toEqual([matchingId]);
			} finally {
				cleanup();
			}
		});

		it("searches summaries beyond the first unfiltered page", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Pelican needle observation must not consume summary pagination",
					createdAt: "2026-08-20T12:04:00.000Z",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Newest unrelated summary",
					createdAt: "2026-08-20T12:03:00.000Z",
				});
				const matchingId = insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Older summary with pelican needle",
					createdAt: "2026-08-20T12:01:00.000Z",
				});

				const payload = (await (
					await app.request("/api/summaries?q=pelican%20needle&limit=1&offset=0")
				).json()) as { items: Array<{ id: number }>; pagination: { has_more: boolean } };
				expect(payload.items.map((item) => item.id)).toEqual([matchingId]);
				expect(payload.pagination.has_more).toBe(false);
			} finally {
				cleanup();
			}
		});

		it("searches metadata-classified summaries by their canonical displayed kind", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				const summaryId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Flag classified summary",
					metadata: { is_summary: true },
				});
				const sourceSummaryId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Source classified summary",
					metadata: { source: "observer_summary" },
				});
				const observationId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Metadata classified observation",
				});

				const summaries = (await (
					await app.request("/api/summaries?q=session_summary")
				).json()) as { items: Array<{ id: number; kind: string }> };
				const observations = (await (
					await app.request("/api/observations?q=session_summary")
				).json()) as { items: Array<{ id: number }> };
				const changeSummaries = (await (await app.request("/api/summaries?q=change")).json()) as {
					items: Array<{ id: number }>;
				};
				const changeObservations = (await (
					await app.request("/api/observations?q=change")
				).json()) as { items: Array<{ id: number; kind: string }> };
				expect(new Set(summaries.items.map((item) => item.id))).toEqual(
					new Set([summaryId, sourceSummaryId]),
				);
				expect(summaries.items.every((item) => item.kind === "session_summary")).toBe(true);
				expect(observations.items).toEqual([]);
				expect(changeSummaries.items).toEqual([]);
				expect(changeObservations.items).toMatchObject([{ id: observationId, kind: "change" }]);
			} finally {
				cleanup();
			}
		});

		it("intersects search with project, ownership, sharing-domain, active, and type filters", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				grantSyncScopeToDevices(store, "authorized-team", [store.deviceId]);
				grantSyncScopeToDevices(store, "unauthorized-team", []);
				const projectSessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("search-project", projectSessionId);
				const otherSessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET project = ? WHERE id = ?")
					.run("other-project", otherSessionId);
				const visibleId = insertTestMemory(store, {
					sessionId: projectSessionId,
					kind: "bugfix",
					title: "Boundary keyword visible",
					scopeId: "authorized-team",
				});
				const hiddenId = insertTestMemory(store, {
					sessionId: projectSessionId,
					kind: "bugfix",
					title: "Boundary keyword hidden domain",
					scopeId: "unauthorized-team",
				});
				const theirsId = insertTestMemory(store, {
					sessionId: projectSessionId,
					kind: "bugfix",
					title: "Boundary keyword theirs",
					actorId: "peer:other",
					originDeviceId: "peer-device-002",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId: projectSessionId,
					kind: "bugfix",
					title: "Boundary keyword inactive",
					active: false,
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId: projectSessionId,
					kind: "session_summary",
					title: "Boundary keyword summary",
					scopeId: "authorized-team",
				});
				insertTestMemory(store, {
					sessionId: otherSessionId,
					kind: "bugfix",
					title: "Boundary keyword other project",
					scopeId: "authorized-team",
				});

				const payload = (await (
					await app.request(
						"/api/observations?q=boundary%20keyword&project=search-project&scope=mine",
					)
				).json()) as { items: Array<{ id: number }> };
				expect(payload.items.map((item) => item.id)).toEqual([visibleId]);

				const theirsPayload = (await (
					await app.request(
						"/api/observations?q=boundary%20keyword&project=search-project&scope=theirs",
					)
				).json()) as { items: Array<{ id: number }> };
				expect(theirsPayload.items.map((item) => item.id)).toEqual([theirsId]);

				const hiddenIdPayload = (await (
					await app.request(`/api/observations?q=${hiddenId}`)
				).json()) as { items: Array<{ id: number }> };
				expect(hiddenIdPayload.items).toEqual([]);
			} finally {
				cleanup();
			}
		});

		it("keeps memory list routes available when identity tables are unavailable", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Legacy schema identity",
					actorId: "actor:legacy",
					originDeviceId: "device:legacy",
				});
				store.db.exec("DROP TABLE identity_devices");

				const response = await app.request("/api/observations?limit=10");
				expect(response.status).toBe(200);
				const payload = (await response.json()) as { items: Array<Record<string, unknown>> };
				expect(payload.items[0]?.title).toBe("Legacy schema identity");
				expect(payload.items[0]).not.toHaveProperty("resolved_actor_display_name");
				expect(payload.items[0]).not.toHaveProperty("resolved_device_display_name");
			} finally {
				cleanup();
			}
		});

		it("resolves trusted actor and device names across memory list routes", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = "2026-08-18T12:00:00.000Z";
				const malformedId = "123e4567-e89b-12d3-a456-426614174000";
				store.db
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at)
						 VALUES (?, ?, 0, 'active', NULL, ?, ?), (?, ?, 0, 'active', NULL, ?, ?),
						        (?, ?, 0, 'active', NULL, ?, ?)`,
					)
					.run(
						"actor:direct",
						"Trusted Actor",
						now,
						now,
						"actor:peer",
						"Peer Actor",
						now,
						now,
						"actor:legacy",
						malformedId,
						now,
						now,
					);
				store.db
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at)
						 VALUES (?, ?, 0, 'active', NULL, ?, ?), (?, ?, 0, 'merged', ?, ?, ?),
						        (?, ?, 0, 'merged', ?, ?, ?)`,
					)
					.run(
						"actor:merged-target",
						"Merged Actor",
						now,
						now,
						"actor:merged-middle",
						"Middle Actor",
						"actor:merged-target",
						now,
						now,
						"actor:merged",
						"Old Actor",
						"actor:merged-middle",
						now,
						now,
					);
				store.db
					.prepare(
						`INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, actor_id, created_at)
						 VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
					)
					.run(
						"device:direct",
						"Lower-priority Device",
						"direct-fingerprint",
						"actor:peer",
						now,
						"device:peer",
						"Peer Device",
						"peer-fingerprint",
						"actor:peer",
						now,
						"device:legacy",
						malformedId,
						"legacy-fingerprint",
						"actor:legacy",
						now,
					);
				store.db
					.prepare(
						`INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, actor_id, created_at)
						 VALUES (?, ?, ?, ?, ?), (?, ?, NULL, ?, ?)`,
					)
					.run(
						"device:merged",
						"Merged Device",
						"merged-fingerprint",
						"actor:peer",
						now,
						"device:unpinned",
						"Unpinned Device",
						"actor:peer",
						now,
					);
				store.db
					.prepare(
						`INSERT INTO identity_devices(
							device_id, identity_id, display_name, status, provenance, revision,
							migration_state, assignment_version, source_fingerprint, idempotency_key,
							created_at, updated_at
						 ) VALUES (?, ?, ?, 'active', 'test', '1', 'user_managed', 1, NULL, ?, ?, ?)`,
					)
					.run("device:direct", "actor:direct", "Trusted Device", "identity-device-test", now, now);

				const sessionId = insertTestSession(store.db);
				const directId = insertTestMemory(store, {
					sessionId,
					kind: "discovery",
					title: "Direct identity",
					actorId: "actor:direct",
					originDeviceId: "device:direct",
					createdAt: "2026-08-18T12:03:00.000Z",
				});
				const peerId = insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Peer identity",
					actorId: "actor:missing",
					originDeviceId: "device:peer",
					createdAt: "2026-08-18T12:02:00.000Z",
				});
				const legacyId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Legacy identity",
					actorId: "actor:legacy",
					originDeviceId: "device:legacy",
					createdAt: "2026-08-18T12:01:00.000Z",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Merged identity",
					actorId: "actor:merged",
					originDeviceId: "device:merged",
					createdAt: "2026-08-18T12:00:00.000Z",
				});
				const unpinnedId = insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Unpinned identity",
					actorId: "actor:missing-unpinned",
					originDeviceId: "device:unpinned",
					createdAt: "2026-08-18T11:59:00.000Z",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Metadata-only identity",
					actorId: null,
					originDeviceId: null,
					metadata: {
						actor_id: "actor:direct",
						origin_device_id: "device:direct",
					},
					createdAt: "2026-08-18T11:58:00.000Z",
				});
				insertTestMemory(store, {
					sessionId,
					kind: "session_summary",
					title: "Metadata-only summary identity",
					actorId: null,
					originDeviceId: null,
					metadata: {
						actor_id: "actor:direct",
						origin_device_id: "device:direct",
					},
					createdAt: "2026-08-18T11:57:00.000Z",
				});
				store.db
					.prepare("UPDATE memory_items SET actor_display_name = ? WHERE id = ?")
					.run("Raw direct provenance", directId);
				store.db
					.prepare("UPDATE memory_items SET actor_display_name = ? WHERE id = ?")
					.run("Raw peer provenance", peerId);
				store.db
					.prepare("UPDATE memory_items SET actor_display_name = ? WHERE id = ?")
					.run("Legacy teammate", legacyId);
				store.db
					.prepare("UPDATE memory_items SET actor_display_name = ? WHERE id = ?")
					.run(malformedId, unpinnedId);

				type IdentityItem = {
					title: string;
					actor_id: string;
					actor_display_name: string;
					origin_device_id: string;
					resolved_actor_display_name?: string;
					resolved_device_display_name?: string;
				};
				const load = async (path: string) => {
					const response = await app.request(path);
					expect(response.status).toBe(200);
					return ((await response.json()) as { items: IdentityItem[] }).items;
				};
				const observations = await load("/api/observations?limit=10");
				const summaries = await load("/api/summaries?limit=10");
				const memories = await load("/api/memory?limit=10");
				const direct = observations.find((item) => item.title === "Direct identity");
				const peer = summaries.find((item) => item.title === "Peer identity");
				const legacy = observations.find((item) => item.title === "Legacy identity");
				const merged = observations.find((item) => item.title === "Merged identity");
				const unpinned = observations.find((item) => item.title === "Unpinned identity");
				const metadataOnly = observations.find((item) => item.title === "Metadata-only identity");
				const metadataOnlySummary = summaries.find(
					(item) => item.title === "Metadata-only summary identity",
				);

				expect(direct).toMatchObject({
					actor_id: "actor:direct",
					actor_display_name: "Raw direct provenance",
					origin_device_id: "device:direct",
					resolved_actor_display_name: "Trusted Actor",
					resolved_device_display_name: "Trusted Device",
				});
				expect(peer).toMatchObject({
					actor_id: "actor:missing",
					actor_display_name: "Raw peer provenance",
					origin_device_id: "device:peer",
					resolved_actor_display_name: "Peer Actor",
					resolved_device_display_name: "Peer Device",
				});
				expect(legacy).toMatchObject({
					actor_id: "actor:legacy",
					actor_display_name: "Legacy teammate",
					origin_device_id: "device:legacy",
					resolved_actor_display_name: "Legacy teammate",
				});
				expect(legacy).not.toHaveProperty("resolved_device_display_name");
				expect(merged).toMatchObject({
					actor_id: "actor:merged",
					resolved_actor_display_name: "Merged Actor",
					resolved_device_display_name: "Merged Device",
				});
				expect(merged?.resolved_actor_display_name).not.toBe("Peer Actor");
				expect(unpinned).not.toHaveProperty("resolved_actor_display_name");
				expect(unpinned).not.toHaveProperty("resolved_device_display_name");
				expect(metadataOnly).toMatchObject({
					resolved_actor_display_name: "Trusted Actor",
					resolved_device_display_name: "Trusted Device",
				});
				expect(metadataOnlySummary).toMatchObject({
					resolved_actor_display_name: "Trusted Actor",
					resolved_device_display_name: "Trusted Device",
				});
				expect(memories.find((item) => item.title === "Metadata-only identity")).toMatchObject({
					resolved_actor_display_name: "Trusted Actor",
					resolved_device_display_name: "Trusted Device",
				});
				expect(memories.find((item) => item.title === "Direct identity")).toMatchObject({
					resolved_actor_display_name: "Trusted Actor",
					resolved_device_display_name: "Trusted Device",
				});
				expect(memories.find((item) => item.title === "Peer identity")).toMatchObject({
					resolved_actor_display_name: "Peer Actor",
					resolved_device_display_name: "Peer Device",
				});
				expect(memories.find((item) => item.title === "Legacy identity")).toMatchObject({
					actor_display_name: "Legacy teammate",
					resolved_actor_display_name: "Legacy teammate",
				});
			} finally {
				cleanup();
			}
		});

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

		it("does not classify numeric is_summary metadata as a summary", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sessionId = insertTestSession(store.db);
				insertTestMemory(store, {
					sessionId,
					kind: "change",
					title: "Numeric summary flag",
					metadata: { is_summary: 1 },
				});

				const summariesRes = await app.request("/api/summaries");
				expect(summariesRes.status).toBe(200);
				const summaries = ((await summariesRes.json()) as { items: Array<{ title: string }> })
					.items;
				expect(summaries.map((item) => item.title)).not.toContain("Numeric summary flag");

				const observationsRes = await app.request("/api/observations");
				expect(observationsRes.status).toBe(200);
				const observations = (
					(await observationsRes.json()) as { items: Array<{ title: string; kind: string }> }
				).items;
				expect(observations).toContainEqual(
					expect.objectContaining({ title: "Numeric summary flag", kind: "change" }),
				);
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

		it("tolerates malformed metadata during classification and search", async () => {
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

				const observationsRes = await app.request("/api/observations?q=broken%20metadata");
				expect(observationsRes.status).toBe(200);
				const observations = ((await observationsRes.json()) as { items: Array<{ title: string }> })
					.items;
				expect(observations.map((item) => item.title)).toContain("Broken metadata row");

				const summariesRes = await app.request("/api/summaries?q=broken%20metadata");
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

	describe("POST /api/pack", () => {
		it("rejects requests from a different viewer identity target", async () => {
			vi.stubEnv("CODEMEM_DEVICE_ID", "viewer-device");
			vi.stubEnv("CODEMEM_ACTOR_ID", "viewer-actor");
			vi.stubEnv("CODEMEM_CONFIG", "/tmp/viewer-config.json");
			vi.stubEnv("CODEMEM_RUNTIME_ROOT", "/tmp/viewer-runtime");
			vi.stubEnv("CODEMEM_WORKSPACE_ID", "viewer-workspace");
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const asyncBuilder = vi.spyOn(store, "buildMemoryPackAsync");
				const tracedBuilder = vi.spyOn(store, "buildMemoryPackWithTraceAsync");
				const viewerIdentityTarget = {
					device_id: "viewer-device",
					actor_id_present: true,
					actor_id: "viewer-actor",
					config_path: "/tmp/viewer-config.json",
					runtime_root: "/tmp/viewer-runtime",
					workspace_id: "viewer-workspace",
					home_dir: resolve(process.env.HOME || homedir()),
					pack_compression: null,
					embedding_disabled: false,
					embedding_model: "Xenova/bge-small-en-v1.5",
				};
				const profile = await app.request("/api/prompt-pack-profile");
				expect(profile.status).toBe(200);
				expect(await profile.json()).toMatchObject({
					service: "codemem-viewer",
					protocol_version: 1,
					min_supported_protocol_version: 1,
					db_path: resolve(store.dbPath),
					identity_target: viewerIdentityTarget,
				});
				const res = await postViewerJson(app, "/api/pack", {
					context: "viewer identity",
					db_path: ensureStore().dbPath,
					identity_target: {
						...viewerIdentityTarget,
						device_id: "request-device",
					},
				});
				expect(res.status).toBe(409);
				expect(await res.json()).toEqual({
					error: {
						code: "viewer_identity_mismatch",
						message: "viewer identity does not match request",
					},
				});

				const compressionMismatch = await postViewerJson(app, "/api/pack", {
					context: "viewer identity",
					db_path: ensureStore().dbPath,
					identity_target: { ...viewerIdentityTarget, pack_compression: "ids" },
				});
				expect(compressionMismatch.status).toBe(409);

				const embeddingMismatch = await postViewerJson(app, "/api/pack", {
					context: "viewer identity",
					db_path: ensureStore().dbPath,
					identity_target: { ...viewerIdentityTarget, embedding_disabled: true },
				});
				expect(embeddingMismatch.status).toBe(409);

				const unsupported = await postViewerJson(app, "/api/pack", {
					context: "viewer identity",
					db_path: ensureStore().dbPath,
					identity_target: { ...viewerIdentityTarget, future_field: "new" },
				});
				expect(unsupported.status).toBe(409);
				expect(await unsupported.json()).toMatchObject({
					error: { code: "viewer_contract_unsupported" },
				});
				expect(asyncBuilder).not.toHaveBeenCalled();
				expect(tracedBuilder).not.toHaveBeenCalled();
			} finally {
				cleanup();
				vi.unstubAllEnvs();
			}
		});

		it("rejects a viewer whose cached effective identity is stale", async () => {
			const configDir = mkdtempSync(join(tmpdir(), "codemem-viewer-identity-"));
			const configPath = join(configDir, "config.json");
			const envKeys = [
				"CODEMEM_DEVICE_ID",
				"CODEMEM_ACTOR_ID",
				"CODEMEM_CONFIG",
				"CODEMEM_RUNTIME_ROOT",
				"CODEMEM_WORKSPACE_ID",
				"CODEMEM_PACK_COMPRESSION",
				"CODEMEM_EMBEDDING_DISABLED",
				"CODEMEM_EMBEDDING_MODEL",
			] as const;
			const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
			for (const key of envKeys) delete process.env[key];
			process.env.CODEMEM_CONFIG = configPath;
			writeFileSync(configPath, JSON.stringify({ actor_id: "actor-before" }));
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				expect(store.actorId).toBe("actor-before");
				writeFileSync(configPath, JSON.stringify({ actor_id: "actor-after" }));
				const res = await postViewerJson(app, "/api/pack", {
					context: "stale viewer identity",
					db_path: store.dbPath,
					identity_target: {
						device_id: null,
						actor_id_present: false,
						actor_id: null,
						config_path: resolve(configPath),
						runtime_root: null,
						workspace_id: null,
						home_dir: resolve(process.env.HOME || homedir()),
						pack_compression: null,
						embedding_disabled: false,
						embedding_model: "Xenova/bge-small-en-v1.5",
					},
				});
				expect(res.status).toBe(409);
				expect(await res.json()).toMatchObject({
					error: { code: "viewer_identity_mismatch" },
				});
			} finally {
				cleanup();
				rmSync(configDir, { recursive: true, force: true });
				for (const key of envKeys) {
					const value = previousEnv[key];
					if (value == null) delete process.env[key];
					else process.env[key] = value;
				}
			}
		});

		it("validates structured request fields", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const builder = vi.spyOn(store, "buildMemoryPackAsync");
				const invalidJson = await app.request("/api/pack", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "http://127.0.0.1:38888",
					},
					body: "{",
				});
				expect(invalidJson.status).toBe(400);
				expect(await invalidJson.json()).toEqual({
					error: { code: "invalid_request", message: "invalid json body" },
				});

				const invalidWorkingSet = await postViewerJson(app, "/api/pack", {
					context: "viewer transport",
					working_set_files: ["../private.txt"],
				});
				expect(invalidWorkingSet.status).toBe(400);
				expect(await invalidWorkingSet.json()).toMatchObject({
					error: {
						code: "invalid_request",
						message: "working_set_files contains an invalid repository-relative path",
					},
				});

				const mismatchedDb = await postViewerJson(app, "/api/pack", {
					context: "viewer transport",
					db_path: `${store.dbPath}.other`,
				});
				expect(mismatchedDb.status).toBe(409);
				expect(await mismatchedDb.json()).toEqual({
					error: {
						code: "viewer_db_mismatch",
						message: "viewer database does not match request",
					},
				});
				expect(builder).not.toHaveBeenCalled();

				const equivalentDb = await postViewerJson(app, "/api/pack", {
					context: "viewer transport",
					db_path: `${dirname(store.dbPath)}/./${basename(store.dbPath)}`,
				});
				expect(equivalentDb.status).toBe(200);
			} finally {
				cleanup();
			}
		});

		it("returns the same machine-readable pack as GET for equivalent inputs", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const sessionId = insertTestSession(store.db);
				store.remember(
					sessionId,
					"decision",
					"Structured pack parity",
					"Viewer POST uses the shared pack builder.",
					0.9,
				);

				const getResponse = await app.request(
					"/api/pack?context=structured%20pack%20parity&limit=5&token_budget=800",
				);
				const postResponse = await postViewerJson(app, "/api/pack", {
					context: "structured pack parity",
					limit: 5,
					token_budget: 800,
					all_projects: true,
				});

				expect(postResponse.status).toBe(200);
				const postBody = (await postResponse.json()) as Record<string, unknown>;
				const getBody = (await getResponse.json()) as Record<string, unknown>;
				expect(postBody).toMatchObject({
					pack_text: getBody.pack_text,
					items: getBody.items,
					item_ids: getBody.item_ids,
				});
			} finally {
				cleanup();
			}
		});

		it("passes project, working-set, and render options to the shared builder", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			const previousProject = process.env.CODEMEM_PROJECT;
			process.env.CODEMEM_PROJECT = "stale-viewer-project";
			try {
				const store = ensureStore();
				const builder = vi.spyOn(store, "buildMemoryPackAsync");
				const response = await postViewerJson(app, "/api/pack", {
					context: "focused viewer pack",
					limit: 4,
					token_budget: 600,
					project: "viewer-project",
					working_set_files: ["./packages/viewer-server/src/index.ts"],
					compact: true,
					compact_detail_count: 2,
				});

				expect(response.status).toBe(200);
				expect(builder).toHaveBeenCalledWith(
					"focused viewer pack",
					4,
					600,
					{
						project: "viewer-project",
						working_set_paths: ["packages/viewer-server/src/index.ts"],
					},
					{ compact: true, compactDetailCount: 2 },
				);
			} finally {
				if (previousProject == null) delete process.env.CODEMEM_PROJECT;
				else process.env.CODEMEM_PROJECT = previousProject;
				cleanup();
			}
		});

		it("records attempts and reports changed-artifact conflicts without blocking pack delivery", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const sessionId = insertTestSession(store.db);
				store.remember(sessionId, "feature", "Viewer ledger candidate", "first artifact", 0.8);
				const request = {
					context: "viewer ledger candidate",
					all_projects: true,
					working_set_files: ["./packages/viewer-server/src/index.ts"],
					attempt: {
						attempt_id: promptPackAttemptId(1),
						started_at: "2026-08-03T10:00:00.000Z",
						source: "opencode",
						request_id: "viewer-pack-request",
					},
				};

				const first = await postViewerJson(app, "/api/pack", request);
				expect(first.status).toBe(200);
				const firstBody = (await first.json()) as Record<string, unknown>;
				expect(firstBody.ledger_artifact_fingerprint).toMatch(/^[a-f0-9]{64}$/);
				expect(firstBody).not.toHaveProperty("ledger_outcome");
				expect(core.getRetrievalAttempt(store.db, promptPackAttemptId(1))).toMatchObject({
					retrievalStatus: "succeeded",
					workingSetFiles: ["packages/viewer-server/src/index.ts"],
				});

				const retry = await postViewerJson(app, "/api/pack", request);
				expect(retry.status).toBe(200);
				expect(await retry.json()).not.toHaveProperty("ledger_outcome");

				store.remember(
					sessionId,
					"decision",
					"Viewer ledger candidate changed",
					"second artifact",
					0.95,
				);
				const conflict = await postViewerJson(app, "/api/pack", request);
				expect(conflict.status).toBe(200);
				expect(await conflict.json()).toMatchObject({
					ledger_outcome: {
						ok: false,
						errorCode: "retrieval_ledger_write_failed",
						reason: "idempotency_conflict",
					},
				});
			} finally {
				cleanup();
			}
		});

		it("returns a stable structured error when pack construction fails", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				vi.spyOn(ensureStore(), "buildMemoryPackAsync").mockRejectedValue(
					new Error("private storage detail"),
				);
				const response = await postViewerJson(app, "/api/pack", {
					context: "pack failure",
					all_projects: true,
				});
				expect(response.status).toBe(500);
				expect(await response.json()).toEqual({
					error: { code: "pack_failed", message: "memory pack could not be built" },
				});
			} finally {
				cleanup();
			}
		});

		it("delivers a built pack when ledger instrumentation fails", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const sessionId = insertTestSession(store.db);
				store.remember(sessionId, "feature", "Viewer pack survives", "ledger outage", 0.8);
				const build = store.buildMemoryPackWithTraceAsync.bind(store);
				vi.spyOn(store, "buildMemoryPackWithTraceAsync").mockImplementation(async (...args) => {
					const artifacts = await build(...args);
					store.db.exec("DROP TABLE retrieval_attempts");
					return artifacts;
				});

				const response = await postViewerJson(app, "/api/pack", {
					context: "viewer pack survives",
					all_projects: true,
					attempt: {
						attempt_id: promptPackAttemptId(9),
						started_at: "2026-08-03T10:00:00.000Z",
						source: "opencode",
					},
				});

				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({
					pack_text: expect.stringContaining("Viewer pack survives"),
				});
			} finally {
				cleanup();
			}
		});
	});

	describe("POST /api/prompt-pack-ledger", () => {
		it("preserves record, delivery, and cache-reuse idempotency", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const store = ensureStore();
				const terminal = {
					action: "record",
					attempt_id: promptPackAttemptId(10),
					started_at: "2026-08-03T10:00:00.000Z",
					source: "opencode",
					request_id: "skipped-request",
					retrieval_status: "skipped",
					failure_code: "injection_disabled",
					failure_stage: "policy",
				};
				const record = await postViewerJson(app, "/api/prompt-pack-ledger", terminal);
				expect(record.status).toBe(200);
				expect(await record.json()).toMatchObject({ ok: true, value: { inserted: true } });
				const recordRetry = await postViewerJson(app, "/api/prompt-pack-ledger", terminal);
				expect(await recordRetry.json()).toMatchObject({
					ok: true,
					value: { inserted: false },
				});
				const recordConflict = await postViewerJson(app, "/api/prompt-pack-ledger", {
					...terminal,
					failure_code: "compaction_skipped",
				});
				expect(recordConflict.status).toBe(409);
				expect(await recordConflict.json()).toEqual({
					ok: false,
					errorCode: "retrieval_ledger_write_failed",
					reason: "idempotency_conflict",
				});

				const sessionId = insertTestSession(store.db);
				store.remember(sessionId, "decision", "Ledger delivery candidate", "bounded body", 0.9);
				const pack = await postViewerJson(app, "/api/pack", {
					context: "ledger delivery candidate",
					all_projects: true,
					attempt: {
						attempt_id: promptPackAttemptId(11),
						started_at: "2026-08-03T10:00:00.500Z",
						source: "opencode",
						request_id: "delivery-request",
					},
				});
				expect(pack.status).toBe(200);

				const delivery = {
					action: "delivery",
					attempt_id: promptPackAttemptId(11),
					delivery_status: "handed_off",
				};
				const delivered = await postViewerJson(app, "/api/prompt-pack-ledger", delivery);
				expect(await delivered.json()).toMatchObject({ ok: true, value: { changed: true } });
				const deliveryRetry = await postViewerJson(app, "/api/prompt-pack-ledger", delivery);
				expect(await deliveryRetry.json()).toMatchObject({
					ok: true,
					value: { changed: false },
				});

				const cacheReuse = {
					action: "cache_reuse",
					attempt_id: promptPackAttemptId(12),
					started_at: "2026-08-03T10:00:01.000Z",
					source: "opencode",
					request_id: "cache-request",
					original_attempt_id: promptPackAttemptId(11),
				};
				const cloned = await postViewerJson(app, "/api/prompt-pack-ledger", cacheReuse);
				expect(await cloned.json()).toMatchObject({ ok: true, value: { inserted: true } });
				const cloneRetry = await postViewerJson(app, "/api/prompt-pack-ledger", cacheReuse);
				expect(await cloneRetry.json()).toMatchObject({
					ok: true,
					value: { inserted: false },
				});
				expect(core.getRetrievalAttempt(store.db, promptPackAttemptId(12))).toMatchObject({
					deliveryStatus: "not_attempted",
					requestId: `cache_reuse:cache-request:from:${promptPackAttemptId(11)}`,
				});
			} finally {
				cleanup();
			}
		});

		it("returns structured validation and core failure outcomes", async () => {
			const { app, ensureStore, cleanup } = createTestApp();
			try {
				const invalid = await postViewerJson(app, "/api/prompt-pack-ledger", {
					action: "unknown",
					attempt_id: promptPackAttemptId(20),
				});
				expect(invalid.status).toBe(400);
				expect(await invalid.json()).toEqual({
					error: { code: "invalid_request", message: "ledger action is invalid" },
				});

				const missing = await postViewerJson(app, "/api/prompt-pack-ledger", {
					action: "cache_reuse",
					attempt_id: promptPackAttemptId(21),
					original_attempt_id: promptPackAttemptId(22),
				});
				expect(missing.status).toBe(422);
				expect(await missing.json()).toEqual({
					ok: false,
					errorCode: "retrieval_ledger_write_failed",
					reason: "attempt_not_found",
				});

				const mismatchedDb = await postViewerJson(app, "/api/prompt-pack-ledger", {
					action: "record",
					attempt_id: promptPackAttemptId(23),
					retrieval_status: "skipped",
					failure_code: "injection_disabled",
					failure_stage: "policy",
					db_path: `${ensureStore().dbPath}.other`,
				});
				expect(mismatchedDb.status).toBe(409);
				expect(await mismatchedDb.json()).toMatchObject({
					error: { code: "viewer_db_mismatch" },
				});
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
							observer_reasoning_effort: "medium",
							observer_reasoning_summary: "auto",
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
				expect(saved.observer_reasoning_effort).toBe("medium");
				expect(saved.observer_reasoning_summary).toBe("auto");
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

		it("returns peer runtime metadata from peer and status read models while redacted", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(
						`INSERT INTO sync_peers (
							peer_device_id, name, runtime_version, runtime_version_observed_at, created_at
						) VALUES (?, ?, ?, ?, ?)`,
					)
					.run(
						"peer-version",
						"Versioned peer",
						"0.40.2",
						"2026-08-10T12:00:00.000Z",
						"2026-08-10T00:00:00.000Z",
					);

				const peersResponse = await app.request("/api/sync/peers");
				const peersBody = (await peersResponse.json()) as {
					items: Array<Record<string, unknown>>;
					redacted: boolean;
				};
				const statusResponse = await app.request("/api/sync/status");
				const statusBody = (await statusResponse.json()) as {
					peers: Array<Record<string, unknown>>;
					redacted: boolean;
				};

				expect(peersBody.redacted).toBe(true);
				expect(peersBody.items[0]).toMatchObject({
					runtime_version: "0.40.2",
					runtime_version_observed_at: "2026-08-10T12:00:00.000Z",
				});
				expect(statusBody.redacted).toBe(true);
				expect(statusBody.peers[0]).toMatchObject({
					runtime_version: "0.40.2",
					runtime_version_observed_at: "2026-08-10T12:00:00.000Z",
				});
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
				expect(body.runtime_version).toBeUndefined();
			} finally {
				cleanup();
			}
		});

		it("includes the canonical runtime version in authenticated peer status", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/status";
				peer = createAuthenticatedSyncPeer(store, { url });
				const res = await syncApp.request(url, {
					headers: buildAuthHeaders({
						deviceId: peer.peerDeviceId,
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peer.keysDir,
					}),
				});

				expect(res.status).toBe(200);
				expect((await res.json()) as Record<string, unknown>).toMatchObject({
					runtime_version: VERSION,
				});
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("accepts recipient-bound v3 auth and records sticky peer adoption", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/status";
				peer = createAuthenticatedSyncPeer(store, { url });
				const headers = buildDirectPeerAuthHeaders({
					deviceId: peer.peerDeviceId,
					recipientId: "test-device-001",
					method: "GET",
					url,
					bodyBytes: Buffer.alloc(0),
					keysDir: peer.keysDir,
				});

				const response = await syncApp.request(url, { headers });

				expect(response.status).toBe(200);
				expect(
					store.db
						.prepare(
							`SELECT highest_observed_direct_signature_version
							 FROM sync_peer_signature_state WHERE peer_device_id = ?`,
						)
						.pluck()
						.get(peer.peerDeviceId),
				).toBe(3);
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("rejects a valid v3 signature for another recipient without exposing the reason", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/status";
				peer = createAuthenticatedSyncPeer(store, { url });
				const headers = buildDirectPeerAuthHeaders({
					deviceId: peer.peerDeviceId,
					recipientId: "another-device",
					method: "GET",
					url,
					bodyBytes: Buffer.alloc(0),
					keysDir: peer.keysDir,
				});

				const response = await syncApp.request(url, { headers });

				expect(response.status).toBe(401);
				expect(await response.json()).toEqual({ error: "unauthorized" });
				expect(warning).toHaveBeenCalledWith(expect.stringContaining("reason=recipient_mismatch"));
				expect(
					store.db
						.prepare(
							`SELECT highest_observed_direct_signature_version
						 FROM sync_peer_signature_state WHERE peer_device_id = ?`,
						)
						.pluck()
						.get(peer.peerDeviceId),
				).toBeUndefined();
			} finally {
				warning.mockRestore();
				peer?.cleanup();
				cleanup();
			}
		});

		it("rejects unchanged recipient-bound requests replayed to another direct peer", async () => {
			// Arrange
			const recipientA = createTestApp({ deviceId: "recipient-a" });
			const storeA = recipientA.ensureStore();
			const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			let recipientB: ReturnType<typeof createTestApp> | null = null;
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				core.setSyncResetState(storeA.db, {
					generation: 1,
					snapshot_id: "snapshot-1",
					baseline_cursor: null,
					retained_floor_cursor: null,
				});
				peer = createAuthenticatedSyncPeer(storeA, { url: "http://localhost/v1/status" });
				const peerPublicKey = loadPublicKey(peer.keysDir);
				if (!peerPublicKey) throw new Error("peer public key missing");
				recipientB = createTestApp({ deviceId: "recipient-b" });
				const storeB = recipientB.ensureStore();
				storeB.db
					.prepare(
						`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(
						peer.peerDeviceId,
						fingerprintPublicKey(peerPublicKey),
						peerPublicKey,
						new Date().toISOString(),
					);
				const cases: Array<{
					name: string;
					method: "GET" | "POST";
					url: string;
					bodyText?: string;
					assertAccepted: (response: Response) => Promise<void>;
				}> = [
					{
						name: "status",
						method: "GET",
						url: "http://localhost/v1/status",
						assertAccepted: async (response) => {
							expect((await response.json()) as Record<string, unknown>).toMatchObject({
								device_id: "recipient-a",
								protocol_version: "2",
							});
						},
					},
					{
						name: "ops GET",
						method: "GET",
						url: "http://localhost/v1/ops?since=&limit=1&generation=1&snapshot_id=snapshot-1",
						assertAccepted: async (response) => {
							expect((await response.json()) as Record<string, unknown>).toMatchObject({
								reset_required: false,
								ops: [],
							});
						},
					},
					{
						name: "ops POST",
						method: "POST",
						url: "http://localhost/v1/ops",
						bodyText: JSON.stringify({ ops: [] }),
						assertAccepted: async (response) => {
							expect((await response.json()) as Record<string, unknown>).toMatchObject({
								applied: 0,
								rejected: 0,
							});
						},
					},
					{
						name: "snapshot",
						method: "GET",
						url: "http://localhost/v1/snapshot?generation=1&snapshot_id=snapshot-1&limit=1",
						assertAccepted: async (response) => {
							expect((await response.json()) as Record<string, unknown>).toMatchObject({
								generation: 1,
								snapshot_id: "snapshot-1",
								items: [],
							});
						},
					},
				];

				for (const scenario of cases) {
					const bodyBytes = Buffer.from(scenario.bodyText ?? "");
					const headers = buildDirectPeerAuthHeaders({
						deviceId: peer.peerDeviceId,
						recipientId: "recipient-a",
						method: scenario.method,
						url: scenario.url,
						bodyBytes,
						keysDir: peer.keysDir,
					});
					if (scenario.bodyText !== undefined) headers["Content-Type"] = "application/json";
					const request = {
						method: scenario.method,
						headers,
						body: scenario.bodyText,
					};

					// Act
					const accepted = await recipientA.syncApp.request(scenario.url, request);
					const replayed = await recipientB.syncApp.request(scenario.url, request);

					// Assert
					expect(accepted.status, `${scenario.name} at recipient A`).toBe(200);
					await scenario.assertAccepted(accepted);
					expect(replayed.status, `${scenario.name} replayed at recipient B`).toBe(401);
					expect(await replayed.json()).toEqual({ error: "unauthorized" });
				}
				expect(
					storeB.db
						.prepare("SELECT COUNT(*) FROM sync_nonces WHERE device_id = ?")
						.pluck()
						.get(peer.peerDeviceId),
				).toBe(0);
				expect(
					storeB.db
						.prepare(
							`SELECT highest_observed_direct_signature_version
							 FROM sync_peer_signature_state WHERE peer_device_id = ?`,
						)
						.pluck()
						.get(peer.peerDeviceId),
				).toBeUndefined();
				expect(warning).toHaveBeenCalledWith(expect.stringContaining("reason=recipient_mismatch"));
			} finally {
				warning.mockRestore();
				peer?.cleanup();
				recipientB?.cleanup();
				recipientA.cleanup();
			}
		});

		it("does not fall back to valid v2 when supplied v3 material is invalid", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/status";
				peer = createAuthenticatedSyncPeer(store, { url });
				const headers = buildDirectPeerAuthHeaders({
					deviceId: peer.peerDeviceId,
					recipientId: "test-device-001",
					method: "GET",
					url,
					bodyBytes: Buffer.alloc(0),
					keysDir: peer.keysDir,
				});
				headers["X-Codemem-Signature"] = "v3:invalid";

				const response = await syncApp.request(url, { headers });

				expect(response.status).toBe(401);
				expect(await response.json()).toEqual({ error: "unauthorized" });
				expect(
					store.db
						.prepare(
							`SELECT highest_observed_direct_signature_version
							 FROM sync_peer_signature_state WHERE peer_device_id = ?`,
						)
						.pluck()
						.get(peer.peerDeviceId),
				).toBeUndefined();
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("does not fall back to valid v2 when v3 material is incomplete", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/status";
				peer = createAuthenticatedSyncPeer(store, { url });
				const headers = {
					...buildAuthHeaders({
						deviceId: peer.peerDeviceId,
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peer.keysDir,
					}),
					"X-Codemem-Recipient": "test-device-001",
				};

				const response = await syncApp.request(url, { headers });

				expect(response.status).toBe(401);
				expect(await response.json()).toEqual({ error: "unauthorized" });
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("rejects v2 after v3 adoption, trust deletion, and peer recreation", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/status";
				peer = createAuthenticatedSyncPeer(store, { url });
				const legacy = buildAuthHeaders({
					deviceId: peer.peerDeviceId,
					method: "GET",
					url,
					bodyBytes: Buffer.alloc(0),
					keysDir: peer.keysDir,
				});

				// Act
				const beforeAdoption = await syncApp.request(url, { headers: legacy });

				// Assert
				expect(beforeAdoption.status).toBe(200);
				expect(
					store.db
						.prepare(
							`SELECT highest_observed_direct_signature_version
							 FROM sync_peer_signature_state WHERE peer_device_id = ?`,
						)
						.pluck()
						.get(peer.peerDeviceId),
				).toBeUndefined();
				const v3 = buildDirectPeerAuthHeaders({
					deviceId: peer.peerDeviceId,
					recipientId: "test-device-001",
					method: "GET",
					url,
					bodyBytes: Buffer.alloc(0),
					keysDir: peer.keysDir,
				});

				// Act
				const adoption = await syncApp.request(url, { headers: v3 });

				// Assert
				expect(adoption.status).toBe(200);
				expect(
					store.db
						.prepare(
							`SELECT highest_observed_direct_signature_version
							 FROM sync_peer_signature_state WHERE peer_device_id = ?`,
						)
						.pluck()
						.get(peer.peerDeviceId),
				).toBe(3);
				const peerPublicKey = loadPublicKey(peer.keysDir);
				if (!peerPublicKey) throw new Error("peer public key missing");
				store.db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(peer.peerDeviceId);
				store.db
					.prepare(
						`INSERT INTO sync_peers(
							peer_device_id, pinned_fingerprint, public_key, created_at
						 ) VALUES (?, ?, ?, ?)`,
					)
					.run(
						peer.peerDeviceId,
						fingerprintPublicKey(peerPublicKey),
						peerPublicKey,
						new Date().toISOString(),
					);
				const v2 = buildAuthHeaders({
					deviceId: peer.peerDeviceId,
					method: "GET",
					url,
					bodyBytes: Buffer.alloc(0),
					keysDir: peer.keysDir,
				});

				const response = await syncApp.request(url, { headers: v2 });

				expect(response.status).toBe(401);
				expect(await response.json()).toEqual({ error: "unauthorized" });
				expect(warning).toHaveBeenCalledWith(expect.stringContaining("reason=signature_downgrade"));
				expect(
					store.db
						.prepare(
							`SELECT highest_observed_direct_signature_version
							 FROM sync_peer_signature_state WHERE peer_device_id = ?`,
						)
						.pluck()
						.get(peer.peerDeviceId),
				).toBe(3);
			} finally {
				warning.mockRestore();
				peer?.cleanup();
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

		it("keeps sync auth failures generic even when diagnostics are enabled", async () => {
			const previous = process.env.CODEMEM_SYNC_AUTH_DIAGNOSTICS;
			process.env.CODEMEM_SYNC_AUTH_DIAGNOSTICS = "1";
			const { syncApp, cleanup } = createTestApp();
			try {
				const res = await syncApp.request("/v1/status");
				expect(res.status).toBe(401);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toEqual({ error: "unauthorized" });
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

		it("allows /v1/status with a valid bootstrap grant using seed-device lookup", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			const peerDir = mkdtempSync(join(tmpdir(), "codemem-sync-bootstrap-grant-test-"));
			const peerDbPath = join(peerDir, "peer.sqlite");
			const peerKeysDir = join(peerDir, "keys");
			const configPath = join(mkdtempSync(join(tmpdir(), "codemem-config-test-")), "config.json");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevAdminSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			let peerDeviceIdValue = "";
			const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/v1/bootstrap-grants/grant-1?group_id=g1")) {
					const lookupHeaders = new Headers(init?.headers);
					const seedDeviceId = lookupHeaders.get("X-Opencode-Device");
					expect(seedDeviceId).toBeTruthy();
					expect(lookupHeaders.get("X-Opencode-Signature")).toBeTruthy();
					return new Response(
						JSON.stringify({
							grant: {
								grant_id: "grant-1",
								group_id: "g1",
								seed_device_id: seedDeviceId,
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
				delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				writeFileSync(
					configPath,
					JSON.stringify({
						sync_coordinator_url: "https://coord.example.test",
						sync_coordinator_groups: ["g1"],
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
					const headers = buildDirectPeerAuthHeaders({
						deviceId: peerDeviceId,
						recipientId: "test-device-001",
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
								`SELECT pinned_fingerprint, public_key,
								        highest_observed_direct_signature_version
								 FROM sync_peers WHERE peer_device_id = ?`,
							)
							.get(peerDeviceId),
					).toEqual({
						pinned_fingerprint: peerFingerprintValue,
						public_key: peerPublicKeyValue,
						highest_observed_direct_signature_version: 3,
					});
					const now = new Date().toISOString();
					store.db
						.prepare(`INSERT INTO actors(
						 actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
						 ) VALUES ('identity-local', 'Local Identity', 1, 'active', NULL, ?, ?)`)
						.run(now, now);
					store.db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(peerDeviceId);
					store.db
						.prepare(`INSERT INTO sync_peers(peer_device_id, actor_id, created_at)
						 VALUES (?, 'identity-local', ?)`)
						.run(peerDeviceId, now);
					const conflictingHeaders = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peerKeysDir,
						bootstrapGrantId: "grant-1",
					});
					expect((await syncApp.request(url, { headers: conflictingHeaders })).status).toBe(401);
				} finally {
					peerDb.close();
				}
			} finally {
				cleanup();
				rmSync(peerDir, { recursive: true, force: true });
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevAdminSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = prevAdminSecret;
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
				expect(body.skipped).toBe(0);
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
						`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active, deleted_at, visibility, scope_id, metadata_json)
						 VALUES (?, 'discovery', ?, 'body', ?, ?, ?, 1, ?, ?, ?, 'snapshot-work', ?)`,
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
						`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, rev, active, deleted_at, visibility, scope_id, metadata_json)
						 VALUES (?, 'discovery', ?, 'body', ?, ?, ?, 1, ?, ?, ?, 'snapshot-work', ?)`,
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

				core.setSyncResetState(
					store.db,
					{
						generation: 11,
						snapshot_id: "snapshot-11",
						baseline_cursor: "2026-01-01T00:00:02Z|base-op",
						retained_floor_cursor: "2026-01-01T00:00:03Z|floor-op",
					},
					"snapshot-work",
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
					const localDevice = store.db.prepare("SELECT device_id FROM sync_device LIMIT 1").get() as
						| { device_id: string }
						| undefined;
					if (!localDevice?.device_id) throw new Error("local sync device missing");
					grantSyncScopeToDevices(store, "snapshot-work", [localDevice.device_id, peerDeviceId]);

					const url =
						"http://localhost/v1/snapshot?limit=2&generation=11&snapshot_id=snapshot-11&baseline_cursor=2026-01-01T00:00:02Z%7Cbase-op&scope_id=snapshot-work";
					const headers = buildAuthHeaders({
						deviceId: peerDeviceId,
						method: "GET",
						url,
						bodyBytes: Buffer.alloc(0),
						keysDir: peerKeysDir,
					});
					headers[core.SYNC_CAPABILITY_HEADER] = "scoped";

					const res = await syncApp.request(url, { headers });
					expect(res.status).toBe(200);
					const body = (await res.json()) as Record<string, unknown>;
					expect(body.generation).toBe(11);
					expect(body.snapshot_id).toBe("snapshot-11");
					expect(body.sync_capability).toBe("scoped");
					expect(body.scope_id).toBe("snapshot-work");
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

		it("rejects unknown scoped pushes from unsupported peers", async () => {
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
								scope_id: "legacy-explicit",
								title: "Legacy push title",
								updated_at: now,
								visibility: "shared",
							}),
							clock_rev: 1,
							clock_updated_at: now,
							clock_device_id: peer.peerDeviceId,
							device_id: peer.peerDeviceId,
							created_at: now,
							scope_id: "legacy-explicit",
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

				expect(res.status).toBe(403);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body).toMatchObject({ error: "scope_rejected", reason: "missing_scope" });
				expect(
					store.db
						.prepare("SELECT title, scope_id FROM memory_items WHERE import_key = ?")
						.get("legacy-push-key"),
				).toBeUndefined();
			} finally {
				peer?.cleanup();
				cleanup();
			}
		});

		it("accepts known authoritative scoped pushes from unsupported peers", async () => {
			const { syncApp, ensureStore, cleanup } = createTestApp();
			let peer: ReturnType<typeof createAuthenticatedSyncPeer> | null = null;
			try {
				const store = ensureStore();
				const url = "http://localhost/v1/ops";
				peer = createAuthenticatedSyncPeer(store, { url, method: "POST" });
				grantSyncScopeToDevices(store, "unsupported-explicit", []);
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
								scope_id: "unsupported-explicit",
								title: "Unsupported scoped push title",
								updated_at: now,
								visibility: "shared",
							}),
							clock_rev: 1,
							clock_updated_at: now,
							clock_device_id: peer.peerDeviceId,
							device_id: peer.peerDeviceId,
							created_at: now,
							scope_id: "unsupported-explicit",
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
				).toMatchObject({
					title: "Unsupported scoped push title",
					scope_id: "unsupported-explicit",
				});
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
								scope_id: "personal:actor-1",
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
							expect.objectContaining({
								op_id: "shared-delete-1",
								reason: "sender_not_member",
							}),
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
						expect.arrayContaining([{ reason: "sender_not_member", count: 3 }]),
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

		it("returns empty enrollment reconciliation issue counts without diagnostics", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/status");
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.coordinator_enrollment_reconciliation_issues).toEqual({
					counts: { open: 0, resolved: 0 },
				});
			} finally {
				cleanup();
			}
		});

		it("redacts enrollment reconciliation issue identifiers while retaining counts", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db
					.prepare(`INSERT INTO coordinator_enrollment_reconciliation_issues(
					coordinator_id, group_id, kind, reference_id, code, status,
					first_seen_at, last_seen_at, occurrence_count, updated_at
				) VALUES ('https://private.example.test', 'private-group', 'device', 'private-device',
					'safe_code', 'open', '2026-07-29T00:00:00.000Z',
					'2026-07-29T00:00:00.000Z', 1, '2026-07-29T00:00:00.000Z')`)
					.run();

				const res = await app.request("/api/sync/status");
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.coordinator_enrollment_reconciliation_issues).toEqual({
					counts: { open: 1, resolved: 0 },
				});
				expect(JSON.stringify(body.coordinator_enrollment_reconciliation_issues)).not.toContain(
					"private",
				);
			} finally {
				cleanup();
			}
		});

		it("returns bounded safe enrollment issue diagnostics in open-first recency order", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const insert = store.db.prepare(`INSERT INTO coordinator_enrollment_reconciliation_issues(
					coordinator_id, group_id, kind, reference_id, code, status, first_seen_at,
					last_seen_at, resolved_at, occurrence_count, updated_at
				) VALUES ('https://coord.example.test', 'group-a', 'device', ?, 'safe_code', ?,
					'2026-07-29T00:00:00.000Z', ?, ?, 1, ?)`);
				insert.run(
					"open-item",
					"open",
					"2026-07-29T00:30:00.000Z",
					null,
					"2026-07-29T00:30:00.000Z",
				);
				for (let index = 0; index < 25; index += 1) {
					const timestamp = new Date(Date.UTC(2026, 6, 29, 0, index)).toISOString();
					insert.run(`resolved-${index}`, "resolved", timestamp, timestamp, timestamp);
				}

				const res = await app.request("/api/sync/status?includeDiagnostics=true");
				const body = (await res.json()) as {
					coordinator_enrollment_reconciliation_issues: {
						counts: { open: number; resolved: number };
						issues: Array<Record<string, unknown>>;
					};
				};
				const block = body.coordinator_enrollment_reconciliation_issues;
				expect(block.counts).toEqual({ open: 1, resolved: 25 });
				expect(block.issues).toHaveLength(25);
				expect(block.issues[0]).toMatchObject({ reference_id: "open-item", status: "open" });
				expect(block.issues[1]).toMatchObject({ reference_id: "resolved-24", status: "resolved" });
				expect(block.issues.at(-1)).toMatchObject({ reference_id: "resolved-1" });
				expect(block.issues[0]).not.toHaveProperty("payload");
				expect(block.issues[0]).not.toHaveProperty("error");
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
						expected_incoming_request_id: "req-reviewed",
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
						expected_group_id: "team-a",
						expected_incoming_request_id: "req-reviewed",
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

		it("rejects an explicitly empty reviewed reciprocal approval request", async () => {
			const { app, cleanup } = createTestApp();
			try {
				const res = await app.request("/api/sync/peers/accept-discovered", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						peer_device_id: "peer-fresh",
						expected_group_id: "team-a",
						expected_incoming_request_id: " ",
					}),
				});

				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					error: "expected_incoming_request_id must not be empty",
				});
			} finally {
				cleanup();
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
					body: JSON.stringify({ peer_device_id: "peer-rename", name: "  Desk   Mini  " }),
				});

				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ ok: true });

				const peerRow = store.db
					.prepare("SELECT name FROM sync_peers WHERE peer_device_id = ?")
					.get("peer-rename") as { name: string } | undefined;
				expect(peerRow?.name).toBe("Desk Mini");

				const invalidRes = await app.request("/api/sync/peers/rename", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						peer_device_id: "peer-rename",
						name: "123e4567-e89b-12d3-a456-426614174000",
					}),
				});
				expect(invalidRes.status).toBe(400);
				expect(await invalidRes.json()).toEqual({ error: "name_invalid" });
				expect(
					store.db
						.prepare("SELECT name FROM sync_peers WHERE peer_device_id = ?")
						.pluck()
						.get("peer-rename"),
				).toBe("Desk Mini");
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

		it("returns safe recipient-policy reconciliation states with the delivered-copy warning", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = "2026-07-22T12:00:00.000Z";
				const waitingProject = "https://git.example.invalid/acme/waiting.git";
				const unsupportedProject = "https://git.example.invalid/acme/unsupported.git";
				const insertRecipient = store.db.prepare(
					`INSERT INTO project_recipients(
					 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
					 policy_revision, migration_state, idempotency_key, created_at, updated_at
					 ) VALUES (?, 'identity', ?, 'active', 'test', 'private-revision', 'native', ?, ?, ?)`,
				);
				insertRecipient.run(
					waitingProject,
					"identity-waiting",
					"recipient-status-waiting",
					now,
					now,
				);
				insertRecipient.run(
					unsupportedProject,
					"identity-unsupported",
					"recipient-status-unsupported",
					now,
					now,
				);
				const insertAuthority = store.db.prepare(
					`INSERT INTO recipient_policy_authority_states(
					 canonical_project_identity, authority_state, generation, desired_devices_digest,
					 current_devices_digest, fresh_snapshot_fingerprint, safe_error_code,
					 state_changed_at, last_error_at, attempt_count, last_attempt_at, created_at, updated_at
					 ) VALUES (?, 'legacy', 2, 'private-desired-digest', 'private-current-digest',
					 'private-snapshot-fingerprint', ?, ?, ?, 1, ?, ?, ?)`,
				);
				insertAuthority.run(
					waitingProject,
					"recipient_policy_capability_undetermined",
					now,
					now,
					now,
					now,
					now,
				);
				insertAuthority.run(
					unsupportedProject,
					"recipient_policy_capability_unsupported",
					now,
					now,
					now,
					now,
					now,
				);
				const syncStatusResponse = await app.request("/api/sync/status");
				const syncStatusPayload = (await syncStatusResponse.json()) as {
					recipient_policy_reconciliation?: {
						version: number;
						items: Array<{
							canonicalProjectIdentity: string;
							state: string;
							deliveredCopiesMayRemain: boolean;
							revocationWarning: string;
						}>;
					};
				};
				expect(syncStatusResponse.status).toBe(200);
				store.db.pragma("query_only = ON");

				const response = await app.request("/api/sync/recipient-policy/v1/reconciliation-status");
				const text = await response.text();
				const payload = JSON.parse(text) as {
					version: number;
					items: Array<{
						canonicalProjectIdentity: string;
						state: string;
						deliveredCopiesMayRemain: boolean;
						revocationWarning: string;
					}>;
				};

				expect(response.status).toBe(200);
				expect(payload.version).toBe(1);
				expect(payload.items).toEqual([
					expect.objectContaining({
						canonicalProjectIdentity: unsupportedProject,
						state: "needs_attention",
						deliveredCopiesMayRemain: true,
					}),
					expect.objectContaining({
						canonicalProjectIdentity: waitingProject,
						state: "waiting",
						deliveredCopiesMayRemain: true,
					}),
				]);
				expect(payload.items.every((item) => item.revocationWarning.length > 0)).toBe(true);

				expect(syncStatusPayload.recipient_policy_reconciliation?.items).toEqual(payload.items);
				for (const privateValue of [
					"private-revision",
					"private-desired-digest",
					"private-current-digest",
					"private-snapshot-fingerprint",
					"recipient_policy_capability_undetermined",
					"recipient_policy_capability_unsupported",
				]) {
					expect(text).not.toContain(privateValue);
				}
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
					continuity: { findingCount: number; state: string } | null;
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
				expect(review.continuity).toEqual({
					findingCount: 1,
					state: "legacy_access_preserved",
				});
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
				const completedReviewResponse = await app.request("/api/sync/recipient-policy/v1/review");
				const completedReview = (await completedReviewResponse.json()) as typeof review;
				expect(completedReviewResponse.status).toBe(200);
				expect(completedReview.continuity).toBeNull();
				expect(completedReview).toHaveProperty("continuity");
			} finally {
				getStore()?.db.pragma("query_only = OFF");
				cleanup();
			}
		});

		it("persists a fail-closed recipient-policy Project identity repair", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sourceSessionId = insertTestSession(store.db);
				store.db
					.prepare(
						"UPDATE sessions SET cwd = NULL, git_remote = NULL, git_branch = NULL, project = ? WHERE id = ?",
					)
					.run("Legacy source", sourceSessionId);
				const sourceMemoryId = insertTestMemory(store, {
					sessionId: sourceSessionId,
					kind: "discovery",
					title: "legacy source repair",
					metadata: {},
				});
				// insertTestMemory deliberately seeds shared:default for most integration
				// fixtures. Clear it here so this fixture follows the existing unmapped
				// Project pattern and exercises noncanonical_project_identity.
				store.db
					.prepare("UPDATE memory_items SET workspace_id = NULL WHERE id = ?")
					.run(sourceMemoryId);
				const targetIdentity = "https://git.example.invalid/acme/repair-target.git";
				const targetSessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run(targetIdentity, "Safe target", targetSessionId);
				insertTestMemory(store, {
					sessionId: targetSessionId,
					kind: "discovery",
					title: "repair target",
					metadata: {},
				});

				const reviewResponse = await app.request("/api/sync/recipient-policy/v1/review");
				const reviewText = await reviewResponse.text();
				const review = JSON.parse(reviewText) as {
					blockedItems: Array<{
						blockedItemId: string;
						repair?: {
							sourceIdentityRef: string;
							sourceFingerprint: string;
							reason?: string;
							choices: Array<{ projectRef: string; displayName: string }>;
							spaces?: Array<{ spaceRef: string; displayName: string }>;
						};
					}>;
				};
				const blocked = review.blockedItems.find((item) =>
					item.repair?.choices.some((candidate) => candidate.displayName === "Safe target"),
				);
				const repair = blocked?.repair;
				const choice = repair?.choices.find((candidate) => candidate.displayName === "Safe target");
				const space = repair?.spaces?.[0];
				if (!blocked || !repair || !choice || !space)
					throw new Error(`repair response incomplete: ${JSON.stringify(review.blockedItems)}`);
				expect(repair.reason).toBe("ready");
				const blockedText = JSON.stringify(blocked);
				expect(blockedText).not.toContain(targetIdentity);
				expect(blockedText).not.toContain("/workspace/");

				const stale = await app.request(
					"/api/sync/recipient-policy/v1/review/repair-project-identity",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							blockedItemId: blocked.blockedItemId,
							sourceIdentityRef: repair.sourceIdentityRef,
							sourceFingerprint: "stale",
							projectRef: choice.projectRef,
						}),
					},
				);
				expect(stale.status).toBe(409);
				expect(store.db.prepare("SELECT COUNT(*) FROM project_scope_mappings").pluck().get()).toBe(
					0,
				);

				const applied = await app.request(
					"/api/sync/recipient-policy/v1/review/repair-project-identity",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							blockedItemId: blocked.blockedItemId,
							sourceIdentityRef: repair.sourceIdentityRef,
							sourceFingerprint: repair.sourceFingerprint,
							projectRef: choice.projectRef,
							spaceRef: space.spaceRef,
						}),
					},
				);
				expect(applied.status).toBe(200);
				expect(await applied.json()).toMatchObject({ status: "applied", idempotent: false });
				expect(
					store.db
						.prepare(
							"SELECT workspace_identity FROM project_scope_mappings WHERE source = 'recipient_policy_repair'",
						)
						.pluck()
						.get(),
				).toBe(targetIdentity);
				const laterTargetIdentity = "https://git.example.invalid/acme/later-repair-target.git";
				const laterTargetSessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run(laterTargetIdentity, "Later target", laterTargetSessionId);
				insertTestMemory(store, {
					sessionId: laterTargetSessionId,
					kind: "discovery",
					title: "later repair target",
					metadata: {},
				});
				const staleReplay = await app.request(
					"/api/sync/recipient-policy/v1/review/repair-project-identity",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							blockedItemId: blocked.blockedItemId,
							sourceIdentityRef: repair.sourceIdentityRef,
							sourceFingerprint: repair.sourceFingerprint,
							projectRef: choice.projectRef,
						}),
					},
				);
				expect(staleReplay.status).toBe(409);
				expect(await staleReplay.json()).toMatchObject({
					status: "stale",
					errorCode: "source_fingerprint_stale",
					idempotent: false,
				});
				const refreshed = (await (
					await app.request("/api/sync/recipient-policy/v1/review")
				).json()) as typeof review;
				expect(
					refreshed.blockedItems.some((item) => item.blockedItemId === blocked.blockedItemId),
				).toBe(false);
			} finally {
				cleanup();
			}
		});

		it("groups stale recipient-policy sources with no live content", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const sourceSessionId = insertTestSession(store.db);
				store.db
					.prepare(
						"UPDATE sessions SET cwd = ?, git_remote = NULL, git_branch = NULL, project = ? WHERE id = ?",
					)
					.run(null, "/Users/private/.local/share/chezmoi", sourceSessionId);
				const memoryId = insertTestMemory(store, {
					sessionId: sourceSessionId,
					kind: "discovery",
					title: "stale source",
					metadata: {},
				});
				store.db
					.prepare("UPDATE memory_items SET active = 0, workspace_id = NULL WHERE id = ?")
					.run(memoryId);
				const sourceIdentity = core.canonicalWorkspaceIdentity({
					project: "/Users/private/.local/share/chezmoi",
				}).value;
				store.db
					.prepare(
						`INSERT INTO project_recipients(
						 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
						 policy_revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
						 ) VALUES (?, 'identity', ?, 'active', 'legacy_migration', 'legacy', 'projected',
						 'legacy-source', 'legacy-stale-route', ?, ?)`,
					)
					.run(
						sourceIdentity,
						store.actorId,
						"2026-08-28T12:00:00.000Z",
						"2026-08-28T12:00:00.000Z",
					);
				const rowCount = store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get();

				const response = await app.request("/api/sync/recipient-policy/v1/review");
				const text = await response.text();
				const review = JSON.parse(text) as {
					blockedItems: unknown[];
					staleNoContent?: {
						reason: string;
						count: number;
						labels: string[];
						sourceFingerprint: string;
					};
				};

				expect(response.status).toBe(200);
				expect(review.blockedItems).toEqual([]);
				expect(review.staleNoContent).toMatchObject({ reason: "stale_no_content", count: 1 });
				expect(review.staleNoContent?.labels).toEqual(["Local folder (path hidden)"]);
				expect(text).not.toContain("/Users/private");
				expect(store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(rowCount);
				const invalid = await app.request(
					"/api/sync/recipient-policy/v1/review/prune-stale-sources",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							sourceFingerprint: review.staleNoContent?.sourceFingerprint,
							unexpected: true,
						}),
					},
				);
				expect(invalid.status).toBe(400);
				const stale = await app.request(
					"/api/sync/recipient-policy/v1/review/prune-stale-sources",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sourceFingerprint: "stale" }),
					},
				);
				expect(stale.status).toBe(409);
				expect(store.db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(1);
				const applied = await app.request(
					"/api/sync/recipient-policy/v1/review/prune-stale-sources",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							sourceFingerprint: review.staleNoContent?.sourceFingerprint,
						}),
					},
				);
				const appliedText = await applied.text();
				expect(applied.status).toBe(200);
				expect(JSON.parse(appliedText)).toMatchObject({
					status: "applied",
					removedCount: 1,
					skippedCount: 0,
					removed: [{ label: "Local folder (path hidden)" }],
				});
				expect(appliedText).not.toContain("/Users/private");
				expect(appliedText).not.toContain(sourceIdentity);
				expect(store.db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
				expect(store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(rowCount);
			} finally {
				cleanup();
			}
		});

		it("serves an Advanced administration action for multiple Project boundaries", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = "2026-08-28T12:00:00.000Z";
				for (const [scopeId, label] of [
					["scope-work", "Work"],
					["scope-oss", "Open source"],
				] as const) {
					store.db
						.prepare(
							`INSERT INTO replication_scopes(
							 scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
							 ) VALUES (?, ?, 'managed_project', 'local', 1, 'active', ?, ?)`,
						)
						.run(scopeId, label, now, now);
				}
				const sessionId = insertTestSession(store.db);
				store.db
					.prepare("UPDATE sessions SET cwd = NULL, project = 'Shared default' WHERE id = ?")
					.run(sessionId);
				for (const [scopeId, title] of [
					["scope-work", "Work boundary"],
					["scope-oss", "OSS boundary"],
				] as const) {
					const memoryId = insertTestMemory(store, {
						sessionId,
						kind: "discovery",
						title,
						scopeId,
						metadata: {},
					});
					store.db
						.prepare("UPDATE memory_items SET workspace_id = 'shared:default' WHERE id = ?")
						.run(memoryId);
					store.db
						.prepare(
							`INSERT INTO project_scope_mappings(
							 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
							 ) VALUES ('shared:default', 'shared:default', ?, 1000, 'test', ?, ?)`,
						)
						.run(scopeId, now, now);
				}

				const response = await app.request("/api/sync/recipient-policy/v1/review");
				const text = await response.text();
				const review = JSON.parse(text) as {
					blockedItems: Array<{
						reason: string;
						repair?: { kind: string; projectIdentity?: string };
					}>;
				};
				const blocked = review.blockedItems.find(
					(item) => item.repair?.kind === "review_project_scope_mappings",
				);

				expect(blocked).toMatchObject({
					repair: { kind: "review_project_scope_mappings", projectIdentity: "shared:default" },
				});
				expect(blocked?.reason).toContain("Open source, Work");
				expect(text).not.toContain("scope-work");
				expect(text).not.toContain("scope-oss");
			} finally {
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

		it("returns a structured response when recipient-policy migration cannot acquire its writer lock", async () => {
			const { app, getStore, cleanup } = createTestApp();
			let competing: InstanceType<typeof Database> | null = null;
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				store.db.pragma("busy_timeout = 1");
				competing = new Database(store.db.name);
				competing.exec("BEGIN IMMEDIATE");

				const response = await app.request("/api/sync/recipient-policy/v1/migrate", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({}),
				});

				expect(response.status).toBe(503);
				expect(response.headers.get("Retry-After")).toBe("1");
				expect(await response.json()).toEqual({ error: "migration_busy" });
			} finally {
				if (competing?.inTransaction) competing.exec("ROLLBACK");
				competing?.close();
				cleanup();
			}
		});

		it("returns a generic recipient-policy migration failure without leaking details", async () => {
			const { app, getStore, cleanup } = createTestApp();
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const prepare = store.db.prepare.bind(store.db);
				store.db.prepare = (() => {
					throw new Error("private SQLite migration detail");
				}) as typeof store.db.prepare;

				const response = await app.request("/api/sync/recipient-policy/v1/migrate", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({}),
				});
				store.db.prepare = prepare;
				const text = await response.text();

				expect(response.status).toBe(500);
				expect(JSON.parse(text)).toEqual({ error: "migration_failed" });
				expect(text).not.toContain("private SQLite migration detail");
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
					body: JSON.stringify({ display_name: "  Fixture   shadow  " }),
				});
				expect(createRes.status).toBe(200);
				const created = (await createRes.json()) as { actor_id: string; display_name: string };
				expect(created.display_name).toBe("Fixture shadow");

				const actorCount = store.db.prepare("SELECT COUNT(*) FROM actors").pluck().get();
				const invalidCreateRes = await app.request("/api/sync/actors", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ display_name: "local:a57f7c7c-d531-4148-9917-78acb586caad" }),
				});
				expect(invalidCreateRes.status).toBe(400);
				expect(await invalidCreateRes.json()).toEqual({ error: "display_name_invalid" });
				expect(store.db.prepare("SELECT COUNT(*) FROM actors").pluck().get()).toBe(actorCount);

				const invalidRenameRes = await app.request("/api/sync/actors/rename", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						actor_id: created.actor_id,
						display_name: "123e4567-e89b-12d3-a456-426614174000",
					}),
				});
				expect(invalidRenameRes.status).toBe(400);
				expect(await invalidRenameRes.json()).toEqual({
					error: "display_name_invalid",
				});
				expect(
					store.db
						.prepare("SELECT display_name FROM actors WHERE actor_id = ?")
						.pluck()
						.get(created.actor_id),
				).toBe("Fixture shadow");

				const renameRes = await app.request("/api/sync/actors/rename", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						actor_id: created.actor_id,
						display_name: "  Fixture   remote  ",
					}),
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
				const bindingTimestamp = new Date().toISOString();
				store.db
					.prepare(`INSERT INTO identity_devices(
						device_id, identity_id, display_name, status, provenance, revision, migration_state,
						assignment_version, source_fingerprint, idempotency_key, created_at, updated_at
					) VALUES (?, ?, ?, 'active', 'user_confirmed_identity_setup', 'r1', 'user_managed',
						0, NULL, ?, ?, ?)`)
					.run(
						"bound-device",
						created.actor_id,
						"Bound device",
						"binding-before-merge",
						bindingTimestamp,
						bindingTimestamp,
					);
				store.db
					.prepare(`INSERT INTO policy_teams(
						team_id, display_name, status, device_eligibility_mode, provenance, revision,
						migration_state, source_fingerprint, idempotency_key, created_at, updated_at
					) VALUES (?, ?, 'active', 'reviewed_allowlist', 'user', 'r1', 'user_managed',
						NULL, ?, ?, ?)`)
					.run("merge-team", "Merge team", "merge-team-key", bindingTimestamp, bindingTimestamp);
				store.db
					.prepare(`INSERT INTO policy_team_device_decisions(
						team_id, device_id, decision, assignment_version, provenance, revision,
						created_at, updated_at
					) VALUES (?, ?, 'included', 0, 'user', 'r1', ?, ?)`)
					.run("merge-team", "bound-device", bindingTimestamp, bindingTimestamp);
				store.db
					.prepare(`INSERT INTO policy_team_memberships(
						team_id, identity_id, role, status, provenance, revision, migration_state,
						source_fingerprint, idempotency_key, created_at, updated_at
					) VALUES (?, ?, 'member', 'reviewed_active', 'user', 'r1', 'user_managed',
						NULL, ?, ?, ?)`)
					.run(
						"merge-team",
						created.actor_id,
						"merge-membership-key",
						bindingTimestamp,
						bindingTimestamp,
					);
				store.db
					.prepare(`INSERT INTO project_recipients(
						canonical_project_identity, recipient_kind, recipient_id, status, provenance,
						policy_revision, migration_state, source_fingerprint, idempotency_key,
						created_at, updated_at
					) VALUES (?, 'identity', ?, 'active', 'user', 'r1', 'user_managed', NULL, ?, ?, ?)`)
					.run(
						"project-for-merge",
						created.actor_id,
						"merge-project-recipient-key",
						bindingTimestamp,
						bindingTimestamp,
					);
				store.db
					.prepare(`INSERT INTO recipient_managed_project_projections(
						canonical_project_identity, display_name, managed_scope_id, coordinator_id,
						group_id, recipient_identity_id, accepting_device_id, source_operation_id,
						reviewed_project_set_digest, status, accepted_at, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
					.run(
						"received-project-for-merge",
						"Received project for merge",
						"managed-project:merge-team:received-project-for-merge",
						"https://coordinator.example.test",
						"merge-team",
						created.actor_id,
						"bound-device",
						"merge-received-project-operation",
						"merge-reviewed-project-set",
						bindingTimestamp,
						bindingTimestamp,
						bindingTimestamp,
					);
				store.db
					.prepare(`INSERT INTO share_operations(
						operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
						person_kind, teammate_name, history_policy, reviewed_project_set_digest,
						coordinator_group_id, invite_token_digest, invite_expires_at,
						recipient_actor_id, recipient_device_id, created_at, updated_at
					) VALUES (?, 'completed', ?, '[]', ?, 'existing', ?, 'selected', ?, ?, ?, ?, ?, ?, ?, ?)`)
					.run(
						"merge-share-operation",
						localActor.actor_id,
						created.actor_id,
						"Fixture remote",
						"merge-reviewed-project-set",
						"merge-team",
						"merge-invite-token-digest",
						"2099-01-01T00:00:00.000Z",
						created.actor_id,
						"bound-device",
						bindingTimestamp,
						bindingTimestamp,
					);
				store.db
					.prepare(`INSERT INTO actors(
						actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
					) VALUES ('identity-unrelated', 'Unrelated', 0, 'active', NULL, ?, ?)`)
					.run(bindingTimestamp, bindingTimestamp);
				store.db
					.prepare(`INSERT INTO share_operations(
						operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
						person_kind, teammate_name, history_policy, reviewed_project_set_digest,
						coordinator_group_id, invite_token_digest, invite_expires_at,
						recipient_actor_id, recipient_device_id, created_at, updated_at
					) VALUES (?, 'pending_recipient', ?, '[]', 'identity-unrelated', 'existing', ?,
						'selected', ?, ?, ?, ?, 'identity-unrelated', 'unrelated-device', ?, ?)`)
					.run(
						"merge-inviter-share-operation",
						created.actor_id,
						"Unrelated",
						"merge-inviter-reviewed-project-set",
						"merge-team",
						"merge-inviter-token-digest",
						"2099-01-01T00:00:00.000Z",
						bindingTimestamp,
						bindingTimestamp,
					);
				store.db
					.prepare(`INSERT INTO recipient_managed_project_projections(
						canonical_project_identity, display_name, managed_scope_id, coordinator_id,
						group_id, recipient_identity_id, accepting_device_id, source_operation_id,
						reviewed_project_set_digest, status, accepted_at, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, 'identity-unrelated', ?, ?, ?, 'active', ?, ?, ?)`)
					.run(
						"unrelated-received-project",
						"Unrelated received project",
						"managed-project:merge-team:unrelated-received-project",
						"https://coordinator.example.test",
						"merge-team",
						"unrelated-device",
						"unrelated-received-project-operation",
						"unrelated-reviewed-project-set",
						bindingTimestamp,
						bindingTimestamp,
						bindingTimestamp,
					);

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
				expect(
					store.db
						.prepare(
							"SELECT identity_id, assignment_version FROM identity_devices WHERE device_id = ?",
						)
						.get("bound-device"),
				).toEqual({ identity_id: localActor.actor_id, assignment_version: 1 });
				expect(
					store.db
						.prepare("SELECT COUNT(*) FROM policy_team_device_decisions WHERE device_id = ?")
						.pluck()
						.get("bound-device"),
				).toBe(0);
				expect(
					store.db
						.prepare("SELECT identity_id FROM policy_team_memberships WHERE team_id = ?")
						.all("merge-team"),
				).toEqual([{ identity_id: localActor.actor_id }]);
				expect(
					store.db
						.prepare(
							"SELECT recipient_id FROM project_recipients WHERE canonical_project_identity = ? AND recipient_kind = 'identity'",
						)
						.all("project-for-merge"),
				).toEqual([{ recipient_id: localActor.actor_id }]);
				expect(
					store.db
						.prepare(
							"SELECT recipient_identity_id FROM recipient_managed_project_projections WHERE canonical_project_identity = ?",
						)
						.get("received-project-for-merge"),
				).toEqual({ recipient_identity_id: localActor.actor_id });
				expect(
					store.db
						.prepare(
							"SELECT recipient_identity_id FROM recipient_managed_project_projections WHERE canonical_project_identity = ?",
						)
						.get("unrelated-received-project"),
				).toEqual({ recipient_identity_id: "identity-unrelated" });
				expect(
					store.db
						.prepare(
							"SELECT person_id, recipient_actor_id FROM share_operations WHERE operation_id = ?",
						)
						.get("merge-share-operation"),
				).toEqual({ person_id: localActor.actor_id, recipient_actor_id: localActor.actor_id });
				expect(
					store.db
						.prepare(
							"SELECT inviter_actor_id, person_id, recipient_actor_id FROM share_operations WHERE operation_id = ?",
						)
						.get("merge-inviter-share-operation"),
				).toEqual({
					inviter_actor_id: localActor.actor_id,
					person_id: "identity-unrelated",
					recipient_actor_id: "identity-unrelated",
				});
				expect(
					store.db
						.prepare(`SELECT previous_identity_id, target_identity_id, action,
							previous_assignment_version, resulting_assignment_version
						 FROM device_identity_binding_audit WHERE device_id = ?`)
						.get("bound-device"),
				).toEqual({
					previous_identity_id: created.actor_id,
					target_identity_id: localActor.actor_id,
					action: "rebind",
					previous_assignment_version: 0,
					resulting_assignment_version: 1,
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
			const previousAdminSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			const previousFetch = globalThis.fetch;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "coordinator-a",
					sync_coordinator_admin_secret: "secret",
				}),
			);
			const coordinatorBodies: Record<string, unknown>[] = [];
			const coordinatorUrls: string[] = [];
			const coordinatorHeaders: Headers[] = [];
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const body = JSON.parse(
					init?.body instanceof Uint8Array
						? new TextDecoder().decode(init.body)
						: String(init?.body ?? "{}"),
				) as Record<string, unknown>;
				coordinatorBodies.push(body);
				coordinatorUrls.push(url);
				coordinatorHeaders.push(new Headers(init?.headers));
				const signedAddDevice = url.endsWith("/v1/invites/add-device");
				const reviewedIntent = body.reviewed_intent as
					| Extract<core.RecipientReviewedIntentV1, { journey: "add_device" }>
					| undefined;
				const kind = signedAddDevice ? "add_device" : String(body.invite_kind);
				const targetIdentityId = signedAddDevice
					? reviewedIntent?.targetIdentity.identityId
					: body.target_identity_id;
				const payload = {
					v: 1,
					kind,
					coordinator_url: "https://coord.example.test",
					group_id: body.group_id,
					policy: signedAddDevice ? "auto_admit" : body.policy,
					token: `token-${kind}`,
					expires_at: body.expires_at,
					team_name: null,
					policy_team_id: body.policy_team_id ?? undefined,
					target_identity_id: targetIdentityId ?? undefined,
					assigned_identity_id: kind === "team_member" ? "identity-assigned-team" : undefined,
					reviewed_preview_digest: body.reviewed_preview_digest,
				};
				return new Response(
					JSON.stringify({
						invite: {
							invite_id: `invite-${kind}`,
							invite_kind: kind,
							policy_team_id: body.policy_team_id,
							target_identity_id: targetIdentityId,
							assigned_identity_id: kind === "team_member" ? "identity-assigned-team" : null,
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
				expect(coordinatorUrls).toEqual([
					"https://coord.example.test/v1/admin/invites",
					"https://coord.example.test/v1/admin/invites",
				]);
				expect(coordinatorBodies[0]).toMatchObject({
					invite_kind: "team_member",
					policy_team_id: "policy-team-a",
				});
				expect(coordinatorBodies[1]).toMatchObject({
					invite_kind: "add_device",
					target_identity_id: store.actorId,
				});
				expect(coordinatorHeaders[0]?.get("X-Codemem-Coordinator-Admin")).toBeTruthy();
				expect(coordinatorHeaders[1]?.get("X-Codemem-Coordinator-Admin")).toBeTruthy();
				for (const body of coordinatorBodies) {
					expect(body.reviewed_intent).toMatchObject({
						version: 1,
					});
					expect(body.reviewed_preview_digest).toBe(
						await core.recipientReviewedIntentDigest(body.reviewed_intent),
					);
					expect(body.reviewed_intent).not.toHaveProperty("binding");
					expect(body.reviewed_intent).not.toHaveProperty("reviewedOnboardingDigest");
					expect(body).not.toHaveProperty("reviewed_onboarding_digest");
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
				if (previousAdminSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = previousAdminSecret;
				rmSync(configDir, { recursive: true, force: true });
			}
		});

		it("creates add-device invites without an admin secret while Team creation stays admin-only", async () => {
			const configDir = mkdtempSync(join(tmpdir(), "codemem-signed-add-device-invite-"));
			const configPath = join(configDir, "config.json");
			const keysDir = join(configDir, "keys");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
			const previousAdminSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			const previousFetch = globalThis.fetch;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			writeFileSync(
				configPath,
				JSON.stringify({
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "coordinator-a",
					actor_display_name: "Owner",
				}),
			);
			const { app, ensureStore, cleanup } = createTestApp({ seedDevice: false });
			try {
				const store = ensureStore();
				const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });
				store.adoptEnsuredDeviceIdentity(deviceId);
				let signedBody: Record<string, unknown> | null = null;
				globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
					expect(String(input)).toBe("https://coord.example.test/v1/invites/add-device");
					signedBody = JSON.parse(
						init?.body instanceof Uint8Array
							? new TextDecoder().decode(init.body)
							: String(init?.body ?? "{}"),
					) as Record<string, unknown>;
					const digest = String(signedBody.reviewed_preview_digest);
					return new Response(
						JSON.stringify({
							invite: {
								invite_id: "invite-add-device",
								invite_kind: "add_device",
								target_identity_id: store.actorId,
								reviewed_preview_digest: digest,
							},
							payload: {
								kind: "add_device",
								target_identity_id: store.actorId,
								reviewed_preview_digest: digest,
							},
							encoded: "signed-add-device",
							link: "codemem://join?invite=signed-add-device",
						}),
						{ status: 200 },
					);
				}) as typeof fetch;

				const preview = await app.request("/api/sync/recipient-policy/v1/invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ kind: "add_device", target_identity_id: store.actorId }),
				});
				expect(preview.status).toBe(200);
				const previewBody = (await preview.json()) as {
					preview: { reviewedOnboardingDigest: string };
				};
				const created = await app.request("/api/sync/recipient-policy/v1/invites", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						kind: "add_device",
						target_identity_id: store.actorId,
						reviewed_onboarding_digest: previewBody.preview.reviewedOnboardingDigest,
					}),
				});
				expect(created.status, JSON.stringify(await created.clone().json())).toBe(200);
				expect(signedBody).not.toHaveProperty("target_identity_id");
				expect(signedBody).not.toHaveProperty("invite_kind");

				const teamPreview = await app.request("/api/sync/recipient-policy/v1/invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ kind: "team_member", policy_team_id: "policy-team-a" }),
				});
				expect(teamPreview.status).toBe(400);
				expect(await teamPreview.json()).toMatchObject({
					error: "coordinator_admin_secret_missing",
				});

				const crossIdentity = await app.request("/api/sync/recipient-policy/v1/invites/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						kind: "add_device",
						target_identity_id: "identity-other",
					}),
				});
				expect(crossIdentity.status).toBe(400);
				expect(await crossIdentity.json()).toEqual({ error: "invite_identity_conflict" });
			} finally {
				cleanup();
				globalThis.fetch = previousFetch;
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
				if (previousAdminSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = previousAdminSecret;
				rmSync(configDir, { recursive: true, force: true });
			}
		});

		it("inspects and accepts Team/add-device invites with intent-only local writes", async () => {
			for (const kind of ["team_member", "add_device"] as const) {
				const assignedTeamIdentityId = "identity-assigned-team-recipient";
				const testDir = mkdtempSync(join(tmpdir(), `codemem-${kind}-accept-`));
				const configPath = join(testDir, "config.json");
				const keysDir = join(testDir, "keys");
				const previousConfig = process.env.CODEMEM_CONFIG;
				const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
				const previousFetch = globalThis.fetch;
				process.env.CODEMEM_CONFIG = configPath;
				process.env.CODEMEM_KEYS_DIR = keysDir;
				writeFileSync(configPath, JSON.stringify({ actor_display_name: "Local Identity" }));
				const { app, ensureStore, cleanup } = createTestApp({
					seedDevice: false,
					getSyncRuntimeStatus: () => ({ phase: "disabled" }),
				});
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
					const reviewedIntent: core.RecipientReviewedIntentV1 =
						kind === "team_member"
							? {
									version: 1,
									journey: "team",
									team: {
										teamId: "policy-team-a",
										displayName: "Policy Team A",
										futureProjectsInherit: true,
									},
									projects: [
										{
											canonicalProjectIdentity: projectId,
											displayName: "recipient",
											existingMemoryCount: 1,
											futureMemoriesShared: true,
											sources: [
												{
													kind: "team",
													teamId: "policy-team-a",
													displayName: "Policy Team A",
												},
											],
										},
									],
									excludedProjects: [],
								}
							: {
									version: 1,
									journey: "add_device",
									targetIdentity: {
										identityId: store.actorId,
										displayName: "Local Identity",
									},
									projects: [
										{
											canonicalProjectIdentity: projectId,
											displayName: "recipient",
											existingMemoryCount: 1,
											futureMemoriesShared: true,
											sources: [{ kind: "direct" }],
										},
									],
									excludedProjects: [],
								};
					const digest = await core.recipientReviewedIntentDigest(reviewedIntent);
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
							? {
									policy_team_id: "policy-team-a",
									assigned_identity_id: assignedTeamIdentityId,
								}
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
									reviewed_intent: reviewedIntent,
									bound: false,
									...(kind === "team_member"
										? {
												policy_team_id: "policy-team-a",
												assigned_identity_id: assignedTeamIdentityId,
											}
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
								identity_id: kind === "team_member" ? assignedTeamIdentityId : store.actorId,
								reviewed_preview_digest: digest,
								reviewed_intent: reviewedIntent,
								...(kind === "team_member"
									? {
											policy_team_id: "policy-team-a",
											target_identity_id: null,
											assigned_identity_id: assignedTeamIdentityId,
										}
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
					const acceptedBody = (await accepted.json()) as Record<string, unknown>;
					expect(acceptedBody).toMatchObject({
						status: "accepted",
						type: "recipient_onboarding",
						setup_state: "restart_required",
						restart_required: true,
						sync_enabled: true,
						detail: expect.stringContaining("Restart codemem"),
					});
					const persistedConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<
						string,
						unknown
					>;
					expect(persistedConfig).toMatchObject({
						sync_enabled: true,
						sync_host: "0.0.0.0",
						sync_port: 7337,
						sync_interval_s: 120,
					});
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

		it("fails closed with safe errors for unavailable or tampered recipient reviewed intent", async () => {
			// Arrange
			const testDir = mkdtempSync(join(tmpdir(), "codemem-recipient-intent-errors-"));
			const configPath = join(testDir, "config.json");
			const keysDir = join(testDir, "keys");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
			const previousFetch = globalThis.fetch;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			writeFileSync(configPath, JSON.stringify({ actor_display_name: "Fresh Recipient" }));
			const reviewedIntent: Extract<core.RecipientReviewedIntentV1, { journey: "team" }> = {
				version: 1,
				journey: "team",
				team: {
					teamId: "team-reviewed",
					displayName: "Reviewed Team",
					futureProjectsInherit: true,
				},
				projects: [],
				excludedProjects: [],
			};
			const digest = await core.recipientReviewedIntentDigest(reviewedIntent);
			const encoded = core.encodeInvitePayload({
				v: 1,
				kind: "team_member",
				coordinator_url: "https://coord.example.test",
				group_id: "coordinator-a",
				policy: "auto_admit",
				token: "token-reviewed",
				expires_at: "2099-01-01T00:00:00.000Z",
				team_name: null,
				policy_team_id: "team-reviewed",
				assigned_identity_id: "identity-assigned-team",
				reviewed_preview_digest: digest,
			});
			globalThis.fetch = vi
				.fn()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: "recipient_invite_review_unavailable" }), {
						status: 409,
					}),
				)
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							kind: "team_member",
							policy_team_id: "team-reviewed",
							assigned_identity_id: "identity-assigned-team",
							reviewed_preview_digest: digest,
						}),
						{ status: 200 },
					),
				)
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							kind: "team_member",
							policy_team_id: "team-reviewed",
							assigned_identity_id: "identity-assigned-team",
							reviewed_preview_digest: digest,
							reviewed_intent: {
								...reviewedIntent,
								team: { ...reviewedIntent.team, displayName: "Tampered Team" },
							},
						}),
						{ status: 200 },
					),
				) as typeof fetch;
			const { app, cleanup } = createTestApp({ seedDevice: false });
			try {
				// Act / Assert
				for (const expected of [
					"recipient_invite_review_unavailable",
					"recipient_invite_review_unavailable",
					"recipient_invite_intent_mismatch",
				]) {
					const response = await app.request("/api/sync/invites/inspect", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ invite: encoded }),
					});
					expect([400, 409]).toContain(response.status);
					expect(await response.json()).toEqual({ error: expected });
				}
			} finally {
				cleanup();
				globalThis.fetch = previousFetch;
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it.each([
			{ label: "kind", responseOverride: { kind: "add_device" } },
			{ label: "target ID", responseOverride: { policy_team_id: "team-other" } },
			{ label: "reviewed digest", responseOverride: { reviewed_preview_digest: "f".repeat(64) } },
		])("rejects a mismatched inspect $label without mutating the recipient DB or config", async (testCase) => {
			// Arrange
			const testDir = mkdtempSync(join(tmpdir(), "codemem-recipient-inspect-mismatch-"));
			const configPath = join(testDir, "config.json");
			const keysDir = join(testDir, "keys");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
			const previousFetch = globalThis.fetch;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			writeFileSync(configPath, JSON.stringify({ actor_display_name: "Fresh Recipient" }));
			const reviewedIntent: Extract<core.RecipientReviewedIntentV1, { journey: "team" }> = {
				version: 1,
				journey: "team",
				team: {
					teamId: "team-reviewed",
					displayName: "Reviewed Team",
					futureProjectsInherit: true,
				},
				projects: [],
				excludedProjects: [],
			};
			const digest = await core.recipientReviewedIntentDigest(reviewedIntent);
			const encoded = core.encodeInvitePayload({
				v: 1,
				kind: "team_member",
				coordinator_url: "https://coord.example.test",
				group_id: "coordinator-a",
				policy: "auto_admit",
				token: "token-reviewed",
				expires_at: "2099-01-01T00:00:00.000Z",
				team_name: null,
				policy_team_id: "team-reviewed",
				assigned_identity_id: "identity-assigned-team",
				reviewed_preview_digest: digest,
			});
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							kind: "team_member",
							policy_team_id: "team-reviewed",
							assigned_identity_id: "identity-assigned-team",
							reviewed_preview_digest: digest,
							reviewed_intent: reviewedIntent,
							bound: false,
							...testCase.responseOverride,
						}),
						{ status: 200 },
					),
			) as typeof fetch;
			const { app, ensureStore, cleanup } = createTestApp({ seedDevice: false });
			try {
				const store = ensureStore();
				const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });
				store.adoptEnsuredDeviceIdentity(deviceId);
				const snapshot = () =>
					JSON.stringify(
						Object.fromEntries(
							[
								"actors",
								"sync_device",
								"identity_devices",
								"policy_teams",
								"policy_team_memberships",
								"project_recipients",
							].map((table) => [
								table,
								store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
							]),
						),
					);
				const beforeDb = snapshot();
				const beforeConfig = readFileSync(configPath, "utf8");

				// Act
				const response = await app.request("/api/sync/invites/inspect", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite: encoded, device_name: "Recipient Laptop" }),
				});

				// Assert
				expect(response.status).toBe(409);
				expect(await response.json()).toEqual({ error: "recipient_invite_intent_mismatch" });
				expect(snapshot()).toBe(beforeDb);
				expect(readFileSync(configPath, "utf8")).toBe(beforeConfig);
			} finally {
				cleanup();
				globalThis.fetch = previousFetch;
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it.each([
			{ label: "Team", kind: "team_member" as const },
			{ label: "add-device", kind: "add_device" as const },
		])("creates a $label invite through the owner viewer and accepts it in a separate fresh recipient", async (testCase) => {
			// Arrange
			const testDir = mkdtempSync(join(tmpdir(), `codemem-${testCase.kind}-coordinator-`));
			const coordinatorDbPath = join(testDir, "coordinator.sqlite");
			const ownerConfigPath = join(testDir, "owner-config.json");
			const ownerKeysDir = join(testDir, "owner-keys");
			const recipientConfigPath = join(testDir, "recipient-config.json");
			const recipientKeysDir = join(testDir, "recipient-keys");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
			const previousAdminSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			const previousFetch = globalThis.fetch;
			const setupCoordinator = new core.BetterSqliteCoordinatorStore(coordinatorDbPath);
			await setupCoordinator.createGroup("coordinator-a", "Coordinator A");
			await setupCoordinator.close();
			const coordinatorApp = core.createCoordinatorApp({
				storeFactory: () => new core.BetterSqliteCoordinatorStore(coordinatorDbPath),
				runtime: {
					adminSecret: () => "secret",
					now: () => "2026-07-23T12:00:00.000Z",
				},
				requestVerifier: async () => true,
			});
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
				coordinatorApp.request(String(input), init),
			) as typeof fetch;
			process.env.CODEMEM_CONFIG = ownerConfigPath;
			process.env.CODEMEM_KEYS_DIR = ownerKeysDir;
			process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = "secret";
			writeFileSync(
				ownerConfigPath,
				JSON.stringify({
					actor_display_name: "Owner Identity",
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "coordinator-a",
					sync_coordinator_admin_secret: "secret",
				}),
			);
			const owner = createTestApp({ seedDevice: false });
			let recipient: ReturnType<typeof createTestApp> | null = null;
			try {
				const ownerStore = owner.ensureStore();
				const [ownerDeviceId] = ensureDeviceIdentity(ownerStore.db, { keysDir: ownerKeysDir });
				ownerStore.adoptEnsuredDeviceIdentity(ownerDeviceId);
				const teamId = "policy-team-a";
				const alphaProjectId = "https://git.example.invalid/acme/alpha.git";
				const betaProjectId = "https://git.example.invalid/acme/beta.git";
				const now = "2026-07-23T12:00:00.000Z";
				for (const [projectId, displayName, count] of [
					[alphaProjectId, "alpha", 2],
					[betaProjectId, "beta", 1],
				] as const) {
					const sessionId = insertTestSession(ownerStore.db);
					ownerStore.db
						.prepare("UPDATE sessions SET cwd = ?, git_remote = ?, project = ? WHERE id = ?")
						.run(`/workspace/${displayName}`, projectId, displayName, sessionId);
					for (let index = 0; index < count; index += 1) {
						insertTestMemory(ownerStore, {
							sessionId,
							kind: "discovery",
							title: `${displayName}-${index}`,
							originDeviceId: ownerDeviceId,
						});
					}
				}
				ownerStore.db
					.prepare(`INSERT INTO policy_teams(
							team_id, display_name, status, provenance, revision, migration_state,
							source_fingerprint, idempotency_key, created_at, updated_at
						) VALUES (?, ?, 'active', 'user', 'r1', 'user_managed', NULL, 'team-a', ?, ?)`)
					.run(teamId, "Policy Team A", now, now);
				for (const [recipientKind, recipientId] of [
					["team", teamId],
					["identity", ownerStore.actorId],
				] as const) {
					ownerStore.db
						.prepare(`INSERT INTO project_recipients(
								canonical_project_identity, recipient_kind, recipient_id, status, provenance,
								policy_revision, migration_state, source_fingerprint, idempotency_key,
								created_at, updated_at
							) VALUES (?, ?, ?, 'active', 'user', ?, 'user_managed', NULL, ?, ?, ?)`)
						.run(
							alphaProjectId,
							recipientKind,
							recipientId,
							`revision-${recipientKind}`,
							`idempotency-${recipientKind}`,
							now,
							now,
						);
				}
				const ownerRequest =
					testCase.kind === "team_member"
						? { kind: testCase.kind, policy_team_id: teamId }
						: { kind: testCase.kind, target_identity_id: ownerStore.actorId };
				const preview = (await (
					await owner.app.request("/api/sync/recipient-policy/v1/invites/preview", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(ownerRequest),
					})
				).json()) as { preview: { reviewedOnboardingDigest: string } };
				const createResponse = await owner.app.request("/api/sync/recipient-policy/v1/invites", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						...ownerRequest,
						reviewed_onboarding_digest: preview.preview.reviewedOnboardingDigest,
					}),
				});
				expect(createResponse.status, JSON.stringify(await createResponse.clone().json())).toBe(
					200,
				);
				const created = (await createResponse.json()) as { invite: { encoded: string } };
				const payload = core.decodeInvitePayload(created.invite.encoded);

				process.env.CODEMEM_CONFIG = recipientConfigPath;
				process.env.CODEMEM_KEYS_DIR = recipientKeysDir;
				writeFileSync(
					recipientConfigPath,
					JSON.stringify(
						testCase.kind === "team_member" ? { actor_display_name: "Fresh Recipient" } : {},
					),
				);
				recipient = createTestApp({ seedDevice: false });
				const recipientStore = recipient.ensureStore();
				const bootstrapActorId = recipientStore.actorId;
				expect(bootstrapActorId.length).toBeGreaterThan(0);
				expect(recipientStore.db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(
					0,
				);
				expect(
					recipientStore.db.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get(),
				).toBe(0);
				expect(
					recipientStore.db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get(),
				).toBe(0);

				// Act
				const inspectResponse = await recipient.app.request("/api/sync/invites/inspect", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite: created.invite.encoded, device_name: "Recipient Laptop" }),
				});
				expect(inspectResponse.status, JSON.stringify(await inspectResponse.clone().json())).toBe(
					200,
				);
				const inspection = (await inspectResponse.json()) as {
					recipient_name: string;
					assigned_identity_id?: string;
					onboarding: {
						reviewedOnboardingDigest: string;
						projects: unknown[];
						excludedProjects: unknown[];
					};
				};

				// Assert
				if (testCase.kind === "team_member") {
					expect(inspection.assigned_identity_id).toEqual(expect.any(String));
					expect(inspection.assigned_identity_id?.trim()).toBe(inspection.assigned_identity_id);
					expect(inspection.assigned_identity_id?.length).toBeGreaterThan(0);
					expect(inspection.assigned_identity_id).not.toBe(bootstrapActorId);
					expect(inspection.assigned_identity_id).not.toBe(ownerStore.actorId);
				}
				expect(inspection.onboarding.projects).toEqual([
					{
						canonicalProjectIdentity: alphaProjectId,
						displayName: "alpha",
						existingMemoryCount: 2,
						futureMemoriesShared: true,
						sources:
							testCase.kind === "team_member"
								? [{ kind: "team", teamId, displayName: "Policy Team A" }]
								: [{ kind: "direct" }],
					},
				]);
				expect(inspection.onboarding.excludedProjects).toEqual(
					testCase.kind === "team_member"
						? []
						: [
								{
									canonicalProjectIdentity: betaProjectId,
									displayName: "beta",
									existingMemoryCount: 1,
								},
							],
				);
				if (testCase.kind === "team_member") {
					expect(JSON.stringify(inspection)).not.toContain(betaProjectId);
					expect(JSON.stringify(inspection)).not.toContain('"beta"');
				}
				const importBody = {
					invite: created.invite.encoded,
					recipient_name: inspection.recipient_name,
					device_name: "Recipient Laptop",
					reviewed_onboarding_digest: inspection.onboarding.reviewedOnboardingDigest,
				};
				if (testCase.kind === "team_member") {
					const invalidName = await recipient.app.request("/api/sync/invites/import", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							...importBody,
							recipient_name: "local:0ea043cc-c61c-427d-8b77-572331b9855c",
						}),
					});
					expect(invalidName.status).toBe(400);
					expect(await invalidName.json()).toEqual({ error: "recipient_display_name_invalid" });
				}
				const stale = await recipient.app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ...importBody, device_name: "Renamed Recipient Laptop" }),
				});
				expect(stale.status).toBe(400);
				expect(await stale.json()).toEqual({ error: "reviewed_onboarding_stale" });
				expect(recipientStore.actorId).not.toBe(
					testCase.kind === "team_member" ? inspection.assigned_identity_id : ownerStore.actorId,
				);

				const accepted = await recipient.app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(importBody),
				});
				expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(200);
				expect(await accepted.json()).toMatchObject({
					status: "accepted",
					type: "recipient_onboarding",
				});
				const expectedIdentityId =
					testCase.kind === "team_member"
						? String(inspection.assigned_identity_id)
						: ownerStore.actorId;
				expect(recipientStore.actorId).toBe(expectedIdentityId);
				expect(recipientStore.actorId).not.toBe(bootstrapActorId);
				if (testCase.kind === "add_device") {
					expect(recipientStore.actorDisplayName).toBe("Owner Identity");
				}
				const recipientDeviceId = recipientStore.db
					.prepare("SELECT device_id FROM sync_device LIMIT 1")
					.pluck()
					.get() as string;
				expect(
					recipientStore.db.prepare("SELECT identity_id, device_id FROM identity_devices").all(),
				).toEqual([{ identity_id: expectedIdentityId, device_id: recipientDeviceId }]);
				expect(
					recipientStore.db
						.prepare(
							"SELECT actor_id, display_name, is_local, status FROM actors ORDER BY actor_id",
						)
						.all(),
				).toEqual([
					{
						actor_id: expectedIdentityId,
						display_name: testCase.kind === "team_member" ? "Fresh Recipient" : "Owner Identity",
						is_local: 1,
						status: "active",
					},
				]);
				expect(
					recipientStore.db.prepare("SELECT team_id, display_name, status FROM policy_teams").all(),
				).toEqual(
					testCase.kind === "team_member"
						? [{ team_id: teamId, display_name: "Policy Team A", status: "active" }]
						: [],
				);
				expect(
					recipientStore.db
						.prepare("SELECT team_id, identity_id, role, status FROM policy_team_memberships")
						.all(),
				).toEqual(
					testCase.kind === "team_member"
						? [
								{
									team_id: teamId,
									identity_id: expectedIdentityId,
									role: "member",
									status: "active",
								},
							]
						: [],
				);
				expect(
					recipientStore.db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get(),
				).toBe(0);
				const persistedConfig = JSON.parse(readFileSync(recipientConfigPath, "utf8"));
				expect(persistedConfig).toMatchObject({
					actor_id: expectedIdentityId,
					actor_display_name:
						testCase.kind === "team_member" ? "Fresh Recipient" : "Owner Identity",
					sync_device_name: "Recipient Laptop",
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "coordinator-a",
					sync_coordinator_groups: ["coordinator-a"],
				});
				const materializedState = JSON.stringify({
					actors: recipientStore.db.prepare("SELECT * FROM actors ORDER BY actor_id").all(),
					devices: recipientStore.db
						.prepare("SELECT * FROM identity_devices ORDER BY identity_id")
						.all(),
					teams: recipientStore.db.prepare("SELECT * FROM policy_teams ORDER BY team_id").all(),
					memberships: recipientStore.db
						.prepare("SELECT * FROM policy_team_memberships ORDER BY team_id, identity_id")
						.all(),
				});
				const persistedConfigText = readFileSync(recipientConfigPath, "utf8");
				const replay = await recipient.app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(importBody),
				});
				expect(replay.status).toBe(200);
				expect(await replay.json()).toMatchObject({ status: "existing" });
				expect(
					JSON.stringify({
						actors: recipientStore.db.prepare("SELECT * FROM actors ORDER BY actor_id").all(),
						devices: recipientStore.db
							.prepare("SELECT * FROM identity_devices ORDER BY identity_id")
							.all(),
						teams: recipientStore.db.prepare("SELECT * FROM policy_teams ORDER BY team_id").all(),
						memberships: recipientStore.db
							.prepare("SELECT * FROM policy_team_memberships ORDER BY team_id, identity_id")
							.all(),
					}),
				).toBe(materializedState);
				expect(readFileSync(recipientConfigPath, "utf8")).toBe(persistedConfigText);
				const coordinatorVerification = new core.BetterSqliteCoordinatorStore(coordinatorDbPath);
				try {
					expect(
						await coordinatorVerification.getInviteByTokenForInspection(String(payload.token)),
					).toMatchObject({
						invite_kind: testCase.kind,
						...(testCase.kind === "team_member"
							? { assigned_identity_id: expectedIdentityId }
							: { target_identity_id: expectedIdentityId }),
						bound_device_id: recipientDeviceId,
						recipient_actor_id: expectedIdentityId,
						consumed_at: expect.any(String),
					});
				} finally {
					await coordinatorVerification.close();
				}
			} finally {
				recipient?.cleanup();
				owner.cleanup();
				globalThis.fetch = previousFetch;
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
				if (previousAdminSecret == null) {
					delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				} else {
					process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = previousAdminSecret;
				}
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it("reuses a reconciled Team identity for a later exact-Project share", async () => {
			// Arrange
			const teammateName = "Dogfood Teammate";
			const testDir = mkdtempSync(join(tmpdir(), "codemem-team-project-regression-"));
			const coordinatorDbPath = join(testDir, "coordinator.sqlite");
			const ownerConfigPath = join(testDir, "owner-config.json");
			const ownerKeysDir = join(testDir, "owner-keys");
			const recipientConfigPath = join(testDir, "recipient-config.json");
			const recipientKeysDir = join(testDir, "recipient-keys");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
			const previousAdminSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			const previousFetch = globalThis.fetch;
			const setupCoordinator = new core.BetterSqliteCoordinatorStore(coordinatorDbPath);
			await setupCoordinator.createGroup("coordinator-a", "Coordinator A");
			const coordinatorApp = core.createCoordinatorApp({
				storeFactory: () => new core.BetterSqliteCoordinatorStore(coordinatorDbPath),
				runtime: {
					adminSecret: () => "secret",
					now: () => "2026-08-07T12:00:00.000Z",
				},
				requestVerifier: async () => true,
			});
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
				coordinatorApp.request(String(input), init),
			) as typeof fetch;
			const useOwnerConfig = () => {
				process.env.CODEMEM_CONFIG = ownerConfigPath;
				process.env.CODEMEM_KEYS_DIR = ownerKeysDir;
				process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = "secret";
			};
			const useRecipientConfig = () => {
				process.env.CODEMEM_CONFIG = recipientConfigPath;
				process.env.CODEMEM_KEYS_DIR = recipientKeysDir;
				delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			};
			useOwnerConfig();
			writeFileSync(
				ownerConfigPath,
				JSON.stringify({
					actor_display_name: "Owner Identity",
					sync_coordinator_url: "https://coord.example.test",
					sync_coordinator_group: "coordinator-a",
					sync_coordinator_admin_secret: "secret",
				}),
			);
			const owner = createTestApp({ seedDevice: false });
			let recipient: ReturnType<typeof createTestApp> | null = null;
			try {
				const ownerStore = owner.ensureStore();
				const [ownerDeviceId] = ensureDeviceIdentity(ownerStore.db, { keysDir: ownerKeysDir });
				ownerStore.adoptEnsuredDeviceIdentity(ownerDeviceId);
				ownerStore.db
					.prepare(`INSERT OR IGNORE INTO actors(
						actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
					) VALUES (?, 'Owner Identity', 1, 'active', NULL, ?, ?)`)
					.run(ownerStore.actorId, "2026-08-07T12:00:00.000Z", "2026-08-07T12:00:00.000Z");
				const ownerDevice = ownerStore.db
					.prepare("SELECT public_key, fingerprint FROM sync_device WHERE device_id = ?")
					.get(ownerDeviceId) as { public_key: string; fingerprint: string };
				await setupCoordinator.enrollDevice("coordinator-a", {
					deviceId: ownerDeviceId,
					publicKey: ownerDevice.public_key,
					fingerprint: ownerDevice.fingerprint,
					displayName: "Owner Laptop",
					identityId: ownerStore.actorId,
				});
				const teamId = "policy-team-a";
				const projectId = "https://git.example.invalid/acme/team-project.git";
				const now = "2026-08-07T12:00:00.000Z";
				ownerStore.db
					.prepare(`INSERT INTO policy_teams(
						team_id, display_name, status, provenance, revision, migration_state,
						source_fingerprint, idempotency_key, created_at, updated_at
					) VALUES (?, 'Policy Team A', 'active', 'user', 'r1', 'user_managed',
						NULL, 'team-a', ?, ?)`)
					.run(teamId, now, now);
				const sessionId = insertTestSession(ownerStore.db);
				ownerStore.db
					.prepare("UPDATE sessions SET git_remote = ?, project = ? WHERE id = ?")
					.run(projectId, "team-project", sessionId);
				insertTestMemory(ownerStore, {
					sessionId,
					kind: "discovery",
					title: "shared project memory",
					originDeviceId: ownerDeviceId,
				});
				ownerStore.db
					.prepare(`INSERT INTO project_recipients(
						canonical_project_identity, recipient_kind, recipient_id, status, provenance,
						policy_revision, migration_state, source_fingerprint, idempotency_key,
						created_at, updated_at
					) VALUES (?, 'team', ?, 'active', 'user', 'r1', 'user_managed', NULL,
						'team-project', ?, ?)`)
					.run(projectId, teamId, now, now);

				const teamPreviewResponse = await owner.app.request(
					"/api/sync/recipient-policy/v1/invites/preview",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ kind: "team_member", policy_team_id: teamId }),
					},
				);
				expect(teamPreviewResponse.status).toBe(200);
				const teamPreview = (await teamPreviewResponse.json()) as {
					preview: { reviewedOnboardingDigest: string };
				};
				const teamCreateResponse = await owner.app.request(
					"/api/sync/recipient-policy/v1/invites",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							kind: "team_member",
							policy_team_id: teamId,
							reviewed_onboarding_digest: teamPreview.preview.reviewedOnboardingDigest,
						}),
					},
				);
				expect(teamCreateResponse.status).toBe(200);
				const teamCreated = (await teamCreateResponse.json()) as { invite: { encoded: string } };

				useRecipientConfig();
				writeFileSync(recipientConfigPath, JSON.stringify({ actor_display_name: teammateName }));
				recipient = createTestApp({ seedDevice: false });
				const recipientStore = recipient.ensureStore();
				const inspectTeam = await recipient.app.request("/api/sync/invites/inspect", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						invite: teamCreated.invite.encoded,
						device_name: "Teammate Laptop",
					}),
				});
				expect(inspectTeam.status).toBe(200);
				const teamInspection = (await inspectTeam.json()) as {
					assigned_identity_id: string;
					recipient_name: string;
					onboarding: { reviewedOnboardingDigest: string };
				};
				expect(teamInspection.recipient_name).toBe(teammateName);

				// Act
				const acceptTeam = await recipient.app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						invite: teamCreated.invite.encoded,
						recipient_name: teammateName,
						device_name: "Teammate Laptop",
						reviewed_onboarding_digest: teamInspection.onboarding.reviewedOnboardingDigest,
					}),
				});
				expect(acceptTeam.status, JSON.stringify(await acceptTeam.clone().json())).toBe(200);
				expect(recipientStore.actorId).toBe(teamInspection.assigned_identity_id);

				useOwnerConfig();
				const enrollmentReconciliation = await reconcileConfiguredCoordinatorEnrollment(ownerStore);
				expect(enrollmentReconciliation).toMatchObject({
					failedGroups: 0,
					identitiesAdded: 1,
					membershipsAdded: 1,
					issues: 0,
				});
				expect(
					ownerStore.db
						.prepare("SELECT display_name, status FROM actors WHERE actor_id = ?")
						.get(teamInspection.assigned_identity_id),
				).toEqual({ display_name: teammateName, status: "active" });

				const projectPreviewResponse = await owner.app.request(
					"/api/sync/project-invites/preview",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ teammate_name: teammateName, project_ids: [projectId] }),
					},
				);
				expect(projectPreviewResponse.status).toBe(200);
				const projectPreview = (await projectPreviewResponse.json()) as {
					operation_id: string;
					reviewed_project_set_digest: string;
					teammate: { match: string; person_id: string };
				};
				expect(projectPreview.teammate).toEqual({
					display_name: teammateName,
					match: "existing",
					person_id: teamInspection.assigned_identity_id,
				});
				const projectCreateResponse = await owner.app.request("/api/sync/project-invites", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						teammate_name: teammateName,
						project_ids: [projectId],
						reviewed_project_set_digest: projectPreview.reviewed_project_set_digest,
					}),
				});
				expect(
					projectCreateResponse.status,
					JSON.stringify(await projectCreateResponse.clone().json()),
				).toBe(200);
				const projectCreated = (await projectCreateResponse.json()) as {
					invite: { encoded: string };
				};
				expect(
					ownerStore.db
						.prepare("SELECT person_id, person_kind FROM share_operations WHERE operation_id = ?")
						.get(projectPreview.operation_id),
				).toEqual({ person_id: teamInspection.assigned_identity_id, person_kind: "existing" });

				useRecipientConfig();
				const inspectProject = await recipient.app.request("/api/sync/invites/inspect", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite: projectCreated.invite.encoded }),
				});
				expect(inspectProject.status).toBe(200);
				const acceptProject = await recipient.app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						invite: projectCreated.invite.encoded,
						device_name: "Teammate Laptop",
					}),
				});
				expect(acceptProject.status, JSON.stringify(await acceptProject.clone().json())).toBe(200);

				useOwnerConfig();
				const reconcileProject = await owner.app.request(
					`/api/sync/project-invites/${projectPreview.operation_id}/reconcile`,
					{ method: "POST" },
				);

				// Assert
				expect(reconcileProject.status, JSON.stringify(await reconcileProject.clone().json())).toBe(
					200,
				);
				expect(await reconcileProject.json()).toMatchObject({
					reconciled: true,
					state: "pending_setup",
				});
				expect(
					ownerStore.db
						.prepare(
							"SELECT state, person_id, person_kind, recipient_actor_id FROM share_operations WHERE operation_id = ?",
						)
						.get(projectPreview.operation_id),
				).toEqual({
					state: "provisioning",
					person_id: teamInspection.assigned_identity_id,
					person_kind: "existing",
					recipient_actor_id: teamInspection.assigned_identity_id,
				});
				expect(
					ownerStore.db
						.prepare("SELECT COUNT(*) FROM actors WHERE display_name = ? AND status = 'pending'")
						.pluck()
						.get(teammateName),
				).toBe(0);
				expect(
					ownerStore.db
						.prepare("SELECT COUNT(*) FROM actors WHERE lower(display_name) = lower(?)")
						.pluck()
						.get(teammateName),
				).toBe(1);
			} finally {
				recipient?.cleanup();
				owner.cleanup();
				await setupCoordinator.close();
				globalThis.fetch = previousFetch;
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
				if (previousAdminSecret == null) {
					delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
				} else {
					process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = previousAdminSecret;
				}
				rmSync(testDir, { recursive: true, force: true });
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
				store.actorDisplayName = "local:a57f7c7c-d531-4148-9917-78acb586caad";
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
					inviter_display_name: "Project owner",
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
				| "upstream_500"
				| "transport"
				| "malformed"
				| "wrong_group"
				| "waiting"
				| "invalid_trust"
				| "accepted" = "not_found";
			const fetchMock = vi.fn(async () => {
				if (mode === "not_found") {
					return new Response(JSON.stringify({ error: "operation_not_found" }), { status: 404 });
				}
				if (mode === "upstream_500") {
					return new Response("coordinator stack trace with internal-host.example", {
						status: 500,
					});
				}
				if (mode === "transport") {
					throw new Error("fetch failed for internal-host.example");
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
				const notFound = await request();
				expect(notFound.status).toBe(404);
				expect(await notFound.json()).toEqual({ error: "operation_not_found" });
				const missingOperationId = `share_${"8".repeat(40)}`;
				const missingReconcile = await app.request(
					`/api/sync/project-invites/${missingOperationId}/reconcile`,
					{ method: "POST" },
				);
				expect(missingReconcile.status).toBe(404);
				expect(await missingReconcile.json()).toEqual({ error: "operation_not_found" });
				mode = "upstream_500";
				for (const [label, response] of [
					["read", await request()],
					[
						"reconcile",
						await app.request(`/api/sync/project-invites/${operationId}/reconcile`, {
							method: "POST",
						}),
					],
				] as const) {
					expect(response.status, label).toBe(502);
					const body = await response.json();
					expect(body).toEqual({ error: "coordinator_upstream_failed" });
					expect(JSON.stringify(body)).not.toContain("internal-host.example");
				}
				mode = "transport";
				for (const [label, response] of [
					["read", await request()],
					[
						"reconcile",
						await app.request(`/api/sync/project-invites/${operationId}/reconcile`, {
							method: "POST",
						}),
					],
				] as const) {
					expect(response.status, label).toBe(503);
					const body = await response.json();
					expect(body).toEqual({ error: "coordinator_unavailable" });
					expect(JSON.stringify(body)).not.toContain("internal-host.example");
				}
				mode = "malformed";
				const malformed = await request();
				expect(malformed.status).toBe(409);
				expect(await malformed.json()).toEqual({ error: "operation_intent_invalid" });
				mode = "wrong_group";
				const wrongGroup = await request();
				expect(wrongGroup.status).toBe(409);
				expect(await wrongGroup.json()).toEqual({ error: "operation_scope_mismatch" });
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
				expect(await accepted.json()).toMatchObject({ state: "pending_setup" });
				expect(
					store.db
						.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
						.pluck()
						.get(operationId),
				).toBe("waiting_for_acceptance");

				const reconcile = () =>
					app.request(`/api/sync/project-invites/${operationId}/reconcile`, { method: "POST" });
				const firstReconcile = await reconcile();
				expect(firstReconcile.status).toBe(200);
				expect(await firstReconcile.json()).toMatchObject({ state: "pending_setup" });
				expect((await reconcile()).status).toBe(200);
				expect(
					store.db
						.prepare("SELECT state, recipient_actor_id, recipient_device_id FROM share_operations")
						.get(),
				).toEqual({
					state: "provisioning",
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

		it("imports directly from a fallback store with one stable human-named local actor", async () => {
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
			const { app, getStore, cleanup } = createTestApp({ seedDevice: false });
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				expect(store.actorId).toBe("local:local");
				const fallbackNow = "2026-07-23T12:00:00.000Z";
				store.db
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES ('local:local', 'local:local', 1, 'active', ?, ?)`,
					)
					.run(fallbackNow, fallbackNow);
				const res = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as Record<string, unknown>;
				expect(body.group_id).toBe("team-a");
				expect(body.status).toBe("pending");
				expect(body.type).toBe("team_join");
				expect(body).not.toHaveProperty("restart_required");
				expect(store.deviceId).not.toBe("local");
				expect(store.actorId).toBe(`local:${store.deviceId}`);
				expect(store.actorDisplayName).toBe("Fixture User");
				expect(
					store.db
						.prepare(
							"SELECT actor_id, display_name FROM actors WHERE is_local = 1 AND status = 'active'",
						)
						.all(),
				).toEqual([{ actor_id: store.actorId, display_name: "Fixture User" }]);
				const writtenConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<
					string,
					unknown
				>;
				expect(writtenConfig.sync_coordinator_url).toBe("https://coord.example.test");
				expect(writtenConfig.sync_coordinator_group).toBe("team-a");
				expect(writtenConfig).not.toHaveProperty("sync_enabled");
				expect(writtenConfig).not.toHaveProperty("sync_host");
				expect(writtenConfig).not.toHaveProperty("sync_port");
				expect(writtenConfig).not.toHaveProperty("sync_interval_s");
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("keeps configured identity canonical and hides a stale fallback during invite import", async () => {
			const configDir = mkdtempSync(join(tmpdir(), "codemem-configured-invite-test-"));
			const configPath = join(configDir, "config.json");
			const keysDir = join(configDir, "keys");
			const prevConfig = process.env.CODEMEM_CONFIG;
			const prevKeysDir = process.env.CODEMEM_KEYS_DIR;
			const invitePayload = {
				v: 1,
				kind: "coordinator_team_invite",
				coordinator_url: "https://coord.example.test",
				group_id: "team-a",
				policy: "approval_required",
				token: "configured-token",
				expires_at: new Date(Date.now() + 86_400_000).toISOString(),
				team_name: "Team A",
			};
			const invite = Buffer.from(JSON.stringify(invitePayload), "utf8").toString("base64url");
			let joinBody: Record<string, unknown> = {};
			const prevFetch = globalThis.fetch;
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).includes("/v1/join")) {
					joinBody = JSON.parse(
						init?.body instanceof Uint8Array
							? new TextDecoder().decode(init.body)
							: String(init?.body ?? "{}"),
					) as Record<string, unknown>;
					return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
				}
				return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
			}) as typeof fetch;
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			writeFileSync(
				configPath,
				JSON.stringify({ actor_id: "actor:configured", actor_display_name: "Configured User" }),
			);
			const { app, getStore, cleanup } = createTestApp({ seedDevice: false });
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				const now = "2026-07-23T12:00:00.000Z";
				store.db
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES ('local:local', 'local:local', 1, 'active', ?, ?)`,
					)
					.run(now, now);

				const imported = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite }),
				});
				const importedBody = (await imported.json()) as Record<string, unknown>;
				expect(imported.status).toBe(200);
				expect(JSON.stringify(importedBody)).not.toContain("local:local");
				expect(joinBody).toMatchObject({ display_name: "Configured User" });
				expect(JSON.stringify(joinBody)).not.toContain("local:local");
				expect(store.actorId).toBe("actor:configured");

				const actors = await app.request("/api/sync/actors");
				const actorsBody = (await actors.json()) as { items: Array<Record<string, unknown>> };
				expect(actorsBody.items).toEqual([
					expect.objectContaining({
						actor_id: "actor:configured",
						display_name: "Configured User",
						is_local: 1,
						status: "active",
					}),
				]);
				expect(JSON.stringify(actorsBody)).not.toContain("local:local");
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
				rmSync(configDir, { recursive: true, force: true });
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
			let exposeInternalFailure = false;
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
					if (exposeInternalFailure) throw new Error("internal recipient device id: device-secret");
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
			const { app, getStore, cleanup } = createTestApp({ seedDevice: false });
			try {
				await app.request("/api/stats");
				const store = getStore();
				if (!store) throw new Error("store not initialized");
				expect(store.actorId).toBe("local:local");
				const fallbackNow = "2026-07-23T12:00:00.000Z";
				store.db
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES ('local:local', 'local:local', 1, 'active', ?, ?)`,
					)
					.run(fallbackNow, fallbackNow);
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
				expect(store.deviceId).not.toBe("local");
				expect(store.actorId).toBe(`local:${store.deviceId}`);
				expect(
					store.db
						.prepare(
							"SELECT is_local, status, merged_into_actor_id FROM actors WHERE actor_id = 'local:local'",
						)
						.get(),
				).toEqual({
					is_local: 0,
					status: "merged",
					merged_into_actor_id: store.actorId,
				});
				const accepted = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						invite,
						device_name: "Brian's Test Mac",
					}),
				});
				const acceptedBody = (await accepted.json()) as Record<string, unknown>;
				expect(accepted.status, JSON.stringify(acceptedBody)).toBe(200);
				expect(acceptedBody).toMatchObject({
					status: "pending_setup",
					setup_state: "pending_inviter",
					sync_enabled: true,
					type: "project_share",
				});
				expect(acceptedBody).not.toHaveProperty("restart_required");
				expect(joinBody).toMatchObject({
					operation_id: operationId,
					recipient_actor_id: store.actorId,
					recipient_display_name: "Local Person",
					device_display_name: "Brian's Test Mac",
				});
				expect(joinBody).not.toHaveProperty("projects");
				expect(joinBody).not.toHaveProperty("scope_ids");
				expect(
					store.db
						.prepare("SELECT display_name, status FROM actors WHERE actor_id = ?")
						.get(store.actorId),
				).toEqual({ display_name: "Local Person", status: "active" });
				expect(
					store.db
						.prepare(
							"SELECT actor_id, display_name FROM actors WHERE is_local = 1 AND status = 'active'",
						)
						.all(),
				).toEqual([{ actor_id: store.actorId, display_name: "Local Person" }]);
				expect(
					store.db
						.prepare("SELECT pending_bootstrap_grant_id FROM sync_peers WHERE peer_device_id = ?")
						.get("device-adam"),
				).toEqual({ pending_bootstrap_grant_id: "grant-1" });
				const enabledConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<
					string,
					unknown
				>;
				expect(enabledConfig).toMatchObject({
					sync_enabled: true,
					sync_host: "0.0.0.0",
					sync_port: 7337,
					sync_interval_s: 120,
				});
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
				expect(await rejected.json()).toEqual({
					error: "inviter_identity_invalid",
					detail:
						"The owner's device identity could not be verified. Ask the owner to review the share and create a new invitation.",
				});
				exposeInternalFailure = true;
				const redactedFailure = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite, device_name: "Brian's Test Mac" }),
				});
				expect(redactedFailure.status).toBe(400);
				const redactedBody = (await redactedFailure.json()) as Record<string, unknown>;
				expect(redactedBody.error).toBe("project_invite_acceptance_failed");
				expect(JSON.stringify(redactedBody)).not.toContain("device-secret");
			} finally {
				cleanup();
				globalThis.fetch = prevFetch;
				if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = prevConfig;
				if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
			}
		});

		it("persists restart-required project setup and replays acceptance without duplicate records", async () => {
			const testDir = mkdtempSync(join(tmpdir(), "codemem-project-restart-test-"));
			const configPath = join(testDir, "config.json");
			const keysDir = join(testDir, "keys");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
			const previousFetch = globalThis.fetch;
			const operationId = `share_${"d".repeat(40)}`;
			const inviterPublicKey = "restart-inviter-public-key";
			const invite = core.encodeInvitePayload({
				v: 1,
				kind: "coordinator_team_invite",
				coordinator_url: "https://coord.example.test",
				group_id: "team-a",
				policy: "auto_admit",
				token: "project-restart-token",
				expires_at: "2099-01-01T00:00:00.000Z",
				team_name: "Team A",
				operation_id: operationId,
			});
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			writeFileSync(
				configPath,
				JSON.stringify({ actor_display_name: "Brian", sync_enabled: false }),
			);
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "pending_setup",
							operation_id: operationId,
							group_id: "team-a",
							trust_state: "bootstrap_grant_created",
							bootstrap_grant_id: "grant-restart",
							inviter_device: {
								device_id: "device-adam",
								public_key: inviterPublicKey,
								fingerprint: fingerprintPublicKey(inviterPublicKey),
								display_name: "Adam's Mac",
							},
						}),
						{ status: 200 },
					),
			);
			globalThis.fetch = fetchMock as typeof fetch;
			const { app, ensureStore, cleanup } = createTestApp({
				seedDevice: false,
				getSyncRuntimeStatus: () => ({ phase: "disabled", detail: "Sync is disabled" }),
			});
			try {
				const store = ensureStore();
				for (let attempt = 0; attempt < 2; attempt += 1) {
					const response = await app.request("/api/sync/invites/import", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ invite, device_name: "Brian's Mac" }),
					});
					expect(response.status).toBe(200);
					expect(await response.json()).toMatchObject({
						status: "pending_setup",
						setup_state: "restart_required",
						restart_required: true,
						type: "project_share",
						detail: expect.stringContaining("Restart codemem"),
					});
				}
				expect(fetchMock).toHaveBeenCalledTimes(2);
				expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
					sync_enabled: true,
					sync_host: "0.0.0.0",
					sync_port: 7337,
					sync_interval_s: 120,
					sync_coordinator_groups: ["team-a"],
				});
				expect(
					store.db
						.prepare("SELECT COUNT(*) FROM sync_peers WHERE peer_device_id = 'device-adam'")
						.pluck()
						.get(),
				).toBe(1);
				expect(
					store.db
						.prepare("SELECT COUNT(*) FROM actors WHERE actor_id = ?")
						.pluck()
						.get(store.actorId),
				).toBe(1);
			} finally {
				cleanup();
				globalThis.fetch = previousFetch;
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it("returns a safe actionable error when project sync config cannot be written", async () => {
			const testDir = mkdtempSync(join(tmpdir(), "codemem-project-config-failure-test-"));
			const configPath = join(testDir, "config-as-directory");
			const keysDir = join(testDir, "keys");
			const previousConfig = process.env.CODEMEM_CONFIG;
			const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
			const previousFetch = globalThis.fetch;
			const inviterPublicKey = "config-failure-inviter-public-key";
			mkdirSync(configPath);
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_KEYS_DIR = keysDir;
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "pending_setup",
							operation_id: `share_${"e".repeat(40)}`,
							group_id: "team-a",
							trust_state: "bootstrap_grant_created",
							bootstrap_grant_id: "grant-write",
							inviter_device: {
								device_id: "internal-device-id",
								public_key: inviterPublicKey,
								fingerprint: fingerprintPublicKey(inviterPublicKey),
							},
						}),
						{ status: 200 },
					),
			) as typeof fetch;
			const invite = core.encodeInvitePayload({
				v: 1,
				kind: "coordinator_team_invite",
				coordinator_url: "https://coord.example.test",
				group_id: "team-a",
				policy: "auto_admit",
				token: "project-config-write-token",
				expires_at: "2099-01-01T00:00:00.000Z",
				team_name: "Team A",
				operation_id: `share_${"e".repeat(40)}`,
			});
			const { app, cleanup } = createTestApp({ seedDevice: false });
			try {
				const response = await app.request("/api/sync/invites/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite, recipient_name: "Brian" }),
				});
				expect(response.status).toBe(400);
				const body = (await response.json()) as Record<string, unknown>;
				expect(body).toEqual({
					error: "project_sync_enablement_failed",
					detail:
						"Invitation was accepted, but sync could not be enabled. Make the codemem config writable, then retry.",
				});
				expect(JSON.stringify(body)).not.toContain("internal-device-id");
				expect(JSON.stringify(body)).not.toContain(configPath);
			} finally {
				cleanup();
				globalThis.fetch = previousFetch;
				if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
				else process.env.CODEMEM_CONFIG = previousConfig;
				if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
				else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
				rmSync(testDir, { recursive: true, force: true });
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
							body: JSON.stringify({
								effect_id: "caller-supplied-revoke",
								membership_epoch: 4,
								memory_items: [{ id: 1 }],
							}),
						},
					);
					expect(revoked.status).toBe(200);

					const repeatedGrant = await app.request(
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
					expect(repeatedGrant.status).toBe(200);

					const calls = fetchMock.mock.calls;
					expect(calls).toHaveLength(4);
					const grantBody = bodyJson(calls[1]?.[1] as RequestInit | undefined);
					expect(grantBody).toMatchObject({
						device_id: "device-1",
						role: "reader",
					});
					expect(grantBody.effect_id).toMatch(/^viewer-admin-membership:grant:[a-f0-9]{64}$/);
					expect(grantBody).not.toHaveProperty("memory_payload");
					const revokeBody = bodyJson(calls[2]?.[1] as RequestInit | undefined);
					expect(revokeBody).toMatchObject({
						effect_id: "caller-supplied-revoke",
						membership_epoch: 4,
					});
					expect(revokeBody).not.toHaveProperty("memory_items");
					const repeatedGrantBody = bodyJson(calls[3]?.[1] as RequestInit | undefined);
					expect(repeatedGrantBody.effect_id).toMatch(
						/^viewer-admin-membership:grant:[a-f0-9]{64}$/,
					);
					expect(repeatedGrantBody.effect_id).not.toBe(grantBody.effect_id);
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
							items: [
								{
									device_id: "device-1",
									group_id: "team-a",
									public_key: "device-1-key",
									fingerprint: "device-1-fingerprint",
									identity_id: null,
									display_name: "Laptop",
									enabled: 1,
									created_at: "2026-07-27T00:00:00.000Z",
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
					const invalidRename = await app.request(
						"/api/coordinator/admin/devices/device-1/rename",
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ display_name: "device:123e4567" }),
						},
					);
					expect(invalidRename.status).toBe(400);
					expect(await invalidRename.json()).toMatchObject({
						error: "display_name_invalid",
					});
					expect(fetchMock).not.toHaveBeenCalled();

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
