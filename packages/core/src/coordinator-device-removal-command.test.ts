import { describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { removalDeviceKey } from "./coordinator-device-removal-test-harness.js";

const PREVIEW = "/v1/admin/devices/removal-preview";
const COMMIT = "/v1/admin/devices/removal";
const ADMIN_SECRET = "synthetic-removal-command-admin";
const DEVICE = "fixture-device";
const DEVICE_IDS = [DEVICE];
const PREVIEW_BODY = { device_ids: DEVICE_IDS };
const COMMIT_BODY = { ...PREVIEW_BODY, expected_digest: "0".repeat(64) };

async function fixture(backend: Backend) {
	const { db, store } = setupStore(backend);
	const close = vi.spyOn(store, "close").mockResolvedValue();
	const storeFactory = vi.fn(() => store);
	const app = createCoordinatorApp({
		storeFactory,
		runtime: { adminSecret: () => ADMIN_SECRET, now: () => "2026-11-20T00:00:00.000Z" },
		requestVerifier: () => false,
		requestRateLimit: { mutationLimit: 12 },
	});
	const key = await removalDeviceKey("removal-command");
	return {
		db,
		store,
		storeFactory,
		close,
		key,
		request: (request: Request) => app.request(request),
		post: (path: string, body: unknown, secret = ADMIN_SECRET) =>
			app.request(path, {
				method: "POST",
				headers: { ...(secret ? { "X-Codemem-Coordinator-Admin": secret } : {}) },
				body: JSON.stringify(body),
			}),
		enroll: async (groupId: string, deviceId = DEVICE, publicKey = key) => {
			await store.createGroup(groupId);
			await store.enrollDevice(groupId, { ...publicKey, deviceId });
		},
		snapshot: () =>
			["enrolled_devices", "coordinator_device_removals"].map((table) =>
				db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
			),
		dispose: () => {
			vi.restoreAllMocks();
			db.close();
		},
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function readyPreview(f: Fixture) {
	const response = await f.post(PREVIEW, PREVIEW_BODY);
	expect(response.status).toBe(200);
	return response.json<{ expected_digest: string }>();
}

async function expectReply(response: Response, status: number, error: string) {
	expect(response.status).toBe(status);
	expect(await response.json()).toEqual({ error });
}

describe.each(["SQLite", "D1"] as const)("%s admin removal commands", (backend) => {
	it("D1/D2 reject unauthorized and malformed requests without opening the store", async () => {
		const f = await fixture(backend);
		try {
			const unauthenticated = new Request(`http://localhost${PREVIEW}`, {
				method: "POST",
				body: "not json",
			});
			await expectReply(await f.request(unauthenticated), 401, "missing_admin_header");
			expect(unauthenticated.bodyUsed).toBe(false);
			await expectReply(await f.post(COMMIT, null, "invalid"), 401, "invalid_admin_secret");
			for (const body of [
				{ ...PREVIEW_BODY, group_id: "extra" },
				{ device_ids: [] },
				{ device_ids: Array(9).fill("test") },
				{ device_ids: [" control"] },
			]) {
				await expectReply(await f.post(PREVIEW, body), 400, "invalid_input");
			}
			for (const body of [
				{ ...COMMIT_BODY, actor_id: "spoofed" },
				PREVIEW_BODY,
				{ ...COMMIT_BODY, expected_digest: "not-a-digest" },
			]) {
				await expectReply(await f.post(COMMIT, body), 400, "invalid_input");
			}
			expect(f.storeFactory).not.toHaveBeenCalled();
		} finally {
			f.dispose();
		}
	});

	it("D3 returns target refusals and writes nothing", async () => {
		const f = await fixture(backend);
		try {
			await expectReply(await f.post(PREVIEW, PREVIEW_BODY), 404, "removal_target_not_enrolled");
			await f.enroll("group-a");
			await f.enroll("group-b", DEVICE, await removalDeviceKey("different-key"));
			const before = f.snapshot();
			await expectReply(await f.post(PREVIEW, PREVIEW_BODY), 409, "removal_target_conflict");
			expect(f.snapshot()).toEqual(before);
		} finally {
			f.dispose();
		}
	});

	it("D4/D7 previews key aliases without writes and commits the exact reviewed set", async () => {
		const f = await fixture(backend);
		try {
			await f.enroll("group-a");
			await f.enroll("group-b", "fixture-alias");
			const before = f.snapshot();
			const { expected_digest, ...preview } = await readyPreview(f);
			const enrollment = {
				fingerprint: f.key.fingerprint,
				display_name: null,
				identity_id: null,
			};
			expect(preview).toEqual({
				state: "ready",
				version: 1,
				device_ids: DEVICE_IDS,
				key_id: f.key.keyId,
				enrollments: [
					{ ...enrollment, group_id: "group-a", device_id: DEVICE },
					{ ...enrollment, group_id: "group-b", device_id: "fixture-alias" },
				],
				rejoin: "invitation",
			});
			expect(expected_digest).toMatch(/^[a-f0-9]{64}$/u);
			expect(f.snapshot()).toEqual(before);
			const response = await f.post(COMMIT, { ...PREVIEW_BODY, expected_digest });
			expect(response.status).toBe(200);
			const receipt = await response.json();
			const [, rows] = f.snapshot();
			expect(receipt).toEqual({
				state: "removed",
				version: 1,
				removal_id: expect.any(String),
				removal_seq: expect.any(Number),
				device_ids: DEVICE_IDS,
				key_id: f.key.keyId,
				removals: [
					{ group_id: "group-a", device_id: DEVICE, removal_seq: expect.any(Number) },
					{ group_id: "group-b", device_id: "fixture-alias", removal_seq: expect.any(Number) },
				],
			});
			expect(rows).toHaveLength(2);
			expect(f.snapshot()[0]).toEqual([]);
			expect(f.close).toHaveBeenCalledTimes(2);
		} finally {
			f.dispose();
		}
	});
});

describe.each(["SQLite", "D1"] as const)("%s guarded removal commit", (backend) => {
	it("D3 refuses a preview that expands to more than 50 same-key enrollments", async () => {
		const f = await fixture(backend);
		try {
			await f.enroll("group-a");
			for (let index = 0; index < 50; index++) await f.enroll("group-a", `alias-${index}`);
			const before = f.snapshot();
			await expectReply(await f.post(PREVIEW, PREVIEW_BODY), 409, "removal_target_too_large");
			expect(f.snapshot()).toEqual(before);
		} finally {
			f.dispose();
		}
	});

	it("refuses a wrong digest or a same-key alias added after preview without any writes", async () => {
		const f = await fixture(backend);
		try {
			await f.enroll("group-a");
			const { expected_digest } = await readyPreview(f);
			const before = f.snapshot();
			await expectReply(await f.post(COMMIT, COMMIT_BODY), 409, "removal_preview_stale");
			expect(f.snapshot()).toEqual(before);
			await f.enroll("group-b", "new-alias");
			const afterAlias = f.snapshot();
			await expectReply(
				await f.post(COMMIT, { ...PREVIEW_BODY, expected_digest }),
				409,
				"removal_preview_stale",
			);
			expect(f.snapshot()).toEqual(afterAlias);
		} finally {
			f.dispose();
		}
	});

	it("D6 returns 503 from both routes when removal storage is unavailable", async () => {
		const f = await fixture(backend);
		try {
			await f.enroll("group-a");
			f.db.exec("DROP TABLE coordinator_device_removals");
			await expectReply(await f.post(PREVIEW, PREVIEW_BODY), 503, "device_removal_unavailable");
			await expectReply(await f.post(COMMIT, COMMIT_BODY), 503, "device_removal_unavailable");
			expect(await f.store.getEnrollment("group-a", DEVICE)).not.toBeNull();
		} finally {
			f.dispose();
		}
	});

	it("reports an incomplete commit as an unknown outcome and closes the store", async () => {
		const f = await fixture(backend);
		const commit = vi.spyOn(f.store, "removeDeviceEnrollments");
		try {
			commit.mockRejectedValueOnce(new Error("device_removal_incomplete"));
			await expectReply(await f.post(COMMIT, COMMIT_BODY), 500, "device_removal_incomplete");
			expect(f.close).toHaveBeenCalledOnce();
		} finally {
			f.dispose();
		}
	});
});
