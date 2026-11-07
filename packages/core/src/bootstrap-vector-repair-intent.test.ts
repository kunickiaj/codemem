import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as embeddings from "./embeddings.js";
import * as jobs from "./maintenance-jobs.js";
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
	return { ...actual, getEmbeddingClient: vi.fn(), embedTexts: vi.fn() };
});

const repairWork = { upsertMemoryIds: [101, 102], deleteMemoryIds: [103] };

function seedRepairIntent(db: Database): number {
	queueVectorBackfill(db, repairWork);
	// A later enqueue makes a reset to an initial revision observable.
	queueVectorBackfill(db, { upsertMemoryIds: [102], deleteMemoryIds: [] });
	return Number(jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata?.queue_revision);
}

function expectRepairIntent(db: Database, minimumRevision: number): void {
	const metadata = jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata;
	expect(metadata).toMatchObject({
		pending_upsert_memory_ids: [101, 102],
		pending_delete_memory_ids: [103],
	});
	expect(metadata?.queue_revision).toEqual(expect.any(Number));
	expect(Number(metadata?.queue_revision)).toBeGreaterThanOrEqual(minimumRevision);
}

let db: Database;
const directories: string[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	db = new Database(":memory:");
});

afterEach(() => {
	vi.restoreAllMocks();
	db.close();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("bootstrap scheduling preserves vector repair intent", () => {
	it("retains queued upserts, deletes, and revision after closing and reopening the database", () => {
		// Arrange: pending repair must survive a real connection restart.
		const directory = mkdtempSync(join(tmpdir(), "codemem-bootstrap-intent-"));
		directories.push(directory);
		const path = join(directory, "intent.sqlite");
		db.close();
		db = new Database(path);
		const revision = seedRepairIntent(db);

		// Act
		queueVectorBackfillForSyncBootstrap(db);
		db.close();
		db = new Database(path);

		// Assert
		expectRepairIntent(db, revision);
		expect(jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "pending",
			metadata: { trigger: "sync_bootstrap", last_cursor_id: 0, processed_embeddable: 0 },
		});
		expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
		expect(embeddings.embedTexts).not.toHaveBeenCalled();
	});

	it("retains repair intent across repeated bootstrap scheduling", () => {
		// Arrange
		const revision = seedRepairIntent(db);

		// Act
		queueVectorBackfillForSyncBootstrap(db, { embeddableTotal: 4 });
		const firstRevision = Number(
			jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata?.queue_revision,
		);
		queueVectorBackfillForSyncBootstrap(db, { embeddableTotal: 8 });

		// Assert
		expect(firstRevision).toBeGreaterThanOrEqual(revision);
		expectRepairIntent(db, firstRevision);
		expect(jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			progress: { current: 0, total: 8 },
			metadata: { embeddable_total: 8 },
		});
	});

	it.each(["failed", "cancelled", "completed"] as const)(
		"retains pending repair when replacing a %s job",
		(status) => {
			// Arrange: local repair may coexist with a terminal migration.
			const revision = seedRepairIntent(db);
			jobs.updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, { status });
			if (status !== "completed") {
				queueVectorBackfill(db, { upsertMemoryIds: [102], deleteMemoryIds: [] });
			}
			const queuedRevision = Number(
				jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata?.queue_revision,
			);
			// Completed jobs can have persisted pending intent from an interrupted finalization.
			jobs.updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, { status });

			// Act
			queueVectorBackfillForSyncBootstrap(db);

			// Assert
			expectRepairIntent(db, Math.max(revision, queuedRevision));
			expect(jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
				status: "pending",
				finished_at: null,
				error: null,
				progress: { current: 0, total: null },
			});
			expect(
				jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata
					?.local_repair_preserves_migration_state,
			).toBeUndefined();
		},
	);

	it.each([
		{ upsertMemoryIds: [101], deleteMemoryIds: [] },
		{ upsertMemoryIds: [], deleteMemoryIds: [103] },
	])("retains one-sided repair work %j", (work) => {
		// Arrange
		queueVectorBackfill(db, work);
		const revision = Number(
			jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata?.queue_revision,
		);

		// Act
		queueVectorBackfillForSyncBootstrap(db);

		// Assert
		const metadata = jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata;
		expect(metadata).toMatchObject({
			pending_upsert_memory_ids: work.upsertMemoryIds,
			pending_delete_memory_ids: work.deleteMemoryIds,
		});
		expect(Number(metadata?.queue_revision)).toBeGreaterThanOrEqual(revision);
	});
});

describe("bootstrap scheduling starts fresh migration state", () => {
	it("starts fresh migration progress without copying stale target, cleanup, or error fields", () => {
		// Arrange
		const revision = seedRepairIntent(db);
		const metadata = jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata;
		jobs.failMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, "previous failure", {
			progressCurrent: 77,
			progressTotal: 999,
			metadata: {
				...metadata,
				source_model: "old-source",
				target_model: "old-target",
				requested_model: "old-request",
				requested_revision: "old-revision",
				last_cursor_id: 900,
				processed_embeddable: 77,
				embeddable_total: 999,
				cleanup_pending: true,
				stale_scan_exhausted: true,
				stale_scan_exhausted_max_rowid: 500,
				reconciliation_target_coverage_complete: true,
				uncovered_target_memories: 5,
				cutover_retry_count: 4,
				removed_stale_rows: 12,
				local_repair_preserves_migration_state: true,
			},
		});

		// Act
		queueVectorBackfillForSyncBootstrap(db, { embeddableTotal: 6 });

		// Assert: retain only durable repair intent alongside fresh bootstrap state.
		expectRepairIntent(db, revision);
		const job = jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(job).toMatchObject({
			status: "pending",
			error: null,
			finished_at: null,
			progress: { current: 0, total: 6 },
		});
		expect(job?.metadata).toEqual({
			pending_upsert_memory_ids: [101, 102],
			pending_delete_memory_ids: [103],
			queue_revision: job?.metadata?.queue_revision,
			last_cursor_id: 0,
			processed_embeddable: 0,
			trigger: "sync_bootstrap",
			embeddable_total: 6,
		});
	});

	it.each([undefined, null, 0, 7, -1, Number.NaN])(
		"keeps empty-queue bootstrap progress compatible for total %s",
		(embeddableTotal) => {
			// Arrange
			const expectedTotal =
				typeof embeddableTotal === "number" && embeddableTotal >= 0 ? embeddableTotal : null;
			const options = embeddableTotal === undefined ? undefined : { embeddableTotal };

			// Act
			queueVectorBackfillForSyncBootstrap(db, options);

			// Assert
			const job = jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
			expect(job).toMatchObject({
				status: "pending",
				title: "Re-indexing memories",
				message: "Queued vector catch-up for synced bootstrap data",
				progress: { current: 0, total: expectedTotal, unit: "items" },
				metadata: { last_cursor_id: 0, processed_embeddable: 0, trigger: "sync_bootstrap" },
			});
			expect(job?.metadata?.embeddable_total).toBe(expectedTotal ?? undefined);
			expect(job?.metadata?.pending_upsert_memory_ids ?? []).toEqual([]);
			expect(job?.metadata?.pending_delete_memory_ids ?? []).toEqual([]);
		},
	);
});

describe("bootstrap scheduling is atomic", () => {
	it("reads existing intent and writes bootstrap state inside one transaction", () => {
		// Arrange
		const revision = seedRepairIntent(db);
		const read = jobs.getMaintenanceJob;
		const transactionalReads: boolean[] = [];
		vi.spyOn(jobs, "getMaintenanceJob").mockImplementation((connection, kind) => {
			transactionalReads.push(connection.inTransaction);
			return read(connection, kind);
		});

		// Act
		queueVectorBackfillForSyncBootstrap(db);

		// Assert: a read outside the write transaction could lose another writer's intent.
		expect(transactionalReads.length).toBeGreaterThan(0);
		expect(transactionalReads.every(Boolean)).toBe(true);
		expect(db.inTransaction).toBe(false);
		expectRepairIntent(db, revision);
	});

	it.each(["existing repair", "no existing job"])(
		"rolls back scheduling after a write fails with %s",
		(existingState) => {
			// Arrange
			if (existingState === "existing repair") seedRepairIntent(db);
			const before = jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
			const start = jobs.startMaintenanceJob;
			vi.spyOn(jobs, "startMaintenanceJob").mockImplementation((connection, input) => {
				start(connection, input);
				throw new Error("injected post-write failure");
			});

			// Act
			const schedule = () => queueVectorBackfillForSyncBootstrap(db, { embeddableTotal: 3 });

			// Assert: neither partial bootstrap state nor a lost queue may commit.
			expect(schedule).toThrow("injected post-write failure");
			expect(jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toEqual(before);
			expect(db.inTransaction).toBe(false);
		},
	);
});

describe("bootstrap runner drains repair and imported memories", () => {
	beforeEach(() => {
		initTestSchema(db);
		const sessionId = insertTestSession(db);
		const insertMemory = db.prepare(
			`INSERT INTO memory_items(id, session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
			 VALUES (?, ?, 'feature', ?, 'Synthetic body', 0.5, '', 1,
			 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{}', 1, 'shared')`,
		);
		for (const id of [101, 102, 103]) insertMemory.run(id, sessionId, `Memory ${id}`);
		db.prepare("UPDATE memory_items SET active = 0 WHERE id = 103").run();
		db.prepare(
			"INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model) VALUES (?, ?, ?, ?, ?)",
		).run(Buffer.alloc(384 * Float32Array.BYTES_PER_ELEMENT), 103n, 0n, "stale", "test-model");
		seedRepairIntent(db);
		// Imported rows arrive after repair was queued and are absent from its ID list.
		for (const id of [201, 202]) insertMemory.run(id, sessionId, `Memory ${id}`);
		vi.spyOn(embeddings, "resolveEmbeddingClientVectorIdentityLabel").mockReturnValue("test-model");
		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue({
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
		});
		vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) =>
			texts.map(() => new Float32Array(384)),
		);
	});

	it("completes repair upserts, removes deleted vectors, and covers newly imported memories", async () => {
		// Arrange
		const activeIds = [101, 102, 201, 202];

		// Act: small batches exercise queue draining followed by the bootstrap scan.
		queueVectorBackfillForSyncBootstrap(db, { embeddableTotal: activeIds.length });
		for (let pass = 0; pass < 10; pass++) {
			await runVectorMigrationPass(db, { batchSize: 1 });
			if (jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.status === "completed") break;
		}

		// Assert
		const job = jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(job?.status).toBe("completed");
		expect(job?.metadata?.pending_upsert_memory_ids ?? []).toEqual([]);
		expect(job?.metadata?.pending_delete_memory_ids ?? []).toEqual([]);
		expect(findMemoryIdsWithCompleteActiveVectorCoverage(db, activeIds, "test-model")).toEqual(
			activeIds,
		);
		expect(db.prepare("SELECT memory_id FROM memory_vectors WHERE memory_id = 103").all()).toEqual(
			[],
		);
		expect(embeddings.embedTexts).toHaveBeenCalled();
	});

	it("retains upsert intent without claiming completion when the fake provider fails", async () => {
		// Arrange
		vi.mocked(embeddings.embedTexts).mockRejectedValueOnce(new Error("synthetic provider failure"));

		// Act
		queueVectorBackfillForSyncBootstrap(db);
		const run = runVectorMigrationPass(db, { batchSize: 1 });

		// Assert
		await expect(run).rejects.toThrow("synthetic provider failure");
		expect(jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.status).not.toBe("completed");
		expect(jobs.getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata).toMatchObject({
			pending_upsert_memory_ids: [101, 102],
		});
		expect(
			findMemoryIdsWithCompleteActiveVectorCoverage(db, [101, 102, 201, 202], "test-model"),
		).toEqual([]);
	});
});
