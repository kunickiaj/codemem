import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSqliteVec } from "./db.js";
import * as embeddings from "./embeddings.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { backfillVectors, storeVectors } from "./vectors.js";

vi.mock("./embeddings.js", async () => {
	const actual = await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js");
	return {
		...actual,
		getEmbeddingClient: vi.fn(),
		embedTexts: vi.fn(),
	};
});

describe("vectors", () => {
	let db: InstanceType<typeof Database>;

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
	});

	afterEach(() => {
		db.close();
	});

	it("stores vectors with integer metadata columns via sqlite-vec workaround", async () => {
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);

		await expect(storeVectors(db, 123, "Title", "Body")).resolves.toBeUndefined();

		const row = db
			.prepare(
				"SELECT memory_id, chunk_index, content_hash, model FROM memory_vectors WHERE memory_id = ?",
			)
			.get(123) as
			| { memory_id: number; chunk_index: number; content_hash: string; model: string }
			| undefined;

		expect(row).toMatchObject({
			memory_id: 123,
			chunk_index: 0,
			model: "test-model",
		});
		expect(row?.content_hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rejects non-integer memory ids instead of truncating them", async () => {
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);

		await expect(storeVectors(db, 123.5, "Title", "Body")).rejects.toThrow(
			"Expected integer, received 123.5",
		);
		expect(db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get()).toMatchObject({ c: 0 });
	});

	it("backfills vectors with integer metadata columns via sqlite-vec workaround", async () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'feature', 'Backfill title', 'Backfill body', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, now, now);
		const memoryId = Number(info.lastInsertRowid);
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);

		const result = await backfillVectors(db, { memoryIds: [memoryId] });

		expect(result).toMatchObject({ checked: 1, embedded: 1, inserted: 1, skipped: 0 });
		const row = db
			.prepare(
				"SELECT memory_id, chunk_index, content_hash, model FROM memory_vectors WHERE memory_id = ?",
			)
			.get(memoryId) as
			| { memory_id: number; chunk_index: number; content_hash: string; model: string }
			| undefined;
		expect(row).toMatchObject({
			memory_id: memoryId,
			chunk_index: 0,
			model: "test-model",
		});
	});
});
