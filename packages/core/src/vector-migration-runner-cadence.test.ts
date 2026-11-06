import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as database from "./db.js";
import * as embeddings from "./embeddings.js";
import { getMaintenanceJob, startMaintenanceJob } from "./maintenance-jobs.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { VECTOR_MODEL_MIGRATION_JOB, VectorModelMigrationRunner } from "./vector-migration.js";

vi.mock("./embeddings.js", async () => ({
	...(await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js")),
	getEmbeddingClient: vi.fn(),
	embedTexts: vi.fn(),
	resolveEmbeddingModel: vi.fn(() => "test-model"),
	resolveEmbeddingClientVectorIdentityLabel: vi.fn(() => "test-model"),
	tryResolveEmbeddingRevision: vi.fn(() => "test-revision"),
	tryResolveEmbeddingVectorIdentityLabel: vi.fn(() => "test-model"),
}));

const TEST_CLIENT = {
	model: "test-model",
	dimensions: 384,
	identity: {
		package: "@huggingface/transformers",
		version: "4.2.0",
		model: "test-model",
		revision: "0123456789abcdef0123456789abcdef01234567",
		requestedRevision: "test-revision",
		dtype: "fp32",
		device: "cpu",
		pooling: "mean",
		normalization: "l2",
		dimensions: 384,
	},
	embed: vi.fn(),
} as const;

// Simulated inference time per memory; fake timers make it deterministic.
const EMBED_MS_PER_MEMORY = 500;

let directory: string;
let dbPath: string;
let runner: VectorModelMigrationRunner | null;

function withDb<T>(read: (db: Database.Database) => T): T {
	const db = new Database(dbPath);
	try {
		return read(db);
	} finally {
		db.close();
	}
}

function seedQueuedIncrementalJob(options: {
	memories: number;
	cutoverRetryCount?: number;
	trigger?: string;
}): void {
	withDb((db) => {
		initTestSchema(db);
		const session = insertTestSession(db);
		const now = new Date().toISOString();
		const insert = db.prepare(
			`INSERT INTO memory_items(id, session_id, kind, title, body_text, confidence, tags_text,
			 active, created_at, updated_at, metadata_json, rev, visibility)
			 VALUES (?, ?, 'feature', ?, ?, 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
		);
		const ids = Array.from({ length: options.memories }, (_, index) => index + 1);
		for (const id of ids) insert.run(id, session, `Title ${id}`, `Body ${id}`, now, now);
		// Mirrors the production row: an earlier cutover attempt retried, then
		// incremental sync queued thousands of memories onto the same job.
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			status: "running",
			message: "Target metadata comparison exceeded 2 seconds; retrying",
			metadata: {
				trigger: options.trigger ?? "sync_incremental",
				cutover_retry_count: options.cutoverRetryCount,
				pending_upsert_memory_ids: ids,
				pending_delete_memory_ids: [],
				queue_revision: 1,
			},
		});
	});
}

function pendingUpserts(): number {
	return withDb((db) => {
		const metadata = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata ?? {};
		return (metadata.pending_upsert_memory_ids as number[] | undefined)?.length ?? 0;
	});
}

function startRunner(options: { batchSize: number; tickBudgetMs?: number }): void {
	runner = new VectorModelMigrationRunner({
		dbPath,
		intervalMs: 5_000,
		idleIntervalMs: 60_000,
		...options,
	});
	runner.start();
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
	directory = mkdtempSync(join(tmpdir(), "codemem-vector-cadence-"));
	dbPath = join(directory, "cadence.sqlite");
	runner = null;
	vi.spyOn(database, "connect").mockImplementation(() => new Database(dbPath));
	vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(TEST_CLIENT as never);
	vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
		await new Promise((resolve) => setTimeout(resolve, EMBED_MS_PER_MEMORY * texts.length));
		return texts.map(() => new Float32Array(384));
	});
});

afterEach(async () => {
	const stopping = runner?.stop();
	await vi.runAllTimersAsync();
	await stopping;
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

describe("queued incremental work after a cutover retry", () => {
	it("drains on the active cadence instead of the idle interval", async () => {
		// Arrange: one batch of 2 takes 1 s, then the runner rests 5 s.
		seedQueuedIncrementalJob({ memories: 20, cutoverRetryCount: 4 });
		startRunner({ batchSize: 2 });

		// Act: the idle interval alone would allow only one batch in 20 s.
		await vi.advanceTimersByTimeAsync(20_000);

		// Assert: ticks at 0.1, 6.1, 12.1, and 18.1 s each drained a batch.
		expect(pendingUpserts()).toBe(12);
	});

	it("keeps the idle backoff for a retrying cutover with no queued work", async () => {
		// Arrange
		seedQueuedIncrementalJob({ memories: 0, cutoverRetryCount: 4 });

		// Act
		const idle = withDb(computeIdleOnce);

		// Assert
		expect(idle).toBe(true);
	});

	it("keeps the idle backoff for a bootstrap job, whose passes can still reach cutover", async () => {
		// Arrange: queued work alone skips cutover only for incremental sync jobs.
		seedQueuedIncrementalJob({ memories: 4, cutoverRetryCount: 4, trigger: "sync_bootstrap" });

		// Act
		const idle = withDb(computeIdleOnce);

		// Assert
		expect(idle).toBe(true);
	});
});

function computeIdleOnce(db: Database.Database): boolean {
	const idleRunner = new VectorModelMigrationRunner({ dbPath });
	return (
		idleRunner as unknown as { computeIdle: (db: Database.Database) => boolean }
	).computeIdle.call(idleRunner, db);
}

function jobMessage(): string | null | undefined {
	return withDb((db) => getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.message);
}

describe("a database that stays locked", () => {
	const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

	it("tells the UI it is waiting for the lock after 10 locked ticks", async () => {
		// Arrange: locked ticks run at 0.1, 5.1, 15.1, 35.1 s, then every 30 s.
		seedQueuedIncrementalJob({ memories: 4 });
		vi.mocked(embeddings.getEmbeddingClient).mockRejectedValue(busy());
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		startRunner({ batchSize: 2 });

		// Act: the ninth locked tick is at 185.1 s and the tenth at 215.1 s.
		await vi.advanceTimersByTimeAsync(214_000);
		const afterNine = jobMessage();
		await vi.advanceTimersByTimeAsync(2_000);

		// Assert
		expect(afterNine).toBe("Target metadata comparison exceeded 2 seconds; retrying");
		expect(jobMessage()).toBe("Waiting for the database lock");
		expect(withDb((db) => getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.status)).toBe(
			"running",
		);
	});

	it("starts counting again after a tick succeeds", async () => {
		// Arrange: nine locked ticks, one success, then one more locked tick.
		seedQueuedIncrementalJob({ memories: 20 });
		for (let tick = 0; tick < 9; tick++) {
			vi.mocked(embeddings.getEmbeddingClient).mockRejectedValueOnce(busy());
		}
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		startRunner({ batchSize: 2 });
		// Locked ticks end at 185.1 s; the tick at 215.1 s drains a batch by 216.1 s.
		await vi.advanceTimersByTimeAsync(216_500);
		const afterSuccess = pendingUpserts();
		vi.mocked(embeddings.getEmbeddingClient).mockRejectedValueOnce(busy());

		// Act: the next tick at 221.1 s is locked, but it is the first in a new streak.
		await vi.advanceTimersByTimeAsync(5_000);

		// Assert
		expect(afterSuccess).toBe(18);
		expect(jobMessage()).toMatch(/^Queued vector catch-up has 18 memory change/);
	});

	it("logs the original failure with its stack when recording it hits a lock", async () => {
		// Arrange: inference fails, then the job-failure write loses the lock.
		seedQueuedIncrementalJob({ memories: 4 });
		const failure = new Error("model exploded");
		vi.mocked(embeddings.getEmbeddingClient).mockRejectedValue(failure);
		vi.mocked(database.connect).mockImplementation(() => {
			const db = new Database(dbPath);
			const prepare = db.prepare.bind(db);
			vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
				if (sql.includes("UPDATE maintenance_jobs")) throw busy();
				return prepare(sql);
			});
			return db;
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		startRunner({ batchSize: 2 });

		// Act
		await vi.advanceTimersByTimeAsync(200);

		// Assert
		const [firstMessage, loggedError] = warn.mock.calls[0] ?? [];
		expect(firstMessage).toBe("Vector migration runner failed");
		expect(loggedError).toBe(failure);
		expect(failure.stack).toContain("model exploded");
		expect(String(warn.mock.calls[1]?.[0])).toMatch(
			/database locked \(database is locked\); retrying in 5s/,
		);
	});
});

describe("ticks that hit a locked database", () => {
	it("retry after 5, 10, 20, then 30 s instead of the 60 s idle interval", async () => {
		// Arrange
		seedQueuedIncrementalJob({ memories: 4 });
		const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		startRunner({ batchSize: 2 });
		const attemptTimes: number[] = [];
		const start = Date.now();
		vi.mocked(embeddings.getEmbeddingClient).mockImplementation(async () => {
			attemptTimes.push(Date.now() - start);
			throw busy;
		});

		// Act
		await vi.advanceTimersByTimeAsync(100_000);

		// Assert
		expect(attemptTimes).toEqual([100, 5_100, 15_100, 35_100, 65_100, 95_100]);
	});

	it("leaves the job running so the UI does not report a failure", async () => {
		// Arrange
		seedQueuedIncrementalJob({ memories: 4 });
		const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		vi.mocked(embeddings.getEmbeddingClient).mockRejectedValue(busy);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		startRunner({ batchSize: 2 });

		// Act
		await vi.advanceTimersByTimeAsync(200);

		// Assert
		expect(withDb((db) => getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.status)).toBe(
			"running",
		);
	});

	it("returns to the active cadence once a tick succeeds", async () => {
		// Arrange: the first tick is locked out, later ticks succeed.
		seedQueuedIncrementalJob({ memories: 20 });
		const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		vi.mocked(embeddings.getEmbeddingClient).mockRejectedValueOnce(busy);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		startRunner({ batchSize: 2 });

		// Act: busy at 0.1 s, batches at 5.1-6.1 s and 11.1-12.1 s.
		await vi.advanceTimersByTimeAsync(13_000);

		// Assert
		expect(pendingUpserts()).toBe(16);
	});
});

describe("draining several batches in one tick", () => {
	it("keeps running batches until the tick budget is spent, then rests", async () => {
		// Arrange: each batch of 2 takes 1 s of simulated inference.
		seedQueuedIncrementalJob({ memories: 20 });
		startRunner({ batchSize: 2, tickBudgetMs: 2_500 });

		// Act: batches end at 1.1, 2.1, and 3.1 s. The 3.1 s check is past the
		// budget, so the next tick starts at 8.1 s.
		await vi.advanceTimersByTimeAsync(8_000);

		// Assert
		expect(pendingUpserts()).toBe(14);
		expect(embeddings.embedTexts).toHaveBeenCalledTimes(3);
	});

	it("persists queue progress after every batch, before the next inference starts", async () => {
		// Arrange
		seedQueuedIncrementalJob({ memories: 6 });
		const progress: number[] = [];
		vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
			// A batch only starts after the previous batch's queue update committed.
			progress.push(pendingUpserts());
			await new Promise((resolve) => setTimeout(resolve, EMBED_MS_PER_MEMORY * texts.length));
			return texts.map(() => new Float32Array(384));
		});
		startRunner({ batchSize: 2, tickBudgetMs: 60_000 });

		// Act
		await vi.advanceTimersByTimeAsync(4_000);

		// Assert
		expect(progress).toEqual([6, 4, 2]);
		expect(pendingUpserts()).toBe(0);
	});

	it("stops after the batch in progress when stop() arrives mid-tick", async () => {
		// Arrange: a long budget would otherwise keep draining all 20 memories.
		seedQueuedIncrementalJob({ memories: 20 });
		startRunner({ batchSize: 2, tickBudgetMs: 60_000 });
		await vi.advanceTimersByTimeAsync(600);
		const activeRunner = runner;
		runner = null;

		// Act: stop during the first batch's inference, then let that batch finish.
		let stopped = false;
		const stopping = activeRunner?.stop().then(() => {
			stopped = true;
		});
		await vi.advanceTimersByTimeAsync(2_000);
		await stopping;

		// Assert
		expect(stopped).toBe(true);
		expect(embeddings.embedTexts).toHaveBeenCalledTimes(1);
		expect(pendingUpserts()).toBe(18);
	});

	it("runs one batch per tick without a budget", async () => {
		// Arrange
		seedQueuedIncrementalJob({ memories: 20 });
		startRunner({ batchSize: 2 });

		// Act
		await vi.advanceTimersByTimeAsync(8_000);

		// Assert: batches at 0.1-1.1 s and 6.1-7.1 s.
		expect(pendingUpserts()).toBe(16);
	});
});
