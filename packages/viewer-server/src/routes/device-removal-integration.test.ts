import {
	BetterSqliteCoordinatorStore,
	createCoordinatorApp,
	fingerprintPublicKey,
	readCoordinatorSyncConfig,
	verifiedLocalKeyId,
} from "@codemem/core";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { ensureMemoryRetirementDeliverySchema } from "../../../core/src/memory-retirement-delivery-schema.js";
import { ensurePeerRemovalCheckState } from "../../../core/src/peer-removal-check-state.js";
import { initTestSchema } from "../../../core/src/test-utils.js";
import { confirmAndCommitDeviceRemoval } from "../../../ui/src/tabs/device-removal-confirmation";
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
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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
		requestVerifier: () => false,
	});
	return { app, store };
}

type FixtureOptions = {
	loseReply?: boolean;
	loseRequest?: boolean;
	missingCommitRoute?: boolean;
	progressUnavailable?: boolean;
};

async function fixture(options: FixtureOptions = {}) {
	const local = localStore();
	const { app, store } = await coordinatorStore();
	const config = {
		...readCoordinatorSyncConfig({}),
		syncCoordinatorUrl: origin,
		syncCoordinatorAdminSecret: adminSecret,
	};
	const runtime = {
		readCoordinatorConfig: () => config,
		waitForRefresh: vi.fn(async () => {}),
		refresh: vi.fn(async () => {}),
	};
	const viewer = new Hono()
		.route(
			"/",
			deviceRemovalReviewRoutes({
				readCoordinatorConfig: runtime.readCoordinatorConfig,
				localIdentity: () => ({ deviceId: localId, keyId: verifiedLocalKeyId(local.db, localId) }),
			}),
		)
		.route(
			"/",
			deviceRemovalCommitRoutes({
				readCoordinatorConfig: runtime.readCoordinatorConfig,
				createDeviceRemovalRefreshHooks: () => runtime,
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
		expect(new Headers(init.headers).get("X-Codemem-Coordinator-Admin")).toBe(adminSecret);
		remote.push(url.pathname);
		if (url.pathname === progressPaths[0] && options.progressUnavailable)
			return new Response(null, { status: 503 });
		if (url.pathname === remoteCommit && options.missingCommitRoute)
			return new Response(null, { status: 404 });
		if (url.pathname === remoteCommit && options.loseRequest)
			throw new Error("synthetic lost request");
		const response = await app.request(new Request(url, init));
		if (url.pathname === remoteCommit && options.loseReply) {
			expect(response.status).toBe(200);
			throw new Error("synthetic lost response");
		}
		return response;
	});
	vi.stubGlobal("fetch", fetch);
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	return { ...local, ...runtime, store, config, viewer, browser, remote };
}

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
