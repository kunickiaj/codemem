import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRawEventRelinkPlanWithDb } from "./maintenance/relink.js";
import { exportedSessionKey } from "./session-export-identity.js";
import { snapshotSessionExportKeysForMemoryIds } from "./session-export-identity-mutation.js";
import { applyBootstrapSnapshot, mergeBootstrapSnapshot } from "./sync-bootstrap.js";
import {
	applyReplicationOps,
	backfillReplicationOps,
	DEFAULT_SYNC_SCOPE_ID,
	diagnoseStalePeerReceivedRows,
	migrateLegacyImportKeys,
	reconcileStalePeerReceivedRows,
} from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp, SyncMemorySnapshotItem, SyncResetRequired } from "./types.js";

const now = "2026-01-01T00:00:00Z";
const canonical = `export-session:v1:${"a".repeat(64)}`;
const reset: SyncResetRequired = {
	reset_required: true,
	reason: "generation_mismatch",
	generation: 2,
	snapshot_id: "snapshot",
	baseline_cursor: null,
	retained_floor_cursor: null,
	scope_id: "work",
};

let db: Database.Database;
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(now));
	db = new Database(":memory:");
	initTestSchema(db);
});
afterEach(() => {
	db.close();
	vi.useRealTimers();
});

function session(key: string | null = null): number {
	return Number(
		db.prepare("INSERT INTO sessions(started_at, import_key) VALUES (?, ?)").run(now, key)
			.lastInsertRowid,
	);
}
function memory(
	sessionId: number,
	key: string | null,
	scope = "work",
	visibility = "shared",
): number {
	return Number(
		db
			.prepare(`INSERT INTO memory_items
			(session_id, kind, title, body_text, created_at, updated_at, import_key,
			metadata_json, rev, active, scope_id, visibility, origin_device_id)
			VALUES (?, 'discovery', 'fixture', 'body', ?, ?, ?, '{}', 1, 1, ?, ?, 'remote')`)
			.run(sessionId, now, now, key, scope, visibility).lastInsertRowid,
	);
}
function row(sessionId: number): { id: number; import_key: string | null } {
	return db.prepare("SELECT id, import_key FROM sessions WHERE id = ?").get(sessionId) as {
		id: number;
		import_key: string | null;
	};
}
function marker(sessionId: number): string {
	const before = db.prepare("SELECT total_changes()").pluck().get();
	const value = exportedSessionKey(db, row(sessionId));
	expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(before);
	return value;
}
function device(): void {
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES ('local', 'fixture', 'fixture', ?)",
	).run(now);
}
function snapshotItem(key: string): SyncMemorySnapshotItem {
	return {
		entity_id: key,
		op_type: "upsert",
		clock_rev: 2,
		clock_updated_at: now,
		clock_device_id: "remote",
		payload_json: JSON.stringify({
			kind: "discovery",
			title: "replacement",
			body_text: "body",
			created_at: now,
			visibility: "shared",
			scope_id: "work",
		}),
	};
}

function cleanupOp(): ReplicationOp {
	return {
		op_id: "cleanup-anchor",
		entity_type: "memory_item",
		entity_id: "anchor",
		op_type: "access_cleanup",
		scope_id: DEFAULT_SYNC_SCOPE_ID,
		payload_json: JSON.stringify({ cleanup_scope_id: "work", reason: "scope_revoked" }),
		clock_rev: 2,
		clock_updated_at: now,
		clock_device_id: "remote",
		device_id: "remote",
		created_at: now,
	};
}

function cleanup(hook: string): void {
	if (hook === "access") applyReplicationOps(db, [cleanupOp()], "local");
	else reconcileStalePeerReceivedRows(db, { localDeviceId: "local" });
}

describe("legacy session physical cleanup", () => {
	it.each(["access", "reconcile"])(
		"%s preserves a last-anchor marker and leaves unrelated sessions untouched",
		(hook) => {
			// Arrange: match existing cleanup fixtures' sender-origin proof; no actor claims grant access.
			let scope = DEFAULT_SYNC_SCOPE_ID;
			if (hook === "access") scope = "work";
			const affected = session();
			const id = memory(affected, "anchor", scope);
			const local = session();
			const localId = memory(local, "local-anchor", scope);
			db.prepare("UPDATE memory_items SET origin_device_id = 'local' WHERE id = ?").run(localId);
			const expected = marker(affected);
			// Act
			cleanup(hook);
			cleanup(hook);
			// Assert
			expect(db.prepare("SELECT id FROM memory_items WHERE id = ?").get(id)).toBeUndefined();
			expect(marker(affected)).toBe(expected);
			expect(row(local).import_key).toBeNull();
			expect(db.prepare("SELECT id FROM memory_items WHERE id = ?").get(localId)).toBeDefined();
		},
	);

	it.each(["access", "reconcile"])("%s cannot snapshot a receiver-owned anchor", (hook) => {
		// Arrange
		const sid = session();
		const id = memory(sid, "anchor", DEFAULT_SYNC_SCOPE_ID);
		db.prepare("UPDATE memory_items SET origin_device_id = 'local', scope_id = ? WHERE id = ?").run(
			hook === "access" ? "work" : DEFAULT_SYNC_SCOPE_ID,
			id,
		);
		// Act
		cleanup(hook);
		// Assert
		expect(row(sid).import_key).toBeNull();
		expect(db.prepare("SELECT id FROM memory_items WHERE id = ?").get(id)).toBeDefined();
	});

	it("diagnoses stale local-only peer rows without snapshot or any database writes", () => {
		// Arrange
		const sid = session();
		const id = memory(sid, "anchor", DEFAULT_SYNC_SCOPE_ID);
		const before = db.serialize();
		const changes = db.prepare("SELECT total_changes()").pluck().get();
		// Act
		const result = diagnoseStalePeerReceivedRows(db, { localDeviceId: "local" });
		// Assert
		expect(result.would_delete_memory_ids).toEqual([id]);
		expect(row(sid).import_key).toBeNull();
		expect(db.serialize().equals(before)).toBe(true);
		expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
	});
});

function observeQueryExecutions() {
	const statements: Database.Statement[] = [];
	const prepare = db.prepare.bind(db);
	const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		// Count executions, not just preparations: the old loop reused one statement.
		vi.spyOn(statement, "get");
		vi.spyOn(statement, "all");
		vi.spyOn(statement, "run");
		statements.push(statement);
		return statement;
	});
	return {
		restore: () => prepareSpy.mockRestore(),
		count: () =>
			statements.reduce(
				(count, statement) =>
					count +
					vi.mocked(statement.get).mock.calls.length +
					vi.mocked(statement.all).mock.calls.length +
					vi.mocked(statement.run).mock.calls.length,
				0,
			),
	};
}

describe("legacy session bulk snapshot queries", () => {
	it.each([1000, 10000])("executes four queries for %i memories in one actual session", (size) => {
		// Arrange: exceed SQLite's usual placeholder limit without any external services.
		const sid = session();
		const ids = db.transaction(() =>
			Array.from({ length: size }, (_, index) => memory(sid, `anchor-${index}`)),
		)();
		const expected = marker(sid);
		const queries = observeQueryExecutions();
		// Act
		db.transaction(() => snapshotSessionExportKeysForMemoryIds(db, ids)).immediate();
		queries.restore();
		// Assert: one bulk lookup plus anchor, identity and update per unique session.
		expect(row(sid).import_key).toBe(expected);
		expect(queries.count()).toBe(4);
	});

	it("resolves two actual sessions despite duplicate and missing memory IDs", () => {
		// Arrange: identical mutable labels must not collapse distinct source sessions.
		const first = session(" \t");
		const second = session();
		const unrelated = session();
		const ids = db.transaction(() => [
			memory(first, "first-anchor"),
			memory(first, "later-first"),
			memory(second, "second-anchor"),
			memory(second, "later-second"),
		])();
		memory(unrelated, "unrelated-anchor");
		db.prepare("UPDATE sessions SET project = ?, metadata_json = ?").run(
			"same-project",
			JSON.stringify({ source: "same-source" }),
		);
		const expected = [marker(first), marker(second)];
		const before = db.serialize();
		const queries = observeQueryExecutions();
		// Act
		db.transaction(() => {
			snapshotSessionExportKeysForMemoryIds(db, [-1]);
		})();
		const afterMissing = db.serialize();
		db.transaction(() => {
			snapshotSessionExportKeysForMemoryIds(db, [...ids, ...ids, -1]);
		}).immediate();
		queries.restore();
		// Assert: missing-only input reads once; the mixed batch reads once plus three per session.
		expect(afterMissing.equals(before)).toBe(true);
		expect([row(first).import_key, row(second).import_key]).toEqual(expected);
		expect(row(unrelated).import_key).toBeNull();
		expect(queries.count()).toBe(8);
	});
});

describe("legacy session snapshot helper", () => {
	it("requires a transaction even for empty input and never writes on rejection", () => {
		// Arrange
		const id = memory(session(), "anchor");
		const before = db.serialize();
		const changes = db.prepare("SELECT total_changes()").pluck().get();
		// Act / Assert
		for (const ids of [[], [id]])
			expect(() => snapshotSessionExportKeysForMemoryIds(db, ids)).toThrow(
				"session_export_identity_transaction_required",
			);
		expect(db.serialize().equals(before)).toBe(true);
		expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
	});

	it("snapshots raw whitespace anchor bytes once per actual session without touching unrelated rows", () => {
		// Arrange
		const affected = session(" \t");
		const first = memory(affected, " \tanchor\n");
		const second = memory(affected, "later");
		const untouched = session();
		memory(untouched, "unrelated");
		const expected = `export-session:v1:${createHash("sha256")
			.update(JSON.stringify(["memory_key", " \tanchor\n"]))
			.digest("hex")}`;
		const before = marker(affected);
		const changes = db.prepare("SELECT total_changes()").pluck().get() as number;
		// Act
		db.transaction(() => snapshotSessionExportKeysForMemoryIds(db, [first, second, first, -1]))();
		db.transaction(() => snapshotSessionExportKeysForMemoryIds(db, [second]))();
		// Assert
		expect(before).toBe(expected);
		expect(marker(affected)).toBe(before);
		expect(row(affected).import_key).toBe(expected);
		expect(row(untouched).import_key).toBeNull();
		expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changes + 1);
	});

	it.each([" original-import ", canonical, " native-uuid "])(
		"preserves nonblank session key bytes: %s",
		(key) => {
			// Arrange
			const sid = session(key);
			const id = memory(sid, "anchor");
			const before = marker(sid);
			const changes = db.prepare("SELECT total_changes()").pluck().get();
			// Act
			db.transaction(() => snapshotSessionExportKeysForMemoryIds(db, [id]))();
			// Assert
			expect(row(sid).import_key).toBe(key);
			expect(marker(sid)).toBe(before);
			expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
		},
	);

	it("skips anchorless sessions so cleanup proceeds but export still fails read-only", () => {
		// Arrange
		const sid = session();
		const id = memory(sid, " ");
		// Act
		db.transaction(() => {
			snapshotSessionExportKeysForMemoryIds(db, [id]);
			db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);
		})();
		const before = db.serialize();
		// Assert
		expect(row(sid).import_key).toBeNull();
		expect(() => marker(sid)).toThrow("session_identity_unavailable");
		expect(db.serialize().equals(before)).toBe(true);
	});
});

describe("legacy session key assignment", () => {
	it("backfill snapshots its own blank-key assignment after the migration limit is exhausted", () => {
		// Arrange: the first 2,000 rows consume migration's batch, leaving this assignment to backfill.
		device();
		const filler = session(canonical);
		db.transaction(() => {
			for (let index = 0; index < 2000; index++) memory(filler, null);
		})();
		const sid = session();
		const earlier = memory(sid, null);
		memory(sid, "later-anchor");
		const expected = marker(sid);
		// Act
		backfillReplicationOps(db, 3000);
		const persisted = row(sid);
		backfillReplicationOps(db, 3000);
		// Assert
		expect(
			db.prepare("SELECT import_key FROM memory_items WHERE id = ?").pluck().get(earlier),
		).toBe(`legacy:local:memory_item:${earlier}`);
		expect(marker(sid)).toBe(expected);
		expect(row(sid)).toEqual(persisted);
	});
	it.each(["migration", "backfill"])(
		"%s preserves an existing later anchor before assigning an earlier blank key",
		(hook) => {
			// Arrange: no export has occurred on the second session before mutation.
			device();
			const firstSession = session();
			memory(firstSession, null);
			memory(firstSession, "later-first");
			const secondSession = session();
			memory(secondSession, "");
			memory(secondSession, "later-second");
			const expected = ["later-first", "later-second"].map(
				(key) =>
					`export-session:v1:${createHash("sha256")
						.update(JSON.stringify(["memory_key", key]))
						.digest("hex")}`,
			);
			const mutate = hook === "migration" ? migrateLegacyImportKeys : backfillReplicationOps;
			// Act
			mutate(db);
			const persisted = [row(firstSession), row(secondSession)];
			mutate(db);
			// Assert
			expect([marker(firstSession), marker(secondSession)]).toEqual(expected);
			expect([row(firstSession), row(secondSession)]).toEqual(persisted);
		},
	);

	it("migration snapshots old-format keys before rewrite and rolls both writes back on failure", () => {
		// Arrange
		device();
		const sid = session();
		memory(sid, "legacy:memory_item:42");
		const beforeMarker = marker(sid);
		db.exec(
			"CREATE TRIGGER fail_key BEFORE UPDATE OF import_key ON memory_items BEGIN SELECT RAISE(ABORT, 'key_failed'); END",
		);
		const before = db.serialize();
		// Act / Assert
		expect(() => migrateLegacyImportKeys(db)).toThrow("key_failed");
		expect(db.serialize().equals(before)).toBe(true);
		expect(row(sid).import_key).toBeNull();
		db.exec("DROP TRIGGER fail_key");
		expect(migrateLegacyImportKeys(db)).toBe(1);
		expect(marker(sid)).toBe(beforeMarker);
		expect(migrateLegacyImportKeys(db)).toBe(0);
	});
});

describe("legacy session bootstrap predicates", () => {
	it.each(["replace", "merge"])(
		"bootstrap %s snapshots only sessions selected by its deletion predicate",
		(hook) => {
			// Arrange: private, other-scope and keyless rows belong to separate historical sessions.
			const affected = session();
			const id = memory(affected, "target");
			const privateSession = session();
			const otherScope = session();
			const keyless = session();
			const unoffered = session();
			memory(privateSession, "target", "work", "private");
			memory(otherScope, "target", "other");
			memory(keyless, null);
			memory(unoffered, "unoffered");
			const expected = marker(affected);
			const mutate = hook === "replace" ? applyBootstrapSnapshot : mergeBootstrapSnapshot;
			// Act
			const result = mutate(db, "remote", [snapshotItem("target")], reset);
			// Assert
			expect(result.ok).toBe(true);
			expect(db.prepare("SELECT id FROM memory_items WHERE id = ?").get(id)).toBeUndefined();
			expect(marker(affected)).toBe(expected);
			for (const sid of [privateSession, otherScope, keyless])
				expect(row(sid).import_key).toBeNull();
			if (hook === "merge") expect(row(unoffered).import_key).toBeNull();
			else expect(row(unoffered).import_key).not.toBeNull();
		},
	);

	it.each(["replace", "merge"])(
		"bootstrap %s rolls back identity and deleted anchors after injected failure",
		(hook) => {
			// Arrange
			const sid = session();
			memory(sid, "target");
			db.exec(
				"CREATE TRIGGER fail_delete BEFORE DELETE ON memory_items BEGIN SELECT RAISE(ABORT, 'delete_failed'); END",
			);
			const before = db.serialize();
			const mutate = hook === "replace" ? applyBootstrapSnapshot : mergeBootstrapSnapshot;
			// Act / Assert
			expect(() => mutate(db, "remote", [snapshotItem("target")], reset)).toThrow("delete_failed");
			expect(db.serialize().equals(before)).toBe(true);
			expect(row(sid).import_key).toBeNull();
		},
	);
});

describe("legacy session relink survivor", () => {
	it("rolls back the survivor snapshot and repoints if session compaction fails", () => {
		// Arrange
		const survivor = session();
		const redundant = session();
		memory(redundant, "earlier");
		memory(survivor, "survivor-anchor");
		db.prepare("UPDATE sessions SET metadata_json = ?").run(
			JSON.stringify({
				source: "plugin",
				session_context: { source: "opencode", flusher: "raw_events", streamId: "fixture-stream" },
			}),
		);
		db.exec(
			"CREATE TRIGGER fail_compaction BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'compaction_failed'); END",
		);
		const before = db.serialize();
		// Act / Assert
		expect(() => applyRawEventRelinkPlanWithDb(db, { limit: 10 })).toThrow("compaction_failed");
		expect(db.serialize().equals(before)).toBe(true);
		expect(row(survivor).import_key).toBeNull();
	});
	it("relink preserves the survivor before adding an earlier memory, without retaining removed aliases", () => {
		// Arrange
		const survivor = session();
		const redundant = session();
		memory(redundant, "earlier");
		memory(survivor, "survivor-anchor");
		const metadata = JSON.stringify({
			source: "plugin",
			session_context: {
				source: "opencode",
				flusher: "raw_events",
				streamId: "fixture-stream",
			},
		});
		db.prepare("UPDATE sessions SET metadata_json = ?").run(metadata);
		const expected = marker(survivor);
		// Act
		const result = applyRawEventRelinkPlanWithDb(db, { limit: 10 });
		const repeated = applyRawEventRelinkPlanWithDb(db, { limit: 10 });
		// Assert
		expect(result.totals.memory_repoints).toBe(1);
		expect(marker(survivor)).toBe(expected);
		expect(db.prepare("SELECT id FROM sessions WHERE id = ?").get(redundant)).toBeUndefined();
		expect(db.prepare("SELECT DISTINCT session_id FROM memory_items").pluck().all()).toEqual([
			survivor,
		]);
		expect(repeated.totals.memory_repoints).toBe(0);
	});
});
