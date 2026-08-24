import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import {
	commitDeviceIdentityBindings,
	previewDeviceIdentityBindings,
} from "./device-identity-binding.js";
import type { DeviceIdentityInventoryInput } from "./device-identity-inventory.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-18T12:00:00.000Z";

function enrollment(deviceId: string): CoordinatorEnrollment {
	return {
		group_id: "group-a",
		device_id: deviceId,
		public_key: `${deviceId}-key`,
		fingerprint: fingerprintPublicKey(`${deviceId}-key`),
		identity_id: null,
		display_name: deviceId,
		enabled: 1,
		created_at: NOW,
	};
}

describe("device Identity binding", () => {
	let db: InstanceType<typeof Database>;
	let inventoryInput: DeviceIdentityInventoryInput;
	const context = {
		localActorId: "identity-local",
		localDeviceId: "device-local",
		now: () => NOW,
	};

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-local', 'Local', 1, 'active', ?, ?),
			 ('identity-other', 'Other', 0, 'active', ?, ?)`,
		).run(NOW, NOW, NOW, NOW);
		db.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		).run("device-local", "local-key", fingerprintPublicKey("local-key"), NOW);
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, public_key, pinned_fingerprint, created_at)
			 VALUES ('device-peer', 'Peer', 'peer-key', ?, ?)`,
		).run(fingerprintPublicKey("peer-key"), NOW);
		inventoryInput = {
			localDeviceId: "device-local",
			coordinator: { availability: "available", safeErrorCode: null, enrollments: [] },
		};
	});

	afterEach(() => db.close());

	it("binds an explicitly confirmed individual device", () => {
		const request = {
			bindings: [
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const result = commitDeviceIdentityBindings(db, context, inventoryInput, {
			...request,
			reviewedInventoryDigest: preview.reviewedInventoryDigest,
		});

		expect(result).toMatchObject({ status: "applied", writeCount: 1, idempotent: false });
		expect(
			db
				.prepare("SELECT identity_id FROM identity_devices WHERE device_id = 'device-peer'")
				.pluck()
				.get(),
		).toBe("identity-other");
	});

	it("requires explicit confirmation for the local device and commits a confirmed batch atomically", () => {
		const unconfirmed = previewDeviceIdentityBindings(db, inventoryInput, {
			bindings: [
				{
					deviceId: "device-local",
					targetIdentityId: "identity-local",
					confirmed: false,
				},
			],
		});
		expect(unconfirmed).toMatchObject({ status: "invalid", errorCode: "binding_request_invalid" });

		const request = {
			bindings: [
				{
					deviceId: "device-local",
					targetIdentityId: "identity-local",
					confirmed: true,
				},
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const result = commitDeviceIdentityBindings(db, context, inventoryInput, {
			...request,
			reviewedInventoryDigest: preview.reviewedInventoryDigest,
		});
		expect(result).toMatchObject({ status: "applied", writeCount: 2 });
	});

	it("rejects coordinator-only devices until they are paired", () => {
		inventoryInput.coordinator.enrollments = [enrollment("device-coordinator")];
		const result = previewDeviceIdentityBindings(db, inventoryInput, {
			bindings: [
				{
					deviceId: "device-coordinator",
					targetIdentityId: "identity-local",
					confirmed: true,
				},
			],
		});

		expect(result).toMatchObject({ status: "conflict", errorCode: "device_pairing_required" });
	});

	it("rejects stale, conflicted, incomplete, and truncated evidence", () => {
		const request = {
			bindings: [
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		db.prepare(
			`UPDATE sync_peers SET public_key = 'changed-key', pinned_fingerprint = ?
			 WHERE peer_device_id = 'device-peer'`,
		).run(fingerprintPublicKey("changed-key"));
		expect(
			commitDeviceIdentityBindings(db, context, inventoryInput, {
				...request,
				reviewedInventoryDigest: preview.reviewedInventoryDigest,
			}),
		).toMatchObject({ status: "stale", errorCode: "binding_evidence_stale" });

		db.prepare(
			"UPDATE sync_peers SET public_key = 'key-a', pinned_fingerprint = ? WHERE peer_device_id = 'device-peer'",
		).run(fingerprintPublicKey("key-b"));
		expect(previewDeviceIdentityBindings(db, inventoryInput, request)).toMatchObject({
			status: "conflict",
			errorCode: "device_evidence_conflict",
		});

		inventoryInput.coordinator = {
			availability: "unavailable",
			safeErrorCode: "coordinator_unavailable",
			enrollments: [],
		};
		expect(previewDeviceIdentityBindings(db, inventoryInput, request)).toMatchObject({
			status: "conflict",
			errorCode: "device_inventory_incomplete",
		});

		inventoryInput.coordinator = {
			availability: "available",
			safeErrorCode: null,
			enrollments: [],
		};
		const insert = db.prepare(
			"INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES (?, ?, ?)",
		);
		db.transaction(() => {
			for (let index = 0; index < 2_001; index += 1) {
				insert.run(`overflow-${index}`, `Overflow ${index}`, NOW);
			}
		})();
		expect(previewDeviceIdentityBindings(db, inventoryInput, request)).toMatchObject({
			status: "conflict",
			errorCode: "device_inventory_truncated",
		});
	});

	it("permits confirmed local-only setup when the coordinator is not configured", () => {
		inventoryInput.coordinator = {
			availability: "unavailable",
			safeErrorCode: "coordinator_not_configured",
			enrollments: [],
		};
		const request = {
			bindings: [
				{
					deviceId: "device-local",
					targetIdentityId: "identity-local",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const result = commitDeviceIdentityBindings(db, context, inventoryInput, {
			...request,
			reviewedInventoryDigest: preview.reviewedInventoryDigest,
		});

		expect(preview.status).toBe("ready");
		expect(result).toMatchObject({ status: "applied", writeCount: 1 });
	});

	it("rejects local-only setup when configured coordinator evidence is unavailable", () => {
		inventoryInput.coordinator = {
			availability: "unavailable",
			safeErrorCode: "coordinator_unavailable",
			enrollments: [],
		};
		const result = previewDeviceIdentityBindings(db, inventoryInput, {
			bindings: [
				{
					deviceId: "device-local",
					targetIdentityId: "identity-local",
					confirmed: true,
				},
			],
		});

		expect(result).toMatchObject({
			status: "conflict",
			errorCode: "device_inventory_incomplete",
		});
	});

	it("does not stale a selected binding when unrelated inventory display evidence changes", () => {
		const request = {
			bindings: [
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES ('unrelated', 'Before', ?)",
		).run(NOW);
		db.prepare("UPDATE sync_peers SET name = 'After' WHERE peer_device_id = 'unrelated'").run();
		const result = commitDeviceIdentityBindings(db, context, inventoryInput, {
			...request,
			reviewedInventoryDigest: preview.reviewedInventoryDigest,
		});

		expect(result).toMatchObject({ status: "applied", writeCount: 1 });
	});

	it("rolls back the full batch when one audited write fails", () => {
		db.exec(`CREATE TRIGGER fail_second_binding_audit
			BEFORE INSERT ON device_identity_binding_audit
			WHEN NEW.device_id = 'device-peer'
			BEGIN SELECT RAISE(ABORT, 'audit failed'); END`);
		const request = {
			bindings: [
				{
					deviceId: "device-local",
					targetIdentityId: "identity-local",
					confirmed: true,
				},
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const result = commitDeviceIdentityBindings(db, context, inventoryInput, {
			...request,
			reviewedInventoryDigest: preview.reviewedInventoryDigest,
		});

		expect(result).toMatchObject({ status: "conflict", writeCount: 0 });
		expect(db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_commits").pluck().get()).toBe(
			0,
		);
	});

	it("makes an exact retry idempotent", () => {
		const request = {
			bindings: [
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const commit = { ...request, reviewedInventoryDigest: preview.reviewedInventoryDigest };
		expect(commitDeviceIdentityBindings(db, context, inventoryInput, commit).idempotent).toBe(
			false,
		);
		expect(commitDeviceIdentityBindings(db, context, inventoryInput, commit)).toMatchObject({
			status: "applied",
			writeCount: 0,
			idempotent: true,
		});
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_audit").pluck().get()).toBe(1);
	});

	it("fails closed when the deciding local actor is active but merged", () => {
		const request = {
			bindings: [
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		db.prepare(
			"UPDATE actors SET merged_into_actor_id = 'identity-other' WHERE actor_id = 'identity-local'",
		).run();

		expect(
			commitDeviceIdentityBindings(db, context, inventoryInput, {
				...request,
				reviewedInventoryDigest: preview.reviewedInventoryDigest,
			}),
		).toMatchObject({
			status: "invalid",
			errorCode: "deciding_identity_unavailable",
			writeCount: 0,
		});
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_commits").pluck().get()).toBe(
			0,
		);
	});

	it.each([
		{ status: "deactivated", mergedIntoIdentityId: null },
		{ status: "merged", mergedIntoIdentityId: "identity-local" },
	])("rejects an exact retry after its target identity becomes $status", ({
		status,
		mergedIntoIdentityId,
	}) => {
		const request = {
			bindings: [
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const commit = { ...request, reviewedInventoryDigest: preview.reviewedInventoryDigest };
		expect(commitDeviceIdentityBindings(db, context, inventoryInput, commit)).toMatchObject({
			status: "applied",
			writeCount: 1,
			idempotent: false,
		});
		db.prepare(
			"UPDATE actors SET status = ?, merged_into_actor_id = ? WHERE actor_id = 'identity-other'",
		).run(status, mergedIntoIdentityId);

		expect(commitDeviceIdentityBindings(db, context, inventoryInput, commit)).toMatchObject({
			status: "stale",
			errorCode: "binding_retry_stale",
			writeCount: 0,
			idempotent: false,
		});
		expect(
			db
				.prepare("SELECT identity_id, status FROM identity_devices WHERE device_id = 'device-peer'")
				.get(),
		).toEqual({ identity_id: "identity-other", status: "active" });
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_audit").pluck().get()).toBe(1);
	});

	it("rejects an exact retry after device evidence becomes conflicted", () => {
		const request = {
			bindings: [
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const commit = { ...request, reviewedInventoryDigest: preview.reviewedInventoryDigest };
		expect(commitDeviceIdentityBindings(db, context, inventoryInput, commit)).toMatchObject({
			status: "applied",
			writeCount: 1,
		});
		db.prepare(
			"UPDATE sync_peers SET pinned_fingerprint = ? WHERE peer_device_id = 'device-peer'",
		).run(fingerprintPublicKey("rotated-key"));

		expect(commitDeviceIdentityBindings(db, context, inventoryInput, commit)).toMatchObject({
			status: "conflict",
			errorCode: "device_evidence_conflict",
			writeCount: 0,
			idempotent: false,
		});
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_audit").pluck().get()).toBe(1);
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_commits").pluck().get()).toBe(
			1,
		);
	});

	it("rejects an exact retry when inventory evidence is incomplete or truncated", () => {
		const request = {
			bindings: [
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const commit = { ...request, reviewedInventoryDigest: preview.reviewedInventoryDigest };
		expect(commitDeviceIdentityBindings(db, context, inventoryInput, commit).status).toBe(
			"applied",
		);

		expect(
			commitDeviceIdentityBindings(
				db,
				context,
				{
					...inventoryInput,
					coordinator: {
						availability: "unavailable",
						safeErrorCode: "coordinator_unavailable",
						enrollments: [],
					},
				},
				commit,
			),
		).toMatchObject({
			status: "conflict",
			errorCode: "device_inventory_incomplete",
			writeCount: 0,
			idempotent: false,
		});

		const insert = db.prepare(
			"INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES (?, ?, ?)",
		);
		db.transaction(() => {
			for (let index = 0; index < 2_001; index += 1) {
				insert.run(`overflow-${index}`, `Overflow ${index}`, NOW);
			}
		})();
		expect(commitDeviceIdentityBindings(db, context, inventoryInput, commit)).toMatchObject({
			status: "conflict",
			errorCode: "device_inventory_truncated",
			writeCount: 0,
			idempotent: false,
		});
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_audit").pluck().get()).toBe(1);
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_commits").pluck().get()).toBe(
			1,
		);
	});

	it("audits an explicitly confirmed unchanged binding without mutating it", () => {
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES ('device-peer', 'identity-other', 'Peer', 'active',
			 'coordinator_enrollment', 'revision-a', 'user_managed', 'key-a', ?, ?)`,
		).run(NOW, NOW);
		const before = db
			.prepare("SELECT * FROM identity_devices WHERE device_id = 'device-peer'")
			.get();
		const request = {
			bindings: [
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const result = commitDeviceIdentityBindings(db, context, inventoryInput, {
			...request,
			reviewedInventoryDigest: preview.reviewedInventoryDigest,
		});

		expect(result).toMatchObject({ status: "applied", writeCount: 0 });
		expect(
			db.prepare("SELECT * FROM identity_devices WHERE device_id = 'device-peer'").get(),
		).toEqual(before);
		expect(
			db
				.prepare(
					`SELECT action, previous_identity_id, target_identity_id,
				 previous_assignment_version, resulting_assignment_version
				 FROM device_identity_binding_audit`,
				)
				.get(),
		).toEqual({
			action: "unchanged",
			previous_identity_id: "identity-other",
			target_identity_id: "identity-other",
			previous_assignment_version: 0,
			resulting_assignment_version: 0,
		});
	});

	it("rolls back a batch when a planned bind finds a live row at the write boundary", () => {
		db.exec(`CREATE TRIGGER conflict_planned_bind
			AFTER INSERT ON device_identity_binding_commits
			BEGIN
				INSERT INTO identity_devices(
				 device_id, identity_id, display_name, status, provenance, revision, migration_state,
				 idempotency_key, created_at, updated_at
				 ) VALUES ('device-peer', 'identity-local', 'Concurrent peer', 'active',
				 'user_confirmed_identity_setup', 'concurrent-revision', 'user_managed',
				 'concurrent-key', '${NOW}', '${NOW}');
			END`);
		const request = {
			bindings: [
				{
					deviceId: "device-local",
					targetIdentityId: "identity-local",
					confirmed: true,
				},
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const result = commitDeviceIdentityBindings(db, context, inventoryInput, {
			...request,
			reviewedInventoryDigest: preview.reviewedInventoryDigest,
		});

		expect(result).toMatchObject({ status: "conflict", errorCode: "binding_write_conflict" });
		expect(db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_commits").pluck().get()).toBe(
			0,
		);
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_audit").pluck().get()).toBe(0);
	});

	it("rolls back when a planned rebind no longer matches the live previous identity", () => {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-third', 'Third', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES ('device-peer', 'identity-local', 'Peer', 'active',
			 'user_confirmed_identity_setup', 'revision-a', 'user_managed', 'key-a', ?, ?)`,
		).run(NOW, NOW);
		db.exec(`CREATE TRIGGER stale_planned_rebind
			AFTER INSERT ON device_identity_binding_commits
			BEGIN
				UPDATE identity_devices SET identity_id = 'identity-third'
				WHERE device_id = 'device-peer';
			END`);
		const request = {
			bindings: [
				{
					deviceId: "device-peer",
					targetIdentityId: "identity-other",
					confirmed: true,
					allowRebind: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const result = commitDeviceIdentityBindings(db, context, inventoryInput, {
			...request,
			reviewedInventoryDigest: preview.reviewedInventoryDigest,
		});

		expect(result).toMatchObject({ status: "stale", errorCode: "binding_rebind_stale" });
		expect(
			db
				.prepare("SELECT identity_id FROM identity_devices WHERE device_id = 'device-peer'")
				.pluck()
				.get(),
		).toBe("identity-local");
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_commits").pluck().get()).toBe(
			0,
		);
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_audit").pluck().get()).toBe(0);
	});

	it("requires explicit rebind confirmation and preserves audited assignment history", () => {
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES ('device-peer', 'identity-local', 'Peer', 'active',
			 'user_confirmed_identity_setup', 'revision-a', 'user_managed', 'key-a', ?, ?)`,
		).run(NOW, NOW);
		const base = {
			deviceId: "device-peer",
			targetIdentityId: "identity-other",
			confirmed: true,
		};
		expect(previewDeviceIdentityBindings(db, inventoryInput, { bindings: [base] })).toMatchObject({
			status: "conflict",
			errorCode: "device_rebind_confirmation_required",
		});
		const request = { bindings: [{ ...base, allowRebind: true }] };
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const result = commitDeviceIdentityBindings(db, context, inventoryInput, {
			...request,
			reviewedInventoryDigest: preview.reviewedInventoryDigest,
		});

		expect(result).toMatchObject({ status: "applied", outcomes: [{ action: "rebind" }] });
		expect(
			db
				.prepare(
					`SELECT previous_identity_id, target_identity_id, action,
				 previous_assignment_version, resulting_assignment_version
				 FROM device_identity_binding_audit`,
				)
				.get(),
		).toEqual({
			previous_identity_id: "identity-local",
			target_identity_id: "identity-other",
			action: "rebind",
			previous_assignment_version: 0,
			resulting_assignment_version: 1,
		});
	});

	it("rebinds the uniquely active binding alias in a fingerprint group", () => {
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, public_key, pinned_fingerprint, created_at)
			 VALUES ('binding-alias', 'Alias', 'local-key', ?, ?)`,
		).run(fingerprintPublicKey("local-key"), NOW);
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES ('binding-alias', 'identity-local', 'Alias', 'active',
			 'user_confirmed_identity_setup', 'revision-a', 'user_managed', 'key-a', ?, ?)`,
		).run(NOW, NOW);
		const request = {
			bindings: [
				{
					deviceId: "device-local",
					targetIdentityId: "identity-other",
					confirmed: true,
					allowRebind: true,
				},
			],
		};

		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		expect(preview).toMatchObject({
			status: "ready",
			outcomes: [
				{
					deviceId: "binding-alias",
					previousIdentityId: "identity-local",
					action: "rebind",
				},
			],
		});
		const commit = { ...request, reviewedInventoryDigest: preview.reviewedInventoryDigest };
		expect(commitDeviceIdentityBindings(db, context, inventoryInput, commit)).toMatchObject({
			status: "applied",
			outcomes: [{ deviceId: "binding-alias", action: "rebind" }],
		});
		expect(
			db
				.prepare("SELECT identity_id FROM identity_devices WHERE device_id = 'binding-alias'")
				.pluck()
				.get(),
		).toBe("identity-other");
		expect(
			db
				.prepare("SELECT COUNT(*) FROM identity_devices WHERE device_id = 'device-local'")
				.pluck()
				.get(),
		).toBe(0);
		expect(db.prepare("SELECT device_id FROM device_identity_binding_audit").pluck().get()).toBe(
			"binding-alias",
		);
		expect(commitDeviceIdentityBindings(db, context, inventoryInput, commit)).toMatchObject({
			status: "applied",
			writeCount: 0,
			idempotent: true,
		});
	});

	it("rejects multiple active binding aliases in one fingerprint group", () => {
		for (const alias of ["binding-alias-a", "binding-alias-b"]) {
			db.prepare(
				`INSERT INTO sync_peers(peer_device_id, name, public_key, pinned_fingerprint, created_at)
				 VALUES (?, ?, 'local-key', ?, ?)`,
			).run(alias, alias, fingerprintPublicKey("local-key"), NOW);
			db.prepare(
				`INSERT INTO identity_devices(
				 device_id, identity_id, display_name, status, provenance, revision, migration_state,
				 idempotency_key, created_at, updated_at
				 ) VALUES (?, 'identity-local', ?, 'active',
				 'user_confirmed_identity_setup', ?, 'user_managed', ?, ?, ?)`,
			).run(alias, alias, `revision-${alias}`, `key-${alias}`, NOW, NOW);
		}
		const before = db.prepare("SELECT * FROM identity_devices ORDER BY device_id").all();

		expect(
			previewDeviceIdentityBindings(db, inventoryInput, {
				bindings: [
					{
						deviceId: "device-local",
						targetIdentityId: "identity-other",
						confirmed: true,
						allowRebind: true,
					},
				],
			}),
		).toMatchObject({
			status: "conflict",
			errorCode: "device_evidence_conflict",
			outcomes: [],
			writeCount: 0,
		});
		expect(db.prepare("SELECT * FROM identity_devices ORDER BY device_id").all()).toEqual(before);
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_audit").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM device_identity_binding_commits").pluck().get()).toBe(
			0,
		);
	});

	it("does not mutate Projects, Team membership, sharing access, or synchronization", () => {
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES ('project-a', 'identity', 'identity-local', 'active', 'user',
			 'project-revision', 'user_managed', 'project-key', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance, revision,
			 migration_state, idempotency_key, created_at, updated_at
			 ) VALUES ('team-a', 'Team A', 'active', 'reviewed_devices', 'user', 'team-revision',
			 'user_managed', 'team-key', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES ('team-a', 'identity-other', 'member', 'active', 'user',
			 'membership-revision', 'user_managed', 'membership-key', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
			 team_id, device_id, decision, assignment_version, provenance, revision, created_at, updated_at
			 ) VALUES ('team-a', 'device-peer', 'included', 0, 'reviewed_setup',
			 'decision-revision', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, status, created_at, updated_at
			 ) VALUES ('scope-a', 'Scope A', 'team', 'local', 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO scope_memberships(
			 scope_id, device_id, role, status, membership_epoch, updated_at
			 ) VALUES ('scope-a', 'device-peer', 'member', 'active', 1, ?)`,
		).run(NOW);
		db.prepare(
			`UPDATE sync_peers SET trust_provenance = 'manual_pairing', claimed_local_actor = 1
			 WHERE peer_device_id = 'device-peer'`,
		).run();
		const tables = [
			"project_recipients",
			"policy_teams",
			"policy_team_memberships",
			"policy_team_device_decisions",
			"replication_scopes",
			"scope_memberships",
			"sync_peers",
		] as const;
		const before = Object.fromEntries(
			tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
		);
		expect(deriveRecipientPolicyEffectiveDevicesFromDatabase(db, "project-a").devices).toEqual([]);
		const request = {
			bindings: [
				{
					deviceId: "device-local",
					targetIdentityId: "identity-local",
					confirmed: true,
				},
			],
		};
		const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
		const result = commitDeviceIdentityBindings(db, context, inventoryInput, {
			...request,
			reviewedInventoryDigest: preview.reviewedInventoryDigest,
		});

		expect(result).toMatchObject({ status: "applied", writeCount: 1 });
		for (const table of tables) {
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[table]);
		}
		expect(deriveRecipientPolicyEffectiveDevicesFromDatabase(db, "project-a").devices).toEqual([
			expect.objectContaining({ deviceId: "device-local", identityId: "identity-local" }),
		]);
	});
});
