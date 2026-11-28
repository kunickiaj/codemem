import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileCoordinatorEnrollmentSnapshot } from "./coordinator-enrollment-reconciler.js";
import {
	commitDeviceIdentityBindings,
	previewDeviceIdentityBindings,
} from "./device-identity-binding.js";
import {
	type DeviceIdentityInventoryInput,
	listDeviceIdentityInventory,
} from "./device-identity-inventory.js";
import { ensureMemoryRetirementDeliverySchema } from "./memory-retirement-delivery-schema.js";
import { removePairingState } from "./pairing-removal.js";
import { removePeerFromThisDevice } from "./peer-removal.js";
import { listRecipientPolicyIntent } from "./recipient-policy-intent.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import { resolveSameActorPeerIds } from "./same-actor-peers.js";
import { saveSyncChannelCompletedBoundary } from "./sync-channel-progress.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { setReplicationCursor } from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-17T00:00:00.000Z";
const LOCAL = "device-local";
const PEER = "device-peer";
const PEER_KEY = "peer-key";
const IDENTITY = "identity-a";
const PROJECT = "project-a";
const INVENTORY: DeviceIdentityInventoryInput = {
	localDeviceId: LOCAL,
	coordinator: { availability: "available", safeErrorCode: null, enrollments: [] },
};
let db: InstanceType<typeof Database>;

function pair() {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, name, public_key, pinned_fingerprint, created_at)
		 VALUES (?, 'Peer', ?, ?, ?)`,
	).run(PEER, PEER_KEY, fingerprintPublicKey(PEER_KEY), NOW);
}

function binding() {
	return db
		.prepare("SELECT identity_id, status FROM identity_devices WHERE device_id = ?")
		.get(PEER);
}

function remove() {
	return removePairingState(db, { localDeviceId: LOCAL, reason: "local", deviceIds: [PEER] });
}

function peerInventoryItem() {
	return listDeviceIdentityInventory(db, INVENTORY).items.find((item) => item.deviceId === PEER);
}

function bindPeerInDevices() {
	const request = { bindings: [{ deviceId: PEER, targetIdentityId: IDENTITY, confirmed: true }] };
	const preview = previewDeviceIdentityBindings(db, INVENTORY, request);
	return commitDeviceIdentityBindings(
		db,
		{ localActorId: IDENTITY, localDeviceId: LOCAL, now: () => NOW },
		INVENTORY,
		{ ...request, reviewedInventoryDigest: preview.reviewedInventoryDigest },
	);
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	ensureMemoryRetirementDeliverySchema(db);
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES (?, 'Ada', 1, 'active', ?, ?)`,
	).run(IDENTITY, NOW, NOW);
	pair();
	db.prepare(
		`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
		 revision, migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, ?, 'Peer', 'active', 'user_confirmed_identity_setup', '1', 'user_managed',
		 'binding:peer', ?, ?)`,
	).run(PEER, IDENTITY, NOW, NOW);
	db.prepare(
		`INSERT INTO project_recipients(canonical_project_identity, recipient_kind, recipient_id,
		 status, provenance, policy_revision, migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, 'identity', ?, 'active', 'test', '1', 'native', 'recipient:a', ?, ?)`,
	).run(PROJECT, IDENTITY, NOW, NOW);
	db.prepare(
		`INSERT INTO recipient_policy_authority_states(canonical_project_identity, authority_state,
		 generation, state_changed_at, last_attempt_at, created_at, updated_at)
		 VALUES (?, 'active', 1, ?, ?, ?, ?)`,
	).run(PROJECT, NOW, NOW, NOW, NOW);
});

afterEach(() => db.close());

describe("a binding that device removal ended", () => {
	it("H12: is absent from the reconciler's device list without blocking the Project, and wakes its policy", () => {
		expect(
			deriveRecipientPolicyEffectiveDevicesFromDatabase(db, PROJECT).devices.map(
				(device) => device.deviceId,
			),
		).toEqual([PEER]);

		remove();

		expect(deriveRecipientPolicyEffectiveDevicesFromDatabase(db, PROJECT)).toMatchObject({
			status: "eligible",
			devices: [],
			blocked: [],
		});
		expect(
			db.prepare("SELECT last_attempt_at FROM recipient_policy_authority_states").pluck().get(),
		).toBeNull();
	});

	it("is absent from the recipient intent graph", () => {
		remove();

		expect(listRecipientPolicyIntent(db).identityDevices).toEqual([]);
	});

	it("no longer makes the device one of this person's own devices after it pairs again", () => {
		expect(resolveSameActorPeerIds(db, IDENTITY)).toContain(PEER);

		remove();
		pair();

		expect(resolveSameActorPeerIds(db, IDENTITY)).not.toContain(PEER);
	});

	it("is absent from Devices, and a device that pairs again needs setup instead of review", () => {
		remove();
		expect(peerInventoryItem()).toBeUndefined();

		pair();

		expect(peerInventoryItem()).toMatchObject({
			state: "setup_required",
			identityId: null,
			conflictCodes: [],
		});
	});

	it("becomes active again through an explicit bind in Devices, keeping the binding row", () => {
		remove();
		pair();

		expect(bindPeerInDevices()).toMatchObject({ status: "applied", writeCount: 1 });

		expect(binding()).toEqual({ identity_id: IDENTITY, status: "active" });
		expect(peerInventoryItem()).toMatchObject({ state: "configured", identityId: IDENTITY });
	});
});

describe("a disconnect that keeps the binding", () => {
	it("leaves the device in the reconciler's device list and wakes no Project policy", () => {
		const bindingBefore = db
			.prepare("SELECT * FROM identity_devices WHERE device_id = ?")
			.get(PEER);

		const counts = removePairingState(db, {
			localDeviceId: LOCAL,
			reason: "disconnect",
			deviceIds: [PEER],
		});

		expect(counts).toMatchObject({ syncPeers: 1, identityDevices: 0 });
		expect(db.prepare("SELECT * FROM identity_devices WHERE device_id = ?").get(PEER)).toEqual(
			bindingBefore,
		);
		expect(
			deriveRecipientPolicyEffectiveDevicesFromDatabase(db, PROJECT).devices.map(
				(device) => device.deviceId,
			),
		).toEqual([PEER]);
		expect(
			db.prepare("SELECT last_attempt_at FROM recipient_policy_authority_states").pluck().get(),
		).toBe(NOW);
	});
});

describe("unpairing, whatever the coordinator settings", () => {
	it.each([
		["truncated", '{"sync_coordinator_url":"https://coordinator.invalid"'],
		["empty", ""],
		["unreadable", null],
		["missing", null],
		["valid empty object", "{}"],
	] as const)("keeps the binding with %s config", async (kind, text) => {
		const directory = mkdtempSync(join(tmpdir(), "peer-removal-config-"));
		const path = join(directory, "config.json");
		if (text !== null) writeFileSync(path, text);
		if (kind === "unreadable") mkdirSync(path);
		vi.stubEnv("CODEMEM_CONFIG", path);
		for (const name of ["URL", "GROUP", "GROUPS", "ADMIN_SECRET"]) {
			vi.stubEnv(`CODEMEM_SYNC_COORDINATOR_${name}`, undefined);
		}
		try {
			setReplicationCursor(db, PEER, { lastApplied: "c1" });
			setReplicationCursor(db, PEER, { lastApplied: "c2" }, "scope-a");
			saveSyncChannelCompletedBoundary(db, {
				peerDeviceId: PEER,
				scopeId: "scope-a",
				boundary: { generation: 1, snapshot_id: "snapshot-1", baseline_cursor: null },
			});
			const result = removePeerFromThisDevice(db, {
				localDeviceId: LOCAL,
				peerDeviceId: PEER,
			});
			expect(result.binding).toBe("kept");
			expect(result.removed).toMatchObject({
				replicationCursors: 1,
				replicationCursorsV2: 2,
				syncChannelProgress: 1,
			});
			expect(binding()).toMatchObject({ status: "active" });
			expect(
				db.prepare("SELECT last_attempt_at FROM recipient_policy_authority_states").pluck().get(),
			).toBe(NOW);
			expect(
				[
					"sync_peers",
					"replication_cursors",
					"replication_cursors_v2",
					"sync_channel_progress",
				].map((table) =>
					db.prepare(`SELECT COUNT(*) FROM ${table} WHERE peer_device_id = ?`).pluck().get(PEER),
				),
			).toEqual([0, 0, 0, 0]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

const OTHER_IDENTITY = "identity-b";
const TEAM_PROJECT = "project-team";

function enrollment(deviceId: string, identityId: string, publicKey: string) {
	return {
		group_id: "group-a",
		device_id: deviceId,
		public_key: publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		identity_id: identityId,
		display_name: "Peer",
		enabled: 1,
		created_at: NOW,
	};
}

/** The local device's own enrollment proves the local Identity, as the reconciler requires. */
function reconcile(peerEnrollments: ReturnType<typeof enrollment>[]) {
	return reconcileCoordinatorEnrollmentSnapshot(db, {
		coordinatorId: "https://coord.example.test",
		groupId: "group-a",
		localDeviceId: LOCAL,
		now: NOW,
		consumedTeamInvites: [],
		enrollments: [enrollment(LOCAL, IDENTITY, "local-key"), ...peerEnrollments],
	});
}

function effectiveDeviceIds(project: string) {
	return deriveRecipientPolicyEffectiveDevicesFromDatabase(db, project).devices.map(
		(device) => device.deviceId,
	);
}

function fullBinding() {
	return db
		.prepare(
			"SELECT identity_id, status, provenance, assignment_version FROM identity_devices WHERE device_id = ?",
		)
		.get(PEER);
}

describe("a coordinator enrollment snapshot after device removal", () => {
	/** A Team that excludes the peer and receives its own Project. */
	function excludePeerFromTeam() {
		db.prepare(
			`INSERT INTO policy_teams(team_id, display_name, status, provenance, revision,
			 migration_state, idempotency_key, created_at, updated_at)
			 VALUES ('team-a', 'Team', 'active', 'test', '1', 'native', 'team:a', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_memberships(team_id, identity_id, role, status, provenance,
			 revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES ('team-a', ?, 'member', 'active', 'test', '1', 'native', 'member:a', ?, ?)`,
		).run(IDENTITY, NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(team_id, device_id, decision, provenance,
			 revision, created_at, updated_at) VALUES ('team-a', ?, 'excluded', 'test', '1', ?, ?)`,
		).run(PEER, NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(canonical_project_identity, recipient_kind, recipient_id,
			 status, provenance, policy_revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES (?, 'team', 'team-a', 'active', 'test', '1', 'native', 'recipient:team', ?, ?)`,
		).run(TEAM_PROJECT, NOW, NOW);
	}

	it("binds a listed device again under the same Identity with no manual step, and its Team exclusion still applies", async () => {
		excludePeerFromTeam();
		remove();

		const result = await reconcile([enrollment(PEER, IDENTITY, PEER_KEY)]);

		expect(result.issues).toEqual([]);
		expect(fullBinding()).toEqual({
			identity_id: IDENTITY,
			status: "active",
			provenance: "coordinator_enrollment",
			assignment_version: 0,
		});
		expect(effectiveDeviceIds(PROJECT)).toContain(PEER);
		expect(effectiveDeviceIds(TEAM_PROJECT)).not.toContain(PEER);
	});

	it("binds a device listed under another Identity to that Identity with an incremented assignment version and resets its reviewed-Team inclusion", async () => {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES (?, 'Bea', 0, 'active', ?, ?)`,
		).run(OTHER_IDENTITY, NOW, NOW);
		db.prepare(
			`INSERT INTO policy_teams(team_id, display_name, status, device_eligibility_mode, provenance,
			 revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at)
			 VALUES ('team-reviewed', 'Reviewed', 'active', 'reviewed_allowlist', 'test', '1', 'native',
			 'completed-setup', 'team:reviewed', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(team_id, device_id, decision, provenance,
			 revision, created_at, updated_at) VALUES ('team-reviewed', ?, 'included', 'test', '1', ?, ?)`,
		).run(PEER, NOW, NOW);
		remove();

		const result = await reconcile([enrollment(PEER, OTHER_IDENTITY, PEER_KEY)]);

		expect(result.issues).toEqual([]);
		expect(fullBinding()).toEqual({
			identity_id: OTHER_IDENTITY,
			status: "active",
			provenance: "coordinator_enrollment",
			assignment_version: 1,
		});
		// The reviewed Team included the device under its former Identity.
		expect(
			db
				.prepare(
					`SELECT decision.decision, team.source_fingerprint
					 FROM policy_team_device_decisions decision
					 JOIN policy_teams team ON team.team_id = decision.team_id
					 WHERE decision.device_id = ?`,
				)
				.get(PEER),
		).toEqual({ decision: "unresolved", source_fingerprint: null });
		expect(effectiveDeviceIds(PROJECT)).not.toContain(PEER);
	});

	it("leaves the binding ended when the snapshot does not list the device", async () => {
		remove();

		await reconcile([]);

		expect(binding()).toEqual({ identity_id: IDENTITY, status: "removed" });
	});

	it("keeps the pinned-key conflict and does not bind when this device pins another key for the listed device", async () => {
		remove();
		pair();

		const result = await reconcile([enrollment(PEER, IDENTITY, "another-key")]);

		expect(result.issues).toContainEqual({
			kind: "device",
			referenceId: PEER,
			code: "device_trust_conflict",
		});
		expect(binding()).toEqual({ identity_id: IDENTITY, status: "removed" });
	});
});

describe("a blocked device that keeps an enrollment row", () => {
	it("leaves the binding ended when the snapshot marks the listed device as revoked", async () => {
		remove();

		const result = await reconcile([{ ...enrollment(PEER, IDENTITY, PEER_KEY), revoked: true }]);

		expect(result.issues).toEqual([]);
		expect(binding()).toEqual({ identity_id: IDENTITY, status: "removed" });
	});

	it("leaves the binding ended while this device's retired alias for the device still applies", async () => {
		removePairingState(db, { localDeviceId: LOCAL, reason: "revoked", deviceIds: [PEER] });

		const result = await reconcile([enrollment(PEER, IDENTITY, PEER_KEY)]);

		expect(result.issues).toEqual([]);
		expect(binding()).toEqual({ identity_id: IDENTITY, status: "removed" });
	});

	it("binds the device again once it is paired under a different key, which clears a key-only alias", async () => {
		removePairingState(db, { localDeviceId: LOCAL, reason: "revoked", deviceIds: [PEER] });
		const newKey = "replacement-key";
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, public_key, pinned_fingerprint, created_at)
			 VALUES (?, 'Peer', ?, ?, ?)`,
		).run(PEER, newKey, fingerprintPublicKey(newKey), NOW);

		const result = await reconcile([enrollment(PEER, IDENTITY, newKey)]);

		expect(result.issues).toEqual([]);
		expect(binding()).toEqual({ identity_id: IDENTITY, status: "active" });
	});
});
