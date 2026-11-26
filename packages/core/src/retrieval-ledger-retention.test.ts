import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import { purgeExpiredOutcomeEvidence } from "./outcome-evidence.js";
import { purgeExpiredRetrievalAttempts } from "./retrieval-ledger.js";
import {
	type LedgerRetentionLogger,
	LedgerRetentionRunner,
	retrievalLedgerStats,
	runLedgerRetentionPass,
} from "./retrieval-ledger-retention.js";

type Db = ReturnType<typeof connect>;

const NOW = "2026-11-01T00:00:00.000Z";
const PAST = "2026-10-01T00:00:00.000Z";
const FUTURE = "2026-12-01T00:00:00.000Z";
const EXPOSURES_PER_ATTEMPT = 3;
const RECENT_START = "2026-10-25T00:00:00.000Z";

let dir: string;
let dbPath: string;
let db: Db;

/**
 * An attempt with one selected candidate and two it dropped. It started a week before NOW by
 * default, inside the shorter window for candidates it did not select.
 */
function insertAttempt(
	target: Db,
	id: string,
	retentionUntil: string | null,
	{ pinned = false, startedAt = RECENT_START } = {},
): void {
	target
		.prepare(
			`INSERT INTO retrieval_attempts(
				attempt_id, contract_version, surface, trigger, started_at, retrieval_status,
				delivery_status, candidate_count, selected_count, persisted_candidate_count,
				recorder_version, retention_until, retention_pinned
			) VALUES (?, 1, 'prompt_pack', 'automatic', ?, 'succeeded', 'handed_off', 3, 1, 3, 'test', ?, ?)`,
		)
		.run(id, startedAt, retentionUntil, pinned ? 1 : 0);
	const exposure = target.prepare(
		"INSERT INTO retrieval_exposures(attempt_id, rank, disposition, handoff_status) VALUES (?, ?, ?, 'not_attempted')",
	);
	for (let rank = 1; rank <= EXPOSURES_PER_ATTEMPT; rank++)
		exposure.run(id, rank, rank === 1 ? "selected" : "dropped");
}

function insertEvidence(
	target: Db,
	id: string,
	retentionUntil: string | null,
	{ pinned = false } = {},
): void {
	target
		.prepare(
			`INSERT INTO outcome_evidence(
				evidence_id, contract_version, dimension, evidence_type, source_class, observed_at,
				producer, producer_version, status, references_json, retention_until, retention_pinned
			) VALUES (?, 1, 'quality', 'quality.test_result', 'observed', ?, 'test', 'v1', 'pass', '{}', ?, ?)`,
		)
		.run(id, "2026-08-01T00:00:00.000Z", retentionUntil, pinned ? 1 : 0);
}

function attemptIds(target: Db = db): string[] {
	return target
		.prepare("SELECT attempt_id FROM retrieval_attempts ORDER BY attempt_id")
		.pluck()
		.all() as string[];
}

function evidenceIds(target: Db = db): string[] {
	return target
		.prepare("SELECT evidence_id FROM outcome_evidence ORDER BY evidence_id")
		.pluck()
		.all() as string[];
}

function orphanExposures(target: Db = db): number {
	return target
		.prepare(
			`SELECT count(*) FROM retrieval_exposures e
			 LEFT JOIN retrieval_attempts a ON a.attempt_id = e.attempt_id
			 WHERE a.attempt_id IS NULL`,
		)
		.pluck()
		.get() as number;
}

function insertExpiredAttempts(count: number, prefix = "expired"): void {
	for (let index = 0; index < count; index++) {
		const day = String(1 + (index % 28)).padStart(2, "0");
		insertAttempt(
			db,
			`${prefix}-${String(index).padStart(3, "0")}`,
			`2026-10-${day}T00:00:00.000Z`,
		);
	}
}

/** A clock that advances by `stepMs` each time the pass reads it. */
function steppingClock(stepMs: number): () => number {
	let now = 0;
	return () => {
		now += stepMs;
		return now;
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-ledger-retention-"));
	dbPath = join(dir, "mem.sqlite");
	db = connect(dbPath);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("runLedgerRetentionPass", () => {
	it("removes expired attempts with their exposures and keeps unexpired, pinned and undated ones", async () => {
		// Arrange
		insertAttempt(db, "expired", PAST);
		insertAttempt(db, "expires-now", NOW);
		insertAttempt(db, "unexpired", FUTURE);
		insertAttempt(db, "pinned", PAST, { pinned: true });
		insertAttempt(db, "undated", null);
		insertEvidence(db, "evidence-expired", PAST);
		insertEvidence(db, "evidence-unexpired", FUTURE);
		insertEvidence(db, "evidence-pinned", PAST, { pinned: true });
		insertEvidence(db, "evidence-undated", null);

		// Act
		const result = await runLedgerRetentionPass(db, { now: NOW });

		// Assert
		expect(result).toMatchObject({
			retrievalAttemptsPurged: 2,
			outcomeEvidencePurged: 1,
			complete: true,
		});
		expect(attemptIds()).toEqual(["pinned", "undated", "unexpired"]);
		expect(evidenceIds()).toEqual(["evidence-pinned", "evidence-undated", "evidence-unexpired"]);
		expect(orphanExposures()).toBe(0);
		expect(db.prepare("SELECT count(*) FROM retrieval_exposures").pluck().get()).toBe(
			3 * EXPOSURES_PER_ATTEMPT,
		);
	});

	it("removes nothing before its date", async () => {
		insertAttempt(db, "tomorrow", "2026-11-02T00:00:00.000Z");
		insertEvidence(db, "evidence-tomorrow", "2026-11-02T00:00:00.000Z");

		const result = await runLedgerRetentionPass(db, { now: NOW });

		expect(result.retrievalAttemptsPurged + result.outcomeEvidencePurged).toBe(0);
		expect(attemptIds()).toEqual(["tomorrow"]);
		expect(evidenceIds()).toEqual(["evidence-tomorrow"]);
	});

	it("works through a backlog in batches of the configured size", async () => {
		// Arrange
		insertExpiredAttempts(10);

		// Act
		const result = await runLedgerRetentionPass(db, { now: NOW, batchSize: 3 });

		// Assert: 3 + 3 + 3 + 1 attempts, then one short (empty) batch each for non-selected
		// candidates and evidence.
		expect(result).toMatchObject({ retrievalAttemptsPurged: 10, batches: 6, complete: true });
		expect(attemptIds()).toEqual([]);
		expect(orphanExposures()).toBe(0);
	});

	it("stops at its runtime budget and leaves the remainder to later passes", async () => {
		// Arrange
		insertExpiredAttempts(10);
		insertEvidence(db, "evidence-expired", PAST);

		// Act: the clock passes the 10 ms budget after the first batch.
		const first = await runLedgerRetentionPass(db, {
			now: NOW,
			batchSize: 4,
			maxRuntimeMs: 10,
			clock: steppingClock(6),
		});

		// Assert
		expect(first).toMatchObject({
			retrievalAttemptsPurged: 4,
			outcomeEvidencePurged: 0,
			batches: 1,
			complete: false,
		});
		expect(attemptIds()).toHaveLength(6);
		expect(orphanExposures()).toBe(0);

		const second = await runLedgerRetentionPass(db, { now: NOW, batchSize: 4 });
		expect(second).toMatchObject({
			retrievalAttemptsPurged: 6,
			outcomeEvidencePurged: 1,
			complete: true,
		});
		expect(attemptIds()).toEqual([]);
		expect(evidenceIds()).toEqual([]);
	});

	it("does no work once the signal is aborted", async () => {
		insertExpiredAttempts(2);
		const abort = new AbortController();
		abort.abort();

		const result = await runLedgerRetentionPass(db, { now: NOW, signal: abort.signal });

		expect(result).toMatchObject({ retrievalAttemptsPurged: 0, batches: 0, complete: false });
		expect(attemptIds()).toHaveLength(2);
	});

	it("runs alongside a second process's pass without errors or double counting", async () => {
		// Arrange: a second connection stands in for another process on the same file.
		insertExpiredAttempts(40);
		for (let index = 0; index < 10; index++) insertEvidence(db, `evidence-${index}`, PAST);
		const other = connect(dbPath);
		try {
			// Act
			const results = await Promise.all([
				runLedgerRetentionPass(db, { now: NOW, batchSize: 3 }),
				runLedgerRetentionPass(other, { now: NOW, batchSize: 3 }),
			]);

			// Assert
			const attempts = results.reduce((sum, result) => sum + result.retrievalAttemptsPurged, 0);
			const evidence = results.reduce((sum, result) => sum + result.outcomeEvidencePurged, 0);
			expect([attempts, evidence]).toEqual([40, 10]);
			expect(results.every((result) => result.complete)).toBe(true);
			expect(attemptIds(other)).toEqual([]);
			expect(orphanExposures(other)).toBe(0);
		} finally {
			other.close();
		}
	});
});

/** Each exposure of an attempt as `rank:disposition`. */
function exposureRows(id: string, target: Db = db): string[] {
	return target
		.prepare(
			"SELECT rank || ':' || disposition FROM retrieval_exposures WHERE attempt_id = ? ORDER BY rank",
		)
		.pluck()
		.all(id) as string[];
}

function attemptRow(id: string, target: Db = db): unknown {
	return target.prepare("SELECT * FROM retrieval_attempts WHERE attempt_id = ?").get(id);
}

const daysBefore = (days: number, from = NOW) =>
	new Date(Date.parse(from) - days * 86_400_000).toISOString();

describe("non-selected candidate retention", () => {
	it("removes candidates an attempt did not select once it is older than 14 days", async () => {
		// Arrange: both attempts are within their 90-day retention.
		insertAttempt(db, "fifteen-days", FUTURE, { startedAt: daysBefore(15) });
		insertAttempt(db, "thirteen-days", FUTURE, { startedAt: daysBefore(13) });
		const before = attemptRow("fifteen-days");

		// Act
		const result = await runLedgerRetentionPass(db, { now: NOW });

		// Assert: the attempt row and its selected candidate are untouched.
		expect(result).toMatchObject({ nonSelectedExposuresPurged: 2, complete: true });
		expect(exposureRows("fifteen-days")).toEqual(["1:selected"]);
		expect(exposureRows("thirteen-days")).toEqual(["1:selected", "2:dropped", "3:dropped"]);
		expect(attemptRow("fifteen-days")).toEqual(before);
	});

	it("removes every disposition other than selected", async () => {
		insertAttempt(db, "mixed", FUTURE, { startedAt: daysBefore(20) });
		db.prepare(
			"UPDATE retrieval_exposures SET disposition = 'trimmed' WHERE attempt_id = 'mixed' AND rank = 2",
		).run();
		db.prepare(
			"INSERT INTO retrieval_exposures(attempt_id, rank, disposition, handoff_status) VALUES ('mixed', 4, 'deduped', 'not_attempted')",
		).run();

		await runLedgerRetentionPass(db, { now: NOW });

		expect(exposureRows("mixed")).toEqual(["1:selected"]);
	});

	it("keeps the selected candidates until the attempt's own retention ends", async () => {
		// Arrange: 89 days old, with a day left of its 90-day retention.
		insertAttempt(db, "eighty-nine-days", daysBefore(-1), { startedAt: daysBefore(89) });

		// Act
		await runLedgerRetentionPass(db, { now: NOW });
		const kept = exposureRows("eighty-nine-days");
		await runLedgerRetentionPass(db, { now: daysBefore(-2) });

		// Assert
		expect(kept).toEqual(["1:selected"]);
		expect(attemptIds()).toEqual([]);
		expect(orphanExposures()).toBe(0);
	});

	it("leaves pinned and undated attempts whole", async () => {
		insertAttempt(db, "pinned", null, { pinned: true, startedAt: daysBefore(60) });
		insertAttempt(db, "undated", null, { startedAt: daysBefore(60) });

		const result = await runLedgerRetentionPass(db, { now: NOW });

		expect(result.nonSelectedExposuresPurged).toBe(0);
		expect(exposureRows("pinned")).toHaveLength(EXPOSURES_PER_ATTEMPT);
		expect(exposureRows("undated")).toHaveLength(EXPOSURES_PER_ATTEMPT);
	});

	it("works through both rules in batches of the configured size within one budget", async () => {
		// Arrange: 5 expired attempts, and 5 kept attempts past the shorter window.
		insertExpiredAttempts(5);
		for (let index = 0; index < 5; index++)
			insertAttempt(db, `stale-${index}`, FUTURE, { startedAt: daysBefore(30 + index) });

		// Act
		const result = await runLedgerRetentionPass(db, { now: NOW, batchSize: 2 });

		// Assert: 2 + 2 + 1 expired attempts, 2 + 2 + 1 trimmed attempts, one empty evidence batch.
		expect(result).toMatchObject({
			retrievalAttemptsPurged: 5,
			nonSelectedExposuresPurged: 10,
			batches: 7,
			complete: true,
		});
		expect(db.prepare("SELECT count(*) FROM retrieval_exposures").pluck().get()).toBe(5);
	});

	it("stops between the rules at its budget and finishes on a later pass", async () => {
		// Arrange
		insertExpiredAttempts(2);
		for (let index = 0; index < 3; index++)
			insertAttempt(db, `stale-${index}`, FUTURE, { startedAt: daysBefore(30) });

		// Act: the 10 ms budget ends after the expired attempts' two batches.
		const first = await runLedgerRetentionPass(db, {
			now: NOW,
			batchSize: 2,
			maxRuntimeMs: 10,
			clock: steppingClock(4),
		});
		const second = await runLedgerRetentionPass(db, { now: NOW, batchSize: 2 });

		// Assert
		expect(first).toMatchObject({
			retrievalAttemptsPurged: 2,
			nonSelectedExposuresPurged: 0,
			complete: false,
		});
		expect(second).toMatchObject({ nonSelectedExposuresPurged: 6, complete: true });
	});

	it("counts the rows it will remove in the ledger stats", async () => {
		insertAttempt(db, "stale", FUTURE, { startedAt: daysBefore(20) });
		insertAttempt(db, "fresh", FUTURE, { startedAt: daysBefore(2) });
		insertAttempt(db, "pinned", null, { pinned: true, startedAt: daysBefore(20) });

		const before = retrievalLedgerStats(db, NOW);
		const result = await runLedgerRetentionPass(db, { now: NOW });
		const after = retrievalLedgerStats(db, NOW);

		expect(before).toMatchObject({
			non_selected_retrieval_exposures: 6,
			stale_non_selected_retrieval_exposures: 2,
		});
		expect(result.nonSelectedExposuresPurged).toBe(before.stale_non_selected_retrieval_exposures);
		expect(after).toMatchObject({
			non_selected_retrieval_exposures: 4,
			stale_non_selected_retrieval_exposures: 0,
		});
	});
});

describe("batched purge functions", () => {
	it("removes the earliest expiry first and at most the limit", () => {
		insertAttempt(db, "late", "2026-10-20T00:00:00.000Z");
		insertAttempt(db, "early", "2026-10-02T00:00:00.000Z");
		insertAttempt(db, "middle", "2026-10-10T00:00:00.000Z");
		insertEvidence(db, "evidence-late", "2026-10-20T00:00:00.000Z");
		insertEvidence(db, "evidence-early", "2026-10-02T00:00:00.000Z");

		expect(purgeExpiredRetrievalAttempts(db, NOW, { limit: 2 })).toBe(2);
		expect(purgeExpiredOutcomeEvidence(db, NOW, { limit: 1 })).toBe(1);

		expect(attemptIds()).toEqual(["late"]);
		expect(evidenceIds()).toEqual(["evidence-late"]);
		expect(orphanExposures()).toBe(0);
	});

	it("rejects a limit that is not a positive integer", () => {
		for (const limit of [0, -1, 1.5, Number.NaN]) {
			expect(() => purgeExpiredRetrievalAttempts(db, NOW, { limit })).toThrow(/limit/);
			expect(() => purgeExpiredOutcomeEvidence(db, NOW, { limit })).toThrow(/limit/);
		}
	});
});

describe("LedgerRetentionRunner", () => {
	const logger = (): LedgerRetentionLogger => ({ step: vi.fn(), warn: vi.fn() });

	it("logs how many rows a pass purged, and nothing when there was nothing to purge", async () => {
		// Arrange
		insertAttempt(db, "expired", PAST);
		const log = logger();
		const runner = new LedgerRetentionRunner({ dbPath, logger: log });

		// Act
		const first = await runner.runOnce();
		const second = await runner.runOnce();

		// Assert
		expect([first, second]).toEqual([false, false]);
		expect(log.step).toHaveBeenCalledTimes(1);
		expect(log.step).toHaveBeenCalledWith(
			expect.stringMatching(
				/^Retrieval ledger retention purged 1 attempts, 0 non-selected candidates and 0 outcome evidence rows in \d+ ms$/,
			),
		);
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("asks for another pass soon while expired rows remain", async () => {
		insertExpiredAttempts(3);
		const runner = new LedgerRetentionRunner({
			dbPath,
			logger: logger(),
			pass: { batchSize: 1, maxRuntimeMs: 0 },
		});

		expect(await runner.runOnce()).toBe(true);
		expect(attemptIds()).toHaveLength(3);
	});

	it("contains a failing pass, logs it once per failure streak and retries", async () => {
		// Arrange: the database path is a directory, so opening it fails.
		const log = logger();
		const runner = new LedgerRetentionRunner({ dbPath: dir, logger: log });

		// Act
		const results = [await runner.runOnce(), await runner.runOnce()];

		// Assert
		expect(results).toEqual([true, true]);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringMatching(/^Retrieval ledger retention failed and will retry: /),
		);
	});

	it("runs its first pass after the initial delay and stops cleanly", async () => {
		vi.useFakeTimers();
		try {
			insertAttempt(db, "expired", PAST);
			const runner = new LedgerRetentionRunner({ dbPath, logger: logger(), initialDelayMs: 1_000 });
			const runOnce = vi.spyOn(runner, "runOnce");

			runner.start();
			await vi.advanceTimersByTimeAsync(999);
			expect(runOnce).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(runOnce).toHaveBeenCalledTimes(1);
			await runner.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
