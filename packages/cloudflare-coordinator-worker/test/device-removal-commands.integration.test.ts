import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createCoordinatorApp } from "../../core/src/coordinator-api.js";
import { removalDeviceKey } from "../../core/src/coordinator-device-removal-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

it("requires a fresh preview before committing removal of all same-key enrollments in native D1", async () => {
	const db = env.COORDINATOR_DB;
	const store = new D1CoordinatorStore(db);
	const groupId = "command-fixture-group";
	const deviceId = "command-fixture-device";
	const aliasId = "command-fixture-alias";
	const key = await removalDeviceKey("removal-command-native");
	await store.createGroup(groupId);
	await store.enrollDevice(groupId, { ...key, deviceId });
	const secret = "native-removal-command-secret";
	const app = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => secret, now: () => "2026-11-20T00:00:00.000Z" },
		requestVerifier: () => false,
		requestRateLimit: { mutationLimit: 4 },
	});
	const post = (path: string, body: object) =>
		app.request(`/v1/admin/devices/${path}`, {
			method: "POST",
			headers: { "X-Codemem-Coordinator-Admin": secret },
			body: JSON.stringify(body),
		});
	const preview = async () => {
		const response = await post("removal-preview", { device_ids: [deviceId] });
		expect(response.status).toBe(200);
		return response.json<{ expected_digest: string }>();
	};
	const commit = (expected_digest: string) =>
		post("removal", { device_ids: [deviceId], expected_digest });
	const first = await preview();
	await store.enrollDevice(groupId, { ...key, deviceId: aliasId });
	const stale = await commit(first.expected_digest);
	expect(stale.status).toBe(409);
	expect(await stale.json()).toEqual({ error: "removal_preview_stale" });
	expect((await store.listDeviceRemovals({ deviceId })).items).toEqual([]);
	expect(await store.getEnrollment(groupId, deviceId)).not.toBeNull();
	const latest = await preview();
	const response = await commit(latest.expected_digest);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		state: "removed",
		version: 1,
		removals: expect.arrayContaining([{ group_id: groupId, device_id: aliasId, removal_seq: expect.any(Number) }]),
	});
	expect(await store.getEnrollment(groupId, deviceId)).toBeNull();
	expect(await store.getEnrollment(groupId, aliasId)).toBeNull();
	expect((await commit(latest.expected_digest)).status).toBe(429);
});
