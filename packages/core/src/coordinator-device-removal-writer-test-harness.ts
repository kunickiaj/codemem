import { expect } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import {
	ARRANGED_CREATED_AT,
	ARRANGED_DISPLAY_NAME,
	currentInsert,
	type DeviceKey,
	deleteEnrollmentWithoutTombstone,
	type Enrollment,
	enroll,
	enrollments,
	insertDisabledEnrollment,
	invitationFixture,
	legacyInsert,
	opaqueKey,
	type RemovalFixture,
	type RemovalTest,
	removalDeviceKey,
	target,
} from "./coordinator-device-removal-test-harness.js";
import { projectInvite } from "./coordinator-project-revocation-test-harness.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";

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
}

const INVITE_CONSUME = ["UPDATE coordinator_invites SET token"];
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

function registerKeyTextChanges(test: RemovalTest) {
	test("A26 an admin enrollment keeps the stored key text when the same key arrives in another form", async ({
		fixture: f,
	}) => {
		// Arrange
		const enrolled = await target(f);
		const recommented = {
			...enrolled,
			key: { ...enrolled.key, publicKey: `${enrolled.key.publicKey} another-comment` },
		};
		await enroll(f, enrolled);
		await f.exec("UPDATE enrolled_devices SET enabled = 0 WHERE device_id = ?", enrolled.deviceId);
		// Act: the stale-key trigger would refuse the new text, so the writer does not write it.
		await enroll(f, recommented);
		// Assert: everything else the writer does still happens.
		expect(await enrollmentRow(f, enrolled)).toEqual([
			{
				public_key: enrolled.key.publicKey,
				fingerprint: enrolled.key.fingerprint,
				key_id: enrolled.key.keyId,
				identity_id: null,
				enabled: 1,
				created_at: expect.any(String),
			},
		]);
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
