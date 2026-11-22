import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { CANONICAL_PUBLIC_KEY as key } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { createCoordinatorRefreshLifecycle } from "./coordinator-refresh-lifecycle.js";
import { ensureMemoryRetirementDeliverySchema } from "./memory-retirement-delivery-schema.js";
import { ensurePeerRemovalCheckState } from "./peer-removal-check-state.js";
import { canonicalKeyId } from "./retired-device-aliases.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";
import { commitViewerDeviceRemoval } from "./viewer-device-removal-commit.js";

const origin = "https://coordinator.example.test";
const adminSecret = "fixture-remove-admin";
const target = { deviceIds: ["peer"] };
const localKey = key.replace("dam", "eam");
const otherKey = key.replace("dam", "fam");
const commentKey = `${key} local-alias`;
const previewPath = "/v1/admin/devices/removal-preview";
const commitPath = "/v1/admin/devices/removal";
const listPath = "/v1/admin/devices/removals";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	vi.unstubAllGlobals();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function pair(db: Database.Database, device: string, publicKey: string) {
	db.prepare(`INSERT INTO sync_peers (peer_device_id, public_key, pinned_fingerprint, created_at)
		VALUES (?, ?, ?, 'then')`).run(device, publicKey, fingerprintPublicKey(publicKey));
	db.prepare(`INSERT INTO replication_cursors (peer_device_id, last_applied_cursor, updated_at)
		VALUES (?, 'cursor', 'then')`).run(device);
}

function bind(db: Database.Database, id: string) {
	db.prepare(`INSERT INTO identity_devices (device_id, identity_id, display_name, status, provenance,
		revision, migration_state, idempotency_key, created_at, updated_at)
		VALUES (?, 'identity', 'Device', 'active', 'test', '1', 'user_managed', ?, 'then', 'then')`).run(
		id,
		`key:${id}`,
	);
}

function localFixture() {
	const db = new Database(":memory:");
	cleanups.push(async () => {
		db.close();
	});
	initTestSchema(db);
	ensureMemoryRetirementDeliverySchema(db);
	ensurePeerRemovalCheckState(db);
	pair(db, "peer", key);
	pair(db, "local-alias", commentKey);
	pair(db, "keep", otherKey);
	for (const id of ["peer", "remote-alias", "local-alias", "keep"]) bind(db, id);
	const waitForRefresh = vi.fn(async () => {});
	const refresh = vi.fn(async () => {});
	const readContext = vi.fn(() => ({
		coordinator: { url: origin, adminSecret },
		local: { deviceId: "local-viewer", keyId: canonicalKeyId(localKey) },
	}));
	const summary = () => ({
		peers: db
			.prepare("SELECT peer_device_id FROM sync_peers ORDER BY peer_device_id")
			.pluck()
			.all(),
		cursors: db
			.prepare("SELECT peer_device_id FROM replication_cursors ORDER BY peer_device_id")
			.pluck()
			.all(),
		removedBindings: db
			.prepare("SELECT device_id FROM identity_devices WHERE status = 'removed' ORDER BY device_id")
			.pluck()
			.all(),
	});
	return { db, waitForRefresh, refresh, readContext, summary };
}

async function coordinatorFixture() {
	const store = new BetterSqliteCoordinatorStore(":memory:");
	const close = vi.spyOn(store, "close").mockResolvedValue();
	cleanups.push(async () => {
		close.mockRestore();
		await store.close();
	});
	for (const [groupId, deviceId] of [
		["a", "peer"],
		["b", "remote-alias"],
	]) {
		await store.createGroup(groupId);
		await store.enrollDevice(groupId, {
			deviceId,
			publicKey: key,
			fingerprint: fingerprintPublicKey(key),
		});
	}
	const app = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => adminSecret, now: () => "2026-11-21T00:00:00.000Z" },
		requestVerifier: () => false,
	});
	const response = await app.request(previewPath, {
		method: "POST",
		headers: { "X-Codemem-Coordinator-Admin": adminSecret },
		body: JSON.stringify({ device_ids: target.deviceIds }),
	});
	expect(response.status).toBe(200);
	const { expected_digest: expectedDigest } = await response.json<{ expected_digest: string }>();
	return { store, app, confirmed: { ...target, expectedDigest, coordinatorOrigin: origin } };
}

type Intercept = (request: Request, dispatch: () => Promise<Response>) => Promise<Response>;

async function fixture(intercept?: Intercept) {
	const local = localFixture();
	const coordinator = await coordinatorFixture();
	const before = local.summary();
	const paths: string[] = [];
	const fetch = vi.fn(async (url: string, init: RequestInit) => {
		expect(new URL(url).origin).toBe(origin);
		expect(init.redirect).toBe("error");
		const request = new Request(url, init);
		paths.push(new URL(url).pathname);
		const dispatch = async () => coordinator.app.request(request);
		return intercept ? intercept(request, dispatch) : dispatch();
	});
	vi.stubGlobal("fetch", fetch);
	return {
		...local,
		...coordinator,
		before,
		paths,
		run: () => commitViewerDeviceRemoval(coordinator.confirmed, local),
	};
}

const afterRemoval = {
	peers: ["keep"],
	cursors: ["keep"],
	removedBindings: ["local-alias", "peer", "remote-alias"],
};

describe("Viewer coordinator removal commit", () => {
	it("uses a verified receipt before waiting for refresh and removing the local pairings", async () => {
		const f = await fixture();
		f.waitForRefresh.mockImplementation(async () => {
			expect(f.summary()).toEqual(f.before);
			expect(await f.store.getEnrollment("a", "peer", true)).toBeNull();
		});
		f.refresh.mockImplementation(async () => {
			expect(f.summary()).toEqual(afterRemoval);
		});
		expect(await f.run()).toMatchObject({
			kind: "removed",
			evidence: { source: "receipt" },
			localCleanup: { state: "applied" },
		});
		expect(f.paths).toEqual([previewPath, commitPath]);
		expect(f.summary()).toEqual(afterRemoval);
		expect(f.waitForRefresh).toHaveBeenCalledOnce();
		expect(f.refresh).toHaveBeenCalledOnce();
	});

	it("recovers a lost commit response from one matching batch before deleting anything", async () => {
		const f = await fixture(async (request, dispatch) => {
			const response = await dispatch();
			if (new URL(request.url).pathname === commitPath) {
				expect(response.status).toBe(200);
				throw new Error("fixture lost response");
			}
			expect(f.summary()).toEqual(f.before);
			return response;
		});
		expect(await f.run()).toMatchObject({ kind: "removed", evidence: { source: "listing" } });
		expect(f.paths).toEqual([previewPath, commitPath, listPath]);
		expect(f.summary()).toEqual(afterRemoval);
	});

	it("keeps local state when the lost request committed nothing", async () => {
		const f = await fixture(async (request, dispatch) => {
			if (new URL(request.url).pathname === commitPath) throw new Error("fixture lost request");
			return dispatch();
		});
		expect(await f.run()).toMatchObject({ kind: "unknown", error: "removal_outcome_unknown" });
		expect(f.paths).toEqual([previewPath, commitPath, listPath]);
		expect(f.summary()).toEqual(f.before);
		expect(f.waitForRefresh).not.toHaveBeenCalled();
	});

	it("does not clean up if a pairing changes while the coordinator request is in flight", async () => {
		const f = await fixture(async (request, dispatch) => {
			if (new URL(request.url).pathname === commitPath) {
				f.db
					.prepare(
						"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = 'peer'",
					)
					.run(otherKey, fingerprintPublicKey(otherKey));
			}
			return dispatch();
		});
		expect(await f.run()).toMatchObject({ kind: "removed", localCleanup: { state: "deferred" } });
		expect(f.summary()).toEqual(f.before);
		expect(f.refresh).toHaveBeenCalledOnce();
	});

	it("rejects a changed digest without dispatching a commit", async () => {
		const f = await fixture();
		expect(
			await commitViewerDeviceRemoval({ ...f.confirmed, expectedDigest: "a".repeat(64) }, f),
		).toMatchObject({ kind: "rejected", error: "removal_preview_stale" });
		expect(f.paths).toEqual([previewPath]);
		expect(f.summary()).toEqual(f.before);
	});

	it("never sends confirmation to a coordinator other than the one previewed", async () => {
		const f = await fixture();
		const confirmed = { ...f.confirmed, coordinatorOrigin: "https://previous.example.test" };
		expect(await commitViewerDeviceRemoval(confirmed, f)).toMatchObject({
			kind: "rejected",
			error: "removal_preview_stale",
		});
		expect(f.paths).toEqual([]);
		expect(f.summary()).toEqual(f.before);
	});

	it("reports an older coordinator without a fallback or local cleanup", async () => {
		const f = await fixture(async (request, dispatch) => {
			if (new URL(request.url).pathname === commitPath) return new Response(null, { status: 404 });
			return dispatch();
		});
		expect(await f.run()).toMatchObject({ kind: "rejected", error: "coordinator_update_required" });
		expect(f.paths).toEqual([previewPath, commitPath]);
		expect(f.summary()).toEqual(f.before);
	});

	it("does not use an incomplete receipt or combine unrelated tombstone batches", async () => {
		const f = await fixture(async (request, dispatch) => {
			if (new URL(request.url).pathname !== commitPath) return dispatch();
			await f.store.removeDevice("a", "peer");
			await f.store.removeDevice("b", "remote-alias");
			return Response.json({
				version: 1,
				state: "removed",
				device_ids: ["peer"],
				key_id: canonicalKeyId(key),
				removal_id: "incomplete",
				removal_seq: 1,
				removals: [{ group_id: "a", device_id: "peer", removal_seq: 1 }],
			});
		});
		expect(await f.run()).toMatchObject({ kind: "unknown", error: "removal_outcome_unknown" });
		expect(f.paths).toEqual([previewPath, commitPath, listPath]);
		expect(f.summary()).toEqual(f.before);
	});

	it("keeps the verified outcome when local cleanup rolls back", async () => {
		const f = await fixture();
		f.db.exec(`CREATE TRIGGER fixture_fail_cleanup BEFORE DELETE ON replication_cursors
			BEGIN SELECT RAISE(ABORT, 'local fixture failure'); END`);
		expect(await f.run()).toMatchObject({
			kind: "removed",
			evidence: { source: "receipt" },
			localCleanup: { state: "deferred" },
		});
		expect(f.summary()).toEqual(f.before);
		expect(f.refresh).toHaveBeenCalledOnce();
	});
});

describe("Viewer removal commit races and failures", () => {
	it("honors the coordinator's stale refusal when an alias appears after preview", async () => {
		const f = await fixture(async (request, dispatch) => {
			if (new URL(request.url).pathname === commitPath) {
				await f.store.enrollDevice("b", {
					deviceId: "new-alias",
					publicKey: key,
					fingerprint: fingerprintPublicKey(key),
				});
			}
			return dispatch();
		});
		expect(await f.run()).toEqual({ kind: "rejected", error: "removal_preview_stale" });
		expect(f.paths).toEqual([previewPath, commitPath]);
		expect(await f.store.listDeviceRemovals()).toMatchObject({ items: [] });
		expect(f.summary()).toEqual(f.before);
	});

	it("checks the listing after an uncertain 5xx without retrying the commit", async () => {
		const f = await fixture(async (request, dispatch) => {
			const response = await dispatch();
			if (new URL(request.url).pathname !== commitPath) return response;
			expect(response.status).toBe(200);
			return new Response(null, { status: 500 });
		});
		expect(await f.run()).toMatchObject({ kind: "removed", evidence: { source: "listing" } });
		expect(f.paths).toEqual([previewPath, commitPath, listPath]);
		expect(f.summary()).toEqual(afterRemoval);
	});

	it("keeps a replacement pairing and a binding pinned to another key", async () => {
		const f = await fixture();
		f.db
			.prepare(
				"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = 'peer'",
			)
			.run(otherKey, fingerprintPublicKey(otherKey));
		f.db
			.prepare(
				"UPDATE identity_devices SET source_fingerprint = ? WHERE device_id = 'remote-alias'",
			)
			.run(fingerprintPublicKey(otherKey));

		expect(await f.run()).toMatchObject({ kind: "removed", localCleanup: { state: "applied" } });
		expect(f.summary()).toEqual({
			peers: ["keep", "peer"],
			cursors: ["keep", "peer"],
			removedBindings: ["local-alias"],
		});
	});
});

it("waits for the shared refresh lane after coordinator proof and runs a fresh pass after cleanup", async () => {
	const f = await fixture();
	const lifecycle = createCoordinatorRefreshLifecycle();
	const running = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const verified = Promise.withResolvers<"verified">();
	const existing = lifecycle.runRefresh(async () => {
		running.resolve();
		await release.promise;
	});
	await running.promise;

	const fresh = vi.fn(async () => {
		expect(f.summary()).toEqual(afterRemoval);
	});
	const hooks = lifecycle.forRemoval(fresh);
	const removal = commitViewerDeviceRemoval(f.confirmed, {
		...f,
		waitForRefresh: () => {
			verified.resolve("verified");
			return hooks.waitForRefresh();
		},
		refresh: hooks.refresh,
	});
	try {
		expect(await Promise.race([verified.promise, removal])).toBe("verified");
		expect(await f.store.getEnrollment("a", "peer", true)).toBeNull();
		expect(f.summary()).toEqual(f.before);
		expect(fresh).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await Promise.all([existing, removal]);
	}
	expect(await removal).toMatchObject({
		kind: "removed",
		evidence: { source: "receipt" },
		localCleanup: { state: "applied" },
		refreshPending: false,
	});
	expect(fresh).toHaveBeenCalledOnce();
});

it("returns verified removal with cleanup deferred when waiting for refresh times out", async () => {
	const f = await fixture();
	const lifecycle = createCoordinatorRefreshLifecycle();
	const release = Promise.withResolvers<void>();
	const waiting = Promise.withResolvers<"waiting">();
	const existing = lifecycle.runRefresh(() => release.promise);
	const fresh = vi.fn(async () => {});
	const hooks = lifecycle.forRemoval(fresh, { queueWaitTimeoutMs: 100 });

	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const removal = commitViewerDeviceRemoval(f.confirmed, {
		...f,
		waitForRefresh: () => {
			const ready = hooks.waitForRefresh();
			waiting.resolve("waiting");
			return ready;
		},
		refresh: hooks.refresh,
	});
	try {
		expect(await Promise.race([waiting.promise, removal])).toBe("waiting");
		await vi.advanceTimersByTimeAsync(100);
		expect(await removal).toMatchObject({
			kind: "removed",
			evidence: { source: "receipt" },
			localCleanup: { state: "deferred" },
			refreshPending: true,
		});
		expect(await f.store.getEnrollment("a", "peer", true)).toBeNull();
		expect(f.summary()).toEqual(f.before);
	} finally {
		release.resolve();
		await Promise.all([existing, removal]);
		vi.useRealTimers();
	}

	await expect(lifecycle.runRefresh(async () => "next refresh")).resolves.toBe("next refresh");
	expect(f.summary()).toEqual(f.before);
	expect(fresh).not.toHaveBeenCalled();
});
