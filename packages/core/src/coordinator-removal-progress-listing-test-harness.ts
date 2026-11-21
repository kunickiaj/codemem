import { expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import type { PeerRemovalApiFixture } from "./coordinator-peer-removal-api-test-harness.js";

const ADMIN_SECRET = "fixture-listing-secret";

async function seedProgress({ store, prefix, exec }: PeerRemovalApiFixture) {
	const groupId = `${prefix}-progress`;
	await store.createGroup(groupId);
	const devices = [
		{ deviceId: "requester" },
		{ deviceId: "offline", sequence: 42 },
		{ deviceId: "reset", sequence: 0 },
		{ deviceId: "legacy" },
		{ deviceId: "malformed", sequence: "42" },
	];
	for (const { deviceId, sequence } of devices) {
		await store.enrollDevice(groupId, {
			deviceId,
			publicKey: `fixture-key-${deviceId}`,
			fingerprint: `fixture-fingerprint-${deviceId}`,
		});
		if (deviceId === "requester") continue;
		await store.upsertPresence({
			groupId,
			deviceId,
			addresses: [],
			ttlS: 300,
			capabilities: {
				...(sequence === undefined ? {} : { applied_removal_seq: sequence }),
				sync_features: ["peer_removal_check"],
				private_fixture_field: "not for the admin listing",
			},
		});
	}
	await exec(
		"UPDATE presence_records SET expires_at = ? WHERE group_id = ? AND device_id = 'offline'",
		"2000-01-01T00:00:00.000Z",
		groupId,
	);
	return groupId;
}

async function listedDevices(
	app: ReturnType<typeof createCoordinatorApp>,
	path: string,
	headers: Record<string, string>,
) {
	const response = await app.request(path, { headers });
	expect(response.status).toBe(200);
	const { items } = (await response.json()) as { items: { device_id: string }[] };
	return Object.fromEntries(items.map((item) => [item.device_id, item]));
}

export async function expectRemovalProgressListings(fixture: PeerRemovalApiFixture) {
	const groupId = await seedProgress(fixture);
	const close = vi.spyOn(fixture.store, "close").mockResolvedValue();
	const app = createCoordinatorApp({
		storeFactory: () => fixture.store,
		runtime: { adminSecret: () => ADMIN_SECRET, now: () => new Date().toISOString() },
		requestVerifier: () => true,
	});
	try {
		await expectPeerProgress(app, groupId);
		await expectAdminProgress(app, groupId);
	} finally {
		close.mockRestore();
	}
}

async function expectPeerProgress(app: ReturnType<typeof createCoordinatorApp>, groupId: string) {
	const peers = await listedDevices(app, `/v1/peers?group_id=${groupId}`, {
		"X-Opencode-Device": "requester",
		"X-Opencode-Timestamp": "fixture-timestamp",
		"X-Opencode-Nonce": "fixture-nonce",
		"X-Opencode-Signature": "fixture-signature",
	});
	expect(peers.offline).toMatchObject({ stale: true, capabilities: { applied_removal_seq: 42 } });
	expect(peers.reset).toMatchObject({ capabilities: { applied_removal_seq: 0 } });
	expect(peers.legacy).not.toHaveProperty("capabilities.applied_removal_seq");
}

async function expectAdminProgress(app: ReturnType<typeof createCoordinatorApp>, groupId: string) {
	const admin = await listedDevices(app, `/v1/admin/devices?group_id=${groupId}`, {
		"X-Codemem-Coordinator-Admin": ADMIN_SECRET,
	});
	expect(admin.offline).toMatchObject({ presence_capabilities: { applied_removal_seq: 42 } });
	expect(admin.reset).toMatchObject({ presence_capabilities: { applied_removal_seq: 0 } });
	expect(admin.legacy).not.toHaveProperty("presence_capabilities.applied_removal_seq");
	expect(admin.malformed).not.toHaveProperty("presence_capabilities.applied_removal_seq");
	expect(admin.offline).not.toHaveProperty("presence_capabilities.private_fixture_field");
}
