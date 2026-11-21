import { expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { removalDeviceKey } from "./coordinator-device-removal-test-harness.js";
import {
	enrollRevocation,
	type RevocationFixture,
	type revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { EXPECTED_KEY_ID } from "./coordinator-ed25519-key-id-test-fixtures.js";

const ADMIN_SECRET = "block-tombstone-fixture";

function operator(f: RevocationFixture) {
	const app = createCoordinatorApp({
		storeFactory: () => f.store,
		runtime: { adminSecret: () => ADMIN_SECRET, now: () => "2026-11-20T00:00:00.000Z" },
		requestVerifier: () => false,
		deviceRevocation: { coordinatorId: "fixture-coordinator" },
	});
	const post = (endpoint: string, extra?: { expected_digest: string }) =>
		app.request(`/v1/admin/devices/${endpoint}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": ADMIN_SECRET,
			},
			body: JSON.stringify({ group_id: f.input.groupId, device_id: f.input.deviceId, ...extra }),
		});
	return {
		preview: () => post("revoke-preview"),
		block: (expected_digest: string) => post("revoke", { expected_digest }),
	};
}

type Operator = ReturnType<typeof operator>;

async function digest(operator: Operator) {
	const preview = await operator.preview();
	expect(preview.status).toBe(200);
	const body = await preview.json();
	if (!body || typeof body !== "object" || !("expected_digest" in body))
		throw new Error("Missing fixture preview digest");
	expect(body).not.toHaveProperty("public_key");
	const value = body.expected_digest;
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
		throw new Error("Invalid fixture preview digest");
	return value;
}

async function remove(f: RevocationFixture) {
	expect(await f.store.removeDevice(f.input.groupId, f.input.deviceId)).toBe(true);
}

function liftFixtureTombstone(f: RevocationFixture) {
	return f.exec(
		`UPDATE coordinator_device_removals SET lifted_at = '2026-11-20T01:00:00.000Z',
		 lifted_by_invite_id = 'fixture-invite' WHERE group_id = ? AND device_id = ?`,
		f.input.groupId,
		f.input.deviceId,
	);
}

async function expectRefusal(response: Response, error: string) {
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error });
}

export function registerBlockTombstoneContract(test: ReturnType<typeof revocationHarness>) {
	registerBlockEvidenceChanges(test);
	registerBlockEvidenceCompatibility(test);
	test("G1 blocks both global subjects from an active tombstone in the requested group", async ({
		fixture: f,
	}) => {
		await enrollRevocation(f);
		await remove(f);
		const before = await f.rows("coordinator_device_removals");
		const admin = operator(f);
		const expectedDigest = await digest(admin);
		expect(await f.store.listDeviceRevocations(f.input)).toEqual([]);
		const response = await admin.block(expectedDigest);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			state: "revoked",
			revocations: [
				{ subject_kind: "device_id", subject_value: f.input.deviceId },
				{ subject_kind: "ed25519_key", subject_value: EXPECTED_KEY_ID },
			],
		});
		expect(await f.rows("coordinator_device_removals")).toEqual(before);
		expect(await f.store.getEnrollment(f.input.groupId, f.input.deviceId, true)).toBeNull();
	});
}

function registerBlockEvidenceChanges(test: ReturnType<typeof revocationHarness>) {
	test("G2 the same tuple after removal needs a fresh digest", async ({ fixture: f }) => {
		await enrollRevocation(f);
		const admin = operator(f);
		const enrollmentDigest = await digest(admin);
		await remove(f);

		await expectRefusal(await admin.block(enrollmentDigest), "revocation_preview_stale");
		expect(await digest(admin)).not.toBe(enrollmentDigest);
		expect(await f.store.listDeviceRevocations(f.input)).toEqual([]);
	});

	test("G3 a lifted tombstone without an enrollment is unavailable", async ({ fixture: f }) => {
		await enrollRevocation(f);
		await remove(f);
		const admin = operator(f);
		const expectedDigest = await digest(admin);
		await liftFixtureTombstone(f);

		await expectRefusal(await admin.preview(), "revocation_target_unavailable");
		await expectRefusal(await admin.block(expectedDigest), "revocation_target_unavailable");
		expect(await f.store.listDeviceRevocations(f.input)).toEqual([]);
	});

	test("refuses stale tombstone evidence if it was lifted after rereading, even with the same enrollment tuple", async ({
		fixture: f,
	}) => {
		await enrollRevocation(f);
		await remove(f);
		const admin = operator(f);
		const expectedDigest = await digest(admin);
		const write = f.store.createDeviceRevocation.bind(f.store);
		const intercept = vi
			.spyOn(f.store, "createDeviceRevocation")
			.mockImplementationOnce(async (tuple) => {
				await liftFixtureTombstone(f);
				await enrollRevocation(f);
				return write(tuple);
			});
		try {
			await expectRefusal(await admin.block(expectedDigest), "revocation_preview_stale");
			expect(intercept).toHaveBeenCalledOnce();
			expect(await f.store.listDeviceRevocations(f.input)).toEqual([]);
		} finally {
			intercept.mockRestore();
		}
	});
}

function registerBlockEvidenceCompatibility(test: ReturnType<typeof revocationHarness>) {
	test("a requested-group enrollment takes precedence over an active tombstone", async ({
		fixture: f,
	}) => {
		await enrollRevocation(f);
		await remove(f);
		const admin = operator(f);
		const tombstoneDigest = await digest(admin);
		// A mixed legacy state: the current enrollment supplies a different key.
		const replacement = await removalDeviceKey("block-current-enrollment");
		await liftFixtureTombstone(f);
		await f.store.enrollDevice(f.input.groupId, { ...f.input, ...replacement });
		await f.exec(
			`INSERT INTO coordinator_device_removals(removal_id, group_id, device_id,
			 public_key, fingerprint, key_id, removed_at)
			 VALUES ('legacy-evidence', ?, ?, ?, ?, ?, '2026-11-20T02:00:00.000Z')`,
			f.input.groupId,
			f.input.deviceId,
			f.input.publicKey,
			f.input.fingerprint,
			EXPECTED_KEY_ID,
		);

		await expectRefusal(await admin.block(tombstoneDigest), "revocation_preview_stale");
		const response = await admin.block(await digest(admin));
		expect(response.status).toBe(200);
		expect(await f.store.listDeviceRevocations({ publicKey: replacement.publicKey })).toMatchObject(
			[{ subject_kind: "ed25519_key", subject_value: replacement.keyId }],
		);
		expect(await f.store.listDeviceRevocations({ publicKey: f.input.publicKey })).toEqual([]);
	});

	test("an opaque tombstone cannot be used to block a device", async ({ fixture: f }) => {
		await f.store.createGroup(f.input.groupId);
		await f.store.enrollDevice(f.input.groupId, { ...f.input, publicKey: "opaque-fixture-key" });
		await remove(f);
		await expectRefusal(await operator(f).preview(), "revocation_target_unavailable");
		expect(await f.store.listDeviceRevocations(f.input)).toEqual([]);
	});

	test("a tombstone in another group is not evidence for the requested group", async ({
		fixture: f,
	}) => {
		await enrollRevocation(f);
		await remove(f);
		const other = { ...f, input: { ...f.input, groupId: "other-fixture-group" } };
		await expectRefusal(await operator(other).preview(), "revocation_target_unavailable");
		expect(await f.store.listDeviceRevocations(f.input)).toEqual([]);
	});

	test("an enrolled device can still be blocked before tombstone storage is installed", async ({
		fixture: f,
	}) => {
		await enrollRevocation(f);
		await f.exec("DROP TABLE coordinator_device_removals");
		const admin = operator(f);
		const unknown = operator({ ...f, input: { ...f.input, deviceId: "not-enrolled" } });
		await expectRefusal(await unknown.preview(), "revocation_target_unavailable");
		expect((await admin.block(await digest(admin))).status).toBe(200);
	});
}
