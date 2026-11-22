import { vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "../../../core/src/better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "../../../core/src/coordinator-api.js";
import { CANONICAL_PUBLIC_KEY as publicKey } from "../../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { createCoordinatorRefreshLifecycle } from "../../../core/src/coordinator-refresh-lifecycle.js";
import { readCoordinatorSyncConfig } from "../../../core/src/coordinator-sync-config.js";
import { verifiedLocalKeyId } from "../../../core/src/device-retirement.js";
import { MemoryStore } from "../../../core/src/store.js";
import { fingerprintPublicKey } from "../../../core/src/sync-fingerprint.js";
import { deviceRemovalCommitRoutes } from "../../../viewer-server/src/routes/device-removal-commit.js";
import { deviceRemovalReviewRoutes } from "../../../viewer-server/src/routes/device-removal-review.js";

const origin = "https://coordinator.example.test";
const viewerOrigin = "http://localhost:7337";
const secret = "synthetic-devices-remove";
const group = "fixture-group";
const localId = "fixture-viewer";
const remoteCommit = "/v1/admin/devices/removal";
const remoteList = "/v1/admin/devices/removals";

function seedLocal(db, deviceId) {
	const localKey = publicKey.replace("dam", "eam");
	db.prepare("INSERT INTO sync_device VALUES (?, ?, ?, 'then')").run(
		localId,
		localKey,
		fingerprintPublicKey(localKey),
	);
	db.prepare(`INSERT INTO sync_peers (peer_device_id, public_key, pinned_fingerprint, created_at)
		VALUES (?, ?, ?, 'then')`).run(deviceId, publicKey, fingerprintPublicKey(publicKey));
	db.prepare(`INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, updated_at)
		VALUES (?, 'cursor', 'then')`).run(deviceId);
	db.prepare(`INSERT INTO identity_devices (device_id, identity_id, display_name, status, provenance,
		revision, migration_state, idempotency_key, created_at, updated_at)
		VALUES (?, 'fixture-identity', 'Laptop', 'active', 'test', '1', 'user_managed', 'key:peer', 'then', 'then')`).run(
		deviceId,
	);
}

function viewerRoutes(store, waitForRefresh, refresh) {
	const loadConfig = () =>
		readCoordinatorSyncConfig({
			sync_coordinator_url: origin,
			sync_coordinator_admin_secret: secret,
		});
	const read = deviceRemovalReviewRoutes({
		readCoordinatorConfig: loadConfig,
		localIdentity: () => ({ deviceId: localId, keyId: verifiedLocalKeyId(store.db, localId) }),
	});
	return read.route(
		"/",
		deviceRemovalCommitRoutes({
			getStore: () => ({ db: store.db, deviceId: localId }),
			readCoordinatorConfig: loadConfig,
			createDeviceRemovalRefreshHooks: () => ({ waitForRefresh, refresh }),
		}),
	);
}

function captureRequests(viewer, coordinator) {
	const paths = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input, init) => {
			const url = new URL(input, viewerOrigin);
			const request = new Request(url, init);
			paths.push(url.pathname);
			if (url.origin === viewerOrigin) return viewer.request(request);
			if (url.origin !== origin) throw new Error("Unexpected network request");
			const reply = await coordinator.request(request);
			if (url.pathname === remoteCommit && reply.ok) throw new Error("Synthetic lost reply");
			return reply;
		}),
	);
	return paths;
}

export async function createRemovalClickFixture(deviceId) {
	const local = new MemoryStore(":memory:");
	const remote = new BetterSqliteCoordinatorStore(":memory:");
	const remoteClose = vi.spyOn(remote, "close").mockResolvedValue();
	const close = async () => {
		vi.unstubAllGlobals();
		remoteClose.mockRestore();
		await remote.close();
		await local.close();
	};
	try {
		const fingerprint = fingerprintPublicKey(publicKey);
		seedLocal(local.db, deviceId);
		await remote.createGroup(group);
		await remote.enrollDevice(group, { deviceId, publicKey, fingerprint });
		const coordinator = createCoordinatorApp({
			storeFactory: () => remote,
			runtime: { adminSecret: () => secret, now: () => "2026-11-22T00:00:00.000Z" },
			requestVerifier: () => false,
		});
		const lifecycle = createCoordinatorRefreshLifecycle();
		const waiting = Promise.withResolvers();
		const refresh = vi.fn(async () => {});
		const hooks = lifecycle.forRemoval(refresh);
		const viewer = viewerRoutes(
			local,
			() => {
				const ready = hooks.waitForRefresh();
				waiting.resolve("waiting");
				return ready;
			},
			hooks.refresh,
		);
		const paths = captureRequests(viewer, coordinator);
		const binding = () => local.db.prepare("SELECT status FROM identity_devices").pluck().get();
		const paired = () => Boolean(local.db.prepare("SELECT 1 FROM sync_peers").get());
		const cursor = () =>
			local.db.prepare("SELECT last_applied_cursor FROM replication_cursors").pluck().get();
		return {
			lifecycle,
			waiting: waiting.promise,
			paths,
			refresh,
			binding,
			paired,
			cursor,
			enrollment: () => remote.getEnrollment(group, deviceId),
			remoteCommit,
			remoteList,
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
