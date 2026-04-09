import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSqliteVec } from "./db.js";
import * as embeddings from "./embeddings.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { runVectorMigrationPass, VECTOR_MODEL_MIGRATION_JOB } from "./vector-migration.js";
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
		initTestSchema(db);
		loadSqliteVec(db);
		db.exec(`
			CREATE VIRTUAL TABLE memory_vectors USING vec0(
				embedding float[384],
				memory_id INTEGER,
				chunk_index INTEGER,
				content_hash TEXT,
				model TEXT
			)
		`);
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
			progress: { current: 2, total: 2, unit: "items" },
		});

		const models = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(models).toEqual([{ model: "test-model", c: 1 }]);
	});
});
