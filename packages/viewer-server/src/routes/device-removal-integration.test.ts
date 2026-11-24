import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BetterSqliteCoordinatorStore,
	canonicalKeyId,
	coordinatorRevokeDeviceAction,
	createCoordinatorApp,
	fingerprintPublicKey,
	generateKeypair,
	listDeviceIdentityInventory,
	loadPublicKey,
	type MemoryStore,
	RemoteCoordinatorRequestError,
	readCoordinatorSyncConfig,
	verifiedLocalKeyId,
} from "@codemem/core";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { createServeCoordinatorRefresh } from "../../../cli/src/commands/serve-coordinator-refresh.js";
import { ensureMemoryRetirementDeliverySchema } from "../../../core/src/memory-retirement-delivery-schema.js";
import { ensurePeerRemovalCheckState } from "../../../core/src/peer-removal-check-state.js";
import {
	listRetiredDeviceAliases,
	retiredAliasApplies,
} from "../../../core/src/retired-device-aliases.js";
import { verifySignature } from "../../../core/src/sync-auth.js";
import { initTestSchema } from "../../../core/src/test-utils.js";
import { confirmAndCommitDeviceRemoval } from "../../../ui/src/tabs/device-removal-confirmation";
import { createApp } from "../index.js";
import { deviceRemovalCommitRoutes } from "./device-removal-commit.js";
import { deviceRemovalReviewRoutes } from "./device-removal-review.js";

vi.mock("../../../ui/src/tabs/sync/sync-dialogs", () => ({
	openSyncConfirmDialog: () => {
		throw new Error("Synthetic test must provide confirmation");
	},
}));

const origin = "https://coordinator.example.test";
const viewerOrigin = "http://localhost:7337";
const adminSecret = "synthetic-viewer-removal-fixture";
const groupId = "fixture-team";
const deviceId = "peer";
const localId = "viewer";
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea";
const previewPath = "/api/sync/devices/peer/remove/preview";
const commitPath = "/api/sync/devices/peer/remove";
const remotePreview = "/v1/admin/devices/removal-preview";
const remoteCommit = "/v1/admin/devices/removal";
const remoteList = "/v1/admin/devices/removals";
const progressPaths = ["/v1/admin/groups", "/v1/admin/devices"];
const target = { deviceId, displayName: "Travel laptop" };
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixtureConfig(text: string) {
	const directory = mkdtempSync(join(tmpdir(), "codemem-viewer-remove-config-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "config.json");
	writeFileSync(path, text);
	vi.stubEnv("CODEMEM_CONFIG", path);
	return path;
}

function localStore() {
	const db = new Database(":memory:");
	cleanups.push(() => db.close());
	initTestSchema(db);
	ensureMemoryRetirementDeliverySchema(db);
	ensurePeerRemovalCheckState(db);
	const ownKey = key.replace("dam", "eam");
	db.prepare(`INSERT INTO sync_device VALUES (?, ?, ?, 'then')`).run(
		localId,
		ownKey,
		fingerprintPublicKey(ownKey),
	);
	db.prepare(`INSERT INTO sync_peers (peer_device_id, public_key, pinned_fingerprint, created_at)
		VALUES (?, ?, ?, 'then')`).run(deviceId, key, fingerprintPublicKey(key));
	db.prepare(`INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, updated_at)
		VALUES (?, 'cursor', 'then')`).run(deviceId);
	db.prepare(`INSERT INTO identity_devices (device_id, identity_id, display_name, status, provenance,
		revision, migration_state,idempotency_key, created_at, updated_at)
		VALUES (?, 'fixture-identity', 'Laptop', 'active', 'test', '1','user_managed', 'key:peer', 'then', 'then')`).run(
		deviceId,
	);
	const localSnapshot = () => ({
		paired: Boolean(db.prepare("SELECT 1 FROM sync_peers").get()),
		cursor: db.prepare("SELECT last_applied_cursor FROM replication_cursors").pluck().get() ?? null,
		binding: db.prepare("SELECT status FROM identity_devices").pluck().get(),
	});
	return { db, deviceId: localId, localSnapshot };
}

async function coordinatorStore() {
	const store = new BetterSqliteCoordinatorStore(":memory:");
	const close = vi.spyOn(store, "close").mockResolvedValue();
	cleanups.push(async () => {
		close.mockRestore();
		await store.close();
	});
	await store.createGroup(groupId);
	await store.enrollDevice(groupId, {
		deviceId,
		publicKey: key,
		fingerprint: fingerprintPublicKey(key),
	});
	const otherKey = key.replace("dam", "fam");
	for (const [deviceId, sequence] of [
		["applied", 42],
		["pending", 0],
		["older", null],
	] as const) {
		await store.enrollDevice(groupId, {
			deviceId,
			publicKey: otherKey,
			fingerprint: fingerprintPublicKey(otherKey),
		});
		if (sequence === null) continue;
		await store.upsertPresence({
			groupId,
			deviceId,
			addresses: [],
			ttlS: 120,
			capabilities: { applied_removal_seq: sequence },
		});
	}
	const app = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => adminSecret, now: () => "2026-11-21T00:00:00.000Z" },
		requestVerifier: (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		deviceRevocation: { coordinatorId: "synthetic-viewer-removal" },
	});
	return { app, store };
}

type FixtureOptions = {
	loseReply?: boolean;
	loseRequest?: boolean;
	missingCommitRoute?: boolean;
	progressUnavailable?: boolean;
	sharedRefresh?: boolean;
	localOnly?: boolean;
	blockFailure?: "preflight" | "commit";
	blockCompatibility?: "rejects_selector" | "ignores_selector" | "unavailable";
	mounted?: boolean;
	lookupUnavailable?: boolean;
};

const blockPreviewPath = "/v1/admin/devices/revoke-preview";
const blockCommitPath = "/v1/admin/devices/revoke";
const blockRequest = { remoteUrl: origin, adminSecret, groupId, deviceId };
const refusedBlockPath = { preflight: blockPreviewPath, commit: blockCommitPath };

async function fixtureBlockCompatibility(
	app: Awaited<ReturnType<typeof coordinatorStore>>["app"],
	request: Request,
	compatibility: FixtureOptions["blockCompatibility"],
) {
	if (!compatibility || new URL(request.url).pathname !== blockPreviewPath)
		return app.request(request);
	const body = await request.clone().json<Record<string, unknown>>();
	if (!Object.hasOwn(body, "required_removal_id")) return app.request(request);
	if (compatibility === "rejects_selector")
		return Response.json({ error: "revocation_invalid_input" }, { status: 400 });
	if (compatibility === "unavailable")
		return Response.json({ error: "revocation_unavailable" }, { status: 503 });
	delete body.required_removal_id;
	return app.request(new Request(request, { body: JSON.stringify(body) }));
}

async function fixture(options: FixtureOptions = {}) {
	const local = localStore();
	const { app, store } = await coordinatorStore();
	const config = {
		...readCoordinatorSyncConfig({}),
		syncCoordinatorUrl: options.localOnly ? "" : origin,
		syncCoordinatorAdminSecret: options.localOnly ? "" : adminSecret,
		syncCoordinatorGroups: options.mounted ? [groupId] : [],
	};
	const runtime = {
		readCoordinatorConfig: () => config,
		waitForRefresh: vi.fn(async () => {}),
		refresh: vi.fn(async () => {}),
	};
	const shared = createServeCoordinatorRefresh(
		{ store: { db: local.db, dbPath: ":memory:" }, signal: new AbortController().signal },
		async () => {
			await runtime.refresh();
			return { refreshed: true, peers: [] };
		},
	);
	const createHooks = () => {
		if (!options.sharedRefresh) return runtime;
		const hooks = shared.viewer.createDeviceRemovalRefreshHooks();
		return {
			waitForRefresh: () => {
				const ready = hooks.waitForRefresh();
				return runtime.waitForRefresh().then(() => ready);
			},
			refresh: hooks.refresh,
		};
	};
	if (options.mounted) await enableFixtureSigning(local, store);
	const viewer = options.mounted
		? createApp({
				storeFactory: () => ({ ...local, dbPath: ":memory:" }) as MemoryStore,
				readCoordinatorConfig: runtime.readCoordinatorConfig,
				createDeviceRemovalRefreshHooks: createHooks,
			})
		: new Hono()
				.route(
					"/",
					deviceRemovalReviewRoutes({
						readCoordinatorConfig: runtime.readCoordinatorConfig,
						localIdentity: () => ({
							deviceId: localId,
							keyId: verifiedLocalKeyId(local.db, localId),
						}),
						getLocalStore: () => local,
					}),
				)
				.route(
					"/",
					deviceRemovalCommitRoutes({
						readCoordinatorConfig: runtime.readCoordinatorConfig,
						createDeviceRemovalRefreshHooks: createHooks,
						getStore: () => local,
					}),
				);
	const browser: string[] = [];
	const remote: string[] = [];
	const fetch = vi.fn(async (input: string, init: RequestInit) => {
		const url = new URL(input, viewerOrigin);
		if (url.origin === viewerOrigin) {
			browser.push(url.pathname);
			return viewer.request(new Request(url, init));
		}
		expect(url.origin).toBe(origin);
		expect(new Headers(init.headers).get("X-Codemem-Coordinator-Admin")).toBe(
			url.pathname === "/v1/peers/revocations" ? null : adminSecret,
		);
		remote.push(url.pathname);
		const refusal = fixtureRemoteRefusal(url.pathname, options);
		if (refusal) return refusal;
		const response = await fixtureBlockCompatibility(
			app,
			new Request(url, init),
			options.blockCompatibility,
		);
		if (url.pathname === remoteCommit && options.loseReply) {
			expect(response.status).toBe(200);
			throw new Error("synthetic lost response");
		}
		return response;
	});
	vi.stubGlobal("fetch", fetch);
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	return { ...local, ...runtime, store, config, viewer, browser, remote, shared };
}

function fixtureRemoteRefusal(path: string, options: FixtureOptions) {
	if (path === "/v1/peers/revocations" && options.lookupUnavailable)
		return new Response(null, { status: 404 });
	if (options.blockFailure !== undefined && path === refusedBlockPath[options.blockFailure])
		return Response.json({ error: "revocation_target_unavailable" }, { status: 409 });
	if (path === progressPaths[0] && options.progressUnavailable)
		return new Response(null, { status: 503 });
	if (path !== remoteCommit) return null;
	if (options.missingCommitRoute) return new Response(null, { status: 404 });
	if (options.loseRequest) throw new Error("synthetic lost request");
	return null;
}

async function enableFixtureSigning(
	local: ReturnType<typeof localStore>,
	store: BetterSqliteCoordinatorStore,
) {
	const keysDir = mkdtempSync(join(tmpdir(), "codemem-removal-lookup-keys-"));
	cleanups.push(() => rmSync(keysDir, { recursive: true, force: true }));
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	generateKeypair(join(keysDir, "device.key"), join(keysDir, "device.key.pub"));
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("Missing fixture public key");
	const fingerprint = fingerprintPublicKey(publicKey);
	local.db
		.prepare("UPDATE sync_device SET public_key = ?, fingerprint = ?")
		.run(publicKey, fingerprint);
	await store.enrollDevice(groupId, { deviceId: localId, publicKey, fingerprint });
}

it("uses signed global evidence to commit a mounted Remove for a locally paired, unenrolled device", async () => {
	const f = await fixture({ mounted: true });
	// An unrelated pairing is not in the coordinator's enrollment or removal records.
	const peer = "local-only-peer";
	const peerKey = key.replace("dam", "zam");
	f.db
		.prepare("UPDATE sync_peers SET peer_device_id = ?, public_key = ?, pinned_fingerprint = ?")
		.run(peer, peerKey, fingerprintPublicKey(peerKey));
	f.db.prepare("UPDATE identity_devices SET device_id = ?").run(peer);
	expect(
		await confirmAndCommitDeviceRemoval(
			{ deviceId: peer, displayName: "Local peer" },
			{ confirm: async () => true },
		),
	).toEqual({ state: "removed", mode: "local" });
	expect(f.remote).toEqual(["/v1/peers/revocations", "/v1/peers/revocations"]);
	expect(f.localSnapshot()).toMatchObject({ paired: false, binding: "removed" });
	expect((await f.store.listDeviceRemovals()).items).toEqual([]);
});

it("never falls back to Remove when a mounted Viewer cannot obtain signed evidence", async () => {
	const f = await fixture({ mounted: true, lookupUnavailable: true });
	const before = f.localSnapshot();
	const response = await f.viewer.request(previewPath, { method: "POST" });
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: "device_removal_unavailable" });
	expect(f.remote).toEqual(["/v1/peers/revocations"]);
	expect(f.localSnapshot()).toEqual(before);
	expect((await f.store.listDeviceRemovals()).items).toEqual([]);
});

it("uses the mounted routes to remove an enrolled peer after signed lookup", async () => {
	const f = await fixture({ mounted: true });
	await expect(
		confirmAndCommitDeviceRemoval(target, { confirm: async () => true }),
	).resolves.toMatchObject({
		state: "removed",
		evidence: "receipt",
		local_cleanup: "applied",
	});
	expect(f.remote).toEqual([
		"/v1/peers/revocations",
		remotePreview,
		"/v1/peers/revocations",
		remotePreview,
		remoteCommit,
		...progressPaths,
	]);
	expect(await f.store.getEnrollment(groupId, deviceId, true)).toBeNull();
	expect(f.localSnapshot()).toEqual({ paired: false, cursor: null, binding: "removed" });
});

it("does not remove an enrolled disabled peer from a Viewer without admin credentials", async () => {
	const f = await fixture({ mounted: true });
	f.config.syncCoordinatorAdminSecret = "";
	await f.store.setDeviceEnabled(groupId, deviceId, false);
	const before = f.localSnapshot();
	const response = await f.viewer.request(previewPath, { method: "POST" });
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "coordinator_admin_required" });
	expect(f.remote).toEqual(["/v1/peers/revocations"]);
	expect(await f.store.getEnrollment(groupId, deviceId, true)).not.toBeNull();
	expect(f.localSnapshot()).toEqual(before);
});

it("clears local state for an already removed peer without issuing a second coordinator Remove", async () => {
	const f = await fixture({ mounted: true });
	f.config.syncCoordinatorAdminSecret = "";
	expect(await f.store.removeDevice(groupId, deviceId)).toBe(true);
	const before = await f.store.listDeviceRemovals();
	await expect(
		confirmAndCommitDeviceRemoval(target, { confirm: async () => true }),
	).resolves.toEqual({
		state: "removed",
		mode: "already_removed",
	});
	expect(f.remote).toEqual(["/v1/peers/revocations", "/v1/peers/revocations"]);
	expect(await f.store.listDeviceRemovals()).toEqual(before);
	expect(f.localSnapshot()).toEqual({ paired: false, cursor: null, binding: "removed" });
	expect(listRetiredDeviceAliases(f.db).has(deviceId)).toBe(false);
});

it("retains the blocked key when the mounted Viewer cleans up a revoked peer", async () => {
	const f = await fixture({ mounted: true });
	f.config.syncCoordinatorAdminSecret = "";
	const fingerprint = fingerprintPublicKey(key);
	await expect(
		f.store.createDeviceRevocation({ groupId, deviceId, publicKey: key, fingerprint }),
	).resolves.toMatchObject({ kind: "revoked" });
	await expect(
		confirmAndCommitDeviceRemoval(target, { confirm: async () => true }),
	).resolves.toEqual({
		state: "removed",
		mode: "already_removed",
	});
	expect(f.remote).toEqual(["/v1/peers/revocations", "/v1/peers/revocations"]);
	expect(f.localSnapshot()).toEqual({ paired: false, cursor: null, binding: "removed" });
	const alias = listRetiredDeviceAliases(f.db).get(deviceId);
	expect(alias).toEqual({ kind: "key", keyId: canonicalKeyId(key), fingerprint });
	expect(retiredAliasApplies(alias, { publicKey: `${key} alias`, fingerprint: null })).toBe(true);
	expect(
		retiredAliasApplies(alias, { publicKey: key.replace("dam", "fam"), fingerprint: null }),
	).toBe(false);
	expect(
		listDeviceIdentityInventory(f.db, {
			localDeviceId: localId,
			coordinator: { availability: "available", safeErrorCode: null, enrollments: [] },
		}).items,
	).toContainEqual(expect.objectContaining({ deviceId, state: "retired" }));
});

async function supportsPinnedBlockFixture() {
	try {
		// A new removal ID cannot name an existing tombstone in this fixture.
		// A capable coordinator recognizes the selector and refuses the nonmatching target.
		await coordinatorRevokeDeviceAction({
			...blockRequest,
			requiredRemovalId: crypto.randomUUID(),
		});
		return false;
	} catch (error) {
		return (
			error instanceof RemoteCoordinatorRequestError &&
			error.status === 409 &&
			error.code === "revocation_target_unavailable"
		);
	}
}

// Exercise the existing transports without mounting a production Block action.
async function runCompoundBlockFixture() {
	const preflight = await coordinatorRevokeDeviceAction(blockRequest);
	if (preflight.state !== "ready") throw new Error("Expected enrollment Block preview");
	if (!(await supportsPinnedBlockFixture())) throw new Error("pinned_block_support_unconfirmed");
	const removal = await confirmAndCommitDeviceRemoval(target, { confirm: async () => true });
	if (!removal || "mode" in removal) throw new Error("Expected verified coordinator removal");
	const pinned = { ...blockRequest, requiredRemovalId: removal.removal_id };
	const preview = await coordinatorRevokeDeviceAction(pinned);
	if (
		preview.state !== "ready" ||
		preview.coordinator_id !== preflight.coordinator_id ||
		preview.key_id !== preflight.key_id
	)
		throw new Error("Block evidence does not match preflight");
	return coordinatorRevokeDeviceAction({
		...pinned,
		expectedDigest: preview.expected_digest,
		expectedContext: { coordinatorId: preview.coordinator_id, keyId: preview.key_id },
	});
}

it("blocks an enrolled device using a new preview pinned to the verified Remove receipt", async () => {
	const f = await fixture();
	await expect(runCompoundBlockFixture()).resolves.toMatchObject({
		state: "revoked",
		group_id: groupId,
		device_id: deviceId,
	});
	expect(f.remote).toEqual([
		blockPreviewPath,
		blockPreviewPath,
		remotePreview,
		remotePreview,
		remoteCommit,
		...progressPaths,
		blockPreviewPath,
		blockCommitPath,
	]);
	expect(await f.store.getEnrollment(groupId, deviceId, true)).toBeNull();
	expect(f.localSnapshot()).toEqual({ paired: false, cursor: null, binding: "removed" });
});

it.each(["rejects_selector", "ignores_selector", "unavailable"] as const)(
	"does not request Viewer Remove when Block capability cannot be confirmed (%s)",
	async (blockCompatibility) => {
		const f = await fixture({ blockCompatibility });
		const before = f.localSnapshot();
		const enrollment = await f.store.getEnrollment(groupId, deviceId, true);
		expect(enrollment).not.toBeNull();
		await expect(runCompoundBlockFixture()).rejects.toThrow(/^pinned_block_support_unconfirmed$/);
		expect(f.remote).toEqual([blockPreviewPath, blockPreviewPath]);
		expect(f.browser).toEqual([]);
		expect(f.localSnapshot()).toEqual(before);
		expect(await f.store.getEnrollment(groupId, deviceId, true)).toEqual(enrollment);
		expect((await f.store.listDeviceRemovals({ deviceId })).items).toEqual([]);
		expect(await f.store.listDeviceRevocations({ deviceId, publicKey: key })).toEqual([]);
	},
);

it("leaves the enrollment and pairing intact if Block preflight refuses", async () => {
	const f = await fixture({ blockFailure: "preflight" });
	const before = f.localSnapshot();
	await expect(runCompoundBlockFixture()).rejects.toMatchObject({
		status: 409,
		code: "revocation_target_unavailable",
	});
	expect(f.remote).toEqual([blockPreviewPath]);
	expect(f.browser).toEqual([]);
	expect(f.localSnapshot()).toEqual(before);
	expect(await f.store.getEnrollment(groupId, deviceId, true)).not.toBeNull();
	expect((await f.store.listDeviceRemovals({ deviceId })).items).toEqual([]);
});

it("keeps the verified removal available in Devices after an explicit Block commit refusal", async () => {
	const options: FixtureOptions = { blockFailure: "commit" };
	const f = await fixture(options);
	await expect(runCompoundBlockFixture()).rejects.toMatchObject({
		status: 409,
		code: "revocation_target_unavailable",
	});
	expect(f.remote.slice(-2)).toEqual([blockPreviewPath, blockCommitPath]);
	expect(await f.store.getEnrollment(groupId, deviceId, true)).toBeNull();
	expect(f.localSnapshot()).toEqual({ paired: false, cursor: null, binding: "removed" });
	expect(await f.store.listDeviceRevocations({ deviceId, publicKey: key })).toEqual([]);
	const listing = await f.viewer.request("/api/sync/devices/removals");
	expect(listing.status).toBe(200);
	expect(await listing.json()).toMatchObject({
		items: [{ group_id: groupId, device_id: deviceId }],
	});
	options.blockFailure = undefined;
	const retry = await coordinatorRevokeDeviceAction(blockRequest);
	if (retry.state !== "ready") throw new Error("Expected removed-device Block preview");
	await expect(
		coordinatorRevokeDeviceAction({
			...blockRequest,
			expectedDigest: retry.expected_digest,
		}),
	).resolves.toMatchObject({ state: "revoked" });
	expect(f.remote.filter((path) => path === remoteCommit)).toHaveLength(1);
});

it.each(["coordinator configured", "pairing changed"] as const)(
	"refuses a local-only confirmation when the %s after preview",
	async (change) => {
		const f = await fixture({ localOnly: true });
		const before = f.localSnapshot();
		const confirm = vi.fn(async () => {
			if (change === "coordinator configured") f.config.syncCoordinatorUrl = origin;
			else f.db.prepare("UPDATE sync_peers SET pinned_fingerprint = 'changed'").run();
			return true;
		});
		await expect(confirmAndCommitDeviceRemoval(target, { confirm })).rejects.toMatchObject({
			code: "removal_preview_stale",
		});
		expect(confirm).toHaveBeenCalledOnce();
		expect(f.remote).toEqual([]);
		expect(f.localSnapshot()).toEqual(before);
	},
);

it.each([
	"{broken",
	'{"sync_coordinator_url":42}',
	'{"sync_coordinator_url":"https://coordinator.example.test"}',
] as const)(
	"never offers local Remove when the config file cannot prove the coordinator is absent (%s)",
	async (text) => {
		fixtureConfig(text);
		const f = await fixture({ localOnly: true });
		const before = f.localSnapshot();
		const response = await f.viewer.request(previewPath, { method: "POST" });
		expect(response.status).not.toBe(200);
		expect(await response.json()).not.toHaveProperty("mode", "local");
		expect(f.remote).toEqual([]);
		expect(f.localSnapshot()).toEqual(before);
	},
);

it("does not use local Remove when an environment override configures the coordinator", async () => {
	fixtureConfig("{}");
	const f = await fixture({ localOnly: true });
	const before = f.localSnapshot();
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", origin);
	const response = await f.viewer.request(previewPath, { method: "POST" });
	expect(response.status).not.toBe(200);
	expect(await response.json()).not.toHaveProperty("mode", "local");
	expect(f.remote).toEqual([]);
	expect(f.localSnapshot()).toEqual(before);
});

it("does not commit local Remove when the config becomes malformed after preview", async () => {
	const path = fixtureConfig("{}");
	const f = await fixture({ localOnly: true });
	const before = f.localSnapshot();
	const confirm = vi.fn(async () => {
		writeFileSync(path, "{broken");
		return true;
	});
	await expect(confirmAndCommitDeviceRemoval(target, { confirm })).rejects.toMatchObject({
		code: "removal_preview_stale",
	});
	expect(confirm).toHaveBeenCalledOnce();
	expect(f.remote).toEqual([]);
	expect(f.localSnapshot()).toEqual(before);
});

it("refuses a local-only Remove of a pairing that holds this device's key", async () => {
	const f = await fixture({ localOnly: true });
	const ownKey = key.replace("dam", "eam");
	f.db
		.prepare("UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ?")
		.run(`${ownKey} alias`, fingerprintPublicKey(`${ownKey} alias`));
	const before = f.localSnapshot();
	const review = await f.viewer.request(previewPath, { method: "POST" });
	expect(review.status).toBe(400);
	expect(await review.json()).toEqual({ error: "cannot_remove_this_device" });
	expect(f.remote).toEqual([]);
	expect(f.localSnapshot()).toEqual(before);
});

it("uses the real review and commit routes only after the device confirmation", async () => {
	const f = await fixture();
	const before = f.localSnapshot();
	const confirm = vi.fn(async () => {
		expect(f.remote).toEqual([remotePreview]);
		expect(f.localSnapshot()).toEqual(before);
		return true;
	});
	f.waitForRefresh.mockImplementation(async () => {
		expect(await f.store.getEnrollment(groupId, deviceId)).toBeNull();
		expect(f.localSnapshot()).toEqual(before);
	});
	f.refresh.mockImplementation(async () => {
		expect(f.localSnapshot()).toEqual({ paired: false, cursor: null, binding: "removed" });
	});

	expect(await confirmAndCommitDeviceRemoval(target, { confirm })).toMatchObject({
		state: "removed",
		evidence: "receipt",
		local_cleanup: "applied",
		progress: expect.arrayContaining([
			{ device_id: "applied", group_id: groupId, display_name: null, state: "applied" },
			{ device_id: "pending", group_id: groupId, display_name: null, state: "pending" },
			{ device_id: "older", group_id: groupId, display_name: null, state: "older" },
		]),
	});
	expect(confirm).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ autoFocusAction: "cancel" }),
	);
	expect(f.browser).toEqual([previewPath, commitPath]);
	expect(f.remote).toEqual([remotePreview, remotePreview, remoteCommit, ...progressPaths]);
	expect(f.refresh).toHaveBeenCalledOnce();
});

it("canceling confirmation leaves both stores unchanged", async () => {
	const f = await fixture();
	const before = f.localSnapshot();
	expect(await confirmAndCommitDeviceRemoval(target, { confirm: async () => false })).toBeNull();
	expect(f.browser).toEqual([previewPath]);
	expect(f.remote).toEqual([remotePreview]);
	expect(f.localSnapshot()).toEqual(before);
	expect(await f.store.getEnrollment(groupId, deviceId)).not.toBeNull();
});

it("recovers a lost reply through the listing before cleaning up the local pairing", async () => {
	const f = await fixture({ loseReply: true });
	const before = f.localSnapshot();
	f.waitForRefresh.mockImplementation(async () => {
		expect(f.remote).toEqual([remotePreview, remotePreview, remoteCommit, remoteList]);
		expect(f.localSnapshot()).toEqual(before);
	});
	expect(await confirmAndCommitDeviceRemoval(target, { confirm: async () => true })).toMatchObject({
		state: "removed",
		evidence: "listing",
		local_cleanup: "applied",
	});
	expect(f.localSnapshot()).toEqual({ paired: false, cursor: null, binding: "removed" });
});

it("does not reach the coordinator when the saved admin credential is removed after preview", async () => {
	const f = await fixture();
	const before = f.localSnapshot();
	const result = await f.viewer.request(previewPath, { method: "POST" });
	expect(result.status).toBe(200);
	const { coordinator_origin, expected_digest } = await result.json();
	expect(coordinator_origin).toBe(origin);
	f.config.syncCoordinatorAdminSecret = "";
	const reply = await f.viewer.request(commitPath, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Codemem-Coordinator-Admin": adminSecret,
		},
		body: JSON.stringify({ coordinator_origin, expected_digest }),
	});
	expect(reply.status).toBe(409);
	expect(await reply.json()).toEqual({ error: "coordinator_admin_required" });
	expect(f.remote).toEqual([remotePreview]);
	expect(f.localSnapshot()).toEqual(before);
});

it("rejects a cross-site commit and refuses extra fields without sending a write", async () => {
	const f = await fixture();
	const before = f.localSnapshot();
	const body = JSON.stringify({
		coordinator_origin: origin,
		expected_digest: "a".repeat(64),
		admin_secret: adminSecret,
	});
	expect(
		(
			await f.viewer.request(commitPath, {
				method: "POST",
				headers: { Origin: "https://other.example.test" },
				body,
			})
		).status,
	).toBe(403);
	const invalid = await f.viewer.request(commitPath, { method: "POST", body });
	expect(invalid.status).toBe(400);
	expect(await invalid.json()).toEqual({ error: "invalid_input" });
	expect(f.remote).toEqual([]);
	expect(f.localSnapshot()).toEqual(before);
});

it("returns an unknown outcome and preserves local state when no commit evidence exists", async () => {
	const f = await fixture({ loseRequest: true });
	const before = f.localSnapshot();
	const response = await f.viewer.request(previewPath, { method: "POST" });
	const { coordinator_origin, expected_digest } = await response.json();
	const result = await f.viewer.request(commitPath, {
		method: "POST",
		body: JSON.stringify({ coordinator_origin, expected_digest }),
	});
	expect(result.status).toBe(502);
	expect(await result.json()).toEqual({ error: "removal_outcome_unknown" });
	expect(f.remote).toEqual([remotePreview, remotePreview, remoteCommit, remoteList]);
	expect(f.localSnapshot()).toEqual(before);
	expect(f.refresh).not.toHaveBeenCalled();
});

it("does not send the confirmed removal to a coordinator selected after preview", async () => {
	const f = await fixture();
	const before = f.localSnapshot();
	const confirm = async () => {
		f.config.syncCoordinatorUrl = "https://replacement.example.test";
		return true;
	};
	await expect(confirmAndCommitDeviceRemoval(target, { confirm })).rejects.toMatchObject({
		code: "removal_preview_stale",
		statusCode: 409,
	});
	expect(f.browser).toEqual([previewPath, commitPath]);
	expect(f.remote).toEqual([remotePreview]);
	expect(f.localSnapshot()).toEqual(before);
});

it("reports an older coordinator without running the legacy remove route or local cleanup", async () => {
	const f = await fixture({ missingCommitRoute: true });
	const before = f.localSnapshot();
	await expect(
		confirmAndCommitDeviceRemoval(target, { confirm: async () => true }),
	).rejects.toMatchObject({
		code: "coordinator_update_required",
		statusCode: 503,
	});
	expect(f.remote).toEqual([remotePreview, remotePreview, remoteCommit]);
	expect(f.localSnapshot()).toEqual(before);
	expect(f.waitForRefresh).not.toHaveBeenCalled();
	expect(f.refresh).not.toHaveBeenCalled();
});

it("leaves local state alone until an in-flight refresh actually finishes", async () => {
	const f = await fixture();
	const before = f.localSnapshot();
	const waiting = Promise.withResolvers<"waiting">();
	const release = Promise.withResolvers<void>();
	f.waitForRefresh.mockImplementation(() => {
		waiting.resolve("waiting");
		return release.promise;
	});

	const pending = confirmAndCommitDeviceRemoval(target, { confirm: async () => true });
	try {
		expect(await Promise.race([waiting.promise, pending])).toBe("waiting");
		expect(await f.store.getEnrollment(groupId, deviceId)).toBeNull();
		expect(f.localSnapshot()).toEqual(before);
		expect(f.refresh).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await pending;
	}
	expect(await pending).toMatchObject({ state: "removed", local_cleanup: "applied" });
	expect(f.localSnapshot()).toEqual({ paired: false, cursor: null, binding: "removed" });
	expect(f.refresh).toHaveBeenCalledOnce();
});

it("still reports verified removal when peer progress is unavailable", async () => {
	const f = await fixture({ progressUnavailable: true });
	expect(await confirmAndCommitDeviceRemoval(target, { confirm: async () => true })).toMatchObject({
		state: "removed",
		evidence: "receipt",
		local_cleanup: "applied",
		progress: null,
	});
	expect(f.remote).toEqual([remotePreview, remotePreview, remoteCommit, progressPaths[0]]);
	expect(f.localSnapshot()).toEqual({ paired: false, cursor: null, binding: "removed" });
});

it("queues verified Viewer cleanup behind an in-flight manual refresh and before the next daemon pass", async () => {
	const f = await fixture({ sharedRefresh: true, loseReply: true });
	const { viewer, daemon } = f.shared;
	const before = f.localSnapshot();
	const steps: string[] = [];
	const release = Promise.withResolvers<void>();
	const verified = Promise.withResolvers<"verified">();
	const manual = viewer.runManualCoordinatorRefresh(async () => {
		steps.push("manual started");
		await release.promise;
		steps.push("manual finished");
	});
	f.waitForRefresh.mockImplementation(async () => {
		verified.resolve("verified");
	});
	f.refresh.mockImplementation(async () => {
		expect(f.localSnapshot()).toEqual({ paired: false, cursor: null, binding: "removed" });
		steps.push("fresh refresh");
	});

	const removal = confirmAndCommitDeviceRemoval(target, { confirm: async () => true });
	try {
		expect(await Promise.race([verified.promise, removal])).toBe("verified");
		expect(f.localSnapshot()).toEqual(before);
		expect(f.remote).toContain(remoteList);
		expect(steps).toEqual(["manual started"]);
		const queued = daemon.runCoordinatorRefresh(async () => {
			steps.push("daemon resumed");
		});
		release.resolve();
		await queued;
	} finally {
		release.resolve();
		await Promise.all([manual, removal]);
	}
	expect(await removal).toMatchObject({
		state: "removed",
		evidence: "listing",
		local_cleanup: "applied",
	});
	expect(steps).toEqual(["manual started", "manual finished", "fresh refresh", "daemon resumed"]);
});
