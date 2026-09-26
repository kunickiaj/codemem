import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { REF_BACKFILL_JOB, RefBackfillRunner } from "./ref-backfill.js";
import {
	SUMMARY_DEDUP_BACKFILL_JOB,
	SummaryDedupBackfillRunner,
} from "./summary-dedup-backfill.js";
import { insertTestSession } from "./test-utils.js";

const busyOnce = vi.hoisted(() => ({ remaining: 0, failCalls: [] as string[] }));

vi.mock("./maintenance-jobs.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./maintenance-jobs.js")>();
	return {
		...actual,
		startMaintenanceJob: (...args: Parameters<typeof actual.startMaintenanceJob>) => {
			if (busyOnce.remaining > 0) {
				busyOnce.remaining -= 1;
				throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
			}
			return actual.startMaintenanceJob(...args);
		},
		failMaintenanceJob: (...args: Parameters<typeof actual.failMaintenanceJob>) => {
			busyOnce.failCalls.push(args[1]);
			return actual.failMaintenanceJob(...args);
		},
	};
});

let dir: string;
let dbPath: string;

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	busyOnce.remaining = 1;
	busyOnce.failCalls = [];
	dir = mkdtempSync(join(tmpdir(), "codemem-backfill-busy-"));
	dbPath = join(dir, "mem.sqlite");
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

function seed(fn: (db: ReturnType<typeof connect>, sessionId: number) => void): void {
	const db = connect(dbPath);
	try {
		fn(db, insertTestSession(db));
	} finally {
		db.close();
	}
}

function jobStatus(kind: string): string | undefined {
	const db = connect(dbPath);
	try {
		return getMaintenanceJob(db, kind)?.status;
	} finally {
		db.close();
	}
}

async function runUntilIdle(runner: { start(): void; stop(): Promise<void> }): Promise<void> {
	runner.start();
	await vi.advanceTimersByTimeAsync(100);
	await vi.advanceTimersByTimeAsync(5_000);
	await runner.stop();
}

describe("backfill runners on a busy database", () => {
	it("ref backfill retries instead of failing the job", async () => {
		seed((db, sessionId) => {
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, active,
				 created_at, updated_at, metadata_json, rev, visibility, workspace_id, files_read)
				 VALUES (?, 'discovery', 'm', 'b', 0.5, '', 1, ?, ?, '{}', 1, 'shared', 'shared:default', ?)`,
			).run(sessionId, now, now, JSON.stringify(["/src/a.ts"]));
		});

		await runUntilIdle(new RefBackfillRunner({ dbPath, intervalMs: 1000 }));

		expect(busyOnce.remaining).toBe(0);
		expect(busyOnce.failCalls).toEqual([]);
		expect(jobStatus(REF_BACKFILL_JOB)).toBe("completed");
	});

	it("summary-dedup backfill retries instead of failing the job", async () => {
		seed((db, sessionId) => {
			const insert = db.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, active,
				 created_at, updated_at, metadata_json, rev, visibility, workspace_id)
				 VALUES (?, 'session_summary', 's', 'b', 0.8, '', 1, ?, ?, ?, 1, 'shared', 'shared:default')`,
			);
			const meta = JSON.stringify({ source: "observer_summary" });
			insert.run(sessionId, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", meta);
			insert.run(sessionId, "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z", meta);
		});

		await runUntilIdle(new SummaryDedupBackfillRunner({ dbPath, intervalMs: 1000 }));

		expect(busyOnce.remaining).toBe(0);
		expect(busyOnce.failCalls).toEqual([]);
		expect(jobStatus(SUMMARY_DEDUP_BACKFILL_JOB)).toBe("completed");
	});
});
