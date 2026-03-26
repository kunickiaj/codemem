import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { runSyncRetentionPass } from "./sync-retention-runner.js";
import { initTestSchema } from "./test-utils.js";

function insertReplicationOp(db: ReturnType<typeof connect>, opId: string, createdAt: string) {
	db.prepare(
		`INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type, payload_json, clock_rev, clock_updated_at, clock_device_id, device_id, created_at)
		 VALUES (?, 'memory_item', ?, 'upsert', NULL, 1, ?, 'dev-a', 'dev-a', ?)`,
	).run(opId, `ent-${opId}`, createdAt, createdAt);
}

describe("runSyncRetentionPass", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: ReturnType<typeof connect>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-sync-retention-test-"));
		dbPath = join(tmpDir, "retention.sqlite");
		db = connect(dbPath);
		initTestSchema(db);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("persists aggregated multi-pass pruning results", async () => {
		insertReplicationOp(db, "op-1", "2026-01-01T00:00:01Z");
		insertReplicationOp(db, "op-2", "2026-01-01T00:00:02Z");
		insertReplicationOp(db, "op-3", "2026-01-01T00:00:03Z");
		insertReplicationOp(db, "op-4", "2026-01-01T00:00:04Z");
		insertReplicationOp(db, "op-5", "2026-03-26T00:00:00Z");

		await runSyncRetentionPass(db, {
			syncRetentionEnabled: true,
			syncRetentionMaxAgeDays: 30,
			syncRetentionMaxSizeMb: 1024,
			syncRetentionMaxOpsPerPass: 2,
			syncRetentionMaxRuntimeMs: 60_000,
		});

		const state = db.prepare("SELECT * FROM sync_retention_state WHERE id = 1").get() as {
			last_deleted_ops: number;
			last_estimated_bytes_before: number | null;
			last_estimated_bytes_after: number | null;
			retained_floor_cursor: string | null;
			last_error: string | null;
		};
		expect(state.last_deleted_ops).toBe(4);
		expect(state.last_estimated_bytes_before).not.toBeNull();
		expect(state.last_estimated_bytes_after).not.toBeNull();
		expect(state.retained_floor_cursor).toBe("2026-01-01T00:00:04Z|op-4");
		expect(state.last_error).toBeNull();

		const remaining = db
			.prepare("SELECT op_id FROM replication_ops ORDER BY created_at, op_id")
			.all() as Array<{ op_id: string }>;
		expect(remaining.map((row) => row.op_id)).toEqual(["op-5"]);
	});
});
