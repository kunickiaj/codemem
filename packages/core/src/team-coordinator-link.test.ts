import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileCoordinatorEnrollmentSnapshot } from "./coordinator-enrollment-reconciler.js";
import { connect } from "./db.js";
import { createRecipientPolicyTeam } from "./recipient-policy-team-create.js";
import { ensurePolicyTeamMemberRemovalsTable } from "./schema-bootstrap.js";
import {
	type CoordinatorTeamGroupBindingReport,
	isTeamMemberRemoved,
	teamCoordinatorLinkConflicts,
	teamCoordinatorLinkState,
	teamIdsForBindingRead,
} from "./team-member-removal-lookup.js";
import { applyTeamMemberRemovals } from "./team-member-removal-policy.js";
import { previewTeamMemberRemoval } from "./team-member-removal-review.js";
import { linkTeamToCoordinatorGroup } from "./team-member-removal-test-fixtures.js";

const NOW = "2026-07-26T00:00:00.000Z";
const COORDINATOR = "https://coord.example.test";
let dir: string;
let db: DatabaseType;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "team-coordinator-link-"));
	db = connect(join(dir, "test.sqlite"));
	db.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
	 VALUES ('identity-creator', 'Creator', 1, 'active', ?, ?)`).run(NOW, NOW);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function createTeam(teamId: string, groupId?: string) {
	createRecipientPolicyTeam(db, {
		displayName: `Team ${teamId}`,
		creatorIdentityId: "identity-creator",
		now: NOW,
		teamId,
		coordinatorGroup: groupId ? { coordinatorId: COORDINATOR, groupId } : undefined,
	});
}

type Binding = CoordinatorTeamGroupBindingReport;

/** An enrollment check for the group, with the binding reads the coordinator answered. */
function reconcile(
	groupId: string,
	teamId: string,
	options: { bindings: Binding[] | "not read"; removals?: Array<{ identity: string }> },
) {
	return reconcileCoordinatorEnrollmentSnapshot(db, {
		coordinatorId: COORDINATOR,
		groupId,
		now: NOW,
		localDeviceId: "device-local",
		enrollments: [],
		consumedTeamInvites: [
			{
				invite_id: `invite-${groupId}`,
				group_id: groupId,
				policy_team_id: teamId,
				assigned_identity_id: "identity-invited",
				recipient_actor_id: "identity-invited",
				bound_device_id: "device-invited",
				consumed_at: NOW,
			},
		],
		teamMemberRemovals: (options.removals ?? []).map((removal, index) => ({
			removal_seq: index + 1,
			group_id: groupId,
			team_id: teamId,
			identity_id: removal.identity,
			removed_by_device_id: null,
			removed_at: NOW,
		})),
		teamGroupBindings: options.bindings === "not read" ? undefined : options.bindings,
	});
}

const bound = (teamId: string, groupId: string): Binding => ({
	team_id: teamId,
	state: "bound",
	group_id: groupId,
});

const member = (teamId: string) =>
	db
		.prepare(
			"SELECT COUNT(*) FROM policy_team_memberships WHERE team_id = ? AND identity_id = 'identity-invited' AND status = 'active'",
		)
		.pluck()
		.get(teamId);

const codes = (result: Awaited<ReturnType<typeof reconcile>>) =>
	result.issues.filter((item) => item.kind === "team_membership").map((item) => item.code);

const preview = (teamId: string) =>
	previewTeamMemberRemoval(
		db,
		{ teamId, identityId: "identity-invited" },
		{
			coordinator: { remoteUrl: COORDINATOR, adminSecret: "synthetic", groupIds: ["group-a"] },
			localIdentityId: "identity-creator",
			localDeviceId: "device-local",
		},
	);

describe("a Team's coordinator group", () => {
	it("is recorded by the admin device that creates the Team", () => {
		createTeam("team-created", "group-a");

		expect(teamCoordinatorLinkState(db, "team-created")).toEqual({
			state: "linked",
			coordinatorId: COORDINATOR,
			groupId: "group-a",
		});
	});

	it("comes from the coordinator's binding, so the Team's removals apply and its invitations grant", async () => {
		createTeam("team-bound");

		const result = await reconcile("group-a", "team-bound", {
			bindings: [bound("team-bound", "group-a")],
			removals: [{ identity: "identity-removed" }],
		});

		expect(teamCoordinatorLinkState(db, "team-bound")).toMatchObject({
			state: "linked",
			groupId: "group-a",
		});
		expect(isTeamMemberRemoved(db, "team-bound", "identity-removed")).toBe(true);
		expect(member("team-bound")).toBe(1);
		expect(codes(result)).toEqual([]);
	});

	it("is never learned from an accepted invitation, which grants nothing without a binding", async () => {
		createTeam("team-invited");

		const result = await reconcile("group-a", "team-invited", {
			bindings: [{ team_id: "team-invited", state: "unbound" }],
		});
		const unread = await reconcile("group-a", "team-invited", { bindings: "not read" });

		// Not bound yet: no group, so nothing applies and nothing grants, but no conflict.
		expect(teamCoordinatorLinkState(db, "team-invited")).toEqual({ state: "none" });
		expect(teamCoordinatorLinkConflicts(db)).toEqual([]);
		expect(member("team-invited")).toBe(0);
		expect(codes(result)).toEqual(["team_group_unverified"]);
		expect(codes(unread)).toEqual(["team_group_bindings_unavailable"]);
	});

	it("applies a fresh removal to a Team with a known group when the bindings cannot be read", async () => {
		createTeam("team-known", "group-a");

		const result = await reconcile("group-a", "team-known", {
			bindings: "not read",
			removals: [{ identity: "identity-removed" }],
		});

		expect(isTeamMemberRemoved(db, "team-known", "identity-removed")).toBe(true);
		expect(member("team-known")).toBe(0);
		expect(codes(result)).toEqual(["team_group_bindings_unavailable"]);
	});

	it("is a conflict only when the coordinator reports Team invitations from more than one group", async () => {
		createTeam("team-shared");

		const result = await reconcile("group-a", "team-shared", {
			bindings: [{ team_id: "team-shared", state: "conflict" }],
		});

		expect(teamCoordinatorLinkState(db, "team-shared")).toEqual({ state: "conflict" });
		expect(codes(result)).toEqual(["team_group_conflict"]);
	});
});

describe("a Team's coordinator group when evidence disagrees or is missing", () => {
	it("holds back an invitation from another group than the Team's", async () => {
		createTeam("team-other", "group-b");

		const result = await reconcile("group-a", "team-other", {
			bindings: [bound("team-other", "group-b")],
		});

		expect(member("team-other")).toBe(0);
		expect(codes(result)).toEqual(["team_group_unverified"]);
	});

	it("is a conflict when the group recorded at creation disagrees with the binding: no new removal applies, and enforced ones stay", async () => {
		createTeam("team-claimed", "group-a");
		applyTeamMemberRemovals(db, {
			coordinatorId: COORDINATOR,
			groupId: "group-a",
			removals: [
				{
					removal_seq: 1,
					group_id: "group-a",
					team_id: "team-claimed",
					identity_id: "identity-removed",
					removed_by_device_id: null,
					removed_at: NOW,
				},
			],
			now: NOW,
		});
		expect(isTeamMemberRemoved(db, "team-claimed", "identity-removed")).toBe(true);

		const result = await reconcile("group-b", "team-claimed", {
			bindings: [bound("team-claimed", "group-b")],
			removals: [{ identity: "identity-invited" }],
		});

		expect(teamCoordinatorLinkState(db, "team-claimed")).toEqual({ state: "conflict" });
		expect(teamCoordinatorLinkConflicts(db)).toEqual(["team-claimed"]);
		expect(isTeamMemberRemoved(db, "team-claimed", "identity-removed")).toBe(true);
		expect(isTeamMemberRemoved(db, "team-claimed", "identity-invited")).toBe(false);
		expect(codes(result).toSorted()).toEqual([
			"team_group_conflict",
			"team_member_removal_other_group",
		]);
		expect(await preview("team-claimed")).toEqual({
			state: "rejected",
			error: "team_link_conflict",
		});
	});

	it("resolves once the coordinator reports a binding for a Team it held none for", async () => {
		createTeam("team-unbound");
		await reconcile("group-a", "team-unbound", {
			bindings: [{ team_id: "team-unbound", state: "conflict" }],
		});
		expect(teamCoordinatorLinkConflicts(db)).toEqual(["team-unbound"]);

		await reconcile("group-a", "team-unbound", { bindings: [bound("team-unbound", "group-a")] });
		await reconcile("group-a", "team-unbound", {
			bindings: [{ team_id: "team-unbound", state: "unbound" }],
		});

		expect(teamCoordinatorLinkState(db, "team-unbound")).toMatchObject({
			state: "linked",
			groupId: "group-a",
		});
		expect(member("team-unbound")).toBe(1);
	});

	it("keeps a created Team's group when its coordinator has not bound it yet", async () => {
		createTeam("team-new", "group-a");

		await reconcile("group-a", "team-new", {
			bindings: [{ team_id: "team-new", state: "unbound" }],
		});

		expect(teamCoordinatorLinkState(db, "team-new")).toMatchObject({ state: "linked" });
		expect(member("team-new")).toBe(1);
	});

	it("is a conflict when the Team's completed setup and the binding disagree", async () => {
		const team = linkTeamToCoordinatorGroup(db, {
			candidateId: "candidate-a",
			coordinatorId: COORDINATOR,
			groupId: "group-a",
		});
		db.prepare(`INSERT INTO policy_teams(team_id, display_name, status, provenance, revision,
		 migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, 'Set up', 'active', 'test', 'r1', 'user_managed', 'setup-team', ?, ?)`).run(
			team,
			NOW,
			NOW,
		);
		expect(teamCoordinatorLinkState(db, team)).toMatchObject({
			state: "linked",
			groupId: "group-a",
		});

		await reconcile("group-b", team, { bindings: [bound(team, "group-b")] });

		expect(teamCoordinatorLinkState(db, team)).toEqual({ state: "conflict" });
	});
});

describe("Teams whose binding an enrollment check reads", () => {
	it("are the invited Teams and every Team tied to this coordinator", () => {
		createTeam("team-created", "group-a");
		createTeam("team-elsewhere");
		db.prepare(`INSERT INTO policy_team_coordinator_links(team_id, coordinator_id, group_id, source, recorded_at)
		 VALUES ('team-far', 'https://other.example.test', 'group-a', 'team_create', ?)`).run(NOW);

		expect(
			teamIdsForBindingRead(db, {
				coordinatorId: `${COORDINATOR}/`,
				invitedTeamIds: ["team-invited", "team-created"],
			}),
		).toEqual(["team-created", "team-invited"]);
	});
});

describe("removals enforced before enforcement was recorded", () => {
	it("count as enforced when the Team's completed setup came from their group", () => {
		const team = linkTeamToCoordinatorGroup(db, {
			candidateId: "candidate-a",
			coordinatorId: COORDINATOR,
			groupId: "group-a",
		});
		db.exec("DROP TABLE policy_team_member_removal_enforcements");
		const insert = db.prepare(`INSERT INTO policy_team_member_removals(coordinator_id, group_id,
		 team_id, identity_id, removal_seq, removed_at, removed_by_device_id, recorded_at)
		 VALUES (?, ?, ?, ?, 1, ?, NULL, ?)`);
		insert.run(COORDINATOR, "group-a", team, "identity-setup-group", NOW, NOW);
		insert.run(COORDINATOR, "group-b", team, "identity-other-group", NOW, NOW);

		ensurePolicyTeamMemberRemovalsTable(db);

		expect(
			db.prepare("SELECT identity_id FROM policy_team_member_removal_enforcements").pluck().all(),
		).toEqual(["identity-setup-group"]);
	});
});
