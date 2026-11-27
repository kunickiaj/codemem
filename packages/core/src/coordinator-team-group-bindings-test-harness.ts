import { expect, it } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import { removalDeviceKey } from "./coordinator-device-removal-test-harness.js";
import { recipientReviewedIntentDigest } from "./recipient-reviewed-intent.js";

/** A store, raw SQL access to its database, and a prefix no other test uses. */
export interface TeamGroupBindingFixture {
	store: Store;
	prefix: string;
	exec(sql: string, ...values: (string | number)[]): Promise<unknown>;
	count(sql: string, ...values: (string | number)[]): Promise<number>;
}

export function teamGroupBindingHarness(
	fixture: (use: (f: TeamGroupBindingFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: TeamGroupBindingFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
export type TeamGroupBindingTest = ReturnType<typeof teamGroupBindingHarness>;

/** The clock every fixture injects into its store. */
export const TEAM_GROUP_BINDING_CLOCK_MS = Date.UTC(2026, 10, 26, 12, 0, 0);

type World = Awaited<ReturnType<typeof world>>;

/** Two groups, each with an enrolled inviting device, and one Team ID. */
async function world(f: TeamGroupBindingFixture) {
	const groups = [`${f.prefix}-group-a`, `${f.prefix}-group-b`] as const;
	for (const groupId of groups) {
		await f.store.createGroup(groupId);
		const key = await removalDeviceKey(`${groupId}-inviter`);
		await f.store.enrollDevice(groupId, {
			deviceId: `${groupId}-inviter`,
			publicKey: key.publicKey,
			fingerprint: key.fingerprint,
			identityId: "identity:inviter",
		});
	}
	return { f, groups, teamId: `${f.prefix}-team` };
}

/** Mints a Team invitation for the world's Team from one group. */
async function mint(w: World, groupId: string) {
	const reviewedIntent = {
		version: 1,
		journey: "team",
		team: { teamId: w.teamId, displayName: "Team", futureProjectsInherit: true },
		projects: [],
		excludedProjects: [],
	};
	return w.f.store.createInvite({
		groupId,
		policy: "auto_admit",
		expiresAt: "2099-01-01T00:00:00Z",
		inviteKind: "team_member",
		inviterDeviceId: `${groupId}-inviter`,
		policyTeamId: w.teamId,
		reviewedIntent,
		reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
	});
}

const invitations = (w: World, groupId: string) =>
	w.f.count(
		"SELECT COUNT(*) AS n FROM coordinator_invites WHERE group_id = ? AND policy_team_id = ?",
		groupId,
		w.teamId,
	);

/** A Team invitation from before bindings existed: a row with no binding. */
const priorInvitation = (w: World, groupId: string, inviteId: string) =>
	w.f.exec(
		`INSERT INTO coordinator_invites(invite_id, group_id, token, policy, expires_at, created_at, invite_kind, policy_team_id)
		 VALUES (?, ?, ?, 'auto_admit', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'team_member', ?)`,
		inviteId,
		groupId,
		`${inviteId}-token`,
		w.teamId,
	);

const read = async (w: World) => (await w.f.store.readTeamGroupBindings([w.teamId]))[0];

export function registerTeamGroupBindingContract(test: TeamGroupBindingTest): void {
	registerMintBindings(test);
	registerAdminBindings(test);
}

function registerMintBindings(test: TeamGroupBindingTest): void {
	test("binds a Team ID to the group of its first Team invitation", async ({ fixture }) => {
		const w = await world(fixture);
		const [a] = w.groups;
		expect(await read(w)).toEqual({ team_id: w.teamId, state: "unbound" });

		await mint(w, a);
		await mint(w, a);

		expect(await read(w)).toEqual({ team_id: w.teamId, state: "bound", group_id: a });
		expect(await invitations(w, a)).toBe(2);
	});

	test("refuses a Team invitation from another group and writes nothing", async ({ fixture }) => {
		const w = await world(fixture);
		const [a, b] = w.groups;
		await mint(w, a);

		await expect(mint(w, b)).rejects.toThrow("team_bound_to_other_group");

		expect(await invitations(w, b)).toBe(0);
		expect(await read(w)).toEqual({ team_id: w.teamId, state: "bound", group_id: a });
	});

	test("refuses Team invitations for a Team ID that two groups used until an admin binds it", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const [a, b] = w.groups;
		await priorInvitation(w, a, `${w.f.prefix}-prior-a`);
		await priorInvitation(w, b, `${w.f.prefix}-prior-b`);
		expect(await read(w)).toEqual({ team_id: w.teamId, state: "conflict" });

		await expect(mint(w, a)).rejects.toThrow("team_binding_conflict");
		await expect(mint(w, b)).rejects.toThrow("team_binding_conflict");
		expect(await invitations(w, a)).toBe(1);

		expect(await w.f.store.bindTeamGroup({ teamId: w.teamId, groupId: a })).toEqual({
			status: "created",
			binding: { team_id: w.teamId, group_id: a },
		});
		await mint(w, a);
		await expect(mint(w, b)).rejects.toThrow("team_bound_to_other_group");
		expect(await invitations(w, a)).toBe(2);
		expect(await invitations(w, b)).toBe(1);
	});
}

function registerAdminBindings(test: TeamGroupBindingTest): void {
	test("binds by admin once, never to a second group, and not to an unknown group", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const [a, b] = w.groups;
		await expect(
			w.f.store.bindTeamGroup({ teamId: w.teamId, groupId: `${w.f.prefix}-missing` }),
		).rejects.toThrow("group_not_found");
		await w.f.store.bindTeamGroup({ teamId: w.teamId, groupId: a });

		expect((await w.f.store.bindTeamGroup({ teamId: w.teamId, groupId: a })).status).toBe(
			"existing",
		);
		await expect(w.f.store.bindTeamGroup({ teamId: w.teamId, groupId: b })).rejects.toThrow(
			"team_bound_to_other_group",
		);
		expect(await read(w)).toEqual({ team_id: w.teamId, state: "bound", group_id: a });
	});

	test("keeps every binding as written", async ({ fixture }) => {
		const w = await world(fixture);
		const [a, b] = w.groups;
		await mint(w, a);

		await expect(
			w.f.exec(
				"UPDATE coordinator_team_group_bindings SET group_id = ? WHERE team_id = ?",
				b,
				w.teamId,
			),
		).rejects.toThrow(/team_group_binding_immutable/u);
		await expect(
			w.f.exec("DELETE FROM coordinator_team_group_bindings WHERE team_id = ?", w.teamId),
		).rejects.toThrow(/team_group_binding_immutable/u);
		expect(await read(w)).toEqual({ team_id: w.teamId, state: "bound", group_id: a });
	});

	test("refuses a read of no Team, too many Teams, or a malformed ID", async ({ fixture }) => {
		await expect(fixture.store.readTeamGroupBindings([])).rejects.toThrow("invalid_input");
		await expect(
			fixture.store.readTeamGroupBindings(Array.from({ length: 51 }, (_, i) => `team-${i}`)),
		).rejects.toThrow("invalid_input");
		await expect(fixture.store.readTeamGroupBindings(["bad\u0000id"])).rejects.toThrow(
			"invalid_input",
		);
	});
}
