import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileCoordinatorEnrollmentSnapshot } from "./coordinator-enrollment-reconciler.js";
import { connect } from "./db.js";
import { applyTeamMemberRemovals } from "./team-member-removal-policy.js";
import { linkTeamToCoordinatorGroup } from "./team-member-removal-test-fixtures.js";

const NOW = "2026-07-26T00:00:00.000Z";
const COORDINATOR = "https://coord.example.test";

describe("reconciling accepted invitations of people removed from a Team", () => {
	let dir: string;
	let db: DatabaseType;
	let team: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "coordinator-enrollment-team-removals-"));
		db = connect(join(dir, "test.sqlite"));
		team = linkTeamToCoordinatorGroup(db, {
			candidateId: "candidate-a",
			coordinatorId: COORDINATOR,
			groupId: "group-a",
		});
		db.prepare(`INSERT INTO policy_teams(
			team_id, display_name, status, provenance, revision, migration_state,
			source_fingerprint, idempotency_key, created_at, updated_at
		) VALUES (?, 'Team A', 'active', 'test', 'r1', 'user_managed', 's1', 'i1', ?, ?)`).run(
			team,
			NOW,
			NOW,
		);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const invite = (inviteId = "invite-team") => ({
		invite_id: inviteId,
		group_id: "group-a",
		policy_team_id: team,
		assigned_identity_id: "identity-team",
		recipient_actor_id: "identity-team",
		bound_device_id: "device-team",
		consumed_at: NOW,
	});
	const reconcile = (invites: ReturnType<typeof invite>[]) =>
		reconcileCoordinatorEnrollmentSnapshot(db, {
			coordinatorId: COORDINATOR,
			groupId: "group-a",
			now: NOW,
			consumedTeamInvites: invites,
			enrollments: [],
		});
	const membership = () =>
		db
			.prepare(
				"SELECT status FROM policy_team_memberships WHERE team_id = ? AND identity_id = 'identity-team'",
			)
			.pluck()
			.get(team);
	const removeFrom = (groupId: string) =>
		applyTeamMemberRemovals(db, {
			coordinatorId: COORDINATOR,
			groupId,
			removals: [
				{
					group_id: groupId,
					team_id: team,
					identity_id: "identity-team",
					removal_seq: 1,
					removed_at: NOW,
					removed_by_device_id: null,
				},
			],
			now: NOW,
		});

	it("never adds back a member removed from the Team, whichever accepted invitation names them", async () => {
		await reconcile([invite()]);
		expect(membership()).toBe("active");

		removeFrom("group-a");
		const replay = await reconcile([invite(), invite("invite-older")]);

		expect(membership()).toBe("revoked");
		expect(replay.membershipsAdded).toBe(0);
		expect(replay.issues.toSorted((a, b) => a.referenceId.localeCompare(b.referenceId))).toEqual([
			{ kind: "team_membership", referenceId: "invite-older", code: "team_member_removed" },
			{ kind: "team_membership", referenceId: "invite-team", code: "team_member_removed" },
		]);
	});

	it("ignores a removal from another group, which cannot remove a member of this Team", async () => {
		await reconcile([invite()]);

		const result = removeFrom("group-b");
		const replay = await reconcile([invite()]);

		expect(result).toMatchObject({
			revoked: [],
			ignored: [{ teamId: team, identityId: "identity-team" }],
		});
		expect(membership()).toBe("active");
		expect(replay.issues).toEqual([]);
	});
});
