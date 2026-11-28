import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { coordinatorImportInviteAction } from "../../../core/src/coordinator-actions.js";
import { createCoordinatorApp } from "../../../core/src/coordinator-api.js";
import { setupStore } from "../../../core/src/coordinator-auth-store-test-fixtures.js";
import {
	LIFT_NOW,
	liftTables,
} from "../../../core/src/coordinator-invitation-lift-test-harness.js";
import { encodeInvitePayload } from "../../../core/src/coordinator-invites.js";
import { queryPeerRemoval } from "../../../core/src/coordinator-peer-revocation.js";
import { projectInvite } from "../../../core/src/coordinator-project-revocation-test-harness.js";
import { readCoordinatorRemovalState } from "../../../core/src/coordinator-removal-notice.js";
import {
	lookupCoordinatorPeers,
	refreshAuthorizedCoordinatorPeerTrust,
	registerCoordinatorPresence,
	removeCoordinatorRevokedPeers,
} from "../../../core/src/coordinator-runtime.js";
import { readCoordinatorSyncConfig } from "../../../core/src/coordinator-sync-config.js";
import { connect } from "../../../core/src/db.js";
import { verifiedLocalKeyId } from "../../../core/src/device-retirement.js";
import { initDatabase } from "../../../core/src/maintenance/init-vacuum.js";
import { ensureMemoryRetirementDeliverySchema } from "../../../core/src/memory-retirement-delivery-schema.js";
import { ensurePeerRemovalCheckState } from "../../../core/src/peer-removal-check-state.js";
import {
	canonicalKeyId,
	listRetiredDeviceAliases,
} from "../../../core/src/retired-device-aliases.js";
import { refreshConfiguredScopeMembershipCache } from "../../../core/src/scope-membership-cache.js";
import { MemoryStore } from "../../../core/src/store.js";
import { buildDirectPeerAuthHeaders, verifySignature } from "../../../core/src/sync-auth.js";
import { ensureDeviceIdentity, loadPublicKey } from "../../../core/src/sync-identity.js";
import { runSyncPass } from "../../../core/src/sync-orchestration.js";
import { confirmAndBlockRemovedDevice } from "../../../ui/src/tabs/device-block-confirmation";
import { confirmAndCommitDeviceRemoval } from "../../../ui/src/tabs/device-removal-confirmation";
import { createApp } from "../index.js";
import { createSyncApp } from "../sync-app.js";
import { deviceRemovalCommitRoutes } from "./device-removal-commit.js";
import { deviceRemovalReviewRoutes } from "./device-removal-review.js";

vi.mock("../../../ui/src/tabs/sync/sync-dialogs", () => ({
	openSyncConfirmDialog: () => {
		throw new Error("Synthetic confirmation must be explicit");
	},
}));

const coordinatorOrigin = "https://coordinator.example.test";
const viewerOrigin = "http://localhost:7337";
const adminSecret = "synthetic-project-client-admin";
const groupId = "project-client-group";
const cleanups: (() => void)[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function localIdentity(directory: string, name: string) {
	const dbPath = join(directory, `${name}.sqlite`);
	const keysDir = join(directory, `${name}-keys`);
	initDatabase(dbPath);
	const db = connect(dbPath);
	cleanups.push(() => db.close());
	const [deviceId, fingerprint] = ensureDeviceIdentity(db, { keysDir });
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("Fixture public key missing");
	return { dbPath, keysDir, db, deviceId, fingerprint, publicKey };
}

async function fixture(options: { mounted?: boolean } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "codemem-project-client-lifecycle-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.spyOn(Date, "now").mockReturnValue(Date.parse(LIFT_NOW));
	const configPath = join(directory, "client-config.json");
	writeFileSync(configPath, "{}\n");
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	const client = localIdentity(directory, "client");
	const viewerLocal = localIdentity(directory, "viewer");
	const survivor = localIdentity(directory, "survivor");
	ensureMemoryRetirementDeliverySchema(viewerLocal.db);
	ensurePeerRemovalCheckState(viewerLocal.db);
	viewerLocal.db
		.prepare(`INSERT INTO sync_peers
			(peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)`)
		.run(client.deviceId, client.publicKey, client.fingerprint, LIFT_NOW);
	viewerLocal.db
		.prepare(`INSERT INTO replication_cursors
			(peer_device_id, last_applied_cursor, updated_at) VALUES (?, 'fixture-cursor', ?)`)
		.run(client.deviceId, LIFT_NOW);
	const { store, db } = setupStore("SQLite", { authClock: () => Date.parse(LIFT_NOW) });
	cleanups.push(() => db.close());
	vi.spyOn(store, "close").mockResolvedValue();
	await store.createGroup(groupId);
	await store.enrollDevice(groupId, client);
	if (options.mounted) {
		vi.stubEnv("CODEMEM_KEYS_DIR", viewerLocal.keysDir);
		await store.enrollDevice(groupId, viewerLocal);
		await store.enrollDevice(groupId, survivor);
	}
	const verifier = vi.fn((input: Parameters<typeof verifySignature>[0]) => verifySignature(input));
	const coordinator = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => adminSecret, now: () => LIFT_NOW },
		requestVerifier: (input) => verifier({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		deviceRevocation: { coordinatorId: "synthetic-project-client-coordinator" },
	});
	const config = {
		...readCoordinatorSyncConfig({}),
		syncCoordinatorUrl: coordinatorOrigin,
		syncCoordinatorAdminSecret: adminSecret,
		syncCoordinatorGroups: options.mounted ? [groupId] : [],
	};
	const readCoordinatorConfig = () => config;
	const refresh = vi.fn(async () => {});
	const viewer = mountViewer({
		viewerLocal,
		readCoordinatorConfig,
		refresh,
		mounted: options.mounted,
	});
	const { joins, browserPaths } = installTransport(coordinator, viewer);
	const post = (path: string, body: unknown) =>
		coordinator.request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Codemem-Coordinator-Admin": adminSecret },
			body: JSON.stringify(body),
		});
	const snapshot = () =>
		liftTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
	const issue = (operationId: string) => issueProject({ store, db, client }, operationId);
	const importInvite = (inviteValue: string) =>
		coordinatorImportInviteAction({
			inviteValue,
			dbPath: client.dbPath,
			keysDir: client.keysDir,
			configPath,
			recipientActorId: "recipient-identity",
			recipientDisplayName: "Recipient",
			deviceDisplayName: "Travel laptop",
		});
	const target = { deviceId: client.deviceId, displayName: "Travel laptop" };
	const remove = (approved = true) =>
		confirmAndCommitDeviceRemoval(target, { confirm: async () => approved });
	return {
		client,
		viewerLocal,
		survivor,
		viewer,
		config,
		db,
		store,
		post,
		issue,
		importInvite,
		remove,
		snapshot,
		joins,
		verifier,
		browserPaths,
		refresh,
		configPath,
		target,
		coordinator,
		directory,
	};
}

function mountViewer({
	viewerLocal,
	readCoordinatorConfig,
	refresh,
	mounted,
}: {
	viewerLocal: ReturnType<typeof localIdentity>;
	readCoordinatorConfig: () => ReturnType<typeof readCoordinatorSyncConfig>;
	refresh: () => Promise<void>;
	mounted?: boolean;
}) {
	if (mounted) {
		const viewerStore = new MemoryStore(viewerLocal.dbPath);
		cleanups.push(() => viewerStore.close());
		return createApp({
			storeFactory: () => viewerStore,
			readCoordinatorConfig,
			createDeviceRemovalRefreshHooks: () => ({
				waitForRefresh: async () => {},
				refresh,
			}),
		});
	}
	return new Hono()
		.route(
			"/",
			deviceRemovalReviewRoutes({
				readCoordinatorConfig,
				localIdentity: () => ({
					deviceId: viewerLocal.deviceId,
					keyId: verifiedLocalKeyId(viewerLocal.db, viewerLocal.deviceId),
				}),
			}),
		)
		.route(
			"/",
			deviceRemovalCommitRoutes({
				readCoordinatorConfig,
				getStore: () => viewerLocal,
				createDeviceRemovalRefreshHooks: () => ({
					waitForRefresh: async () => {},
					refresh,
				}),
			}),
		);
}

async function issueProject(
	f: {
		store: ReturnType<typeof setupStore>["store"];
		db: ReturnType<typeof connect>;
		client: ReturnType<typeof localIdentity>;
	},
	operationId: string,
) {
	const { invite } = await projectInvite(
		{
			store: f.store,
			input: { ...f.client, groupId, actorId: "synthetic-operator" },
			exec: async (sql, ...values) => {
				f.db.prepare(sql).run(...values);
			},
			rows: async (table) => {
				if (!liftTables.includes(table)) throw new Error("Unknown fixture table");
				return f.db.prepare(`SELECT * FROM ${table}`).all();
			},
		},
		operationId,
	);
	return {
		invite,
		value: encodeInvitePayload({
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: coordinatorOrigin,
			group_id: groupId,
			policy: "auto_admit",
			token: invite.token,
			expires_at: invite.expires_at,
			operation_id: operationId,
		}),
	};
}

function installTransport(coordinator: ReturnType<typeof createCoordinatorApp>, viewer: Hono) {
	const joins: { status: number; body: unknown; signature: string | null }[] = [];
	const browserPaths: string[] = [];
	// No fallback to native fetch: every HTTP request stays inside these two Hono apps.
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input), viewerOrigin);
			const request = new Request(url, init);
			if (url.origin === viewerOrigin) {
				expect(url.pathname).toMatch(/^\/api\/sync\/devices\/[^/]+\/remove(?:\/preview)?$/u);
				browserPaths.push(url.pathname);
				return viewer.request(request);
			}
			expect(url.origin).toBe(coordinatorOrigin);
			expect(url.pathname).toMatch(
				/^\/v1\/(?:join|peers(?:\/revocations)?|admin\/(?:groups|devices)(?:\/removal-preview|\/removal|\/removals|\/revoke-preview|\/revoke)?)$/u,
			);
			const response = await coordinator.request(request);
			if (url.pathname === "/v1/join") {
				joins.push({
					status: response.status,
					body: await response.clone().json(),
					signature: request.headers.get("X-Opencode-Signature"),
				});
			}
			return response;
		}),
	);
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	return { joins, browserPaths };
}

it("imports a fresh Project through the real signed client after Viewer Remove, then refuses it after permanent Block", async () => {
	// Arrange: the client retains its actual identity, key files, and local database across removal.
	const f = await fixture();
	const stale = await f.issue(`share_${"a".repeat(40)}`);

	// Act: use the actual Viewer confirmation and review/commit routes.
	const removed = await f.remove();
	const beforeStale = f.snapshot();
	const staleImport = f.importInvite(stale.value);

	// Assert: a pre-removal invitation cannot restore admission or consume retained authority.
	expect(removed).toMatchObject({ state: "removed", local_cleanup: "applied" });
	await expect(staleImport).rejects.toThrow("Invite import failed (403).");
	expect(f.joins.at(-1)).toMatchObject({ status: 403, body: { error: "device_removed" } });
	expect(f.snapshot()).toEqual(beforeStale);
	expect(f.viewerLocal.db.prepare("SELECT * FROM sync_peers").all()).toEqual([]);
	expect(f.viewerLocal.db.prepare("SELECT * FROM replication_cursors").all()).toEqual([]);

	// Arrange: issue fresh authority after the removal high-water mark.
	const fresh = await f.issue(`share_${"b".repeat(40)}`);
	// Act
	const imported = await f.importInvite(fresh.value);
	// Assert: real signature verification, coordinator enrollment, and client persistence all succeeded.
	expect(imported).toMatchObject({ setup_state: "pending_inviter", sync_enabled: true });
	expect(f.joins.at(-1)).toMatchObject({ status: 200, body: { ok: true, group_id: groupId } });
	expect(await f.store.getEnrollment(groupId, f.client.deviceId)).not.toBeNull();
	expect(f.db.prepare("SELECT lifted_by_invite_id FROM coordinator_device_removals").all()).toEqual(
		[{ lifted_by_invite_id: fresh.invite.invite_id }],
	);
	expect(f.client.db.prepare("SELECT public_key FROM sync_device").pluck().get()).toBe(
		f.client.publicKey,
	);
	expect(
		f.client.db.prepare("SELECT pending_bootstrap_grant_id FROM sync_peers").pluck().get(),
	).toEqual(expect.any(String));
	expect(JSON.parse(readFileSync(f.configPath, "utf8"))).toMatchObject({
		sync_enabled: true,
		sync_coordinator_url: coordinatorOrigin,
	});

	// Arrange: remove again, issue a fresh invitation, then review permanent Block separately.
	expect(await f.remove()).toMatchObject({ state: "removed" });
	const blockedInvite = await f.issue(`share_${"c".repeat(40)}`);
	const blocked = await confirmAndBlockRemovedDevice(
		{ ...f.target, groupId },
		{
			preview: async () => {
				const response = await f.post("/v1/admin/devices/revoke-preview", {
					group_id: groupId,
					device_id: f.client.deviceId,
				});
				expect(response.status).toBe(200);
				return response.json();
			},
			confirm: async () => true,
			commit: async (preview) => {
				const response = await f.post("/v1/admin/devices/revoke", {
					group_id: groupId,
					device_id: f.client.deviceId,
					expected_digest: preview.expected_digest,
				});
				expect(response.status).toBe(200);
				return response.json();
			},
		},
	);
	const beforeBlocked = f.snapshot();
	const configBeforeBlocked = readFileSync(f.configPath, "utf8");
	// Act
	const blockedImport = f.importInvite(blockedInvite.value);
	// Assert: even a fresh, correctly signed client import cannot undo permanent Block.
	expect(blocked).toMatchObject({ state: "revoked" });
	await expect(blockedImport).rejects.toThrow("Invite import failed (403).");
	expect(f.joins.at(-1)).toMatchObject({ status: 403, body: { error: "device_revoked" } });
	expect(f.snapshot()).toEqual(beforeBlocked);
	expect(readFileSync(f.configPath, "utf8")).toBe(configBeforeBlocked);
	expect(await f.store.getEnrollment(groupId, f.client.deviceId, true)).toBeNull();
	expect(f.joins).toHaveLength(3);
	for (const join of f.joins) expect(join.signature).toMatch(/^v2:/u);
	expect(f.verifier).toHaveBeenCalledTimes(3);
	for (const result of f.verifier.mock.results) expect(await result.value).toBe(true);
	expect(f.refresh).toHaveBeenCalledTimes(2);
	expect(f.browserPaths).toEqual([
		`/api/sync/devices/${f.client.deviceId}/remove/preview`,
		`/api/sync/devices/${f.client.deviceId}/remove`,
		`/api/sync/devices/${f.client.deviceId}/remove/preview`,
		`/api/sync/devices/${f.client.deviceId}/remove`,
	]);
});

it("canceling the actual Viewer removal confirmation preserves enrollment and the local pairing", async () => {
	// Arrange
	const f = await fixture();
	const before = f.snapshot();
	const paired = f.viewerLocal.db.prepare("SELECT * FROM sync_peers").all();
	// Act
	const result = await f.remove(false);
	// Assert
	expect(result).toBeNull();
	expect(f.snapshot()).toEqual(before);
	expect(f.viewerLocal.db.prepare("SELECT * FROM sync_peers").all()).toEqual(paired);
	expect(f.browserPaths).toEqual([`/api/sync/devices/${f.client.deviceId}/remove/preview`]);
	expect(f.refresh).not.toHaveBeenCalled();
	expect(f.joins).toEqual([]);
});

function pairForPropagation(
	local: ReturnType<typeof localIdentity>,
	peer: ReturnType<typeof localIdentity>,
) {
	ensureMemoryRetirementDeliverySchema(local.db);
	ensurePeerRemovalCheckState(local.db);
	local.db
		.prepare(`INSERT INTO sync_peers
			(peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)`)
		.run(peer.deviceId, peer.publicKey, peer.fingerprint, LIFT_NOW);
	local.db
		.prepare(`INSERT INTO replication_cursors
			(peer_device_id, last_applied_cursor, updated_at) VALUES (?, 'retained-progress', ?)`)
		.run(peer.deviceId, LIFT_NOW);
}

async function blockMountedRemoval(f: Awaited<ReturnType<typeof fixture>>) {
	const listing = await f.viewer.request("/api/sync/devices/removals");
	expect(listing.status).toBe(200);
	const { items } = await listing.json<{ items: { removal_id: string; device_id: string }[] }>();
	const removal = items.find((item) => item.device_id === f.client.deviceId);
	expect(removal).toBeDefined();
	const body = { group_id: groupId, removal_id: removal?.removal_id };
	const path = `/api/sync/devices/${f.client.deviceId}/block`;
	const post = (route: string, value: unknown) =>
		f.viewer.request(route, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(value),
		});
	const review = await post(`${path}/preview`, body);
	expect(review.status).toBe(200);
	const { expected_digest } = await review.json<{ expected_digest: string }>();
	const committed = await post(path, { ...body, expected_digest });
	expect(committed.status).toBe(200);
	expect(await committed.json()).toMatchObject({ state: "revoked" });
}

function signedPeerRead(
	local: ReturnType<typeof localIdentity>,
	peer: ReturnType<typeof localIdentity>,
) {
	const store = new MemoryStore(local.dbPath);
	cleanups.push(() => store.close());
	const app = createSyncApp({ storeFactory: () => store });
	return async (path: string) => {
		const url = `http://localhost${path}`;
		const headers = buildDirectPeerAuthHeaders({
			deviceId: peer.deviceId,
			recipientId: local.deviceId,
			method: "GET",
			url,
			bodyBytes: Buffer.alloc(0),
			keysDir: peer.keysDir,
		});
		const previous = process.env.CODEMEM_KEYS_DIR;
		vi.stubEnv("CODEMEM_KEYS_DIR", local.keysDir);
		try {
			return await app.request(url, { headers });
		} finally {
			vi.stubEnv("CODEMEM_KEYS_DIR", previous);
		}
	};
}

it("propagates mounted A Remove to C, restores B signed discovery by fresh Project import, and reports permanent Block to A/C", async () => {
	const f = await fixture({ mounted: true });
	// A is the Viewer, B the invitation client, and C the independently signed survivor.
	pairForPropagation(f.survivor, f.client);
	pairForPropagation(f.survivor, f.viewerLocal);
	const readCAsB = signedPeerRead(f.survivor, f.client);
	expect((await readCAsB("/v1/status")).status).toBe(200);
	const lookup = (local: ReturnType<typeof localIdentity>) =>
		lookupCoordinatorPeers(local, f.config, { keysDir: local.keysDir });
	const check = (local: ReturnType<typeof localIdentity>) =>
		queryPeerRemoval(local, f.config, {
			localDeviceId: local.deviceId,
			keysDir: local.keysDir,
			deviceId: f.client.deviceId,
			publicKey: f.client.publicKey,
		});
	expect(await lookup(f.client)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ device_id: f.viewerLocal.deviceId }),
			expect.objectContaining({ device_id: f.survivor.deviceId }),
		]),
	);
	const stale = await f.issue(`share_${"d".repeat(40)}`);
	expect(await f.remove()).toMatchObject({ state: "removed", local_cleanup: "applied" });
	await expect(lookup(f.client)).rejects.toThrow("403: device_removed");
	expect(await check(f.survivor)).toMatchObject({ answered: true, removed: true, revoked: false });
	expect(
		await removeCoordinatorRevokedPeers(f.survivor, f.config, { keysDir: f.survivor.keysDir }),
	).toMatchObject({ status: "checked", removed: 1, revoked: 0 });
	expect(f.survivor.db.prepare("SELECT peer_device_id FROM sync_peers").pluck().all()).toEqual([
		f.viewerLocal.deviceId,
	]);
	expect(
		f.survivor.db.prepare("SELECT peer_device_id FROM replication_cursors").pluck().all(),
	).toEqual([f.viewerLocal.deviceId]);
	const denied = await readCAsB("/v1/ops");
	expect(denied.status).toBe(401);
	const beforeStale = f.snapshot();
	await expect(f.importInvite(stale.value)).rejects.toThrow("Invite import failed (403).");
	expect(f.snapshot()).toEqual(beforeStale);

	const fresh = await f.issue(`share_${"e".repeat(40)}`);
	expect(await f.importInvite(fresh.value)).toMatchObject({ setup_state: "pending_inviter" });
	expect(await lookup(f.client)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ device_id: f.viewerLocal.deviceId }),
			expect.objectContaining({ device_id: f.survivor.deviceId }),
		]),
	);
	for (const local of [f.viewerLocal, f.survivor]) {
		expect(await check(local)).toMatchObject({
			answered: true,
			enrolled: true,
			removed: false,
			revoked: false,
		});
	}
	// Admission is restored, but pending_inviter is not a completed Project bootstrap or replication.
	expect(await f.remove()).toMatchObject({ state: "removed" });
	await blockMountedRemoval(f);
	const blockedInvite = await f.issue(`share_${"f".repeat(40)}`);
	const beforeBlocked = f.snapshot();
	const configBeforeBlocked = readFileSync(f.configPath, "utf8");
	await expect(f.importInvite(blockedInvite.value)).rejects.toThrow("Invite import failed (403).");
	expect(f.joins.at(-1)).toMatchObject({ status: 403, body: { error: "device_revoked" } });
	expect(f.snapshot()).toEqual(beforeBlocked);
	expect(readFileSync(f.configPath, "utf8")).toBe(configBeforeBlocked);
	await expect(lookup(f.client)).rejects.toThrow("403: device_revoked");
	for (const local of [f.viewerLocal, f.survivor]) {
		// Query both survivors even though Remove already deleted B's local pairing.
		expect(await check(local)).toMatchObject({ answered: true, revoked: true, enrolled: false });
		expect(await lookup(local)).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ device_id: f.client.deviceId })]),
		);
	}
	expect(f.joins).toHaveLength(3);
	for (const request of f.joins) expect(request.signature).toMatch(/^v2:/u);
	for (const result of f.verifier.mock.results) expect(await result.value).toBe(true);
});

const projectIdentity = "https://git.example.invalid/example/lifecycle-project.git";

async function inDeviceEnvironment<T>(
	local: ReturnType<typeof localIdentity>,
	configPath: string,
	run: () => Promise<T>,
): Promise<T> {
	const previousKeys = process.env.CODEMEM_KEYS_DIR;
	const previousConfig = process.env.CODEMEM_CONFIG;
	vi.stubEnv("CODEMEM_KEYS_DIR", local.keysDir);
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	try {
		return await run();
	} finally {
		vi.stubEnv("CODEMEM_KEYS_DIR", previousKeys);
		vi.stubEnv("CODEMEM_CONFIG", previousConfig);
	}
}

function propagationDevice(
	f: Awaited<ReturnType<typeof fixture>>,
	local: ReturnType<typeof localIdentity>,
	name: string,
) {
	const configPath = join(f.directory, `${name}-config.json`);
	const origin = `http://${name}.example.test:7337`;
	writeFileSync(
		configPath,
		JSON.stringify({
			sync_enabled: true,
			sync_coordinator_url: coordinatorOrigin,
			sync_coordinator_group: groupId,
			sync_coordinator_admin_secret: adminSecret,
			sync_advertise: origin,
			actor_display_name: name,
		}),
	);
	const store = new MemoryStore(local.dbPath);
	cleanups.push(() => store.close());
	ensureMemoryRetirementDeliverySchema(store.db);
	ensurePeerRemovalCheckState(store.db);
	const app = createSyncApp({ storeFactory: () => store });
	const config = readCoordinatorSyncConfig(JSON.parse(readFileSync(configPath, "utf8")));
	const run = <T>(action: () => Promise<T>) => inDeviceEnvironment(local, configPath, action);
	return { local, store, app, origin, config, configPath, run };
}

async function projectPropagationFixture() {
	const f = await fixture({ mounted: true });
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	const a = propagationDevice(f, f.viewerLocal, "owner");
	const b = propagationDevice(f, f.client, "recipient");
	const c = propagationDevice(f, f.survivor, "survivor");
	const devices = [a, b, c];
	const joins: { status: number; body: unknown; signature: string | null }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input), viewerOrigin);
			const request = new Request(url, init);
			if (url.origin === coordinatorOrigin) {
				const response = await f.coordinator.request(request);
				if (url.pathname === "/v1/join") {
					joins.push({
						status: response.status,
						body: await response.clone().json(),
						signature: request.headers.get("X-Opencode-Signature"),
					});
				}
				return response;
			}
			if (url.origin === viewerOrigin) return a.run(() => f.viewer.request(request));
			const device = devices.find((candidate) => candidate.origin === url.origin);
			if (!device) throw new Error(`Unexpected synthetic transport origin: ${url.origin}`);
			return device.run(() => device.app.request(request));
		}),
	);
	for (const device of devices) {
		await device.run(() => registerCoordinatorPresence(device.store, device.config));
	}
	const session = a.store.startSession({ cwd: f.directory, project: "Lifecycle Project" });
	a.store.db
		.prepare("UPDATE sessions SET git_remote = ? WHERE id = ?")
		.run(projectIdentity, session);
	a.store.remember(
		session,
		"discovery",
		"Before removal operation",
		"Synthetic project body",
		0.5,
		[],
		{
			visibility: "shared",
		},
	);
	const post = (path: string, body: unknown) =>
		a.run(() =>
			f.viewer.request(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	const issue = async (teammateName = "Lifecycle recipient") => {
		const body = { teammate_name: teammateName, project_ids: [projectIdentity] };
		const preview = await post("/api/sync/project-invites/preview", body);
		expect(preview.status, await preview.clone().text()).toBe(200);
		const review = await preview.json<{ reviewed_project_set_digest: string }>();
		const created = await post("/api/sync/project-invites", {
			...body,
			reviewed_project_set_digest: review.reviewed_project_set_digest,
		});
		expect(created.status, await created.clone().text()).toBe(200);
		return created.json<{ operation_id: string; invite: { encoded: string } }>();
	};
	const accept = (invite: string, recipient = b) =>
		recipient.run(() =>
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: recipient.local.dbPath,
				keysDir: recipient.local.keysDir,
				configPath: recipient.configPath,
				recipientActorId: recipient.store.actorId,
				recipientDisplayName: recipient === b ? "Lifecycle recipient" : "Survivor",
				deviceDisplayName: "Recipient laptop",
			}),
		);
	const remember = (title = "Eligible lifecycle operation") =>
		a.store.remember(session, "discovery", title, "Synthetic post-removal project body", 0.5, [], {
			visibility: "shared",
		});
	return { f, a, b, c, post, issue, accept, remember, joins };
}

async function advanceProject(
	p: Awaited<ReturnType<typeof projectPropagationFixture>>,
	operationId: string,
	recipient: ReturnType<typeof propagationDevice>,
) {
	const reconciled = await p.post(`/api/sync/project-invites/${operationId}/reconcile`, {});
	expect(reconciled.status, await reconciled.clone().text()).toBe(200);
	for (const device of [recipient, p.a]) {
		await device.run(() => registerCoordinatorPresence(device.store, device.config));
		await device.run(() => refreshAuthorizedCoordinatorPeerTrust(device.store, device.config));
	}
	const advanced = await p.post(`/api/sync/share-operations/${operationId}/advance`, {});
	expect(advanced.status, await advanced.clone().text()).toBe(200);
}

async function propagatePermanentBlock(p: Awaited<ReturnType<typeof projectPropagationFixture>>) {
	const { f, a, b, c } = p;
	for (const device of [a, c]) {
		expect(
			device.store.db
				.prepare("SELECT public_key FROM sync_peers WHERE peer_device_id = ?")
				.pluck()
				.get(b.local.deviceId),
		).toBe(b.local.publicKey);
		expect(listRetiredDeviceAliases(device.store.db).has(b.local.deviceId)).toBe(false);
	}
	// The mounted coordinator records Block while both survivors still have a pairing to remove.
	const review = await f.post("/v1/admin/devices/revoke-preview", {
		group_id: groupId,
		device_id: b.local.deviceId,
	});
	expect(review.status).toBe(200);
	const { expected_digest } = await review.json<{ expected_digest: string }>();
	const blocked = await f.post("/v1/admin/devices/revoke", {
		group_id: groupId,
		device_id: b.local.deviceId,
		expected_digest,
	});
	expect(blocked.status).toBe(200);
	for (const device of [a, c]) {
		expect(
			await device.run(() => removeCoordinatorRevokedPeers(device.store, device.config)),
		).toMatchObject({ status: "checked", revoked: 1 });
		expect(
			device.store.db
				.prepare("SELECT 1 FROM sync_peers WHERE peer_device_id = ?")
				.get(b.local.deviceId),
		).toBeUndefined();
		expect(listRetiredDeviceAliases(device.store.db).get(b.local.deviceId)).toMatchObject({
			kind: "key",
			keyId: canonicalKeyId(b.local.publicKey),
		});
		const reopened = connect(device.local.dbPath);
		try {
			expect(listRetiredDeviceAliases(reopened).get(b.local.deviceId)).toMatchObject({
				kind: "key",
				keyId: canonicalKeyId(b.local.publicKey),
			});
		} finally {
			reopened.close();
		}
		expect((await signedPeerRead(device.local, b.local)("/v1/ops")).status).toBe(401);
	}
}

function assertAppliedProjectOperation(p: Awaited<ReturnType<typeof projectPropagationFixture>>) {
	const title = "Eligible lifecycle operation";
	const source = p.a.store.db
		.prepare(
			"SELECT title, body_text, scope_id, origin_device_id FROM memory_items WHERE title = ?",
		)
		.get(title);
	expect(source).toMatchObject({
		title,
		body_text: "Synthetic post-removal project body",
		origin_device_id: p.a.local.deviceId,
	});
	const received = p.b.store.db
		.prepare(
			"SELECT title, body_text, scope_id, origin_device_id FROM memory_items WHERE title = ?",
		)
		.all(title);
	expect(received).toEqual([source]);
	expect(
		p.b.store.db
			.prepare(
				`SELECT s.kind FROM replication_scopes s JOIN memory_items m ON s.scope_id = m.scope_id
		 WHERE m.title = ?`,
			)
			.pluck()
			.get(title),
	).toBe("managed_project");
	expect(
		p.a.store.db
			.prepare(
				`SELECT sm.status FROM scope_memberships sm JOIN memory_items m ON sm.scope_id = m.scope_id
		 WHERE m.title = ? AND sm.device_id = ?`,
			)
			.pluck()
			.get(title, p.b.local.deviceId),
	).toBe("active");
	const applied = p.b.store.db
		.prepare(
			`SELECT op_id FROM replication_ops
		 WHERE entity_type = 'memory_item' AND op_type = 'upsert'
		 AND json_extract(payload_json, '$.title') = ?`,
		)
		.pluck()
		.all(title);
	expect(applied.length).toBeGreaterThan(0);
	for (const opId of applied) {
		expect(
			p.a.store.db.prepare("SELECT op_id FROM replication_ops WHERE op_id = ?").pluck().get(opId),
		).toBe(opId);
	}
}

it("completes mounted Project rejoin with an applied operation before ordinary Block propagation", async () => {
	const p = await projectPropagationFixture();
	const { f, a, b, c } = p;
	pairForPropagation(c.local, b.local);
	const stale = await p.issue();
	expect(await a.run(() => f.remove())).toMatchObject({ state: "removed" });
	await b.run(() => removeCoordinatorRevokedPeers(b.store, b.config));
	expect(
		readCoordinatorRemovalState(b.store.db, {
			coordinatorId: coordinatorOrigin,
			groupIds: [groupId],
		}),
	).toMatchObject({ removed: true, removedFromGroups: [groupId] });
	expect(await c.run(() => removeCoordinatorRevokedPeers(c.store, c.config))).toMatchObject({
		status: "checked",
		removed: 1,
	});
	for (const local of [a.local, c.local]) {
		expect((await signedPeerRead(local, b.local)("/v1/ops")).status).toBe(401);
	}
	await expect(p.accept(stale.invite.encoded)).rejects.toThrow("Invite import failed (403).");
	// A newly captured Project memory changes the reviewed intent and creates a fresh invitation.
	p.remember("After removal, before bootstrap");
	const fresh = await p.issue();
	expect(fresh.operation_id).not.toBe(stale.operation_id);
	expect(await p.accept(fresh.invite.encoded)).toMatchObject({ setup_state: "pending_inviter" });
	await advanceProject(p, fresh.operation_id, b);
	p.remember();
	expect(
		b.store.db
			.prepare("SELECT 1 FROM memory_items WHERE title = ?")
			.get("Eligible lifecycle operation"),
	).toBeUndefined();
	expect(
		await a.run(() =>
			runSyncPass(a.store.db, b.local.deviceId, {
				keysDir: a.local.keysDir,
				dbPath: a.local.dbPath,
				scanner: a.store.scanner,
				refreshAuthorization: true,
			}),
		),
	).toMatchObject({ ok: true });
	assertAppliedProjectOperation(p);
	const survivorInvite = await p.issue("Survivor");
	await p.accept(survivorInvite.invite.encoded, c);
	await advanceProject(p, survivorInvite.operation_id, c);
	for (const device of [b, c]) {
		await device.run(() =>
			refreshConfiguredScopeMembershipCache(device.store.db, device.config, {
				keysDir: device.local.keysDir,
				dbPath: device.local.dbPath,
			}),
		);
		await device.run(() => refreshAuthorizedCoordinatorPeerTrust(device.store, device.config));
	}
	await propagatePermanentBlock(p);
	const blockedInvite = await p.issue();
	expect(blockedInvite.operation_id).not.toBe(fresh.operation_id);
	const beforeBlocked = f.snapshot();
	const beforeConfig = readFileSync(b.configPath, "utf8");
	await expect(p.accept(blockedInvite.invite.encoded)).rejects.toThrow(
		"Invite import failed (403).",
	);
	expect(p.joins.at(-1)).toMatchObject({ status: 403, body: { error: "device_revoked" } });
	expect(f.snapshot()).toEqual(beforeBlocked);
	expect(readFileSync(b.configPath, "utf8")).toBe(beforeConfig);
	for (const request of p.joins) expect(request.signature).toMatch(/^v2:/u);
	for (const result of f.verifier.mock.results) expect(await result.value).toBe(true);
});
