import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAdditiveSchemaCompatibility } from "./db.js";
import { deleteOrphanReplicationCursorsOnce } from "./replication-cursor-orphan-cleanup.js";
import { saveSyncChannelCompletedBoundary } from "./sync-channel-progress.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-17T00:00:00.000Z";
const PROGRESS_TABLES = ["replication_cursors", "replication_cursors_v2", "sync_channel_progress"];
let db: InstanceType<typeof Database>;

function addCursors(deviceId: string) {
	db.prepare(
		"INSERT INTO replication_cursors(peer_device_id, last_applied_cursor, updated_at) VALUES (?, 'c1', ?)",
	).run(deviceId, NOW);
	db.prepare(
		"INSERT INTO replication_cursors_v2(peer_device_id, scope_id, last_applied_cursor, updated_at) VALUES (?, 'scope-a', 'c2', ?)",
	).run(deviceId, NOW);
	saveSyncChannelCompletedBoundary(db, {
		peerDeviceId: deviceId,
		scopeId: "scope-a",
		boundary: { generation: 1, snapshot_id: "snapshot-1", baseline_cursor: null },
	});
}

function cursorDeviceIds(table: string) {
	return db
		.prepare(`SELECT DISTINCT peer_device_id FROM ${table} ORDER BY peer_device_id`)
		.pluck()
		.all();
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	db.prepare("INSERT INTO sync_peers(peer_device_id, created_at) VALUES ('paired', ?)").run(NOW);
	addCursors("paired");
	addCursors("unpaired");
});

afterEach(() => db.close());

describe("deleteOrphanReplicationCursorsOnce", () => {
	it("H16: deletes sync progress in all three tables for a device with no pairing and keeps a paired device's rows", () => {
		const counts = deleteOrphanReplicationCursorsOnce(db);

		expect(counts).toEqual({
			replicationCursors: 1,
			replicationCursorsV2: 1,
			syncChannelProgress: 1,
		});
		for (const table of PROGRESS_TABLES) expect(cursorDeviceIds(table)).toEqual(["paired"]);
	});

	it("H16: cleans the cursor tables on a device that never installed the channel progress table", () => {
		db.exec("DROP TABLE sync_channel_progress");

		expect(deleteOrphanReplicationCursorsOnce(db)).toEqual({
			replicationCursors: 1,
			replicationCursorsV2: 1,
			syncChannelProgress: 0,
		});
	});

	it("H16: runs once, so a later cursor without a pairing is left alone", () => {
		deleteOrphanReplicationCursorsOnce(db);
		addCursors("later");

		expect(deleteOrphanReplicationCursorsOnce(db)).toBeNull();
		expect(cursorDeviceIds("replication_cursors_v2")).toEqual(["later", "paired"]);
	});

	it("H16: a failure deletes nothing and leaves the cleanup to run again", () => {
		db.exec(`CREATE TRIGGER fail_scoped_cursor_delete BEFORE DELETE ON replication_cursors_v2
			BEGIN SELECT RAISE(ABORT, 'cursor delete failed'); END`);

		expect(() => deleteOrphanReplicationCursorsOnce(db)).toThrow("cursor delete failed");
		for (const table of PROGRESS_TABLES) {
			expect(cursorDeviceIds(table)).toEqual(["paired", "unpaired"]);
		}

		db.exec("DROP TRIGGER fail_scoped_cursor_delete");
		expect(deleteOrphanReplicationCursorsOnce(db)).toEqual({
			replicationCursors: 1,
			replicationCursorsV2: 1,
			syncChannelProgress: 1,
		});
	});

	it("H16: opening a database runs the cleanup, and a failing cleanup does not stop the open", () => {
		db.exec(`CREATE TRIGGER fail_scoped_cursor_delete BEFORE DELETE ON replication_cursors_v2
			BEGIN SELECT RAISE(ABORT, 'cursor delete failed'); END`);

		expect(() => ensureAdditiveSchemaCompatibility(db)).not.toThrow();
		expect(cursorDeviceIds("replication_cursors")).toEqual(["paired", "unpaired"]);

		db.exec("DROP TRIGGER fail_scoped_cursor_delete");
		ensureAdditiveSchemaCompatibility(db);
		for (const table of PROGRESS_TABLES) expect(cursorDeviceIds(table)).toEqual(["paired"]);
	});
});
