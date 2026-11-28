import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removePairingState } from "./pairing-removal.js";
import { listRetiredDeviceAliases } from "./retired-device-aliases.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";
import { listUnpairedPeerPins, readUnpairedPeerPin } from "./unpaired-peer-pin.js";

const LOCAL = "device-local";
const PEER = "device-peer";
const KEY = "key-device-peer";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	pair(PEER, KEY);
});

afterEach(() => db.close());

function pair(deviceId: string, publicKey: string | null, fingerprint?: string) {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
		 VALUES (?, ?, ?, 'then')`,
	).run(deviceId, publicKey, fingerprint ?? (publicKey ? fingerprintPublicKey(publicKey) : null));
}

const remove = (reason: "disconnect" | "removed" | "local" | "revoked", deviceId = PEER) =>
	removePairingState(db, { localDeviceId: LOCAL, reason, deviceIds: [deviceId] });
const kept = (deviceId = PEER) =>
	readUnpairedPeerPin(db, { localDeviceId: LOCAL, peerDeviceId: deviceId });

describe("the pin kept when this device unpairs", () => {
	it("holds the last verified key and fingerprint after the pairing is gone", () => {
		remove("disconnect");

		expect(db.prepare("SELECT COUNT(*) FROM sync_peers").pluck().get()).toBe(0);
		expect(kept()).toMatchObject({
			deviceId: PEER,
			publicKey: KEY,
			pinnedFingerprint: fingerprintPublicKey(KEY),
		});
		expect(listUnpairedPeerPins(db, LOCAL).map((pin) => pin.deviceId)).toEqual([PEER]);
	});

	it("is replaced by the pin of the next pairing that is unpaired", () => {
		remove("disconnect");
		pair(PEER, "key-rotated");

		remove("disconnect");

		expect(kept()?.publicKey).toBe("key-rotated");
	});

	it("records no pin that fails its fingerprint, or a pairing that has none", () => {
		pair("bad-fingerprint", "key-bad", "not-the-fingerprint");
		pair("no-key", null);

		remove("disconnect", "bad-fingerprint");
		remove("disconnect", "no-key");

		expect(listUnpairedPeerPins(db, LOCAL)).toEqual([]);
	});

	it.each(["removed", "local", "revoked"] as const)(
		"is cleared when the device is dealt with by %s",
		(reason) => {
			remove("disconnect");
			expect(kept()).not.toBeNull();

			remove(reason);

			expect(kept()).toBeNull();
		},
	);

	it("is not authorization for sync: unpairing leaves no pairing for any sync path to read", () => {
		remove("disconnect");

		expect(
			db.prepare("SELECT 1 FROM sync_peers WHERE peer_device_id = ?").get(PEER),
		).toBeUndefined();
	});

	it("stands in for the deleted pin when the coordinator revokes the key, so the alias is still retired", () => {
		remove("disconnect");

		remove("revoked");

		expect(listRetiredDeviceAliases(db).get(PEER)).toMatchObject({
			kind: "key",
			fingerprint: fingerprintPublicKey(KEY),
		});
	});
});
