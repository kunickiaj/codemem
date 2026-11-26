import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import type { RetentionLogger } from "./periodic-retention.js";
import {
	runSyncAttemptRetentionPass,
	SYNC_ATTEMPT_RECENT_OVERALL,
	SYNC_ATTEMPT_RECENT_PER_PEER,
	SyncAttemptRetentionRunner,
} from "./sync-attempt-retention.js";

type Db = ReturnType<typeof connect>;

const NOW = "2026-11-01T00:00:00.000Z";
const DAY = 86_400_000;

let dir: string;
let dbPath: string;
let db: Db;

interface AttemptInput {
	peer: string;
	daysAgo: number;
	ok?: boolean;
	category?: string | null;
	finished?: boolean;
}

/** Inserts an attempt and returns its id. Later inserts at the same time sort after it. */
function insertAttempt(target: Db, input: AttemptInput): number {
	const at = new Date(Date.parse(NOW) - input.daysAgo * DAY).toISOString();
	const ok = input.ok ?? true;
	return Number(
		target
			.prepare(
				`INSERT INTO sync_attempts(peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error, failure_category)
				 VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
			)
			.run(
				input.peer,
				at,
				input.finished === false ? null : at,
				ok ? 1 : 0,
				ok ? null : "connection refused",
				ok ? null : (input.category ?? "connectivity"),
			).lastInsertRowid,
	);
}

/** `count` old attempts for one peer, oldest first, between `fromDays` and `toDays` ago. */
function insertSeries(
	target: Db,
	peer: string,
	count: number,
	fromDays: number,
	toDays: number,
	extra: Omit<AttemptInput, "peer" | "daysAgo"> = {},
): number[] {
	const step = (fromDays - toDays) / Math.max(count - 1, 1);
	return Array.from({ length: count }, (_, index) =>
		insertAttempt(target, { peer, daysAgo: fromDays - index * step, ...extra }),
	);
}

/**
 * Fills the attempt list's newest rows with recent attempts from another peer, so the rule
 * that keeps the newest rows across all peers does not also keep a test's old rows.
 */
function fillRecent(target: Db = db, nowMs = Date.parse(NOW)): void {
	const insert = target.prepare(
		`INSERT INTO sync_attempts(peer_device_id, started_at, finished_at, ok, ops_in, ops_out)
		 VALUES ('filler-peer', ?, ?, 1, 0, 0)`,
	);
	for (let index = 0; index < SYNC_ATTEMPT_RECENT_OVERALL; index++) {
		const at = new Date(nowMs - DAY + index * 1_000).toISOString();
		insert.run(at, at);
	}
}

/** Attempt ids, leaving out the filler peer's. */
function ids(target: Db = db): number[] {
	return target
		.prepare("SELECT id FROM sync_attempts WHERE peer_device_id <> 'filler-peer' ORDER BY id")
		.pluck()
		.all() as number[];
}

function steppingClock(stepMs: number): () => number {
	let now = 0;
	return () => {
		now += stepMs;
		return now;
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-sync-attempt-retention-"));
	dbPath = join(dir, "mem.sqlite");
	db = connect(dbPath);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("runSyncAttemptRetentionPass", () => {
	it("keeps the last 7 days and each peer's newest attempts, and removes the rest", async () => {
		fillRecent();
		// Arrange: 30 old successes, then 3 within the window.
		const old = insertSeries(db, "peer-a", 30, 40, 10);
		const recent = insertSeries(db, "peer-a", 3, 6, 1);

		// Act
		const result = await runSyncAttemptRetentionPass(db, { now: NOW });

		// Assert: 10 newest per peer are recent + the 7 newest old ones.
		const kept = old.slice(-(SYNC_ATTEMPT_RECENT_PER_PEER - recent.length));
		expect(ids()).toEqual([...kept, ...recent]);
		expect(result).toMatchObject({ syncAttemptsPurged: 30 - kept.length, complete: true });
	});

	it("keeps everything from the last 7 days even when it is far more than the per-peer rows", async () => {
		fillRecent();
		const recent = insertSeries(db, "peer-a", 40, 6.9, 0.1);
		insertSeries(db, "peer-a", 5, 30, 20);

		await runSyncAttemptRetentionPass(db, { now: NOW });

		expect(ids()).toEqual(recent);
	});

	it("keeps each peer's latest success and latest failure of every category, however old", async () => {
		fillRecent();
		// Arrange: one success and one trust failure long ago, then many connectivity failures.
		const success = insertAttempt(db, { peer: "peer-a", daysAgo: 60 });
		const trust = insertAttempt(db, { peer: "peer-a", daysAgo: 50, ok: false, category: "trust" });
		insertSeries(db, "peer-a", 20, 40, 30, { ok: false, category: "connectivity" });
		const newest = insertSeries(db, "peer-a", 10, 9, 8, { ok: false, category: "connectivity" });

		// Act
		await runSyncAttemptRetentionPass(db, { now: NOW });

		// Assert
		expect(ids()).toEqual([success, trust, ...newest]);
	});

	it("keeps a removed peer's latest attempts under the same rule instead of removing them all", async () => {
		fillRecent();
		// Arrange: no sync_peers row exists for this peer.
		insertSeries(db, "removed-peer", 15, 90, 60);
		const failure = insertAttempt(db, { peer: "removed-peer", daysAgo: 59, ok: false });

		// Act
		await runSyncAttemptRetentionPass(db, { now: NOW });

		// Assert: the 10 newest, which include its latest failure and latest success.
		const kept = ids();
		expect(kept).toHaveLength(SYNC_ATTEMPT_RECENT_PER_PEER);
		expect(kept).toContain(failure);
	});

	it("keeps the newest attempts across all peers that the attempt list can show", async () => {
		// Arrange: more old attempts than the list's maximum, all from one peer.
		const old = insertSeries(db, "peer-a", SYNC_ATTEMPT_RECENT_OVERALL + 50, 30, 8);

		// Act
		await runSyncAttemptRetentionPass(db, { now: NOW });

		// Assert
		expect(ids()).toEqual(old.slice(-SYNC_ATTEMPT_RECENT_OVERALL));
	});

	it("never removes attempts without a finish time", async () => {
		fillRecent();
		const unfinished = insertSeries(db, "peer-a", 15, 60, 40, { finished: false });
		insertSeries(db, "peer-a", 10, 2, 1);

		await runSyncAttemptRetentionPass(db, { now: NOW });

		expect(ids().slice(0, unfinished.length)).toEqual(unfinished);
	});
});

describe("runSyncAttemptRetentionPass batches and budget", () => {
	it("works through a backlog in batches of the configured size", async () => {
		insertSeries(db, "peer-a", SYNC_ATTEMPT_RECENT_OVERALL + 25, 40, 30);

		const result = await runSyncAttemptRetentionPass(db, { now: NOW, batchSize: 10 });

		expect(result).toMatchObject({ syncAttemptsPurged: 25, batches: 3, complete: true });
	});

	it("stops at its runtime budget and leaves the remainder to later passes", async () => {
		// Arrange
		insertSeries(db, "peer-a", SYNC_ATTEMPT_RECENT_OVERALL + 25, 40, 30);

		// Act: after the batch that always runs, the clock passes the 10 ms budget after one more.
		const first = await runSyncAttemptRetentionPass(db, {
			now: NOW,
			batchSize: 10,
			maxRuntimeMs: 10,
			clock: steppingClock(6),
		});

		// Assert
		expect(first).toMatchObject({ syncAttemptsPurged: 20, batches: 2, complete: false });
		const second = await runSyncAttemptRetentionPass(db, { now: NOW, batchSize: 10 });
		expect(second).toMatchObject({ syncAttemptsPurged: 5, complete: true });
		expect(ids()).toHaveLength(SYNC_ATTEMPT_RECENT_OVERALL);
	});

	it("deletes one batch even when the budget is spent, and later passes remove the rest", async () => {
		// Arrange: 25 removable rows; the budget is already spent once the kept rows are found.
		insertSeries(db, "peer-a", SYNC_ATTEMPT_RECENT_OVERALL + 25, 40, 30);

		// Act
		const spent = await runSyncAttemptRetentionPass(db, {
			now: NOW,
			batchSize: 10,
			maxRuntimeMs: 0,
		});
		const later = [
			await runSyncAttemptRetentionPass(db, { now: NOW, batchSize: 10, maxRuntimeMs: 0 }),
			await runSyncAttemptRetentionPass(db, { now: NOW, batchSize: 10, maxRuntimeMs: 0 }),
		];

		// Assert
		expect(spent).toMatchObject({ syncAttemptsPurged: 10, batches: 1, complete: false });
		expect(later.map((result) => result.syncAttemptsPurged)).toEqual([10, 5]);
		expect(later[1]?.complete).toBe(true);
		expect(ids()).toHaveLength(SYNC_ATTEMPT_RECENT_OVERALL);
	});

	it("reads only through indexes, so a pass costs the same on a large table", async () => {
		// Arrange: record every statement a pass prepares.
		insertSeries(db, "peer-a", 30, 40, 10, { ok: false, category: "trust" });
		insertSeries(db, "peer-b", 30, 40, 10);
		const statements: string[] = [];
		const prepare = db.prepare.bind(db);
		vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			statements.push(sql);
			return prepare(sql);
		});

		// Act
		await runSyncAttemptRetentionPass(db, { now: NOW });
		vi.mocked(db.prepare).mockRestore();

		// Assert: each read of sync_attempts seeks an index, or walks one under a LIMIT.
		db.exec("CREATE TEMP TABLE sync_attempt_retention_keep (id INTEGER PRIMARY KEY)");
		const reads = statements.filter((sql) => /FROM sync_attempts/.test(sql));
		expect(reads.length).toBeGreaterThan(4);
		for (const sql of reads) {
			const params = Array.from(sql.matchAll(/\?/g), () => "x");
			const plan = (
				db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>
			)
				.map((row) => row.detail)
				.filter((detail) => /\bsync_attempts\b/.test(detail));
			for (const detail of plan) {
				const bounded =
					/^SEARCH /.test(detail) || (/USING .*INDEX/.test(detail) && /LIMIT/.test(sql));
				expect(bounded, `${detail}\n${sql}`).toBe(true);
			}
		}
	});

	it("does no work once the signal is aborted", async () => {
		insertSeries(db, "peer-a", 20, 40, 30);
		const abort = new AbortController();
		abort.abort();

		const result = await runSyncAttemptRetentionPass(db, { now: NOW, signal: abort.signal });

		expect(result).toMatchObject({ syncAttemptsPurged: 0, batches: 0, complete: false });
		expect(ids()).toHaveLength(20);
	});

	it("runs alongside a second process's pass without errors or double counting", async () => {
		// Arrange: a second connection stands in for another process on the same file.
		insertSeries(db, "peer-a", SYNC_ATTEMPT_RECENT_OVERALL + 40, 40, 30);
		const other = connect(dbPath);
		try {
			// Act
			const results = await Promise.all([
				runSyncAttemptRetentionPass(db, { now: NOW, batchSize: 3 }),
				runSyncAttemptRetentionPass(other, { now: NOW, batchSize: 3 }),
			]);

			// Assert
			const purged = results.reduce((sum, result) => sum + result.syncAttemptsPurged, 0);
			expect(purged).toBe(40);
			expect(results.every((result) => result.complete)).toBe(true);
			expect(ids(other)).toHaveLength(SYNC_ATTEMPT_RECENT_OVERALL);
		} finally {
			other.close();
		}
	});

	it("rejects a batch size that is not a positive integer", async () => {
		for (const batchSize of [0, -1, 1.5, Number.NaN]) {
			await expect(runSyncAttemptRetentionPass(db, { now: NOW, batchSize })).rejects.toThrow(
				/batch size/,
			);
		}
	});
});

describe("SyncAttemptRetentionRunner", () => {
	const logger = (): RetentionLogger => ({ step: vi.fn(), warn: vi.fn() });

	it("logs how many rows a pass purged, and nothing when there was nothing to purge", async () => {
		// Arrange: attempts dated relative to the real clock, which the runner uses.
		const offset = (Date.now() - Date.parse(NOW)) / DAY;
		insertSeries(db, "peer-a", 12, 40 - offset, 30 - offset);
		fillRecent(db, Date.now());
		const log = logger();
		const runner = new SyncAttemptRetentionRunner({ dbPath, logger: log });

		// Act
		const first = await runner.runOnce();
		const second = await runner.runOnce();

		// Assert
		expect([first, second]).toEqual([false, false]);
		expect(log.step).toHaveBeenCalledTimes(1);
		expect(log.step).toHaveBeenCalledWith(
			expect.stringMatching(/^Sync attempt retention purged 2 attempts in \d+ ms$/),
		);
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("asks for another pass soon while old rows remain", async () => {
		insertSeries(db, "peer-a", 12, 400, 300);
		fillRecent(db, Date.now());
		const runner = new SyncAttemptRetentionRunner({
			dbPath,
			logger: logger(),
			pass: { batchSize: 1, maxRuntimeMs: 0 },
		});

		expect(await runner.runOnce()).toBe(true);
		expect(ids()).toHaveLength(11);
	});

	it("contains a failing pass, logs it once per failure streak and retries", async () => {
		// Arrange: the database path is a directory, so opening it fails.
		const log = logger();
		const runner = new SyncAttemptRetentionRunner({ dbPath: dir, logger: log });

		// Act
		const results = [await runner.runOnce(), await runner.runOnce()];

		// Assert
		expect(results).toEqual([true, true]);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringMatching(/^Sync attempt retention failed and will retry: /),
		);
	});
});
