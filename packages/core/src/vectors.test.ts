import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as embeddings from "./embeddings.js";
import { startMaintenanceJob } from "./maintenance-jobs.js";
import { MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import {
	backfillVectors,
	resolveSemanticSearchModel,
	semanticSearch,
	storeVectors,
} from "./vectors.js";

vi.mock("./embeddings.js", async () => {
	const actual = await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js");
	return {
		...actual,
		getEmbeddingClient: vi.fn(),
		embedTexts: vi.fn(),
		resolveEmbeddingModel: vi.fn(() => "test-model"),
	};
});

describe("vectors", () => {
	let db: InstanceType<typeof Database>;

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

	it("keeps stale-model vectors until a migration cutover removes them", async () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'feature', 'Rebuild title', 'Rebuild body', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, now, now);
		const memoryId = Number(info.lastInsertRowid);

		// Seed a stale vector row using a different model label.
		const staleVector = new Float32Array(384);
		db.exec(`
			INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
			VALUES (
				vec_f32('${JSON.stringify(Array.from(staleVector))}'),
				${memoryId},
				0,
				'stale-hash',
				'old-model'
			)
		`);

		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);

		const result = await backfillVectors(db, { memoryIds: [memoryId] });

		expect(result).toMatchObject({ checked: 1, embedded: 1, inserted: 1 });
		const models = db
			.prepare("SELECT model, COUNT(*) AS c FROM memory_vectors GROUP BY model ORDER BY model")
			.all() as Array<{ model: string; c: number }>;
		expect(models).toEqual([
			{ model: "old-model", c: 1 },
			{ model: "test-model", c: 1 },
		]);
	});

	it("skips query embedding when vector search is disabled during migration", async () => {
		startMaintenanceJob(db, {
			kind: "vector_model_migration",
			title: "Re-indexing memories",
			metadata: { source_model: "old-model", target_model: "test-model" },
		});

		const results = await semanticSearch(db, "query text");

		expect(results).toEqual([]);
		expect(embeddings.embedTexts).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Fresh-database bootstrap coverage for memory_vectors.
// Regression guard for codemem-yco1: bootstrapSchema must create the
// sqlite-vec virtual table so the unguarded `resolveSemanticSearchModel`
// query path does not throw on a freshly auto-bootstrapped DB.
// ---------------------------------------------------------------------------

describe("memory_vectors bootstrap on fresh databases", () => {
	let tmpDir: string;
	let prevCodememConfig: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		prevCodememConfig = process.env.CODEMEM_CONFIG;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-vec-bootstrap-test-"));
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue({
			model: "test-model",
			dimensions: 384,
			embed: vi.fn(async () => [new Float32Array(384)]),
		});
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);
	});

	afterEach(() => {
		if (prevCodememConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevCodememConfig;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates memory_vectors during initTestSchema on an in-memory DB", () => {
		const scratch = new Database(":memory:");
		try {
			initTestSchema(scratch);
			const row = scratch
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'")
				.get() as { name: string } | undefined;
			expect(row?.name).toBe("memory_vectors");

			// resolveSemanticSearchModel must not throw on an empty but
			// bootstrapped DB — this is the unguarded path that previously
			// blew up when memory_vectors was missing.
			expect(() => resolveSemanticSearchModel(scratch, "test-model")).not.toThrow();
			expect(resolveSemanticSearchModel(scratch, "test-model")).toBeNull();
		} finally {
			scratch.close();
		}
	});

	it("creates memory_vectors via auto-bootstrap when constructing MemoryStore against a fresh path", async () => {
		const dbPath = join(tmpDir, "vectors-fresh.sqlite");
		// No pre-seeding — constructor discovers an uninitialized file and
		// runs ensureSchemaBootstrapped, which must now create memory_vectors.
		const store = new MemoryStore(dbPath);
		try {
			const tableRow = store.db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'")
				.get() as { name: string } | undefined;
			expect(tableRow?.name).toBe("memory_vectors");

			// Unguarded model-resolution query must succeed on a fresh DB.
			expect(() => resolveSemanticSearchModel(store.db, "test-model")).not.toThrow();

			// Round-trip: remember → flushPendingVectorWrites → semanticSearch.
			// With the mocked embedding client, storeVectors writes a vector row.
			const sessionId = insertTestSession(store.db);
			store.remember(
				sessionId,
				"discovery",
				"vectors bootstrap smoke test",
				"body text for semantic search round-trip",
			);
			await store.flushPendingVectorWrites();

			const count = store.db
				.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = ?")
				.get("test-model") as { c: number };
			expect(count.c).toBeGreaterThan(0);

			// After a successful insert, resolveSemanticSearchModel should
			// return the current model (this is the read path semanticSearch
			// relies on before embedding the query).
			expect(resolveSemanticSearchModel(store.db, "test-model")).toBe("test-model");
		} finally {
			store.close();
		}
	});
});
