import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./store.js";
import { updatePeerAddresses } from "./sync-peer-addresses.js";
import {
	ensureSyncPeerTransportPolicySchema,
	promotePeerToNoiseRequired,
	readPeerTransportPolicy,
} from "./sync-transport-policy.js";
import { initTestSchema, insertTestPeer } from "./test-utils.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});

function testDb(): Database.Database {
	const db = new Database(":memory:");
	cleanup.push(() => db.close());
	initTestSchema(db);
	return db;
}

function policyRow(db: Database.Database, peerDeviceId: string) {
	return db
		.prepare("SELECT policy, source FROM sync_peer_transport_policy WHERE peer_device_id = ?")
		.get(peerDeviceId);
}

describe("sync peer transport policy", () => {
	it("records every new pairing as legacy plaintext", () => {
		const db = testDb();
		insertTestPeer(db, "peer-a");
		updatePeerAddresses(db, "peer-b", ["http://127.0.0.1:7337"], {
			pinnedFingerprint: "fp",
			publicKey: "key",
			replaceTrust: true,
		});
		expect(policyRow(db, "peer-a")).toEqual({ policy: "legacy_plaintext", source: "pairing" });
		expect(readPeerTransportPolicy(db, "peer-b")).toBe("legacy_plaintext");
		expect(readPeerTransportPolicy(db, "unknown")).toBeNull();
	});

	it("records pairings from before the table as legacy plaintext on open", () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem-transport-policy-"));
		cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
		const path = join(directory, "mem.sqlite");
		const first = new MemoryStore(path);
		insertTestPeer(first.db, "peer-a");
		first.db.exec(`DROP TRIGGER sync_peer_transport_policy_default_after_insert;
			DROP TRIGGER sync_peer_transport_policy_no_demotion;
			DROP TABLE sync_peer_transport_policy;`);
		insertTestPeer(first.db, "peer-b");
		first.close();

		const reopened = new MemoryStore(path);
		cleanup.push(() => reopened.close());
		expect(policyRow(reopened.db, "peer-a")).toEqual({
			policy: "legacy_plaintext",
			source: "migration",
		});
		expect(readPeerTransportPolicy(reopened.db, "peer-b")).toBe("legacy_plaintext");
		insertTestPeer(reopened.db, "peer-c");
		expect(readPeerTransportPolicy(reopened.db, "peer-c")).toBe("legacy_plaintext");
	});

	it("promotes once and never demotes", () => {
		const db = testDb();
		insertTestPeer(db, "peer-a");
		expect(promotePeerToNoiseRequired(db, "peer-a", "pairing_payload")).toBe(true);
		expect(promotePeerToNoiseRequired(db, "peer-a", "transport_statement")).toBe(false);
		expect(policyRow(db, "peer-a")).toEqual({
			policy: "noise_required",
			source: "pairing_payload",
		});
		expect(() =>
			db
				.prepare(
					"UPDATE sync_peer_transport_policy SET policy = 'legacy_plaintext' WHERE peer_device_id = ?",
				)
				.run("peer-a"),
		).toThrow(/cannot be demoted/);
		ensureSyncPeerTransportPolicySchema(db);
		expect(readPeerTransportPolicy(db, "peer-a")).toBe("noise_required");
	});

	it("keeps noise_required through re-pinning, removal and re-pairing", () => {
		const db = testDb();
		insertTestPeer(db, "peer-a");
		promotePeerToNoiseRequired(db, "peer-a", "pairing_payload");
		updatePeerAddresses(db, "peer-a", ["http://127.0.0.1:7337"], {
			pinnedFingerprint: "new-fp",
			publicKey: "new-key",
			replaceTrust: true,
		});
		expect(readPeerTransportPolicy(db, "peer-a")).toBe("noise_required");
		db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run("peer-a");
		expect(readPeerTransportPolicy(db, "peer-a")).toBe("noise_required");
		insertTestPeer(db, "peer-a");
		ensureSyncPeerTransportPolicySchema(db);
		expect(readPeerTransportPolicy(db, "peer-a")).toBe("noise_required");
	});

	it("keeps noise_required when the pairing row is replaced", () => {
		const db = testDb();
		insertTestPeer(db, "peer-a");
		promotePeerToNoiseRequired(db, "peer-a", "pairing_payload");
		// The trigger's default insert runs under the outer statement's REPLACE policy.
		for (const verb of ["INSERT OR REPLACE", "REPLACE"]) {
			db.prepare(
				`${verb} INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
				 VALUES ('peer-a', 'key', 'fp', '2026-11-27T00:00:00.000Z')`,
			).run();
			expect(policyRow(db, "peer-a")).toEqual({
				policy: "noise_required",
				source: "pairing_payload",
			});
		}
		db.prepare(
			`INSERT OR REPLACE INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
			 VALUES ('peer-new', 'key', 'fp', '2026-11-27T00:00:00.000Z')`,
		).run();
		expect(readPeerTransportPolicy(db, "peer-new")).toBe("legacy_plaintext");
	});

	it("refuses to demote by replacing or re-inserting the policy row", () => {
		const db = testDb();
		insertTestPeer(db, "peer-a");
		promotePeerToNoiseRequired(db, "peer-a", "pairing_payload");
		for (const verb of ["INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE"]) {
			const demote = () =>
				db
					.prepare(
						`${verb} INTO sync_peer_transport_policy(peer_device_id, policy, source, recorded_at)
						 VALUES ('peer-a', 'legacy_plaintext', 'attempt', '2026-11-27T00:00:00.000Z')`,
					)
					.run();
			expect(demote).toThrow(/cannot be demoted/);
			expect(readPeerTransportPolicy(db, "peer-a")).toBe("noise_required");
		}
	});

	it("can promote a device this store has not paired yet", () => {
		const db = testDb();
		expect(promotePeerToNoiseRequired(db, "peer-later", "transport_statement")).toBe(true);
		insertTestPeer(db, "peer-later");
		expect(readPeerTransportPolicy(db, "peer-later")).toBe("noise_required");
		expect(() => promotePeerToNoiseRequired(db, "  ", "pairing_payload")).toThrow();
	});
});
