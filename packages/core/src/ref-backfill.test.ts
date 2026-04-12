import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { hasPendingRefBackfill, REF_BACKFILL_JOB, runRefBackfillPass } from "./ref-backfill.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

/**
 * Insert a "legacy" memory that has JSON arrays in the dedicated columns
 * but no corresponding junction-table rows (simulates data written before
 * the write-time ref population landed).
 */
function seedLegacyMemory(
	db: Database,
	sessionId: number,
	opts: {
		filesRead?: string[] | null;
		filesModified?: string[] | null;
		concepts?: string[] | null;
	} = {},
): number {
	const now = new Date().toISOString();
	const info = db
		.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
			 workspace_id, dedup_key,
			 files_read, files_modified, concepts)
			 VALUES (?, 'discovery', 'Test memory', 'Body', 0.5, '', 1, ?, ?, '{}', 1, 'shared', 'shared:default', NULL,
			 ?, ?, ?)`,
		)
		.run(
			sessionId,
			now,
			now,
			opts.filesRead ? JSON.stringify(opts.filesRead) : null,
			opts.filesModified ? JSON.stringify(opts.filesModified) : null,
			opts.concepts ? JSON.stringify(opts.concepts) : null,
		);
	return Number(info.lastInsertRowid);
}

describe("ref backfill maintenance", () => {
	it("populates file/concept refs for memories that have JSON data", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			const memId = seedLegacyMemory(db, sessionId, {
				filesRead: ["/src/foo.ts", "/src/bar.ts"],
				filesModified: ["/src/baz.ts"],
				concepts: ["TypeScript", "Testing"],
			});

			expect(hasPendingRefBackfill(db)).toBe(true);
			await runRefBackfillPass(db, { batchSize: 10 });

			// File refs should be populated
			const fileRefs = db
				.prepare(
					"SELECT file_path, relation FROM memory_file_refs WHERE memory_id = ? ORDER BY file_path",
				)
				.all(memId) as Array<{ file_path: string; relation: string }>;
			expect(fileRefs).toEqual([
				{ file_path: "/src/bar.ts", relation: "read" },
				{ file_path: "/src/baz.ts", relation: "modified" },
				{ file_path: "/src/foo.ts", relation: "read" },
			]);

			// Concept refs should be normalized to lowercase
			const conceptRefs = db
				.prepare("SELECT concept FROM memory_concept_refs WHERE memory_id = ? ORDER BY concept")
				.all(memId) as Array<{ concept: string }>;
			expect(conceptRefs).toEqual([{ concept: "testing" }, { concept: "typescript" }]);

			expect(hasPendingRefBackfill(db)).toBe(false);
		} finally {
			db.close();
		}
	});

	it("is idempotent — second pass produces no errors or duplicate rows", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			seedLegacyMemory(db, sessionId, {
				filesRead: ["/src/a.ts"],
				concepts: ["Idempotency"],
			});

			await runRefBackfillPass(db, { batchSize: 10 });
			const countAfterFirst = (
				db.prepare("SELECT COUNT(*) AS cnt FROM memory_file_refs").get() as { cnt: number }
			).cnt;

			// Reset job so a second pass will re-process
			db.prepare("DELETE FROM maintenance_jobs WHERE kind = ?").run(REF_BACKFILL_JOB);

			// Second pass — INSERT OR IGNORE means no duplicates
			await runRefBackfillPass(db, { batchSize: 10 });
			const countAfterSecond = (
				db.prepare("SELECT COUNT(*) AS cnt FROM memory_file_refs").get() as { cnt: number }
			).cnt;

			expect(countAfterSecond).toBe(countAfterFirst);
		} finally {
			db.close();
		}
	});

	it("respects batchSize — returns true when more work remains", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			seedLegacyMemory(db, sessionId, { filesRead: ["/a.ts"] });
			seedLegacyMemory(db, sessionId, { filesRead: ["/b.ts"] });
			seedLegacyMemory(db, sessionId, { filesRead: ["/c.ts"] });

			// First pass: batchSize=2, should return true (more work)
			const moreWork = await runRefBackfillPass(db, { batchSize: 2 });
			expect(moreWork).toBe(true);

			const runningJob = getMaintenanceJob(db, REF_BACKFILL_JOB);
			expect(runningJob).toMatchObject({
				status: "running",
				progress: { current: 2, total: 3, unit: "items" },
			});

			// Second pass: processes remaining 1 row, should return false
			const done = await runRefBackfillPass(db, { batchSize: 2 });
			expect(done).toBe(false);

			const completedJob = getMaintenanceJob(db, REF_BACKFILL_JOB);
			expect(completedJob).toMatchObject({
				status: "completed",
				progress: { current: 3, total: 3, unit: "items" },
			});
		} finally {
			db.close();
		}
	});

	it("memories with null JSON arrays produce no ref rows", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			// Memory with all nulls — but we need at least one non-null to match
			// the WHERE clause, so this memory won't be selected at all
			seedLegacyMemory(db, sessionId, {
				filesRead: null,
				filesModified: null,
				concepts: null,
			});

			const moreWork = await runRefBackfillPass(db, { batchSize: 10 });
			expect(moreWork).toBe(false);

			const fileCount = (
				db.prepare("SELECT COUNT(*) AS cnt FROM memory_file_refs").get() as { cnt: number }
			).cnt;
			const conceptCount = (
				db.prepare("SELECT COUNT(*) AS cnt FROM memory_concept_refs").get() as { cnt: number }
			).cnt;
			expect(fileCount).toBe(0);
			expect(conceptCount).toBe(0);
		} finally {
			db.close();
		}
	});

	it("skips memories with corrupt/invalid JSON gracefully", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);

			// Insert a memory with corrupt JSON directly
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility,
				 workspace_id, dedup_key,
				 files_read, files_modified, concepts)
				 VALUES (?, 'discovery', 'Corrupt memory', 'Body', 0.5, '', 1, ?, ?, '{}', 1, 'shared', 'shared:default', NULL,
				 '{not-json', 'also broken', '["valid-concept"]')`,
			).run(sessionId, now, now);

			// Should not throw
			const moreWork = await runRefBackfillPass(db, { batchSize: 10 });
			expect(moreWork).toBe(false);

			// The valid concept should still be inserted
			const conceptCount = (
				db.prepare("SELECT COUNT(*) AS cnt FROM memory_concept_refs").get() as { cnt: number }
			).cnt;
			expect(conceptCount).toBe(1);

			// Corrupt file columns should produce no file refs
			const fileCount = (
				db.prepare("SELECT COUNT(*) AS cnt FROM memory_file_refs").get() as { cnt: number }
			).cnt;
			expect(fileCount).toBe(0);
		} finally {
			db.close();
		}
	});

	it("maintenance job transitions: created → running → completed", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const sessionId = insertTestSession(db);
			seedLegacyMemory(db, sessionId, { concepts: ["alpha"] });
			seedLegacyMemory(db, sessionId, { concepts: ["beta"] });
			seedLegacyMemory(db, sessionId, { concepts: ["gamma"] });

			// First pass with batchSize=2 — creates job in running state
			await runRefBackfillPass(db, { batchSize: 2 });
			const runningJob = getMaintenanceJob(db, REF_BACKFILL_JOB);
			expect(runningJob?.status).toBe("running");
			expect(runningJob?.metadata).toMatchObject({
				processed: 2,
				remaining: 1,
				total_backfillable: 3,
			});

			// Second pass — completes
			await runRefBackfillPass(db, { batchSize: 2 });
			const completedJob = getMaintenanceJob(db, REF_BACKFILL_JOB);
			expect(completedJob?.status).toBe("completed");
			expect(completedJob?.metadata).toMatchObject({
				processed: 3,
				remaining: 0,
				total_backfillable: 3,
			});
		} finally {
			db.close();
		}
	});
});
