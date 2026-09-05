import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as embeddings from "./embeddings.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import {
	queueVectorBackfillForIncrementalSync,
	runVectorMigrationPass,
	VECTOR_MODEL_MIGRATION_JOB,
} from "./vector-migration.js";

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

function seedMemory(db: Database, id: number, sessionId: number, body: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_items(id, session_id, kind, title, body_text, confidence,
		 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
		 VALUES (?, ?, 'feature', ?, ?, 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
	).run(id, sessionId, `Memory ${id}`, body, now, now);
}

let db: Database;

beforeEach(() => {
	vi.clearAllMocks();
	db = new Database(":memory:");
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
	db.close();
});

describe("queued vector coverage reconciliation", () => {
	it("retains an in-flight upsert when content changes before inference returns", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "Original body");
		queueVectorBackfillForIncrementalSync(db, {
			upsertMemoryIds: [1],
			deleteMemoryIds: [],
		});
		vi.mocked(embeddings.embedTexts).mockImplementationOnce(async (texts) => {
			db.prepare("UPDATE memory_items SET body_text = ? WHERE id = ?").run("Updated body", 1);
			return texts.map(() => new Float32Array(384));
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "running",
			metadata: { pending_upsert_memory_ids: [1] },
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(
			db
				.prepare("SELECT content_hash FROM memory_vectors WHERE memory_id = ? AND model = ?")
				.all(1, "test-model"),
		).toEqual([{ content_hash: embeddings.hashText("Memory 1\nUpdated body") }]);
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			metadata: { pending_upsert_memory_ids: [] },
		});
	});

	it("dequeues covered IDs while retaining redacted and concurrently queued IDs", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "Stable body");
		seedMemory(db, 2, sessionId, "Sensitive body");
		seedMemory(db, 3, sessionId, "Arrived concurrently");
		queueVectorBackfillForIncrementalSync(db, {
			upsertMemoryIds: [1, 2],
			deleteMemoryIds: [],
		});
		vi.mocked(embeddings.embedTexts).mockImplementationOnce(async (texts) => {
			db.prepare("UPDATE memory_items SET body_text = ? WHERE id = ?").run("[REDACTED]", 2);
			queueVectorBackfillForIncrementalSync(db, {
				upsertMemoryIds: [3],
				deleteMemoryIds: [],
			});
			return texts.map(() => new Float32Array(384));
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "running",
			metadata: { pending_upsert_memory_ids: [2, 3] },
		});
	});
});

describe("queued vector concurrency reconciliation", () => {
	it("merges changes queued through another connection during inference", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "codemem-vector-queue-"));
		const dbPath = join(dbDir, "queue.sqlite");
		const fileDb = new Database(dbPath);
		const writerDb = new Database(dbPath);
		try {
			initTestSchema(fileDb);
			const sessionId = insertTestSession(fileDb);
			seedMemory(fileDb, 1, sessionId, "Original body");
			seedMemory(fileDb, 2, sessionId, "Arrived concurrently");
			queueVectorBackfillForIncrementalSync(fileDb, {
				upsertMemoryIds: [1],
				deleteMemoryIds: [],
			});
			vi.mocked(embeddings.embedTexts).mockImplementationOnce(async (texts) => {
				writerDb
					.prepare("UPDATE memory_items SET body_text = ? WHERE id = ?")
					.run("Updated body", 1);
				queueVectorBackfillForIncrementalSync(writerDb, {
					upsertMemoryIds: [1, 2],
					deleteMemoryIds: [],
				});
				return texts.map(() => new Float32Array(384));
			});

			await runVectorMigrationPass(fileDb, { batchSize: 10 });

			expect(getMaintenanceJob(fileDb, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
				status: "running",
				metadata: { pending_upsert_memory_ids: [1, 2], queue_revision: 2 },
			});
		} finally {
			writerDb.close();
			fileDb.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	it("dequeues an in-flight memory that becomes inactive", async () => {
		const sessionId = insertTestSession(db);
		seedMemory(db, 1, sessionId, "Original body");
		queueVectorBackfillForIncrementalSync(db, {
			upsertMemoryIds: [1],
			deleteMemoryIds: [],
		});
		vi.mocked(embeddings.embedTexts).mockImplementationOnce(async (texts) => {
			db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(1);
			return texts.map(() => new Float32Array(384));
		});

		await runVectorMigrationPass(db, { batchSize: 10 });

		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			metadata: { pending_upsert_memory_ids: [] },
		});
	});
});
