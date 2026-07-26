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
			groupId: "group-a",
			now: NOW,
			consumedTeamInvites: [
				{
					invite_id: "invite-team",
					group_id: "group-a",
					policy_team_id: "team-a",
					assigned_identity_id: "identity-team",
					recipient_actor_id: "identity-team",
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
					display_name: "Team laptop",
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

	it("refreshes coordinator-managed device names without overwriting local names", () => {
		db.prepare(`INSERT INTO identity_devices(
			device_id, identity_id, display_name, status, provenance, revision, migration_state,
			source_fingerprint, idempotency_key, created_at, updated_at
		) VALUES ('device-local', 'identity-direct', 'My custom name', 'active', 'manual', 'r1',
			'user_managed', 's1', 'local-device', ?, ?)`).run(NOW, NOW);
		const input = {
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
});
