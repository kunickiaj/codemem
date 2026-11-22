import { expect, it, vi } from "vitest";
import { createCoordinatorApp } from "../../../core/src/coordinator-api.js";
import { setupStore } from "../../../core/src/coordinator-auth-store-test-fixtures.js";
import { removalDeviceKey } from "../../../core/src/coordinator-device-removal-test-harness.js";

const adminSecret = "synthetic-block-lifecycle-admin";
const groupId = "block-lifecycle-group";
const deviceId = "block-lifecycle-device";
const blockTarget = { group_id: groupId, device_id: deviceId };
const removalTarget = { device_ids: [deviceId] };
const blockPreview = "/v1/admin/devices/revoke-preview";
const blockCommit = "/v1/admin/devices/revoke";

async function previewDigest(response: Response) {
	expect(response.status).toBe(200);
	const body = await response.json<{ expected_digest: string }>();
	expect(body.expected_digest).toMatch(/^[a-f0-9]{64}$/u);
	expect(body).not.toHaveProperty("public_key");
	return body.expected_digest;
}

async function expectRefusal(response: Response, status: number, error: string) {
	expect(response.status).toBe(status);
	expect(await response.json()).toEqual({ error });
}

it("requires a fresh Block review after guarded Remove and keeps join and enable admission revoked", async () => {
	const { db, store } = setupStore("SQLite");
	// Each real route closes its store. Keep this one in-memory database alive across the ceremony.
	const close = vi.spyOn(store, "close").mockResolvedValue();
	const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	try {
		const key = await removalDeviceKey("block-lifecycle");
		await store.createGroup(groupId);
		await store.enrollDevice(groupId, { deviceId, ...key });
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => adminSecret,
				now: () => "2026-11-21T00:00:00.000Z",
			},
			requestVerifier: () => false,
			deviceRevocation: { coordinatorId: "synthetic-block-coordinator" },
		});
		const post = (path: string, body: unknown, secret = adminSecret) =>
			app.request(path, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(secret ? { "X-Codemem-Coordinator-Admin": secret } : {}),
				},
				body: JSON.stringify(body),
			});
		const snapshot = () =>
			[
				"enrolled_devices",
				"coordinator_device_removals",
				"coordinator_device_revocations",
				"coordinator_invites",
				"coordinator_join_requests",
			].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

		const enrollmentDigest = await previewDigest(await post(blockPreview, blockTarget));
		const removalDigest = await previewDigest(
			await post("/v1/admin/devices/removal-preview", removalTarget),
		);
		const removed = await post("/v1/admin/devices/removal", {
			...removalTarget,
			expected_digest: removalDigest,
		});
		expect(removed.status).toBe(200);
		expect(await removed.json()).toMatchObject({ state: "removed", device_ids: [deviceId] });
		expect(await store.getEnrollment(groupId, deviceId, true)).toBeNull();
		expect(await store.listDeviceRevocations({ deviceId, publicKey: key.publicKey })).toEqual([]);
		const tombstones = db.prepare("SELECT * FROM coordinator_device_removals").all();
		expect(tombstones).toHaveLength(1);

		const invitation = await store.createInvite({
			groupId,
			policy: "auto_admit",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		const beforeBlock = snapshot();
		await expectRefusal(
			await post(blockCommit, { ...blockTarget, expected_digest: enrollmentDigest }),
			409,
			"revocation_preview_stale",
		);
		expect(snapshot()).toEqual(beforeBlock);

		const tombstoneDigest = await previewDigest(await post(blockPreview, blockTarget));
		expect(tombstoneDigest).not.toBe(enrollmentDigest);
		expect(snapshot()).toEqual(beforeBlock);
		for (const [path, body] of [
			[blockPreview, blockTarget],
			[blockCommit, { ...blockTarget, expected_digest: tombstoneDigest }],
		] as const) {
			await expectRefusal(await post(path, body, ""), 401, "unauthorized");
		}
		expect(snapshot()).toEqual(beforeBlock);

		const blocked = await post(blockCommit, {
			...blockTarget,
			expected_digest: tombstoneDigest,
		});
		expect(blocked.status).toBe(200);
		expect(await blocked.json()).toMatchObject({
			state: "revoked",
			revocations: [
				{ subject_kind: "device_id", subject_value: deviceId },
				{ subject_kind: "ed25519_key", subject_value: key.keyId },
			],
		});
		expect(await store.listDeviceRevocations({ deviceId, publicKey: key.publicKey })).toHaveLength(
			2,
		);
		expect(db.prepare("SELECT * FROM coordinator_device_removals").all()).toEqual(tombstones);
		const afterBlock = snapshot();
		await expectRefusal(
			await post(
				"/v1/join",
				{
					token: invitation.token,
					device_id: deviceId,
					public_key: key.publicKey,
					fingerprint: key.fingerprint,
				},
				"",
			),
			403,
			"device_revoked",
		);
		expect(snapshot()).toEqual(afterBlock);
		await expectRefusal(await post("/v1/admin/devices/enable", blockTarget), 403, "device_revoked");
		expect(snapshot()).toEqual(afterBlock);
		expect(await store.getEnrollment(groupId, deviceId, true)).toBeNull();
		expect(network).not.toHaveBeenCalled();
	} finally {
		network.mockRestore();
		close.mockRestore();
		db.close();
	}
});
