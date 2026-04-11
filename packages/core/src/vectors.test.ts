import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbModule from "./db.js";
import * as embeddings from "./embeddings.js";
import { startMaintenanceJob } from "./maintenance-jobs.js";
import { ensureSchemaBootstrapped } from "./schema-bootstrap.js";
import { MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import {
	backfillVectors,
	getSemanticIndexDiagnostics,
	maintainVectorsForReplicationApply,
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

	it("runs best-effort replication vector maintenance without throwing on embedding failures", async () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'feature', 'Sync title', 'Sync body', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, now, now);
		const memoryId = Number(info.lastInsertRowid);

		vi.mocked(embeddings.embedTexts).mockRejectedValue(new Error("embedding unavailable"));

		const result = await maintainVectorsForReplicationApply(db, {
			upsertMemoryIds: [memoryId],
			deleteMemoryIds: [],
		});

		expect(result.inserted).toBe(0);
		expect(result.errors).toEqual(["backfill vectors failed: embedding unavailable"]);
		expect(db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get()).toMatchObject({ c: 0 });
	});

	it("reports pending semantic-index catch-up from queued maintenance job state", () => {
		startMaintenanceJob(db, {
			kind: "vector_model_migration",
			title: "Re-indexing memories",
			status: "pending",
			message: "Queued vector catch-up for synced bootstrap data",
			progressTotal: 3,
			metadata: {
				trigger: "sync_bootstrap",
				processed_embeddable: 1,
				embeddable_total: 3,
			},
		});

		const diagnostics = getSemanticIndexDiagnostics(db);

		expect(diagnostics).toMatchObject({
			state: "pending",
			mode: "keyword_only",
			pending_memory_count: 2,
			maintenance_job: {
				status: "pending",
				message: "Queued vector catch-up for synced bootstrap data",
			},
		});
	});

	it("reports degraded keyword-only mode when embeddable memories have no current vectors", () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
			 VALUES (?, 'feature', 'Needs vectors', 'Still keyword only', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
		).run(sessionId, now, now);

		const diagnostics = getSemanticIndexDiagnostics(db);

		expect(diagnostics).toMatchObject({
			state: "degraded",
			mode: "keyword_only",
			embeddable_memory_count: 1,
			indexed_memory_count: 0,
			pending_memory_count: 1,
		});
	});

	it("does not mark partially covered memories as healthy", () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		const bodyText = "semantic chunk ".repeat(5000);
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'feature', 'Chunky memory', ?, 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, bodyText, now, now);
		const memoryId = Number(info.lastInsertRowid);
		const chunks = embeddings.chunkText(`Chunky memory\n${bodyText}`);
		const firstChunk = chunks[0];
		if (!firstChunk || chunks.length < 2) {
			throw new Error("expected multi-chunk memory for partial coverage test");
		}

		db.exec(`
			INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
			VALUES (
				vec_f32('${JSON.stringify(Array.from(new Float32Array(384)))}'),
				${memoryId},
				0,
				'${embeddings.hashText(firstChunk)}',
				'test-model'
			)
		`);

		const diagnostics = getSemanticIndexDiagnostics(db);

		expect(diagnostics).toMatchObject({
			state: "pending",
			embeddable_memory_count: 1,
			indexed_memory_count: 0,
			pending_memory_count: 1,
		});
	});

	it("reports failed semantic-index catch-up from maintenance job state", () => {
		startMaintenanceJob(db, {
			kind: "vector_model_migration",
			title: "Re-indexing memories",
			status: "pending",
			progressTotal: 2,
		});
		db.prepare(
			"UPDATE maintenance_jobs SET status = 'failed', message = ?, error = ? WHERE kind = ?",
		).run(
			"Vector re-indexing is waiting for the embedding client",
			"Embedding client unavailable",
			"vector_model_migration",
		);

		const diagnostics = getSemanticIndexDiagnostics(db);

		expect(diagnostics).toMatchObject({
			state: "failed",
			summary: "Embedding client unavailable",
			maintenance_job: {
				status: "failed",
				error: "Embedding client unavailable",
			},
		});
	});

	it("falls back to live pending counts after a completed job when vectors go missing", () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
			 VALUES (?, 'feature', 'Needs vectors', 'Coverage regressed', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
		).run(sessionId, now, now);
		startMaintenanceJob(db, {
			kind: "vector_model_migration",
			title: "Re-indexing memories",
			status: "completed",
			progressCurrent: 2,
			progressTotal: 2,
			metadata: {
				embeddable_total: 2,
				processed_embeddable: 2,
			},
		});

		const diagnostics = getSemanticIndexDiagnostics(db);

		expect(diagnostics).toMatchObject({
			state: "degraded",
			pending_memory_count: 1,
			mode: "keyword_only",
		});
	});

	it("forces keyword-only degraded diagnostics when embeddings are disabled", async () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'feature', 'Has vectors', 'But runtime embeddings are disabled', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, now, now);
		const memoryId = Number(info.lastInsertRowid);
		db.exec(`
			INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
			VALUES (
				vec_f32('${JSON.stringify(Array.from(new Float32Array(384)))}'),
				${memoryId},
				0,
				'${embeddings.hashText("Has vectors\nBut runtime embeddings are disabled")}',
				'test-model'
			)
		`);
		const previous = process.env.CODEMEM_EMBEDDING_DISABLED;
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";

		const diagnostics = getSemanticIndexDiagnostics(db);
		if (previous === undefined) {
			delete process.env.CODEMEM_EMBEDDING_DISABLED;
		} else {
			process.env.CODEMEM_EMBEDDING_DISABLED = previous;
		}

		expect(diagnostics).toMatchObject({
			state: "degraded",
			mode: "keyword_only",
			summary: "Embeddings are disabled; sync data is available in keyword-only mode",
		});
	});

	it("deletes vector rows for replicated tombstones", async () => {
		const vector = new Float32Array(384);
		db.exec(`
			INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
			VALUES (
				vec_f32('${JSON.stringify(Array.from(vector))}'),
				321,
				0,
				'delete-hash',
				'test-model'
			)
		`);

		const result = await maintainVectorsForReplicationApply(db, {
			upsertMemoryIds: [],
			deleteMemoryIds: [321],
		});

		expect(result.deleted).toBe(1);
		expect(result.errors).toEqual([]);
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ?").get(321),
		).toMatchObject({ c: 0 });
	});

	it("refreshes same-model vectors for replicated content updates", async () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'feature', 'Fresh title', 'Fresh body', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, now, now);
		const memoryId = Number(info.lastInsertRowid);

		const staleVector = new Float32Array(384);
		db.exec(`
			INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
			VALUES (
				vec_f32('${JSON.stringify(Array.from(staleVector))}'),
				${memoryId},
				0,
				'stale-hash',
				'test-model'
			)
		`);
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);

		const result = await maintainVectorsForReplicationApply(db, {
			upsertMemoryIds: [memoryId],
			deleteMemoryIds: [],
		});

		expect(result.errors).toEqual([]);
		const rows = db
			.prepare(
				"SELECT content_hash FROM memory_vectors WHERE memory_id = ? AND model = ? ORDER BY chunk_index",
			)
			.all(memoryId, "test-model") as Array<{ content_hash: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.content_hash).not.toBe("stale-hash");
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

	it("returns empty results on a freshly bootstrapped database with no vectors", async () => {
		const freshDb = new Database(":memory:");
		try {
			initTestSchema(freshDb);

			const results = await semanticSearch(freshDb, "query text");

			expect(results).toEqual([]);
			expect(embeddings.embedTexts).not.toHaveBeenCalled();
		} finally {
			freshDb.close();
		}
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

	it("bootstraps the core schema even when sqlite-vec cannot load", () => {
		const scratch = new Database(":memory:");
		const loadSpy = vi.spyOn(dbModule, "loadSqliteVec").mockImplementation(() => {
			throw new Error("vec unavailable");
		});

		try {
			expect(() => ensureSchemaBootstrapped(scratch)).not.toThrow();
			expect(() => scratch.prepare("SELECT COUNT(*) AS c FROM memory_items").get()).not.toThrow();
			expect(() => resolveSemanticSearchModel(scratch, "test-model")).not.toThrow();
			expect(resolveSemanticSearchModel(scratch, "test-model")).toBeNull();
		} finally {
			loadSpy.mockRestore();
			scratch.close();
		}
	});
});
