import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import type { DeviceIdentityCoordinatorEvidence } from "./device-identity-inventory.js";
import {
	convertLegacyPairingAssignments,
	LEGACY_PAIRING_ASSIGNMENT_PROVENANCE,
} from "./legacy-pairing-assignment-conversion.js";
import { legacyPairingAssignmentsConverted } from "./legacy-pairing-assignment-state.js";
import { LocalIdentitySupersededError } from "./local-identity-generation.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import { recordRetiredDeviceAliases } from "./retired-device-aliases.js";
import { resolveSameActorPeerIds } from "./same-actor-peers.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-18T00:00:00.000Z";
const LOCAL_DEVICE = "device-local";
const ME = "identity-me";
const BO = "identity-bo";
const PEER = "device-peer";
const PROJECT = "project-a";

const NOT_CONFIGURED: DeviceIdentityCoordinatorEvidence = {
	availability: "unavailable",
	safeErrorCode: "coordinator_not_configured",
	enrollments: [],
};
const UNREACHABLE: DeviceIdentityCoordinatorEvidence = {
	availability: "unavailable",
	safeErrorCode: "coordinator_unavailable",
	enrollments: [],
};

let db: InstanceType<typeof Database>;

function available(enrollments: CoordinatorEnrollment[] = []): DeviceIdentityCoordinatorEvidence {
	return { availability: "available", safeErrorCode: null, enrollments };
}

function enrollment(
	deviceId: string,
	overrides: Partial<CoordinatorEnrollment> = {},
): CoordinatorEnrollment {
	const publicKey = `${deviceId}-key`;
	return {
		group_id: "group-a",
		device_id: deviceId,
		public_key: publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		identity_id: null,
		display_name: "Enrolled",
		enabled: 1,
		created_at: NOW,
		...overrides,
	};
}

function actor(actorId: string, options: { isLocal?: boolean; status?: string } = {}) {
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(actorId, actorId, options.isLocal ? 1 : 0, options.status ?? "active", NOW, NOW);
}

interface PeerOptions {
	actorId?: string | null;
	claimed?: boolean;
	publicKey?: string | null;
	trustProvenance?: string | null;
}

function peer(deviceId: string, options: PeerOptions = {}) {
	const publicKey = options.publicKey === undefined ? `${deviceId}-key` : options.publicKey;
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, name, public_key, pinned_fingerprint, actor_id,
		 claimed_local_actor, trust_provenance, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		deviceId,
		`Name of ${deviceId}`,
		publicKey,
		publicKey ? fingerprintPublicKey(publicKey) : null,
		options.actorId ?? null,
		options.claimed ? 1 : 0,
		options.trustProvenance ?? null,
		NOW,
	);
}

function bind(deviceId: string, identityId: string, status = "active") {
	db.prepare(
		`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
		 revision, migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, ?, 'Bound', ?, 'user_confirmed_identity_setup', '1', 'user_managed', ?, ?, ?)`,
	).run(deviceId, identityId, status, `binding:${deviceId}`, NOW, NOW);
}

function binding(deviceId: string) {
	return db
		.prepare(
			"SELECT identity_id, status, provenance, display_name FROM identity_devices WHERE device_id = ?",
		)
		.get(deviceId);
}

function convert(coordinator: DeviceIdentityCoordinatorEvidence = available()) {
	return convertLegacyPairingAssignments(db, {
		localActorId: ME,
		localDeviceId: LOCAL_DEVICE,
		coordinator,
		now: () => NOW,
	});
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	actor(ME, { isLocal: true });
	actor(BO);
});

afterEach(() => db.close());

describe("converting a person assigned to a pairing", () => {
	it("binds a paired device to the person its pairing names", () => {
		peer(PEER, { actorId: BO });

		const result = convert();

		expect(result).toMatchObject({
			status: "converted",
			converted: [{ deviceId: PEER, identityId: BO }],
			review: [],
		});
		expect(binding(PEER)).toEqual({
			identity_id: BO,
			status: "active",
			provenance: LEGACY_PAIRING_ASSIGNMENT_PROVENANCE,
			display_name: `Name of ${PEER}`,
		});
	});

	it("binds a device claimed as the user's own to the local Identity", () => {
		peer(PEER, { claimed: true });

		convert();

		expect(binding(PEER)).toMatchObject({ identity_id: ME, status: "active" });
	});

	it("keeps a converted own device as one of this person's devices", () => {
		peer(PEER, { claimed: true, actorId: ME });
		expect(resolveSameActorPeerIds(db, ME)).toEqual([PEER]);

		convert();

		expect(resolveSameActorPeerIds(db, ME)).toEqual([PEER]);
	});

	it("makes the device one of the person's devices for recipient derivation and wakes the policy", () => {
		peer(PEER, { actorId: BO });
		db.prepare(
			`INSERT INTO project_recipients(canonical_project_identity, recipient_kind, recipient_id,
			 status, provenance, policy_revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES (?, 'identity', ?, 'active', 'test', '1', 'native', 'recipient:bo', ?, ?)`,
		).run(PROJECT, BO, NOW, NOW);
		db.prepare(
			`INSERT INTO recipient_policy_authority_states(canonical_project_identity, authority_state,
			 generation, state_changed_at, last_attempt_at, created_at, updated_at)
			 VALUES (?, 'legacy', 0, ?, ?, ?, ?)`,
		).run(PROJECT, NOW, NOW, NOW, NOW);

		convert();

		expect(
			deriveRecipientPolicyEffectiveDevicesFromDatabase(db, PROJECT).devices.map(
				(device) => device.deviceId,
			),
		).toEqual([PEER]);
		expect(
			db.prepare("SELECT last_attempt_at FROM recipient_policy_authority_states").pluck().get(),
		).toBeNull();
	});

	it("converts when the coordinator names the same person for the device", () => {
		peer(PEER, { actorId: BO });

		convert(available([enrollment(PEER, { identity_id: BO })]));

		expect(binding(PEER)).toMatchObject({ identity_id: BO });
	});
});

describe("assignments that are left for a person to review", () => {
	it.each([
		{
			name: "a claim as the user's own device that also names someone else",
			arrange: () => peer(PEER, { claimed: true, actorId: BO }),
			reason: "assignment_contradiction",
		},
		{
			name: "a pairing with no pinned key",
			arrange: () => peer(PEER, { actorId: BO, publicKey: null }),
			reason: "key_unproven",
		},
		{
			name: "a person who was deactivated",
			arrange: () => {
				actor("identity-gone", { status: "deactivated" });
				peer(PEER, { actorId: "identity-gone" });
			},
			reason: "identity_unavailable",
		},
		{
			name: "a person this device has no record of",
			arrange: () => peer(PEER, { actorId: "identity-unknown" }),
			reason: "identity_unavailable",
		},
		{
			name: "two device IDs that pin the same key",
			arrange: () => {
				peer(PEER, { actorId: BO, publicKey: "shared-key" });
				peer("device-alias", { publicKey: "shared-key" });
			},
			reason: "device_alias",
		},
		{
			name: "a device this install recorded as blocked",
			arrange: () => {
				peer(PEER, { actorId: BO });
				recordRetiredDeviceAliases(db, [
					{
						deviceId: PEER,
						kind: "device_id",
						fingerprint: fingerprintPublicKey(`${PEER}-key`),
						keyId: null,
					},
				]);
			},
			reason: "device_retired",
		},
	])("leaves $name unbound", ({ arrange, reason }) => {
		arrange();

		const result = convert();

		expect(result.converted).toEqual([]);
		expect(result.review).toEqual([{ deviceId: PEER, reason }]);
		expect(binding(PEER)).toBeUndefined();
	});

	it.each([
		{
			name: "names a different person",
			coordinator: () => available([enrollment(PEER, { identity_id: "identity-other" })]),
			reason: "suggestion_conflict",
		},
		{
			name: "has disabled the device",
			coordinator: () => available([enrollment(PEER, { enabled: 0 })]),
			reason: "evidence_conflict",
		},
		{
			name: "lists the device ID under a different key",
			coordinator: () =>
				available([
					enrollment(PEER, {
						public_key: "another-key",
						fingerprint: fingerprintPublicKey("another-key"),
					}),
				]),
			reason: "evidence_conflict",
		},
	])("leaves a device unbound when the coordinator $name", ({ coordinator, reason }) => {
		peer(PEER, { actorId: BO });

		const result = convert(coordinator());

		expect(result.review).toEqual([{ deviceId: PEER, reason }]);
		expect(binding(PEER)).toBeUndefined();
	});

	it("leaves a device unbound when two coordinator groups name different people for it", () => {
		peer(PEER, { claimed: true, actorId: ME });

		const result = convert(
			available([
				enrollment(PEER, { group_id: "group-a", identity_id: ME }),
				enrollment(PEER, { group_id: "group-b", identity_id: BO }),
			]),
		);

		expect(result.review).toEqual([{ deviceId: PEER, reason: "suggestion_conflict" }]);
		expect(binding(PEER)).toBeUndefined();
	});

	it("leaves a device unbound when its only key came from coordinator policy", () => {
		peer(PEER, { actorId: BO, trustProvenance: "coordinator_policy" });

		const result = convert(available([enrollment(PEER)]));

		expect(result.review).toEqual([{ deviceId: PEER, reason: "pairing_required" }]);
		expect(binding(PEER)).toBeUndefined();
	});
});

describe("bindings that already exist", () => {
	it("keeps a binding to another person and asks for no review", () => {
		peer(PEER, { actorId: BO });
		bind(PEER, ME);

		const result = convert();

		expect(result).toMatchObject({ converted: [], review: [], alreadyBound: [PEER] });
		expect(binding(PEER)).toMatchObject({ identity_id: ME });
	});

	it("does not bind again a device whose binding device removal ended", () => {
		peer(PEER, { actorId: BO });
		bind(PEER, BO, "removed");

		const result = convert();

		expect(result.converted).toEqual([]);
		expect(binding(PEER)).toMatchObject({ status: "removed" });
	});
});

describe("when the conversion runs", () => {
	it("waits, and changes nothing, while a configured coordinator cannot be read", () => {
		peer(PEER, { claimed: true, actorId: ME });

		const result = convert(UNREACHABLE);

		expect(result).toMatchObject({
			status: "waiting",
			waitingReason: "coordinator_evidence_unavailable",
			converted: [],
		});
		expect(binding(PEER)).toBeUndefined();
		expect(legacyPairingAssignmentsConverted(db)).toBe(false);
	});

	it("keeps counting an older claim for ownership until the conversion has run", () => {
		peer(PEER, { claimed: true, actorId: ME });

		convert(UNREACHABLE);

		expect(resolveSameActorPeerIds(db, ME)).toEqual([PEER]);
	});

	it.each([
		{ name: "no coordinator is configured", coordinator: NOT_CONFIGURED },
		{ name: "the coordinator cannot be read", coordinator: UNREACHABLE },
	])(
		"does not retire the older columns when $name, even with nothing to convert",
		({ coordinator }) => {
			peer(PEER);

			expect(convert(coordinator)).toMatchObject({ status: "waiting", converted: [] });
			expect(legacyPairingAssignmentsConverted(db)).toBe(false);
		},
	);

	it("finishes with nothing to convert once the coordinator can be read", () => {
		peer(PEER);

		expect(convert()).toMatchObject({ status: "converted", converted: [] });
		expect(legacyPairingAssignmentsConverted(db)).toBe(true);
	});

	it("runs once: a value written to the older columns afterward is not converted", () => {
		convert();
		peer(PEER, { actorId: BO });

		const result = convert();

		expect(result).toMatchObject({ status: "already_converted", converted: [] });
		expect(binding(PEER)).toBeUndefined();
	});

	it("stops counting an unconverted claim for ownership after it has run", () => {
		peer(PEER, { claimed: true, actorId: ME, publicKey: null });

		convert();

		expect(binding(PEER)).toBeUndefined();
		expect(resolveSameActorPeerIds(db, ME)).toEqual([]);
	});

	it("refuses to decide for a person this database has switched away from", () => {
		peer(PEER, { claimed: true, actorId: BO });
		db.exec(
			`CREATE TABLE local_identity_generation(id INTEGER PRIMARY KEY, generation INTEGER, actor_id TEXT);
			 INSERT INTO local_identity_generation VALUES (1, 2, '${BO}')`,
		);

		expect(() => convert()).toThrow(LocalIdentitySupersededError);
		expect(legacyPairingAssignmentsConverted(db)).toBe(false);
	});

	it("records the local Identity only when the conversion is going to finish", () => {
		peer(PEER, { claimed: true });
		const ensureLocalIdentity = vi.fn(() => true);
		const input = { localActorId: ME, localDeviceId: LOCAL_DEVICE, ensureLocalIdentity };

		convertLegacyPairingAssignments(db, { ...input, coordinator: UNREACHABLE });
		expect(ensureLocalIdentity).not.toHaveBeenCalled();

		convertLegacyPairingAssignments(db, { ...input, coordinator: available() });
		expect(ensureLocalIdentity).toHaveBeenCalledOnce();
	});

	it("waits, and writes no marker, when the local Identity cannot be recorded", () => {
		peer(PEER, { claimed: true });

		const result = convertLegacyPairingAssignments(db, {
			localActorId: ME,
			localDeviceId: LOCAL_DEVICE,
			coordinator: available(),
			ensureLocalIdentity: () => false,
		});

		expect(result).toMatchObject({ status: "waiting", waitingReason: "local_identity_conflict" });
		expect(binding(PEER)).toBeUndefined();
		expect(legacyPairingAssignmentsConverted(db)).toBe(false);
	});

	it("ignores a pairing row for this device itself", () => {
		peer(LOCAL_DEVICE, { claimed: true });

		expect(convert()).toMatchObject({ status: "converted", converted: [], review: [] });
		expect(binding(LOCAL_DEVICE)).toBeUndefined();
	});
});
