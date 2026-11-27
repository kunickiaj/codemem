import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, toJson } from "./db.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { capturePlans, statementsScanning } from "./query-plan-test-fixtures.js";
import {
	ReplicationBackfillRunner,
	runReplicationBackfillPass,
	runReplicationBackfillSlice,
} from "./replication-backfill.js";
import {
	REPLICATION_BACKFILL_JOB,
	requestReplicationBackfillRecheck,
} from "./replication-backfill-state.js";
import { syncPassPreflight } from "./sync-pass.js";
import { pruneReplicationOps } from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

type Db = InstanceType<typeof Database>;

const NOW = new Date("2026-11-01T12:00:00.000Z");
const LONG_AGO = "2026-01-01T00:00:00.000Z";

let db: Db;
let sessionId: number;

interface MemoryInput {
	importKey?: string | null;
	rev?: number;
	active?: number;
	deletedAt?: string | null;
	updatedAt?: string;
	metadata?: Record<string, unknown>;
}

function insertMemory(target: Db, input: MemoryInput = {}): number {
	const info = target
		.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				import_key, rev, active, deleted_at, metadata_json)
			 VALUES (?, 'discovery', 'Title', 'Body', ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			sessionId,
			LONG_AGO,
			input.updatedAt ?? LONG_AGO,
			input.importKey === undefined
				? `key:${Math.random().toString(36).slice(2)}`
				: input.importKey,
			input.rev ?? 1,
			input.active ?? 1,
			input.deletedAt ?? null,
			toJson(input.metadata ?? {}),
		);
	return Number(info.lastInsertRowid);
}

function addDeviceIdentity(target: Db): void {
	target
		.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run("dev-local", "pub", "fp", LONG_AGO);
}

function ops(target: Db): Array<{ entity_id: string; op_type: string; clock_rev: number }> {
	return target
		.prepare(
			"SELECT entity_id, op_type, clock_rev FROM replication_ops ORDER BY entity_id, op_type",
		)
		.all() as Array<{ entity_id: string; op_type: string; clock_rev: number }>;
}

function importKey(target: Db, memoryId: number): string | null {
	return (
		target.prepare("SELECT import_key FROM memory_items WHERE id = ?").get(memoryId) as {
			import_key: string | null;
		}
	).import_key;
}

/** A slice with as much time as it needs, at the fixed test time. */
function slice(target: Db = db, at: Date = NOW, warn: (message: string) => void = () => {}) {
	return runReplicationBackfillSlice(target, { maxRuntimeMs: 60_000, now: () => at, warn });
}

function minutesAfter(minutes: number): Date {
	return new Date(NOW.getTime() + minutes * 60_000);
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	addDeviceIdentity(db);
	sessionId = insertTestSession(db);
});

afterEach(() => {
	vi.restoreAllMocks();
	db.close();
});

describe("runReplicationBackfillSlice", () => {
	it("gives existing rows their op and legacy rows a device-scoped key", () => {
		const active = insertMemory(db, { importKey: "key:active", rev: 3 });
		insertMemory(db, { importKey: "key:gone", rev: 2, active: 0, deletedAt: LONG_AGO });
		const legacy = insertMemory(db, { importKey: "legacy:memory_item:42" });
		const unkeyed = insertMemory(db, { importKey: null });

		const result = slice();

		expect(result).toEqual({ opsCreated: 4, keysMigrated: 2, complete: true });
		expect(importKey(db, active)).toBe("key:active");
		expect(importKey(db, legacy)).toBe("legacy:dev-local:memory_item:42");
		expect(importKey(db, unkeyed)).toBe(`legacy:dev-local:memory_item:${unkeyed}`);
		expect(ops(db)).toHaveLength(4);
		expect(ops(db)).toEqual(
			expect.arrayContaining([
				{ entity_id: "key:active", op_type: "upsert", clock_rev: 3 },
				{ entity_id: "key:gone", op_type: "delete", clock_rev: 2 },
				{ entity_id: "legacy:dev-local:memory_item:42", op_type: "upsert", clock_rev: 1 },
				{ entity_id: `legacy:dev-local:memory_item:${unkeyed}`, op_type: "upsert", clock_rev: 1 },
			]),
		);
		expect(getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)).toMatchObject({
			status: "completed",
			message: null,
		});
	});

	it("reads only new and changed rows once the first check is complete", () => {
		for (let index = 0; index < 5; index++) insertMemory(db);
		slice();

		const plans = capturePlans(db, () => slice(db, minutesAfter(1)));

		expect(plans.length).toBeGreaterThan(0);
		expect(statementsScanning(plans, "memory_items")).toEqual([]);
		expect(statementsScanning(plans, "replication_ops")).toEqual([]);
	});

	it("gives a memory written after the first check its op on the next slice", () => {
		insertMemory(db, { importKey: "key:old" });
		slice();

		insertMemory(db, { importKey: "key:new", updatedAt: LONG_AGO });
		const result = slice(db, minutesAfter(1));

		expect(result).toEqual({ opsCreated: 1, keysMigrated: 0, complete: true });
		expect(ops(db).map((op) => op.entity_id)).toEqual(["key:new", "key:old"]);
	});

	it("records the delete for a memory deactivated in place without an op", () => {
		const memoryId = insertMemory(db, { importKey: "key:kept" });
		slice();

		// Maintenance commands deactivate rows this way: no revision bump, no op.
		const deactivatedAt = minutesAfter(30).toISOString();
		db.prepare("UPDATE memory_items SET active = 0, updated_at = ? WHERE id = ?").run(
			deactivatedAt,
			memoryId,
		);
		const result = slice(db, minutesAfter(31));

		expect(result.opsCreated).toBe(1);
		expect(ops(db)).toEqual([
			{ entity_id: "key:kept", op_type: "delete", clock_rev: 1 },
			{ entity_id: "key:kept", op_type: "upsert", clock_rev: 1 },
		]);
	});

	it("rechecks rows a slower writer committed just behind the previous position", () => {
		const memoryId = insertMemory(db, { importKey: "key:late" });
		slice();
		slice(db, minutesAfter(10));

		// Stamped two minutes before the previous slice, committed after it.
		db.prepare("UPDATE memory_items SET active = 0, updated_at = ? WHERE id = ?").run(
			minutesAfter(8).toISOString(),
			memoryId,
		);

		expect(slice(db, minutesAfter(11)).opsCreated).toBe(1);
	});
});

describe("runReplicationBackfillSlice limits", () => {
	it("tries an unmigratable legacy key once and reports it once", () => {
		// The device-scoped key the legacy row would get already belongs to another memory.
		const holder = insertMemory(db, { importKey: "legacy:dev-local:memory_item:7" });
		const blocked = insertMemory(db, { importKey: "legacy:memory_item:7" });
		const warn = vi.fn();

		slice(db, NOW, warn);
		slice(db, minutesAfter(1), warn);
		// Even with the other memory gone, the row is not looked at again.
		db.prepare("DELETE FROM memory_items WHERE id = ?").run(holder);
		slice(db, minutesAfter(20), warn);

		expect(importKey(db, blocked)).toBe("legacy:memory_item:7");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("1 legacy import key was left unchanged");
		expect(getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)).toMatchObject({
			status: "completed",
			message: expect.stringContaining("1 legacy import key was left unchanged"),
			metadata: { blocked_legacy_keys: 1, reported_blocked_legacy_keys: 1 },
		});
	});

	it("stops at its time limit and continues from where it stopped", () => {
		for (let index = 0; index < 450; index++) insertMemory(db);
		// Every look at the clock is past the limit, so each slice checks one window.
		let tick = 0;
		const outOfTime = { maxRuntimeMs: 1, now: () => NOW, clock: () => tick++ * 10 };

		const first = runReplicationBackfillSlice(db, outOfTime);
		expect(first).toMatchObject({ opsCreated: 200, complete: false });
		expect(getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)).toMatchObject({
			status: "running",
			progress: { current: 200, total: 450, unit: "memories" },
		});

		expect(runReplicationBackfillSlice(db, outOfTime)).toMatchObject({ opsCreated: 200 });
		expect(runReplicationBackfillSlice(db, outOfTime)).toMatchObject({ opsCreated: 50 });
		expect(runReplicationBackfillSlice(db, outOfTime)).toEqual({
			opsCreated: 0,
			keysMigrated: 0,
			complete: true,
		});
		expect(ops(db)).toHaveLength(450);
		expect(getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)?.status).toBe("completed");
	});

	it("reads a memory that reuses the ID of a deleted newest row", () => {
		insertMemory(db, { importKey: "key:first" });
		const newest = insertMemory(db, { importKey: "key:second" });
		slice();

		db.prepare("DELETE FROM memory_items WHERE id = ?").run(newest);
		slice(db, minutesAfter(1));
		const reused = insertMemory(db, { importKey: "key:third", updatedAt: LONG_AGO });

		expect(reused).toBe(newest);
		expect(slice(db, minutesAfter(2)).opsCreated).toBe(1);
		expect(ops(db).map((op) => op.entity_id)).toContain("key:third");
	});

	it("leaves the position unset until the device has a sync identity", () => {
		db.exec("DELETE FROM sync_device");
		insertMemory(db, { importKey: "key:waiting" });

		expect(slice()).toEqual({ opsCreated: 0, keysMigrated: 0, complete: true });
		expect(getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)).toBeNull();

		addDeviceIdentity(db);
		expect(slice().opsCreated).toBe(1);
	});

	it("does not write when nothing changed and its position was saved recently", () => {
		insertMemory(db);
		slice();
		const savedAt = getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)?.metadata?.updated_at;
		const before = db.prepare("SELECT total_changes() AS n").get();

		slice(db, minutesAfter(2));

		expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
		slice(db, minutesAfter(6));
		expect(getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)?.metadata?.updated_at).not.toBe(savedAt);
	});
});

describe("memories changed at the same instant", () => {
	/** Deactivates every memory with one statement, as a maintenance command does. */
	function deactivateAllAt(at: Date): void {
		db.prepare("UPDATE memory_items SET active = 0, updated_at = ?").run(at.toISOString());
	}

	it("records every delete across pages of one timestamp", () => {
		for (let index = 0; index < 450; index++) insertMemory(db);
		slice();
		deactivateAllAt(minutesAfter(30));
		// Each slice sees its limit spent after one page of changed rows.
		let tick = 0;
		const onePage = { maxRuntimeMs: 1, now: () => minutesAfter(31), clock: () => tick++ * 10 };

		const created = [0, 1, 2, 3].map(() => runReplicationBackfillSlice(db, onePage).opsCreated);

		expect(created).toEqual([200, 200, 50, 0]);
		expect(ops(db).filter((op) => op.op_type === "delete")).toHaveLength(450);
	});

	it("starts each page after the previous position by index seek", () => {
		for (let index = 0; index < 5; index++) insertMemory(db);
		slice();
		deactivateAllAt(minutesAfter(30));

		const plans = capturePlans(db, () => slice(db, minutesAfter(31)));

		const withinTimestamp = plans.find(({ sql }) => sql.includes("WHERE updated_at = ?"));
		expect(withinTimestamp?.steps.join(" ")).toContain("(updated_at=? AND rowid>?)");
		// No statement seeks to the timestamp alone and filters the ID afterwards.
		expect(plans.filter(({ sql }) => sql.includes("updated_at >= ?"))).toEqual([]);
		expect(statementsScanning(plans, "memory_items")).toEqual([]);
	});
});

describe("recheck after replication ops are pruned", () => {
	it("gives a memory a new op when its current one was removed", () => {
		insertMemory(db, { importKey: "key:pruned" });
		insertMemory(db, { importKey: "key:kept" });
		slice();
		db.prepare("DELETE FROM replication_ops WHERE entity_id = 'key:pruned'").run();
		expect(slice(db, minutesAfter(1)).opsCreated).toBe(0);

		requestReplicationBackfillRecheck(db);
		const result = slice(db, minutesAfter(2));

		expect(result).toEqual({ opsCreated: 1, keysMigrated: 0, complete: true });
		expect(ops(db).map((op) => op.entity_id)).toEqual(["key:kept", "key:pruned"]);
		expect(getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)?.status).toBe("completed");
	});

	it("does not try or report unmigratable legacy keys again", () => {
		insertMemory(db, { importKey: "legacy:dev-local:memory_item:7" });
		const blocked = insertMemory(db, { importKey: "legacy:memory_item:7" });
		const warn = vi.fn();
		slice(db, NOW, warn);

		requestReplicationBackfillRecheck(db);
		slice(db, minutesAfter(1), warn);

		expect(importKey(db, blocked)).toBe("legacy:memory_item:7");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)?.metadata).toMatchObject({
			blocked_legacy_keys: 1,
		});
	});

	it("is requested when pruning removes ops", () => {
		insertMemory(db, { importKey: "key:old-op" });
		slice();
		db.prepare("UPDATE replication_ops SET created_at = ?").run(LONG_AGO);

		const pruned = pruneReplicationOps(db, { maxAgeDays: 30 });
		const result = slice(db, minutesAfter(1));

		expect(pruned.deleted).toBe(1);
		expect(result.opsCreated).toBe(1);
		expect(ops(db)).toEqual([{ entity_id: "key:old-op", op_type: "upsert", clock_rev: 1 }]);
	});
});

describe("memories that reuse the ID of a deleted row", () => {
	it("checks a replacement inserted before the next slice", () => {
		insertMemory(db, { importKey: "key:first" });
		const newest = insertMemory(db, { importKey: "key:second" });
		slice();

		// No slice runs between the deletion and the insert, and the import keeps an old time.
		db.prepare("DELETE FROM memory_items WHERE id = ?").run(newest);
		const replacement = insertMemory(db, { importKey: "key:imported", updatedAt: LONG_AGO });

		expect(replacement).toBe(newest);
		expect(slice(db, minutesAfter(1)).opsCreated).toBe(1);
		expect(ops(db).map((op) => op.entity_id)).toContain("key:imported");
	});

	it("checks every replacement when several newest rows were deleted", () => {
		const ids = ["a", "b", "c", "d", "e"].map((name) =>
			insertMemory(db, { importKey: `key:${name}` }),
		);
		slice();

		db.prepare("DELETE FROM memory_items WHERE id >= ?").run(ids[2]);
		insertMemory(db, { importKey: "key:new-1", updatedAt: LONG_AGO });
		insertMemory(db, { importKey: "key:new-2", updatedAt: LONG_AGO });

		expect(slice(db, minutesAfter(1)).opsCreated).toBe(2);
		expect(slice(db, minutesAfter(2)).opsCreated).toBe(0);
	});

	it("checks every memory again when none of the remembered rows survived", () => {
		const ids = Array.from({ length: 12 }, (_, index) =>
			insertMemory(db, { importKey: `key:${index}` }),
		);
		slice();

		// More newest rows than a slice remembers are deleted and replaced.
		db.prepare("DELETE FROM memory_items WHERE id >= ?").run(ids[2]);
		for (let index = 0; index < 10; index++) {
			insertMemory(db, { importKey: `key:replacement-${index}`, updatedAt: LONG_AGO });
		}

		expect(slice(db, minutesAfter(1)).opsCreated).toBe(10);
	});
});

describe("legacy keys of memories that reuse the ID of a deleted row", () => {
	function blockedPair(suffix: number) {
		// The device-scoped key the legacy row would get already belongs to another memory.
		insertMemory(db, { importKey: `legacy:dev-local:memory_item:${suffix}` });
		return insertMemory(db, { importKey: `legacy:memory_item:${suffix}` });
	}

	it("rewrites the legacy key of a replacement inserted before the next slice", () => {
		insertMemory(db, { importKey: "key:first" });
		const newest = insertMemory(db, { importKey: "key:second" });
		slice();

		db.prepare("DELETE FROM memory_items WHERE id = ?").run(newest);
		const replacement = insertMemory(db, {
			importKey: "legacy:memory_item:42",
			updatedAt: LONG_AGO,
		});
		const result = slice(db, minutesAfter(1));

		expect(replacement).toBe(newest);
		expect(result).toEqual({ opsCreated: 1, keysMigrated: 1, complete: true });
		expect(importKey(db, replacement)).toBe("legacy:dev-local:memory_item:42");
		expect(ops(db).map((op) => op.entity_id)).toContain("legacy:dev-local:memory_item:42");
	});

	it("rewrites the legacy key of a replacement inserted after a slice saw the deletion", () => {
		insertMemory(db, { importKey: "key:first" });
		const newest = insertMemory(db, { importKey: "key:second" });
		slice();

		db.prepare("DELETE FROM memory_items WHERE id = ?").run(newest);
		slice(db, minutesAfter(1));
		const replacement = insertMemory(db, {
			importKey: "legacy:memory_item:42",
			updatedAt: LONG_AGO,
		});

		expect(slice(db, minutesAfter(2)).keysMigrated).toBe(1);
		expect(importKey(db, replacement)).toBe("legacy:dev-local:memory_item:42");
	});

	it("does not try a blocked key below the replacements again", () => {
		const blocked = blockedPair(7);
		insertMemory(db, { importKey: "key:kept" });
		const newest = insertMemory(db, { importKey: "key:newest" });
		const warn = vi.fn();
		slice(db, NOW, warn);

		db.prepare("DELETE FROM memory_items WHERE id = ?").run(newest);
		insertMemory(db, { importKey: "legacy:memory_item:42", updatedAt: LONG_AGO });
		// Its blocker is gone, so trying the blocked row again would rewrite its key.
		db.prepare(
			"DELETE FROM memory_items WHERE import_key = 'legacy:dev-local:memory_item:7'",
		).run();
		slice(db, minutesAfter(1), warn);

		expect(importKey(db, blocked)).toBe("legacy:memory_item:7");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)?.metadata).toMatchObject({
			blocked_legacy_keys: 1,
			reported_blocked_legacy_keys: 1,
		});
	});

	it("counts blocked keys once when every remembered row was replaced", () => {
		blockedPair(7);
		const ids = Array.from({ length: 10 }, (_, index) =>
			insertMemory(db, { importKey: `key:${index}` }),
		);
		const warn = vi.fn();
		slice(db, NOW, warn);

		// More newest rows than a slice remembers are deleted and replaced.
		db.prepare("DELETE FROM memory_items WHERE id >= ?").run(ids[0]);
		const replacement = insertMemory(db, {
			importKey: "legacy:memory_item:42",
			updatedAt: LONG_AGO,
		});
		for (let index = 0; index < 9; index++) {
			insertMemory(db, { importKey: `key:replacement-${index}`, updatedAt: LONG_AGO });
		}
		const result = slice(db, minutesAfter(1), warn);

		expect(result).toEqual({ opsCreated: 10, keysMigrated: 1, complete: true });
		expect(importKey(db, replacement)).toBe("legacy:dev-local:memory_item:42");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(getMaintenanceJob(db, REPLICATION_BACKFILL_JOB)?.metadata).toMatchObject({
			blocked_legacy_keys: 1,
			reported_blocked_legacy_keys: 1,
		});
	});
});

describe("slices from two processes", () => {
	let dir: string;
	let dbPath: string;
	let worker: ReturnType<typeof connect>;
	let viewer: ReturnType<typeof connect>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codemem-replication-backfill-lock-"));
		dbPath = join(dir, "mem.sqlite");
		worker = connect(dbPath);
		viewer = connect(dbPath);
		addDeviceIdentity(worker);
		sessionId = insertTestSession(worker);
	});

	afterEach(() => {
		viewer.close();
		worker.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("skips a slice that would have to wait for another writer", () => {
		insertMemory(worker, { importKey: "key:waiting" });
		worker.exec("BEGIN IMMEDIATE");

		const skipped = runReplicationBackfillSlice(viewer, { waitForWriteLock: false });
		worker.exec("COMMIT");
		const done = runReplicationBackfillSlice(viewer, { waitForWriteLock: false });

		expect(skipped).toEqual({ opsCreated: 0, keysMigrated: 0, complete: false });
		expect(done).toEqual({ opsCreated: 1, keysMigrated: 0, complete: true });
		expect(viewer.pragma("busy_timeout", { simple: true })).toBe(5000);
	});

	it("takes no write lock when there is nothing to write", () => {
		insertMemory(worker, { importKey: "key:done" });
		slice(worker);
		worker.exec("BEGIN IMMEDIATE");

		// An idle slice finishes while the other connection holds the write lock.
		const idle = slice(viewer, minutesAfter(1));
		worker.exec("COMMIT");

		expect(idle).toEqual({ opsCreated: 0, keysMigrated: 0, complete: true });
	});

	it("continues from the position another process stored", () => {
		for (let index = 0; index < 450; index++) insertMemory(worker);
		let tick = 0;
		const oneWindow = { maxRuntimeMs: 1, now: () => NOW, clock: () => tick++ * 10 };

		runReplicationBackfillSlice(worker, oneWindow);
		runReplicationBackfillSlice(viewer, oneWindow);
		runReplicationBackfillSlice(worker, oneWindow);
		const last = runReplicationBackfillSlice(viewer, oneWindow);

		expect(last).toEqual({ opsCreated: 0, keysMigrated: 0, complete: true });
		expect(ops(viewer)).toHaveLength(450);
		expect(getMaintenanceJob(viewer, REPLICATION_BACKFILL_JOB)).toMatchObject({
			status: "completed",
			progress: { current: 450 },
		});
	});
});

describe("syncPassPreflight", () => {
	it("gives new memories their op without scanning the store", () => {
		for (let index = 0; index < 5; index++) insertMemory(db);
		syncPassPreflight(db);
		insertMemory(db, { importKey: "key:fresh" });

		const plans = capturePlans(db, () => syncPassPreflight(db));

		expect(ops(db).map((op) => op.entity_id)).toContain("key:fresh");
		expect(statementsScanning(plans, "memory_items")).toEqual([]);
		expect(statementsScanning(plans, "replication_ops")).toEqual([]);
	});
});

describe("runReplicationBackfillPass", () => {
	it("works through a store in slices until every memory is checked", async () => {
		for (let index = 0; index < 450; index++) insertMemory(db);
		// Each slice sees its limit spent after one window; the pass keeps going.
		let tick = 0;

		const result = await runReplicationBackfillPass(db, {
			maxRuntimeMs: 1_000_000,
			now: () => NOW,
			clock: () => tick++ * 60,
		});

		expect(result).toEqual({ opsCreated: 450, keysMigrated: 0, complete: true });
	});
});

describe("ReplicationBackfillRunner", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codemem-replication-backfill-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A file-backed store, as the maintenance worker opens one of its own. */
	function storeOnDisk() {
		const dbPath = join(dir, "mem.sqlite");
		const file = connect(dbPath);
		addDeviceIdentity(file);
		sessionId = insertTestSession(file);
		const logger = { step: vi.fn(), warn: vi.fn() };
		return { file, logger, runner: new ReplicationBackfillRunner({ dbPath, logger }) };
	}

	/** A sync pass's slice that sees its limit spent after one window of rows. */
	function syncSliceOfOneWindow(file: Db) {
		let tick = 0;
		return runReplicationBackfillSlice(file, {
			maxRuntimeMs: 1,
			now: () => NOW,
			clock: () => tick++ * 10,
		});
	}

	it("leaves a store that no sync pass has checked as it is", async () => {
		const { file, logger, runner } = storeOnDisk();
		// Never synced: sharing its Project moves it without asking another device.
		const neverSynced = insertMemory(file, { importKey: null });
		insertMemory(file, { importKey: "legacy:memory_item:42" });

		const retrySoon = await runner.runOnce();

		expect(retrySoon).toBe(false);
		expect(importKey(file, neverSynced)).toBeNull();
		expect(ops(file)).toEqual([]);
		expect(getMaintenanceJob(file, REPLICATION_BACKFILL_JOB)).toBeNull();
		expect(logger.step).not.toHaveBeenCalled();
		file.close();
	});

	it("finishes a check that a sync pass ran out of time for", async () => {
		const { file, logger, runner } = storeOnDisk();
		for (let index = 0; index < 450; index++) insertMemory(file);
		const begun = syncSliceOfOneWindow(file);

		const retrySoon = await runner.runOnce();

		expect(begun).toEqual({ opsCreated: 200, keysMigrated: 0, complete: false });
		expect(retrySoon).toBe(false);
		expect(ops(file)).toHaveLength(450);
		expect(logger.step).toHaveBeenCalledWith(
			"Replication backfill recorded 250 sync changes and rewrote 0 legacy import keys",
		);
		expect(logger.warn).not.toHaveBeenCalled();
		expect(getMaintenanceJob(file, REPLICATION_BACKFILL_JOB)).toMatchObject({
			status: "completed",
			metadata: { unfinished: false },
		});
		file.close();
	});

	it("leaves memories written after a finished check to the next sync pass", async () => {
		const { file, runner } = storeOnDisk();
		insertMemory(file, { importKey: "key:checked" });
		slice(file);
		const written = insertMemory(file, { importKey: null });

		await runner.runOnce();
		const untouched = importKey(file, written);
		const bySyncPass = slice(file, minutesAfter(1));

		expect(untouched).toBeNull();
		expect(bySyncPass).toEqual({ opsCreated: 1, keysMigrated: 1, complete: true });
		expect(importKey(file, written)).toBe(`legacy:dev-local:memory_item:${written}`);
		file.close();
	});

	it("leaves a recheck after pruning to the next sync pass", async () => {
		const { file, runner } = storeOnDisk();
		insertMemory(file, { importKey: "key:pruned" });
		slice(file);
		file.prepare("DELETE FROM replication_ops").run();
		requestReplicationBackfillRecheck(file);

		await runner.runOnce();
		const afterWorker = ops(file);
		slice(file, minutesAfter(1));

		expect(afterWorker).toEqual([]);
		expect(ops(file)).toEqual([{ entity_id: "key:pruned", op_type: "upsert", clock_rev: 1 }]);
		file.close();
	});
});
