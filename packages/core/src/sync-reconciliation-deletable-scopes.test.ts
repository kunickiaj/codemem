import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturePlans, statementsScanning } from "./query-plan-test-fixtures.js";
import { upsertCachedScopeMemberships } from "./scope-membership-cache.js";
import { DEFAULT_SYNC_SCOPE_ID, reconcileStalePeerReceivedRows } from "./sync-replication.js";
import { initTestSchema, insertTestPeer, insertTestSession } from "./test-utils.js";

const NOW = "2026-01-01T00:00:00.000Z";
const LOCAL = "device-local";
const PEER = "device-peer";
const OTHER_PEER = "device-other";

let db: InstanceType<typeof Database>;
let sessionId: number;
let nextKey = 0;

function seedScope(scopeId: string, localStatus: "active" | "revoked"): void {
	db.prepare(
		`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', 3, 'active', ?, ?)`,
	).run(scopeId, scopeId, NOW, NOW);
	upsertCachedScopeMemberships(
		db,
		[LOCAL, PEER, OTHER_PEER].map((deviceId) => ({
			scope_id: scopeId,
			device_id: deviceId,
			role: "member",
			status: deviceId === LOCAL ? localStatus : "active",
			membership_epoch: 3,
			coordinator_id: null,
			group_id: null,
			manifest_issuer_device_id: null,
			manifest_hash: null,
			signed_manifest_json: null,
			updated_at: NOW,
		})),
	);
}

function insertRows(scopeId: string | null, count: number, originDeviceId = PEER): number[] {
	const insert = db.prepare(
		`INSERT INTO memory_items(
			session_id, kind, title, body_text, created_at, updated_at,
			import_key, rev, active, metadata_json, origin_device_id, scope_id
		 ) VALUES (?, 'discovery', 'Received fixture', 'Body', ?, ?, ?, 1, 1, '{}', ?, ?)`,
	);
	return Array.from({ length: count }, () => {
		nextKey += 1;
		return Number(
			insert.run(sessionId, NOW, NOW, `fixture:${nextKey}`, originDeviceId, scopeId)
				.lastInsertRowid,
		);
	});
}

function remainingIds(): number[] {
	return db.prepare("SELECT id FROM memory_items ORDER BY id").pluck().all() as number[];
}

function seedMixedStore() {
	seedScope("scope-authorized", "active");
	seedScope("scope-revoked", "revoked");
	return {
		authorized: insertRows("scope-authorized", 3),
		revoked: insertRows("scope-revoked", 2),
		defaultScope: insertRows(DEFAULT_SYNC_SCOPE_ID, 2),
		unscoped: insertRows(null, 1),
		otherPeerRevoked: insertRows("scope-revoked", 2, OTHER_PEER),
	};
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	sessionId = insertTestSession(db);
	insertTestPeer(db, PEER);
	insertTestPeer(db, OTHER_PEER);
});

afterEach(() => {
	db.close();
});

describe("reconcileStalePeerReceivedRows with onlyDeletableScopes", () => {
	it("deletes the same rows as a full pass over the peer", () => {
		const rows = seedMixedStore();
		const expected = [...rows.revoked, ...rows.defaultScope, ...rows.unscoped].sort(
			(left, right) => left - right,
		);

		// Run the full pass inside a savepoint and undo it, so both passes see the same rows.
		db.exec("SAVEPOINT full_pass");
		const full = reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL, peerDeviceId: PEER });
		db.exec("ROLLBACK TO full_pass; RELEASE full_pass");
		const narrowed = reconcileStalePeerReceivedRows(db, {
			localDeviceId: LOCAL,
			peerDeviceId: PEER,
			onlyDeletableScopes: true,
		});

		expect(full.deleted_memory_ids).toEqual(expected);
		expect(narrowed.deleted_memory_ids).toEqual(expected);
		expect(narrowed.checked).toBe(expected.length);
		expect(remainingIds()).toEqual([...rows.authorized, ...rows.otherPeerRevoked]);
	});

	it("reads no rows for a peer whose scopes are all authorized", () => {
		seedScope("scope-authorized", "active");
		const kept = insertRows("scope-authorized", 4);

		const plans = capturePlans(db, () => {
			const result = reconcileStalePeerReceivedRows(db, {
				localDeviceId: LOCAL,
				peerDeviceId: PEER,
				onlyDeletableScopes: true,
			});
			expect(result).toMatchObject({ checked: 0, deleted: 0, retained: 0 });
		});

		expect(remainingIds()).toEqual(kept);
		expect(statementsScanning(plans, "memory_items")).toEqual([]);
		const scopeList = plans.find(({ sql }) => sql.includes("SELECT DISTINCT scope_id"));
		expect(scopeList?.steps.join(" ")).toContain(
			"USING COVERING INDEX idx_memory_items_origin_active_scope",
		);
	});

	it("honours maxRows across scopes in ID order", () => {
		const rows = seedMixedStore();

		const result = reconcileStalePeerReceivedRows(db, {
			localDeviceId: LOCAL,
			peerDeviceId: PEER,
			onlyDeletableScopes: true,
			maxRows: 3,
		});

		expect(result.deleted_memory_ids).toEqual([...rows.revoked, rows.defaultScope[0]]);
	});
});

describe("reconcileStalePeerReceivedRows for one peer", () => {
	it("finds the peer's rows by index instead of scanning every memory", () => {
		seedMixedStore();

		const plans = capturePlans(db, () =>
			reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL, peerDeviceId: PEER }),
		);

		// The plan must select by peer. Selecting by `active` alone reads about half the store.
		const rowQuery = plans.find(({ sql }) =>
			/FROM memory_items\s+WHERE origin_device_id = \?/.test(sql),
		);
		expect(rowQuery?.steps.join(" ")).toContain("(origin_device_id=? AND active=?)");
		expect(statementsScanning(plans, "memory_items")).toEqual([]);
	});
});
