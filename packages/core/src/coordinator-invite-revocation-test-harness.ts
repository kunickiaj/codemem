import { expect, it } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import { removalDeviceKey } from "./coordinator-device-removal-test-harness.js";
import { recipientReviewedIntentDigest } from "./recipient-reviewed-intent.js";

/** A store and a prefix no other test uses. */
export interface InviteRevocationFixture {
	store: Store;
	prefix: string;
}

export function inviteRevocationHarness(
	fixture: (use: (f: InviteRevocationFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: InviteRevocationFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
export type InviteRevocationTest = ReturnType<typeof inviteRevocationHarness>;

/** The clock every fixture injects into its store. */
export const INVITE_REVOCATION_CLOCK_MS = Date.UTC(2026, 10, 26, 12, 0, 0);
const CLOCK_ISO = new Date(INVITE_REVOCATION_CLOCK_MS).toISOString();
const ACCEPTED_AT = "2026-11-26T13:00:00.000Z";

/** A group with an inviting device, and a Team invitation that a new device can accept. */
async function teamInvitation(f: InviteRevocationFixture, name = "invited") {
	const groupId = `${f.prefix}-group`;
	if (!(await f.store.getGroup(groupId))) {
		await f.store.createGroup(groupId);
		const inviter = await removalDeviceKey(`${f.prefix}-inviter`);
		await f.store.enrollDevice(groupId, {
			deviceId: `${f.prefix}-inviter`,
			publicKey: inviter.publicKey,
			fingerprint: inviter.fingerprint,
			identityId: "identity:inviter",
		});
	}
	const reviewedIntent = {
		version: 1,
		journey: "team",
		team: { teamId: `${f.prefix}-team`, displayName: "Team", futureProjectsInherit: true },
		projects: [],
		excludedProjects: [],
	};
	const invite = await f.store.createInvite({
		groupId,
		policy: "auto_admit",
		expiresAt: "2099-01-01T00:00:00Z",
		inviteKind: "team_member",
		inviterDeviceId: `${f.prefix}-inviter`,
		policyTeamId: `${f.prefix}-team`,
		reviewedIntent,
		reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
	});
	const key = await removalDeviceKey(`${f.prefix}-${name}`);
	const accept = () =>
		f.store.consumeRecipientInvite({
			token: invite.token,
			inviteKind: "team_member",
			identityId: String(invite.assigned_identity_id),
			deviceId: `${f.prefix}-${name}`,
			publicKey: key.publicKey,
			fingerprint: key.fingerprint,
			recipientDisplayName: "Recipient",
			deviceDisplayName: "Recipient device",
			now: ACCEPTED_AT,
		});
	const revoke = () => f.store.revokeInvite({ groupId, inviteId: invite.invite_id });
	return { groupId, invite, accept, revoke };
}

export function registerInviteRevocationContract(test: InviteRevocationTest) {
	test("revokes an unaccepted invitation, which can then no longer be accepted", async ({
		fixture: f,
	}) => {
		const t = await teamInvitation(f);

		expect(await t.revoke()).toEqual({
			status: "revoked",
			invite_id: t.invite.invite_id,
			revoked_at: CLOCK_ISO,
		});

		await expect(t.accept()).rejects.toThrow("invite_invalid");
		expect(await f.store.getEnrollment(t.groupId, `${f.prefix}-invited`)).toBeNull();
	});

	test("keeps the first revocation when it is revoked again", async ({ fixture: f }) => {
		const t = await teamInvitation(f);
		await t.revoke();

		expect(await t.revoke()).toEqual({
			status: "already_revoked",
			invite_id: t.invite.invite_id,
			revoked_at: CLOCK_ISO,
		});
	});

	test("refuses an accepted invitation and leaves it accepted", async ({ fixture: f }) => {
		const t = await teamInvitation(f);
		expect((await t.accept()).status).toBe("accepted");

		expect(await t.revoke()).toEqual({ status: "consumed", invite_id: t.invite.invite_id });

		const [stored] = (await f.store.listInvites(t.groupId)).filter(
			(invite) => invite.invite_id === t.invite.invite_id,
		);
		expect(stored?.revoked_at).toBeNull();
		expect(stored?.consumed_at).toBe(ACCEPTED_AT);
	});

	test("does not find an invitation of another group or an unknown one", async ({ fixture: f }) => {
		const t = await teamInvitation(f);
		await f.store.createGroup(`${f.prefix}-other`);

		expect(
			await f.store.revokeInvite({ groupId: `${f.prefix}-other`, inviteId: t.invite.invite_id }),
		).toEqual({ status: "not_found", invite_id: t.invite.invite_id });
		expect(await f.store.revokeInvite({ groupId: t.groupId, inviteId: "unknown" })).toEqual({
			status: "not_found",
			invite_id: "unknown",
		});
		expect((await t.accept()).status).toBe("accepted");
	});

	registerRaceAndRefusals(test);
}

function registerRaceAndRefusals(test: InviteRevocationTest) {
	test("lets exactly one of a revocation and an acceptance win when they race", async ({
		fixture: f,
	}) => {
		const t = await teamInvitation(f);

		const [revoked, accepted] = await Promise.allSettled([t.revoke(), t.accept()]);

		if (revoked.status !== "fulfilled") throw revoked.reason;
		if (revoked.value.status === "revoked") {
			expect(accepted.status).toBe("rejected");
		} else {
			expect(revoked.value.status).toBe("consumed");
			expect(accepted.status === "fulfilled" && accepted.value.status).toBe("accepted");
		}
	});

	test("refuses identifiers that are empty, padded or not text", async ({ fixture: f }) => {
		const t = await teamInvitation(f);
		for (const input of [
			null,
			{ groupId: t.groupId, inviteId: "" },
			{ groupId: ` ${t.groupId}`, inviteId: t.invite.invite_id },
			{ groupId: t.groupId, inviteId: 7 },
		])
			await expect(f.store.revokeInvite(input as never)).rejects.toThrow("invalid_input");
		expect((await t.accept()).status).toBe("accepted");
	});
}
