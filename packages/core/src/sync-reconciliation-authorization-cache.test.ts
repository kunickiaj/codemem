import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertCachedScopeMemberships } from "./scope-membership-cache.js";
import {
	DEFAULT_SYNC_SCOPE_ID,
	diagnoseStalePeerReceivedRows,
	getReplicationCursor,
	reconcileStalePeerReceivedRows,
	setReplicationCursor,
} from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

const NOW = "2026-01-01T00:00:00.000Z";
const LOCAL = "device-local";
const PEER = "device-peer";

function createFixture() {
	let db: InstanceType<typeof Database>;
	let sessionId: number;
	let nextKey: number;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		db = new Database(":memory:");
		initTestSchema(db);
		sessionId = insertTestSession(db);
		nextKey = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		db.close();
		vi.useRealTimers();
	});

	function seedScope(
		scopeId: string,
		options: {
			membershipStatus?: string;
			membershipEpoch?: number;
			scopeStatus?: string;
			omitLocalMembership?: boolean;
		} = {},
	): void {
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES (?, ?, 'team', 'coordinator', 3, ?, ?, ?)`,
		).run(scopeId, scopeId, options.scopeStatus ?? "active", NOW, NOW);
		const deviceIds = options.omitLocalMembership ? [PEER] : [LOCAL, PEER];
		upsertCachedScopeMemberships(
			db,
			deviceIds.map((deviceId) => ({
				scope_id: scopeId,
				device_id: deviceId,
				role: "member",
				status: deviceId === LOCAL ? (options.membershipStatus ?? "active") : "active",
				membership_epoch: deviceId === LOCAL ? (options.membershipEpoch ?? 3) : 3,
				coordinator_id: null,
				group_id: null,
				manifest_issuer_device_id: null,
				manifest_hash: null,
				signed_manifest_json: null,
				updated_at: NOW,
			})),
		);
	}

	function insertRows(
		scopeId: string | null,
		count: number,
		options: { originDeviceId?: string | null; omitImportKey?: boolean; active?: number } = {},
	): number[] {
		const insert = db.prepare(
			`INSERT INTO memory_items(
			 session_id, kind, title, body_text, created_at, updated_at,
			 import_key, rev, active, metadata_json, origin_device_id, scope_id
			 ) VALUES (?, 'discovery', 'Imported fixture', 'Body', ?, ?, ?, 1, ?, '{}', ?, ?)`,
		);
		return Array.from({ length: count }, () => {
			nextKey += 1;
			return Number(
				insert.run(
					sessionId,
					NOW,
					NOW,
					options.omitImportKey ? null : `fixture:${nextKey}`,
					options.active ?? 1,
					options.originDeviceId === undefined ? PEER : options.originDeviceId,
					scopeId,
				).lastInsertRowid,
			);
		});
	}

	function remainingIds(): number[] {
		return db.prepare("SELECT id FROM memory_items ORDER BY id").pluck().all() as number[];
	}

	// Observe real authorization query executions, not replacement authorization decisions.
	function observeAuthorizationQueries() {
		const readCalls: Array<() => Array<{ deviceId: unknown; scopeId: unknown }>> = [];
		const prepare = db.prepare.bind(db);
		const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
			const statement = prepare(sql);
			if (/FROM scope_memberships sm\s+LEFT JOIN replication_scopes/.test(sql)) {
				const getSpy = vi.spyOn(statement, "get");
				readCalls.push(() =>
					getSpy.mock.calls.map(([deviceId, scopeId]) => ({ deviceId, scopeId })),
				);
			}
			return statement;
		});
		return {
			calls: () => readCalls.flatMap((read) => read()),
			prepared: () =>
				prepareSpy.mock.calls.filter(([sql]) =>
					/FROM scope_memberships sm\s+LEFT JOIN replication_scopes/.test(sql),
				).length,
		};
	}

	return {
		get db() {
			return db;
		},
		seedScope,
		insertRows,
		remainingIds,
		observeAuthorizationQueries,
	};
}

describe("transaction-local authorization reuse for retention and deletion", () => {
	const fixture = createFixture();
	const { seedScope, insertRows, remainingIds, observeAuthorizationQueries } = fixture;

	it("queries each distinct authorized scope once for many imported rows", () => {
		// Arrange: different senders still use the same explicit local-device authorization.
		const db = fixture.db;
		seedScope("scope-a");
		seedScope("scope-b");
		const ids = [
			...insertRows("scope-a", 12),
			...insertRows("scope-b", 12),
			...insertRows("scope-a", 12, { originDeviceId: "device-other" }),
		];
		const queries = observeAuthorizationQueries();

		// Act
		const result = reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL });

		// Assert: retention is unchanged; query cost follows scopes rather than row count.
		expect(result).toMatchObject({ checked: 36, retained: 36, deleted: 0, ambiguous: [] });
		expect(remainingIds()).toEqual(ids);
		expect(queries.calls()).toEqual([
			{ deviceId: LOCAL, scopeId: "scope-a" },
			{ deviceId: LOCAL, scopeId: "scope-b" },
		]);
		expect(queries.prepared()).toBe(2);
	});

	it.each([
		["revoked", { membershipStatus: "revoked" }],
		["inactive", { scopeStatus: "archived" }],
		["stale epoch", { membershipEpoch: 2 }],
		["absent membership in a known scope", { omitLocalMembership: true }],
	])(
		"deletes %s rows with one authorization query and clears scoped cursors",
		(_state, options) => {
			// Arrange
			const db = fixture.db;
			seedScope("scope-stale", options);
			const ids = insertRows("scope-stale", 10);
			const localIds = insertRows("scope-stale", 1, { originDeviceId: LOCAL });
			setReplicationCursor(db, PEER, { lastApplied: "applied", lastAcked: "acked" }, "scope-stale");
			setReplicationCursor(db, PEER, { lastApplied: "default", lastAcked: "default-ack" });
			db.prepare(
				"INSERT INTO memory_file_refs(memory_id, file_path, relation) VALUES (?, ?, ?)",
			).run(ids[0], "src/fixture.ts", "read");
			const queries = observeAuthorizationQueries();

			// Act
			const result = reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL });

			// Assert
			expect(result).toMatchObject({
				deleted_memory_ids: ids,
				deleted: 10,
				retained: 1,
				ambiguous: [],
			});
			expect(remainingIds()).toEqual(localIds);
			expect(getReplicationCursor(db, PEER, "scope-stale")).toEqual([null, null]);
			expect(getReplicationCursor(db, PEER)).toEqual(["default", "default-ack"]);
			expect(db.prepare("SELECT COUNT(*) FROM memory_file_refs").pluck().get()).toBe(0);
			expect(queries.calls()).toEqual([{ deviceId: LOCAL, scopeId: "scope-stale" }]);
		},
	);
});

describe("transaction-local authorization reuse for ambiguous rows and diagnosis", () => {
	const fixture = createFixture();
	const { seedScope, insertRows, remainingIds, observeAuthorizationQueries } = fixture;

	it.each(["pending", "unknown scope", "policy denied"])(
		"retains %s rows as ambiguous without repeatedly querying authorization",
		(state) => {
			// Arrange: policy denial with a membership is ambiguous, not permission to delete.
			const db = fixture.db;
			if (state !== "unknown scope") {
				seedScope("scope-ambiguous", {
					membershipStatus: state === "pending" ? "pending" : "active",
				});
			}
			if (state === "policy denied") {
				db.prepare(
					`INSERT INTO recipient_policy_deny_overlays(
					 canonical_project_identity, scope_id, device_id, generation, reason_code, created_at, updated_at
					 ) VALUES ('fixture-project', 'scope-ambiguous', ?, 1, 'fixture-denied', ?, ?)`,
				).run(LOCAL, NOW, NOW);
			}
			const ids = insertRows("scope-ambiguous", 8);
			const queries = observeAuthorizationQueries();

			// Act
			const result = reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL });

			// Assert
			expect(result.deleted).toBe(0);
			expect(result.retained).toBe(0);
			expect(result.ambiguous.map((row) => [row.memory_id, row.reason])).toEqual(
				ids.map((id) => [id, "authorization_unknown"]),
			);
			expect(remainingIds()).toEqual(ids);
			expect(queries.calls()).toEqual([{ deviceId: LOCAL, scopeId: "scope-ambiguous" }]);
		},
	);

	it("diagnoses repeated stale and authorized scopes without deleting rows or clearing cursors", () => {
		// Arrange
		const db = fixture.db;
		seedScope("scope-stale", { membershipStatus: "revoked" });
		seedScope("scope-authorized");
		const staleIds = insertRows("scope-stale", 6);
		const authorizedIds = insertRows("scope-authorized", 6);
		setReplicationCursor(db, PEER, { lastApplied: "applied", lastAcked: "acked" }, "scope-stale");
		const queries = observeAuthorizationQueries();

		// Act
		const result = diagnoseStalePeerReceivedRows(db, { localDeviceId: LOCAL });

		// Assert
		expect(result).toMatchObject({
			checked: 12,
			would_delete: 6,
			would_delete_memory_ids: staleIds,
			retained: 6,
			ambiguous: [],
		});
		expect(remainingIds()).toEqual([...staleIds, ...authorizedIds]);
		expect(getReplicationCursor(db, PEER, "scope-stale")).toEqual(["applied", "acked"]);
		expect(queries.calls()).toEqual([
			{ deviceId: LOCAL, scopeId: "scope-stale" },
			{ deviceId: LOCAL, scopeId: "scope-authorized" },
		]);
	});
});

describe("cleanup scan limits and identity preservation", () => {
	const fixture = createFixture();
	const { seedScope, insertRows, remainingIds, observeAuthorizationQueries } = fixture;

	it("preserves peer filtering, active-row filtering and maxRows before memoization", () => {
		// Arrange: the limit applies to the selected peer, not to all rows in the database.
		const db = fixture.db;
		seedScope("scope-stale", { membershipStatus: "revoked" });
		const excludedIds = [
			...insertRows("scope-stale", 2, { originDeviceId: "device-other" }),
			...insertRows("scope-stale", 1, { active: 0 }),
		];
		const peerIds = insertRows("scope-stale", 5);
		const queries = observeAuthorizationQueries();

		// Act
		const result = reconcileStalePeerReceivedRows(db, {
			localDeviceId: LOCAL,
			peerDeviceId: PEER,
			maxRows: 2,
		});

		// Assert
		expect(result).toMatchObject({
			checked: 2,
			deleted: 2,
			deleted_memory_ids: peerIds.slice(0, 2),
		});
		expect(remainingIds()).toEqual([...excludedIds, ...peerIds.slice(2)]);
		expect(queries.calls()).toEqual([{ deviceId: LOCAL, scopeId: "scope-stale" }]);
	});

	it("does no authorization work for a zero-row limit or an unmatched peer", () => {
		// Arrange
		const db = fixture.db;
		seedScope("scope-stale", { membershipStatus: "revoked" });
		const ids = insertRows("scope-stale", 4);
		const queries = observeAuthorizationQueries();

		// Act
		const limited = reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL, maxRows: 0 });
		const unmatched = diagnoseStalePeerReceivedRows(db, {
			localDeviceId: LOCAL,
			peerDeviceId: "device-unmatched",
		});

		// Assert
		expect(limited).toMatchObject({ checked: 0, deleted: 0, retained: 0, ambiguous: [] });
		expect(unmatched).toMatchObject({ checked: 0, would_delete: 0, retained: 0, ambiguous: [] });
		expect(remainingIds()).toEqual(ids);
		expect(queries.calls()).toEqual([]);
	});

	it("does not infer missing identities or authorize local-only and local-owned rows", () => {
		// Arrange
		const db = fixture.db;
		seedScope("scope-stale", { membershipStatus: "revoked" });
		const localIds = insertRows("scope-stale", 1, { originDeviceId: LOCAL });
		const missingOriginIds = insertRows("scope-stale", 1, { originDeviceId: null });
		const missingKeyIds = insertRows("scope-stale", 1, { omitImportKey: true });
		const localOnlyIds = [...insertRows(null, 1), ...insertRows(DEFAULT_SYNC_SCOPE_ID, 1)];
		const queries = observeAuthorizationQueries();

		// Act
		const result = reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL });

		// Assert
		expect(result.deleted_memory_ids).toEqual(localOnlyIds);
		expect(result.retained).toBe(1);
		expect(result.ambiguous.map((row) => [row.memory_id, row.reason])).toEqual([
			[missingOriginIds[0], "missing_origin_device"],
			[missingKeyIds[0], "missing_import_key"],
		]);
		expect(remainingIds()).toEqual([...localIds, ...missingOriginIds, ...missingKeyIds]);
		expect(queries.calls()).toEqual([]);
	});
});

describe("authorization cache cannot survive a cleanup transaction", () => {
	const fixture = createFixture();
	const { seedScope, insertRows, remainingIds } = fixture;

	it("observes revocation between separate cleanup transactions", () => {
		// Arrange
		const db = fixture.db;
		seedScope("scope-changing");
		const ids = insertRows("scope-changing", 3);

		// Act: a completed cleanup must not keep authorization alive for the next call.
		const first = reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL });
		db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = ?").run(LOCAL);
		const second = reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL });

		// Assert
		expect(first).toMatchObject({ retained: 3, deleted: 0 });
		expect(second).toMatchObject({ retained: 0, deleted: 3, deleted_memory_ids: ids });
		expect(remainingIds()).toEqual([]);
	});

	it("observes a new authorization after an earlier unknown-scope decision", () => {
		// Arrange
		const db = fixture.db;
		const ids = insertRows("scope-changing", 3);

		// Act
		const first = reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL });
		seedScope("scope-changing");
		const second = reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL });

		// Assert: negative decisions cannot escape their transaction either.
		expect(first.ambiguous).toHaveLength(3);
		expect(second).toMatchObject({ retained: 3, deleted: 0, ambiguous: [] });
		expect(remainingIds()).toEqual(ids);
	});

	it("observes newer membership epochs between diagnosis and cleanup", () => {
		// Arrange
		const db = fixture.db;
		seedScope("scope-changing", { membershipEpoch: 2 });
		const ids = insertRows("scope-changing", 3);

		// Act
		const diagnosis = diagnoseStalePeerReceivedRows(db, { localDeviceId: LOCAL });
		db.prepare("UPDATE scope_memberships SET membership_epoch = 3 WHERE device_id = ?").run(LOCAL);
		const cleanup = reconcileStalePeerReceivedRows(db, { localDeviceId: LOCAL });

		// Assert: diagnosis cannot poison a later cleanup with its stale-epoch decision.
		expect(diagnosis.would_delete_memory_ids).toEqual(ids);
		expect(cleanup).toMatchObject({ retained: 3, deleted: 0, ambiguous: [] });
		expect(remainingIds()).toEqual(ids);
	});
});
