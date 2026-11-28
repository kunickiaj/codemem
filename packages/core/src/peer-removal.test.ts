import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryRetirementDeliverySchema } from "./memory-retirement-delivery-schema.js";
import { removePeerFromThisDevice } from "./peer-removal.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-17T00:00:00.000Z";
const LOCAL = "device-local";
const PEER = "device-peer";
const IDENTITY = "identity-a";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	ensureMemoryRetirementDeliverySchema(db);
	seedPeer(PEER);
});

afterEach(() => db.close());

function seedPeer(deviceId: string) {
	db.prepare("INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES (?, 'Peer', ?)").run(
		deviceId,
		NOW,
	);
	db.prepare(
		`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
		 revision, migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, ?, 'Peer', 'active', 'test', '1', 'user_managed', ?, ?, ?)`,
	).run(deviceId, IDENTITY, `binding:${deviceId}`, NOW, NOW);
}

function state(deviceId = PEER) {
	return {
		pairings: Number(
			db.prepare("SELECT COUNT(*) FROM sync_peers WHERE peer_device_id = ?").pluck().get(deviceId),
		),
		binding: db
			.prepare("SELECT status FROM identity_devices WHERE device_id = ?")
			.pluck()
			.get(deviceId),
	};
}

describe("removePeerFromThisDevice", () => {
	it("deletes the pairing and keeps the Identity binding", () => {
		const result = removePeerFromThisDevice(db, { localDeviceId: LOCAL, peerDeviceId: PEER });

		expect(result.binding).toBe("kept");
		expect(result.removed).toMatchObject({ syncPeers: 1, identityDevices: 0 });
		expect(state()).toEqual({ pairings: 0, binding: "active" });
	});

	it("leaves the cached scope authorization and Project recipient wake-ups alone", () => {
		db.prepare(
			`INSERT INTO recipient_policy_authority_states(canonical_project_identity, authority_state,
			 generation, state_changed_at, last_attempt_at, created_at, updated_at)
			 VALUES ('project-a', 'active', 1, ?, ?, ?, ?)`,
		).run(NOW, NOW, NOW, NOW);

		removePeerFromThisDevice(db, { localDeviceId: LOCAL, peerDeviceId: PEER });

		// The reconciler clears this when a Project's policy is woken.
		expect(
			db.prepare("SELECT last_attempt_at FROM recipient_policy_authority_states").pluck().get(),
		).toBe(NOW);
	});

	it("never ends this device's own binding", () => {
		seedPeer(LOCAL);

		const result = removePeerFromThisDevice(db, { localDeviceId: LOCAL, peerDeviceId: LOCAL });

		expect(result.removed).toMatchObject({ syncPeers: 1, identityDevices: 0 });
		expect(state(LOCAL)).toEqual({ pairings: 0, binding: "active" });
		expect(state(PEER).pairings).toBe(1);
	});
});
