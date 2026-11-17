import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	commitDeviceIdentityBindings,
	previewDeviceIdentityBindings,
} from "./device-identity-binding.js";
import type { DeviceIdentityInventoryInput } from "./device-identity-inventory.js";
import { removePairingState } from "./pairing-removal.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

const LOCAL = "device-local";
const PEER = "device-peer";
const PEER_KEY = "peer-key";
const IDENTITY = "identity-other";
const START = Date.parse("2026-11-18T00:00:00.000Z");
const INVENTORY: DeviceIdentityInventoryInput = {
	localDeviceId: LOCAL,
	coordinator: { availability: "available", safeErrorCode: null, enrollments: [] },
};
const REQUEST = {
	bindings: [{ deviceId: PEER, targetIdentityId: IDENTITY, confirmed: true }],
};
/** The preview digest for the never-removed fixture, recorded before ended bindings entered the digest. */
const DIGEST_WITHOUT_ENDED_BINDING =
	"device-identity-binding-preview-v1:d2951c6aa765fcc4c5b2638d1c13ca457de6e698ea2ca2017d03b31db6a8dae8";

let db: InstanceType<typeof Database>;

function pair() {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, name, public_key, pinned_fingerprint, created_at)
		 VALUES (?, 'Peer', ?, ?, '2026-11-18T00:00:00.000Z')`,
	).run(PEER, PEER_KEY, fingerprintPublicKey(PEER_KEY));
}

const preview = () => previewDeviceIdentityBindings(db, INVENTORY, REQUEST);

function commit(reviewedInventoryDigest: string) {
	return commitDeviceIdentityBindings(
		db,
		{ localActorId: "identity-local", localDeviceId: LOCAL },
		INVENTORY,
		{ ...REQUEST, reviewedInventoryDigest },
	);
}

/** Preview, then confirm what was previewed, as Devices does. */
function bindInDevices() {
	const reviewed = preview();
	return { reviewed, result: commit(reviewed.reviewedInventoryDigest) };
}

/** Ends the binding one minute later and pairs the same device ID and key again. */
function removeAndPairAgain() {
	vi.setSystemTime(Date.now() + 60_000);
	removePairingState(db, { localDeviceId: LOCAL, reason: "local", deviceIds: [PEER] });
	pair();
}

const binding = () =>
	db.prepare("SELECT identity_id, status FROM identity_devices WHERE device_id = ?").get(PEER);
const count = (table: string) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(START);
	db = new Database(":memory:");
	initTestSchema(db);
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES ('identity-local', 'Local', 1, 'active', ?, ?), (?, 'Other', 0, 'active', ?, ?)`,
	).run(
		"2026-11-18T00:00:00.000Z",
		"2026-11-18T00:00:00.000Z",
		IDENTITY,
		"2026-11-18T00:00:00.000Z",
		"2026-11-18T00:00:00.000Z",
	);
	pair();
});

afterEach(() => {
	db.close();
	vi.useRealTimers();
});

describe("binding a device in Devices after it was removed", () => {
	it("keeps the preview digest of a device that was never removed byte for byte", () => {
		expect(preview().reviewedInventoryDigest).toBe(DIGEST_WITHOUT_ENDED_BINDING);
	});

	it("binds a removed device that was paired again, as a new commit with its own audit row", () => {
		const first = bindInDevices();
		expect(first.result).toMatchObject({ status: "applied", writeCount: 1 });
		removeAndPairAgain();
		expect(binding()).toEqual({ identity_id: IDENTITY, status: "removed" });

		const second = bindInDevices();

		expect(second.reviewed.reviewedInventoryDigest).not.toBe(
			first.reviewed.reviewedInventoryDigest,
		);
		expect(second.result).toMatchObject({ status: "applied", writeCount: 1, idempotent: false });
		expect(binding()).toEqual({ identity_id: IDENTITY, status: "active" });
		expect(count("device_identity_binding_commits")).toBe(2);
		expect(count("device_identity_binding_audit")).toBe(2);
	});

	it("treats an exact retry of the new commit as idempotent", () => {
		bindInDevices();
		removeAndPairAgain();
		const second = bindInDevices();

		const retry = commit(second.reviewed.reviewedInventoryDigest);

		expect(retry).toMatchObject({ status: "applied", writeCount: 0, idempotent: true });
		expect(count("device_identity_binding_commits")).toBe(2);
	});

	it("still refuses a replay of the original commit after the removal", () => {
		const first = bindInDevices();
		removeAndPairAgain();

		const replay = commit(first.reviewed.reviewedInventoryDigest);

		expect(replay).toMatchObject({ status: "stale", errorCode: "binding_retry_stale" });
		expect(binding()).toEqual({ identity_id: IDENTITY, status: "removed" });
		expect(count("device_identity_binding_commits")).toBe(1);
	});

	it("binds again after a second removal, because the binding ended at a different time", () => {
		bindInDevices();
		removeAndPairAgain();
		const second = bindInDevices();
		removeAndPairAgain();

		const third = bindInDevices();

		expect(third.reviewed.reviewedInventoryDigest).not.toBe(
			second.reviewed.reviewedInventoryDigest,
		);
		expect(third.result).toMatchObject({ status: "applied", writeCount: 1 });
		expect(binding()).toEqual({ identity_id: IDENTITY, status: "active" });
		expect(count("device_identity_binding_commits")).toBe(3);
	});
});
