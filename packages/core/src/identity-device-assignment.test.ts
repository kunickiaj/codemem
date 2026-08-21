import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assignIdentityDeviceInTransaction,
	type IdentityDeviceAssignmentError,
} from "./identity-device-assignment.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-21T12:00:00.000Z";
const LATER = "2026-08-21T13:00:00.000Z";

function insertValues(deviceId: string) {
	return {
		displayName: `Device ${deviceId}`,
		provenance: "test",
		revision: `revision-${deviceId}`,
		migrationState: "user_managed",
		idempotencyKey: `identity-device-${deviceId}`,
	};
}

describe("assignIdentityDeviceInTransaction", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => db.close());

	function assign(
		input: Parameters<typeof assignIdentityDeviceInTransaction>[1],
	): ReturnType<typeof assignIdentityDeviceInTransaction> {
		return db.transaction(() => assignIdentityDeviceInTransaction(db, input))();
	}

	function seedAssignment(deviceId = "device-a", identityId = "identity-a"): void {
		assign({
			deviceId,
			targetIdentityId: identityId,
			expectation: { kind: "absent" },
			insert: insertValues(deviceId),
			now: NOW,
		});
	}

	function seedReviewedTeam(
		teamId: string,
		deviceId: string,
		decision: "included" | "excluded" | "unresolved" = "included",
	): void {
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance, revision,
			 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, 'active', 'reviewed_allowlist', 'test', ?, 'user_managed', ?, ?, ?, ?)`,
		).run(
			teamId,
			`Team ${teamId}`,
			`revision-${teamId}`,
			`fingerprint-${teamId}`,
			`policy-team-${teamId}`,
			NOW,
			NOW,
		);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
			 team_id, device_id, decision, assignment_version, provenance, revision,
			 created_at, updated_at
			 ) VALUES (?, ?, ?, 0, 'test', ?, ?, ?)`,
		).run(teamId, deviceId, decision, `decision-${teamId}`, NOW, NOW);
	}

	it("inserts a missing assignment for an absent expectation", () => {
		const result = assign({
			deviceId: "device-a",
			targetIdentityId: "identity-a",
			expectation: { kind: "absent" },
			insert: insertValues("device-a"),
			now: NOW,
		});

		expect(result).toEqual({
			assignmentVersion: 0,
			changed: true,
			invalidatedDecisionCount: 0,
			invalidatedTeamCount: 0,
		});
		expect(
			db.prepare("SELECT identity_id, assignment_version, updated_at FROM identity_devices").get(),
		).toEqual({ identity_id: "identity-a", assignment_version: 0, updated_at: NOW });
	});

	it("rejects an absent expectation when a row appeared", () => {
		seedAssignment();

		expect(() =>
			assign({
				deviceId: "device-a",
				targetIdentityId: "identity-b",
				expectation: { kind: "absent" },
				insert: insertValues("device-a"),
				now: LATER,
			}),
		).toThrowError(
			expect.objectContaining<Partial<IdentityDeviceAssignmentError>>({
				code: "team_setup_assignment_changed",
			}),
		);
	});

	it("preserves unrelated insert constraint errors", () => {
		seedAssignment("device-a");

		expect(() =>
			assign({
				deviceId: "device-b",
				targetIdentityId: "identity-b",
				expectation: { kind: "absent" },
				insert: {
					...insertValues("device-b"),
					idempotencyKey: "identity-device-device-a",
				},
				now: LATER,
			}),
		).toThrowError(expect.objectContaining({ code: "SQLITE_CONSTRAINT_UNIQUE" }));
	});

	it("reassigns when the existing expectation matches", () => {
		seedAssignment();

		const result = assign({
			deviceId: "device-a",
			targetIdentityId: "identity-b",
			expectation: { kind: "existing", identityId: "identity-a", assignmentVersion: 0 },
			now: LATER,
		});

		expect(result.assignmentVersion).toBe(1);
		expect(result.changed).toBe(true);
		expect(
			db.prepare("SELECT identity_id, assignment_version FROM identity_devices").get(),
		).toEqual({ identity_id: "identity-b", assignment_version: 1 });
	});

	it("rejects a stale assignment version", () => {
		seedAssignment();
		assign({
			deviceId: "device-a",
			targetIdentityId: "identity-b",
			expectation: { kind: "existing", identityId: "identity-a", assignmentVersion: 0 },
			now: LATER,
		});

		expect(() =>
			assign({
				deviceId: "device-a",
				targetIdentityId: "identity-c",
				expectation: {
					kind: "existing",
					identityId: "identity-b",
					assignmentVersion: 0,
				},
				now: LATER,
			}),
		).toThrowError(
			expect.objectContaining<Partial<IdentityDeviceAssignmentError>>({
				code: "team_setup_assignment_changed",
			}),
		);
	});

	it("keeps a matching active assignment as a true no-op", () => {
		seedAssignment();
		seedReviewedTeam("team-a", "device-a");

		const result = assign({
			deviceId: "device-a",
			targetIdentityId: "identity-a",
			expectation: { kind: "existing", identityId: "identity-a", assignmentVersion: 0 },
			now: LATER,
		});

		expect(result).toEqual({
			assignmentVersion: 0,
			changed: false,
			invalidatedDecisionCount: 0,
			invalidatedTeamCount: 0,
		});
		expect(db.prepare("SELECT assignment_version, updated_at FROM identity_devices").get()).toEqual(
			{ assignment_version: 0, updated_at: NOW },
		);
		expect(db.prepare("SELECT decision FROM policy_team_device_decisions").pluck().get()).toBe(
			"included",
		);
		expect(db.prepare("SELECT source_fingerprint FROM policy_teams").pluck().get()).toBe(
			"fingerprint-team-a",
		);
	});

	it("invalidates included decisions across reviewed Teams only", () => {
		seedAssignment();
		seedReviewedTeam("team-a", "device-a");
		seedReviewedTeam("team-b", "device-a");
		seedReviewedTeam("team-excluded", "device-a", "excluded");
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance, revision,
			 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES ('team-person', 'Person Team', 'active', 'person_all_devices', 'test',
			 'revision-person', 'user_managed', 'fingerprint-person', 'policy-team-person', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
			 team_id, device_id, decision, assignment_version, provenance, revision,
			 created_at, updated_at
			 ) VALUES ('team-person', 'device-a', 'included', 0, 'test', 'decision-person', ?, ?)`,
		).run(NOW, NOW);

		const result = assign({
			deviceId: "device-a",
			targetIdentityId: "identity-b",
			expectation: { kind: "existing", identityId: "identity-a", assignmentVersion: 0 },
			now: LATER,
		});

		expect(result).toMatchObject({
			assignmentVersion: 1,
			invalidatedDecisionCount: 2,
			invalidatedTeamCount: 2,
		});
		expect(
			db
				.prepare("SELECT team_id, decision FROM policy_team_device_decisions ORDER BY team_id")
				.all(),
		).toEqual([
			{ team_id: "team-a", decision: "unresolved" },
			{ team_id: "team-b", decision: "unresolved" },
			{ team_id: "team-excluded", decision: "excluded" },
			{ team_id: "team-person", decision: "included" },
		]);
		expect(
			db.prepare("SELECT team_id, source_fingerprint FROM policy_teams ORDER BY team_id").all(),
		).toEqual([
			{ team_id: "team-a", source_fingerprint: null },
			{ team_id: "team-b", source_fingerprint: null },
			{ team_id: "team-excluded", source_fingerprint: "fingerprint-team-excluded" },
			{ team_id: "team-person", source_fingerprint: "fingerprint-person" },
		]);
	});

	it("rejects calls outside a transaction", () => {
		expect(() =>
			assignIdentityDeviceInTransaction(db, {
				deviceId: "device-a",
				targetIdentityId: "identity-a",
				expectation: { kind: "absent" },
				insert: insertValues("device-a"),
				now: NOW,
			}),
		).toThrowError(
			expect.objectContaining<Partial<IdentityDeviceAssignmentError>>({
				code: "identity_device_assignment_transaction_required",
			}),
		);
	});
});
