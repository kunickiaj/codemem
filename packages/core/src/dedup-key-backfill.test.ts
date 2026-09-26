import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	DEDUP_KEY_BACKFILL_JOB,
	hasPendingDedupKeyBackfill,
	runDedupKeyBackfillPass,
} from "./dedup-key-backfill.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

function seedMemoryWithoutDedupKey(
	db: Database,
	sessionId: number,
	title: string,
	active = 1,
): number {
	const now = new Date().toISOString();
	const info = db
		.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
			 workspace_id, dedup_key)
			 VALUES (?, 'discovery', ?, 'Body', 0.5, '', ?, ?, ?, '{}', 1, 'shared', 'shared:default', NULL)`,
		)
		.run(sessionId, title, active, now, now);
	return Number(info.lastInsertRowid);
}

describe("dedup-key backfill maintenance", () => {
	it("runs once for duplicate scopes, then stops when only skipped rows remain", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			seedMemoryWithoutDedupKey(db, sessionId, "PR #88 duplicate title");
			seedMemoryWithoutDedupKey(db, sessionId, "PR #88 duplicate title");

			expect(hasPendingDedupKeyBackfill(db)).toBe(true);
			await runDedupKeyBackfillPass(db, { batchSize: 10 });

			const job = getMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB);
			expect(job).toMatchObject({
				status: "completed",
				progress: { current: 1, total: 1, unit: "items" },
			});
			expect(job?.metadata).toMatchObject({ remaining_backfillable: 0, skipped_rows: 1 });
			expect(hasPendingDedupKeyBackfill(db)).toBe(false);
		} finally {
			db.close();
		}
	});

	it("re-processes rows inserted after completion by resetting the cursor on terminal state", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			seedMemoryWithoutDedupKey(db, sessionId, "Initial title");
			await runDedupKeyBackfillPass(db, { batchSize: 10 });
			expect(getMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB)?.status).toBe("completed");

			// Simulate a replicated or bootstrap-snapshot row landing AFTER
			// the prior pass marked itself completed. Previously the pass
			// would resume from last_cursor_id (past this row's id) and
			// never touch it, while the predicate kept reporting pending —
			// the "backfill announced every startup" symptom reported by
			// the user.
			db.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
				 workspace_id, dedup_key)
				 VALUES (?, 'discovery', 'Replicated row with no dedup_key', 'Body', 0.5, '', 1, ?, ?, '{}', 1, 'shared', 'shared:default', NULL)`,
			).run(sessionId, "2026-04-22T00:00:00Z", "2026-04-22T00:00:00Z");
			const newRowId = Number(
				(
					db.prepare("SELECT MAX(id) AS id FROM memory_items WHERE dedup_key IS NULL").get() as {
						id: number;
					}
				).id,
			);

			expect(hasPendingDedupKeyBackfill(db)).toBe(true);

			// Re-running the pass must re-scan from id=0 (cursor reset on
			// terminal state) and write a dedup_key for the replicated row.
			await runDedupKeyBackfillPass(db, { batchSize: 10 });
			const row = db.prepare("SELECT dedup_key FROM memory_items WHERE id = ?").get(newRowId) as {
				dedup_key: string | null;
			};
			expect(row.dedup_key).toBeTruthy();
			expect(hasPendingDedupKeyBackfill(db)).toBe(false);
		} finally {
			db.close();
		}
	});

	it("keys every row when id order differs from created_at order across batches", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			const insert = db.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
				 workspace_id, dedup_key)
				 VALUES (?, 'discovery', ?, 'Body', 0.5, '', 1, ?, ?, '{}', 1, 'shared', 'shared:default', NULL)`,
			);
			// Newer rows get smaller ids, like memories synced in after local ones.
			for (let index = 0; index < 6; index++) {
				const createdAt = `2026-0${6 - index}-01T00:00:00Z`;
				insert.run(sessionId, `Distinct title ${index}`, createdAt, createdAt);
			}

			for (
				let pass = 0;
				pass < 20 && (await runDedupKeyBackfillPass(db, { batchSize: 2 }));
				pass++
			) {
				// Keep running batches until the pass reports completion.
			}

			expect(getMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB)?.status).toBe("completed");
			expect(
				db.prepare("SELECT COUNT(*) FROM memory_items WHERE dedup_key IS NULL").pluck().get(),
			).toBe(0);
			expect(hasPendingDedupKeyBackfill(db)).toBe(false);
		} finally {
			db.close();
		}
	});

	it("tracks progress and completes when backfillable rows are exhausted", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			seedMemoryWithoutDedupKey(db, sessionId, "Legacy title one");
			seedMemoryWithoutDedupKey(db, sessionId, "Legacy title two");
			seedMemoryWithoutDedupKey(db, sessionId, "Legacy title three");

			expect(hasPendingDedupKeyBackfill(db)).toBe(true);

			await runDedupKeyBackfillPass(db, { batchSize: 2 });

			const runningJob = getMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB);
			expect(runningJob).toMatchObject({
				status: "running",
				progress: { current: 2, total: 3, unit: "items" },
			});
			expect(runningJob?.metadata).toMatchObject({
				processed_updates: 2,
				remaining_backfillable: 1,
				total_backfillable: 3,
			});

			await runDedupKeyBackfillPass(db, { batchSize: 2 });

			const completedJob = getMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB);
			expect(completedJob).toMatchObject({
				status: "completed",
				progress: { current: 3, total: 3, unit: "items" },
			});
			expect(completedJob?.metadata).toMatchObject({
				processed_updates: 3,
				remaining_backfillable: 0,
				total_backfillable: 3,
			});
			expect(hasPendingDedupKeyBackfill(db)).toBe(false);
		} finally {
			db.close();
		}
	});
});

describe("dedup-key backfill concurrent inserts", () => {
	it("rescans before completing when a row is inserted behind the cursor mid-run", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			const insert = db.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
				 workspace_id, dedup_key)
				 VALUES (?, 'discovery', ?, 'Body', 0.5, '', 1, ?, ?, '{}', 1, 'shared', 'shared:default', NULL)`,
			);
			for (let index = 0; index < 4; index++) {
				const createdAt = `2026-0${index + 2}-01T00:00:00Z`;
				insert.run(sessionId, `Local title ${index}`, createdAt, createdAt);
			}

			expect(await runDedupKeyBackfillPass(db, { batchSize: 2 })).toBe(true);
			// A synced memory keeps its older source created_at but gets a new id.
			insert.run(sessionId, "Synced title", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
			for (
				let pass = 0;
				pass < 20 && (await runDedupKeyBackfillPass(db, { batchSize: 2 }));
				pass++
			) {
				const job = getMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB);
				expect(job?.progress.current).toBeLessThanOrEqual(job?.progress.total ?? 0);
			}

			const job = getMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB);
			expect(job?.status).toBe("completed");
			expect(job?.metadata?.processed_updates).toBe(5);
			expect(job?.metadata?.total_backfillable).toBe(5);
			expect(
				db.prepare("SELECT COUNT(*) FROM memory_items WHERE dedup_key IS NULL").pluck().get(),
			).toBe(0);
		} finally {
			db.close();
		}
	});

	it("keys rows with an empty created_at on the initial scan", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			db.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
				 workspace_id, dedup_key)
				 VALUES (?, 'discovery', 'Imported title', 'Body', 0.5, '', 1, '', '', '{}', 1,
				 'shared', 'shared:default', NULL)`,
			).run(sessionId);

			expect(hasPendingDedupKeyBackfill(db)).toBe(true);
			for (
				let pass = 0;
				pass < 5 && (await runDedupKeyBackfillPass(db, { batchSize: 2 }));
				pass++
			) {
				// Keep running batches until the pass reports completion.
			}

			expect(getMaintenanceJob(db, DEDUP_KEY_BACKFILL_JOB)?.status).toBe("completed");
			expect(hasPendingDedupKeyBackfill(db)).toBe(false);
		} finally {
			db.close();
		}
	});
});
