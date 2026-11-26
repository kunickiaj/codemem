import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileCoordinatorEnrollmentSnapshot } from "./coordinator-enrollment-reconciler.js";
import { connect } from "./db.js";
import { applyTeamMemberRemovals } from "./team-member-removal-policy.js";

const NOW = "2026-07-26T00:00:00.000Z";

describe("reconciling accepted invitations of people removed from a Team", () => {
	let dir: string;
	let db: DatabaseType;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "coordinator-enrollment-team-removals-"));
		db = connect(join(dir, "test.sqlite"));
		db.prepare(`INSERT INTO policy_teams(
			team_id, display_name, status, provenance, revision, migration_state,
			source_fingerprint, idempotency_key, created_at, updated_at
		) VALUES ('team-a', 'Team A', 'active', 'test', 'r1', 'user_managed', 's1', 'i1', ?, ?)`).run(
			NOW,
			NOW,
		);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("never adds back a member removed from the Team, whichever accepted invitation names them", async () => {
		const invite = {
			invite_id: "invite-team",
			group_id: "group-a",
			policy_team_id: "team-a",
			assigned_identity_id: "identity-team",
			recipient_actor_id: "identity-team",
			bound_device_id: "device-team",
			consumed_at: NOW,
		};
		const input = (consumedTeamInvites: (typeof invite)[]) => ({
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			now: NOW,
			consumedTeamInvites,
			enrollments: [],
		});
		const membership = () =>
			db
				.prepare(
					"SELECT status FROM policy_team_memberships WHERE team_id = 'team-a' AND identity_id = 'identity-team'",
				)
				.pluck()
				.get();
		await reconcileCoordinatorEnrollmentSnapshot(db, input([invite]));
		expect(membership()).toBe("active");

		applyTeamMemberRemovals(db, {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			removals: [
				{
					group_id: "group-a",
					team_id: "team-a",
					identity_id: "identity-team",
					removal_seq: 1,
					removed_at: NOW,
					removed_by_device_id: null,
				},
			],
			now: NOW,
		});
		const replay = await reconcileCoordinatorEnrollmentSnapshot(
			db,
			input([invite, { ...invite, invite_id: "invite-older" }]),
		);

		expect(membership()).toBe("revoked");
		expect(replay.membershipsAdded).toBe(0);
		expect(replay.issues.toSorted((a, b) => a.referenceId.localeCompare(b.referenceId))).toEqual([
			{ kind: "team_membership", referenceId: "invite-older", code: "team_member_removed" },
			{ kind: "team_membership", referenceId: "invite-team", code: "team_member_removed" },
		]);
	});
});
