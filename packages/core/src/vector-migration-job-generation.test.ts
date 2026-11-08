import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as embeddings from "./embeddings.js";
import { getMaintenanceJob, updateMaintenanceJob } from "./maintenance-jobs.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { queueVectorBackfill } from "./vector-backfill-queue.js";
import {
	queueVectorBackfillForSyncBootstrap,
	runVectorMigrationPass,
	VECTOR_MODEL_MIGRATION_JOB,
} from "./vector-migration.js";
import { findMemoryIdsWithCompleteActiveVectorCoverage } from "./vectors.js";

vi.mock("./embeddings.js", async () => {
	const actual = await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js");
	return {
		...actual,
		getEmbeddingClient: vi.fn(),
		embedTexts: vi.fn(),
		resolveEmbeddingClientVectorIdentityLabel: vi.fn(() => "test-model"),
		tryResolveEmbeddingVectorIdentityLabel: vi.fn(() => "test-model"),
	};
});

const client: embeddings.EmbeddingClient = {
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
};

let db: Database;
let writer: Database;
let directory: string;
let sessionId: number;

function seedMemory(connection: Database, id: number): void {
	connection
		.prepare(
			`INSERT INTO memory_items(id, session_id, kind, title, body_text, confidence,
		 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
		 VALUES (?, ?, 'feature', ?, 'Synthetic body', 0.5, '', 1,
		 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{}', 1, 'shared')`,
		)
		.run(id, sessionId, `Memory ${id}`);
}

function job(connection = db) {
	return getMaintenanceJob(connection, VECTOR_MODEL_MIGRATION_JOB);
}

function generation(): number {
	return Number(job()?.metadata?.job_generation ?? 0);
}

function replaceDuringEmbedding(action: () => void) {
	const snapshots: ReturnType<typeof job>[] = [];
	vi.mocked(embeddings.embedTexts).mockImplementationOnce(async (texts) => {
		action();
		snapshots.push(job(writer));
		return texts.map(() => new Float32Array(384));
	});
	return snapshots;
}

async function finishCurrentJob(): Promise<void> {
	for (let pass = 0; pass < 12; pass++) {
		await runVectorMigrationPass(db, { batchSize: 2 });
		if (job()?.status === "completed") return;
	}
	expect(job()?.status).toBe("completed");
}

beforeEach(() => {
	vi.resetAllMocks();
	// Freeze only Date so two distinct jobs share timestamps without blocking SQLite yields.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	directory = mkdtempSync(join(tmpdir(), "codemem-vector-generation-"));
	const path = join(directory, "jobs.sqlite");
	db = new Database(path);
	db.pragma("journal_mode = WAL");
	db.pragma("busy_timeout = 0");
	initTestSchema(db);
	writer = new Database(path);
	writer.pragma("busy_timeout = 0");
	sessionId = insertTestSession(db);
	vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(client);
	vi.mocked(embeddings.resolveEmbeddingClientVectorIdentityLabel).mockReturnValue("test-model");
	vi.mocked(embeddings.tryResolveEmbeddingVectorIdentityLabel).mockReturnValue("test-model");
	vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) =>
		texts.map(() => new Float32Array(384)),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	writer.close();
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("vector migration job generation fences replacement", () => {
	it("keeps a same-clock bootstrap replacement pending when an incremental drain returns", async () => {
		// Arrange
		seedMemory(db, 1);
		queueVectorBackfill(db, { upsertMemoryIds: [1], deleteMemoryIds: [9] });
		const original = job();
		const replacements = replaceDuringEmbedding(() => {
			seedMemory(writer, 2);
			seedMemory(writer, 3);
			queueVectorBackfillForSyncBootstrap(writer);
		});

		// Act
		await runVectorMigrationPass(db, { batchSize: 1 });

		// Assert: the old pass cannot finalize the replacement or skip its imported rows.
		expect(replacements).toHaveLength(1);
		expect(replacements[0]?.started_at).toBe(original?.started_at);
		expect(job()).toEqual(replacements[0]);
		expect(findMemoryIdsWithCompleteActiveVectorCoverage(db, [2, 3], "test-model")).toEqual([]);
		await finishCurrentJob();
		expect(findMemoryIdsWithCompleteActiveVectorCoverage(db, [1, 2, 3], "test-model")).toEqual([
			1, 2, 3,
		]);
	});

	it.each([1, 10])(
		"preserves same-clock bootstrap replacement after a migration batch of size %s",
		async (batchSize) => {
			// Arrange: resume above ID 1, then edit that already scanned memory during inference.
			for (const id of [1, 2, 3]) seedMemory(db, id);
			queueVectorBackfillForSyncBootstrap(db);
			await runVectorMigrationPass(db, { batchSize: 1 });
			expect(job()?.metadata?.last_cursor_id).toBe(1);
			const original = job();
			const replacements = replaceDuringEmbedding(() => {
				writer
					.prepare("UPDATE memory_items SET body_text = 'Changed below cursor' WHERE id = 1")
					.run();
				queueVectorBackfillForSyncBootstrap(writer);
			});

			// Act
			await runVectorMigrationPass(db, { batchSize });

			// Assert: neither a full batch nor final cutover may advance the replacement cursor.
			expect(replacements).toHaveLength(1);
			expect(replacements[0]?.started_at).toBe(original?.started_at);
			expect(job()).toEqual(replacements[0]);
			await finishCurrentJob();
			expect(findMemoryIdsWithCompleteActiveVectorCoverage(db, [1, 2, 3], "test-model")).toEqual([
				1, 2, 3,
			]);
		},
	);

	it.each([false, true])(
		"lets mid-flight cancellation win with local repair policy %s",
		async (localRepair) => {
			// Arrange
			seedMemory(db, 1);
			queueVectorBackfill(db, { upsertMemoryIds: [1], deleteMemoryIds: [] });
			const cancellations = replaceDuringEmbedding(() => {
				updateMaintenanceJob(writer, VECTOR_MODEL_MIGRATION_JOB, {
					status: "cancelled",
					metadata: {
						...job(writer)?.metadata,
						local_repair_preserves_migration_state: localRepair || undefined,
					},
				});
			});

			// Act
			await runVectorMigrationPass(db, { batchSize: 1 });

			// Assert: cancellation's status, completion time, and queued work belong to the latest writer.
			expect(cancellations).toHaveLength(1);
			expect(cancellations[0]?.finished_at).not.toBeNull();
			expect(job()).toEqual(cancellations[0]);
		},
	);

	it.each(["same generation", "replacement"])(
		"does not acknowledge another target in %s",
		async (change) => {
			// Arrange
			seedMemory(db, 1);
			queueVectorBackfill(db, { upsertMemoryIds: [1], deleteMemoryIds: [] });
			const replacements = replaceDuringEmbedding(() => {
				if (change === "replacement") queueVectorBackfillForSyncBootstrap(writer);
				updateMaintenanceJob(writer, VECTOR_MODEL_MIGRATION_JOB, {
					metadata: { ...job(writer)?.metadata, target_model: "different-target" },
				});
			});

			// Act
			await runVectorMigrationPass(db, { batchSize: 1 });

			// Assert
			expect(replacements).toHaveLength(1);
			expect(job()).toEqual(replacements[0]);
			expect(job()?.metadata?.pending_upsert_memory_ids).toEqual([1]);
		},
	);

	it.each(["available", "unavailable"])(
		"preserves a bootstrap scheduled during %s client setup",
		async (availability) => {
			// Arrange: the owner at pass entry is the absence of a job.
			seedMemory(db, 1);
			const replacements: ReturnType<typeof job>[] = [];
			vi.mocked(embeddings.getEmbeddingClient).mockImplementationOnce(async () => {
				queueVectorBackfillForSyncBootstrap(writer);
				replacements.push(job(writer));
				return availability === "available" ? client : null;
			});

			// Act
			await runVectorMigrationPass(db);

			// Assert
			expect(replacements).toHaveLength(1);
			expect(job()).toEqual(replacements[0]);
			expect(embeddings.embedTexts).not.toHaveBeenCalled();
		},
	);
});

describe("client setup keeps the owner captured before awaiting", () => {
	it.each(["available", "unavailable"])(
		"does not update a replacement when an existing owner's client becomes %s",
		async (availability) => {
			// Arrange
			seedMemory(db, 1);
			queueVectorBackfillForSyncBootstrap(db);
			const original = job();
			const replacements: ReturnType<typeof job>[] = [];
			vi.mocked(embeddings.getEmbeddingClient).mockImplementationOnce(async () => {
				queueVectorBackfillForSyncBootstrap(writer);
				replacements.push(job(writer));
				return availability === "available" ? client : null;
			});

			// Act
			await runVectorMigrationPass(db);

			// Assert: unavailable-client handling must not mark the replacement failed.
			expect(replacements).toHaveLength(1);
			expect(replacements[0]?.started_at).toBe(original?.started_at);
			expect(job()).toEqual(replacements[0]);
			expect(embeddings.embedTexts).not.toHaveBeenCalled();
		},
	);
});

describe("vector job generation advances only for replacements", () => {
	it("keeps one generation across enqueues while incrementing queue revision and retaining IDs", () => {
		// Arrange
		queueVectorBackfill(db, { upsertMemoryIds: [1], deleteMemoryIds: [9] });
		const initial = generation();
		const revision = Number(job()?.metadata?.queue_revision);

		// Act
		queueVectorBackfill(writer, { upsertMemoryIds: [2], deleteMemoryIds: [8] });

		// Assert
		expect(initial).toBeGreaterThan(0);
		expect(generation()).toBe(initial);
		expect(job()?.metadata).toMatchObject({
			queue_revision: revision + 1,
			pending_upsert_memory_ids: [1, 2],
			pending_delete_memory_ids: [9, 8],
		});
	});

	it("uses a new generation when a completed job's queue revision is reused for changed text", async () => {
		// Arrange
		seedMemory(db, 1);
		queueVectorBackfill(db, { upsertMemoryIds: [1], deleteMemoryIds: [] });
		await finishCurrentJob();
		const initial = generation();
		const oldHash = db
			.prepare("SELECT content_hash FROM memory_vectors WHERE memory_id = 1")
			.pluck()
			.get();
		writer
			.prepare("UPDATE memory_items SET body_text = 'Changed after completion' WHERE id = 1")
			.run();

		// Act
		queueVectorBackfill(writer, { upsertMemoryIds: [1], deleteMemoryIds: [] });
		const replacement = job();
		await finishCurrentJob();

		// Assert
		expect(replacement?.metadata?.queue_revision).toBe(1);
		expect(replacement?.metadata?.job_generation).toBe(initial + 1);
		expect(generation()).toBe(initial + 1);
		expect(findMemoryIdsWithCompleteActiveVectorCoverage(db, [1], "test-model")).toEqual([1]);
		expect(
			db.prepare("SELECT content_hash FROM memory_vectors WHERE memory_id = 1").pluck().get(),
		).not.toBe(oldHash);
	});

	it("increments generation for every explicit bootstrap replacement under the same clock", () => {
		// Arrange
		queueVectorBackfillForSyncBootstrap(db);
		const original = job();
		const initial = generation();

		// Act
		queueVectorBackfillForSyncBootstrap(writer);
		queueVectorBackfillForSyncBootstrap(writer);

		// Assert
		expect(job()?.started_at).toBe(original?.started_at);
		expect(generation()).toBe(initial + 2);
	});

	it("retains generation when a failed job receives ordinary repair work", () => {
		// Arrange
		queueVectorBackfill(db, { upsertMemoryIds: [1], deleteMemoryIds: [] });
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, { status: "failed" });
		const initial = generation();

		// Act
		queueVectorBackfill(writer, { upsertMemoryIds: [2], deleteMemoryIds: [] });

		// Assert
		expect(generation()).toBe(initial);
		expect(job()).toMatchObject({
			status: "failed",
			metadata: { pending_upsert_memory_ids: [1, 2] },
		});
	});

	it("increments generation when the runner replaces a failed migration", async () => {
		// Arrange: a migration scan, rather than queued repair, needs a fresh start.
		seedMemory(db, 1);
		queueVectorBackfillForSyncBootstrap(db);
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, { status: "failed" });
		const initial = generation();

		// Act
		await runVectorMigrationPass(db, { batchSize: 1 });

		// Assert
		expect(generation()).toBe(initial + 1);
		expect(job()?.metadata?.last_cursor_id).toBe(1);
	});

	it.each(["resume", "replace"])(
		"treats missing legacy generation as zero during %s",
		async (operation) => {
			// Arrange
			seedMemory(db, 1);
			queueVectorBackfillForSyncBootstrap(db);
			const metadata = { ...job()?.metadata };
			delete metadata.job_generation;
			updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, { metadata });

			// Act
			if (operation === "replace") queueVectorBackfillForSyncBootstrap(writer);
			await runVectorMigrationPass(db, { batchSize: 1 });

			// Assert
			expect(generation()).toBe(operation === "replace" ? 1 : 0);
			expect(findMemoryIdsWithCompleteActiveVectorCoverage(db, [1], "test-model")).toEqual([1]);
		},
	);

	it.each(["bootstrap", "completed enqueue", "failed runner"])(
		"rolls back exhausted generations during %s",
		async (operation) => {
			// Arrange
			seedMemory(db, 1);
			queueVectorBackfillForSyncBootstrap(db);
			updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				status: operation === "completed enqueue" ? "completed" : "failed",
				metadata: { ...job()?.metadata, job_generation: Number.MAX_SAFE_INTEGER },
			});
			const before = job();

			// Act
			const replace = async () => {
				if (operation === "bootstrap") return queueVectorBackfillForSyncBootstrap(writer);
				if (operation === "completed enqueue") {
					return queueVectorBackfill(writer, { upsertMemoryIds: [1], deleteMemoryIds: [] });
				}
				return runVectorMigrationPass(db);
			};

			// Assert: exhaustion must not wrap or reuse an older owner's generation.
			await expect(replace()).rejects.toThrow(/generation/i);
			expect(job()).toEqual(before);
			expect(db.inTransaction).toBe(false);
			expect(writer.inTransaction).toBe(false);
		},
	);
});
