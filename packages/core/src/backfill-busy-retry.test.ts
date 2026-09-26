import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { hasPendingRefBackfill, REF_BACKFILL_JOB, RefBackfillRunner } from "./ref-backfill.js";
import {
	hasPendingSummaryDedupBackfill,
	SUMMARY_DEDUP_BACKFILL_JOB,
	SummaryDedupBackfillRunner,
} from "./summary-dedup-backfill.js";
import { insertTestSession } from "./test-utils.js";

const busyOnce = vi.hoisted(() => ({
	remaining: 0,
	target: "start" as "start" | "complete",
	failCalls: [] as string[],
}));

vi.mock("./maintenance-jobs.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./maintenance-jobs.js")>();
	const throwIfBusy = (target: typeof busyOnce.target) => {
		if (busyOnce.target !== target || busyOnce.remaining <= 0) return;
		busyOnce.remaining -= 1;
		throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
	};
	return {
		...actual,
		startMaintenanceJob: (...args: Parameters<typeof actual.startMaintenanceJob>) => {
			throwIfBusy("start");
			return actual.startMaintenanceJob(...args);
		},
		completeMaintenanceJob: (...args: Parameters<typeof actual.completeMaintenanceJob>) => {
			throwIfBusy("complete");
			return actual.completeMaintenanceJob(...args);
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
	busyOnce.target = "start";
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

function seedRefBackfillWork(): void {
	seed((db, sessionId) => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, active,
			 created_at, updated_at, metadata_json, rev, visibility, workspace_id, files_read)
			 VALUES (?, 'discovery', 'm', 'b', 0.5, '', 1, ?, ?, '{}', 1, 'shared', 'shared:default', ?)`,
		).run(sessionId, now, now, JSON.stringify(["/src/a.ts"]));
	});
}

function seedSummaryDedupWork(): void {
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
}

function readState(kind: string, isPending: (db: ReturnType<typeof connect>) => boolean) {
	const db = connect(dbPath);
	try {
		return { status: getMaintenanceJob(db, kind)?.status, pending: isPending(db) };
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
		seedRefBackfillWork();

		await runUntilIdle(new RefBackfillRunner({ dbPath, intervalMs: 1000 }));

		expect(busyOnce.remaining).toBe(0);
		expect(busyOnce.failCalls).toEqual([]);
		expect(jobStatus(REF_BACKFILL_JOB)).toBe("completed");
	});

	it("summary-dedup backfill retries instead of failing the job", async () => {
		seedSummaryDedupWork();

		await runUntilIdle(new SummaryDedupBackfillRunner({ dbPath, intervalMs: 1000 }));

		expect(busyOnce.remaining).toBe(0);
		expect(busyOnce.failCalls).toEqual([]);
		expect(jobStatus(SUMMARY_DEDUP_BACKFILL_JOB)).toBe("completed");
	});

	// The sequential coordinator stops a runner as soon as its work is no
	// longer pending, so a busy completion write must never leave finished
	// work behind a job row that still says running.
	it.each([
		{
			name: "ref backfill",
			kind: REF_BACKFILL_JOB,
			isPending: hasPendingRefBackfill,
			seedWork: seedRefBackfillWork,
			createRunner: () => new RefBackfillRunner({ dbPath, intervalMs: 1000 }),
		},
		{
			name: "summary-dedup backfill",
			kind: SUMMARY_DEDUP_BACKFILL_JOB,
			isPending: hasPendingSummaryDedupBackfill,
			seedWork: seedSummaryDedupWork,
			createRunner: () => new SummaryDedupBackfillRunner({ dbPath, intervalMs: 1000 }),
		},
	])("$name keeps work pending when the completion write is busy", async (testCase) => {
		busyOnce.target = "complete";
		testCase.seedWork();
		const runner = testCase.createRunner();

		runner.start();
		await vi.advanceTimersByTimeAsync(100);

		expect(busyOnce.remaining).toBe(0);
		expect(readState(testCase.kind, testCase.isPending)).toEqual({
			status: "running",
			pending: true,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		await runner.stop();

		expect(busyOnce.failCalls).toEqual([]);
		expect(readState(testCase.kind, testCase.isPending)).toEqual({
			status: "completed",
			pending: false,
		});
	});
});
