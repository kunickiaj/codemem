import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as database from "./db.js";
import * as embeddings from "./embeddings.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { queueVectorBackfill } from "./vector-backfill-queue.js";
import { VECTOR_MODEL_MIGRATION_JOB, VectorModelMigrationRunner } from "./vector-migration.js";
import { getSemanticIndexDiagnostics } from "./vectors.js";

vi.mock("./embeddings.js", async () => ({
	...(await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js")),
	getEmbeddingClient: vi.fn(),
	embedTexts: vi.fn(),
	resolveEmbeddingModel: vi.fn(() => "test-model"),
	resolveEmbeddingClientVectorIdentityLabel: vi.fn(() => "test-model"),
	tryResolveEmbeddingRevision: vi.fn(() => "test-revision"),
	tryResolveEmbeddingVectorIdentityLabel: vi.fn(() => "test-model"),
}));

/** The embedding runtime; `packageVersion` is what a library upgrade changes. */
function testClient(packageVersion: string) {
	return {
		model: "test-model",
		dimensions: 384,
		identity: {
			package: "@huggingface/transformers",
			version: packageVersion,
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
	};
}

vi.mock("./vector-backfill-queue.js", async () => {
	const actual = await vi.importActual<typeof import("./vector-backfill-queue.js")>(
		"./vector-backfill-queue.js",
	);
	return { ...actual, queueVectorBackfill: vi.fn(actual.queueVectorBackfill) };
});

const GAP_CHECK_MS = 600_000;

let directory: string;
let dbPath: string;
let runner: VectorModelMigrationRunner | null;

function withDb<T>(read: (db: Database.Database) => T): T {
	const db = new Database(dbPath);
	try {
		database.loadSqliteVec(db);
		return read(db);
	} finally {
		db.close();
	}
}

function insertMemories(db: Database.Database, ids: number[]): void {
	const session = insertTestSession(db);
	const now = new Date().toISOString();
	const insert = db.prepare(
		`INSERT INTO memory_items(id, session_id, kind, title, body_text, confidence, tags_text,
		 active, created_at, updated_at, metadata_json, rev, visibility)
		 VALUES (?, ?, 'feature', ?, ?, 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
	);
	for (const id of ids) insert.run(id, session, `Title ${id}`, `Body ${id}`, now, now);
}

function indexedMemoryIds(): number[] {
	return withDb(
		(db) =>
			db
				.prepare("SELECT DISTINCT memory_id FROM memory_vectors ORDER BY memory_id")
				.pluck()
				.all() as number[],
	);
}

function vectorJob() {
	return withDb((db) => getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB));
}

function startRunner(): void {
	runner = new VectorModelMigrationRunner({
		dbPath,
		intervalMs: 5_000,
		idleIntervalMs: 60_000,
		coverageGapCheckIntervalMs: GAP_CHECK_MS,
	});
	runner.start();
}

async function stopRunner(): Promise<void> {
	const stopping = runner?.stop();
	await vi.runAllTimersAsync();
	await stopping;
	runner = null;
}

/** Memories 1-3 queued and indexed the normal way, leaving a completed job. */
async function seedIndexedStore(): Promise<void> {
	withDb((db) => {
		initTestSchema(db);
		insertMemories(db, [1, 2, 3]);
		queueVectorBackfill(db, { upsertMemoryIds: [1, 2, 3], deleteMemoryIds: [] });
	});
	startRunner();
	await vi.advanceTimersByTimeAsync(30_000);
	await stopRunner();
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
	directory = mkdtempSync(join(tmpdir(), "codemem-vector-gap-"));
	dbPath = join(directory, "gap.sqlite");
	runner = null;
	vi.spyOn(database, "connect").mockImplementation(() => new Database(dbPath));
	vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(testClient("4.2.0") as never);
	vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) =>
		texts.map(() => new Float32Array(384)),
	);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
	await stopRunner();
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

describe("vector catch-up for memories without vectors", () => {
	it("indexes active memories whose queued vector work was lost", async () => {
		await seedIndexedStore();
		expect(indexedMemoryIds()).toEqual([1, 2, 3]);
		expect(vectorJob()?.status).toBe("completed");
		// Memory 4 arrives without vector work, and memory 2 loses its vectors.
		withDb((db) => {
			insertMemories(db, [4]);
			db.prepare("DELETE FROM memory_vectors WHERE memory_id = 2").run();
		});
		expect(withDb((db) => getSemanticIndexDiagnostics(db))).toMatchObject({
			state: "pending",
			pending_memory_count: 2,
			summary: "2 memories have no vectors yet; background catch-up adds them",
		});

		startRunner();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(indexedMemoryIds()).toEqual([1, 2, 3, 4]);
		expect(vectorJob()).toMatchObject({ status: "completed" });
		expect(withDb((db) => getSemanticIndexDiagnostics(db)).state).toBe("healthy");
	});

	it("retries on the next tick when the queue write finds the database locked", async () => {
		await seedIndexedStore();
		withDb((db) => insertMemories(db, [4]));
		vi.mocked(queueVectorBackfill).mockImplementationOnce(() => {
			throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		});

		startRunner();
		await vi.advanceTimersByTimeAsync(120_000);

		expect(indexedMemoryIds()).toEqual([1, 2, 3, 4]);
	});

	it("checks for missing vectors at most once per interval", async () => {
		await seedIndexedStore();
		startRunner();
		await vi.advanceTimersByTimeAsync(30_000);
		withDb((db) => insertMemories(db, [4]));

		await vi.advanceTimersByTimeAsync(GAP_CHECK_MS / 2);
		const beforeNextCheck = indexedMemoryIds();
		await vi.advanceTimersByTimeAsync(GAP_CHECK_MS);

		expect(beforeNextCheck).toEqual([1, 2, 3]);
		expect(indexedMemoryIds()).toEqual([1, 2, 3, 4]);
	});

	it("queues nothing after an upgrade that leaves the embedding model unchanged", async () => {
		await seedIndexedStore();
		const before = vectorJob();
		vi.mocked(embeddings.embedTexts).mockClear();
		// A new release restarts the runner with a newer embedding library version.
		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(testClient("4.3.0") as never);

		startRunner();
		await vi.advanceTimersByTimeAsync(GAP_CHECK_MS * 2);

		const after = vectorJob();
		expect(after?.status).toBe("completed");
		expect(after?.metadata?.job_generation).toBe(before?.metadata?.job_generation);
		expect(after?.started_at).toBe(before?.started_at);
		expect(embeddings.embedTexts).not.toHaveBeenCalled();
		expect(withDb((db) => getSemanticIndexDiagnostics(db)).state).toBe("healthy");
	});

	it("says a new memory's queued vectors are not a re-index", () => {
		withDb((db) => {
			initTestSchema(db);
			insertMemories(db, [1]);
			queueVectorBackfill(db, { upsertMemoryIds: [1], deleteMemoryIds: [] });
		});

		expect(vectorJob()).toMatchObject({
			title: "Indexing memories",
			message: "Queued vectors for new or changed memories",
		});
	});
});
