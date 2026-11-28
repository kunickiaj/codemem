import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	ensureDeviceIdentity,
	fingerprintPublicKey,
	initTestSchema,
	MemoryStore,
	readAccountLinkDevice,
	serializeRecipientPolicyPublicationMutation,
} from "@codemem/core";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { generateDeviceKey } from "../../cloudflare-coordinator-worker/test/device-rejoin-ceremony-fixture.js";
import { readCoordinatorSyncConfig } from "../../core/src/coordinator-sync-config.js";
import { verifySignature } from "../../core/src/sync-auth.js";
import { settleBackgroundRefreshes } from "./application/background-refresh.js";
import { createApp } from "./index.js";

// Binding commits need the admin device; these tests are about other checks.
function createAdminApp(options: Parameters<typeof createApp>[0]) {
	return createApp({
		readCoordinatorConfig: () =>
			readCoordinatorSyncConfig({
				sync_coordinator_url: "https://coord.example.test",
				sync_coordinator_groups: ["group-admin"],
				sync_coordinator_admin_secret: "fixture-admin-secret",
			}),
		...options,
	});
}

function testStore(): { store: MemoryStore; cleanup: () => void } {
	const directory = mkdtempSync(join(tmpdir(), "codemem-device-inventory-test-"));
	const dbPath = join(directory, "test.sqlite");
	const keysDir = join(directory, "keys");
	const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
	process.env.CODEMEM_KEYS_DIR = keysDir;
	const db = new Database(dbPath);
	initTestSchema(db);
	ensureDeviceIdentity(db, { deviceId: "local-device", keysDir });
	db.close();
	const store = new MemoryStore(dbPath);
	const now = "2026-08-18T12:00:00.000Z";
	store.db
		.prepare(
			`INSERT OR IGNORE INTO actors(
			 actor_id, display_name, is_local, status, created_at, updated_at
			 ) VALUES (?, 'Local Identity', 1, 'active', ?, ?)`,
		)
		.run(store.actorId, now, now);
	return {
		store,
		cleanup: () => {
			store.close();
			if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
			else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

it.each([
	"exact key",
	"different key",
	"unverifiable key",
	"pin changed during discovery",
] as const)(
	"only attaches a signed discovery rejoin marker to the mounted inventory for a verified pin (%s)",
	async (scenario) => {
		const { store, cleanup } = testStore();
		const configPath = join(dirname(store.dbPath), "config.json");
		const config = {
			sync_enabled: true,
			sync_coordinator_url: "https://coordinator.example.test",
			sync_coordinator_groups: ["group-a"],
		};
		writeFileSync(configPath, JSON.stringify(config));
		vi.stubEnv("CODEMEM_CONFIG", configPath);
		const pinned = generateDeviceKey();
		const discovered = scenario === "different key" ? generateDeviceKey() : pinned;
		const nextPin = scenario === "pin changed during discovery" ? generateDeviceKey() : pinned;
		const local = readAccountLinkDevice(store.dbPath);
		const peerId = "reused-device-id";
		store.db
			.prepare(`INSERT INTO sync_peers (peer_device_id, name, public_key, pinned_fingerprint, created_at)
		VALUES (?, 'Pinned laptop', ?, ?, 'then')`)
			.run(peerId, pinned.publicKey, pinned.fingerprint);
		vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
			const url = new URL(input);
			expect(url.origin).toBe(config.sync_coordinator_url);
			const headers = new Headers(init?.headers);
			expect(headers.has("x-codemem-coordinator-admin")).toBe(false);
			if (url.pathname === "/v1/peers") {
				expect(
					verifySignature({
						method: "GET",
						pathWithQuery: `${url.pathname}${url.search}`,
						bodyBytes: Buffer.alloc(0),
						deviceId: local.deviceId,
						publicKey: local.publicKey,
						signature: headers.get("x-opencode-signature") ?? "",
						timestamp: headers.get("x-opencode-timestamp") ?? "",
						nonce: headers.get("x-opencode-nonce") ?? "",
					}),
				).toBe(true);
				if (scenario === "pin changed during discovery")
					store.db
						.prepare(
							"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = ?",
						)
						.run(nextPin.publicKey, nextPin.fingerprint, peerId);
				return Response.json({
					items: [
						{
							device_id: peerId,
							public_key: scenario === "unverifiable key" ? undefined : discovered.publicKey,
							fingerprint: discovered.fingerprint,
							rejoined_at_ms: 1_700_000_000_000,
							stale: true,
						},
					],
				});
			}
			if (url.pathname === "/v1/presence") return Response.json({ ok: true });
			return Response.json({ items: [] });
		});
		try {
			const app = createApp({
				storeFactory: () => store,
				readCoordinatorConfig: () => readCoordinatorSyncConfig(config),
			});
			const inventory = await app.request("/api/sync/recipient-policy/v1/device-inventory");
			expect(inventory.status).toBe(200);
			const { items } = await inventory.json<{ items: Array<Record<string, unknown>> }>();
			const row = items.find((item) => item.deviceId === peerId);
			expect(row).toMatchObject({ validatedFingerprint: nextPin.fingerprint });
			if (scenario === "exact key")
				expect(row).toMatchObject({
					rejoin: { deviceId: peerId, rejoinedAtMs: 1_700_000_000_000 },
				});
			else expect(row).not.toHaveProperty("rejoin");
			expect(JSON.stringify(items)).not.toContain(discovered.publicKey);
			// Coordinator status is refreshed in the background; wait for that refresh.
			await app.request("/api/sync/status");
			await settleBackgroundRefreshes();
			const status = await app.request("/api/sync/status");
			expect(status.status).toBe(200);
			const { coordinator } = await status.json<{
				coordinator: { discovered_devices: unknown[] };
			}>();
			expect(coordinator.discovered_devices).toHaveLength(1);
			expect(coordinator.discovered_devices[0]).not.toHaveProperty("rejoined_at_ms");
			expect(coordinator.discovered_devices[0]).not.toHaveProperty("public_key");
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			cleanup();
		}
	},
);

describe("GET /api/sync/recipient-policy/v1/device-inventory", () => {
	it("stabilizes a fresh viewer before returning discovery identifiers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem-fresh-inventory-test-"));
		const dbPath = join(directory, "test.sqlite");
		const keysDir = join(directory, "keys");
		const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
		const db = new Database(dbPath);
		initTestSchema(db);
		db.close();
		const store = new MemoryStore(dbPath);
		try {
			expect(store.deviceId).toBe("local");
			process.env.CODEMEM_KEYS_DIR = keysDir;
			const app = createApp({
				storeFactory: () => store,
				loadDeviceIdentityCoordinatorEvidence: async () => ({
					availability: "available",
					safeErrorCode: null,
					enrollments: [],
				}),
			});

			const response = await app.request("/api/sync/recipient-policy/v1/device-inventory");
			const body = (await response.json()) as { items: Array<Record<string, unknown>> };

			expect(response.status).toBe(200);
			expect(store.deviceId).not.toBe("local");
			expect(store.actorId).toBe(`local:${store.deviceId}`);
			expect(body.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ deviceId: store.deviceId, state: "setup_required" }),
				]),
			);
			expect(
				store.db.prepare("SELECT status FROM actors WHERE actor_id = ?").pluck().get(store.actorId),
			).toBe("active");
		} finally {
			if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
			else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("returns injected coordinator evidence without materializing identity bindings", async () => {
		const fixture = testStore();
		try {
			const before = fixture.store.db.prepare("SELECT * FROM identity_devices").all();
			const app = createApp({
				storeFactory: () => fixture.store,
				loadDeviceIdentityCoordinatorEvidence: async () => ({
					availability: "available",
					safeErrorCode: null,
					enrollments: [
						{
							group_id: "group-a",
							device_id: "legacy-device",
							public_key: "legacy-key",
							fingerprint: fingerprintPublicKey("legacy-key"),
							identity_id: "unreviewed-identity",
							display_name: "Legacy laptop",
							enabled: 1,
							created_at: "2026-08-18T12:00:00.000Z",
						},
					],
				}),
			});
			const response = await app.request("/api/sync/recipient-policy/v1/device-inventory");
			const body = (await response.json()) as Record<string, unknown>;

			expect(response.status).toBe(200);
			expect(body).toMatchObject({
				version: 1,
				coordinatorEvidence: { availability: "available", safeErrorCode: null },
				truncated: false,
			});
			expect(body.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						deviceId: "legacy-device",
						state: "pairing_required",
						identityId: null,
					}),
				]),
			);
			expect(fixture.store.db.prepare("SELECT * FROM identity_devices").all()).toEqual(before);
		} finally {
			fixture.cleanup();
		}
	});

	it("keeps the local inventory available when coordinator evidence fails", async () => {
		const fixture = testStore();
		try {
			const app = createApp({
				storeFactory: () => fixture.store,
				loadDeviceIdentityCoordinatorEvidence: async () => {
					throw new Error("sensitive coordinator failure");
				},
			});

			const response = await app.request("/api/sync/recipient-policy/v1/device-inventory");
			const body = (await response.json()) as {
				coordinatorEvidence: Record<string, unknown>;
				items: Array<Record<string, unknown>>;
			};
			const serialized = JSON.stringify(body);

			expect(response.status).toBe(200);
			expect(body.coordinatorEvidence).toEqual({
				availability: "unavailable",
				safeErrorCode: "coordinator_unavailable",
			});
			expect(serialized).not.toContain("sensitive coordinator failure");
			expect(body.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ deviceId: "local-device", state: "setup_required" }),
				]),
			);
		} finally {
			fixture.cleanup();
		}
	});
});

describe("device Identity binding routes", () => {
	it("stabilizes a fresh viewer identity before preview and commit", async () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem-fresh-binding-test-"));
		const dbPath = join(directory, "test.sqlite");
		const keysDir = join(directory, "keys");
		const db = new Database(dbPath);
		initTestSchema(db);
		db.close();
		const previewStore = new MemoryStore(dbPath);
		const commitStore = new MemoryStore(dbPath);
		const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
		try {
			expect(previewStore.deviceId).toBe("local");
			expect(commitStore.deviceId).toBe("local");
			process.env.CODEMEM_KEYS_DIR = keysDir;
			const [stableDeviceId] = ensureDeviceIdentity(previewStore.db, { keysDir });
			const stableActorId = `local:${stableDeviceId}`;
			const coordinatorEvidence = async () => ({
				availability: "available" as const,
				safeErrorCode: null,
				enrollments: [],
			});
			const bindings = [
				{
					deviceId: stableDeviceId,
					targetIdentityId: stableActorId,
					confirmed: true,
				},
			];
			const previewApp = createApp({
				storeFactory: () => previewStore,
				loadDeviceIdentityCoordinatorEvidence: coordinatorEvidence,
			});
			const previewResponse = await previewApp.request(
				"/api/sync/recipient-policy/v1/device-bindings/preview",
				{ method: "POST", body: JSON.stringify({ bindings }) },
			);
			const preview = (await previewResponse.json()) as { reviewedInventoryDigest: string };

			expect(previewResponse.status).toBe(200);
			expect(previewStore.deviceId).toBe(stableDeviceId);
			expect(previewStore.actorId).toBe(stableActorId);
			const commitApp = createAdminApp({
				storeFactory: () => commitStore,
				loadDeviceIdentityCoordinatorEvidence: coordinatorEvidence,
			});
			const commitResponse = await commitApp.request(
				"/api/sync/recipient-policy/v1/device-bindings/commit",
				{
					method: "POST",
					body: JSON.stringify({
						bindings,
						reviewedInventoryDigest: preview.reviewedInventoryDigest,
					}),
				},
			);

			expect(commitResponse.status).toBe(200);
			expect(commitStore.deviceId).toBe(stableDeviceId);
			expect(commitStore.actorId).toBe(stableActorId);
			expect(
				commitStore.db
					.prepare(
						`SELECT decided_by_identity_id, decided_by_device_id
						 FROM device_identity_binding_commits`,
					)
					.get(),
			).toEqual({
				decided_by_identity_id: stableActorId,
				decided_by_device_id: stableDeviceId,
			});
		} finally {
			if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
			else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
			previewStore.close();
			commitStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("device Identity binding configuration", () => {
	it.each([
		{ sync_coordinator_admin_secret: "test-secret" },
		{ sync_coordinator_url: "https://coord.example.test", sync_coordinator_group: "team-a" },
		{ sync_coordinator_admin_secret: "test-secret", sync_coordinator_group: "team-a" },
		{
			sync_coordinator_url: "https://coord.example.test",
			sync_coordinator_admin_secret: "test-secret",
		},
		{ sync_coordinator_url: " ", sync_coordinator_group: "team-a" },
	])("fails closed with setup guidance for partial coordinator config %j", async (config) => {
		const fixture = testStore();
		const configDirectory = mkdtempSync(join(tmpdir(), "codemem-binding-config-test-"));
		const configPath = join(configDirectory, "config.json");
		const previousConfig = process.env.CODEMEM_CONFIG;
		const previousCoordinatorUrl = process.env.CODEMEM_SYNC_COORDINATOR_URL;
		const previousCoordinatorGroup = process.env.CODEMEM_SYNC_COORDINATOR_GROUP;
		const previousCoordinatorGroups = process.env.CODEMEM_SYNC_COORDINATOR_GROUPS;
		const previousAdminSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
		try {
			process.env.CODEMEM_CONFIG = configPath;
			delete process.env.CODEMEM_SYNC_COORDINATOR_URL;
			delete process.env.CODEMEM_SYNC_COORDINATOR_GROUP;
			delete process.env.CODEMEM_SYNC_COORDINATOR_GROUPS;
			delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			writeFileSync(configPath, JSON.stringify(config));
			const app = createApp({ storeFactory: () => fixture.store });

			const inventoryResponse = await app.request("/api/sync/recipient-policy/v1/device-inventory");
			const inventoryBody = await inventoryResponse.json();
			expect(inventoryBody).toMatchObject({
				coordinatorEvidence: {
					availability: "unavailable",
					safeErrorCode: "coordinator_configuration_required",
				},
			});
			expect(JSON.stringify(inventoryBody)).not.toContain("coord.example.test");
			expect(JSON.stringify(inventoryBody)).not.toContain("test-secret");

			const previewResponse = await app.request(
				"/api/sync/recipient-policy/v1/device-bindings/preview",
				{
					method: "POST",
					body: JSON.stringify({
						bindings: [
							{
								deviceId: fixture.store.deviceId,
								targetIdentityId: fixture.store.actorId,
								confirmed: true,
							},
						],
					}),
				},
			);
			expect(previewResponse.status).toBe(409);
			expect(await previewResponse.json()).toMatchObject({
				status: "conflict",
				errorCode: "device_inventory_incomplete",
			});
		} finally {
			if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
			else process.env.CODEMEM_CONFIG = previousConfig;
			if (previousCoordinatorUrl == null) delete process.env.CODEMEM_SYNC_COORDINATOR_URL;
			else process.env.CODEMEM_SYNC_COORDINATOR_URL = previousCoordinatorUrl;
			if (previousCoordinatorGroup == null) delete process.env.CODEMEM_SYNC_COORDINATOR_GROUP;
			else process.env.CODEMEM_SYNC_COORDINATOR_GROUP = previousCoordinatorGroup;
			if (previousCoordinatorGroups == null) delete process.env.CODEMEM_SYNC_COORDINATOR_GROUPS;
			else process.env.CODEMEM_SYNC_COORDINATOR_GROUPS = previousCoordinatorGroups;
			if (previousAdminSecret == null) {
				delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			} else {
				process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = previousAdminSecret;
			}
			fixture.cleanup();
			rmSync(configDirectory, { recursive: true, force: true });
		}
	});
});

describe("device inventory rejoin marker", () => {
	it("carries a coordinator rejoin marker on the item and changes nothing else", async () => {
		const fixture = testStore();
		try {
			const enrollment = {
				group_id: "group-a",
				device_id: "rejoined-device",
				public_key: "rejoined-key",
				fingerprint: fingerprintPublicKey("rejoined-key"),
				identity_id: null,
				display_name: "Rejoined laptop",
				enabled: 1,
				created_at: "2026-08-18T12:00:00.000Z",
			};
			const read = async (extra: Record<string, unknown>) => {
				const app = createApp({
					storeFactory: () => fixture.store,
					loadDeviceIdentityCoordinatorEvidence: async () => ({
						availability: "available",
						safeErrorCode: null,
						enrollments: [{ ...enrollment, ...extra }],
					}),
				});
				const response = await app.request("/api/sync/recipient-policy/v1/device-inventory");
				const body = (await response.json()) as { items: Array<Record<string, unknown>> };
				return body.items.find((item) => item.deviceId === "rejoined-device");
			};

			const marked = await read({ rejoined_at_ms: 1_700_000_000_000 });
			const plain = await read({});

			expect(marked?.rejoin).toEqual({
				deviceId: "rejoined-device",
				rejoinedAtMs: 1_700_000_000_000,
			});
			expect({ ...marked, rejoin: undefined }).toEqual({ ...plain, rejoin: undefined });
		} finally {
			fixture.cleanup();
		}
	});
});

describe("device Identity binding writes", () => {
	it("returns Retry-After when preview evidence is SQLite-busy", async () => {
		const fixture = testStore();
		let competing: InstanceType<typeof Database> | null = null;
		try {
			const app = createApp({
				storeFactory: () => fixture.store,
				loadDeviceIdentityCoordinatorEvidence: async () => ({
					availability: "available",
					safeErrorCode: null,
					enrollments: [],
				}),
			});
			const database = fixture.store.db.pragma("database_list") as Array<{ file: string }>;
			const databasePath = database.find((entry) => entry.file)?.file;
			if (!databasePath) throw new Error("test database path missing");
			fixture.store.db.pragma("journal_mode = DELETE");
			fixture.store.db.pragma("busy_timeout = 1");
			competing = new Database(databasePath);
			competing.exec("BEGIN EXCLUSIVE");

			const response = await app.request("/api/sync/recipient-policy/v1/device-bindings/preview", {
				method: "POST",
				body: JSON.stringify({
					bindings: [
						{
							deviceId: fixture.store.deviceId,
							targetIdentityId: fixture.store.actorId,
							confirmed: true,
						},
					],
				}),
			});

			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("1");
			expect(await response.json()).toEqual({ error: "binding_preview_busy" });
		} finally {
			if (competing?.inTransaction) competing.exec("ROLLBACK");
			competing?.close();
			fixture.cleanup();
		}
	});

	it("requires local confirmation, commits, and makes an exact retry idempotent", async () => {
		const fixture = testStore();
		try {
			const app = createAdminApp({
				storeFactory: () => fixture.store,
				loadDeviceIdentityCoordinatorEvidence: async () => ({
					availability: "available",
					safeErrorCode: null,
					enrollments: [],
				}),
			});
			fixture.store.db
				.prepare("DELETE FROM identity_devices WHERE device_id = ?")
				.run(fixture.store.deviceId);
			const accessBefore = {
				projects: fixture.store.db.prepare("SELECT * FROM project_recipients").all(),
				teams: fixture.store.db.prepare("SELECT * FROM policy_team_memberships").all(),
				scopes: fixture.store.db.prepare("SELECT * FROM scope_memberships").all(),
			};
			const bindings = [
				{
					deviceId: fixture.store.deviceId,
					targetIdentityId: fixture.store.actorId,
					confirmed: false,
				},
			];
			const unconfirmed = await app.request(
				"/api/sync/recipient-policy/v1/device-bindings/preview",
				{ method: "POST", body: JSON.stringify({ bindings }) },
			);
			expect(unconfirmed.status).toBe(400);

			bindings[0] = { ...bindings[0], confirmed: true };
			const previewResponse = await app.request(
				"/api/sync/recipient-policy/v1/device-bindings/preview",
				{ method: "POST", body: JSON.stringify({ bindings }) },
			);
			const preview = (await previewResponse.json()) as { reviewedInventoryDigest: string };
			const commitBody = {
				bindings,
				reviewedInventoryDigest: preview.reviewedInventoryDigest,
			};
			let releasePublication: () => void = () => undefined;
			const publicationGate = new Promise<void>((resolve) => {
				releasePublication = resolve;
			});
			let markPublicationStarted: () => void = () => undefined;
			const publicationStarted = new Promise<void>((resolve) => {
				markPublicationStarted = resolve;
			});
			const heldPublication = serializeRecipientPolicyPublicationMutation(
				fixture.store.db,
				async () => {
					markPublicationStarted();
					await publicationGate;
				},
			);
			await publicationStarted;
			let commitSettled = false;
			const commitRequest = app
				.request("/api/sync/recipient-policy/v1/device-bindings/commit", {
					method: "POST",
					body: JSON.stringify(commitBody),
				})
				.then((response) => {
					commitSettled = true;
					return response;
				});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(commitSettled).toBe(false);
			releasePublication();
			const commitResponse = await commitRequest;
			await heldPublication;
			const retryResponse = await app.request(
				"/api/sync/recipient-policy/v1/device-bindings/commit",
				{ method: "POST", body: JSON.stringify(commitBody) },
			);

			expect(commitResponse.status).toBe(200);
			expect(await commitResponse.json()).toMatchObject({
				status: "applied",
				writeCount: 1,
				idempotent: false,
			});
			expect(await retryResponse.json()).toMatchObject({
				status: "applied",
				writeCount: 0,
				idempotent: true,
			});
			expect(fixture.store.db.prepare("SELECT * FROM project_recipients").all()).toEqual(
				accessBefore.projects,
			);
			expect(fixture.store.db.prepare("SELECT * FROM policy_team_memberships").all()).toEqual(
				accessBefore.teams,
			);
			expect(fixture.store.db.prepare("SELECT * FROM scope_memberships").all()).toEqual(
				accessBefore.scopes,
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("rejects pairing-required and safely redacts coordinator failures", async () => {
		const fixture = testStore();
		try {
			const available = createApp({
				storeFactory: () => fixture.store,
				loadDeviceIdentityCoordinatorEvidence: async () => ({
					availability: "available",
					safeErrorCode: null,
					enrollments: [
						{
							group_id: "group-a",
							device_id: "coordinator-only",
							public_key: "coordinator-key",
							fingerprint: fingerprintPublicKey("coordinator-key"),
							identity_id: fixture.store.actorId,
							display_name: "Coordinator only",
							enabled: 1,
							created_at: "2026-08-18T12:00:00.000Z",
						},
					],
				}),
			});
			const pairing = await available.request(
				"/api/sync/recipient-policy/v1/device-bindings/preview",
				{
					method: "POST",
					body: JSON.stringify({
						bindings: [
							{
								deviceId: "coordinator-only",
								targetIdentityId: fixture.store.actorId,
								confirmed: true,
							},
						],
					}),
				},
			);
			expect(pairing.status).toBe(409);
			expect(await pairing.json()).toMatchObject({ errorCode: "device_pairing_required" });

			const unavailable = createApp({
				storeFactory: () => fixture.store,
				loadDeviceIdentityCoordinatorEvidence: async () => {
					throw new Error("secret coordinator response");
				},
			});
			const failed = await unavailable.request(
				"/api/sync/recipient-policy/v1/device-bindings/preview",
				{
					method: "POST",
					body: JSON.stringify({
						bindings: [
							{
								deviceId: fixture.store.deviceId,
								targetIdentityId: fixture.store.actorId,
								confirmed: true,
							},
						],
					}),
				},
			);
			const serialized = JSON.stringify(await failed.json());
			expect(failed.status).toBe(409);
			expect(serialized).toContain("device_inventory_incomplete");
			expect(serialized).not.toContain("secret coordinator response");
		} finally {
			fixture.cleanup();
		}
	});

	it("re-reads evidence and rejects a stale commit", async () => {
		const fixture = testStore();
		try {
			const app = createAdminApp({
				storeFactory: () => fixture.store,
				loadDeviceIdentityCoordinatorEvidence: async () => ({
					availability: "available",
					safeErrorCode: null,
					enrollments: [],
				}),
			});
			const bindings = [
				{
					deviceId: fixture.store.deviceId,
					targetIdentityId: fixture.store.actorId,
					confirmed: true,
				},
			];
			const previewResponse = await app.request(
				"/api/sync/recipient-policy/v1/device-bindings/preview",
				{ method: "POST", body: JSON.stringify({ bindings }) },
			);
			const preview = (await previewResponse.json()) as { reviewedInventoryDigest: string };
			const bindingsBefore = fixture.store.db.prepare("SELECT * FROM identity_devices").all();
			fixture.store.db
				.prepare(
					`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
					 VALUES (?, 'Changed local evidence', ?, '2026-08-18T12:00:00.000Z')`,
				)
				.run(fixture.store.deviceId, fixture.store.actorId);
			const response = await app.request("/api/sync/recipient-policy/v1/device-bindings/commit", {
				method: "POST",
				body: JSON.stringify({
					bindings,
					reviewedInventoryDigest: preview.reviewedInventoryDigest,
				}),
			});

			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ status: "stale" });
			expect(fixture.store.db.prepare("SELECT * FROM identity_devices").all()).toEqual(
				bindingsBefore,
			);
		} finally {
			fixture.cleanup();
		}
	});
});
