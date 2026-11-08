import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as database from "./db.js";
import * as embeddings from "./embeddings.js";
import {
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { queueVectorBackfill } from "./vector-backfill-queue.js";
import {
	runVectorMigrationPass,
	VECTOR_MODEL_MIGRATION_JOB,
	VectorModelMigrationRunner,
} from "./vector-migration.js";

vi.mock("./embeddings.js", async () => ({
	...(await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js")),
	getEmbeddingClient: vi.fn(),
}));

let db: Database.Database;
let runner: VectorModelMigrationRunner;

function job() {
	return getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
}

function replaceJob() {
	return startMaintenanceJob(db, {
		kind: VECTOR_MODEL_MIGRATION_JOB,
		title: "Replacement migration",
		status: "pending",
		message: "Replacement owns the queued changes",
		progressTotal: 19,
		metadata: {
			job_generation: 2,
			pending_upsert_memory_ids: [19],
			pending_delete_memory_ids: [20],
			queue_revision: 8,
		},
	});
}

function failNextJobRead(error: Error): () => boolean {
	const prepare = db.prepare.bind(db);
	let injected = false;
	vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
		if (!injected && sql === "SELECT * FROM maintenance_jobs WHERE kind = ?") {
			injected = true;
			throw error;
		}
		return prepare(sql);
	});
	return () => injected;
}

async function tick(): Promise<void> {
	// Exercise the public timer API rather than private failure bookkeeping.
	runner.start();
	await vi.advanceTimersByTimeAsync(100);
	await runner.stop();
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	vi.mocked(embeddings.getEmbeddingClient).mockReset();
	vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(null);
	db = new Database(":memory:");
	startMaintenanceJob(db, {
		kind: VECTOR_MODEL_MIGRATION_JOB,
		title: "Original migration",
		status: "running",
		message: "Original work",
		progressTotal: 3,
		metadata: { job_generation: 1, pending_upsert_memory_ids: [1, 2, 3], queue_revision: 1 },
	});
	vi.spyOn(database, "connect").mockReturnValue(db);
	vi.spyOn(database, "loadSqliteVec").mockImplementation(() => undefined);
	vi.spyOn(database, "isEmbeddingDisabled").mockReturnValue(false);
	// Keep the synthetic connection available to inspect durable state after stop().
	vi.spyOn(db, "close").mockReturnValue(db);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	runner = new VectorModelMigrationRunner({ dbPath: ":memory:" });
});

afterEach(async () => {
	await runner.stop();
	vi.restoreAllMocks();
	db.close();
	vi.useRealTimers();
});

describe("migration runner failure reporting outside the pass", () => {
	it.each(["pending", "running"] as const)(
		"records an extension load error on the unchanged %s owner",
		async (status) => {
			// Arrange: native loading fails before the migration pass starts.
			updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, { status });
			const original = job();
			vi.mocked(database.loadSqliteVec).mockImplementation(() => {
				throw new Error("synthetic native extension failure");
			});

			// Act
			await tick();

			// Assert: retain queued work while making the operational error visible.
			expect(job()).toMatchObject({
				status: "failed",
				error: "synthetic native extension failure",
				metadata: original?.metadata,
				progress: original?.progress,
			});
			expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
		},
	);

	it("preserves a replacement committed during extension loading", async () => {
		// Arrange: both jobs have the same timestamp, so generation identifies the owner.
		let replacement: ReturnType<typeof job> = null;
		vi.mocked(database.loadSqliteVec).mockImplementation(() => {
			replacement = replaceJob();
			throw new Error("old owner's extension failed");
		});

		// Act
		await tick();

		// Assert
		expect(replacement).not.toBeNull();
		expect(job()).toEqual(replacement);
	});

	it("leaves a cancelled owner unchanged when extension loading fails", async () => {
		// Arrange
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, { status: "cancelled" });
		const cancelled = job();
		vi.mocked(database.loadSqliteVec).mockImplementation(() => {
			throw new Error("extension failed after cancellation");
		});

		// Act
		await tick();

		// Assert
		expect(job()).toEqual(cancelled);
	});

	it("leaves an unchanged owner running after transient extension lock contention", async () => {
		// Arrange
		const original = job();
		vi.mocked(database.loadSqliteVec).mockImplementation(() => {
			throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		});

		// Act
		await tick();

		// Assert
		expect(job()).toEqual(original);
	});

	it("reports a recoverable preparation read failure on the unchanged owner", async () => {
		// Arrange: job reads work again after the single preparation failure.
		let injected = () => false;
		vi.mocked(database.loadSqliteVec).mockImplementation(() => {
			injected = failNextJobRead(new Error("synthetic preparation read failure"));
		});

		// Act
		await tick();

		// Assert
		expect(injected()).toBe(true);
		expect(job()).toMatchObject({
			status: "failed",
			error: "synthetic preparation read failure",
			metadata: { job_generation: 1, pending_upsert_memory_ids: [1, 2, 3] },
		});
	});

	it("reports an idle computation read failure after a successful pass", async () => {
		// Arrange: a null client ends the pass before the idle status read.
		let injected = () => false;
		vi.mocked(embeddings.getEmbeddingClient).mockImplementation(async () => {
			injected = failNextJobRead(new Error("synthetic idle read failure"));
			return null;
		});

		// Act
		await tick();

		// Assert
		expect(injected()).toBe(true);
		expect(job()).toMatchObject({ status: "failed", error: "synthetic idle read failure" });
	});

	it("preserves a replacement when the old tick's idle computation fails", async () => {
		// Arrange
		let replacement: ReturnType<typeof job> = null;
		let injected = () => false;
		vi.mocked(embeddings.getEmbeddingClient).mockImplementation(async () => {
			replacement = replaceJob();
			injected = failNextJobRead(new Error("old tick's idle read failed"));
			return null;
		});

		// Act
		await tick();

		// Assert
		expect(injected()).toBe(true);
		expect(replacement).not.toBeNull();
		expect(job()).toEqual(replacement);
	});

	it("still reports an operational failure inside the migration pass", async () => {
		// Arrange
		vi.mocked(embeddings.getEmbeddingClient).mockRejectedValue(
			new Error("synthetic model failure"),
		);

		// Act
		await tick();

		// Assert
		expect(job()).toMatchObject({
			status: "failed",
			error: "synthetic model failure",
			metadata: { job_generation: 1, pending_upsert_memory_ids: [1, 2, 3] },
		});
	});

	it("preserves a replacement when the old migration pass fails", async () => {
		// Arrange
		let replacement: ReturnType<typeof job> = null;
		vi.mocked(embeddings.getEmbeddingClient).mockImplementation(async () => {
			replacement = replaceJob();
			throw new Error("old model failed");
		});

		// Act
		await tick();

		// Assert
		expect(replacement).not.toBeNull();
		expect(job()).toEqual(replacement);
	});
});

it.each([false, true])(
	"preserves concurrent queue intent before empty-source completion (new memory: %s)",
	async (addMemory) => {
		// Arrange: the unlocked count sees an empty corpus before another WAL writer queues work.
		vi.mocked(database.loadSqliteVec).mockRestore();
		const directory = mkdtempSync(join(tmpdir(), "codemem-empty-source-queue-"));
		const path = join(directory, "queue.sqlite");
		const migrationDb = new Database(path);
		let writer: Database.Database | undefined;
		try {
			initTestSchema(migrationDb);
			migrationDb.pragma("journal_mode = WAL");
			writer = new Database(path, { timeout: 0 });
			migrationDb
				.prepare(`INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
					VALUES (?, 99, 0, 'old-content', 'old-model')`)
				.run(new Float32Array(384));
			startMaintenanceJob(migrationDb, {
				kind: VECTOR_MODEL_MIGRATION_JOB,
				title: "Original empty migration",
				metadata: { job_generation: 1, trigger: "sync_bootstrap", target_model: "test-model" },
			});
			vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue({
				model: "test-model",
				dimensions: 384,
				identity: { requestedRevision: "test-revision" },
			} as never);
			vi.spyOn(embeddings, "resolveEmbeddingClientVectorIdentityLabel").mockReturnValue(
				"test-model",
			);
			const prepare = migrationDb.prepare.bind(migrationDb);
			let queued: ReturnType<typeof getMaintenanceJob> = null;
			let injected = false;
			let countInTransaction: boolean | undefined;
			vi.spyOn(migrationDb, "prepare").mockImplementation((sql: string) => {
				const statement = prepare(sql);
				if (!sql.includes("SELECT COUNT(*) AS c FROM memory_items")) return statement;
				const get = statement.get.bind(statement);
				statement.get = ((...params: unknown[]) => {
					const count = get(...params);
					if (injected || !writer) return count;
					injected = true;
					countInTransaction = migrationDb.inTransaction;
					if (addMemory) {
						const session = insertTestSession(writer);
						writer
							.prepare(`INSERT INTO memory_items(id, session_id, kind, title, body_text,
							confidence, tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
							VALUES (71, ?, 'feature', 'New memory', 'New body', 0.5, '', 1,
							'2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{}', 1, 'shared')`)
							.run(session);
					}
					queueVectorBackfill(writer, { upsertMemoryIds: [71], deleteMemoryIds: [72] });
					queued = getMaintenanceJob(writer, VECTOR_MODEL_MIGRATION_JOB);
					return count;
				}) as typeof statement.get;
				return statement;
			});

			// Act
			await runVectorMigrationPass(migrationDb);

			// Assert: completion must merge the latest queue, or defer if the corpus is no longer empty.
			expect(injected).toBe(true);
			expect(countInTransaction).toBe(false);
			expect(queued).not.toBeNull();
			const latest = getMaintenanceJob(migrationDb, VECTOR_MODEL_MIGRATION_JOB);
			expect(latest?.metadata).toMatchObject({
				pending_upsert_memory_ids: [71],
				pending_delete_memory_ids: [72],
				queue_revision: queued?.metadata?.queue_revision,
			});
			if (addMemory) {
				expect(latest).toEqual(queued);
				expect(migrationDb.prepare("SELECT model FROM memory_vectors").all()).toEqual([
					{ model: "old-model" },
				]);
			} else {
				expect(latest?.status).toBe("completed");
			}
		} finally {
			writer?.close();
			migrationDb.close();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
