import { describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { removalDeviceKey } from "./coordinator-device-removal-test-harness.js";
import type { RevocationFixture } from "./coordinator-device-revocation-test-harness.js";
import { projectInvite } from "./coordinator-project-revocation-test-harness.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";

const NOW = "2026-10-06T00:00:00.000Z";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const ADMIN_SECRET = "disposable-test-credential";
const GROUP = "removal-api-group";
const DEVICE = "removal-api-device";
/** Every table a refused enrollment writer could have changed. */
const WRITER_TABLES = [
	"enrolled_devices",
	"coordinator_invites",
	"coordinator_join_requests",
	"coordinator_bootstrap_grants",
	"coordinator_device_removals",
];

async function apiFixture(backend: Backend) {
	const { store, db } = setupStore(backend);
	vi.spyOn(store, "close").mockResolvedValue();
	const app = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => ADMIN_SECRET, now: () => NOW },
		requestVerifier: async () => false,
	});
	const key = await removalDeviceKey("removal-api");
	const device = { deviceId: DEVICE, publicKey: key.publicKey, fingerprint: key.fingerprint };
	const invitation: RevocationFixture = {
		store,
		input: { groupId: GROUP, ...device, actorId: "removal-api-operator" },
		exec: async (sql, ...values) => {
			db.prepare(sql).run(...values);
		},
		rows: async (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
	};
	return {
		store,
		db,
		device,
		invitation,
		post: (path: string, body: Record<string, unknown>) =>
			app.request(path, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Codemem-Coordinator-Admin": ADMIN_SECRET,
				},
				body: JSON.stringify(body),
			}),
		snapshot: () =>
			WRITER_TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
		/** Enrolls the device in the group and removes it again through the store. */
		enrollAndRemove: async (deviceId = DEVICE) => {
			await store.createGroup(GROUP);
			await store.enrollDevice(GROUP, { ...device, deviceId });
			expect(await store.removeDevice(GROUP, deviceId)).toBe(true);
		},
		close: () => {
			vi.restoreAllMocks();
			db.close();
		},
	};
}
type ApiFixture = Awaited<ReturnType<typeof apiFixture>>;
type Request = { path: string; body: Record<string, unknown> };

const deviceBody = (f: ApiFixture) => ({
	device_id: f.device.deviceId,
	public_key: f.device.publicKey,
	fingerprint: f.device.fingerprint,
});
const joinBody = (f: ApiFixture, token: string) => ({ token, ...deviceBody(f) });

/** Each enrollment writer family, arranged so that its request is from a removed device. */
const REMOVED_DEVICE_REQUESTS: Record<string, (f: ApiFixture) => Promise<Request>> = {
	"an admin enrollment": async (f) => {
		await f.enrollAndRemove();
		return { path: "/v1/admin/devices", body: { group_id: GROUP, ...deviceBody(f) } };
	},
	"a join through an enrollment-only invitation": async (f) => {
		await f.enrollAndRemove();
		const invite = await f.store.createInvite({
			groupId: GROUP,
			policy: "auto_admit",
			expiresAt: EXPIRES_AT,
		});
		return { path: "/v1/join", body: joinBody(f, invite.token) };
	},
	"a join approval": async (f) => {
		await f.enrollAndRemove();
		const invite = await f.store.createInvite({
			groupId: GROUP,
			policy: "approval_required",
			expiresAt: EXPIRES_AT,
		});
		const request = await f.store.createJoinRequest({
			groupId: GROUP,
			...f.device,
			token: invite.token,
		});
		return { path: "/v1/admin/join-requests/approve", body: { request_id: request.request_id } };
	},
	"a team invitation acceptance": async (f) => {
		const { input } = await recipientInvite(f.invitation, "team_member");
		await f.enrollAndRemove();
		return {
			path: "/v1/join",
			body: {
				...joinBody(f, input.token),
				invite_kind: input.inviteKind,
				identity_id: input.identityId,
				recipient_display_name: "Recipient",
				device_display_name: "Recipient device",
			},
		};
	},
	"a Project invitation acceptance": async (f) => {
		const { input } = await projectInvite(f.invitation);
		await f.enrollAndRemove();
		return {
			path: "/v1/join",
			body: {
				...joinBody(f, input.token),
				operation_id: input.operationId,
				recipient_actor_id: input.recipientActorId,
				recipient_display_name: "Recipient",
				device_display_name: "Recipient device",
			},
		};
	},
	"enabling an enrollment whose key was removed from the group": async (f) => {
		// The same key under two device IDs. One is disabled, and the other is removed.
		await f.store.createGroup(GROUP);
		await f.store.enrollDevice(GROUP, f.device);
		await f.store.setDeviceEnabled(GROUP, DEVICE, false);
		await f.enrollAndRemove(`${DEVICE}-alias`);
		return { path: "/v1/admin/devices/enable", body: { group_id: GROUP, device_id: DEVICE } };
	},
};

describe.each(["SQLite", "D1"] as const)("%s coordinator API for a removed device", (backend) => {
	it.each(Object.keys(REMOVED_DEVICE_REQUESTS))(
		"answers %s with 403 device_removed and writes nothing",
		async (family) => {
			// Arrange
			const f = await apiFixture(backend);
			try {
				const request = await REMOVED_DEVICE_REQUESTS[family]?.(f);
				if (!request) throw new Error("Unknown writer family");
				const before = f.snapshot();
				// Act
				const response = await f.post(request.path, request.body);
				// Assert
				expect({ status: response.status, body: await response.json() }).toEqual({
					status: 403,
					body: { error: "device_removed" },
				});
				expect(f.snapshot()).toEqual(before);
			} finally {
				f.close();
			}
		},
	);

	it("answers a removal with 503 device_removal_unavailable while an enrollment trigger is missing", async () => {
		// Arrange: the state of a D1 database between migrations 0048 and 0049.
		const f = await apiFixture(backend);
		try {
			await f.store.createGroup(GROUP);
			await f.store.enrollDevice(GROUP, f.device);
			f.db.exec("DROP TRIGGER enrolled_devices_removal_delete");
			const before = f.snapshot();
			// Act
			const response = await f.post("/v1/admin/devices/remove", {
				group_id: GROUP,
				device_id: DEVICE,
			});
			// Assert
			expect({ status: response.status, body: await response.json() }).toEqual({
				status: 503,
				body: { error: "device_removal_unavailable" },
			});
			expect(f.snapshot()).toEqual(before);
		} finally {
			f.close();
		}
	});

	it("keeps the replies of a recorded removal and of a device that is not enrolled", async () => {
		// Arrange
		const f = await apiFixture(backend);
		try {
			await f.store.createGroup(GROUP);
			await f.store.enrollDevice(GROUP, f.device);
			const remove = () =>
				f.post("/v1/admin/devices/remove", { group_id: GROUP, device_id: DEVICE });
			// Act
			const removed = await remove();
			const again = await remove();
			// Assert
			expect([removed.status, await removed.json()]).toEqual([200, { ok: true }]);
			expect([again.status, await again.json()]).toEqual([404, { error: "device_not_found" }]);
			expect(f.db.prepare("SELECT device_id FROM coordinator_device_removals").all()).toEqual([
				{ device_id: DEVICE },
			]);
		} finally {
			f.close();
		}
	});

	it("leaves a removal with an unknown outcome as a server error", async () => {
		// Arrange
		const f = await apiFixture(backend);
		try {
			vi.spyOn(f.store, "removeDevice").mockRejectedValue(new Error("device_removal_incomplete"));
			// Act
			const response = await f.post("/v1/admin/devices/remove", {
				group_id: GROUP,
				device_id: DEVICE,
			});
			// Assert
			expect(response.status).toBe(500);
			expect(await response.text()).not.toContain("device_removal");
		} finally {
			f.close();
		}
	});
});
