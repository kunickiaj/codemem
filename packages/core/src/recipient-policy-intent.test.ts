import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRecipientPolicyIntent } from "./recipient-policy-intent.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-10T12:00:00.000Z";

describe("recipient policy intent status projection", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => db.close());

	it("never normalizes unknown statuses to active", () => {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-a', 'Ada', 0, 'future_status', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES ('team-a', 'Team A', 'future_status', 'user', 'revision-team',
			 'user_managed', 'key-team', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES ('team-a', 'identity-a', 'member', 'future_status', 'user',
			 'revision-membership', 'user_managed', 'key-membership', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'future_status', 'user',
			 'revision-device', 'user_managed', 'key-device', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES ('project-a', 'identity', 'identity-a', 'future_status', 'user',
			 'revision-recipient', 'user_managed', 'key-recipient', ?, ?)`,
		).run(NOW, NOW);

		const intent = listRecipientPolicyIntent(db);

		expect(intent.identities[0]?.status).toBe("pending");
		expect(intent.teams[0]?.status).toBe("archived");
		expect(intent.teamMemberships[0]?.status).toBe("revoked");
		expect(intent.identityDevices[0]?.status).toBe("revoked");
		expect(intent.projectRecipients[0]?.status).toBe("revoked");
	});

	it("maps reviewed_active publicly only for reviewed_allowlist Teams", () => {
		for (const [teamId, mode, membershipStatus] of [
			["team-normal", "person_all_devices", "reviewed_active"],
			["team-reviewed", "reviewed_allowlist", "reviewed_active"],
			["team-reviewed-mismatch", "reviewed_allowlist", "active"],
			["team-unknown-mode", "future_mode", "active"],
		] as const) {
			db.prepare(
				`INSERT INTO policy_teams(
				 team_id, display_name, status, device_eligibility_mode, provenance, revision,
				 migration_state, idempotency_key, created_at, updated_at
				 ) VALUES (?, ?, 'active', ?, 'user', ?, 'user_managed', ?, ?, ?)`,
			).run(teamId, teamId, mode, `revision-${teamId}`, `key-${teamId}`, NOW, NOW);
			db.prepare(
				`INSERT INTO policy_team_memberships(
				 team_id, identity_id, role, status, provenance, revision, migration_state,
				 idempotency_key, created_at, updated_at
				 ) VALUES (?, ?, 'member', ?, 'user', ?, 'user_managed', ?, ?, ?)`,
			).run(
				teamId,
				`identity-${teamId}`,
				membershipStatus,
				`revision-membership-${teamId}`,
				`key-membership-${teamId}`,
				NOW,
				NOW,
			);
		}

		expect(
			listRecipientPolicyIntent(db).teamMemberships.map(({ teamId, status }) => ({
				teamId,
				status,
			})),
		).toEqual([
			{ teamId: "team-normal", status: "revoked" },
			{ teamId: "team-reviewed", status: "active" },
			{ teamId: "team-reviewed-mismatch", status: "revoked" },
			{ teamId: "team-unknown-mode", status: "revoked" },
		]);
	});
});
