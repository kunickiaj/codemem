import { expect, it } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import { removalDeviceKey } from "./coordinator-device-removal-test-harness.js";
import type { CoordinatorConsumeRecipientInviteInput } from "./coordinator-store-contract.js";
import {
	type CoordinatorTeamMemberRemoval,
	removedTeamMembers,
	TEAM_MEMBER_REMOVAL_PAGE_SIZE,
	teamMemberKey,
} from "./coordinator-team-member-removals.js";
import { recipientReviewedIntentDigest } from "./recipient-reviewed-intent.js";

/** A store, raw SQL access to its database, and a prefix no other test uses. */
export interface TeamMemberRemovalFixture {
	store: Store;
	prefix: string;
	exec(sql: string, ...values: (string | number)[]): Promise<unknown>;
}

export function teamMemberRemovalHarness(
	fixture: (use: (f: TeamMemberRemovalFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: TeamMemberRemovalFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
export type TeamMemberRemovalTest = ReturnType<typeof teamMemberRemovalHarness>;

/** The clock every fixture injects into its store. */
export const TEAM_MEMBER_REMOVAL_CLOCK_MS = Date.UTC(2026, 10, 25, 12, 0, 0);
const CLOCK_ISO = new Date(TEAM_MEMBER_REMOVAL_CLOCK_MS).toISOString();
const ACCEPTED_AT = "2026-11-25T13:00:00.000Z";

type World = Awaited<ReturnType<typeof world>>;

/** A group with an enrolled inviting device, one Team and one person. */
async function world(f: TeamMemberRemovalFixture) {
	const groupId = `${f.prefix}-group`;
	await f.store.createGroup(groupId);
	const inviter = await removalDeviceKey(`${f.prefix}-inviter`);
	const inviterDeviceId = `${f.prefix}-inviter`;
	await f.store.enrollDevice(groupId, {
		deviceId: inviterDeviceId,
		publicKey: inviter.publicKey,
		fingerprint: inviter.fingerprint,
		identityId: "identity:inviter",
	});
	return {
		f,
		groupId,
		inviterDeviceId,
		teamId: `${f.prefix}-team`,
		identityId: `identity:${f.prefix}-person`,
		deviceId: `${f.prefix}-admin-device`,
	};
}

const remove = (w: World, identityId: string) =>
	w.f.store.recordTeamMemberRemoval({ groupId: w.groupId, teamId: w.teamId, identityId });

async function listed(w: World): Promise<CoordinatorTeamMemberRemoval[]> {
	return (await w.f.store.listTeamMemberRemovals({ groupId: w.groupId })).items;
}

/** Whether the identity is removed from the world's Team, as a client reads it. */
async function removed(w: World, identityId: string): Promise<boolean> {
	return removedTeamMembers(await listed(w)).has(teamMemberKey(w.groupId, w.teamId, identityId));
}

/** A Team invitation issued by the coordinator, and how a new device accepts it. */
async function teamInvitation(w: World, name: string) {
	const reviewedIntent = {
		version: 1,
		journey: "team",
		team: { teamId: w.teamId, displayName: "Team", futureProjectsInherit: true },
		projects: [],
		excludedProjects: [],
	};
	const invite = await w.f.store.createInvite({
		groupId: w.groupId,
		policy: "auto_admit",
		expiresAt: "2099-01-01T00:00:00Z",
		inviteKind: "team_member",
		inviterDeviceId: w.inviterDeviceId,
		policyTeamId: w.teamId,
		reviewedIntent,
		reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
	});
	const identityId = String(invite.assigned_identity_id);
	const key = await removalDeviceKey(`${w.f.prefix}-${name}`);
	const input: CoordinatorConsumeRecipientInviteInput = {
		token: invite.token,
		inviteKind: "team_member",
		identityId,
		deviceId: `${w.f.prefix}-${name}`,
		publicKey: key.publicKey,
		fingerprint: key.fingerprint,
		recipientDisplayName: "Recipient",
		deviceDisplayName: "Recipient device",
		now: ACCEPTED_AT,
	};
	return { invite, identityId, input, accept: () => w.f.store.consumeRecipientInvite(input) };
}

/** A person who joined through a Team invitation and was then removed from the Team. */
async function removedPerson(w: World) {
	const first = await teamInvitation(w, "first-device");
	expect((await first.accept()).status).toBe("accepted");
	const removal = await remove(w, first.identityId);
	expect(removal.status).toBe("created");
	return { first, identityId: first.identityId, removal: removal.removal };
}

export function registerTeamMemberRemovalContract(test: TeamMemberRemovalTest) {
	registerRecording(test);
	registerRefusals(test);
	registerListing(test);
	registerImmutability(test);
	registerInvitations(test);
	registerSameIdentityPaths(test);
}

function registerRecording(test: TeamMemberRemovalTest) {
	test("records a person's removal from one Team with coordinator time", async ({ fixture: f }) => {
		const w = await world(f);

		const result = await f.store.recordTeamMemberRemoval({
			groupId: w.groupId,
			teamId: w.teamId,
			identityId: w.identityId,
			removedByDeviceId: w.deviceId,
		});

		expect(result).toEqual({
			status: "created",
			removal: {
				removal_seq: expect.any(Number),
				group_id: w.groupId,
				team_id: w.teamId,
				identity_id: w.identityId,
				removed_by_device_id: w.deviceId,
				removed_at: CLOCK_ISO,
			},
		});
		expect(await removed(w, w.identityId)).toBe(true);
	});

	test("writes nothing when the same person is removed from the same Team again", async ({
		fixture: f,
	}) => {
		const w = await world(f);
		const key = { groupId: w.groupId, teamId: w.teamId, identityId: w.identityId };
		const first = await f.store.recordTeamMemberRemoval({ ...key, removedByDeviceId: w.deviceId });

		const again = await f.store.recordTeamMemberRemoval({ ...key, removedByDeviceId: "other" });

		expect(again).toEqual({ status: "existing", removal: first.removal });
		expect(await listed(w)).toEqual([first.removal]);
	});

	test("keeps removals from other Teams and groups apart", async ({ fixture: f }) => {
		const w = await world(f);
		const otherGroup = `${f.prefix}-other-group`;
		await f.store.createGroup(otherGroup);
		const record = (groupId: string, teamId: string) =>
			f.store.recordTeamMemberRemoval({ groupId, teamId, identityId: w.identityId });

		const results = [
			await record(w.groupId, w.teamId),
			await record(w.groupId, `${w.teamId}-other`),
			await record(otherGroup, w.teamId),
		];

		expect(results.map((result) => result.status)).toEqual(["created", "created", "created"]);
		expect(new Set(results.map((result) => result.removal.removal_seq)).size).toBe(3);
	});
}

function registerRefusals(test: TeamMemberRemovalTest) {
	test("refuses an unknown group and stores nothing", async ({ fixture: f }) => {
		const w = await world(f);
		const missing = `${f.prefix}-missing`;

		await expect(
			f.store.recordTeamMemberRemoval({
				groupId: missing,
				teamId: w.teamId,
				identityId: w.identityId,
			}),
		).rejects.toThrow("group_not_found");
		expect((await f.store.listTeamMemberRemovals({ groupId: missing })).items).toEqual([]);
	});

	test("refuses identifiers that are empty, padded, too long or contain control characters", async ({
		fixture: f,
	}) => {
		const w = await world(f);
		const valid = { groupId: w.groupId, teamId: w.teamId, identityId: w.identityId };
		const invalid: unknown[] = [
			null,
			{ ...valid, teamId: "" },
			{ ...valid, identityId: " padded" },
			{ ...valid, teamId: "x".repeat(257) },
			{ ...valid, identityId: "line\nbreak" },
			{ ...valid, groupId: undefined },
			{ ...valid, removedByDeviceId: 7 },
		];
		for (const input of invalid)
			await expect(f.store.recordTeamMemberRemoval(input as never)).rejects.toThrow(
				"invalid_input",
			);
		for (const input of [
			{ groupId: "" },
			{ groupId: w.groupId, teamId: "" },
			{ groupId: w.groupId, afterSeq: -1 },
			{ groupId: w.groupId, afterSeq: 1.5 },
		])
			await expect(f.store.listTeamMemberRemovals(input as never)).rejects.toThrow("invalid_input");
		expect(await listed(w)).toEqual([]);
	});
}

function registerListing(test: TeamMemberRemovalTest) {
	test("lists one group's removals oldest first, optionally for one Team", async ({
		fixture: f,
	}) => {
		const w = await world(f);
		const otherGroup = `${f.prefix}-other-group`;
		await f.store.createGroup(otherGroup);
		const record = async (groupId: string, teamId: string, identityId: string) =>
			(await f.store.recordTeamMemberRemoval({ groupId, teamId, identityId })).removal;
		const a = await record(w.groupId, w.teamId, "identity:a");
		const b = await record(w.groupId, `${w.teamId}-other`, "identity:b");
		const c = await record(w.groupId, w.teamId, "identity:c");
		await record(otherGroup, w.teamId, "identity:d");

		expect(await f.store.listTeamMemberRemovals({ groupId: w.groupId })).toEqual({
			items: [a, b, c],
			next_after_seq: null,
		});
		expect(await f.store.listTeamMemberRemovals({ groupId: w.groupId, teamId: w.teamId })).toEqual({
			items: [a, c],
			next_after_seq: null,
		});
		expect(
			await f.store.listTeamMemberRemovals({ groupId: w.groupId, afterSeq: a.removal_seq }),
		).toEqual({ items: [b, c], next_after_seq: null });
	});

	test("pages a long list and the next page starts after the last removal", async ({
		fixture: f,
	}) => {
		const w = await world(f);
		for (let index = 0; index <= TEAM_MEMBER_REMOVAL_PAGE_SIZE; index += 1)
			await remove(w, `identity:${index}`);

		const first = await f.store.listTeamMemberRemovals({ groupId: w.groupId });
		const second = await f.store.listTeamMemberRemovals({
			groupId: w.groupId,
			afterSeq: first.next_after_seq,
		});

		expect(first.items).toHaveLength(TEAM_MEMBER_REMOVAL_PAGE_SIZE);
		expect(first.next_after_seq).toBe(first.items.at(-1)?.removal_seq);
		expect(second.items.map((item) => item.identity_id)).toEqual([
			`identity:${TEAM_MEMBER_REMOVAL_PAGE_SIZE}`,
		]);
		expect(second.next_after_seq).toBeNull();
	});
}

function registerImmutability(test: TeamMemberRemovalTest) {
	test("a stored removal cannot be changed or deleted", async ({ fixture: f }) => {
		const w = await world(f);
		const { removal } = await remove(w, w.identityId);

		for (const sql of [
			"UPDATE coordinator_team_member_removals SET identity_id = 'identity:other' WHERE removal_seq = ?",
			"DELETE FROM coordinator_team_member_removals WHERE removal_seq = ?",
		])
			await expect(f.exec(sql, removal.removal_seq)).rejects.toThrow(
				"team_member_removal_immutable",
			);
		expect(await listed(w)).toEqual([removal]);
	});
}

function registerInvitations(test: TeamMemberRemovalTest) {
	test("a new Team invitation accepted after the removal joins under a new identity, and the removed one stays removed", async ({
		fixture: f,
	}) => {
		const w = await world(f);
		const person = await removedPerson(w);
		const later = await teamInvitation(w, "later-device");

		expect((await later.accept()).status).toBe("accepted");

		expect(later.identityId).not.toBe(person.identityId);
		expect(await removed(w, person.identityId)).toBe(true);
		expect(await removed(w, later.identityId)).toBe(false);
		expect(await listed(w)).toEqual([person.removal]);
	});

	test("an invitation issued before the removal and accepted after it does not affect the removed identity", async ({
		fixture: f,
	}) => {
		const w = await world(f);
		const first = await teamInvitation(w, "first-device");
		await first.accept();
		const earlier = await teamInvitation(w, "earlier-device");
		const { removal } = await remove(w, first.identityId);

		expect((await earlier.accept()).status).toBe("accepted");
		expect((await first.accept()).status).toBe("existing");

		expect(await removed(w, first.identityId)).toBe(true);
		expect(await removed(w, earlier.identityId)).toBe(false);
		expect(await listed(w)).toEqual([removal]);
	});
}

function registerSameIdentityPaths(test: TeamMemberRemovalTest) {
	test("device rejoin of the removed identity's device does not lift the removal", async ({
		fixture: f,
	}) => {
		const w = await world(f);
		const person = await removedPerson(w);
		const deviceId = person.first.input.deviceId;
		expect(await f.store.removeDevice(w.groupId, deviceId)).toBe(true);
		// Issued after the device removal, so it may lift it, for the removed identity.
		const rejoin = await addDeviceInvitation(w, person.identityId, "first-device", {
			joinProofVerified: true,
		});

		expect((await rejoin()).status).toBe("accepted");

		expect(await f.store.getEnrollment(w.groupId, deviceId)).not.toBeNull();
		expect(await listed(w)).toEqual([person.removal]);
	});

	test("add-device by the removed identity does not lift the removal", async ({ fixture: f }) => {
		const w = await world(f);
		const person = await removedPerson(w);
		const addDevice = await addDeviceInvitation(w, person.identityId, "added-device");

		expect((await addDevice()).status).toBe("accepted");

		expect(await listed(w)).toEqual([person.removal]);
	});

	test("a new enrollment under the removed identity, as account linking, rejoin and owner enrollment write, does not lift the removal", async ({
		fixture: f,
	}) => {
		const w = await world(f);
		const person = await removedPerson(w);
		const key = await removalDeviceKey(`${f.prefix}-linked`);

		await f.store.enrollDevice(w.groupId, {
			deviceId: `${f.prefix}-linked`,
			publicKey: key.publicKey,
			fingerprint: key.fingerprint,
			identityId: person.identityId,
		});

		expect(await listed(w)).toEqual([person.removal]);
	});
}

async function addDeviceInvitation(
	w: World,
	identityId: string,
	name: string,
	options: { joinProofVerified?: boolean } = {},
) {
	const reviewedIntent = {
		version: 1,
		journey: "add_device",
		targetIdentity: { identityId, displayName: "Recipient" },
		projects: [],
		excludedProjects: [],
	};
	const invite = await w.f.store.createInvite({
		groupId: w.groupId,
		policy: "auto_admit",
		expiresAt: "2099-01-01T00:00:00Z",
		inviteKind: "add_device",
		inviterDeviceId: w.inviterDeviceId,
		targetIdentityId: identityId,
		reviewedIntent,
		reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
	});
	const key = await removalDeviceKey(`${w.f.prefix}-${name}`);
	return () =>
		w.f.store.consumeRecipientInvite({
			token: invite.token,
			inviteKind: "add_device",
			identityId,
			deviceId: `${w.f.prefix}-${name}`,
			publicKey: key.publicKey,
			fingerprint: key.fingerprint,
			recipientDisplayName: "Recipient",
			deviceDisplayName: "Recipient device",
			now: ACCEPTED_AT,
			...options,
		});
}
