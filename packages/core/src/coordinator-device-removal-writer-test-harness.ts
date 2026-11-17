import { expect } from "vitest";
import {
	ARRANGED_CREATED_AT,
	ARRANGED_DISPLAY_NAME,
	currentInsert,
	deleteEnrollmentWithoutTombstone,
	type Enrollment,
	enroll,
	enrollments,
	insertDisabledEnrollment,
	insertTombstone,
	opaqueKey,
	type RemovalFixture,
	type RemovalTest,
	removalDeviceKey,
	target,
} from "./coordinator-device-removal-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/**
 * Enrollment writers under the enrollment triggers: what they write when the
 * enrollment changes between their reads and their write, and how they keep
 * `key_id` and the key text. The fixtures are those of the removal harness.
 */
export function registerEnrollmentWriterContract(test: RemovalTest) {
	registerPinnedWriterRaces(test);
	registerKeyTextChanges(test);
	registerKeyTextChangeFailures(test);
	registerSuppressedKeyTextRewrites(test);
}

const JOIN_TRANSITION = ["UPDATE coordinator_join_requests"];
const ENROLLMENT_WRITE = ["INSERT INTO enrolled_devices", "UPDATE enrolled_devices SET public_key"];
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

type Race = "appears" | "disappears";

/** Arranges the state before the operation reads, and the change that follows those reads. */
async function arrangeRace(f: RemovalFixture, race: Race, enrollment: Enrollment) {
	if (race === "appears") return insertDisabledEnrollment(enrollment);
	await enroll(f, enrollment);
	await f.exec(
		`UPDATE enrolled_devices SET display_name = ?, created_at = ?
		WHERE group_id = ? AND device_id = ?`,
		ARRANGED_DISPLAY_NAME,
		ARRANGED_CREATED_AT,
		enrollment.groupId,
		enrollment.deviceId,
	);
	return deleteEnrollmentWithoutTombstone(enrollment);
}

function enrollmentRow(f: RemovalFixture, enrollment: Enrollment) {
	return f.rows(
		`SELECT public_key, fingerprint, key_id, identity_id, enabled, created_at
		FROM enrolled_devices WHERE group_id = ? AND device_id = ?`,
		enrollment.groupId,
		enrollment.deviceId,
	);
}

function registerPinnedWriterRaces(test: RemovalTest) {
	for (const race of ["appears", "disappears"] as const) {
		test(`a join approval stays pending and writes no enrollment when the enrollment ${race} after the reads`, async ({
			fixture: f,
		}) => {
			// Arrange: the approval pins the enrollment it read, as the upsert before it did.
			const joining = await target(f, "joining");
			await f.store.createGroup(joining.groupId);
			const invite = await f.store.createInvite({
				groupId: joining.groupId,
				policy: "approval_required",
				expiresAt: EXPIRES_AT,
			});
			const request = await f.store.createJoinRequest({
				groupId: joining.groupId,
				deviceId: joining.deviceId,
				publicKey: joining.key.publicKey,
				fingerprint: joining.key.fingerprint,
				token: invite.token,
			});
			const change = await arrangeRace(f, race, joining);
			const racing = f.interleave(JOIN_TRANSITION, change);
			// Act
			const pending = racing.reviewJoinRequest({ requestId: request.request_id, approved: true });
			// Assert
			await expect(pending).rejects.toThrow("join_review_incomplete");
			expect(
				await f.rows(
					"SELECT status FROM coordinator_join_requests WHERE request_id = ?",
					request.request_id,
				),
			).toEqual([{ status: "pending" }]);
			expect(await enrollmentUntouched(f, joining)).toBe(true);
		});

		test(`an admin enrollment writes nothing when the enrollment ${race} after its read`, async ({
			fixture: f,
		}) => {
			// Arrange: the incoming key differs, so a write would be visible in the row.
			const enrolled = await target(f);
			const incoming = { ...enrolled, key: await removalDeviceKey(`${f.prefix}-incoming`) };
			await f.store.createGroup(enrolled.groupId);
			const change = await arrangeRace(f, race, enrolled);
			const racing = f.interleave(ENROLLMENT_WRITE, change);
			// Act
			const pending = racing.enrollDevice(incoming.groupId, {
				deviceId: incoming.deviceId,
				publicKey: incoming.key.publicKey,
				fingerprint: incoming.key.fingerprint,
			});
			// Assert
			await expect(pending).rejects.toThrow("device_ownership_authorization_unavailable");
			expect(await enrollmentUntouched(f, incoming)).toBe(true);
		});
	}
}

/**
 * True when no writer touched the device's enrollment: every writer sets the
 * display name, and the arranged row carries a marker there. A store whose
 * transaction also held the interleaved change rolls that change back with the
 * refused write, so the row may also be absent or back in its arranged state.
 */
async function enrollmentUntouched(f: RemovalFixture, enrollment: Enrollment) {
	const rows = await f.rows<{ display_name: string | null }>(
		"SELECT display_name FROM enrolled_devices WHERE group_id = ? AND device_id = ?",
		enrollment.groupId,
		enrollment.deviceId,
	);
	return rows.every((row) => row.display_name === ARRANGED_DISPLAY_NAME);
}

/** The same canonical key as another key text, with the fingerprint of that text. */
function otherTextForm(enrollment: Enrollment): Enrollment {
	const publicKey = `${enrollment.key.publicKey} another-comment`;
	return {
		...enrollment,
		key: { ...enrollment.key, publicKey, fingerprint: fingerprintPublicKey(publicKey) },
	};
}

function storedKey({ key }: Enrollment) {
	return { public_key: key.publicKey, fingerprint: key.fingerprint, key_id: key.keyId };
}

/** A pending join request of the device, with the key text it presents now. */
async function requestToJoin(f: RemovalFixture, joining: Enrollment): Promise<string> {
	const invite = await f.store.createInvite({
		groupId: joining.groupId,
		policy: "approval_required",
		expiresAt: EXPIRES_AT,
	});
	const request = await f.store.createJoinRequest({
		groupId: joining.groupId,
		deviceId: joining.deviceId,
		publicKey: joining.key.publicKey,
		fingerprint: joining.key.fingerprint,
		token: invite.token,
	});
	return request.request_id;
}

function registerSuppressedKeyTextRewrites(test: RemovalTest) {
	for (const writer of ["admin enrollment", "join approval"] as const) {
		test(`a key text change by ${writer} whose rewrite a trigger suppresses is rolled back with its key ID reset`, async ({
			fixture: f,
		}) => {
			// Arrange: the reset changes the row, and the rewrite then changes none without an error.
			const enrolled = await target(f);
			const recommented = otherTextForm(enrolled);
			const seed = await target(f, "seed");
			await enroll(f, enrolled);
			await enroll(f, seed);
			const requestId = await requestToJoin(f, recommented);
			const before = await enrollmentRow(f, enrolled);
			await f.exec(`CREATE TRIGGER removal_fixture_ignore_key_text
				BEFORE UPDATE OF public_key ON enrolled_devices
				WHEN NEW.public_key IS NOT OLD.public_key
				BEGIN SELECT RAISE(IGNORE); END`);
			try {
				// Act
				const pending =
					writer === "admin enrollment"
						? enroll(f, recommented)
						: f.store.reviewJoinRequest({
								requestId,
								approved: true,
								bootstrapGrant: { seedDeviceId: seed.deviceId, expiresAt: EXPIRES_AT },
							});
				// Assert: the writer fails closed, and nothing of the sequence is kept.
				await expect(pending).rejects.toThrow(
					/^(device_ownership_authorization_unavailable|join_review_incomplete)$/u,
				);
				expect(await enrollmentRow(f, enrolled)).toEqual(before);
				expect(before).toMatchObject([storedKey(enrolled)]);
				expect(
					await f.rows(
						"SELECT status FROM coordinator_join_requests WHERE request_id = ?",
						requestId,
					),
				).toEqual([{ status: "pending" }]);
				expect(
					await f.rows(
						"SELECT grant_id FROM coordinator_bootstrap_grants WHERE worker_device_id = ?",
						enrolled.deviceId,
					),
				).toEqual([]);
			} finally {
				await f.exec("DROP TRIGGER IF EXISTS removal_fixture_ignore_key_text");
			}
		});
	}
}

function registerKeyTextChangeFailures(test: RemovalTest) {
	for (const writer of ["admin enrollment", "join approval"] as const) {
		test(`a key text change by ${writer} whose second statement fails leaves the original enrollment`, async ({
			fixture: f,
		}) => {
			// Arrange: the key ID reset passes, and the write of the new text then aborts.
			const enrolled = await target(f);
			const recommented = otherTextForm(enrolled);
			await enroll(f, enrolled);
			const requestId = await requestToJoin(f, recommented);
			const before = await enrollmentRow(f, enrolled);
			await f.exec(`CREATE TRIGGER removal_fixture_fail_key_text
				BEFORE UPDATE OF fingerprint ON enrolled_devices
				WHEN NEW.fingerprint IS NOT OLD.fingerprint
				BEGIN SELECT RAISE(ABORT, 'fixture key text failure'); END`);
			try {
				// Act
				const pending =
					writer === "admin enrollment"
						? enroll(f, recommented)
						: f.store.reviewJoinRequest({ requestId, approved: true });
				// Assert: no row keeps the empty key ID of the first statement. Each store
				// reports a failed enrollment statement of an approval in its own way.
				await expect(pending).rejects.toThrow(
					/^(device_ownership_authorization_unavailable|join_review_incomplete)$/u,
				);
				expect(
					await f.rows(
						"SELECT status FROM coordinator_join_requests WHERE request_id = ?",
						requestId,
					),
				).toEqual([{ status: "pending" }]);
				expect(await enrollmentRow(f, enrolled)).toEqual(before);
				expect(before).toMatchObject([storedKey(enrolled)]);
			} finally {
				await f.exec("DROP TRIGGER IF EXISTS removal_fixture_fail_key_text");
			}
		});
	}

	// The first case stops at the write of the new text, whose key ID a tombstone holds.
	// The second has no key ID, so the same write is matched by its text.
	for (const form of ["another text form of its key", "another opaque key"] as const) {
		test(`A19 a key text change to ${form} that an active tombstone holds aborts and leaves the enrollment`, async ({
			fixture: f,
		}) => {
			// Arrange: another device ID was removed elsewhere under the text this device now presents.
			const first = await target(f);
			const opaque = form === "another opaque key";
			const enrolled = opaque ? { ...first, key: opaqueKey(`${f.prefix}-first`) } : first;
			const changed = opaque
				? { ...first, key: opaqueKey(`${f.prefix}-second`) }
				: otherTextForm(first);
			await enroll(f, enrolled);
			await insertTombstone(f, {
				...changed,
				groupId: `${f.prefix}-g9`,
				deviceId: `${f.prefix}-alias`,
			});
			const before = await enrollmentRow(f, enrolled);
			// Act
			const pending = enroll(f, changed);
			// Assert
			await expect(pending).rejects.toThrow("device_ownership_authorization_unavailable");
			expect(await enrollmentRow(f, enrolled)).toEqual(before);
			expect(before).toMatchObject([storedKey(enrolled)]);
		});
	}
}

function registerKeyTextChanges(test: RemovalTest) {
	test("A26 an admin enrollment with another text form of the same key rewrites the key text, fingerprint and key ID", async ({
		fixture: f,
	}) => {
		// Arrange: a device whose public key file lost or gained its comment.
		const enrolled = await target(f);
		const recommented = otherTextForm(enrolled);
		await enroll(f, enrolled);
		// Act
		await enroll(f, recommented);
		// Assert: presence checks the fingerprint of the stored text, so both must follow.
		expect(await enrollmentRow(f, enrolled)).toMatchObject([storedKey(recommented)]);
	});

	test("A26 a join approval of an enrolled device with another text form of its key completes", async ({
		fixture: f,
	}) => {
		// Arrange
		const enrolled = await target(f);
		const recommented = otherTextForm(enrolled);
		await enroll(f, enrolled);
		const requestId = await requestToJoin(f, recommented);
		// Act
		const review = await f.store.reviewJoinRequest({ requestId, approved: true });
		// Assert
		expect(review?.status).toBe("approved");
		expect(await enrollmentRow(f, enrolled)).toMatchObject([storedKey(recommented)]);
	});

	test("A26 an admin enrollment replaces one opaque key with another", async ({ fixture: f }) => {
		// Arrange
		const enrolled = { ...(await target(f)), key: opaqueKey(`${f.prefix}-first`) };
		const replaced = { ...enrolled, key: opaqueKey(`${f.prefix}-second`) };
		await currentInsert(f, enrolled);
		await f.store.createGroup(enrolled.groupId);
		// Act
		await enroll(f, replaced);
		// Assert
		expect(await enrollments(f)).toEqual([
			{
				group_id: enrolled.groupId,
				device_id: enrolled.deviceId,
				public_key: replaced.key.publicKey,
				key_id: "",
			},
		]);
	});
}
