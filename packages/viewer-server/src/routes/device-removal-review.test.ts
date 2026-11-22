import {
	BetterSqliteCoordinatorStore,
	createCoordinatorApp,
	fingerprintPublicKey,
	type MemoryStore,
	readCoordinatorSyncConfig,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../index.js";

const origin = "https://coordinator.example.test";
const secret = "synthetic-removal-review";
const groupId = "fixture-group";
const deviceId = "fixture-device";
const listing = "/api/sync/devices/removals";
const preview = (id = deviceId) => `/api/sync/devices/${id}/remove/preview`;
const publicKey =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea";

const localDatabases: Database.Database[] = [];

afterEach(() => {
	for (const db of localDatabases.splice(0)) db.close();
	vi.unstubAllGlobals();
});

function viewer(adminSecret = secret, localKey = publicKey.replace("dam", "eam")) {
	const db = new Database(":memory:");
	localDatabases.push(db);
	db.exec("CREATE TABLE sync_device (device_id TEXT, public_key TEXT, fingerprint TEXT)");
	const deviceId = "local-viewer-device";
	db.prepare("INSERT INTO sync_device VALUES (?, ?, ?)").run(
		deviceId,
		localKey,
		fingerprintPublicKey(localKey),
	);
	return createApp({
		readCoordinatorConfig: () => ({
			...readCoordinatorSyncConfig({}),
			syncCoordinatorUrl: origin,
			syncCoordinatorAdminSecret: adminSecret,
		}),
		storeFactory: () => ({ deviceId, db }) as MemoryStore,
	});
}

it("previews a removal and lists the tombstone through the merged coordinator APIs", async () => {
	const store = new BetterSqliteCoordinatorStore(":memory:");
	const close = vi.spyOn(store, "close").mockResolvedValue();
	try {
		await store.createGroup(groupId);
		await store.enrollDevice(groupId, { deviceId, publicKey, fingerprint: "fixture" });
		const coordinator = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => secret, now: () => "2026-11-21T00:00:00.000Z" },
			requestVerifier: () => false,
		});
		const requests = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const request = new Request(input, init);
			expect(new URL(request.url).origin).toBe(origin);
			return coordinator.request(request);
		});
		vi.stubGlobal("fetch", requests);
		const app = viewer();
		const response = await app.request(preview(), { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			device_id: deviceId,
			rejoin: "invitation",
			expected_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
		expect(await store.getEnrollment(groupId, deviceId)).not.toBeNull();
		expect(await store.listDeviceRemovals()).toMatchObject({ items: [] });

		expect(await store.removeDevice(groupId, deviceId)).toBe(true);
		const list = await app.request(listing);
		expect(list.status).toBe(200);
		expect(list.headers.get("Cache-Control")).toBe("no-store");
		expect(await list.json()).toEqual({
			items: [
				{
					group_id: groupId,
					device_id: deviceId,
					display_name: null,
					removal_seq: expect.any(Number),
				},
			],
		});
		expect(requests.mock.calls.map(([url]) => url)).toEqual([
			`${origin}/v1/admin/devices/removal-preview`,
			`${origin}/v1/admin/devices/removals`,
		]);
	} finally {
		close.mockRestore();
		await store.close();
	}
});

it("refuses without an admin secret and refuses a preview of this device without contacting the coordinator", async () => {
	const fetch = vi.fn().mockRejectedValue(new Error("network forbidden"));
	vi.stubGlobal("fetch", fetch);
	const list = await viewer("").request(listing);
	expect(list.status).toBe(409);
	expect(await list.json()).toEqual({ error: "coordinator_admin_required" });
	const own = await viewer().request(preview("local-viewer-device"), { method: "POST" });
	expect(own.status).toBe(400);
	expect(await own.json()).toEqual({ error: "cannot_remove_this_device" });
	const commit = await viewer().request(`/api/sync/devices/${deviceId}/remove`, { method: "POST" });
	expect(commit.status).toBe(404);
	expect(fetch).not.toHaveBeenCalled();
});

it("reports an older coordinator without forwarding its error document or calling a legacy endpoint", async () => {
	const fetch = vi.fn().mockResolvedValue(new Response(secret, { status: 404 }));
	vi.stubGlobal("fetch", fetch);
	const response = await viewer().request(preview(), { method: "POST" });
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: "coordinator_update_required" });
	expect(fetch).toHaveBeenCalledOnce();
});

it("does not fetch removal listings for cross-site requests", async () => {
	const fetch = vi.fn().mockRejectedValue(new Error("network forbidden"));
	vi.stubGlobal("fetch", fetch);
	const response = await viewer().request(listing, {
		headers: { Origin: "https://other.example.test" },
	});
	expect(response.status).toBe(403);
	expect(fetch).not.toHaveBeenCalled();
});

it("refuses a preview whose coordinator expansion includes this device", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			Response.json({
				state: "ready",
				version: 1,
				device_ids: [deviceId],
				key_id: "a".repeat(64),
				rejoin: "invitation",
				expected_digest: "b".repeat(64),
				enrollments: [{ device_id: deviceId }, { device_id: "local-viewer-device" }],
			}),
		),
	);
	const response = await viewer().request(preview(), { method: "POST" });
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ error: "cannot_remove_this_device" });
});

it("refuses a preview for this device's key even when its local ID is absent", async () => {
	const keyId = "6db5e9b8a1bace1cdd9a7c6adb9e9396acc5073465d9fe8e3a0ef6d9c60d6d4f";
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			Response.json({
				state: "ready",
				version: 1,
				device_ids: [deviceId],
				key_id: keyId,
				rejoin: "invitation",
				expected_digest: "b".repeat(64),
				enrollments: [{ device_id: deviceId }],
			}),
		),
	);
	const response = await viewer(secret, publicKey).request(preview(), { method: "POST" });
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ error: "cannot_remove_this_device" });
});

it("refuses to preview when the local device key cannot be verified", async () => {
	const fetch = vi.fn().mockRejectedValue(new Error("network forbidden"));
	vi.stubGlobal("fetch", fetch);
	const response = await viewer(secret, "unrecognized fixture key").request(preview(), {
		method: "POST",
	});
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "local_identity_unverified" });
	expect(fetch).not.toHaveBeenCalled();
});
