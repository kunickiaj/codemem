import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileCoordinatorEnrollmentSnapshot } from "./coordinator-enrollment-reconciler.js";
import { connect } from "./db.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";

const NOW = "2026-07-26T00:00:00.000Z";

describe("reconcileCoordinatorEnrollmentSnapshot", () => {
	let dir: string;
	let db: DatabaseType;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "coordinator-enrollment-reconciler-"));
		db = connect(join(dir, "test.sqlite"));
		db.prepare(`INSERT INTO policy_teams(
			team_id, display_name, status, provenance, revision, migration_state,
			source_fingerprint, idempotency_key, created_at, updated_at
		) VALUES ('team-a', 'Team A', 'active', 'test', 'r1', 'user_managed', 's1', 'i1', ?, ?)`).run(
			NOW,
			NOW,
		);
		db.prepare(`INSERT INTO actors(
			actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
		) VALUES ('identity-direct', 'Direct recipient', 0, 'active', NULL, ?, ?)`).run(NOW, NOW);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("materializes accepted Team membership and new devices idempotently", () => {
		const input = {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			now: NOW,
			consumedTeamInvites: [
				{
					invite_id: "invite-team",
					group_id: "group-a",
					policy_team_id: "team-a",
					assigned_identity_id: "identity-team",
					recipient_actor_id: "identity-team",
					recipient_display_name: "Brian Example",
					recipient_device_display_name: "Brian's MacBook",
					bound_device_id: "device-team",
					consumed_at: NOW,
				},
			],
			enrollments: [
				{
					group_id: "group-a",
					device_id: "owner-device",
					public_key: "pk-owner",
					fingerprint: "fp-owner",
					identity_id: null,
					display_name: "Owner laptop",
					enabled: 1,
					created_at: NOW,
				},
				{
					group_id: "group-a",
					device_id: "device-team",
					public_key: "pk-team",
					fingerprint: "fp-team",
					identity_id: "identity-team",
					display_name: "Brian's MacBook",
					enabled: 1,
					created_at: NOW,
				},
				{
					group_id: "group-a",
					device_id: "device-direct-2",
					public_key: "pk-direct",
					fingerprint: "fp-direct",
					identity_id: "identity-direct",
					display_name: "Second laptop",
					enabled: 1,
					created_at: NOW,
				},
			],
		};

		expect(reconcileCoordinatorEnrollmentSnapshot(db, input)).toEqual({
			devicesAdded: 2,
			membershipsAdded: 1,
			identitiesAdded: 1,
			unchanged: 0,
			issues: [],
		});
		expect(reconcileCoordinatorEnrollmentSnapshot(db, input)).toEqual({
			devicesAdded: 0,
			membershipsAdded: 0,
			identitiesAdded: 0,
			unchanged: 3,
			issues: [],
		});
		expect(db.prepare("SELECT identity_id FROM identity_devices ORDER BY device_id").all()).toEqual(
			[{ identity_id: "identity-direct" }, { identity_id: "identity-team" }],
		);
		expect(db.prepare("SELECT actor_id FROM sync_peers ORDER BY peer_device_id").all()).toEqual([]);
		expect(
			db.prepare("SELECT display_name FROM actors WHERE actor_id = 'identity-team'").pluck().get(),
		).toBe("Brian Example");
		expect(
			db
				.prepare("SELECT display_name FROM identity_devices WHERE device_id = 'device-team'")
				.pluck()
				.get(),
		).toBe("Brian's MacBook");
		db.prepare(`INSERT INTO project_recipients(
			canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			policy_revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
		) VALUES
			('project-a', 'identity', 'identity-direct', 'active', 'test', 'r1', 'user_managed',
			 'project-direct', 'project-direct', ?, ?),
			('project-a', 'team', 'team-a', 'active', 'test', 'r1', 'user_managed',
			 'project-team', 'project-team', ?, ?)`).run(NOW, NOW, NOW, NOW);
		expect(
			deriveRecipientPolicyEffectiveDevicesFromDatabase(db, "project-a").devices.map(
				(device) => device.deviceId,
			),
		).toEqual(["device-direct-2", "device-team"]);
	});

	it("uses legacy Team member and enrolled device fallbacks when names are absent", () => {
		const result = reconcileCoordinatorEnrollmentSnapshot(db, {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			now: NOW,
			consumedTeamInvites: [
				{
					invite_id: "invite-legacy-names",
					group_id: "group-a",
					policy_team_id: "team-a",
					assigned_identity_id: "identity-legacy",
					recipient_actor_id: "identity-legacy",
					bound_device_id: "device-legacy",
					consumed_at: NOW,
				},
			],
			enrollments: [
				{
					group_id: "group-a",
					device_id: "device-legacy",
					public_key: "pk-legacy",
					fingerprint: "fp-legacy",
					identity_id: "identity-legacy",
					display_name: null,
					enabled: 1,
					created_at: NOW,
				},
			],
		});

		expect(result.issues).toEqual([]);
		expect(
			db
				.prepare("SELECT display_name FROM actors WHERE actor_id = 'identity-legacy'")
				.pluck()
				.get(),
		).toBe("Team member");
		expect(
			db
				.prepare("SELECT display_name FROM identity_devices WHERE device_id = 'device-legacy'")
				.pluck()
				.get(),
		).toBe("Enrolled device");
	});

	it("uses neutral fallbacks when optional presentation names are malformed", () => {
		const result = reconcileCoordinatorEnrollmentSnapshot(db, {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			now: NOW,
			consumedTeamInvites: [
				{
					invite_id: "invite-malformed-names",
					group_id: "group-a",
					policy_team_id: "team-a",
					assigned_identity_id: "identity-malformed-names",
					recipient_actor_id: "identity-malformed-names",
					recipient_display_name: "Brian\u0000",
					recipient_device_display_name: "x".repeat(121),
					bound_device_id: "device-malformed-names",
					consumed_at: NOW,
				},
			],
			enrollments: [
				{
					group_id: "group-a",
					device_id: "device-malformed-names",
					public_key: "pk-malformed-names",
					fingerprint: "fp-malformed-names",
					identity_id: "identity-malformed-names",
					display_name: "x".repeat(121),
					enabled: 1,
					created_at: NOW,
				},
			],
		});

		expect(result).toMatchObject({ identitiesAdded: 1, membershipsAdded: 1, devicesAdded: 1 });
		expect(result.issues).toEqual([]);
		expect(
			db
				.prepare("SELECT display_name FROM actors WHERE actor_id = 'identity-malformed-names'")
				.pluck()
				.get(),
		).toBe("Team member");
		expect(
			db
				.prepare(
					"SELECT display_name FROM identity_devices WHERE device_id = 'device-malformed-names'",
				)
				.pluck()
				.get(),
		).toBe("Enrolled device");
	});

	it("refreshes coordinator-managed device names without overwriting local names", () => {
		db.prepare(`INSERT INTO identity_devices(
			device_id, identity_id, display_name, status, provenance, revision, migration_state,
			source_fingerprint, idempotency_key, created_at, updated_at
		) VALUES ('device-local', 'identity-direct', 'My custom name', 'active', 'manual', 'r1',
			'user_managed', 's1', 'local-device', ?, ?)`).run(NOW, NOW);
		const input = {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			now: NOW,
			consumedTeamInvites: [],
			enrollments: [
				{
					group_id: "group-a",
					device_id: "device-coordinator",
					public_key: "pk-coordinator",
					fingerprint: "fp-coordinator",
					identity_id: "identity-direct",
					display_name: "Original name",
					enabled: 1,
					created_at: NOW,
				},
				{
					group_id: "group-a",
					device_id: "device-local",
					public_key: "pk-local",
					fingerprint: "fp-local",
					identity_id: "identity-direct",
					display_name: "Coordinator name",
					enabled: 1,
					created_at: NOW,
				},
			],
		};

		reconcileCoordinatorEnrollmentSnapshot(db, input);
		input.enrollments[0].display_name = "Renamed device";
		reconcileCoordinatorEnrollmentSnapshot(db, input);

		expect(
			db.prepare("SELECT device_id, display_name FROM identity_devices ORDER BY device_id").all(),
		).toEqual([
			{ device_id: "device-coordinator", display_name: "Renamed device" },
			{ device_id: "device-local", display_name: "My custom name" },
		]);

		reconcileCoordinatorEnrollmentSnapshot(db, {
			...input,
			enrollments: input.enrollments.map((enrollment) => ({
				...enrollment,
				display_name: null,
			})),
		});
		expect(
			db.prepare("SELECT device_id, display_name FROM identity_devices ORDER BY device_id").all(),
		).toEqual([
			{ device_id: "device-coordinator", display_name: "Renamed device" },
			{ device_id: "device-local", display_name: "My custom name" },
		]);
	});

	it("preserves an owner-revoked Team membership when the consumed invite is replayed", () => {
		db.prepare(`INSERT INTO actors(
			actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
		) VALUES ('identity-team', 'Former member', 0, 'active', NULL, ?, ?)`).run(NOW, NOW);
		db.prepare(`INSERT INTO policy_team_memberships(
			team_id, identity_id, role, status, provenance, revision, migration_state,
			source_fingerprint, idempotency_key, created_at, updated_at
		) VALUES ('team-a', 'identity-team', 'member', 'revoked', 'manual', 'r1',
			'user_managed', 'revoked-source', 'revoked-membership', ?, ?)`).run(NOW, NOW);

		const result = reconcileCoordinatorEnrollmentSnapshot(db, {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			now: NOW,
			enrollments: [],
			consumedTeamInvites: [
				{
					invite_id: "invite-replayed",
					group_id: "group-a",
					policy_team_id: "team-a",
					assigned_identity_id: "identity-team",
					recipient_actor_id: "identity-team",
					bound_device_id: "device-team",
					consumed_at: NOW,
				},
			],
		});

		expect(result.issues).toEqual([
			{
				kind: "team_membership",
				referenceId: "invite-replayed",
				code: "membership_not_active",
			},
		]);
		expect(
			db
				.prepare(
					"SELECT status FROM policy_team_memberships WHERE team_id = 'team-a' AND identity_id = 'identity-team'",
				)
				.pluck()
				.get(),
		).toBe("revoked");
	});

	it("preserves an owner-revoked device when its enrollment is replayed", () => {
		db.prepare(`INSERT INTO identity_devices(
			device_id, identity_id, display_name, status, provenance, revision, migration_state,
			source_fingerprint, idempotency_key, created_at, updated_at
		) VALUES ('device-revoked', 'identity-direct', 'Revoked device', 'revoked', 'manual', 'r1',
			'user_managed', 'revoked-source', 'revoked-device', ?, ?)`).run(NOW, NOW);

		const result = reconcileCoordinatorEnrollmentSnapshot(db, {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			now: NOW,
			consumedTeamInvites: [],
			enrollments: [
				{
					group_id: "group-a",
					device_id: "device-revoked",
					public_key: "pk-revoked",
					fingerprint: "fp-revoked",
					identity_id: "identity-direct",
					display_name: "Coordinator name",
					enabled: 1,
					created_at: NOW,
				},
			],
		});

		expect(result.issues).toEqual([
			{ kind: "device", referenceId: "device-revoked", code: "device_identity_conflict" },
		]);
		expect(
			db
				.prepare("SELECT status FROM identity_devices WHERE device_id = 'device-revoked'")
				.pluck()
				.get(),
		).toBe("revoked");
	});

	it("rejects a consumed Team invite bound to a local actor", () => {
		db.prepare(`INSERT INTO actors(
			actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
		) VALUES ('identity-local-team', 'Local actor', 1, 'active', NULL, ?, ?)`).run(NOW, NOW);

		const result = reconcileCoordinatorEnrollmentSnapshot(db, {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			now: NOW,
			enrollments: [],
			consumedTeamInvites: [
				{
					invite_id: "invite-local-actor",
					group_id: "group-a",
					policy_team_id: "team-a",
					assigned_identity_id: "identity-local-team",
					recipient_actor_id: "identity-local-team",
					bound_device_id: "device-local-team",
					consumed_at: NOW,
				},
			],
		});

		expect(result).toEqual({
			devicesAdded: 0,
			membershipsAdded: 0,
			identitiesAdded: 0,
			unchanged: 0,
			issues: [
				{
					kind: "team_membership",
					referenceId: "invite-local-actor",
					code: "identity_not_active",
				},
			],
		});
		expect(
			db
				.prepare(
					"SELECT COUNT(*) FROM policy_team_memberships WHERE team_id = 'team-a' AND identity_id = 'identity-local-team'",
				)
				.pluck()
				.get(),
		).toBe(0);
	});

	it("rejects a coordinator device enrollment bound to a local actor", () => {
		db.prepare(`INSERT INTO actors(
			actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
		) VALUES ('identity-local-device', 'Local actor', 1, 'active', NULL, ?, ?)`).run(NOW, NOW);

		const result = reconcileCoordinatorEnrollmentSnapshot(db, {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			localDeviceId: "device-this-machine",
			now: NOW,
			consumedTeamInvites: [],
			enrollments: [
				{
					group_id: "group-a",
					device_id: "device-local-actor",
					public_key: "pk-local-actor",
					fingerprint: "fp-local-actor",
					identity_id: "identity-local-device",
					display_name: "Foreign device",
					enabled: 1,
					created_at: NOW,
				},
			],
		});

		expect(result).toEqual({
			devicesAdded: 0,
			membershipsAdded: 0,
			identitiesAdded: 0,
			unchanged: 0,
			issues: [
				{
					kind: "device",
					referenceId: "device-local-actor",
					code: "identity_not_active",
				},
			],
		});
		expect(
			db
				.prepare("SELECT COUNT(*) FROM identity_devices WHERE device_id = 'device-local-actor'")
				.pluck()
				.get(),
		).toBe(0);
	});

	it("accepts local and sibling device enrollments after proving the local Identity binding", () => {
		db.prepare(`INSERT INTO actors(
			actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
		) VALUES ('identity-local-device', 'Local actor', 1, 'active', NULL, ?, ?)`).run(NOW, NOW);

		const result = reconcileCoordinatorEnrollmentSnapshot(db, {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			localDeviceId: "device-local-actor",
			now: NOW,
			consumedTeamInvites: [],
			enrollments: [
				{
					group_id: "group-a",
					device_id: "device-local-actor",
					public_key: "pk-local-actor",
					fingerprint: "fp-local-actor",
					identity_id: "identity-local-device",
					display_name: "This device",
					enabled: 1,
					created_at: NOW,
				},
				{
					group_id: "group-a",
					device_id: "device-sibling",
					public_key: "pk-sibling",
					fingerprint: "fp-sibling",
					identity_id: "identity-local-device",
					display_name: "Sibling device",
					enabled: 1,
					created_at: NOW,
				},
			],
		});

		expect(result).toMatchObject({ devicesAdded: 2, issues: [] });
		expect(
			db.prepare("SELECT device_id FROM identity_devices ORDER BY device_id").pluck().all(),
		).toEqual(["device-local-actor", "device-sibling"]);
	});

	it("fails closed on conflicting or inactive owner policy state", () => {
		db.prepare(`INSERT INTO actors(
			actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
		) VALUES ('identity-other', 'Other', 0, 'active', NULL, ?, ?)`).run(NOW, NOW);
		db.prepare(`INSERT INTO identity_devices(
			device_id, identity_id, display_name, status, provenance, revision, migration_state,
			source_fingerprint, idempotency_key, created_at, updated_at
		) VALUES ('device-conflict', 'identity-other', 'Other device', 'active', 'test', 'r2',
			'user_managed', 's2', 'i2', ?, ?)`).run(NOW, NOW);
		db.prepare("UPDATE actors SET status = 'deactivated' WHERE actor_id = 'identity-direct'").run();

		const result = reconcileCoordinatorEnrollmentSnapshot(db, {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			now: NOW,
			consumedTeamInvites: [],
			enrollments: [
				{
					group_id: "group-a",
					device_id: "device-conflict",
					public_key: "pk",
					fingerprint: "fp",
					identity_id: "identity-direct",
					display_name: null,
					enabled: 1,
					created_at: NOW,
				},
			],
		});
		expect(result.issues).toEqual([
			{ kind: "device", referenceId: "device-conflict", code: "identity_not_active" },
		]);
		expect(
			db
				.prepare("SELECT identity_id FROM identity_devices WHERE device_id = 'device-conflict'")
				.pluck()
				.get(),
		).toBe("identity-other");
	});

	it("persists, deduplicates, resolves, and reopens issue lifecycle", () => {
		const issueEnrollment = {
			group_id: "group-a",
			device_id: "device-conflict",
			public_key: "pk",
			fingerprint: "fp",
			identity_id: "missing-identity",
			display_name: null,
			enabled: 1,
			created_at: NOW,
		};
		const input = {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			now: NOW,
			consumedTeamInvites: [],
			enrollments: [issueEnrollment, issueEnrollment],
		};

		expect(reconcileCoordinatorEnrollmentSnapshot(db, input).issues).toHaveLength(1);
		expect(
			db
				.prepare("SELECT occurrence_count FROM coordinator_enrollment_reconciliation_issues")
				.pluck()
				.get(),
		).toBe(1);
		reconcileCoordinatorEnrollmentSnapshot(db, {
			...input,
			now: "2026-07-26T00:01:00.000Z",
		});
		expect(
			db
				.prepare(`SELECT status, first_seen_at, last_seen_at, resolved_at, occurrence_count
				FROM coordinator_enrollment_reconciliation_issues`)
				.get(),
		).toEqual({
			status: "open",
			first_seen_at: NOW,
			last_seen_at: "2026-07-26T00:01:00.000Z",
			resolved_at: null,
			occurrence_count: 2,
		});

		reconcileCoordinatorEnrollmentSnapshot(db, {
			...input,
			now: "2026-07-26T00:02:00.000Z",
			enrollments: [],
		});
		expect(
			db
				.prepare(`SELECT status, resolved_at FROM coordinator_enrollment_reconciliation_issues`)
				.get(),
		).toEqual({ status: "resolved", resolved_at: "2026-07-26T00:02:00.000Z" });

		reconcileCoordinatorEnrollmentSnapshot(db, {
			...input,
			now: "2026-07-26T00:03:00.000Z",
		});
		expect(
			db
				.prepare(`SELECT status, first_seen_at, resolved_at, occurrence_count
				FROM coordinator_enrollment_reconciliation_issues`)
				.get(),
		).toEqual({ status: "open", first_seen_at: NOW, resolved_at: null, occurrence_count: 3 });
	});

	it("treats changed codes distinctly and isolates coordinator/group boundaries", () => {
		const reconcile = (coordinatorId: string, groupId: string, now: string) =>
			reconcileCoordinatorEnrollmentSnapshot(db, {
				coordinatorId,
				groupId,
				now,
				consumedTeamInvites: [],
				enrollments: [
					{
						group_id: groupId,
						device_id: "device-shared",
						public_key: "pk",
						fingerprint: "fp",
						identity_id: "missing-identity",
						display_name: null,
						enabled: 1,
						created_at: now,
					},
				],
			});
		reconcile("https://coord-a.example.test", "group-a", NOW);
		reconcile("https://coord-a.example.test", "group-b", "2026-07-26T00:01:00.000Z");
		reconcile("https://coord-b.example.test", "group-a", "2026-07-26T00:02:00.000Z");
		db.prepare(`INSERT INTO actors(
			actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
		) VALUES ('missing-identity', 'Now active', 0, 'active', NULL, ?, ?)`).run(NOW, NOW);
		db.prepare(`INSERT INTO identity_devices(
			device_id, identity_id, display_name, status, provenance, revision, migration_state,
			source_fingerprint, idempotency_key, created_at, updated_at
		) VALUES ('device-shared', 'identity-direct', 'Existing', 'active', 'manual', 'r1',
			'user_managed', 'source', 'device-shared', ?, ?)`).run(NOW, NOW);
		reconcile("https://coord-a.example.test", "group-a", "2026-07-26T00:03:00.000Z");

		expect(
			db
				.prepare(`SELECT coordinator_id, group_id, code, status
				FROM coordinator_enrollment_reconciliation_issues
				ORDER BY coordinator_id, group_id, code`)
				.all(),
		).toEqual([
			{
				coordinator_id: "https://coord-a.example.test",
				group_id: "group-a",
				code: "device_identity_conflict",
				status: "open",
			},
			{
				coordinator_id: "https://coord-a.example.test",
				group_id: "group-a",
				code: "identity_not_active",
				status: "resolved",
			},
			{
				coordinator_id: "https://coord-a.example.test",
				group_id: "group-b",
				code: "identity_not_active",
				status: "open",
			},
			{
				coordinator_id: "https://coord-b.example.test",
				group_id: "group-a",
				code: "identity_not_active",
				status: "open",
			},
		]);
	});

	it("rolls policy and lifecycle changes back together", () => {
		db.prepare(`INSERT INTO coordinator_enrollment_reconciliation_issues(
			coordinator_id, group_id, kind, reference_id, code, status,
			first_seen_at, last_seen_at, occurrence_count, updated_at
		) VALUES ('https://coord.example.test', 'group-a', 'device', 'prior-device',
			'prior_code', 'open', ?, ?, 1, ?)`).run(NOW, NOW, NOW);
		db.exec(`CREATE TRIGGER fail_issue_insert
			BEFORE INSERT ON coordinator_enrollment_reconciliation_issues
			BEGIN SELECT RAISE(ABORT, 'injected issue failure'); END`);

		expect(() =>
			reconcileCoordinatorEnrollmentSnapshot(db, {
				coordinatorId: "https://coord.example.test",
				groupId: "group-a",
				now: NOW,
				enrollments: [
					{
						group_id: "group-a",
						device_id: "device-issue",
						public_key: "pk-issue",
						fingerprint: "fp-issue",
						identity_id: "missing-identity",
						display_name: null,
						enabled: 1,
						created_at: NOW,
					},
				],
				consumedTeamInvites: [
					{
						invite_id: "invite-rollback",
						group_id: "group-a",
						policy_team_id: "team-a",
						assigned_identity_id: "identity-rollback",
						recipient_actor_id: "identity-rollback",
						bound_device_id: "device-rollback",
						consumed_at: NOW,
					},
				],
			}),
		).toThrow("injected issue failure");
		expect(
			db.prepare("SELECT COUNT(*) FROM actors WHERE actor_id = 'identity-rollback'").pluck().get(),
		).toBe(0);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) FROM policy_team_memberships WHERE identity_id = 'identity-rollback'",
				)
				.pluck()
				.get(),
		).toBe(0);
		expect(
			db
				.prepare(`SELECT reference_id, status, resolved_at
				FROM coordinator_enrollment_reconciliation_issues`)
				.get(),
		).toEqual({ reference_id: "prior-device", status: "open", resolved_at: null });
	});

	it("hashes invalid remote reference IDs before returning or persisting diagnostics", () => {
		const unsafeReferenceId = `device-secret\n${"x".repeat(300)}`;

		const result = reconcileCoordinatorEnrollmentSnapshot(db, {
			coordinatorId: "https://coord.example.test",
			groupId: "group-a",
			now: NOW,
			consumedTeamInvites: [],
			enrollments: [
				{
					group_id: "group-a",
					device_id: unsafeReferenceId,
					public_key: "pk",
					fingerprint: "fp",
					identity_id: "identity-direct",
					display_name: null,
					enabled: 1,
					created_at: NOW,
				},
			],
		});

		expect(result.issues).toEqual([
			{
				kind: "device",
				referenceId: expect.stringMatching(/^invalid-reference:[a-f0-9]{64}$/u),
				code: "enrollment_invalid",
			},
		]);
		const persistedReferenceId = db
			.prepare("SELECT reference_id FROM coordinator_enrollment_reconciliation_issues")
			.pluck()
			.get();
		expect(persistedReferenceId).toBe(result.issues[0]?.referenceId);
		expect(String(persistedReferenceId)).not.toContain("secret");
	});
});
