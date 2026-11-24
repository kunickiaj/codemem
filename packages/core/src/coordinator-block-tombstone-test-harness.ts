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

function operator(f: RevocationFixture, requiredRemovalId?: unknown) {
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
			body: JSON.stringify({
				group_id: f.input.groupId,
				device_id: f.input.deviceId,
				...(requiredRemovalId === undefined ? {} : { required_removal_id: requiredRemovalId }),
				...extra,
			}),
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
	registerPinnedRemovalBlock(test);
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

async function removalId(f: RevocationFixture): Promise<string> {
	const rows = await f.rows("coordinator_device_removals");
	const row = rows[0] as { removal_id: string };
	return row.removal_id;
}

function registerPinnedRemovalBlock(test: ReturnType<typeof revocationHarness>) {
	test("pinned Block requires a removal even while an enrollment exists", async ({
		fixture: f,
	}) => {
		await enrollRevocation(f);
		const pinned = operator(f, "missing-removal");
		await expectRefusal(await pinned.preview(), "revocation_target_unavailable");
		await expectRefusal(
			await pinned.block(await digest(operator(f))),
			"revocation_target_unavailable",
		);
		expect(await f.rows("coordinator_device_revocations")).toEqual([]);
	});

	test("pins both Block actions to the Remove receipt and preserves the default digest bytes", async ({
		fixture: f,
	}) => {
		await enrollRevocation(f);
		await remove(f);
		const id = await removalId(f);
		const legacy = operator(f);
		const legacyDigest = await digest(legacy);
		const preimage = JSON.stringify([
			"codemem-global-device-revocation",
			1,
			"revoke",
			"fixture-coordinator",
			"removal_tombstone",
			f.input.groupId,
			f.input.deviceId,
			f.input.publicKey,
			f.input.fingerprint,
			EXPECTED_KEY_ID,
		]);
		const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage));
		expect(legacyDigest).toBe(
			Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
		);
		const pinned = operator(f, id);
		const pinnedDigest = await digest(pinned);
		expect(pinnedDigest).not.toBe(legacyDigest);
		await expectRefusal(await pinned.block(legacyDigest), "revocation_preview_stale");
		await expectRefusal(await legacy.block(pinnedDigest), "revocation_preview_stale");
		const before = await f.rows("coordinator_device_removals");
		const result = await pinned.block(pinnedDigest);
		expect(result.status).toBe(200);
		expect(await result.json()).toMatchObject({
			state: "revoked",
			revocations: [
				{ subject_kind: "device_id", subject_value: f.input.deviceId },
				{ subject_kind: "ed25519_key", subject_value: EXPECTED_KEY_ID },
			],
		});
		expect(await f.rows("coordinator_device_removals")).toEqual(before);
	});

	registerPinnedRemovalValidation(test);
	registerPinnedRemovalRaces(test);
	registerPinnedRemovalStore(test);
}

function registerPinnedRemovalStore(test: ReturnType<typeof revocationHarness>) {
	test("SQL compares every pinned tuple field without writing either subject", async ({
		fixture: f,
	}) => {
		await enrollRevocation(f);
		await remove(f);
		const input = {
			...f.input,
			evidenceKind: "removal_tombstone" as const,
			requiredRemovalId: await removalId(f),
		};
		for (const changed of [
			{ groupId: "changed-group" },
			{ deviceId: "changed-device" },
			{ publicKey: `${f.input.publicKey} changed` },
			{ fingerprint: "changed-fingerprint" },
			{ requiredRemovalId: "changed-removal" },
		]) {
			expect(await f.store.createDeviceRevocation({ ...input, ...changed })).toEqual({
				kind: "rejected",
				error: "enrollment_mismatch",
			});
		}
		expect(await f.rows("coordinator_device_revocations")).toEqual([]);
	});

	test("storage rejects invalid selectors and enrollment evidence with a selector", async ({
		fixture: f,
	}) => {
		await enrollRevocation(f);
		for (const input of [
			{ ...f.input, requiredRemovalId: "some-removal" },
			{ ...f.input, evidenceKind: "removal_tombstone" as const, requiredRemovalId: "" },
		]) {
			expect(await f.store.createDeviceRevocation(input)).toEqual({
				kind: "rejected",
				error: "invalid_input",
			});
		}
		expect(await f.rows("coordinator_device_revocations")).toEqual([]);
	});
}

function registerPinnedRemovalValidation(test: ReturnType<typeof revocationHarness>) {
	test("does not fall back to a different removal or another group/device", async ({
		fixture: f,
	}) => {
		await enrollRevocation(f);
		await remove(f);
		const id = await removalId(f);
		for (const [input, selector] of [
			[f.input, "different-removal"],
			[{ ...f.input, groupId: "another-group" }, id],
			[{ ...f.input, deviceId: "another-device" }, id],
		] as const) {
			const admin = operator({ ...f, input }, selector);
			await expectRefusal(await admin.preview(), "revocation_target_unavailable");
			await expectRefusal(await admin.block("0".repeat(64)), "revocation_target_unavailable");
		}
		expect(await f.rows("coordinator_device_revocations")).toEqual([]);
	});

	test("rejects malformed opt-in selectors in both actions", async ({ fixture: f }) => {
		await enrollRevocation(f);
		for (const selector of [null, "", 1, {}, [], "bad\0id", "x".repeat(257)]) {
			const admin = operator(f, selector);
			for (const response of [await admin.preview(), await admin.block("0".repeat(64))]) {
				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({ error: "revocation_invalid_input" });
			}
		}
		expect(await f.rows("coordinator_device_revocations")).toEqual([]);
	});
}

function registerPinnedRemovalRaces(test: ReturnType<typeof revocationHarness>) {
	for (const name of ["lift", "replace", "reenroll"] as const) {
		for (const timing of ["before commit reread", "after commit reread"] as const) {
			test(`pinned Block rejects ${name} ${timing} without writing either subject`, async ({
				fixture: f,
			}) => {
				await enrollRevocation(f);
				await remove(f);
				const admin = operator(f, await removalId(f));
				const expectedDigest = await digest(admin);
				const write = f.store.createDeviceRevocation.bind(f.store);
				const intercept = vi.spyOn(f.store, "createDeviceRevocation");
				try {
					if (timing === "before commit reread") await changePinnedRemoval(f, name);
					else
						intercept.mockImplementationOnce(async (tuple) => {
							await changePinnedRemoval(f, name);
							return write(tuple);
						});
					const result = await admin.block(expectedDigest);
					expect(result.status).toBe(409);
					expect(await result.json()).toHaveProperty(
						"error",
						timing === "after commit reread"
							? "revocation_preview_stale"
							: "revocation_target_unavailable",
					);
					expect(await f.rows("coordinator_device_revocations")).toEqual([]);
				} finally {
					intercept.mockRestore();
				}
			});
		}
	}
}

async function changePinnedRemoval(f: RevocationFixture, change: "lift" | "replace" | "reenroll") {
	await liftFixtureTombstone(f);
	if (change === "reenroll") await enrollRevocation(f);
	if (change !== "replace") return;
	// A new active row with identical key evidence must not satisfy the old receipt.
	await f.exec(
		`INSERT INTO coordinator_device_removals
		(removal_id, group_id, device_id, public_key, fingerprint, key_id, removed_at)
		SELECT 'replacement-removal', group_id, device_id, public_key, fingerprint, key_id, removed_at
		FROM coordinator_device_removals WHERE group_id = ? AND device_id = ?`,
		f.input.groupId,
		f.input.deviceId,
	);
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

		await expectRefusal(
			await operator(f, "legacy-evidence").preview(),
			"revocation_target_unavailable",
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
