import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbModule from "./db.js";
import type { EmbeddingClient, EmbeddingRuntimeIdentity } from "./embeddings.js";
import * as embeddings from "./embeddings.js";
import { failMaintenanceJob, startMaintenanceJob } from "./maintenance-jobs.js";
import { ensureSchemaBootstrapped } from "./schema-bootstrap.js";
import { MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import {
	backfillVectors,
	bestEffortMaintainVectorsForSyncFallback,
	countIncompleteActiveMemoryVectorCoverage,
	getSemanticIndexDiagnostics,
	pruneObsoleteTargetModelVectors,
	pruneObsoleteTargetModelVectorsWithCoverage,
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
		chunkText: vi.fn(actual.chunkText),
		getEmbeddingRuntimeStatus: vi.fn(() => ({ state: "ready" })),
		resolveEmbeddingModel: vi.fn(() => "test-model"),
		resolveEmbeddingClientVectorIdentityLabel: vi.fn(() => "test-model"),
		resolveEmbeddingVectorIdentityLabel: vi.fn(() => "test-model"),
		tryResolveEmbeddingRevision: vi.fn(() => "test-revision"),
		tryResolveEmbeddingVectorIdentityLabel: vi.fn(() => "test-model"),
	};
});

function injectedBackfillClient(
	overrides: {
		model?: string;
		dimensions?: number;
		identity?: Partial<
			Record<keyof EmbeddingRuntimeIdentity | "pooling" | "normalization", unknown>
		>;
	} = {},
): EmbeddingClient {
	const identity = {
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
	};
	return {
		model: overrides.model ?? "test-model",
		dimensions: overrides.dimensions ?? 384,
		identity: { ...identity, ...overrides.identity } as EmbeddingRuntimeIdentity,
		embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384))),
	};
}

function insertInjectedBackfillMemory(db: InstanceType<typeof Database>): number {
	const sessionId = insertTestSession(db);
	const createdAt = "2026-09-05T00:00:00.000Z";
	const info = db
		.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
			 VALUES (?, 'feature', 'Injected client', 'Backfill body', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
		)
		.run(sessionId, createdAt, createdAt);
	return Number(info.lastInsertRowid);
}

const invalidInjectedBackfillClients: Array<{
	caseName: string;
	createClient: () => EmbeddingClient;
	error: string;
}> = [
	{
		caseName: "empty model",
		createClient: () => injectedBackfillClient({ model: "", identity: { model: "" } }),
		error: "model must be a non-empty string",
	},
	{
		caseName: "client model",
		createClient: () => injectedBackfillClient({ model: "other-model" }),
		error: "client model mismatch",
	},
	{
		caseName: "client dimensions",
		createClient: () => injectedBackfillClient({ dimensions: 768 }),
		error: "client dimensions mismatch",
	},
	{
		caseName: "revision",
		createClient: () => injectedBackfillClient({ identity: { revision: "main" } }),
		error: "revision is not a canonical commit SHA",
	},
	{
		caseName: "package",
		createClient: () => injectedBackfillClient({ identity: { package: "other-package" } }),
		error: "identity mismatch for package",
	},
	{
		caseName: "older runtime major version",
		createClient: () => injectedBackfillClient({ identity: { version: "3.0.0" } }),
		error: "identity mismatch for version",
	},
	{
		caseName: "newer runtime major version",
		createClient: () => injectedBackfillClient({ identity: { version: "5.0.0" } }),
		error: "identity mismatch for version",
	},
	{
		caseName: "dtype",
		createClient: () => injectedBackfillClient({ identity: { dtype: "fp16" } }),
		error: "identity mismatch for dtype",
	},
	{
		caseName: "device",
		createClient: () => injectedBackfillClient({ identity: { device: "gpu" } }),
		error: "identity mismatch for device",
	},
	{
		caseName: "pooling",
		createClient: () => injectedBackfillClient({ identity: { pooling: "cls" } }),
		error: "identity mismatch for pooling",
	},
	{
		caseName: "normalization",
		createClient: () => injectedBackfillClient({ identity: { normalization: "none" } }),
		error: "identity mismatch for normalization",
	},
	{
		caseName: "identity dimensions",
		createClient: () => injectedBackfillClient({ identity: { dimensions: 768 } }),
		error: "identity mismatch for dimensions",
	},
];

describe("vectors", () => {
	let db: InstanceType<typeof Database>;

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
				pooling: "mean",
				normalization: "l2",
				dimensions: 384,
			},
			embed: vi.fn(),
		});
		vi.mocked(embeddings.getEmbeddingRuntimeStatus).mockReturnValue({ state: "ready" });
	});

	afterEach(() => {
		db.close();
	});

	function insertCoordinatorScope(scopeId: string): void {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT OR REPLACE INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES (?, ?, 'team', 'coordinator', 'coord-test', 'group-test', 0, 'active', ?, ?)`,
		).run(scopeId, scopeId, now, now);
	}

	function grantScopeToDevice(scopeId: string, deviceId: string): void {
		insertCoordinatorScope(scopeId);
		db.prepare(
			`INSERT OR REPLACE INTO scope_memberships(
				scope_id, device_id, role, status, membership_epoch,
				coordinator_id, group_id, updated_at
			 ) VALUES (?, ?, 'member', 'active', 0, 'coord-test', 'group-test', ?)`,
		).run(scopeId, deviceId, new Date().toISOString());
	}

	function insertScopedMemory(scopeId: string, title: string, bodyText: string): number {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility, scope_id)
				 VALUES (?, 'discovery', ?, ?, 0.5, '', 1, ?, ?, '{}', 1, 'shared', ?)`,
			)
			.run(sessionId, title, bodyText, now, now, scopeId);
		return Number(info.lastInsertRowid);
	}

	function insertTestVector(
		memoryId: number,
		value: number,
		contentHash: string,
		model = "test-model",
	): void {
		const vector = new Float32Array(384).fill(value);
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

	function insertBackfillMemory(
		sessionId: number,
		title: string,
		createdAt: string,
		bodyText = "Backfill body",
	): number {
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'feature', ?, ?, 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, title, bodyText, createdAt, createdAt);
		return Number(info.lastInsertRowid);
	}

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

	it("rejects an injected client without runtime identity", async () => {
		await expect(
			backfillVectors(db, {
				client: {
					model: "test-model",
					dimensions: 384,
					embed: vi.fn(),
				},
			}),
		).rejects.toThrow("Embedding runtime identity is required");
		expect(embeddings.resolveEmbeddingClientVectorIdentityLabel).not.toHaveBeenCalled();
	});

	it("stops obsolete target pruning when aborted between batches", () => {
		const sessionId = insertTestSession(db);
		const memoryId = insertBackfillMemory(sessionId, "Current", "2026-09-01T00:00:00.000Z", "body");
		insertTestVector(memoryId, 0, embeddings.hashText("Current\nbody"));
		for (let index = 0; index <= 250; index++) {
			insertTestVector(memoryId, 0, `obsolete-${index}`);
		}
		const controller = new AbortController();
		let scanPageReads = 0;
		const prepareSpy = vi.spyOn(db, "prepare");
		prepareSpy.mockImplementation((sql: string) => {
			const statement = Database.prototype.prepare.call(db, sql);
			if (sql.includes("vector-target-prune-rowids")) {
				const all = statement.all.bind(statement);
				statement.all = ((...params: unknown[]) => {
					const result = all(...params);
					scanPageReads++;
					if (scanPageReads === 2) controller.abort();
					return result;
				}) as typeof statement.all;
			}
			return statement;
		});

		try {
			expect(pruneObsoleteTargetModelVectors(db, "test-model", { signal: controller.signal })).toBe(
				0,
			);
		} finally {
			prepareSpy.mockRestore();
		}
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = ?").get("test-model"),
		).toMatchObject({ c: 252 });
		expect(
			db.prepare("SELECT name FROM temp.sqlite_schema WHERE name = 'vector_prune_scan'").get(),
		).toBeUndefined();
	});

	it("pages stably and queries existing hashes once per page", async () => {
		const sessionId = insertTestSession(db);
		const createdAt = "2026-09-02T00:00:00.000Z";
		let firstExistingId = 0;
		let lastExistingId = 0;
		for (let index = 1; index <= 51; index++) {
			lastExistingId = insertBackfillMemory(sessionId, `Backfill ${index}`, createdAt);
			if (index === 1) firstExistingId = lastExistingId;
		}
		insertTestVector(firstExistingId, 0, embeddings.hashText("Backfill 1\nBackfill body"));
		let insertedBehindCursorId: number | null = null;
		let insertedAheadOfHighWaterId: number | null = null;
		let pagingPlan: Array<{ detail: string }> = [];
		const embedSpy = vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
			if (insertedBehindCursorId == null) {
				const pageSql = prepareSpy.mock.calls.find(([sql]) =>
					String(sql).includes("candidates.seq AS snapshot_seq"),
				)?.[0];
				if (!pageSql) throw new Error("Backfill page query was not prepared");
				pagingPlan = db.prepare(`EXPLAIN QUERY PLAN ${String(pageSql)}`).all(0, 50) as Array<{
					detail: string;
				}>;
				insertedBehindCursorId = insertBackfillMemory(
					sessionId,
					"Inserted during run",
					"2026-09-01T00:00:00.000Z",
				);
				insertedAheadOfHighWaterId = insertBackfillMemory(
					sessionId,
					"Inserted after run started",
					"2026-09-03T00:00:00.000Z",
				);
			}
			return texts.map(() => new Float32Array(384));
		});
		const prepareSpy = vi.spyOn(db, "prepare");

		try {
			const result = await backfillVectors(db);

			expect(result).toEqual({ checked: 51, embedded: 50, inserted: 50, skipped: 1 });
			expect(embedSpy.mock.calls.map(([texts]) => texts.length)).toEqual([32, 17, 1]);
			expect(
				pagingPlan.some(({ detail }) =>
					detail.startsWith("SEARCH candidates USING INTEGER PRIMARY KEY"),
				),
			).toBe(true);
			expect(pagingPlan.some(({ detail }) => detail.includes("USE TEMP B-TREE"))).toBe(false);
			expect(
				prepareSpy.mock.calls.filter(([sql]) =>
					String(sql).includes("SELECT memory_id, content_hash FROM memory_vectors"),
				),
			).toHaveLength(2);
			expect(db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get()).toMatchObject({ c: 51 });
			expect(
				db
					.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ?")
					.get(lastExistingId),
			).toMatchObject({ c: 1 });
			expect(
				db
					.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ?")
					.get(insertedBehindCursorId),
			).toMatchObject({ c: 0 });
			expect(
				db
					.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ?")
					.get(insertedAheadOfHighWaterId),
			).toMatchObject({ c: 0 });
		} finally {
			prepareSpy.mockRestore();
		}
	});

	it("excludes backdated rows inserted after the backfill snapshot", async () => {
		const sessionId = insertTestSession(db);
		for (let index = 1; index <= 50; index++) {
			insertBackfillMemory(sessionId, `Initial ${index}`, "2026-09-01T00:00:00.000Z");
		}
		insertBackfillMemory(sessionId, "Initial high-water", "2026-09-03T00:00:00.000Z");
		let backdatedId: number | null = null;
		vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
			if (backdatedId == null) {
				backdatedId = insertBackfillMemory(
					sessionId,
					"Backdated during run",
					"2026-09-02T00:00:00.000Z",
				);
			}
			return texts.map(() => new Float32Array(384));
		});

		const result = await backfillVectors(db);

		expect(result).toEqual({ checked: 51, embedded: 51, inserted: 51, skipped: 0 });
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ?").get(backdatedId),
		).toMatchObject({ c: 0 });
	});

	it("excludes memories that become eligible after the backfill snapshot", async () => {
		const sessionId = insertTestSession(db);
		for (let index = 1; index <= 50; index++) {
			insertBackfillMemory(sessionId, `Initial ${index}`, "2026-09-01T00:00:00.000Z");
		}
		const initiallyInactiveId = insertBackfillMemory(
			sessionId,
			"Initially inactive",
			"2026-09-02T00:00:00.000Z",
		);
		db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(initiallyInactiveId);
		const finalInitialId = insertBackfillMemory(
			sessionId,
			"Final initial",
			"2026-09-03T00:00:00.000Z",
		);
		vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
			db.prepare("UPDATE memory_items SET active = 1 WHERE id = ?").run(initiallyInactiveId);
			return texts.map(() => new Float32Array(384));
		});

		const result = await backfillVectors(db, { limit: 51 });

		expect(result).toEqual({ checked: 51, embedded: 51, inserted: 51, skipped: 0 });
		expect(
			db
				.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ?")
				.get(finalInitialId),
		).toMatchObject({ c: 1 });
		expect(
			db
				.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ?")
				.get(initiallyInactiveId),
		).toMatchObject({ c: 0 });
	});

	it("does not duplicate a chunk a concurrent writer inserted mid-run", async () => {
		const sessionId = insertTestSession(db);
		const memoryId = insertBackfillMemory(sessionId, "Concurrent", "2026-09-01T00:00:00.000Z");
		const contentHash = embeddings.hashText("Concurrent\nBackfill body");
		vi.mocked(embeddings.embedTexts).mockImplementationOnce(async (texts) => {
			// Simulate a concurrent writer (e.g. the migration worker) inserting
			// this exact (memory_id, model, content_hash) after the page-wide
			// existing-hash snapshot was taken but before this insert transaction.
			insertTestVector(memoryId, 0, contentHash);
			return texts.map(() => new Float32Array(384));
		});

		const result = await backfillVectors(db, { memoryIds: [memoryId] });

		expect(result).toMatchObject({ checked: 1, embedded: 1, inserted: 0 });
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ? AND content_hash = ?",
				)
				.get(memoryId, contentHash),
		).toMatchObject({ c: 1 });
	});

	it("treats a whitespace-only memory as fully covered", () => {
		const sessionId = insertTestSession(db);
		// Tabs/newlines survive SQLite's one-argument TRIM, so the row is active in
		// the coverage query, but chunkText yields no chunks — it must not be
		// counted as incomplete or migration could never reach cutover.
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
			 VALUES (?, 'feature', '\t', '\n\n', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
		).run(sessionId, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");

		expect(countIncompleteActiveMemoryVectorCoverage(db, "test-model")).toBe(0);
	});

	it("fetches target hashes per bounded validation page", () => {
		const sessionId = insertTestSession(db);
		const insert = db.prepare(
			`INSERT INTO memory_items(id, session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
			 VALUES (?, ?, 'feature', ?, ?, 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
		);
		const now = "2026-09-01T00:00:00.000Z";
		db.transaction(() => {
			for (let id = 1; id <= 250; id++) insert.run(id, sessionId, "\t", "\n", now, now);
			insert.run(251, sessionId, "Uncovered", "memory", now, now);
		})();
		const prepareSpy = vi.spyOn(db, "prepare");

		try {
			expect(countIncompleteActiveMemoryVectorCoverage(db, "test-model")).toBe(1);
			const hashQueries = prepareSpy.mock.calls
				.map(([sql]) => String(sql))
				.filter((sql) => sql.includes("vector-coverage-validation"));
			expect(hashQueries).toHaveLength(2);
			expect(hashQueries.every((sql) => sql.includes("memory_id IN"))).toBe(true);
			expect(hashQueries.map((sql) => (sql.match(/\?/g) ?? []).length)).toEqual([251, 2]);
		} finally {
			prepareSpy.mockRestore();
		}
	});

	it("prunes obsolete target rows beyond the bounded cleanup batch", () => {
		const sessionId = insertTestSession(db);
		const memoryId = insertBackfillMemory(sessionId, "Current", "2026-09-01T00:00:00.000Z", "body");
		insertTestVector(memoryId, 0, embeddings.hashText("Current\nbody"));
		for (let index = 0; index <= 250; index++) {
			insertTestVector(memoryId, 0, `obsolete-${index}`);
		}

		expect(pruneObsoleteTargetModelVectors(db, "test-model")).toBe(251);
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = ?").get("test-model"),
		).toMatchObject({ c: 1 });
	});

	it("bounds pruning query results and drops the spill table", () => {
		const sessionId = insertTestSession(db);
		const now = "2026-09-01T00:00:00.000Z";
		const insertMemory = db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
			 VALUES (?, 'feature', ?, 'body', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
		);
		db.transaction(() => {
			for (let index = 1; index <= 1_000; index++) {
				const title = `Memory ${index}`;
				const memoryId = Number(insertMemory.run(sessionId, title, now, now).lastInsertRowid);
				insertTestVector(memoryId, 0, embeddings.hashText(`${title}\nbody`));
				insertTestVector(memoryId, 0, `obsolete-a-${index}`);
				insertTestVector(memoryId, 0, `obsolete-b-${index}`);
			}
		})();
		const allResultSizes: number[] = [];
		const prepareSpy = vi.spyOn(db, "prepare");
		prepareSpy.mockImplementation((sql: string) => {
			const statement = Database.prototype.prepare.call(db, sql);
			const all = statement.all.bind(statement);
			statement.all = ((...params: unknown[]) => {
				const rows = all(...params);
				allResultSizes.push(rows.length);
				return rows;
			}) as typeof statement.all;
			return statement;
		});

		try {
			expect(pruneObsoleteTargetModelVectors(db, "test-model")).toBe(2_000);
		} finally {
			prepareSpy.mockRestore();
		}
		expect(Math.max(...allResultSizes)).toBeLessThanOrEqual(250);
		expect(
			db.prepare("SELECT name FROM temp.sqlite_schema WHERE name = 'vector_prune_scan'").get(),
		).toBeUndefined();
	});

	it("spills the prune scan to disk and restores temp_store afterwards", () => {
		// The connection defaults to temp_store=MEMORY (db.ts read tuning). If the
		// prune left that in place the spill would live in SQLite's heap and peak
		// memory would still be O(total vectors), which is the OOM Codex flagged.
		// temp_store values: 0=DEFAULT, 1=FILE, 2=MEMORY.
		db.pragma("temp_store = MEMORY");
		expect(db.pragma("temp_store", { simple: true })).toBe(2);
		const sessionId = insertTestSession(db);
		const memoryId = insertBackfillMemory(sessionId, "Spill", "2026-09-01T00:00:00.000Z");
		// A covering row keeps the memory "complete" so the obsolete sibling is
		// actually eligible for pruning; an incomplete memory is left untouched.
		insertTestVector(memoryId, 0, embeddings.hashText("Spill\nBackfill body"));
		insertTestVector(memoryId, 0, "obsolete");

		let tempStoreDuringSpill: number | null = null;
		const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			const statement = Database.prototype.prepare.call(db, sql);
			if (sql.startsWith("INSERT INTO temp.vector_prune_scan")) {
				const run = statement.run.bind(statement);
				statement.run = ((...params: unknown[]) => {
					tempStoreDuringSpill ??= db.pragma("temp_store", { simple: true }) as number;
					return run(...params);
				}) as typeof statement.run;
			}
			return statement;
		});
		try {
			expect(pruneObsoleteTargetModelVectors(db, "test-model")).toBe(1);
		} finally {
			prepareSpy.mockRestore();
		}
		expect(tempStoreDuringSpill).toBe(1);
		expect(db.pragma("temp_store", { simple: true })).toBe(2);
	});

	it("deletes target rows for inactive and missing memories", () => {
		const sessionId = insertTestSession(db);
		const inactiveId = insertBackfillMemory(sessionId, "Inactive", "2026-09-01T00:00:00.000Z");
		db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(inactiveId);
		insertTestVector(inactiveId, 0, "inactive-hash");
		insertTestVector(999_999, 0, "missing-hash");

		expect(pruneObsoleteTargetModelVectors(db, "test-model")).toBe(2);
		expect(db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get()).toMatchObject({ c: 0 });
	});

	it("does not lock main-database writers while spilling a scan page", () => {
		db.close();
		const directory = mkdtempSync(join(tmpdir(), "codemem-vector-prune-lock-"));
		const dbPath = join(directory, "mem.sqlite");
		db = dbModule.connect(dbPath);
		const otherDb = dbModule.connect(dbPath);
		otherDb.pragma("busy_timeout = 0");
		const sessionId = insertTestSession(db);
		const memoryId = insertBackfillMemory(sessionId, "Current", "2026-09-01T00:00:00.000Z", "body");
		insertTestVector(memoryId, 0, embeddings.hashText("Current\nbody"));
		const now = "2026-09-01T00:00:00.000Z";
		const concurrentInsert = otherDb.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
			 VALUES (?, 'feature', 'Concurrent', 'write', 0.5, '', 0, ?, ?, '{}', 1, 'shared')`,
		);
		let concurrentMemoryId: number | null = null;
		const prepareSpy = vi.spyOn(db, "prepare");
		prepareSpy.mockImplementation((sql: string) => {
			const statement = Database.prototype.prepare.call(db, sql);
			if (sql.startsWith("INSERT INTO temp.vector_prune_scan")) {
				const run = statement.run.bind(statement);
				statement.run = ((...params: unknown[]) => {
					const result = run(...params);
					if (concurrentMemoryId == null) {
						concurrentMemoryId = Number(concurrentInsert.run(sessionId, now, now).lastInsertRowid);
					}
					return result;
				}) as typeof statement.run;
			}
			return statement;
		});

		try {
			expect(pruneObsoleteTargetModelVectors(db, "test-model")).toBe(0);
			expect(concurrentMemoryId).not.toBeNull();
			expect(
				db.prepare("SELECT id FROM memory_items WHERE id = ?").get(concurrentMemoryId),
			).toEqual({
				id: concurrentMemoryId,
			});
		} finally {
			prepareSpy.mockRestore();
			otherDb.close();
			db.close();
			db = new Database(":memory:");
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps vec0 metadata scans outside delete transactions", () => {
		const sessionId = insertTestSession(db);
		const memoryId = insertBackfillMemory(sessionId, "Current", "2026-09-01T00:00:00.000Z", "body");
		insertTestVector(memoryId, 0, embeddings.hashText("Current\nbody"));
		for (let index = 0; index < 999; index++) {
			insertTestVector(memoryId, 0, `obsolete-plan-${index}`);
		}
		const pointLookupPlans = (
			db
				.prepare(
					"EXPLAIN QUERY PLAN SELECT memory_id, content_hash, model FROM memory_vectors WHERE rowid = ?",
				)
				.all(1) as Array<{ detail: string }>
		).map(({ detail }) => detail);
		let metadataReadsInTransaction = 0;
		const prepareSpy = vi.spyOn(db, "prepare");
		prepareSpy.mockImplementation((sql: string) => {
			const statement = Database.prototype.prepare.call(db, sql);
			if (sql === "SELECT memory_id, content_hash, model FROM memory_vectors WHERE rowid = ?") {
				const get = statement.get.bind(statement);
				statement.get = ((...params: unknown[]) => {
					if (db.inTransaction) metadataReadsInTransaction++;
					return get(...params);
				}) as typeof statement.get;
			}
			return statement;
		});

		try {
			expect(pruneObsoleteTargetModelVectors(db, "test-model")).toBe(999);
		} finally {
			prepareSpy.mockRestore();
		}
		expect(metadataReadsInTransaction).toBe(0);
		expect(pointLookupPlans.length).toBeGreaterThan(0);
		expect(pointLookupPlans.some((detail) => detail.includes("VIRTUAL TABLE"))).toBe(true);
		expect(
			pointLookupPlans.every(
				(detail) => !detail.includes("INDEX 0") && !detail.toLowerCase().includes("fullscan"),
			),
		).toBe(true);
	});

	it("retains obsolete target rows while current target coverage is incomplete", () => {
		const sessionId = insertTestSession(db);
		const bodyText = "Long semantic content. ".repeat(200);
		const memoryId = insertBackfillMemory(
			sessionId,
			"Partially covered",
			"2026-09-01T00:00:00.000Z",
			bodyText,
		);
		const chunks = embeddings.chunkText(`Partially covered\n${bodyText}`);
		expect(chunks.length).toBeGreaterThan(1);
		const firstChunk = chunks[0];
		if (!firstChunk) throw new Error("expected at least one chunk");
		insertTestVector(memoryId, 0, embeddings.hashText(firstChunk));
		insertTestVector(memoryId, 0, "obsolete-target-hash");

		expect(pruneObsoleteTargetModelVectorsWithCoverage(db, "test-model")).toEqual({
			deleted: 0,
			incompleteActiveCoverage: 1,
		});
		expect(
			db.prepare("SELECT content_hash FROM memory_vectors WHERE memory_id = ?").all(memoryId),
		).toEqual(
			expect.arrayContaining([
				{ content_hash: embeddings.hashText(firstChunk) },
				{ content_hash: "obsolete-target-hash" },
			]),
		);
	});

	it("indexes candidate snapshots without a temporary sort", () => {
		const indexColumns = db
			.prepare("PRAGMA index_xinfo(idx_memory_items_created_id)")
			.all() as Array<{ name: string | null; key: number }>;
		expect(indexColumns.filter(({ key }) => key === 1).map(({ name }) => name)).toEqual([
			"created_at",
			"id",
		]);

		for (const [sql, params, expectedIndex] of [
			[
				`EXPLAIN QUERY PLAN SELECT id, created_at FROM memory_items
				 WHERE 1=1
				 ORDER BY created_at ASC, id ASC LIMIT ?`,
				[50],
				"idx_memory_items_created_id",
			],
			[
				`EXPLAIN QUERY PLAN SELECT id, created_at FROM memory_items
				 WHERE active = 1
				 ORDER BY created_at ASC, id ASC LIMIT ?`,
				[50],
				"idx_memory_items_active_created",
			],
		] as const) {
			const plan = db.prepare(sql).all(...params) as Array<{ detail: string }>;
			expect(plan.some(({ detail }) => detail.includes(expectedIndex))).toBe(true);
			expect(plan.some(({ detail }) => detail.includes("USE TEMP B-TREE"))).toBe(false);
		}
	});

	it("honors a limit smaller than one page", async () => {
		const sessionId = insertTestSession(db);
		const createdAt = new Date().toISOString();
		for (let index = 1; index <= 20; index++) {
			insertBackfillMemory(sessionId, `Limited ${index}`, createdAt);
		}
		let snapshottedRows: number | null = null;
		const embedSpy = vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
			if (snapshottedRows == null) {
				const snapshot = db
					.prepare(
						`SELECT name FROM sqlite_temp_master
						 WHERE type = 'table' AND name LIKE 'codemem_backfill_vector_candidates_%'`,
					)
					.get() as { name: string } | undefined;
				if (!snapshot) throw new Error("Backfill candidate snapshot table was not created");
				expect(snapshot.name).toMatch(/^codemem_backfill_vector_candidates_[a-f0-9]+$/);
				const count = db.prepare(`SELECT COUNT(*) AS c FROM "${snapshot.name}"`).get() as {
					c: number;
				};
				snapshottedRows = count.c;
			}
			return texts.map(() => new Float32Array(384));
		});

		const result = await backfillVectors(db, { limit: 7 });

		expect(result).toEqual({ checked: 7, embedded: 7, inserted: 7, skipped: 0 });
		expect(snapshottedRows).toBe(7);
		expect(embedSpy.mock.calls.map(([texts]) => texts.length)).toEqual([7]);
		expect(
			db
				.prepare(
					`SELECT COUNT(*) AS c FROM sqlite_temp_master
					 WHERE type = 'table' AND name LIKE 'codemem_backfill_vector_candidates_%'`,
				)
				.get(),
		).toMatchObject({ c: 0 });
	});

	it("prepares page chunks incrementally instead of retaining the full page", async () => {
		const sessionId = insertTestSession(db);
		const createdAt = new Date().toISOString();
		for (let index = 1; index <= 50; index++) {
			insertBackfillMemory(sessionId, `Incremental ${index}`, createdAt);
		}
		let chunkCallsAtFirstInference: number | null = null;
		const embedSpy = vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
			chunkCallsAtFirstInference ??= vi.mocked(embeddings.chunkText).mock.calls.length;
			return texts.map(() => new Float32Array(384));
		});

		const result = await backfillVectors(db);

		expect(result).toEqual({ checked: 50, embedded: 50, inserted: 50, skipped: 0 });
		expect(embedSpy.mock.calls.map(([texts]) => texts.length)).toEqual([32, 18]);
		expect(chunkCallsAtFirstInference).toBe(32);
	});

	it("preserves dry-run counts without storing vectors", async () => {
		const sessionId = insertTestSession(db);
		const createdAt = new Date().toISOString();
		for (let index = 1; index <= 3; index++) {
			insertBackfillMemory(sessionId, `Dry run ${index}`, createdAt);
		}
		const embedSpy = vi
			.mocked(embeddings.embedTexts)
			.mockImplementation(async (texts) => texts.map(() => new Float32Array(384)));

		const result = await backfillVectors(db, { dryRun: true });

		expect(result).toEqual({ checked: 3, embedded: 3, inserted: 3, skipped: 0 });
		expect(embedSpy.mock.calls.map(([texts]) => texts.length)).toEqual([3]);
		expect(db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get()).toMatchObject({ c: 0 });
	});

	it("isolates overlapping backfill snapshots on one connection", async () => {
		const sessionId = insertTestSession(db);
		const firstId = insertBackfillMemory(sessionId, "First run", "2026-09-01T00:00:00.000Z");
		const secondId = insertBackfillMemory(sessionId, "Second run", "2026-09-02T00:00:00.000Z");
		let nestedResult: Awaited<ReturnType<typeof backfillVectors>> | null = null;
		let nested = false;
		let maximumSnapshotCount = 0;
		vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
			const snapshotCount = db
				.prepare(
					`SELECT COUNT(*) AS c FROM sqlite_temp_master
					 WHERE type = 'table' AND name LIKE 'codemem_backfill_vector_candidates_%'`,
				)
				.get() as { c: number };
			maximumSnapshotCount = Math.max(maximumSnapshotCount, snapshotCount.c);
			if (!nested) {
				nested = true;
				nestedResult = await backfillVectors(db, { memoryIds: [secondId] });
			}
			return texts.map(() => new Float32Array(384));
		});

		const outerResult = await backfillVectors(db, { memoryIds: [firstId] });

		expect(outerResult).toMatchObject({ checked: 1, inserted: 1 });
		expect(nestedResult).toMatchObject({ checked: 1, inserted: 1 });
		expect(maximumSnapshotCount).toBe(2);
		expect(
			db
				.prepare(
					`SELECT COUNT(*) AS c FROM sqlite_temp_master
					 WHERE type = 'table' AND name LIKE 'codemem_backfill_vector_candidates_%'`,
				)
				.get(),
		).toMatchObject({ c: 0 });
	});

	it("keeps a memory atomic when aborting across the 32-chunk boundary", async () => {
		const sessionId = insertTestSession(db);
		const createdAt = new Date().toISOString();
		const shortId = insertBackfillMemory(sessionId, "Short memory", createdAt);
		const longBody = "x".repeat(1200 * 40);
		const longId = insertBackfillMemory(sessionId, "Long memory", createdAt, longBody);
		const longChunkCount = embeddings.chunkText(`Long memory\n${longBody}`).length;
		expect(longChunkCount).toBeGreaterThan(32);
		const controller = new AbortController();
		const firstPassEmbed = vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
			controller.abort();
			return texts.map(() => new Float32Array(384));
		});

		const aborted = await backfillVectors(db, { signal: controller.signal });

		expect(firstPassEmbed.mock.calls.map(([texts]) => texts.length)).toEqual([32]);
		expect(aborted).toEqual({ checked: 2, embedded: 32, inserted: 1, skipped: 0 });
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ?").get(shortId),
		).toMatchObject({ c: 1 });
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ?").get(longId),
		).toMatchObject({ c: 0 });

		const retryEmbed = vi.mocked(embeddings.embedTexts);
		retryEmbed.mockClear();
		retryEmbed.mockImplementation(async (texts) => texts.map(() => new Float32Array(384)));
		const retried = await backfillVectors(db);

		expect(retryEmbed.mock.calls.map(([texts]) => texts.length)).toEqual([32, longChunkCount - 32]);
		expect(retried).toEqual({
			checked: 2,
			embedded: longChunkCount,
			inserted: longChunkCount,
			skipped: 1,
		});
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE memory_id = ?").get(longId),
		).toMatchObject({ c: longChunkCount });
	});

	it.each(["zero", "dimension", "non-finite"] as const)(
		"rejects %s output before writing the current memory",
		async (failure) => {
			const sessionId = insertTestSession(db);
			const body = "A deterministic sentence. ".repeat(150);
			insertBackfillMemory(sessionId, "Malformed vectors", new Date().toISOString(), body);
			vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => {
				if (failure === "zero") return [];
				expect(texts.length).toBeGreaterThan(1);
				const vectors = texts.map(() => new Float32Array(384));
				const last = vectors.at(-1);
				if (!last) throw new Error("expected multiple chunks");
				if (failure === "dimension") vectors[vectors.length - 1] = new Float32Array(383);
				else last[0] = Number.NaN;
				return vectors;
			});

			await expect(backfillVectors(db)).rejects.toThrow();
			expect(db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get()).toMatchObject({ c: 0 });
			expect(
				db
					.prepare(
						`SELECT COUNT(*) AS c FROM sqlite_temp_master
						 WHERE type = 'table' AND name LIKE 'codemem_backfill_vector_candidates_%'`,
					)
					.get(),
			).toMatchObject({ c: 0 });
		},
	);

	it("runs best-effort sync fallback vector maintenance without throwing on embedding failures", async () => {
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

		const result = await bestEffortMaintainVectorsForSyncFallback(db, {
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

	it("reports degraded keyword-only mode when the embedding runtime is unavailable", () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		const info = db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'feature', 'Indexed', 'Runtime unavailable', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, now, now);
		const memoryId = Number(info.lastInsertRowid);
		db.exec(`
			INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
			VALUES (
				vec_f32('${JSON.stringify(Array.from(new Float32Array(384)))}'),
				${memoryId},
				0,
				'${embeddings.hashText("Indexed\nRuntime unavailable")}',
				'test-model'
			)
		`);
		vi.mocked(embeddings.getEmbeddingRuntimeStatus).mockReturnValue({
			state: "unavailable",
			reason: "initialization_failed",
		});

		expect(getSemanticIndexDiagnostics(db)).toMatchObject({
			state: "degraded",
			mode: "keyword_only",
			semantic_search_model: "test-model",
			indexed_memory_count: 1,
			pending_memory_count: 0,
			summary: "The embedding runtime is unavailable; sync data is available in keyword-only mode",
		});
	});

	it("reports a missing custom-model revision without resolving or querying a vector identity", () => {
		const sessionId = insertTestSession(db);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
			 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
			 VALUES (?, 'feature', 'Needs revision', 'Keyword fallback stays available', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
		).run(sessionId, now, now);
		vi.mocked(embeddings.resolveEmbeddingModel).mockReturnValue("custom/model");
		vi.mocked(embeddings.tryResolveEmbeddingRevision).mockReturnValue(null);
		vi.mocked(embeddings.tryResolveEmbeddingVectorIdentityLabel).mockReturnValue(null);

		expect(resolveSemanticSearchModel(db)).toBeNull();
		expect(() => getSemanticIndexDiagnostics(db)).not.toThrow();
		expect(getSemanticIndexDiagnostics(db)).toMatchObject({
			state: "degraded",
			mode: "keyword_only",
			current_model: "custom/model (missing CODEMEM_EMBEDDING_REVISION)",
			semantic_search_model: null,
			indexed_memory_count: 0,
			summary:
				"Semantic search is unavailable because custom/model has no CODEMEM_EMBEDDING_REVISION; keyword search remains available",
		});
		expect(embeddings.resolveEmbeddingClientVectorIdentityLabel).not.toHaveBeenCalled();
	});

	it("keeps serving compatible legacy vectors until a verified target cutover", () => {
		const currentModel = embeddings.DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
		const legacyModel = "Xenova/bge-small-en-v1.5";
		insertTestVector(1, 0, "legacy-hash", legacyModel);
		insertTestVector(2, 0, "target-hash", currentModel);

		expect(resolveSemanticSearchModel(db, currentModel)).toBe(legacyModel);

		startMaintenanceJob(db, {
			kind: "vector_model_migration",
			title: "Different target completed",
			status: "completed",
			metadata: {
				source_model: legacyModel,
				target_model: "different-target",
			},
		});
		expect(resolveSemanticSearchModel(db, currentModel)).toBe(legacyModel);
	});

	it("serves covered target vectors when a compatible rebuild has exhausted legacy rows", () => {
		const currentModel = embeddings.DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
		const legacyModel = "Xenova/bge-small-en-v1.5";
		insertTestVector(1, 0, "target-hash", currentModel);
		startMaintenanceJob(db, {
			kind: "vector_model_migration",
			title: "Compatible rebuild",
			status: "running",
			metadata: { source_model: legacyModel, target_model: currentModel },
		});

		expect(resolveSemanticSearchModel(db, currentModel)).toBe(currentModel);
		db.prepare("UPDATE maintenance_jobs SET status = 'failed' WHERE kind = ?").run(
			"vector_model_migration",
		);
		expect(resolveSemanticSearchModel(db, currentModel)).toBe(currentModel);
	});

	it("keeps serving complete target coverage during legacy-write reconciliation", () => {
		insertTestVector(1, 0, "target-hash", "test-model");
		insertTestVector(2, 0, "stray-hash", "unverified-legacy-model");
		startMaintenanceJob(db, {
			kind: "vector_model_migration",
			title: "Legacy-write reconciliation",
			status: "running",
			metadata: {
				source_model: "unverified-legacy-model",
				target_model: "test-model",
				reconciliation_target_coverage_complete: true,
			},
		});

		expect(resolveSemanticSearchModel(db, "test-model")).toBe("test-model");
		failMaintenanceJob(db, "vector_model_migration", "coverage became incomplete", {
			metadata: {
				source_model: "unverified-legacy-model",
				target_model: "test-model",
				reconciliation_target_coverage_complete: undefined,
				uncovered_target_memories: 1,
			},
		});
		expect(resolveSemanticSearchModel(db, "test-model")).toBeNull();
		startMaintenanceJob(db, {
			kind: "vector_model_migration",
			title: "Retry legacy-write reconciliation",
			metadata: {
				source_model: "unverified-legacy-model",
				target_model: "test-model",
				uncovered_target_memories: 1,
			},
		});
		expect(resolveSemanticSearchModel(db, "test-model")).toBeNull();
	});

	it("does not select a partial target corpus when the legacy model is incompatible", () => {
		insertTestVector(1, 0, "legacy-hash", "unverified-legacy-model");
		insertTestVector(2, 0, "target-hash", "test-model");

		expect(resolveSemanticSearchModel(db, "test-model")).toBeNull();
	});

	it("does not mark partially covered memories as healthy under deep diagnostics", () => {
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

		const diagnostics = getSemanticIndexDiagnostics(db, { fastCounts: false });

		expect(diagnostics).toMatchObject({
			state: "pending",
			embeddable_memory_count: 1,
			indexed_memory_count: 0,
			pending_memory_count: 1,
		});
	});

	it("reports failed semantic-index catch-up from maintenance job state", () => {
		vi.mocked(embeddings.getEmbeddingRuntimeStatus).mockReturnValue({
			state: "unavailable",
			reason: "initialization_failed",
		});
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

	it("reports a configured but not yet resolved identity as pending", () => {
		vi.mocked(embeddings.tryResolveEmbeddingVectorIdentityLabel).mockReturnValue(null);

		const diagnostics = getSemanticIndexDiagnostics(db);

		expect(diagnostics).toMatchObject({
			state: "pending",
			mode: "keyword_only",
			current_model: "test-model@test-revision (revision unresolved)",
			summary:
				"Semantic indexing is pending until test-model@test-revision resolves to a canonical commit",
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

		const result = await bestEffortMaintainVectorsForSyncFallback(db, {
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

		const result = await bestEffortMaintainVectorsForSyncFallback(db, {
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

	it("filters semantic search candidates by local scope authorization", async () => {
		const deviceId = "device-authorized";
		grantScopeToDevice("authorized-team", deviceId);
		insertCoordinatorScope("unauthorized-team");
		const visibleId = insertScopedMemory(
			"authorized-team",
			"Visible semantic note",
			"semantic scope detail",
		);
		const hiddenId = insertScopedMemory(
			"unauthorized-team",
			"Hidden semantic note",
			"semantic scope secret",
		);
		insertTestVector(visibleId, 0, "visible-hash");
		insertTestVector(hiddenId, 0, "hidden-hash");
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);

		const results = await semanticSearch(db, "semantic scope", 10, null, {
			actorId: "local:device-authorized",
			deviceId,
		});

		const resultIds = results.map((item) => item.id);
		expect(resultIds).toContain(visibleId);
		expect(resultIds).not.toContain(hiddenId);
	});

	it("searches compatible legacy and target vectors together until cutover", async () => {
		const currentModel = embeddings.DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
		const legacyModel = "Xenova/bge-small-en-v1.5";
		vi.mocked(embeddings.resolveEmbeddingModel).mockReturnValue(legacyModel);
		vi.mocked(embeddings.resolveEmbeddingClientVectorIdentityLabel).mockReturnValue(currentModel);
		const legacyId = insertScopedMemory(
			"local-default",
			"Legacy semantic note",
			"semantic legacy detail",
		);
		const targetId = insertScopedMemory(
			"local-default",
			"Target semantic note",
			"semantic target detail",
		);
		insertTestVector(legacyId, 0.2, "legacy-hash", legacyModel);
		insertTestVector(targetId, 0.1, "target-hash", currentModel);
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);
		const context = { actorId: "local:device", deviceId: "device" };

		expect(
			(await semanticSearch(db, "semantic note", 10, null, context)).map(({ id }) => id),
		).toEqual(expect.arrayContaining([legacyId, targetId]));

		startMaintenanceJob(db, {
			kind: "vector_model_migration",
			title: "Completed cutover",
			status: "completed",
			metadata: { source_model: legacyModel, target_model: currentModel },
		});
		expect(
			(await semanticSearch(db, "semantic note", 10, null, context)).map(({ id }) => id),
		).toEqual([targetId]);
	});

	it("intersects semantic search scope filters with local authorization", async () => {
		const deviceId = "device-authorized";
		grantScopeToDevice("authorized-team", deviceId);
		insertCoordinatorScope("unauthorized-team");
		const visibleId = insertScopedMemory(
			"authorized-team",
			"Visible semantic note",
			"semantic scope detail",
		);
		const hiddenId = insertScopedMemory(
			"unauthorized-team",
			"Hidden semantic note",
			"semantic scope secret",
		);
		insertTestVector(visibleId, 0, "visible-hash");
		insertTestVector(hiddenId, 0, "hidden-hash");
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);
		const context = { actorId: "local:device-authorized", deviceId };

		expect(
			await semanticSearch(db, "semantic scope", 10, { scope_id: "unauthorized-team" }, context),
		).toEqual([]);
		expect(
			(
				await semanticSearch(db, "semantic scope", 10, { scope_id: "authorized-team" }, context)
			).map((item) => item.id),
		).toContain(visibleId);
	});

	it("ranks only authorized semantic candidates even when unauthorized candidates dominate", async () => {
		const deviceId = "device-authorized";
		grantScopeToDevice("authorized-team", deviceId);
		insertCoordinatorScope("unauthorized-team");
		for (let i = 0; i < 220; i += 1) {
			const hiddenId = insertScopedMemory(
				"unauthorized-team",
				`Closest hidden semantic note ${i}`,
				"semantic scope secret",
			);
			insertTestVector(hiddenId, 0, `hidden-hash-${i}`);
		}
		const visibleId = insertScopedMemory(
			"authorized-team",
			"Visible semantic fallback note",
			"semantic scope detail",
		);
		insertTestVector(visibleId, 0.5, "visible-hash");
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);

		const results = await semanticSearch(db, "semantic scope", 1, null, {
			actorId: "local:device-authorized",
			deviceId,
		});

		expect(results.map((item) => item.id)).toEqual([visibleId]);
	});

	it("requires explicit scope context when vector search has candidates", async () => {
		const memoryId = insertScopedMemory(
			"local-default",
			"Legacy local semantic note",
			"semantic scope detail",
		);
		insertTestVector(memoryId, 0, "legacy-local-hash");

		await expect(
			semanticSearch(
				db,
				"semantic scope",
				10,
				null,
				undefined as unknown as Parameters<typeof semanticSearch>[4],
			),
		).rejects.toThrow("semantic_search_scope_context_required");
		expect(embeddings.embedTexts).not.toHaveBeenCalled();
	});

	it("skips query embedding when vector search is disabled during migration", async () => {
		startMaintenanceJob(db, {
			kind: "vector_model_migration",
			title: "Re-indexing memories",
			metadata: { source_model: "old-model", target_model: "test-model" },
		});

		const results = await semanticSearch(db, "query text", 10, null, {
			actorId: "local:disabled-device",
			deviceId: "disabled-device",
		});

		expect(results).toEqual([]);
		expect(embeddings.embedTexts).not.toHaveBeenCalled();
	});

	it("returns empty results on a freshly bootstrapped database with no vectors", async () => {
		const freshDb = new Database(":memory:");
		try {
			initTestSchema(freshDb);

			const results = await semanticSearch(freshDb, "query text", 10, null, {
				actorId: "local:fresh-device",
				deviceId: "fresh-device",
			});

			expect(results).toEqual([]);
			expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
			expect(embeddings.embedTexts).not.toHaveBeenCalled();
		} finally {
			freshDb.close();
		}
	});

	it("returns empty results when a custom model has no pinned revision", async () => {
		insertTestVector(1, 0, "custom-hash", "custom/model");
		vi.mocked(embeddings.resolveEmbeddingModel).mockReturnValue("custom/model");
		vi.mocked(embeddings.tryResolveEmbeddingRevision).mockReturnValue(null);

		const results = await semanticSearch(db, "query text", 10, null, {
			actorId: "local:custom-device",
			deviceId: "custom-device",
		});

		expect(results).toEqual([]);
		expect(embeddings.embedTexts).not.toHaveBeenCalled();
		expect(embeddings.resolveEmbeddingVectorIdentityLabel).not.toHaveBeenCalled();
	});

	it("getSemanticIndexDiagnostics survives a missing vec0 module without throwing", () => {
		// Reproduces the Pi 4 / Linux ARM scenario: the memory_vectors
		// virtual table is referenced from the diagnostics counter but
		// the vec0 module is unavailable on the active connection.
		// A JOIN against memory_vectors then crashes with `SQLITE_ERROR:
		// no such module: vec0`. The diagnostics endpoint must treat
		// that as "0 indexed" rather than 500 the route handler that
		// called it.
		//
		// Simulate by constructing a connection where memory_vectors
		// exists in the schema as a non-virtual table (so tableExists
		// returns true) but no vec0 module is registered. The fast-path
		// JOIN will throw "no such module" because better-sqlite3 plans
		// the query against any matching table name.
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-vectors-vec-missing-"));
		const dbPath = join(tmpDir, "test.sqlite");
		try {
			const stubDb = new Database(dbPath);
			try {
				initTestSchema(stubDb);
				stubDb.exec(`
					CREATE TABLE IF NOT EXISTS memory_vectors (
						memory_id INTEGER PRIMARY KEY,
						embedding BLOB,
						model TEXT
					);
				`);
				const originalPrepare = stubDb.prepare.bind(stubDb);
				const prepareSpy = vi.spyOn(stubDb, "prepare").mockImplementation((sql: string) => {
					if (sql.includes("memory_vectors")) {
						throw new Error("SQLITE_ERROR: no such module: vec0");
					}
					return originalPrepare(sql);
				});

				try {
					expect(() => getSemanticIndexDiagnostics(stubDb)).not.toThrow();
					const diagnostics = getSemanticIndexDiagnostics(stubDb);
					expect(diagnostics.indexed_memory_count).toBe(0);
				} finally {
					prepareSpy.mockRestore();
				}
			} finally {
				stubDb.close();
			}
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("injected backfill client identity", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		vi.clearAllMocks();
		db = new Database(":memory:");
		initTestSchema(db);
		vi.mocked(embeddings.resolveEmbeddingClientVectorIdentityLabel).mockReturnValue("test-model");
	});

	afterEach(() => db.close());

	it.each(invalidInjectedBackfillClients)(
		"rejects unsupported injected $caseName before inference or writes",
		async ({ createClient, error }) => {
			await expect(backfillVectors(db, { client: createClient() })).rejects.toThrow(error);
			expect(embeddings.embedTexts).not.toHaveBeenCalled();
			expect(embeddings.resolveEmbeddingClientVectorIdentityLabel).not.toHaveBeenCalled();
			expect(db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get()).toMatchObject({
				c: 0,
			});
		},
	);

	it("accepts a self-consistent injected client", async () => {
		const memoryId = insertInjectedBackfillMemory(db);
		const client = injectedBackfillClient();
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);

		await expect(backfillVectors(db, { client, memoryIds: [memoryId] })).resolves.toMatchObject({
			checked: 1,
			embedded: 1,
			inserted: 1,
		});
		expect(embeddings.embedTexts).toHaveBeenCalledWith(["Injected client\nBackfill body"], client);
		expect(embeddings.resolveEmbeddingClientVectorIdentityLabel).toHaveBeenCalledWith(client);
		expect(db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get()).toMatchObject({
			c: 1,
		});
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
		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(injectedBackfillClient());
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
