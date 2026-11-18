import { expect } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import {
	ARRANGED_CREATED_AT,
	ARRANGED_DISPLAY_NAME,
	currentInsert,
	type DeviceKey,
	type Enrollment,
	enroll,
	enrollments,
	insertDisabledEnrollment,
	insertTombstone,
	invitationFixture,
	legacyInsert,
	opaqueKey,
	type RemovalChange,
	type RemovalFixture,
	type RemovalTest,
	removalDeviceKey,
	target,
} from "./coordinator-device-removal-test-harness.js";
import { deleteEnrollmentWithoutTombstone } from "./coordinator-enrollment-test-fixtures.js";
import { projectInvite } from "./coordinator-project-revocation-test-harness.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/**
 * Enrollment writers under the enrollment triggers: what they write when the
 * enrollment changes between their reads and their write, and how they keep
 * `key_id` and the key text. The fixtures are those of the removal harness.
 */
export function registerEnrollmentWriterContract(test: RemovalTest) {
	registerInvitationRaces(test);
	registerPinnedWriterRaces(test);
	registerKeyIdOnUpdate(test);
	registerKeyTextChanges(test);
	registerKeyTextChangeFailures(test);
	registerSuppressedKeyTextRewrites(test);
	registerRemovedDeviceRefusals(test);
}

const INVITE_CONSUME = ["UPDATE coordinator_invites SET token"];
const JOIN_TRANSITION = ["UPDATE coordinator_join_requests"];
const ENROLLMENT_WRITE = ["INSERT INTO enrolled_devices", "UPDATE enrolled_devices SET public_key"];
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

type Race = "appears" | "disappears";

/** Arranges the state before the operation reads, and the change that follows those reads. */
async function arrangeRace(
	f: RemovalFixture,
	race: Race,
	enrollment: Enrollment,
): Promise<RemovalChange> {
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
	return (database) =>
		deleteEnrollmentWithoutTombstone(
			database,
			"group_id = ? AND device_id = ?",
			enrollment.groupId,
			enrollment.deviceId,
		);
}

type Acceptance = {
	enrollment: Enrollment;
	identityId: string;
	inviteId: string;
	accept: (store: Store) => Promise<{ status: string }>;
};

async function teamAcceptance(f: RemovalFixture, key: DeviceKey): Promise<Acceptance> {
	const fixture = invitationFixture(f, "team", key);
	const { input, invite } = await recipientInvite(fixture, "team_member");
	return {
		enrollment: { groupId: fixture.input.groupId, deviceId: input.deviceId, key },
		identityId: input.identityId,
		inviteId: invite.invite_id,
		accept: (store) => store.consumeRecipientInvite(input),
	};
}

async function projectAcceptance(f: RemovalFixture, key: DeviceKey): Promise<Acceptance> {
	const fixture = invitationFixture(f, "project", key);
	const { input, invite } = await projectInvite(fixture);
	return {
		enrollment: { groupId: fixture.input.groupId, deviceId: input.deviceId, key },
		identityId: input.recipientActorId,
		inviteId: invite.invite_id,
		accept: (store) => store.consumeProjectInvite(input),
	};
}

function enrollmentRow(f: RemovalFixture, enrollment: Enrollment) {
	return f.rows(
		`SELECT public_key, fingerprint, key_id, identity_id, enabled, created_at
		FROM enrolled_devices WHERE group_id = ? AND device_id = ?`,
		enrollment.groupId,
		enrollment.deviceId,
	);
}

function registerInvitationRaces(test: RemovalTest) {
	const families = { recipient: teamAcceptance, Project: projectAcceptance };
	for (const [family, arrange] of Object.entries(families)) {
		for (const race of ["appears", "disappears"] as const) {
			test(`a ${family} invitation is consumed together with an enrollment write when the enrollment ${race} after the reads`, async ({
				fixture: f,
			}) => {
				// Arrange
				const key = await removalDeviceKey(`${f.prefix}-joining`);
				const acceptance = await arrange(f, key);
				const change = await arrangeRace(f, race, acceptance.enrollment);
				const racing = f.interleave(INVITE_CONSUME, change);
				// Act
				const result = await acceptance.accept(racing);
				// Assert: the token is consumed and the enrollment of that moment is written. The
				// row that appeared is updated in place, and the row that disappeared is inserted,
				// so only the first keeps the arranged creation time.
				const createdAt =
					race === "appears" ? ARRANGED_CREATED_AT : expect.not.stringMatching(ARRANGED_CREATED_AT);
				expect(result.status).toBe("accepted");
				expect(
					await f.rows(
						"SELECT consumed_at IS NOT NULL AS consumed FROM coordinator_invites WHERE invite_id = ?",
						acceptance.inviteId,
					),
				).toEqual([{ consumed: 1 }]);
				expect(await enrollmentRow(f, acceptance.enrollment)).toEqual([
					{
						public_key: key.publicKey,
						fingerprint: key.fingerprint,
						key_id: key.keyId,
						identity_id: acceptance.identityId,
						enabled: 1,
						created_at: createdAt,
					},
				]);
			});
		}
	}
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

function registerKeyIdOnUpdate(test: RemovalTest) {
	test("A13 a writer that updates an enrollment without a key ID fills it", async ({
		fixture: f,
	}) => {
		// Arrange: four enrollments as an earlier release wrote them, one for each writer.
		const joining = await removalDeviceKey(`${f.prefix}-joining`);
		const shared = await removalDeviceKey(`${f.prefix}-shared`);
		const team = await teamAcceptance(f, joining);
		const project = await projectAcceptance(f, shared);
		const admin = await target(f, "admin");
		const disabled = await target(f, "disabled");
		await f.store.createGroup(admin.groupId);
		for (const enrollment of [team.enrollment, project.enrollment, admin, disabled])
			await legacyInsert(f, enrollment);
		await f.exec("UPDATE enrolled_devices SET enabled = 0 WHERE device_id = ?", disabled.deviceId);
		// Act
		await team.accept(f.store);
		await project.accept(f.store);
		await enroll(f, admin);
		await f.store.setDeviceEnabled(disabled.groupId, disabled.deviceId, true);
		// Assert
		const stored = await f.rows(
			"SELECT device_id, key_id FROM enrolled_devices WHERE device_id IN (?, ?, ?, ?)",
			team.enrollment.deviceId,
			project.enrollment.deviceId,
			admin.deviceId,
			disabled.deviceId,
		);
		expect(stored).toEqual(
			expect.arrayContaining([
				{ device_id: team.enrollment.deviceId, key_id: joining.keyId },
				{ device_id: project.enrollment.deviceId, key_id: shared.keyId },
				{ device_id: admin.deviceId, key_id: admin.key.keyId },
				{ device_id: disabled.deviceId, key_id: disabled.key.keyId },
			]),
		);
	});
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
			// Assert: the tombstone-match trigger aborts, and the writer names that refusal.
			await expect(pending).rejects.toThrow(/^device_removed$/u);
			expect(await enrollmentRow(f, enrolled)).toEqual(before);
			expect(before).toMatchObject([storedKey(enrolled)]);
		});
	}
}

/** An active tombstone of another group that records the device ID and key of `removed`. */
function removedElsewhere(f: RemovalFixture, removed: Enrollment): Promise<void> {
	return insertTombstone(f, { ...removed, groupId: `${f.prefix}-g9` });
}

/**
 * The fixed error of a refused writer, or what it returned. An error class of
 * the database driver is named, because a fixed store error is a plain Error.
 */
const refusal = (write: Promise<unknown>) =>
	write.then(
		(result) => ({ returned: result }),
		(error: Error) =>
			error.constructor === Error ? error.message : `${error.name}: ${error.message}`,
	);

/**
 * The enrollment triggers stop a removed device behind every writer. Each writer
 * names that refusal `device_removed` and commits nothing of its operation.
 */
function registerRemovedDeviceRefusals(test: RemovalTest) {
	registerRemovedEnrollmentRefusals(test);
	registerRemovedAcceptanceRefusals(test);
	registerRemovedEnableRefusal(test);
	registerRevokedAndRemovedRefusals(test);
}

/** Enrolls the device, records a revocation of its ID and key, and removes it through the store. */
async function revokeAndRemove(f: RemovalFixture, device: Enrollment): Promise<void> {
	await enroll(f, device);
	const revoked = await f.store.createDeviceRevocation({
		groupId: device.groupId,
		deviceId: device.deviceId,
		publicKey: device.key.publicKey,
		fingerprint: device.key.fingerprint,
	});
	expect(revoked).toMatchObject({ kind: "revoked" });
	expect(await f.store.removeDevice(device.groupId, device.deviceId)).toBe(true);
}

function registerRevokedAndRemovedRefusals(test: RemovalTest) {
	test("a device that is both revoked and removed is refused with device_revoked by admin enrollment and by a team invitation", async ({
		fixture: f,
	}) => {
		// Arrange: for each writer, a revocation subject and an active tombstone match its device.
		const enrolling = await target(f, "enrolling");
		const acceptance = await teamAcceptance(f, await removalDeviceKey(`${f.prefix}-joining`));
		await revokeAndRemove(f, enrolling);
		await revokeAndRemove(f, acceptance.enrollment);
		const removals = await f.rows(
			"SELECT device_id FROM coordinator_device_removals WHERE lifted_at IS NULL AND device_id IN (?, ?)",
			enrolling.deviceId,
			acceptance.enrollment.deviceId,
		);
		// Act
		const enrolled = await refusal(enroll(f, enrolling));
		const accepted = await refusal(acceptance.accept(f.store));
		// Assert: revocation takes precedence, and neither writer wrote anything.
		expect(removals).toHaveLength(2);
		expect([enrolled, accepted]).toEqual(["device_revoked", "device_revoked"]);
		expect(await enrollmentRow(f, enrolling)).toEqual([]);
		expect(await enrollmentRow(f, acceptance.enrollment)).toEqual([]);
		expect(
			await f.rows(
				"SELECT consumed_at, bound_device_id FROM coordinator_invites WHERE invite_id = ?",
				acceptance.inviteId,
			),
		).toEqual([{ consumed_at: null, bound_device_id: null }]);
	});
}

function registerRemovedEnrollmentRefusals(test: RemovalTest) {
	test("an admin enrollment of a removed device is refused with device_removed", async ({
		fixture: f,
	}) => {
		// Arrange
		const removed = await target(f);
		await f.store.createGroup(removed.groupId);
		await removedElsewhere(f, removed);
		// Act
		const byDeviceId = await refusal(enroll(f, { ...removed, key: opaqueKey(`${f.prefix}-new`) }));
		const byKey = await refusal(enroll(f, { ...removed, deviceId: `${f.prefix}-renamed` }));
		// Assert
		expect([byDeviceId, byKey]).toEqual(["device_removed", "device_removed"]);
		expect(await enrollments(f)).toEqual([]);
	});

	test("a join approval of a removed device is refused with device_removed and stays pending", async ({
		fixture: f,
	}) => {
		// Arrange: the device was removed after it asked to join.
		const joining = await target(f);
		await f.store.createGroup(joining.groupId);
		const requestId = await requestToJoin(f, joining);
		await removedElsewhere(f, joining);
		// Act
		const review = await refusal(f.store.reviewJoinRequest({ requestId, approved: true }));
		// Assert
		expect(review).toBe("device_removed");
		expect(
			await f.rows("SELECT status FROM coordinator_join_requests WHERE request_id = ?", requestId),
		).toEqual([{ status: "pending" }]);
		expect(await enrollments(f)).toEqual([]);
	});
}

function registerRemovedAcceptanceRefusals(test: RemovalTest) {
	for (const [family, arrange] of Object.entries({
		team: teamAcceptance,
		Project: projectAcceptance,
	})) {
		test(`a ${family} invitation acceptance by a removed device is refused with device_removed and consumes nothing`, async ({
			fixture: f,
		}) => {
			// Arrange: the device was removed after the invitation was created.
			const acceptance = await arrange(f, await removalDeviceKey(`${f.prefix}-joining`));
			await removedElsewhere(f, acceptance.enrollment);
			// Act
			const accepted = await refusal(acceptance.accept(f.store));
			// Assert
			expect(accepted).toBe("device_removed");
			expect(
				await f.rows(
					"SELECT consumed_at, bound_device_id FROM coordinator_invites WHERE invite_id = ?",
					acceptance.inviteId,
				),
			).toEqual([{ consumed_at: null, bound_device_id: null }]);
			expect(await enrollmentRow(f, acceptance.enrollment)).toEqual([]);
		});

		test(`a retried ${family} invitation acceptance that would repair a removed device's enrollment is refused with device_removed`, async ({
			fixture: f,
		}) => {
			// Arrange: an accepted enrollment as an earlier release left it, removed elsewhere since.
			const acceptance = await arrange(f, await removalDeviceKey(`${f.prefix}-joining`));
			await acceptance.accept(f.store);
			await f.exec(
				"UPDATE enrolled_devices SET identity_id = NULL, key_id = NULL WHERE device_id = ?",
				acceptance.enrollment.deviceId,
			);
			await removedElsewhere(f, acceptance.enrollment);
			const before = await enrollmentRow(f, acceptance.enrollment);
			// Act: the repair would state the key ID, which is a change the tombstone refuses.
			const retried = await refusal(acceptance.accept(f.store));
			// Assert
			expect(retried).toBe("device_removed");
			expect(await enrollmentRow(f, acceptance.enrollment)).toEqual(before);
			expect(before).toMatchObject([{ identity_id: null, key_id: null, enabled: 1 }]);
		});
	}
}

function registerRemovedEnableRefusal(test: RemovalTest) {
	test("enabling an enrollment whose key was removed from the group is refused with device_removed", async ({
		fixture: f,
	}) => {
		// Arrange: a disabled enrollment, and a removal of its key under another device ID.
		const disabled = await target(f);
		await enroll(f, disabled);
		await f.store.setDeviceEnabled(disabled.groupId, disabled.deviceId, false);
		await insertTombstone(f, { ...disabled, deviceId: `${f.prefix}-alias` });
		// Act
		const enabled = await refusal(
			f.store.setDeviceEnabled(disabled.groupId, disabled.deviceId, true),
		);
		// Assert
		expect(enabled).toBe("device_removed");
		expect(await enrollmentRow(f, disabled)).toMatchObject([{ enabled: 0 }]);
	});
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
