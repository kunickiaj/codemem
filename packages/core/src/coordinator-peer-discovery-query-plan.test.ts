import type { Database } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	CAPTURE_PEER_ENROLLMENTS_SQL,
	type CapturedPeerEnrollment,
	READ_CURRENT_PEERS_SQL,
} from "./coordinator-peer-discovery.js";

const NOW = "2026-10-01T00:00:00.000Z";
const REVOKED_KEY_ID = "a".repeat(64);

function insertEnrollment(db: Database, deviceId: string, groupId = "group-a") {
	db.prepare(`INSERT INTO enrolled_devices
		(group_id, device_id, public_key, fingerprint, identity_id, display_name, enabled, created_at)
		VALUES (?, ?, ?, ?, NULL, ?, 1, ?)`).run(
		groupId,
		deviceId,
		`key-${deviceId}`,
		`fingerprint-${deviceId}`,
		`Device ${deviceId}`,
		NOW,
	);
}

function capture(db: Database) {
	const rows = db
		.prepare(CAPTURE_PEER_ENROLLMENTS_SQL)
		.all("group-a", "requester") as CapturedPeerEnrollment[];
	return rows.map((row) => ({
		...row,
		keyId: row.device_id === "revoked-key" ? REVOKED_KEY_ID : "b".repeat(64),
	}));
}

function insertRevocation(db: Database, kind: string, value: string) {
	// Revocations apply globally even when their evidence came from another group.
	db.prepare(`INSERT INTO coordinator_device_revocations
		(subject_kind, subject_value, revocation_id, evidence_group_id, evidence_device_id,
		evidence_public_key, evidence_fingerprint, created_at)
		VALUES (?, ?, ?, 'other-group', 'other-device', 'other-key', 'other-fingerprint', ?)`).run(
		kind,
		value,
		`revocation-${kind}`,
		NOW,
	);
}

describe("captured-peer query ordering", () => {
	it("scans captured candidates before full enrollment primary-key seeks without ANALYZE", async () => {
		// Arrange: use the shipped schema with no planner statistics or time thresholds.
		const { store, db } = setupStore("SQLite");
		try {
			for (let index = 0; index < 32; index++) insertEnrollment(db, `peer-${index}`);
			const candidates = JSON.stringify(capture(db));

			// Act
			const plan = db
				.prepare(`EXPLAIN QUERY PLAN ${READ_CURRENT_PEERS_SQL}`)
				.all(candidates, "group-a", "requester") as { detail: string }[];
			const details = plan.map((row) => row.detail);
			const capturedStep = details.findIndex((detail) => /SCAN captured\b/u.test(detail));
			const enrollmentStep = details.findIndex((detail) => /SEARCH e\b/u.test(detail));

			// Assert: do not couple to subquery node IDs, index auto-names, or the whole plan text.
			expect(capturedStep).toBeGreaterThanOrEqual(0);
			expect(enrollmentStep).toBeGreaterThan(capturedStep);
			expect(details[enrollmentStep]).toMatch(/USING INDEX .*\(group_id=\? AND device_id=\?\)/u);
			expect(details.some((detail) => /SCAN e\b/u.test(detail))).toBe(false);
			expect(
				db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").all(),
			).toEqual([]);
		} finally {
			await store.close();
		}
	});

	it("matches the former JOIN while excluding changed tuples, uncaptured peers, and global revocations", async () => {
		// Arrange: cover each enrollment pin and retain fresh metadata/presence from the final read.
		const { store, db } = setupStore("SQLite");
		try {
			for (const deviceId of [
				"active",
				"no-presence",
				"changed-key",
				"changed-fingerprint",
				"changed-identity",
				"cleared-identity",
				"disabled",
				"removed",
				"revoked-device",
				"revoked-key",
				"requester",
			])
				insertEnrollment(db, deviceId);
			db.prepare(
				"UPDATE enrolled_devices SET identity_id = 'original-identity' WHERE device_id = 'cleared-identity'",
			).run();
			const candidates = capture(db);
			insertEnrollment(db, "uncaptured");
			insertEnrollment(db, "active", "other-group");
			db.prepare(
				"UPDATE enrolled_devices SET public_key = 'replacement-key' WHERE device_id = 'changed-key'",
			).run();
			db.prepare(
				"UPDATE enrolled_devices SET fingerprint = 'replacement-fingerprint' WHERE device_id = 'changed-fingerprint'",
			).run();
			db.prepare(
				"UPDATE enrolled_devices SET identity_id = 'replacement-identity' WHERE device_id = 'changed-identity'",
			).run();
			db.prepare(
				"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = 'cleared-identity'",
			).run();
			db.prepare("UPDATE enrolled_devices SET enabled = 0 WHERE device_id = 'disabled'").run();
			db.prepare("DELETE FROM enrolled_devices WHERE device_id = 'removed'").run();
			db.prepare(
				"UPDATE enrolled_devices SET display_name = 'Renamed after capture' WHERE group_id = 'group-a' AND device_id = 'active'",
			).run();
			db.prepare(`INSERT INTO presence_records
				(group_id, device_id, addresses_json, last_seen_at, expires_at, capabilities_json)
				VALUES ('group-a', 'active', '["http://localhost:7337"]', ?, ?, '{"sync_capability":"scoped"}')`).run(
				NOW,
				"2026-10-02T00:00:00.000Z",
			);
			insertRevocation(db, "device_id", "revoked-device");
			insertRevocation(db, "ed25519_key", REVOKED_KEY_ID);
			const bindings = [JSON.stringify(candidates), "group-a", "requester"];
			const formerJoin = READ_CURRENT_PEERS_SQL.replace(
				"CROSS JOIN enrolled_devices",
				"JOIN enrolled_devices",
			);

			// Act
			const current = db.prepare(READ_CURRENT_PEERS_SQL).all(...bindings);
			const former = db.prepare(formerJoin).all(...bindings);

			// Assert: equality alone would miss a predicate accidentally removed from both query forms.
			expect(current).toEqual(former);
			expect(current).toEqual([
				{
					device_id: "active",
					public_key: "key-active",
					fingerprint: "fingerprint-active",
					display_name: "Renamed after capture",
					addresses_json: '["http://localhost:7337"]',
					last_seen_at: NOW,
					expires_at: "2026-10-02T00:00:00.000Z",
					capabilities_json: '{"sync_capability":"scoped"}',
				},
				{
					device_id: "no-presence",
					public_key: "key-no-presence",
					fingerprint: "fingerprint-no-presence",
					display_name: "Device no-presence",
					addresses_json: null,
					last_seen_at: null,
					expires_at: null,
					capabilities_json: null,
				},
			]);
		} finally {
			await store.close();
		}
	});

	it("returns no peers for an empty capture even when enrollments exist", async () => {
		// Arrange
		const { store, db } = setupStore("SQLite");
		try {
			insertEnrollment(db, "uncaptured");

			// Act
			const peers = db.prepare(READ_CURRENT_PEERS_SQL).all("[]", "group-a", "requester");

			// Assert
			expect(peers).toEqual([]);
		} finally {
			await store.close();
		}
	});
});
