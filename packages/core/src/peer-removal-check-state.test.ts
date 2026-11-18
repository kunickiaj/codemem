import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAdditiveSchemaCompatibility } from "./db.js";
import {
	commitDeviceIdentityBindings,
	previewDeviceIdentityBindings,
	reactivateEndedBindingInTransaction,
} from "./device-identity-binding.js";
import type { DeviceIdentityInventoryInput } from "./device-identity-inventory.js";
import { removePairingState } from "./pairing-removal.js";
import {
	ensurePeerRemovalCheckState,
	readAppliedRemovalSeq,
	readPeerRemovalCheckState,
	storeAppliedRemovalSeq,
} from "./peer-removal-check-state.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-18T00:00:00.000Z";
let db: InstanceType<typeof Database>;

function pair(deviceId: string) {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
		 VALUES (?, 'key-1', 'fingerprint-1', ?)`,
	).run(deviceId, NOW);
}

function bind(deviceId: string, status = "active") {
	db.prepare(
		`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
		 revision, migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, 'identity-a', 'Laptop', ?, 'test', '1', 'user_managed', ?, ?, ?)`,
	).run(deviceId, status, `key:${deviceId}`, NOW, NOW);
}

/** Marks every current entry as covered, as a complete lookup does. */
function completeLookup(removalSeq = 7) {
	const state = readPeerRemovalCheckState(db);
	if (!state) throw new Error("state missing");
	expect(storeAppliedRemovalSeq(db, { generation: state.generation, removalSeq })).toBe(true);
	return state.generation;
}

function expectReset(generationBefore: number) {
	expect(readPeerRemovalCheckState(db)).toEqual({
		generation: generationBefore + 1,
		appliedRemovalSeq: 0,
	});
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	pair("peer-a");
	bind("peer-a");
	bind("peer-ended", "removed");
});

afterEach(() => db.close());

describe("peer removal check state", () => {
	it.each([
		["a new pairing", () => pair("peer-new")],
		["a new binding", () => bind("peer-new")],
		[
			"a changed pinned key",
			() => db.exec("UPDATE sync_peers SET public_key = 'key-2', pinned_fingerprint = 'fp-2'"),
		],
		["a changed pairing device ID", () => db.exec("UPDATE sync_peers SET peer_device_id = 'x'")],
		[
			"a pairing upsert that replaces the key",
			() =>
				db.exec(`INSERT INTO sync_peers(peer_device_id, public_key, created_at)
					VALUES ('peer-a', 'key-2', '${NOW}')
					ON CONFLICT(peer_device_id) DO UPDATE SET public_key = excluded.public_key`),
		],
		[
			"a binding status set back to active",
			() => db.exec("UPDATE identity_devices SET status = 'active' WHERE device_id = 'peer-ended'"),
		],
	])(
		"H17: %s sets the stored number to 0 and advances the counter in the same transaction",
		(_case, write) => {
			const generation = completeLookup();

			write();

			expectReset(generation);
		},
	);

	it("H17: the binding reactivation helper resets the stored number", () => {
		const generation = completeLookup();

		db.transaction(() =>
			reactivateEndedBindingInTransaction(db, {
				deviceId: "peer-ended",
				targetIdentityId: "identity-a",
				displayName: "Laptop",
				provenance: "coordinator_enrollment",
				revision: "2",
				migrationState: "user_managed",
				sourceFingerprint: null,
				idempotencyKey: "key:reactivated",
				now: NOW,
			}),
		)();

		expectReset(generation);
	});

	it("H17: a write that rolls back leaves the stored number and the counter unchanged", () => {
		const generation = completeLookup();

		expect(() =>
			db.transaction(() => {
				pair("peer-new");
				throw new Error("rolled back");
			})(),
		).toThrow("rolled back");

		expect(readPeerRemovalCheckState(db)).toEqual({ generation, appliedRemovalSeq: 7 });
	});

	it.each([
		[
			"rewriting a pairing's key with the same values",
			() =>
				db.exec(`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
					VALUES ('peer-a', 'key-1', 'fingerprint-1', '${NOW}')
					ON CONFLICT(peer_device_id) DO UPDATE SET public_key = excluded.public_key,
					pinned_fingerprint = excluded.pinned_fingerprint, last_seen_at = '${NOW}'`),
		],
		["updating a pairing's other columns", () => db.exec("UPDATE sync_peers SET name = 'Renamed'")],
		[
			"updating an active binding's other columns",
			() => db.exec("UPDATE identity_devices SET display_name = 'Renamed'"),
		],
		[
			"removing a pairing and ending its binding",
			() =>
				removePairingState(db, {
					localDeviceId: "local",
					reason: "removed",
					deviceIds: ["peer-a"],
				}),
		],
	])("does not reset the stored number when %s", (_case, write) => {
		const generation = completeLookup();

		write();

		expect(readPeerRemovalCheckState(db)).toEqual({ generation, appliedRemovalSeq: 7 });
	});

	it("H18: refuses to store a number read under an older counter value", () => {
		const generation = readPeerRemovalCheckState(db)?.generation ?? -1;
		pair("peer-new");

		expect(storeAppliedRemovalSeq(db, { generation, removalSeq: 7 })).toBe(false);
		expect(readAppliedRemovalSeq(db)).toBe(0);
	});

	it("reinstalls a dropped trigger on the next open and withdraws the stored number", () => {
		completeLookup();
		db.exec("DROP TRIGGER sync_peer_removal_generation_pairing_insert");
		expect(readAppliedRemovalSeq(db)).toBe(0);

		ensureAdditiveSchemaCompatibility(db);

		expect(readPeerRemovalCheckState(db)).toMatchObject({ appliedRemovalSeq: 0 });
		const generation = completeLookup();
		pair("peer-new");
		expectReset(generation);
	});

	it("installs nothing on a database without the pairing and binding tables", () => {
		const bare = new Database(":memory:");
		try {
			ensurePeerRemovalCheckState(bare);

			expect(readPeerRemovalCheckState(bare)).toBeNull();
			expect(readAppliedRemovalSeq(bare)).toBe(0);
		} finally {
			bare.close();
		}
	});
});

describe("binding reactivation through Devices", () => {
	it("H17: binding a removed device again in Devices resets the stored number", () => {
		const inventory: DeviceIdentityInventoryInput = {
			localDeviceId: "device-local",
			coordinator: { availability: "available", safeErrorCode: null, enrollments: [] },
		};
		const request = {
			bindings: [{ deviceId: "peer-ended", targetIdentityId: "identity-a", confirmed: true }],
		};
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-local', 'Local', 1, 'active', ?, ?), ('identity-a', 'Ada', 0, 'active', ?, ?)`,
		).run(NOW, NOW, NOW, NOW);
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
			 VALUES ('peer-ended', 'key-ended', ?, ?)`,
		).run(fingerprintPublicKey("key-ended"), NOW);
		const generation = completeLookup();

		const result = commitDeviceIdentityBindings(
			db,
			{ localActorId: "identity-local", localDeviceId: "device-local" },
			inventory,
			{
				...request,
				reviewedInventoryDigest: previewDeviceIdentityBindings(db, inventory, request)
					.reviewedInventoryDigest,
			},
		);

		expect(result).toMatchObject({ status: "applied", writeCount: 1 });
		expect(
			db
				.prepare("SELECT status FROM identity_devices WHERE device_id = 'peer-ended'")
				.pluck()
				.get(),
		).toBe("active");
		expectReset(generation);
	});
});
