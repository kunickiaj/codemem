import { expect } from "vitest";
import {
	type Enrollment,
	enroll,
	legacyInsert,
	opaqueKey,
	type RemovalFixture,
	type RemovalTest,
	removalDeviceKey,
	target,
} from "./coordinator-device-removal-test-harness.js";
import { changeEnrollmentKey, seedEnrollment } from "./coordinator-enrollment-test-fixtures.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/**
 * The removal preview: which enrollments one removal request would delete, the
 * refusals, and the digest that a commit must present. Numbers in test names are
 * entries of groups A and D in the removal test plan. The fixtures are those of
 * the removal harness, and a preview writes nothing.
 */
export function registerDeviceRemovalPreviewContract(test: RemovalTest) {
	registerPreviewTargets(test);
	registerPreviewSharedKeys(test);
	registerPreviewRefusals(test);
	registerPreviewSize(test);
	registerPreviewAvailability(test);
	registerPreviewDigest(test);
	registerPreviewRejoin(test);
}

const preview = (f: RemovalFixture, ...deviceIds: string[]) =>
	f.store.previewDeviceRemoval({ deviceIds });

/** The store's fixed error, or the result. */
const outcome = (pending: Promise<unknown>) => pending.catch((error: Error) => error.message);

function seed(f: RemovalFixture, enrollment: Enrollment, extra: { displayName?: string } = {}) {
	return seedEnrollment(f.exec, {
		groupId: enrollment.groupId,
		deviceId: enrollment.deviceId,
		publicKey: enrollment.key.publicKey,
		fingerprint: enrollment.key.fingerprint,
		...extra,
	});
}

function before(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * The digest as the contract describes it, computed here without the store: an
 * action and version domain, the sorted device IDs, and each enrollment tuple
 * with its canonical key ID, sorted by group and device.
 */
async function documentedDigest(deviceIds: string[], keyId: string | null, targets: Enrollment[]) {
	const tuples = targets
		.map(({ groupId, deviceId, key }) => [
			groupId,
			deviceId,
			key.publicKey,
			key.fingerprint,
			key.keyId || null,
		])
		.sort((a, b) => before(String(a[0]), String(b[0])) || before(String(a[1]), String(b[1])));
	const text = JSON.stringify([
		"codemem-device-removal",
		1,
		"remove",
		[...deviceIds].sort(before),
		keyId,
		tuples,
	]);
	const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const entry = (enrollment: Enrollment, extra: Record<string, unknown> = {}) => ({
	group_id: enrollment.groupId,
	device_id: enrollment.deviceId,
	fingerprint: enrollment.key.fingerprint,
	display_name: null,
	identity_id: null,
	...extra,
});

function stored(f: RemovalFixture) {
	return Promise.all([
		f.rows("SELECT * FROM enrolled_devices WHERE device_id LIKE ? ORDER BY rowid", `${f.prefix}%`),
		f.rows("SELECT * FROM coordinator_device_removals WHERE device_id LIKE ?", `${f.prefix}%`),
	]);
}

function registerPreviewTargets(test: RemovalTest) {
	test("A1 A7 a preview lists every enrollment of the device, disabled or in an archived group, without its key", async ({
		fixture: f,
	}) => {
		// Arrange
		const first = await target(f);
		const second = { ...first, groupId: `${f.prefix}-g2` };
		await f.store.createGroup(second.groupId);
		await seedEnrollment(f.exec, {
			groupId: first.groupId,
			deviceId: first.deviceId,
			publicKey: first.key.publicKey,
			fingerprint: first.key.fingerprint,
			displayName: "Work laptop",
			identityId: "identity-a",
		});
		await seed(f, second);
		await f.store.setDeviceEnabled(second.groupId, second.deviceId, false);
		await f.store.archiveGroup(second.groupId);
		const rows = await stored(f);
		// Act
		const result = await preview(f, first.deviceId);
		// Assert
		expect(result).toEqual({
			kind: "ready",
			device_ids: [first.deviceId],
			key_id: first.key.keyId,
			enrollments: [
				entry(first, { display_name: "Work laptop", identity_id: "identity-a" }),
				entry(second),
			],
			rejoin: "invitation",
			expected_digest: await documentedDigest([first.deviceId], first.key.keyId, [first, second]),
		});
		expect(await stored(f)).toEqual(rows);
		expect(rows[1]).toEqual([]);
	});

	test("A14 a preview adds an enrollment of the key under a device ID the request did not name, whatever its key text", async ({
		fixture: f,
	}) => {
		// Arrange: the alias holds the key with a comment, and a second key of its own elsewhere.
		const named = await target(f);
		const recommented = `${named.key.publicKey} another-comment`;
		const alias = {
			groupId: `${f.prefix}-g2`,
			deviceId: `${f.prefix}-alias`,
			key: { ...named.key, publicKey: recommented, fingerprint: fingerprintPublicKey(recommented) },
		};
		const aliasOtherKey = { ...(await target(f, "alias", "g3")) };
		const bystander = await target(f, "bystander");
		for (const enrollment of [named, alias, aliasOtherKey, bystander]) await seed(f, enrollment);
		// Act
		const result = await preview(f, named.deviceId);
		// Assert: the request is echoed, and the enrollments show the device ID it gained.
		expect(result).toEqual({
			kind: "ready",
			device_ids: [named.deviceId],
			key_id: named.key.keyId,
			enrollments: [entry(named), entry(alias)],
			rejoin: "invitation",
			expected_digest: await documentedDigest([named.deviceId], named.key.keyId, [named, alias]),
		});
	});
}

function registerPreviewSharedKeys(test: RemovalTest) {
	test("A2 a preview of two device IDs that share a key lists both, and an opaque key is not expanded by its text", async ({
		fixture: f,
	}) => {
		// Arrange
		const first = await target(f, "d1");
		const second = { ...first, deviceId: `${f.prefix}-d2` };
		const opaque = { ...(await target(f, "opaque")), key: opaqueKey(`${f.prefix}-shared`) };
		const sameText = { ...opaque, deviceId: `${f.prefix}-same-text` };
		for (const enrollment of [first, second, opaque, sameText]) await seed(f, enrollment);
		// Act: the request names the IDs out of order, one of them twice, and one that is not enrolled.
		const unknown = `${f.prefix}-unknown`;
		const shared = await preview(f, second.deviceId, unknown, first.deviceId, second.deviceId);
		const byText = await preview(f, opaque.deviceId);
		// Assert
		expect(shared).toMatchObject({
			kind: "ready",
			device_ids: [first.deviceId, second.deviceId, unknown],
			key_id: first.key.keyId,
			enrollments: [entry(first), entry(second)],
		});
		expect(byText).toEqual({
			kind: "ready",
			device_ids: [opaque.deviceId],
			key_id: null,
			enrollments: [entry(opaque)],
			rejoin: "invitation",
			expected_digest: await documentedDigest([opaque.deviceId], null, [opaque]),
		});
	});
}

function registerPreviewRefusals(test: RemovalTest) {
	test("D3 a preview of device IDs without an enrollment is refused with removal_target_not_enrolled", async ({
		fixture: f,
	}) => {
		// Arrange: another device is enrolled.
		await seed(f, await target(f, "bystander"));
		// Act
		const result = await preview(f, `${f.prefix}-unknown`, `${f.prefix}-also-unknown`);
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "removal_target_not_enrolled" });
	});

	for (const conflict of [
		"two canonical keys",
		"differing opaque key text",
		"a canonical key and an opaque key",
	] as const) {
		test(`A2 D3 a preview whose named enrollments carry ${conflict} is refused with removal_target_conflict`, async ({
			fixture: f,
		}) => {
			// Arrange: the second enrollment is the same device ID in another group, or another device ID.
			const first = await target(f, "d1");
			const others: Record<typeof conflict, Enrollment> = {
				"two canonical keys": await target(f, "d2"),
				"differing opaque key text": {
					...(await target(f, "d2")),
					key: opaqueKey(`${f.prefix}-b`),
				},
				"a canonical key and an opaque key": {
					...first,
					groupId: `${f.prefix}-g2`,
					key: opaqueKey(`${f.prefix}-b`),
				},
			};
			const other = others[conflict];
			const opaqueFirst = { ...first, key: opaqueKey(`${f.prefix}-a`) };
			await seed(f, conflict === "differing opaque key text" ? opaqueFirst : first);
			await seed(f, other);
			const rows = await stored(f);
			// Act
			const result = await preview(f, first.deviceId, other.deviceId);
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "removal_target_conflict" });
			expect(await stored(f)).toEqual(rows);
		});
	}

	test("a preview refuses a request that is not one to eight device IDs with invalid_input", async ({
		fixture: f,
	}) => {
		// Arrange
		const ids = Array.from({ length: 9 }, (_, index) => `${f.prefix}-d${index}`);
		const requests: unknown[] = [[], ids, [" padded "], ["control\u0000character"], [7], "d1"];
		// Act
		const refused = await Promise.all(
			requests.map((deviceIds) =>
				outcome(f.store.previewDeviceRemoval({ deviceIds: deviceIds as string[] })),
			),
		);
		const eight = await preview(f, ...ids.slice(0, 8));
		// Assert
		expect(refused).toEqual(requests.map(() => "invalid_input"));
		expect(eight).toEqual({ kind: "rejected", error: "removal_target_not_enrolled" });
	});
}

function registerPreviewSize(test: RemovalTest) {
	test("D3 a preview of 50 enrollments is ready, and a 51st that the key adds makes it removal_target_too_large", async ({
		fixture: f,
	}) => {
		// Arrange: one device ID in 50 groups.
		const device = await target(f);
		for (let index = 0; index < 50; index += 1)
			await seed(f, { ...device, groupId: `${f.prefix}-g${String(index).padStart(2, "0")}` });
		// Act
		const fifty = await preview(f, device.deviceId);
		await seed(f, { ...device, deviceId: `${f.prefix}-alias` });
		const fiftyOne = await preview(f, device.deviceId);
		// Assert
		expect(fifty).toMatchObject({ kind: "ready" });
		expect(fifty.kind === "ready" && fifty.enrollments).toHaveLength(50);
		expect(fiftyOne).toEqual({ kind: "rejected", error: "removal_target_too_large" });
	});

	test("a preview whose enrollment tuples exceed 1 MB as UTF-8 is refused with removal_target_too_large", async ({
		fixture: f,
	}) => {
		// Arrange: 260,000 two-byte characters. Two such tuples are under 1 MB as characters and over it as bytes.
		const device = { ...(await target(f)), key: opaqueKey("é".repeat(260_000)) };
		await seed(f, device);
		// Act
		const one = await preview(f, device.deviceId);
		await seed(f, { ...device, groupId: `${f.prefix}-g2` });
		const two = await preview(f, device.deviceId);
		// Assert
		expect(one).toMatchObject({ kind: "ready", key_id: null });
		expect(two).toEqual({ kind: "rejected", error: "removal_target_too_large" });
	});
}

function registerPreviewAvailability(test: RemovalTest) {
	test("A16 a preview is unavailable while any enrollment has no key ID, whether or not the device is enrolled", async ({
		fixture: f,
	}) => {
		// Arrange: another enrollment as an older release wrote it.
		const device = await target(f);
		await enroll(f, device);
		await legacyInsert(f, await target(f, "unfilled"));
		// Act
		const enrolled = await outcome(preview(f, device.deviceId));
		const unknown = await outcome(preview(f, `${f.prefix}-unknown`));
		await f.store.fillEnrollmentKeyIds();
		const filled = await preview(f, device.deviceId);
		// Assert
		expect([enrolled, unknown]).toEqual([
			"device_removal_unavailable",
			"device_removal_unavailable",
		]);
		expect(filled).toMatchObject({ kind: "ready" });
	});
}

function registerPreviewDigest(test: RemovalTest) {
	test("A5 A15 the preview digest changes with the request and each tuple, and not with a label or the enabled state", async ({
		fixture: f,
	}) => {
		// Arrange
		const device = await target(f);
		const other = `${f.prefix}-other`;
		await f.store.createGroup(device.groupId);
		await seed(f, device, { displayName: "Before" });
		const digest = async (...deviceIds: string[]) => {
			const result = await preview(f, ...deviceIds);
			if (result.kind !== "ready") throw new Error(`Unexpected ${result.error}`);
			return result.expected_digest;
		};
		const where = [device.groupId, device.deviceId] as const;
		// Act: the same set read again, then one change at a time.
		const first = await digest(device.deviceId);
		const repeated = await digest(device.deviceId, device.deviceId);
		await f.exec(
			"UPDATE enrolled_devices SET display_name = 'After' WHERE group_id = ? AND device_id = ?",
			...where,
		);
		await f.store.setDeviceEnabled(device.groupId, device.deviceId, false);
		const relabelled = await digest(device.deviceId);
		const changed = [await digest(device.deviceId, other)];
		await f.exec(
			"UPDATE enrolled_devices SET fingerprint = 'another' WHERE group_id = ? AND device_id = ?",
			...where,
		);
		changed.push(await digest(device.deviceId));
		await changeEnrollmentKey(
			f.exec,
			{ publicKey: `${device.key.publicKey} comment`, fingerprint: null },
			"group_id = ? AND device_id = ?",
			...where,
		);
		changed.push(await digest(device.deviceId));
		await seed(f, { ...device, deviceId: other });
		changed.push(await digest(device.deviceId));
		await seed(f, { ...device, groupId: `${f.prefix}-g2` });
		changed.push(await digest(device.deviceId));
		// Assert
		expect([repeated, relabelled]).toEqual([first, first]);
		expect(new Set([first, ...changed]).size).toBe(changed.length + 1);
		expect(first).toMatch(/^[a-f0-9]{64}$/u);
	});
}

function insertBinding(f: RemovalFixture, binding: { deviceId: string; keyId: string }) {
	return f.exec(
		`INSERT INTO coordinator_device_ownership_bindings(device_id, key_id, identity_id,
			coordinator_id, binding_id, provenance, source_ref, bound_at)
		VALUES (?, ?, 'identity-a', 'coordinator-a', ?, 'owner_enrollment', 'fixture', '2026-11-17T00:00:00.000Z')`,
		binding.deviceId,
		binding.keyId,
		`${binding.deviceId}-binding`,
	);
}

function registerPreviewRejoin(test: RemovalTest) {
	test("D4 a preview advises invitation for a device without an ownership binding and none for one that has a binding", async ({
		fixture: f,
	}) => {
		// Arrange: three devices, and bindings by device ID, by key, and for an unrelated device.
		const unbound = await target(f, "unbound");
		const boundById = await target(f, "bound-by-id");
		const boundByKey = await target(f, "bound-by-key");
		for (const enrollment of [unbound, boundById, boundByKey]) await seed(f, enrollment);
		const unrelated = await removalDeviceKey(`${f.prefix}-unrelated`);
		const spare = await removalDeviceKey(`${f.prefix}-spare`);
		await insertBinding(f, { deviceId: `${f.prefix}-unrelated`, keyId: unrelated.keyId });
		await insertBinding(f, { deviceId: boundById.deviceId, keyId: spare.keyId });
		await insertBinding(f, { deviceId: `${f.prefix}-owner`, keyId: boundByKey.key.keyId });
		// Act
		const advice = [];
		for (const { deviceId } of [unbound, boundById, boundByKey])
			advice.push(await preview(f, deviceId));
		// Assert: sign_in is not advised before the sign-in rejoin exists.
		expect(advice.map((result) => result.kind === "ready" && result.rejoin)).toEqual([
			"invitation",
			"none",
			"none",
		]);
	});
}
