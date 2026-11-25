import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import {
	type DeviceIdentityInventorySnapshot,
	type DeviceIdentityPeerEvidence,
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

function coordinatorOnly(enrollments: CoordinatorEnrollment[]) {
	return snapshot({ coordinator: { availability: "available", safeErrorCode: null, enrollments } });
}

function discoveredProbe(overrides: Partial<DeviceIdentityPeerEvidence> = {}) {
	return {
		...coordinatorOnly([
			enrollment("probe", "probe-key", {
				display_name: "Relay health probe",
				service_role: "relay_health_probe",
			}),
		]),
		peers: [
			{
				deviceId: "probe",
				displayName: "Relay health probe",
				publicKey: "probe-key",
				pinnedFingerprint: fingerprintPublicKey("probe-key"),
				suggestedIdentityId: "identity-suggested",
				trustProvenance: "coordinator_policy",
				claimedLocalActor: false,
				...overrides,
			},
		],
	};
}

it.each(["probe", "probe-alias"])(
	"keeps a trusted relay probe discovered as %s out of pairing setup",
	(deviceId) => {
		const result = projectDeviceIdentityInventory(discoveredProbe({ deviceId }));
		expect(result.items).toMatchObject([
			{ state: "service", identityId: null, suggestedIdentityId: null },
		]);
	},
);

it.each([
	{ trustProvenance: "manual_pairing" },
	{ trustProvenance: null },
	{ claimedLocalActor: true },
])("preserves person-managed evidence on a probe: %j", (overrides) => {
	const result = projectDeviceIdentityInventory(discoveredProbe(overrides));
	expect(result.items).toMatchObject([{ state: "setup_required" }]);
});

it("keeps a conflicting discovered probe in review", () => {
	const result = projectDeviceIdentityInventory(
		discoveredProbe({
			publicKey: "other-key",
			pinnedFingerprint: fingerprintPublicKey("other-key"),
		}),
	);
	expect(result.items).toMatchObject([
		{ state: "conflicted", conflictCodes: ["fingerprint_conflict"] },
	]);
});

it("does not treat discovery alone as a service-device label", () => {
	const input = discoveredProbe();
	input.coordinator.enrollments = [];
	expect(projectDeviceIdentityInventory(input).items).toMatchObject([
		{ state: "pairing_required" },
	]);
});

it("uses the coordinator's service evidence for an unpaired keyless discovery record", () => {
	const result = projectDeviceIdentityInventory(
		discoveredProbe({ publicKey: null, pinnedFingerprint: null }),
	);
	expect(result.items).toMatchObject([
		{
			state: "service",
			validatedFingerprint: fingerprintPublicKey("probe-key"),
			suggestedIdentityId: null,
		},
	]);
});

it("preserves an Identity binding even when the coordinator labels the peer as a probe", () => {
	const input = discoveredProbe();
	const result = projectDeviceIdentityInventory({
		...input,
		bindings: [
			{
				deviceId: "probe",
				displayName: "Bound device",
				identityId: "identity-reviewed",
				status: "active",
				identityStatus: "active",
			},
		],
	});
	expect(result.items).toMatchObject([{ state: "configured", identityId: "identity-reviewed" }]);
});

it("keeps the current device visible even when its key has a probe enrollment", () => {
	const result = projectDeviceIdentityInventory({
		...discoveredProbe(),
		localDevice: {
			deviceId: "probe",
			displayName: "Current device",
			publicKey: "probe-key",
			fingerprint: fingerprintPublicKey("probe-key"),
		},
	});
	expect(result.items).toMatchObject([{ state: "setup_required", isLocal: true }]);
});

it("does not hide a same-key enrollment whose coordinator has not labeled it as a service", () => {
	const input = discoveredProbe();
	input.coordinator.enrollments.push(
		enrollment("peer-in-other-group", "probe-key", { group_id: "other-group" }),
	);
	expect(projectDeviceIdentityInventory(input).items).toMatchObject([
		{ state: "pairing_required" },
	]);
});

describe("device inventory service devices", () => {
	it("classifies a coordinator-labeled relay probe as a service device", () => {
		const result = projectDeviceIdentityInventory(
			coordinatorOnly([
				enrollment("probe", "probe-key", {
					display_name: "Relay health probe",
					identity_id: "identity-unreviewed",
					service_role: "relay_health_probe",
				}),
			]),
		);

		expect(result.items).toMatchObject([
			{ deviceId: "probe", state: "service", identityId: null, suggestedIdentityId: null },
		]);
	});

	it.each([
		["a disabled enrollment", [{ enabled: 0 }], "coordinator_enrollment_disabled"],
		["two keys under the same ID", [{}, { public_key: "other-key" }], "fingerprint_conflict"],
	])("keeps %s for a labeled probe in review", (_label, rows, conflictCode) => {
		const enrollments = rows.map((row, index) => {
			const publicKey = row.public_key ?? "probe-key";
			return enrollment("probe", publicKey, {
				group_id: `group-${index}`,
				service_role: "relay_health_probe",
				enabled: row.enabled ?? 1,
			});
		});

		const result = projectDeviceIdentityInventory(coordinatorOnly(enrollments));

		expect(result.items).toMatchObject([{ state: "conflicted", conflictCodes: [conflictCode] }]);
	});

	it("keeps a probe-named enrollment without the coordinator label in pairing_required", () => {
		const result = projectDeviceIdentityInventory(
			coordinatorOnly([enrollment("laptop", "laptop-key", { display_name: "Relay health probe" })]),
		);

		expect(result.items).toMatchObject([{ deviceId: "laptop", state: "pairing_required" }]);
	});

	it("keeps a service-labeled enrollment visible when a person's sync peer shares its key", () => {
		const result = projectDeviceIdentityInventory({
			...coordinatorOnly([
				enrollment("laptop", "shared-key", { service_role: "relay_health_probe" }),
			]),
			peers: [
				{
					deviceId: "laptop",
					displayName: "Laptop",
					publicKey: "shared-key",
					pinnedFingerprint: fingerprintPublicKey("shared-key"),
					suggestedIdentityId: null,
					trustProvenance: "manual_pairing",
					claimedLocalActor: false,
				},
			],
		});

		expect(result.items).toMatchObject([{ deviceId: "laptop", state: "setup_required" }]);
	});
});

describe("device inventory retired devices", () => {
	it("marks a revoked enrollment retired even with an active binding and conflicting keys", () => {
		const result = projectDeviceIdentityInventory({
			...coordinatorOnly([
				enrollment("laptop", "key-a", { revoked: true, identity_id: "identity-a" }),
				enrollment("laptop", "key-b", { group_id: "group-b" }),
			]),
			bindings: [
				{
					deviceId: "laptop",
					displayName: "Laptop",
					identityId: "identity-a",
					status: "active",
					identityStatus: "active",
				},
			],
		});

		expect(result.items).toMatchObject([
			{ deviceId: "laptop", state: "retired", identityId: null, suggestedIdentityId: null },
		]);
	});
});

describe("device inventory missing-name provenance", () => {
	it.each([null, "Enrolled device", "Peer device", "Registered device"])(
		"preserves an explicit label %s but skips a missing enrollment label",
		(displayName) => {
			const rows = [
				enrollment("device-a", "key-a", { display_name: displayName }),
				enrollment("device-b", "key-a", { display_name: "Studio laptop" }),
			];
			for (const enrollments of [rows, [...rows].reverse()]) {
				const result = projectDeviceIdentityInventory(
					snapshot({
						coordinator: { availability: "available", safeErrorCode: null, enrollments },
					}),
				);
				expect(result.items[0]?.displayName).toBe(displayName ?? "Studio laptop");
			}
		},
	);
	it("does not turn missing database names into higher-priority labels", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			db.prepare(
				"INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at) VALUES ('identity-a', 'Example', 0, 'active', ?, ?)",
			).run(NOW, NOW);
			db.prepare(
				"INSERT INTO sync_peers(peer_device_id, name, public_key, pinned_fingerprint, created_at) VALUES ('device-a', NULL, 'key-a', ?, ?)",
			).run(fingerprintPublicKey("key-a"), NOW);
			db.prepare(
				"INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance, revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at) VALUES ('device-a', 'identity-a', '', 'active', 'coordinator_enrollment', 'rev-a', 'user_managed', 'source-a', 'key-a', ?, ?)",
			).run(NOW, NOW);
			const loaded = loadDeviceIdentityInventorySnapshot(db, {
				localDeviceId: "missing",
				coordinator: {
					availability: "available",
					safeErrorCode: null,
					enrollments: [enrollment("device-a", "key-a", { display_name: "Studio laptop" })],
				},
			});
			expect(loaded.peers[0]?.displayName).toBe("");
			expect(loaded.bindings[0]?.displayName).toBe("");
			expect(projectDeviceIdentityInventory(loaded).items[0]?.displayName).toBe("Studio laptop");
		} finally {
			db.close();
		}
	});
});

describe("device inventory display names", () => {
	it.each([
		{
			source: "coordinator",
			localName: "Unnamed device",
			bindingName: "Canonical device",
			peerName: "Unnamed device",
			expected: "Studio laptop",
		},
		{
			source: "peer",
			localName: "Unnamed device",
			bindingName: "Canonical device",
			peerName: "Peer laptop",
			expected: "Peer laptop",
		},
		{
			source: "binding",
			localName: "Unnamed device",
			bindingName: "Personal laptop",
			peerName: "Peer laptop",
			expected: "Personal laptop",
		},
		{
			source: "local",
			localName: "This laptop",
			bindingName: "Personal laptop",
			peerName: "Peer laptop",
			expected: "This laptop",
		},
	])(
		"searches aliases for names while preserving $source priority",
		({ localName, bindingName, peerName, expected }) => {
			const input = snapshot({
				localDevice: {
					deviceId: "device-a",
					displayName: localName,
					publicKey: "key-a",
					fingerprint: fingerprintPublicKey("key-a"),
				},
				bindings: [
					{
						deviceId: "device-a",
						displayName: bindingName,
						identityId: "identity-a",
						status: "active",
						identityStatus: "active",
					},
				],
				peers: [
					{
						deviceId: "device-a",
						displayName: peerName,
						publicKey: "key-a",
						pinnedFingerprint: fingerprintPublicKey("key-a"),
						suggestedIdentityId: null,
						trustProvenance: null,
						claimedLocalActor: false,
					},
				],
				coordinator: {
					availability: "available",
					safeErrorCode: null,
					enrollments: [
						enrollment("device-a", "key-a", { display_name: "Unnamed device" }),
						enrollment("device-alias", "key-a", { display_name: "Studio laptop" }),
						enrollment("device-other-alias", "key-a", { display_name: "Other laptop" }),
					],
				},
			});
			const result = projectDeviceIdentityInventory(input);
			expect(result.items).toHaveLength(1);
			expect(result.items[0]?.displayName).toBe(expected);
			expect(result.items[0]?.deviceId).toBe("device-a");
		},
	);

	it.each(["Canonical device", "Unnamed device", "Travel laptop"])(
		"prefers a real enrollment name over placeholder %s without changing bindings",
		(displayName) => {
			const input = snapshot({
				bindings: [
					{
						deviceId: "device-a",
						displayName,
						identityId: "identity-a",
						status: "active",
						identityStatus: "active",
					},
				],
				coordinator: {
					availability: "available",
					safeErrorCode: null,
					enrollments: [enrollment("device-a", "key-a", { display_name: "Studio laptop" })],
				},
			});
			const result = projectDeviceIdentityInventory(input);
			expect(result.items[0]?.displayName).toBe(
				displayName === "Travel laptop" ? displayName : "Studio laptop",
			);
			expect(input.bindings[0]?.displayName).toBe(displayName);
		},
	);
});

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

	it("keeps an invitation-materialized coordinator enrollment binding configured", () => {
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
			suggestedIdentityId: null,
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

describe("device Identity inventory rejoin evidence", () => {
	const rejoined = (deviceId: string, key: string, rejoinedAtMs: number, extra = {}) =>
		enrollment(deviceId, key, { rejoined_at_ms: rejoinedAtMs, ...extra });

	it("reports a rejoin on an enabled enrollment without changing state or sources", () => {
		const plain = projectDeviceIdentityInventory(coordinatorOnly([enrollment("d1", "key-1")]));
		const result = projectDeviceIdentityInventory(
			coordinatorOnly([rejoined("d1", "key-1", 5_000)]),
		);

		expect(result.items[0]?.rejoin).toEqual({ deviceId: "d1", rejoinedAtMs: 5_000 });
		expect({ ...result.items[0], rejoin: undefined }).toEqual({
			...plain.items[0],
			rejoin: undefined,
		});
	});

	it("omits the field when no enrollment carries a marker", () => {
		const result = projectDeviceIdentityInventory(coordinatorOnly([enrollment("d1", "key-1")]));

		expect(result.items[0]).not.toHaveProperty("rejoin");
	});

	it.each([
		["a negative timestamp", -1],
		["a fractional timestamp", 2.5],
		["a timestamp no Date can hold", 9e15],
	])("ignores %s", (_label, marker) => {
		const result = projectDeviceIdentityInventory(
			coordinatorOnly([enrollment("d1", "key-1", { rejoined_at_ms: marker })]),
		);

		expect(result.items[0]).not.toHaveProperty("rejoin");
	});

	it("ignores a marker on a disabled enrollment", () => {
		const result = projectDeviceIdentityInventory(
			coordinatorOnly([rejoined("d1", "key-1", 5_000, { enabled: 0 })]),
		);

		expect(result.items[0]).not.toHaveProperty("rejoin");
	});

	it("ignores a marker on a revoked device and on a service device", () => {
		const result = projectDeviceIdentityInventory(
			coordinatorOnly([
				rejoined("revoked", "key-r", 5_000, { revoked: true }),
				rejoined("probe", "key-p", 6_000, { service_role: "relay_health_probe" }),
			]),
		);

		expect(result.items.map((item) => [item.deviceId, "rejoin" in item])).toEqual([
			["probe", false],
			["revoked", false],
		]);
	});

	it("never marks this device", () => {
		const publicKey = "key-local";
		const result = projectDeviceIdentityInventory(
			snapshot({
				localDevice: {
					deviceId: "d1",
					displayName: "This laptop",
					publicKey,
					fingerprint: fingerprintPublicKey(publicKey),
				},
				coordinator: {
					availability: "available",
					safeErrorCode: null,
					enrollments: [rejoined("d1", publicKey, 5_000)],
				},
			}),
		);

		expect(result.items[0]).toMatchObject({ isLocal: true });
		expect(result.items[0]).not.toHaveProperty("rejoin");
	});

	it("keeps the newest rejoin when one device is enrolled in several groups", () => {
		const result = projectDeviceIdentityInventory(
			coordinatorOnly([
				rejoined("d1", "key-1", 5_000, { group_id: "group-a" }),
				rejoined("d1", "key-1", 9_000, { group_id: "group-b" }),
			]),
		);

		expect(result.items[0]?.rejoin).toEqual({ deviceId: "d1", rejoinedAtMs: 9_000 });
	});

	it("omits the rejoin marker when the same device ID has conflicting enrollment keys", () => {
		const result = projectDeviceIdentityInventory(
			coordinatorOnly([
				rejoined("d1", "key-1", 5_000, { group_id: "group-a" }),
				enrollment("d1", "key-2", { group_id: "group-b" }),
			]),
		);
		expect(result.items[0]).toMatchObject({
			state: "conflicted",
			validatedFingerprint: null,
			conflictCodes: ["fingerprint_conflict"],
		});
		expect(result.items[0]).not.toHaveProperty("rejoin");
	});

	it("reports nothing when the coordinator is unavailable", () => {
		const result = projectDeviceIdentityInventory(
			snapshot({
				coordinator: {
					availability: "unavailable",
					safeErrorCode: "coordinator_unavailable",
					enrollments: [rejoined("d1", "key-1", 5_000)],
				},
			}),
		);

		expect(result.items).toEqual([]);
	});
});
