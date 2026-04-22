import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import {
	hasPendingSummaryDedupBackfill,
	runSummaryDedupBackfillPass,
	SUMMARY_DEDUP_BACKFILL_JOB,
} from "./summary-dedup-backfill.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

function seedSummary(
	db: Database.Database,
	sessionId: number,
	createdAt: string,
	source: string | null = "observer_summary",
	active = 1,
): number {
	const metadata = source === null ? "{}" : JSON.stringify({ source });
	const info = db
		.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
			 workspace_id)
			 VALUES (?, 'session_summary', 'Session recap', '## Completed\n...', 0.8,
			 '', ?, ?, ?, ?, 1, 'shared', 'shared:default')`,
		)
		.run(sessionId, active, createdAt, createdAt, metadata);
	return Number(info.lastInsertRowid);
}

function getRow(db: Database.Database, id: number) {
	return db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as Record<
		string,
		unknown
	> | null;
}

describe("summary-dedup backfill", () => {
	it("no-ops when every session has at most one active observer summary", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionA = insertTestSession(db);
			const sessionB = insertTestSession(db);
			seedSummary(db, sessionA, "2026-04-10T10:00:00Z");
			seedSummary(db, sessionB, "2026-04-10T11:00:00Z");

			expect(hasPendingSummaryDedupBackfill(db)).toBe(false);
			const hasMore = await runSummaryDedupBackfillPass(db);
			expect(hasMore).toBe(false);
			expect(getMaintenanceJob(db, SUMMARY_DEDUP_BACKFILL_JOB)).toBeNull();
		} finally {
			db.close();
		}
	});

	it("keeps the most-recent summary and supersedes the rest with audit metadata", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			const id1 = seedSummary(db, sessionId, "2026-04-10T10:00:00Z");
			const id2 = seedSummary(db, sessionId, "2026-04-10T11:00:00Z");
			const id3 = seedSummary(db, sessionId, "2026-04-10T12:00:00Z");

			expect(hasPendingSummaryDedupBackfill(db)).toBe(true);
			await runSummaryDedupBackfillPass(db, { deviceId: "test-device" });

			const winner = getRow(db, id3);
			const loser1 = getRow(db, id1);
			const loser2 = getRow(db, id2);

			expect(winner?.active).toBe(1);
			expect(loser1?.active).toBe(0);
			expect(loser2?.active).toBe(0);
			expect(loser1?.deleted_at).toBeTruthy();

			const loser1Meta = JSON.parse(String(loser1?.metadata_json || "{}"));
			expect(loser1Meta.superseded_at).toBeTruthy();
			expect(loser1Meta.superseded_by).toBe(id3);
			expect(loser1Meta.clock_device_id).toBe("test-device");
			expect(Number(loser1?.rev)).toBe(2);

			expect(hasPendingSummaryDedupBackfill(db)).toBe(false);
		} finally {
			db.close();
		}
	});

	it("leaves non-observer summaries alone (only targets observer_summary source)", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			const manual1 = seedSummary(db, sessionId, "2026-04-10T10:00:00Z", null);
			const manual2 = seedSummary(db, sessionId, "2026-04-10T11:00:00Z", "manual");

			expect(hasPendingSummaryDedupBackfill(db)).toBe(false);
			await runSummaryDedupBackfillPass(db);
			expect(getRow(db, manual1)?.active).toBe(1);
			expect(getRow(db, manual2)?.active).toBe(1);
		} finally {
			db.close();
		}
	});

	it("emits replication delete ops for superseded rows", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			const id1 = seedSummary(db, sessionId, "2026-04-10T10:00:00Z");
			seedSummary(db, sessionId, "2026-04-10T12:00:00Z");

			await runSummaryDedupBackfillPass(db, { deviceId: "test-device" });

			const ops = db
				.prepare(
					"SELECT op_type, entity_id FROM replication_ops WHERE entity_type = 'memory_item' ORDER BY created_at",
				)
				.all() as Array<{ op_type: string; entity_id: string }>;
			expect(ops.some((op) => op.op_type === "delete" && op.entity_id === String(id1))).toBe(true);
		} finally {
			db.close();
		}
	});

	it("restarts from session_id 0 after a prior run completed so late-arriving duplicates are caught", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionLate = insertTestSession(db);
			const sessionEarly = insertTestSession(db);
			// First, seed dupes only on the later session. Run to completion.
			seedSummary(db, sessionLate, "2026-04-10T10:00:00Z");
			seedSummary(db, sessionLate, "2026-04-10T11:00:00Z");
			await runSummaryDedupBackfillPass(db);
			expect(getMaintenanceJob(db, SUMMARY_DEDUP_BACKFILL_JOB)?.status).toBe("completed");

			// Now introduce dupes on an earlier session_id (simulating a later
			// sync import resurfacing historical data).
			seedSummary(db, sessionEarly, "2026-04-10T09:00:00Z");
			seedSummary(db, sessionEarly, "2026-04-10T09:30:00Z");

			expect(hasPendingSummaryDedupBackfill(db)).toBe(true);
			const hasMore = await runSummaryDedupBackfillPass(db);
			expect(hasMore).toBe(false);
			expect(hasPendingSummaryDedupBackfill(db)).toBe(false);

			const done = getMaintenanceJob(db, SUMMARY_DEDUP_BACKFILL_JOB);
			expect(done?.status).toBe("completed");
			expect(done?.metadata).toMatchObject({ processed_sessions: 1, superseded_rows: 1 });
		} finally {
			db.close();
		}
	});

	it("tracks progress across batches and completes when drained", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			for (let i = 0; i < 3; i += 1) {
				const sessionId = insertTestSession(db);
				seedSummary(db, sessionId, `2026-04-10T10:0${i}:00Z`);
				seedSummary(db, sessionId, `2026-04-10T11:0${i}:00Z`);
			}

			await runSummaryDedupBackfillPass(db, { batchSize: 2 });
			const mid = getMaintenanceJob(db, SUMMARY_DEDUP_BACKFILL_JOB);
			expect(mid).toMatchObject({
				status: "running",
				progress: { current: 2, total: 3, unit: "sessions" },
			});
			expect(mid?.metadata).toMatchObject({
				processed_sessions: 2,
				superseded_rows: 2,
				total_sessions: 3,
			});

			await runSummaryDedupBackfillPass(db, { batchSize: 2 });
			const done = getMaintenanceJob(db, SUMMARY_DEDUP_BACKFILL_JOB);
			expect(done).toMatchObject({
				status: "completed",
				progress: { current: 3, total: 3, unit: "sessions" },
			});
			expect(done?.metadata).toMatchObject({
				processed_sessions: 3,
				superseded_rows: 3,
			});
			expect(hasPendingSummaryDedupBackfill(db)).toBe(false);
		} finally {
			db.close();
		}
	});
});
