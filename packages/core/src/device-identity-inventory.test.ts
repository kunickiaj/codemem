import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import {
	type DeviceIdentityInventorySnapshot,
	listDeviceIdentityInventory,
	loadDeviceIdentityInventorySnapshot,
	projectDeviceIdentityInventory,
} from "./device-identity-inventory.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-18T12:00:00.000Z";

function enrollment(
	deviceId: string,
	publicKey: string,
	overrides: Partial<CoordinatorEnrollment> = {},
): CoordinatorEnrollment {
	return {
		group_id: "group-a",
		device_id: deviceId,
		public_key: publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		identity_id: null,
		display_name: "Laptop",
		enabled: 1,
		created_at: NOW,
		...overrides,
	};
}

function snapshot(
	overrides: Partial<DeviceIdentityInventorySnapshot> = {},
): DeviceIdentityInventorySnapshot {
	return {
		localDevice: null,
		peers: [],
		bindings: [],
		coordinator: { availability: "available", safeErrorCode: null, enrollments: [] },
		...overrides,
	};
}

describe("device Identity inventory projection", () => {
	it("classifies local and peer evidence as setup_required without binding identities", () => {
		const result = projectDeviceIdentityInventory(
			snapshot({
				localDevice: {
					deviceId: "device-local",
					displayName: "This laptop",
					publicKey: "local-key",
					fingerprint: fingerprintPublicKey("local-key"),
				},
				peers: [
					{
						deviceId: "device-peer",
						displayName: "Peer laptop",
						publicKey: "peer-key",
						pinnedFingerprint: fingerprintPublicKey("peer-key"),
						suggestedIdentityId: "identity-suggestion",
						trustProvenance: null,
						claimedLocalActor: false,
					},
				],
			}),
		);

		expect(result.items).toMatchObject([
			{ deviceId: "device-local", state: "setup_required", identityId: null, isLocal: true },
			{
				deviceId: "device-peer",
				state: "setup_required",
				identityId: null,
				suggestedIdentityId: "identity-suggestion",
			},
		]);
	});

	it("keeps coordinator-only enrollment in pairing_required even when it names an identity", () => {
		const result = projectDeviceIdentityInventory(
			snapshot({
				coordinator: {
					availability: "available",
					safeErrorCode: null,
					enrollments: [
						enrollment("legacy-device", "legacy-key", { identity_id: "identity-unreviewed" }),
					],
				},
			}),
		);

		expect(result.items).toMatchObject([
			{
				deviceId: "legacy-device",
				state: "pairing_required",
				identityId: null,
				suggestedIdentityId: "identity-unreviewed",
			},
		]);
	});

	it("preserves an active trusted-invitation binding as configured", () => {
		const result = projectDeviceIdentityInventory(
			snapshot({
				bindings: [
					{
						deviceId: "invited-device",
						displayName: "Invited laptop",
						identityId: "identity-a",
						status: "active",
						identityStatus: "active",
					},
				],
				coordinator: {
					availability: "available",
					safeErrorCode: null,
					enrollments: [enrollment("invited-device", "invite-key", { identity_id: "identity-a" })],
				},
			}),
		);

		expect(result.items).toMatchObject([
			{
				deviceId: "invited-device",
				state: "configured",
				identityId: "identity-a",
				suggestedIdentityId: null,
			},
		]);
	});

	it("deduplicates validated fingerprints but never equal display names", () => {
		const sharedFingerprint = fingerprintPublicKey("shared-key");
		const result = projectDeviceIdentityInventory(
			snapshot({
				peers: [
					{
						deviceId: "peer-a",
						displayName: "Laptop",
						publicKey: "shared-key",
						pinnedFingerprint: sharedFingerprint,
						suggestedIdentityId: null,
						trustProvenance: null,
						claimedLocalActor: false,
					},
					{
						deviceId: "peer-b",
						displayName: "Laptop",
						publicKey: "other-key",
						pinnedFingerprint: fingerprintPublicKey("other-key"),
						suggestedIdentityId: null,
						trustProvenance: null,
						claimedLocalActor: false,
					},
				],
				coordinator: {
					availability: "available",
					safeErrorCode: null,
					enrollments: [enrollment("coordinator-alias", "shared-key")],
				},
			}),
		);

		expect(result.items).toHaveLength(2);
		expect(result.items.find((item) => item.deviceId === "peer-a")?.evidenceDeviceIds).toEqual([
			"coordinator-alias",
			"peer-a",
		]);
	});

	it("fails closed on fingerprint, binding, inactive identity, and disabled-enrollment conflicts", () => {
		const sharedFingerprint = fingerprintPublicKey("shared-key");
		const result = projectDeviceIdentityInventory(
			snapshot({
				peers: [
					{
						deviceId: "device-a",
						displayName: "A",
						publicKey: "shared-key",
						pinnedFingerprint: sharedFingerprint,
						suggestedIdentityId: null,
						trustProvenance: null,
						claimedLocalActor: false,
					},
					{
						deviceId: "device-b",
						displayName: "B",
						publicKey: "shared-key",
						pinnedFingerprint: sharedFingerprint,
						suggestedIdentityId: null,
						trustProvenance: null,
						claimedLocalActor: false,
					},
				],
				bindings: [
					{
						deviceId: "device-a",
						displayName: "A",
						identityId: "identity-a",
						status: "active",
						identityStatus: "active",
					},
					{
						deviceId: "device-b",
						displayName: "B",
						identityId: "identity-b",
						status: "active",
						identityStatus: "deactivated",
					},
				],
				coordinator: {
					availability: "available",
					safeErrorCode: null,
					enrollments: [enrollment("device-a", "different-key", { enabled: 0 })],
				},
			}),
		);

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({ state: "conflicted", identityId: null });
		expect(result.items[0]?.conflictCodes).toEqual([
			"coordinator_enrollment_disabled",
			"fingerprint_conflict",
			"identity_binding_conflict",
			"identity_inactive",
		]);
	});

	it("clears a single active owner when independent evidence is conflicted", () => {
		const result = projectDeviceIdentityInventory(
			snapshot({
				peers: [
					{
						deviceId: "device-a",
						displayName: "A",
						publicKey: "public-key",
						pinnedFingerprint: fingerprintPublicKey("different-key"),
						suggestedIdentityId: null,
						trustProvenance: null,
						claimedLocalActor: false,
					},
				],
				bindings: [
					{
						deviceId: "device-a",
						displayName: "A",
						identityId: "identity-a",
						status: "active",
						identityStatus: "active",
					},
				],
			}),
		);

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			state: "conflicted",
			identityId: null,
			conflictCodes: ["fingerprint_invalid"],
		});
	});

	it("treats a binding to a pending Identity as conflicted", () => {
		const result = projectDeviceIdentityInventory(
			snapshot({
				bindings: [
					{
						deviceId: "device-a",
						displayName: "A",
						identityId: "identity-a",
						status: "active",
						identityStatus: "pending",
					},
				],
			}),
		);

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			state: "conflicted",
			identityId: null,
			conflictCodes: ["identity_inactive"],
		});
	});

	it("ignores unavailable coordinator rows and bounds the response", () => {
		const peers = ["a", "b"].map((suffix) => ({
			deviceId: `device-${suffix}`,
			displayName: `Device ${suffix}`,
			publicKey: `key-${suffix}`,
			pinnedFingerprint: fingerprintPublicKey(`key-${suffix}`),
			suggestedIdentityId: null,
			trustProvenance: null,
			claimedLocalActor: false,
		}));
		const result = projectDeviceIdentityInventory(
			snapshot({
				peers,
				coordinator: {
					availability: "unavailable",
					safeErrorCode: "coordinator_unavailable",
					enrollments: [enrollment("partial-device", "partial-key")],
				},
			}),
			{ limit: 1 },
		);

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.deviceId).not.toBe("partial-device");
		expect(result.truncated).toBe(true);
		expect(result.coordinatorEvidence).toEqual({
			availability: "unavailable",
			safeErrorCode: "coordinator_unavailable",
		});
	});

	it("preserves item classifications when bounded local evidence was truncated", () => {
		const result = projectDeviceIdentityInventory(
			snapshot({
				localEvidenceTruncated: true,
				peers: [
					{
						deviceId: "device-a",
						displayName: "Device A",
						publicKey: "key-a",
						pinnedFingerprint: fingerprintPublicKey("key-a"),
						suggestedIdentityId: null,
						trustProvenance: null,
						claimedLocalActor: false,
					},
				],
			}),
		);

		expect(result).toMatchObject({
			truncated: true,
			items: [{ state: "setup_required", conflictCodes: [] }],
		});
	});

	it("fails closed on an invalid public-key and fingerprint pair", () => {
		const result = projectDeviceIdentityInventory(
			snapshot({
				peers: [
					{
						deviceId: "device-invalid",
						displayName: "Invalid device",
						publicKey: "public-key-a",
						pinnedFingerprint: fingerprintPublicKey("public-key-b"),
						suggestedIdentityId: null,
						trustProvenance: null,
						claimedLocalActor: false,
					},
				],
			}),
		);

		expect(result.items).toMatchObject([
			{ state: "conflicted", conflictCodes: ["fingerprint_invalid"] },
		]);
	});

	it("fails closed on a revoked binding in isolation", () => {
		const result = projectDeviceIdentityInventory(
			snapshot({
				bindings: [
					{
						deviceId: "device-revoked",
						displayName: "Revoked device",
						identityId: "identity-a",
						status: "revoked",
						identityStatus: "active",
					},
				],
			}),
		);

		expect(result.items).toMatchObject([
			{ state: "conflicted", identityId: null, conflictCodes: ["identity_binding_revoked"] },
		]);
	});
});

describe("device Identity inventory database projection", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		db.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		).run("local-device", "local-key", fingerprintPublicKey("local-key"), NOW);
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
			 VALUES ('legacy-peer', 'Legacy laptop', 'identity-suggestion', ?)`,
		).run(NOW);
	});

	afterEach(() => db.close());

	it("is read-only and does not materialize suggested or coordinator identities", () => {
		const before = db.prepare("SELECT * FROM identity_devices ORDER BY device_id").all();

		const result = listDeviceIdentityInventory(db, {
			localDeviceId: "local-device",
			coordinator: {
				availability: "available",
				safeErrorCode: null,
				enrollments: [
					enrollment("coordinator-device", "coordinator-key", {
						identity_id: "coordinator-identity",
					}),
				],
			},
		});

		expect(result.items.find((item) => item.deviceId === "legacy-peer")).toMatchObject({
			state: "setup_required",
			identityId: null,
			suggestedIdentityId: "identity-suggestion",
		});
		expect(db.prepare("SELECT * FROM identity_devices ORDER BY device_id").all()).toEqual(before);
	});

	it("does not fall back to another local sync_device row", () => {
		const loaded = loadDeviceIdentityInventorySnapshot(db, {
			localDeviceId: "missing-local-device",
			coordinator: { availability: "available", safeErrorCode: null, enrollments: [] },
		});

		expect(loaded.localDevice).toBeNull();
	});

	it("keeps coordinator-policy peers pairing_required unless they claim the local actor", () => {
		const fingerprint = fingerprintPublicKey("policy-key");
		db.prepare(
			`UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ?,
			 trust_provenance = 'coordinator_policy', claimed_local_actor = 0
			 WHERE peer_device_id = 'legacy-peer'`,
		).run("policy-key", fingerprint);
		const input = {
			localDeviceId: "local-device",
			coordinator: {
				availability: "available" as const,
				safeErrorCode: null,
				enrollments: [enrollment("legacy-peer", "policy-key")],
			},
		};

		expect(
			listDeviceIdentityInventory(db, input).items.find((item) => item.deviceId === "legacy-peer"),
		).toMatchObject({ state: "pairing_required" });

		db.prepare(
			"UPDATE sync_peers SET claimed_local_actor = 1 WHERE peer_device_id = 'legacy-peer'",
		).run();
		expect(
			listDeviceIdentityInventory(db, input).items.find((item) => item.deviceId === "legacy-peer"),
		).toMatchObject({ state: "setup_required" });
	});

	it("loads an existing reviewed-invitation binding as configured without rewriting it", () => {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-a', 'Ada', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES ('invited-device', 'identity-a', 'Invited laptop', 'active',
			 'coordinator_enrollment', 'revision-a', 'user_managed', 'source-a', 'key-a', ?, ?)`,
		).run(NOW, NOW);
		const before = db.prepare("SELECT * FROM identity_devices").all();

		const result = listDeviceIdentityInventory(db, {
			localDeviceId: "local-device",
			coordinator: {
				availability: "available",
				safeErrorCode: null,
				enrollments: [enrollment("invited-device", "invite-key", { identity_id: "identity-a" })],
			},
		});

		expect(result.items.find((item) => item.deviceId === "invited-device")).toMatchObject({
			state: "configured",
			identityId: "identity-a",
		});
		expect(db.prepare("SELECT * FROM identity_devices").all()).toEqual(before);
	});

	it("retains bindings for local and peer devices when binding evidence is truncated", () => {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-a', 'Ada', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		const insert = db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-a', ?, 'active', 'user_confirmed_identity_setup',
			 'revision-a', 'user_managed', ?, ?, ?)`,
		);
		db.transaction(() => {
			for (let index = 0; index < 2_001; index += 1) {
				const deviceId = `aaa-${String(index).padStart(4, "0")}`;
				insert.run(deviceId, `ZZZ padding ${index}`, `key-${deviceId}`, NOW, NOW);
			}
			insert.run("legacy-peer", "Legacy laptop", "key-legacy", NOW, NOW);
			insert.run("local-device", "This device", "key-local", NOW, NOW);
		})();

		const result = listDeviceIdentityInventory(db, {
			localDeviceId: "local-device",
			coordinator: { availability: "available", safeErrorCode: null, enrollments: [] },
		});

		expect(result.truncated).toBe(true);
		expect(result.items.find((item) => item.deviceId === "legacy-peer")).toMatchObject({
			state: "configured",
			identityId: "identity-a",
		});
		expect(result.items.find((item) => item.deviceId === "local-device")).toMatchObject({
			state: "configured",
			identityId: "identity-a",
		});
	});
});
