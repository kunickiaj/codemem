import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import { listDeviceIdentityInventory } from "./device-identity-inventory.js";
import {
	removeRevokedPeers,
	resolveRetireTarget,
	retireDeviceLocally,
} from "./device-retirement.js";
import { ensureMemoryRetirementDeliverySchema } from "./memory-retirement-delivery-schema.js";
import { canonicalKeyId, listRetiredDeviceAliases } from "./retired-device-aliases.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-16T00:00:00.000Z";
let db: InstanceType<typeof Database>;

/** A well-formed SSH Ed25519 key whose 32 key bytes all equal `byte`. */
function sshKey(byte: number): string {
	const type = Buffer.from("ssh-ed25519");
	const length = (value: number) => Buffer.from([0, 0, 0, value]);
	const wire = Buffer.concat([length(type.length), type, length(32), Buffer.alloc(32, byte)]);
	return `ssh-ed25519 ${wire.toString("base64")}`;
}

const LOCAL_KEY = sshKey(1);
const OLD_KEY = sshKey(2);
const NEW_KEY = sshKey(3);

function enrollment(deviceId: string, publicKey: string): CoordinatorEnrollment {
	return {
		group_id: "group-a",
		device_id: deviceId,
		public_key: publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		identity_id: null,
		display_name: "Old laptop",
		enabled: 1,
		created_at: NOW,
	};
}

function pair(deviceId: string, publicKey: string, pinned = fingerprintPublicKey(publicKey)) {
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES (?, ?, ?, ?)",
	).run(deviceId, pinned, publicKey, NOW);
}

function offlineStates() {
	return listDeviceIdentityInventory(db, {
		localDeviceId: "local",
		coordinator: {
			availability: "unavailable",
			safeErrorCode: "coordinator_unavailable",
			enrollments: [],
		},
	})
		.items.filter((item) => !item.isLocal)
		.map((item) => ({ deviceId: item.deviceId, state: item.state }));
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	ensureMemoryRetirementDeliverySchema(db);
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES ('local', ?, ?, ?)",
	).run(LOCAL_KEY, fingerprintPublicKey(LOCAL_KEY), NOW);
	pair("peer-a", OLD_KEY);
	db.prepare(
		`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
		 revision, migration_state, idempotency_key, created_at, updated_at)
		 VALUES ('peer-a', 'identity-a', 'Old laptop', 'active', 'test', '1', 'user_managed', 'k', ?, ?)`,
	).run(NOW, NOW);
});

afterEach(() => db.close());

describe("resolveRetireTarget", () => {
	it("finds the enrollment alias and every local ID for the same key", () => {
		const target = resolveRetireTarget(db, {
			localDeviceId: "local",
			enrollments: [enrollment("coord-alias", OLD_KEY)],
			deviceId: "peer-a",
		});

		expect(target).toMatchObject({
			aliasDeviceIds: ["coord-alias", "peer-a"],
			fingerprint: fingerprintPublicKey(OLD_KEY),
			groupId: "group-a",
			enrollmentDeviceId: "coord-alias",
		});
	});

	it("refuses an enrollment carrying this device's canonical key under different text", () => {
		const target = resolveRetireTarget(db, {
			localDeviceId: "local",
			enrollments: [enrollment("spare", `${LOCAL_KEY} comment`)],
			deviceId: "spare",
		});

		expect(target).toBe("cannot_retire_this_device");
	});

	it("refuses while the viewer runs under an ID that has no identity row", () => {
		const target = resolveRetireTarget(db, {
			localDeviceId: "not-yet-stable",
			enrollments: [enrollment("local", LOCAL_KEY), enrollment("peer-a", OLD_KEY)],
			deviceId: "local",
		});

		expect(target).toBe("local_identity_unverified");
	});
});

describe("retired device aliases", () => {
	it("keeps a revoked peer's binding retired after its pairing is deleted", () => {
		removeRevokedPeers(db, "local", ["peer-a"]);

		expect(offlineStates()).toEqual([{ deviceId: "peer-a", state: "retired" }]);
		expect(db.prepare("SELECT COUNT(*) FROM sync_peers").pluck().get()).toBe(0);
	});

	it("computes the same canonical key ID the coordinator revokes", async () => {
		expect(canonicalKeyId(`${OLD_KEY} comment`)).toBe(await ed25519KeyIdForRevocation(OLD_KEY));
		expect(canonicalKeyId("pk-legacy")).toBeNull();
	});

	it("stays retired when the ID is paired again with different text for the revoked key", () => {
		removeRevokedPeers(db, "local", ["peer-a"]);
		pair("peer-a", `${OLD_KEY} comment`);

		expect(offlineStates().map((item) => item.state)).toContain("retired");
	});

	it("keeps a re-paired ID with no Identity binding retired while it pins the revoked key", () => {
		db.prepare("DELETE FROM identity_devices").run();
		removeRevokedPeers(db, "local", ["peer-a"]);
		pair("peer-a", OLD_KEY);

		expect(offlineStates()).toEqual([{ deviceId: "peer-a", state: "retired" }]);
	});

	it("clears a key-only retirement when the ID is paired again with a new key", () => {
		removeRevokedPeers(db, "local", ["peer-a"]);
		pair("peer-a", NEW_KEY);

		expect(offlineStates().map((item) => item.state)).not.toContain("retired");
	});

	it("keeps an ID revocation in force even when the ID is paired again", () => {
		retireDeviceLocally(db, "local", {
			aliasDeviceIds: ["peer-a"],
			displayName: "Old laptop",
			fingerprint: fingerprintPublicKey(OLD_KEY),
			keyId: canonicalKeyId(OLD_KEY) as string,
			groupId: "group-a",
			enrollmentDeviceId: "peer-a",
		});
		pair("peer-a", NEW_KEY);

		expect(listRetiredDeviceAliases(db).get("peer-a")?.kind).toBe("device_id");
		expect(offlineStates().map((item) => item.state)).toContain("retired");
	});

	it("leaves an alias that was re-paired with a new key before the local cleanup", () => {
		pair("peer-b", NEW_KEY);

		retireDeviceLocally(db, "local", {
			aliasDeviceIds: ["coord-alias", "peer-a", "peer-b"],
			displayName: "Old laptop",
			fingerprint: fingerprintPublicKey(OLD_KEY),
			keyId: canonicalKeyId(OLD_KEY) as string,
			groupId: "group-a",
			enrollmentDeviceId: "coord-alias",
		});

		expect(db.prepare("SELECT peer_device_id FROM sync_peers").pluck().all()).toEqual(["peer-b"]);
		expect([...listRetiredDeviceAliases(db).keys()].sort()).toEqual(["coord-alias", "peer-a"]);
	});

	it("records nothing for a peer whose pinned fingerprint doesn't match its key", () => {
		db.prepare("DELETE FROM sync_peers").run();
		pair("peer-a", OLD_KEY, fingerprintPublicKey(NEW_KEY));

		removeRevokedPeers(db, "local", ["peer-a"]);

		expect(listRetiredDeviceAliases(db).size).toBe(0);
	});
});
