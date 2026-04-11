import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as embeddings from "./embeddings.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { applyBootstrapSnapshot } from "./sync-bootstrap.js";
import { setSyncResetState } from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import {
	queueVectorBackfillForIncrementalSync,
	runVectorMigrationPass,
	VECTOR_MODEL_MIGRATION_JOB,
} from "./vector-migration.js";
import { resolveSemanticSearchModel } from "./vectors.js";

vi.mock("./embeddings.js", async () => {
	const actual = await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js");
	return {
		...actual,
		getEmbeddingClient: vi.fn(),
		embedTexts: vi.fn(),
		resolveEmbeddingModel: vi.fn(() => "test-model"),
	};
});

function seedMemory(
	db: Database,
	id: number,
	sessionId: number,
	title: string,
	body: string,
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_items(id, session_id, kind, title, body_text, confidence,
		 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
		 VALUES (?, ?, 'feature', ?, ?, 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
	).run(id, sessionId, title, body, now, now);
}

function seedVector(db: Database, memoryId: number, model: string): void {
	const vector = new Float32Array(384);
	db.exec(`
		INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
		VALUES (
			vec_f32('${JSON.stringify(Array.from(vector))}'),
			${memoryId},
			0,
			'hash-${memoryId}-${model}',
			'${model}'
		)
	`);
}

describe("vector migration", () => {
	let db: Database;

	beforeEach(() => {
		vi.clearAllMocks();
		db = new Database(":memory:");
		// initTestSchema -> bootstrapSchema loads sqlite-vec and creates the
		// memory_vectors virtual table as part of normal bootstrap.
		initTestSchema(db);
		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue({
			model: "test-model",
			dimensions: 384,
			embed: vi.fn(),
		});
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);
	});

	afterEach(() => {
		db.close();
	});

	it("disables semantic vector search while migration is in progress", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "Two", "Body two");
		seedVector(db, 1, "old-model");
		seedVector(db, 2, "old-model");

		await runVectorMigrationPass(db, { batchSize: 1 });

		const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(job).toMatchObject({
			status: "running",
			progress: { current: 1, total: 2, unit: "items" },
		});
		expect(job?.metadata).toMatchObject({ source_model: "old-model", target_model: "test-model" });
		expect(job?.metadata).toMatchObject({
			last_cursor_id: 1,
			processed_embeddable: 1,
			embeddable_total: 2,
		});
		expect(resolveSemanticSearchModel(db, "test-model")).toBeNull();

		const models = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(models).toEqual([
			{ model: "old-model", c: 2 },
			{ model: "test-model", c: 1 },
		]);
	});

	it("cuts over to the new model and removes stale rows after full coverage", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "Two", "Body two");
		seedVector(db, 1, "old-model");
		seedVector(db, 2, "old-model");

		await runVectorMigrationPass(db, { batchSize: 10 });

		const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(job).toMatchObject({
			status: "completed",
			progress: { current: 2, total: 2, unit: "items" },
		});
		expect(resolveSemanticSearchModel(db, "test-model")).toBe("test-model");

		const models = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(models).toEqual([{ model: "test-model", c: 2 }]);
	});

	it("treats non-embeddable active memories as already covered", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "", "");
		seedVector(db, 1, "old-model");
		seedVector(db, 2, "old-model");

		await runVectorMigrationPass(db, { batchSize: 10 });

		const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(job).toMatchObject({
			status: "completed",
			progress: { current: 1, total: 1, unit: "items" },
		});

		const models = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(models).toEqual([{ model: "test-model", c: 1 }]);
	});

	it("resumes from the stored cursor instead of rescanning from the beginning", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "Two", "Body two");
		seedMemory(db, 3, sessionId, "Three", "Body three");
		seedVector(db, 1, "old-model");
		seedVector(db, 2, "old-model");
		seedVector(db, 3, "old-model");

		await runVectorMigrationPass(db, { batchSize: 2 });
		const runningJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(runningJob?.metadata).toMatchObject({ last_cursor_id: 2, processed_embeddable: 2 });

		await runVectorMigrationPass(db, { batchSize: 2 });
		const completedJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(completedJob).toMatchObject({
			status: "completed",
			progress: { current: 3, total: 3, unit: "items" },
		});

		const models = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(models).toEqual([{ model: "test-model", c: 3 }]);
	});

	it("resumes from the stored cursor after a failed job", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "Two", "Body two");
		seedMemory(db, 3, sessionId, "Three", "Body three");
		seedVector(db, 1, "old-model");
		seedVector(db, 2, "old-model");
		seedVector(db, 3, "old-model");

		// First pass processes batch of 1
		await runVectorMigrationPass(db, { batchSize: 1 });
		const runningJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(runningJob).toMatchObject({ status: "running" });
		expect(runningJob?.metadata).toMatchObject({ last_cursor_id: 1, processed_embeddable: 1 });

		// Simulate failure by making embedTexts throw on next call
		vi.mocked(embeddings.embedTexts).mockRejectedValueOnce(new Error("provider outage"));
		try {
			await runVectorMigrationPass(db, { batchSize: 1 });
		} catch {
			// expected — backfillVectors propagates the error
		}

		// Restore normal behavior and resume — should pick up from cursor
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);
		await runVectorMigrationPass(db, { batchSize: 10 });

		const afterResume = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(afterResume).toMatchObject({ status: "completed" });
		expect(afterResume?.metadata).toMatchObject({ processed_embeddable: 3, embeddable_total: 3 });

		const models = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(models).toEqual([{ model: "test-model", c: 3 }]);
	});

	it("resumes bootstrap-queued vector catch-up after restart", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "codemem-vector-bootstrap-"));
		const dbPath = join(dbDir, "restart-safe.sqlite");
		let fileDb: Database | null = null;
		try {
			fileDb = new Database(dbPath);
			initTestSchema(fileDb);
			setSyncResetState(fileDb, {
				generation: 1,
				snapshot_id: "snap-1",
				baseline_cursor: null,
			});
			applyBootstrapSnapshot(
				fileDb,
				"peer-1",
				[
					{
						entity_id: "bootstrap-1",
						op_type: "upsert",
						payload_json: JSON.stringify({
							kind: "feature",
							title: "Bootstrap memory",
							body_text: "Needs vectors after restart",
							visibility: "shared",
							workspace_kind: "shared",
							workspace_id: "shared:default",
							created_at: "2026-01-01T00:00:01Z",
							metadata_json: { clock_device_id: "peer-dev" },
						}),
						clock_rev: 1,
						clock_updated_at: "2026-01-01T00:00:02Z",
						clock_device_id: "peer-dev",
					},
				],
				{
					reset_required: true,
					reason: "generation_mismatch",
					generation: 2,
					snapshot_id: "snap-2",
					baseline_cursor: "2026-01-01T00:00:05Z|base-op",
					retained_floor_cursor: null,
				},
			);

			const pendingJob = getMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB);
			expect(pendingJob).toMatchObject({
				status: "pending",
				progress: { current: 0, total: 1, unit: "items" },
			});

			fileDb.close();
			fileDb = null;
			fileDb = new Database(dbPath);
			initTestSchema(fileDb);

			await runVectorMigrationPass(fileDb, { batchSize: 10 });

			const completedJob = getMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB);
			expect(completedJob).toMatchObject({
				status: "completed",
				progress: { current: 1, total: 1, unit: "items" },
			});

			const models = fileDb
				.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
				.all() as Array<{ model: string; c: number }>;
			expect(models).toEqual([{ model: "test-model", c: 1 }]);
		} finally {
			fileDb?.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	it("resumes incremental sync queued vector catch-up after restart", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "codemem-vector-incremental-"));
		const dbPath = join(dbDir, "restart-safe.sqlite");
		let fileDb: Database | null = null;
		try {
			fileDb = new Database(dbPath);
			initTestSchema(fileDb);
			const sessionId = insertTestSession(fileDb);
			seedMemory(fileDb, 1, sessionId, "Incremental memory", "Needs vectors after restart");

			queueVectorBackfillForIncrementalSync(fileDb, {
				upsertMemoryIds: [1],
				deleteMemoryIds: [],
			});

			const pendingJob = getMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB);
			expect(pendingJob).toMatchObject({
				status: "pending",
				message: "Queued vector catch-up for incremental sync data",
				metadata: {
					trigger: "sync_incremental",
					pending_upsert_memory_ids: [1],
					pending_delete_memory_ids: [],
				},
			});

			fileDb.close();
			fileDb = null;
			fileDb = new Database(dbPath);
			initTestSchema(fileDb);

			await runVectorMigrationPass(fileDb, { batchSize: 10 });

			const completedJob = getMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB);
			expect(completedJob).toMatchObject({
				status: "completed",
				message: "Finished vector catch-up for incremental sync data",
				metadata: {
					pending_upsert_memory_ids: [],
					pending_delete_memory_ids: [],
				},
			});

			const models = fileDb
				.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
				.all() as Array<{ model: string; c: number }>;
			expect(models).toEqual([{ model: "test-model", c: 1 }]);
		} finally {
			fileDb?.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	it("marks a queued bootstrap backfill as failed when the embedding client is unavailable", async () => {
		setSyncResetState(db, {
			generation: 1,
			snapshot_id: "snap-1",
			baseline_cursor: null,
		});
		applyBootstrapSnapshot(
			db,
			"peer-1",
			[
				{
					entity_id: "bootstrap-1",
					op_type: "upsert",
					payload_json: JSON.stringify({
						kind: "feature",
						title: "Bootstrap memory",
						body_text: "Needs vectors later",
						visibility: "shared",
						workspace_kind: "shared",
						workspace_id: "shared:default",
						created_at: "2026-01-01T00:00:01Z",
						metadata_json: { clock_device_id: "peer-dev" },
					}),
					clock_rev: 1,
					clock_updated_at: "2026-01-01T00:00:02Z",
					clock_device_id: "peer-dev",
				},
			],
			{
				reset_required: true,
				reason: "generation_mismatch",
				generation: 2,
				snapshot_id: "snap-2",
				baseline_cursor: "2026-01-01T00:00:05Z|base-op",
				retained_floor_cursor: null,
			},
		);

		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValueOnce(null);
		await runVectorMigrationPass(db, { batchSize: 10 });

		const failedJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(failedJob).toMatchObject({
			status: "failed",
			message: "Vector re-indexing is waiting for the embedding client",
			error: "Embedding client unavailable",
		});
	});

	it("does not rewrite completed jobs when the embedding client is unavailable", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedVector(db, 1, "old-model");

		await runVectorMigrationPass(db, { batchSize: 10 });
		const completedBeforeDisable = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(completedBeforeDisable).toMatchObject({ status: "completed" });

		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValueOnce(null);
		await runVectorMigrationPass(db, { batchSize: 10 });

		const completedAfterDisable = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(completedAfterDisable).toMatchObject({ status: "completed" });
	});

	it("removes stale old-model rows when queued work has zero embeddable memories", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "", "");
		seedVector(db, 1, "old-model");

		await runVectorMigrationPass(db, { batchSize: 10 });

		const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(job).toMatchObject({
			status: "completed",
			metadata: {
				source_model: "old-model",
				target_model: "test-model",
				removed_stale_rows: 1,
			},
		});

		const models = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(models).toEqual([]);
	});

	it("backfills memories that have no vectors at all (no source model)", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "Two", "Body two");
		// No vectors seeded at all — empty memory_vectors table

		await runVectorMigrationPass(db, { batchSize: 10 });

		const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(job).toMatchObject({
			status: "completed",
			progress: { current: 2, total: 2, unit: "items" },
		});

		const models = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(models).toEqual([{ model: "test-model", c: 2 }]);
	});
});
