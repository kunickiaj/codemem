import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileCoordinatorEnrollmentSnapshot } from "./coordinator-enrollment-reconciler.js";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import { connect } from "./db.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import { resolveSameActorPeerIds } from "./same-actor-peers.js";

const NOW = "2026-10-27T00:00:00.000Z";
const OLD = "identity-old";
const NEW = "identity-new";

let dir: string;
let db: DatabaseType;

function insertActor(actorId: string, options: { local?: boolean } = {}) {
	db.prepare(`INSERT INTO actors(
		actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
	) VALUES (?, ?, ?, 'active', NULL, ?, ?)`).run(actorId, actorId, options.local ? 1 : 0, NOW, NOW);
}

/** A publisher that knows the device as OLD's, and shares a Project with a Team NEW is in. */
function seedPublisher(options: { deviceStatus?: string; provenance?: string } = {}) {
	insertActor(OLD);
	db.prepare(`INSERT INTO identity_devices(
		device_id, identity_id, display_name, status, provenance, revision, migration_state,
		idempotency_key, created_at, updated_at
	) VALUES ('device-d', ?, 'Laptop', ?, ?, 'r1', 'user_managed', 'device-d', ?, ?)`).run(
		OLD,
		options.deviceStatus ?? "active",
		options.provenance ?? "coordinator_enrollment",
		NOW,
		NOW,
	);
	db.prepare(`INSERT INTO policy_teams(
		team_id, display_name, status, provenance, revision, migration_state,
		idempotency_key, created_at, updated_at
	) VALUES ('team-a', 'Team A', 'active', 'test', 'r1', 'user_managed', 'team-a', ?, ?)`).run(
		NOW,
		NOW,
	);
	db.prepare(`INSERT INTO policy_team_memberships(
		team_id, identity_id, role, status, provenance, revision, migration_state,
		idempotency_key, created_at, updated_at
	) VALUES ('team-a', ?, 'member', 'active', 'test', 'r1', 'user_managed', 'm-new', ?, ?)`).run(
		NEW,
		NOW,
		NOW,
	);
	db.prepare(`INSERT INTO project_recipients(
		canonical_project_identity, recipient_kind, recipient_id, status, provenance,
		policy_revision, migration_state, idempotency_key, created_at, updated_at
	) VALUES ('project-a', 'team', 'team-a', 'active', 'test', '1', 'native', 'p-a', ?, ?)`).run(
		NOW,
		NOW,
	);
}

function enrollment(patch: Partial<CoordinatorEnrollment> = {}): CoordinatorEnrollment {
	return {
		group_id: "group-a",
		device_id: "device-d",
		public_key: "pk-d",
		fingerprint: "fp-d",
		identity_id: NEW,
		display_name: "Laptop",
		enabled: 1,
		created_at: NOW,
		ownership_identity_id: NEW,
		...patch,
	};
}

function reconcile(enrollments: CoordinatorEnrollment[], localDeviceId?: string) {
	return reconcileCoordinatorEnrollmentSnapshot(db, {
		coordinatorId: "https://coord.example.test",
		groupId: "group-a",
		now: NOW,
		consumedTeamInvites: [],
		enrollments,
		...(localDeviceId ? { localDeviceId } : {}),
	});
}

const deviceIdentity = () =>
	db.prepare("SELECT identity_id FROM identity_devices WHERE device_id = 'device-d'").pluck().get();

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "coordinator-enrollment-rebind-"));
	db = connect(join(dir, "test.sqlite"));
});
afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("a device the coordinator rebound to another Identity", () => {
	it("moves to that Identity and gets the Projects it already has", async () => {
		// Arrange
		seedPublisher();
		insertActor(NEW);
		// Act
		const result = await reconcile([enrollment()]);
		// Assert
		expect(result).toMatchObject({ devicesAdded: 1, issues: [] });
		expect(deviceIdentity()).toBe(NEW);
		expect(
			deriveRecipientPolicyEffectiveDevicesFromDatabase(db, "project-a").devices.map(
				(device) => device.deviceId,
			),
		).toEqual(["device-d"]);
	});

	it.each([
		["without an ownership binding", { ownership_identity_id: undefined }],
		["whose binding names another Identity", { ownership_identity_id: "identity-other" }],
	] as const)("stays a conflict for an Identity change %s", async (_label, patch) => {
		// Arrange
		seedPublisher();
		insertActor(NEW);
		// Act
		const result = await reconcile([enrollment(patch)]);
		// Assert
		expect(result.issues).toEqual([
			{ kind: "device", referenceId: "device-d", code: "device_identity_conflict" },
		]);
		expect(deviceIdentity()).toBe(OLD);
	});

	it("leaves a device this publisher revoked alone", async () => {
		// Arrange
		seedPublisher({ deviceStatus: "revoked" });
		insertActor(NEW);
		// Act
		const result = await reconcile([enrollment()]);
		// Assert
		expect(result.devicesAdded).toBe(0);
		expect(deviceIdentity()).toBe(OLD);
	});

	it("gets nothing when this publisher doesn't know the new Identity", async () => {
		// Arrange: NEW was never seen here, so it has no Projects to give.
		seedPublisher();
		// Act
		const result = await reconcile([enrollment()]);
		// Assert
		expect(result.issues).toEqual([
			{ kind: "device", referenceId: "device-d", code: "identity_not_active" },
		]);
		expect(deviceIdentity()).toBe(OLD);
	});

	it("never becomes one of this person's own devices on coordinator evidence alone", async () => {
		// Arrange: this publisher runs as NEW, and knew the device as OLD's through a review.
		seedPublisher({ provenance: "review_resolution" });
		insertActor(NEW, { local: true });
		const own = enrollment({ device_id: "device-p", public_key: "pk-p", fingerprint: "fp-p" });
		// Act
		await reconcile([own, enrollment()], "device-p");
		// Assert
		expect(deviceIdentity()).toBe(NEW);
		expect(resolveSameActorPeerIds(db, NEW)).not.toContain("device-d");
	});

	it("stays a conflict when the key this publisher pinned no longer matches", async () => {
		// Arrange
		seedPublisher();
		insertActor(NEW);
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
			 VALUES ('device-d', 'pk-old', 'fp-old', ?)`,
		).run(NOW);
		// Act
		const result = await reconcile([enrollment()]);
		// Assert
		expect(result.issues).toEqual([
			{ kind: "device", referenceId: "device-d", code: "device_identity_conflict" },
		]);
		expect(deviceIdentity()).toBe(OLD);
	});
});
