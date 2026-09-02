import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as embeddings from "./embeddings.js";
import {
	completeMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
} from "./maintenance-jobs.js";
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
		resolveEmbeddingClientVectorIdentityLabel: vi.fn(() => "test-model"),
		resolveEmbeddingVectorIdentityLabel: vi.fn(() => "test-model"),
		tryResolveEmbeddingRevision: vi.fn(() => "test-revision"),
		tryResolveEmbeddingVectorIdentityLabel: vi.fn(() => "test-model"),
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

function seedVector(
	db: Database,
	memoryId: number,
	model: string,
	contentHash = `hash-${memoryId}-${model}`,
): void {
	const vector = new Float32Array(384);
	db.exec(`
		INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
		VALUES (
			vec_f32('${JSON.stringify(Array.from(vector))}'),
			${memoryId},
			0,
			'${contentHash}',
			'${model}'
		)
	`);
}

describe("vector migration", () => {
	let db: Database;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(embeddings.resolveEmbeddingModel).mockReturnValue("test-model");
		vi.mocked(embeddings.resolveEmbeddingClientVectorIdentityLabel).mockReturnValue("test-model");
		vi.mocked(embeddings.resolveEmbeddingVectorIdentityLabel).mockReturnValue("test-model");
		vi.mocked(embeddings.tryResolveEmbeddingRevision).mockReturnValue("test-revision");
		vi.mocked(embeddings.tryResolveEmbeddingVectorIdentityLabel).mockReturnValue("test-model");
		db = new Database(":memory:");
		// initTestSchema -> bootstrapSchema loads sqlite-vec and creates the
		// memory_vectors virtual table as part of normal bootstrap.
		initTestSchema(db);
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
				dimensions: 384,
			},
			embed: vi.fn(),
		});
		vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) =>
			texts.map(() => new Float32Array(384)),
		);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		db.close();
	});

	it("falls back to FTS for an incompatible source while migration is in progress", async () => {
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

	it("rebuilds legacy bare-model vectors under the revision-aware identity before cutover", async () => {
		const legacyModel = "Xenova/bge-small-en-v1.5";
		const targetModel = embeddings.DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
		vi.mocked(embeddings.resolveEmbeddingClientVectorIdentityLabel).mockReturnValue(targetModel);
		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue({
			model: legacyModel,
			dimensions: 384,
			identity: {
				package: "@huggingface/transformers",
				version: "4.2.0",
				model: legacyModel,
				revision: embeddings.DEFAULT_EMBEDDING_REVISION,
				dtype: "fp32",
				device: "cpu",
				dimensions: 384,
			},
			embed: vi.fn(),
		});
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "Two", "Body two");
		seedVector(db, 1, legacyModel);
		seedVector(db, 2, legacyModel);

		await runVectorMigrationPass(db, { batchSize: 1 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "running",
			message: "Re-indexed 1 of 2 memories with Xenova/bge-small-en-v1.5@ea104dacec62",
			metadata: { source_model: legacyModel, target_model: targetModel },
		});
		expect(resolveSemanticSearchModel(db, targetModel)).toBe(legacyModel);
		expect(
			db
				.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
				.all(),
		).toEqual([
			{ model: legacyModel, c: 1 },
			{ model: targetModel, c: 1 },
		]);

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			metadata: {
				source_model: legacyModel,
				target_model: targetModel,
				removed_stale_rows: 2,
			},
		});
		expect(resolveSemanticSearchModel(db, targetModel)).toBe(targetModel);
		expect(
			db
				.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
				.all(),
		).toEqual([{ model: targetModel, c: 2 }]);
	});

	it("prunes obsolete target and compatible legacy rows after each covered migration memory", async () => {
		const legacyModel = "Xenova/bge-small-en-v1.5";
		const targetModel = embeddings.DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
		vi.mocked(embeddings.resolveEmbeddingClientVectorIdentityLabel).mockReturnValue(targetModel);
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Fresh body one");
		seedMemory(db, 2, sessionId, "Two", "Fresh body two");
		seedVector(db, 1, legacyModel, "legacy-one");
		seedVector(db, 2, legacyModel, "legacy-two");
		seedVector(db, 1, targetModel, "obsolete-target-one");

		await runVectorMigrationPass(db, { batchSize: 1 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({ status: "running" });
		expect(
			db
				.prepare(
					"SELECT model, content_hash FROM memory_vectors WHERE memory_id = 1 ORDER BY model, content_hash",
				)
				.all(),
		).toEqual([
			{
				model: targetModel,
				content_hash: embeddings.hashText("One\nFresh body one"),
			},
		]);
		expect(
			db.prepare("SELECT model, content_hash FROM memory_vectors WHERE memory_id = 2").all(),
		).toEqual([{ model: legacyModel, content_hash: "legacy-two" }]);
	});

	it("retains compatible legacy rows when migration target generation fails", async () => {
		const legacyModel = "Xenova/bge-small-en-v1.5";
		const targetModel = embeddings.DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
		vi.mocked(embeddings.resolveEmbeddingClientVectorIdentityLabel).mockReturnValue(targetModel);
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Fresh body one");
		seedVector(db, 1, legacyModel, "legacy-one");
		vi.mocked(embeddings.embedTexts).mockRejectedValueOnce(new Error("provider outage"));

		await expect(runVectorMigrationPass(db, { batchSize: 1 })).rejects.toThrow("provider outage");

		expect(
			db.prepare("SELECT model, content_hash FROM memory_vectors WHERE memory_id = 1").all(),
		).toEqual([{ model: legacyModel, content_hash: "legacy-one" }]);
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

	it("resets a completed legacy job cursor when the vector identity changes", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "Two", "Body two");
		seedVector(db, 1, "old-model");
		seedVector(db, 2, "old-model");
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Previous migration",
			message: "Previous migration completed",
			progressTotal: 2,
			metadata: {
				source_model: "older-model",
				target_model: "old-model",
				last_cursor_id: 999,
				processed_embeddable: 2,
				embeddable_total: 2,
			},
		});
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);

		await runVectorMigrationPass(db, { batchSize: 1 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "running",
			progress: { current: 1, total: 2, unit: "items" },
			metadata: {
				source_model: "old-model",
				target_model: "test-model",
				last_cursor_id: 1,
				processed_embeddable: 1,
				embeddable_total: 2,
			},
		});
		expect(
			db
				.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
				.all(),
		).toEqual([
			{ model: "old-model", c: 2 },
			{ model: "test-model", c: 1 },
		]);

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			progress: { current: 2, total: 2, unit: "items" },
			metadata: {
				target_model: "test-model",
				processed_embeddable: 2,
				embeddable_total: 2,
			},
		});
		expect(
			db
				.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
				.all(),
		).toEqual([{ model: "test-model", c: 2 }]);
	});

	it("retries cutover when the corpus changes during unlocked validation", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedVector(db, 1, "old-model");
		let injectedWrite = false;
		const prepareSpy = vi.spyOn(db, "prepare");
		prepareSpy.mockImplementation((sql: string) => {
			if (!injectedWrite && sql.includes("vector-coverage-validation")) {
				injectedWrite = true;
				Database.prototype.prepare
					.call(db, "UPDATE memory_items SET updated_at = updated_at WHERE id = 1")
					.run();
			}
			return Database.prototype.prepare.call(db, sql);
		});

		await runVectorMigrationPass(db, { batchSize: 10 });
		prepareSpy.mockRestore();

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "running",
			message: "Memory changes arrived during cutover validation; retrying",
			metadata: { cutover_retry_count: 1 },
		});
		expect(
			db
				.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
				.all(),
		).toEqual([
			{ model: "old-model", c: 1 },
			{ model: "test-model", c: 1 },
		]);

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			metadata: { cutover_retry_count: 0 },
		});
		expect(
			db.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model").all(),
		).toEqual([{ model: "test-model", c: 1 }]);
	});

	it("retries cutover when a memory loses a chunk after target pruning", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "codemem-vector-prune-fence-"));
		const dbPath = join(dbDir, "prune-fence.sqlite");
		let fileDb: Database | null = null;
		let writerDb: Database | null = null;
		try {
			fileDb = new Database(dbPath);
			initTestSchema(fileDb);
			writerDb = new Database(dbPath);
			const sessionId = insertTestSession(fileDb);
			const firstParagraph = "First retained paragraph. ".repeat(40).trim();
			const removedParagraph = "Second removed paragraph. ".repeat(40).trim();
			const chunks = embeddings.chunkText(`${firstParagraph}\n\n${removedParagraph}`);
			expect(chunks).toHaveLength(2);
			seedMemory(fileDb, 1, sessionId, "", `${firstParagraph}\n\n${removedParagraph}`);
			seedVector(fileDb, 1, "old-model");
			seedVector(fileDb, 1, "test-model", embeddings.hashText(chunks[0] ?? ""));
			seedVector(fileDb, 1, "test-model", embeddings.hashText(chunks[1] ?? ""));
			startMaintenanceJob(fileDb, {
				kind: VECTOR_MODEL_MIGRATION_JOB,
				title: "Migration awaiting cutover",
				message: "Cursor exhausted",
				progressTotal: 1,
				metadata: {
					source_model: "old-model",
					target_model: "test-model",
					last_cursor_id: 10,
					processed_embeddable: 1,
					embeddable_total: 1,
				},
			});
			let injectedWrite = false;
			const prepareSpy = vi.spyOn(fileDb, "prepare");
			prepareSpy.mockImplementation((sql: string) => {
				if (!injectedWrite && sql.includes("vector-cutover-prune-end")) {
					injectedWrite = true;
					writerDb
						?.prepare("UPDATE memory_items SET body_text = ?, updated_at = updated_at WHERE id = 1")
						.run(firstParagraph);
				}
				return Database.prototype.prepare.call(fileDb, sql);
			});
			try {
				await runVectorMigrationPass(fileDb, { batchSize: 10 });
			} finally {
				prepareSpy.mockRestore();
			}

			expect(injectedWrite).toBe(true);
			expect(getMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
				status: "running",
				message: "Memory changes arrived during cutover validation; retrying",
				metadata: { cutover_retry_count: 1 },
			});
			expect(
				fileDb.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = 'test-model'").get(),
			).toMatchObject({ c: 2 });

			await runVectorMigrationPass(fileDb, { batchSize: 10 });

			expect(getMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
				status: "completed",
				metadata: { cutover_retry_count: 0, removed_stale_rows: 2 },
			});
			const hashes = fileDb
				.prepare("SELECT content_hash FROM memory_vectors WHERE model = 'test-model'")
				.all() as Array<{ content_hash: string }>;
			expect(hashes).toEqual([{ content_hash: embeddings.hashText(chunks[0] ?? "") }]);
		} finally {
			writerDb?.close();
			fileDb?.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	it("preserves legacy vectors when a completed scan lacks target coverage", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 10, sessionId, "Ten", "Body ten");
		seedVector(db, 10, "old-model");
		await runVectorMigrationPass(db, { batchSize: 1 });

		// Simulate a lower-ID memory appearing after the cursor has advanced.
		seedMemory(db, 5, sessionId, "Five", "Body five");
		seedVector(db, 5, "old-model");

		await runVectorMigrationPass(db, { batchSize: 1 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "failed",
			error: "Target vector coverage is incomplete for 1 memory",
			metadata: { uncovered_target_memories: 1 },
		});
		expect(
			db
				.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
				.all(),
		).toEqual([
			{ model: "old-model", c: 2 },
			{ model: "test-model", c: 1 },
		]);

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			progress: { current: 2, total: 2, unit: "items" },
		});
		expect(
			db.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model").all(),
		).toEqual([{ model: "test-model", c: 2 }]);
	});

	it("refuses cutover when a multi-chunk memory has only partial target coverage", async () => {
		const sessionId = insertTestSession(db);
		const body = "Long semantic content. ".repeat(200);
		seedMemory(db, 1, sessionId, "Long memory", body);
		seedVector(db, 1, "old-model");
		const firstChunk = embeddings.chunkText(`Long memory\n${body}`)[0];
		expect(firstChunk).toBeDefined();
		seedVector(db, 1, "test-model", embeddings.hashText(firstChunk ?? ""));
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Partial migration",
			message: "Cursor exhausted",
			progressTotal: 1,
			metadata: {
				source_model: "old-model",
				target_model: "test-model",
				last_cursor_id: 10,
				processed_embeddable: 1,
				embeddable_total: 1,
			},
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "failed",
			error: "Target vector coverage is incomplete for 1 memory",
			metadata: {
				last_cursor_id: 0,
				processed_embeddable: 0,
				uncovered_target_memories: 1,
			},
		});
		expect(
			db
				.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
				.all(),
		).toEqual([
			{ model: "old-model", c: 1 },
			{ model: "test-model", c: 1 },
		]);
	});

	it("prunes obsolete target-model rows at cutover", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedVector(db, 1, "old-model");
		// A leftover target-model row for content that no longer exists (e.g. an
		// interrupted migration or a redaction without vector maintenance). Its
		// hash is not part of memory 1's current chunk set.
		seedVector(db, 1, "test-model", "obsolete-target-hash");

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
		});
		const hashes = db
			.prepare(
				"SELECT content_hash FROM memory_vectors WHERE memory_id = 1 AND model = 'test-model' ORDER BY content_hash",
			)
			.all() as Array<{ content_hash: string }>;
		// Only the freshly-embedded current chunk remains; the obsolete row is gone.
		expect(hashes.map((row) => row.content_hash)).not.toContain("obsolete-target-hash");
		expect(hashes).toHaveLength(1);
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = 'old-model'").get(),
		).toMatchObject({ c: 0 });
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
		vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) =>
			texts.map(() => new Float32Array(384)),
		);
		await runVectorMigrationPass(db, { batchSize: 10 });

		const afterResume = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(afterResume).toMatchObject({ status: "completed" });
		expect(afterResume?.metadata).toMatchObject({ processed_embeddable: 3, embeddable_total: 3 });

		const models = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(models).toEqual([{ model: "test-model", c: 3 }]);
	});

	it("preserves the migration cursor when an inference batch is aborted", async () => {
		// Cooperative shutdown (codemem-u5yn): with an aborted signal, the
		// in-flight inference batch finishes, but the migration cursor must NOT
		// advance. The next tick rechecks the batch before completing cutover.
		const sessionId = insertTestSession(db);
		for (let i = 1; i <= 10; i++) {
			seedMemory(db, i, sessionId, `Title ${i}`, `Body for memory ${i}`);
			seedVector(db, i, "old-model");
		}
		const controller = new AbortController();
		const embedSpy = vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
			controller.abort();
			return texts.map(() => new Float32Array(384));
		});

		await runVectorMigrationPass(db, { batchSize: 10, signal: controller.signal });

		expect(embedSpy.mock.calls.length).toBe(1);
		const coverage = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(coverage).toEqual([
			{ model: "old-model", c: 10 },
			{ model: "test-model", c: 10 },
		]);
		// Cursor must not advance — retry on next tick.
		const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(job?.status).not.toBe("completed");

		await runVectorMigrationPass(db, { batchSize: 10 });
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.status).toBe("running");

		// An exact-size batch needs one empty cursor pass to prove the migration is drained.
		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.status).toBe("completed");
		expect(
			db.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model").all(),
		).toEqual([{ model: "test-model", c: 10 }]);
	});

	it("completes an in-flight running job without re-embedding when corpus is already covered", async () => {
		// Reproduces codemem-ad6m: sync-incremental trigger leaves the job in
		// 'running' status after its queue drains; every memory is already
		// covered by target-model vectors and no source model remains. The
		// runner should fast-exit, marking the job completed, not re-embed
		// the entire corpus.
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "Two", "Body two");
		seedVector(db, 1, "test-model");
		seedVector(db, 2, "test-model");
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			status: "running",
			message: "Queued sync vector catch-up complete",
			progressCurrent: 2,
			progressTotal: 2,
			metadata: {
				target_model: "test-model",
				source_model: null,
				last_cursor_id: 0,
				processed_embeddable: 2,
				embeddable_total: 2,
				trigger: "sync_incremental",
			},
		});
		const embedSpy = vi.mocked(embeddings.embedTexts);
		const callsBefore = embedSpy.mock.calls.length;

		await runVectorMigrationPass(db, { batchSize: 50 });

		expect(embedSpy.mock.calls.length).toBe(callsBefore);
		const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(job).toMatchObject({ status: "completed" });
		const models = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(models).toEqual([{ model: "test-model", c: 2 }]);
	});

	it("resumes bootstrap-queued vector catch-up after restart", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "codemem-vector-bootstrap-"));
		const dbPath = join(dbDir, "restart-safe.sqlite");
		let fileDb: Database | null = null;
		try {
			fileDb = new Database(dbPath);
			initTestSchema(fileDb);
			setSyncResetState(
				fileDb,
				{
					generation: 1,
					snapshot_id: "snap-1",
					baseline_cursor: null,
				},
				"vector-work",
			);
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
							scope_id: "vector-work",
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
					scope_id: "vector-work",
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
					target_model: "test-model",
					requested_model: "test-model",
					requested_revision: "test-revision",
					pending_upsert_memory_ids: [],
					pending_delete_memory_ids: [],
				},
			});

			const models = fileDb
				.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
				.all() as Array<{ model: string; c: number }>;
			expect(models).toEqual([{ model: "test-model", c: 1 }]);

			const actualEmbeddings =
				await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js");
			vi.stubEnv("CODEMEM_EMBEDDING_MODEL", "test-model");
			vi.stubEnv("CODEMEM_EMBEDDING_REVISION", "test-revision");
			vi.mocked(embeddings.tryResolveEmbeddingVectorIdentityLabel).mockImplementation(
				actualEmbeddings.tryResolveEmbeddingVectorIdentityLabel,
			);
			expect(resolveSemanticSearchModel(fileDb)).toBe("test-model");
		} finally {
			fileDb?.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	it("prunes stale current-model vectors while replaying queued incremental upserts", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "Incremental memory", "Fresh body");
		db.exec(`
			INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
			VALUES (
				vec_f32('${JSON.stringify(Array.from(new Float32Array(384)))}'),
				1,
				0,
				'stale-current-hash',
				'test-model'
			)
		`);

		queueVectorBackfillForIncrementalSync(db, {
			upsertMemoryIds: [1],
			deleteMemoryIds: [],
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		const rows = db
			.prepare(
				"SELECT content_hash FROM memory_vectors WHERE memory_id = ? AND model = ? ORDER BY content_hash",
			)
			.all(1, "test-model") as Array<{ content_hash: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.content_hash).not.toBe("stale-current-hash");
	});

	it("prunes obsolete target and compatible legacy rows after a queued upsert is covered", async () => {
		const legacyModel = "Xenova/bge-small-en-v1.5";
		const targetModel = embeddings.DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
		vi.mocked(embeddings.resolveEmbeddingClientVectorIdentityLabel).mockReturnValue(targetModel);
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "Incremental memory", "Fresh body");
		seedVector(db, 1, legacyModel, "legacy-content");
		seedVector(db, 1, targetModel, "obsolete-target-content");
		queueVectorBackfillForIncrementalSync(db, {
			upsertMemoryIds: [1],
			deleteMemoryIds: [],
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(
			db.prepare("SELECT model, content_hash FROM memory_vectors WHERE memory_id = 1").all(),
		).toEqual([
			{
				model: targetModel,
				content_hash: embeddings.hashText("Incremental memory\nFresh body"),
			},
		]);
	});

	it("continues a legacy rebuild after draining incremental catch-up", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "Queued memory", "Fresh body");
		seedMemory(db, 2, sessionId, "Legacy memory", "Legacy body");
		seedVector(db, 1, "old-model", "stale-queued-content");
		seedVector(db, 2, "old-model", "legacy-content");
		queueVectorBackfillForIncrementalSync(db, {
			upsertMemoryIds: [1],
			deleteMemoryIds: [],
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(
			db.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model").all(),
		).toEqual([{ model: "test-model", c: 2 }]);
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			metadata: { source_model: "old-model", target_model: "test-model" },
		});
	});

	it("resets migration progress when queued work records a new target", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "Two", "Body two");
		seedVector(db, 1, "previous-target");
		seedVector(db, 2, "previous-target");
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			status: "running",
			metadata: {
				target_model: "previous-target",
				source_model: "older-source",
				last_cursor_id: 999,
				processed_embeddable: 99,
				embeddable_total: 100,
				trigger: "sync_incremental",
			},
		});
		queueVectorBackfillForIncrementalSync(db, {
			upsertMemoryIds: [2],
			deleteMemoryIds: [],
		});

		await runVectorMigrationPass(db, { batchSize: 1 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "running",
			metadata: {
				target_model: "test-model",
				source_model: "previous-target",
				last_cursor_id: 1,
				processed_embeddable: 1,
				embeddable_total: 2,
			},
		});
	});

	it("preserves pending cleanup when incremental work reopens a completed job", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "Queued memory", "Fresh body");
		seedMemory(db, 2, sessionId, "Stale memory", "Stale body");
		seedVector(db, 1, "test-model");
		seedVector(db, 2, "old-model");
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			metadata: {
				target_model: "test-model",
				requested_model: "test-model",
				requested_revision: "main",
				cleanup_pending: true,
				removed_stale_rows: 2,
			},
		});
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);

		queueVectorBackfillForIncrementalSync(db, {
			upsertMemoryIds: [1],
			deleteMemoryIds: [],
		});
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "pending",
			metadata: {
				target_model: "test-model",
				requested_model: "test-model",
				requested_revision: "main",
				cleanup_pending: true,
			},
		});

		await runVectorMigrationPass(db, { batchSize: 10 });
		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model != ?").get("test-model"),
		).toMatchObject({ c: 0 });
		expect(
			db
				.prepare("SELECT COUNT(DISTINCT memory_id) AS c FROM memory_vectors WHERE model = ?")
				.get("test-model"),
		).toMatchObject({ c: 2 });
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			metadata: { cleanup_pending: false, removed_stale_rows: 4 },
		});
	});

	it("retains compatible legacy rows and queued work when queued target generation fails", async () => {
		const legacyModel = "Xenova/bge-small-en-v1.5";
		const targetModel = embeddings.DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
		vi.mocked(embeddings.resolveEmbeddingClientVectorIdentityLabel).mockReturnValue(targetModel);
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "Incremental memory", "Fresh body");
		seedVector(db, 1, legacyModel, "legacy-content");
		queueVectorBackfillForIncrementalSync(db, {
			upsertMemoryIds: [1],
			deleteMemoryIds: [],
		});
		vi.mocked(embeddings.embedTexts).mockResolvedValueOnce([]);

		await expect(runVectorMigrationPass(db, { batchSize: 10 })).rejects.toThrow(
			"Embedding client returned 0 vectors for 1 texts",
		);

		expect(
			db.prepare("SELECT model, content_hash FROM memory_vectors WHERE memory_id = 1").all(),
		).toEqual([{ model: legacyModel, content_hash: "legacy-content" }]);
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			metadata: { pending_upsert_memory_ids: [1] },
		});
	});

	it("preserves newly queued incremental ids while replaying queued work", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "Two", "Body two");
		seedVector(db, 2, "test-model");

		queueVectorBackfillForIncrementalSync(db, {
			upsertMemoryIds: [1],
			deleteMemoryIds: [],
		});
		vi.mocked(embeddings.embedTexts).mockImplementationOnce(async () => {
			queueVectorBackfillForIncrementalSync(db, {
				upsertMemoryIds: [],
				deleteMemoryIds: [2],
			});
			return [new Float32Array(384)];
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		const runningJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(runningJob).toMatchObject({
			status: "running",
			metadata: {
				pending_delete_memory_ids: [2],
			},
		});
	});

	it("preserves a re-queued in-flight id and the drained target identity", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Original body");
		seedVector(db, 1, "previous-target");
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			status: "running",
			metadata: {
				target_model: "previous-target",
				source_model: "older-source",
				last_cursor_id: 999,
				processed_embeddable: 99,
				embeddable_total: 100,
				trigger: "sync_incremental",
			},
		});
		queueVectorBackfillForIncrementalSync(db, {
			upsertMemoryIds: [1],
			deleteMemoryIds: [],
		});
		vi.mocked(embeddings.embedTexts).mockImplementationOnce(async () => {
			db.prepare("UPDATE memory_items SET body_text = ? WHERE id = ?").run("Updated body", 1);
			queueVectorBackfillForIncrementalSync(db, {
				upsertMemoryIds: [1],
				deleteMemoryIds: [],
			});
			return [new Float32Array(384)];
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "running",
			metadata: {
				target_model: "test-model",
				requested_model: "test-model",
				requested_revision: "test-revision",
				source_model: null,
				last_cursor_id: 0,
				processed_embeddable: 0,
				pending_upsert_memory_ids: [1],
			},
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(
			db
				.prepare("SELECT content_hash FROM memory_vectors WHERE memory_id = ? AND model = ?")
				.get(1, "test-model"),
		).toMatchObject({ content_hash: embeddings.hashText("One\nUpdated body") });
	});

	it("drains vector changes queued during a full migration before cutover", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedMemory(db, 2, sessionId, "Two", "Body two");
		seedVector(db, 1, "old-model");
		seedVector(db, 2, "old-model");
		vi.mocked(embeddings.embedTexts).mockImplementationOnce(async (texts) => {
			db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(2);
			queueVectorBackfillForIncrementalSync(db, {
				upsertMemoryIds: [],
				deleteMemoryIds: [2],
			});
			return texts.map(() => new Float32Array(384));
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "running",
			metadata: { pending_delete_memory_ids: [2] },
		});
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = ?").get("old-model"),
		).toMatchObject({ c: 2 });

		await runVectorMigrationPass(db, { batchSize: 10 });

		const completedJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(completedJob).toMatchObject({ status: "completed" });
		expect(completedJob?.metadata).not.toHaveProperty("pending_delete_memory_ids");
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ?").get(2),
		).toMatchObject({ c: 0 });
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = ?").get("old-model"),
		).toMatchObject({ c: 0 });
	});

	it("fails a queued bootstrap cleanly when embedding configuration yields no client", async () => {
		setSyncResetState(
			db,
			{
				generation: 1,
				snapshot_id: "snap-1",
				baseline_cursor: null,
			},
			"vector-work",
		);
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
						scope_id: "vector-work",
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
				scope_id: "vector-work",
			},
		);

		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValueOnce(null);
		await expect(runVectorMigrationPass(db, { batchSize: 10 })).resolves.toBeUndefined();
		expect(embeddings.resolveEmbeddingVectorIdentityLabel).not.toHaveBeenCalled();

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

	it("bounds stale-model cleanup to one resumable batch and honors abort before resuming", async () => {
		const sessionId = insertTestSession(db);
		for (let id = 1; id <= 251; id++) {
			seedMemory(db, id, sessionId, `Memory ${id}`, `Body ${id}`);
			seedVector(db, id, "old-model");
		}

		await runVectorMigrationPass(db, { batchSize: 500 });

		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = 'old-model'").get(),
		).toMatchObject({ c: 1 });
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			metadata: { cleanup_pending: true, removed_stale_rows: 250 },
		});

		const controller = new AbortController();
		controller.abort();
		await runVectorMigrationPass(db, { batchSize: 500, signal: controller.signal });
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = 'old-model'").get(),
		).toMatchObject({ c: 1 });
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			metadata: { cleanup_pending: true, removed_stale_rows: 250 },
		});

		await runVectorMigrationPass(db, { batchSize: 500 });
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = 'old-model'").get(),
		).toMatchObject({ c: 0 });
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			metadata: { cleanup_pending: false, removed_stale_rows: 251 },
		});
	});

	it("resumes stale-model cleanup after cutover completion", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedVector(db, 1, "old-model");
		seedVector(db, 1, "test-model", "obsolete-target-content");
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			metadata: {
				source_model: "old-model",
				target_model: "test-model",
				cleanup_pending: true,
				removed_stale_rows: 2,
			},
		});
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model != ?").get("test-model"),
		).toMatchObject({ c: 0 });
		expect(
			db.prepare("SELECT content_hash FROM memory_vectors WHERE model = ?").all("test-model"),
		).toEqual([{ content_hash: embeddings.hashText("One\nBody one") }]);
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			metadata: { cleanup_pending: false, removed_stale_rows: 4 },
		});
	});

	it("retries initial cleanup when memory changes after cutover validation", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "codemem-vector-initial-cleanup-fence-"));
		const dbPath = join(dbDir, "initial-cleanup-fence.sqlite");
		let fileDb: Database | null = null;
		let writerDb: Database | null = null;
		try {
			fileDb = new Database(dbPath);
			initTestSchema(fileDb);
			writerDb = new Database(dbPath);
			const sessionId = insertTestSession(fileDb);
			seedMemory(fileDb, 1, sessionId, "One", "Body one");
			seedVector(fileDb, 1, "old-model");
			let injectedWrite = false;
			const prepareSpy = vi.spyOn(fileDb, "prepare");
			prepareSpy.mockImplementation((sql: string) => {
				const statement = Database.prototype.prepare.call(fileDb, sql);
				if (sql.startsWith("SELECT rowid FROM memory_vectors WHERE model != ?")) {
					const all = statement.all.bind(statement);
					statement.all = ((...params: unknown[]) => {
						const rows = all(...params);
						if (!injectedWrite) {
							injectedWrite = true;
							writerDb
								?.prepare(
									"UPDATE memory_items SET body_text = ?, updated_at = updated_at WHERE id = 1",
								)
								.run("Redacted body");
						}
						return rows;
					}) as typeof statement.all;
				}
				return statement;
			});

			try {
				await runVectorMigrationPass(fileDb, { batchSize: 10 });
			} finally {
				prepareSpy.mockRestore();
			}

			expect(injectedWrite).toBe(true);
			expect(getMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
				status: "completed",
				message: "Memory changes arrived during cleanup; retrying",
				metadata: { cleanup_pending: true, removed_stale_rows: 0 },
			});

			await runVectorMigrationPass(fileDb, { batchSize: 10 });

			expect(getMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
				status: "completed",
				metadata: { cleanup_pending: false },
			});
			expect(fileDb.prepare("SELECT model, content_hash FROM memory_vectors").all()).toEqual([
				{
					model: "test-model",
					content_hash: embeddings.hashText("One\nRedacted body"),
				},
			]);
		} finally {
			writerDb?.close();
			fileDb?.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	it("retries resumed cleanup when memory changes after target pruning", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "codemem-vector-cleanup-fence-"));
		const dbPath = join(dbDir, "cleanup-fence.sqlite");
		let fileDb: Database | null = null;
		let writerDb: Database | null = null;
		try {
			fileDb = new Database(dbPath);
			initTestSchema(fileDb);
			writerDb = new Database(dbPath);
			const sessionId = insertTestSession(fileDb);
			seedMemory(fileDb, 1, sessionId, "One", "Body one");
			seedVector(fileDb, 1, "old-model");
			seedVector(fileDb, 1, "test-model", embeddings.hashText("One\nBody one"));
			seedVector(fileDb, 1, "test-model", "obsolete-target-content");
			startMaintenanceJob(fileDb, {
				kind: VECTOR_MODEL_MIGRATION_JOB,
				title: "Re-indexing memories",
				metadata: {
					source_model: "old-model",
					target_model: "test-model",
					cleanup_pending: true,
					trigger: "sync_incremental",
				},
			});
			completeMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB);
			let injectedWrite = false;
			const prepareSpy = vi.spyOn(fileDb, "prepare");
			prepareSpy.mockImplementation((sql: string) => {
				const statement = Database.prototype.prepare.call(fileDb, sql);
				if (sql.startsWith("SELECT rowid FROM memory_vectors WHERE model != ?")) {
					const all = statement.all.bind(statement);
					statement.all = ((...params: unknown[]) => {
						const rows = all(...params);
						if (!injectedWrite) {
							injectedWrite = true;
							writerDb
								?.prepare(
									"UPDATE memory_items SET body_text = ?, updated_at = updated_at WHERE id = 1",
								)
								.run("Redacted body");
						}
						return rows;
					}) as typeof statement.all;
				}
				return statement;
			});

			try {
				await runVectorMigrationPass(fileDb, { batchSize: 10 });
			} finally {
				prepareSpy.mockRestore();
			}

			expect(injectedWrite).toBe(true);
			expect(getMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
				status: "completed",
				message: "Memory changes arrived during cleanup; retrying",
				metadata: { cleanup_pending: true },
			});
			expect(
				fileDb.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = 'old-model'").get(),
			).toMatchObject({ c: 0 });

			await runVectorMigrationPass(fileDb, { batchSize: 10 });

			expect(getMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
				status: "completed",
				metadata: { cleanup_pending: false },
			});
			expect(
				fileDb.prepare("SELECT content_hash FROM memory_vectors WHERE model = 'test-model'").all(),
			).toEqual([{ content_hash: embeddings.hashText("One\nRedacted body") }]);
		} finally {
			writerDb?.close();
			fileDb?.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	it("does not mark reconciliation safe when target pruning stops before obsolete rows", async () => {
		const sessionId = insertTestSession(db);
		for (let id = 1; id <= 250; id++) {
			const title = `Memory ${id}`;
			const body = `Body ${id}`;
			seedMemory(db, id, sessionId, title, body);
			seedVector(db, id, "test-model", embeddings.hashText(`${title}\n${body}`));
		}
		seedVector(db, 1, "test-model", "obsolete-target-content");
		seedVector(db, 1, "old-model", "late-legacy-content");
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Re-indexing memories",
			metadata: {
				source_model: "old-model",
				target_model: "test-model",
				cleanup_pending: false,
			},
		});
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		const controller = new AbortController();
		const prepareSpy = vi.spyOn(db, "prepare");
		prepareSpy.mockImplementation((sql: string) => {
			const statement = Database.prototype.prepare.call(db, sql);
			if (sql.includes("SELECT mv.rowid AS rowid")) {
				const all = statement.all.bind(statement);
				statement.all = ((...params: unknown[]) => {
					const rows = all(...params);
					controller.abort();
					return rows;
				}) as typeof statement.all;
			}
			return statement;
		});
		const embedSpy = vi.mocked(embeddings.embedTexts);
		embedSpy.mockClear();

		try {
			await runVectorMigrationPass(db, { batchSize: 10, signal: controller.signal });
		} finally {
			prepareSpy.mockRestore();
		}

		expect(embedSpy).not.toHaveBeenCalled();
		expect(
			db
				.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE content_hash = ?")
				.get("obsolete-target-content"),
		).toMatchObject({ c: 1 });
		const job = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(job).toMatchObject({
			status: "completed",
			metadata: { cleanup_pending: true },
		});
		expect(job?.metadata.reconciliation_target_coverage_complete).not.toBe(true);
	});

	it("reconciles legacy vectors written after a completed cutover", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "codemem-vector-legacy-writer-"));
		const dbPath = join(dbDir, "legacy-writer.sqlite");
		let migrationDb: Database | null = null;
		let legacyWriterDb: Database | null = null;
		try {
			migrationDb = new Database(dbPath);
			initTestSchema(migrationDb);
			legacyWriterDb = new Database(dbPath);
			initTestSchema(legacyWriterDb);
			const sessionId = insertTestSession(migrationDb);
			seedMemory(migrationDb, 1, sessionId, "One", "Original body");
			seedVector(migrationDb, 1, "old-model");
			await runVectorMigrationPass(migrationDb, { batchSize: 10 });

			legacyWriterDb
				.prepare("UPDATE memory_items SET body_text = ? WHERE id = ?")
				.run("Changed body", 1);
			seedVector(legacyWriterDb, 1, "old-model", embeddings.hashText("One\nChanged body"));
			vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
				expect(resolveSemanticSearchModel(migrationDb, "test-model")).toBeNull();
				return texts.map(() => new Float32Array(384));
			});

			await runVectorMigrationPass(migrationDb, { batchSize: 10 });

			expect(
				migrationDb.prepare("SELECT model, content_hash FROM memory_vectors ORDER BY model").all(),
			).toEqual([
				{
					model: "test-model",
					content_hash: embeddings.hashText("One\nChanged body"),
				},
			]);
			expect(getMaintenanceJob(migrationDb, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
				status: "completed",
				metadata: { cleanup_pending: false, source_model: "old-model" },
			});
		} finally {
			legacyWriterDb?.close();
			migrationDb?.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	it("cleans a post-cutover legacy row when target coverage is still current", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");
		seedVector(db, 1, "old-model");
		await runVectorMigrationPass(db, { batchSize: 10 });
		seedVector(db, 1, "old-model", embeddings.hashText("One\nBody one"));

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(db.prepare("SELECT DISTINCT model FROM memory_vectors").pluck().all()).toEqual([
			"test-model",
		]);
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			metadata: { cleanup_pending: false },
		});
	});

	it("does not re-embed completed current-model jobs without legacy vectors", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "One", "Body one");

		await runVectorMigrationPass(db, { batchSize: 10 });
		const completedJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		expect(completedJob).toMatchObject({ status: "completed" });
		vi.mocked(embeddings.embedTexts).mockClear();

		await expect(runVectorMigrationPass(db, { batchSize: 10 })).resolves.toBeUndefined();
		expect(embeddings.embedTexts).not.toHaveBeenCalled();
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
		});
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
