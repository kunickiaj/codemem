import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSqliteVec } from "./db.js";
import {
	chunkText,
	hashText,
	DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL as MODEL,
	serializeFloat32,
} from "./embeddings.js";
import { scanSecretsRetroactive } from "./maintenance/scan-secrets.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { SecretScanner } from "./secret-scanner.js";
import { rankPrevalidatedSnapshot } from "./semantic/semantic-ranking.js";
import { createFixture, vector } from "./semantic/semantic-ranking.test-helper.js";
import type { RankInput, WorkerReply } from "./semantic/semantic-worker-protocol.js";
import { rankWorkerInput } from "./semantic/semantic-worker-ranking.js";
import {
	auditBatch,
	initializeValidatedIndex,
	readCatalog,
	startAudit,
} from "./semantic/validated-vector-index.js";
import { pendingVectorFreshness } from "./semantic-query.js";
import { queueVectorBackfill } from "./vector-backfill-queue.js";
import { createEmptyVectorLayout } from "./vector-layout.js";
import { rankSemanticEmbedding } from "./vectors.js";

const LEGACY_MODEL = "Xenova/bge-small-en-v1.5";
const routes = [
	"inline-scan",
	"inline-native",
	"inline-scalar",
	"worker-native",
	"worker-scalar",
] as const;
type Route = (typeof routes)[number];
type Neighbor = { id: number; distance: number };

// Share compiled source modules only. Each rank still opens a fresh worker and database connection.
let compileCacheDirectory: string;
beforeAll(() => {
	compileCacheDirectory = mkdtempSync(join(tmpdir(), "codemem-ranking-compile-cache-"));
});
afterAll(() => {
	rmSync(compileCacheDirectory, { recursive: true, force: true });
});

function sourceHash(db: Database.Database, id: number): string {
	const row = db.prepare("SELECT title, body_text FROM memory_items WHERE id=?").get(id) as {
		title: string;
		body_text: string;
	};
	const text = chunkText(`${row.title}\n${row.body_text}`.trim())[0];
	if (text === undefined) throw new Error("fixture chunk absent");
	return hashText(text);
}

// Exercise the real worker entrypoint with numerical inputs, never an embedding runtime.
async function workerRank(path: string, input: RankInput): Promise<Neighbor[]> {
	const stat = statSync(path);
	const worker = new Worker(new URL("./semantic/semantic-worker-entry.ts", import.meta.url), {
		workerData: { dbPath: path, fileIdentity: `${stat.dev}:${stat.ino}` },
		env: {
			NODE_COMPILE_CACHE: compileCacheDirectory,
			...(process.env.NODE_DISABLE_COMPILE_CACHE === undefined
				? {}
				: { NODE_DISABLE_COMPILE_CACHE: process.env.NODE_DISABLE_COMPILE_CACHE }),
			// Cached V8 functions can yield less precise coverage.
			...(process.env.NODE_V8_COVERAGE !== undefined ? { NODE_DISABLE_COMPILE_CACHE: "1" } : {}),
		},
		execArgv: ["--experimental-transform-types"],
	});
	try {
		return await new Promise<Neighbor[]>((resolve, reject) => {
			worker.on("error", reject);
			worker.on("exit", (code) => reject(new Error(`worker exited before result: ${code}`)));
			worker.on("message", (reply: WorkerReply) => {
				if (reply.type === "ready") {
					worker.postMessage({ type: "rank", id: 1, deadlineAt: Number.MAX_SAFE_INTEGER, input });
				} else if (reply.type === "result") {
					if (!reply.output) reject(new Error("fixture worker catalog unavailable"));
					else resolve(reply.output.candidates.map(({ id, distance }) => ({ id, distance })));
				} else reject(new Error(`worker ranking failed: ${reply.code}`));
			});
		});
	} finally {
		await worker.terminate();
	}
}

function useFixture(layout: "legacy" | "v1") {
	let directory: string;
	let fixture: ReturnType<typeof createFixture>;
	let db: Database.Database;
	let strategy: "native" | "scalar" | undefined;
	const table = layout === "v1" ? "memory_vectors_v1" : "memory_vectors";

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "codemem-pending-ranking-"));
		vi.stubEnv("HOME", directory);
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("test forbids network"));
		fixture = createFixture(directory);
		strategy = undefined;
		db = fixture.db;
		if (layout === "v1") {
			db.exec("DROP TABLE memory_vectors");
			createEmptyVectorLayout(db);
		} else initializeValidatedIndex(db, { writerVersion: 1, allWritersUpgraded: true });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		db.close();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	function seed(
		id: number,
		distance: number,
		options: { hash?: string; chunk?: number; model?: string } = {},
	) {
		const hash = options.hash === undefined ? sourceHash(db, id) : options.hash;
		db.prepare(`INSERT INTO ${table}(embedding,memory_id,chunk_index,content_hash,model)
			VALUES(?,?,?,?,?)`).run(
			serializeFloat32(vector(distance)),
			BigInt(id),
			BigInt(options.chunk ?? 0),
			hash,
			options.model ?? MODEL,
		);
	}

	function audit() {
		startAudit(db, { knownModels: [MODEL, LEGACY_MODEL] });
		const result = auditBatch(db, { limit: 100 });
		if (result.remaining) throw new Error("fixture audit incomplete");
	}

	function queue(ids: number[]) {
		queueVectorBackfill(db, { upsertMemoryIds: ids, deleteMemoryIds: [] });
	}

	function input(limit: number, summarySessionId?: null): RankInput {
		const catalog = readCatalog(db);
		if (!catalog) throw new Error("fixture catalog absent");
		return {
			generationId: catalog.generationId,
			embedding: vector(),
			embeddingIdentity: MODEL,
			filters: null,
			automaticContext: summarySessionId,
			proof: {
				actorId: fixture.context.actorId ?? "",
				deviceId: fixture.context.deviceId ?? "",
				expectedPublicKey: undefined,
			},
			limit,
		};
	}

	async function rank(route: Route, summarySessionId?: null): Promise<Neighbor[]> {
		const limit = route.endsWith("native") ? 1 : 10;
		if (route.startsWith("worker")) return workerRank(fixture.path, input(limit, summarySessionId));
		const context = { ...fixture.context, scopeVisibilityDb: db };
		return db.transaction(() => {
			if (route === "inline-scan")
				return rankSemanticEmbedding(
					db,
					serializeFloat32(vector()),
					[LEGACY_MODEL, MODEL],
					limit,
					null,
					context,
					summarySessionId,
				).map(({ id, distance }) => ({ id, distance }));
			const ranked = rankPrevalidatedSnapshot(
				db,
				{
					query: { model: MODEL, vectors: [vector()] },
					limit,
					filters: null,
					context,
					summarySessionId,
				},
				{ models: [LEGACY_MODEL, MODEL], acceptedIds: null, indexedRows: true },
			);
			strategy = ranked.strategy;
			return ranked.results.map(({ id, distance }) => ({ id, distance }));
		})();
	}

	return {
		memory: (scope?: string) => fixture.memory(scope),
		seed,
		audit,
		queue,
		rank,
		input,
		get db() {
			return db;
		},
		get strategy() {
			return strategy;
		},
		get context() {
			return { ...fixture.context, scopeVisibilityDb: db };
		},
		currentHash: (id: number) => sourceHash(db, id),
		reopen() {
			db.close();
			db = new Database(fixture.path);
			loadSqliteVec(db);
		},
	};
}
type Fixture = ReturnType<typeof useFixture>;

function registerRankingCases(f: Fixture, route: Route) {
	const { memory, seed, audit, queue, rank } = f;
	it("uses the current chunk distance instead of a stale nearer duplicate before LIMIT", async () => {
		// Arrange: both rows share a chunk index, so dropping a whole pending memory loses valid work.
		const id = memory();
		const other = memory();
		seed(id, 0, { hash: hashText("obsolete source") });
		seed(id, 0.5);
		seed(other, 1);
		audit();
		queue([id]);
		const evaluated: number[] = [];
		if (route === "inline-scan" || route === "inline-scalar") {
			f.db.function("vec_distance_l2", (bytes: Buffer, _query: Buffer) => {
				const distance = bytes.readFloatLE(0);
				evaluated.push(distance);
				return distance;
			});
		}
		// Act
		const actual = await rank(route);
		// Assert: stale rows must not contribute to MIN, KNN, score, or the cutoff.
		expect(actual).toEqual(
			[
				{ id, distance: 0.5 },
				{ id: other, distance: 1 },
			].slice(0, route.endsWith("native") ? 1 : 2),
		);
		if (route === "inline-native") expect(f.strategy).toBe("native");
		if (route === "inline-scalar") expect(f.strategy).toBe("scalar");
		if (route === "inline-scan" || route === "inline-scalar") {
			expect(evaluated.sort((a, b) => a - b)).toEqual([0.5, 1]);
		}
	});

	it("excludes a stale-only pending memory while preserving an unqueued candidate", async () => {
		// Arrange
		const stale = memory();
		const visible = memory();
		seed(stale, 0, { hash: hashText("obsolete source") });
		seed(visible, 1);
		audit();
		queue([stale]);
		// Act
		const actual = await rank(route);
		// Assert
		expect(actual).toEqual([{ id: visible, distance: 1 }]);
	});

	it("keeps fresh pending vectors and rejects matching hashes at an obsolete chunk index", async () => {
		// Arrange: matching text alone cannot certify a chunk that no longer exists.
		const id = memory();
		seed(id, 0, { chunk: 7 });
		seed(id, 0.5);
		audit();
		queue([id]);
		// Act
		const actual = await rank(route);
		// Assert
		expect(actual).toEqual([{ id, distance: 0.5 }]);
	});

	it("excludes compatible legacy stale chunks before choosing the current row", async () => {
		// Arrange: legacy compatibility must not make obsolete content searchable.
		const id = memory();
		seed(id, 0.125, { hash: hashText("old legacy text"), model: LEGACY_MODEL });
		seed(id, 0.5);
		audit();
		queue([id]);
		// Act
		const actual = await rank(route);
		// Assert
		expect(actual).toEqual([{ id, distance: 0.5 }]);
	});
}

function registerQueueCases(f: Fixture, route: Route) {
	const { memory, seed, audit, queue, rank } = f;
	it("preserves the no-pending baseline even for historical noncurrent hashes", async () => {
		// Arrange: the selective check must not revalidate the full historical corpus.
		const id = memory();
		seed(id, 0.25, { hash: "historical-hash" });
		audit();
		// Act
		const before = await rank(route);
		queue([id]);
		f.db
			.prepare("UPDATE maintenance_jobs SET metadata_json=? WHERE kind='vector_model_migration'")
			.run('{"pending_upsert_memory_ids":[]}');
		const after = await rank(route);
		// Assert
		expect(before).toEqual([{ id, distance: 0.25 }]);
		expect(after).toEqual(before);
	});

	it.each([
		"{",
		"null",
		'{"pending_upsert_memory_ids":"invalid"}',
		'{"pending_upsert_memory_ids":[null,-1,"1",{}]}',
	])("returns no results for malformed queue metadata: %s", async (metadata) => {
		// Arrange: unreadable repair intent cannot certify the historical corpus.
		const id = memory();
		seed(id, 0.25, { hash: "historical-hash" });
		audit();
		queue([id]);
		f.db
			.prepare("UPDATE maintenance_jobs SET metadata_json=? WHERE kind='vector_model_migration'")
			.run(metadata);
		// Act
		const actual = await rank(route);
		// Assert
		expect(actual).toEqual([]);
	});

	it("honors the durable queue after reopening the synthetic database", async () => {
		// Arrange: reopening must not clear or cache the selective source fence.
		const stale = memory();
		const fresh = memory();
		seed(stale, 0, { hash: "old" });
		seed(fresh, 0.5);
		audit();
		queue([stale, fresh]);
		f.reopen();
		// Act
		const actual = await rank(route);
		// Assert
		expect(actual).toEqual([{ id: fresh, distance: 0.5 }]);
		expect(
			getMaintenanceJob(f.db, "vector_model_migration")?.metadata?.pending_upsert_memory_ids,
		).toEqual([stale, fresh]);
	});
}

function registerRedactionCase(f: Fixture, route: Route) {
	const { memory, seed, audit, rank } = f;
	it("excludes the old vector after a real retroactive redaction and accepts its replacement", async () => {
		// Arrange: an explicit synthetic scanner exercises the actual sweep and queue writer.
		const id = memory();
		const control = memory();
		f.db
			.prepare("UPDATE memory_items SET body_text='synthetic-sensitive-marker' WHERE id=?")
			.run(id);
		seed(id, 0);
		seed(control, 1);
		audit();
		const scanner = new SecretScanner({
			rules: [{ kind: "synthetic", pattern: /synthetic-sensitive-marker/g }],
		});
		// Act
		const swept = scanSecretsRetroactive(f.db, { scanner });
		const stale = await rank(route);
		seed(id, 0.5);
		audit();
		const repaired = await rank(route);
		// Assert: repair intent survives fresh writes until the queue runner acknowledges it.
		expect(swept.updated).toBe(1);
		expect(
			getMaintenanceJob(f.db, "vector_model_migration")?.metadata?.pending_upsert_memory_ids,
		).toContain(id);
		expect(stale).toEqual([{ id: control, distance: 1 }]);
		expect(repaired).toEqual(
			[
				{ id, distance: 0.5 },
				{ id: control, distance: 1 },
			].slice(0, route.endsWith("native") ? 1 : 2),
		);
	});
}

function registerAuthorizationCases(f: Fixture) {
	it.each(["inline-scan", "inline-native", "inline-scalar", "worker-entry"] as const)(
		"%s restricts pending source body reads to authorized IDs and summary continuity",
		async (route) => {
			const { db, memory, seed, audit, queue, input, rank } = f;
			// Arrange: spy on returned statement rows, not just final search results.
			const visible = memory();
			const hidden = memory("hidden");
			const summary = memory();
			const unqueued = memory();
			db.prepare("UPDATE memory_items SET kind='session_summary' WHERE id=?").run(summary);
			for (const id of [visible, hidden, summary]) seed(id, 0.5);
			seed(unqueued, 1);
			audit();
			queue([visible, hidden, summary]);
			const reads: { sql: string; ids: number[]; inSnapshot: boolean }[] = [];
			const prepare = db.prepare.bind(db);
			vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
				const statement = prepare(sql);
				const all = statement.all.bind(statement);
				vi.spyOn(statement, "all").mockImplementation((...params: unknown[]) => {
					const rows = all(...params) as Record<string, unknown>[];
					const bodies = rows.filter((row) => "body_text" in row);
					if (bodies.length)
						reads.push({
							sql,
							ids: bodies.map((row) => Number(row.id)),
							inSnapshot: db.inTransaction,
						});
					return rows;
				});
				return statement;
			});
			// Act: the worker's shipping entry function allows statement inspection on this connection.
			const actual =
				route === "worker-entry"
					? rankWorkerInput(db, input(10, null))?.candidates.map(({ id, distance }) => ({
							id,
							distance,
						}))
					: await rank(route, null);
			// Assert: authorization and continuity run before current source text is fetched.
			expect(actual).toEqual(
				[
					{ id: visible, distance: 0.5 },
					{ id: unqueued, distance: 1 },
				].slice(0, route === "inline-native" ? 1 : 2),
			);
			expect(reads.length).toBeGreaterThan(0);
			expect(reads.flatMap((read) => read.ids)).not.toContain(hidden);
			expect(reads.flatMap((read) => read.ids)).not.toContain(summary);
			expect(reads.every((read) => read.inSnapshot)).toBe(true);
			const sourceReads = reads.filter((read) => !/distance|SELECT \*/.test(read.sql));
			expect(sourceReads.length).toBeGreaterThan(0);
			expect(sourceReads.flatMap((read) => read.ids)).toEqual([visible]);
			expect(sourceReads.every((read) => /WHERE|JOIN/.test(read.sql))).toBe(true);
		},
	);
}

describe.each(["legacy", "v1"] as const)("pending source freshness on %s layout", (layout) => {
	const f = useFixture(layout);
	describe.each(routes)("%s", (route) => {
		registerRankingCases(f, route);
		registerQueueCases(f, route);
		registerRedactionCase(f, route);
	});
	registerAuthorizationCases(f);
	it("rejects nullable historical hashes before evaluating distance", () => {
		// Arrange: vec0 forbids NULL on new inserts, so represent the historical metadata with SQL values.
		const id = f.memory();
		f.queue([id]);
		const evaluated: number[] = [];
		f.db.function("vec_distance_l2", (bytes: Buffer, _query: Buffer) => {
			evaluated.push(bytes.readFloatLE(0));
			return bytes.readFloatLE(0);
		});
		// Act: execute the production freshness predicate in the same source snapshot.
		const actual = f.db.transaction(() => {
			const freshness = pendingVectorFreshness(f.db, null, f.context, undefined);
			return f.db
				.prepare(`WITH historical AS (
				SELECT CAST(? AS INTEGER) AS memory_id, 0 AS chunk_index, NULL AS content_hash, ? AS embedding
				UNION ALL SELECT CAST(? AS INTEGER), 0, ?, ?)
				SELECT vec_distance_l2(embedding, ?) AS distance FROM historical WHERE 1=1 ${freshness.sql}`)
				.all(
					id,
					serializeFloat32(vector()),
					id,
					f.currentHash(id),
					serializeFloat32(vector(0.5)),
					serializeFloat32(vector()),
					...freshness.params,
				);
		})();
		// Assert: the valid row remains eligible and the NULL row never reaches the distance function.
		expect(actual).toEqual([{ distance: 0.5 }]);
		expect(evaluated).toEqual([0.5]);
	});
});
