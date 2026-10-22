import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	chunkText,
	type EmbeddingClient,
	hashText,
	resolveEmbeddingClientVectorIdentityLabel,
} from "./embeddings.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { withVectorMetadataSnapshot } from "./vector-metadata-snapshot.js";
import {
	backfillVectors,
	countIncompleteActiveMemoryVectorCoverage,
	findMemoryIdsWithCompleteActiveVectorCoverage,
	pruneStaleCurrentModelVectors,
} from "./vectors.js";

type Connection = InstanceType<typeof Database>;
let db: Connection;
let sessionId: number;
let client: EmbeddingClient;
let model: string;

function addMemory(title: string, body = "body"): number {
	return Number(
		db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, active, created_at, updated_at)
			 VALUES (?, 'feature', ?, ?, 1, '2026-09-01', '2026-09-01')`,
			)
			.run(sessionId, title, body).lastInsertRowid,
	);
}

function addVector(id: number, hash: string, label = model, chunkIndex = 0): void {
	db.prepare(
		`INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
		 VALUES (?, ?, ?, ?, ?)`,
	).run(Buffer.alloc(384 * 4), BigInt(id), BigInt(chunkIndex), hash, label);
}

// Count actual streamed vec0 reads, not preparations or indexed scratch-DB probes.
function observeMetadata({ failStream = false } = {}) {
	const prepare = Database.prototype.prepare;
	const snapshots = new Set<Connection>();
	const transactions: boolean[] = [];
	const sourceReads: string[] = [];
	const preparedSql: string[] = [];
	vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Connection,
		sql: string,
	) {
		preparedSql.push(sql);
		const statement = prepare.call(this, sql);
		if (this !== db && sql.includes("INSERT INTO vector_metadata")) snapshots.add(this);
		if (this === db && /SELECT\b[\s\S]*FROM memory_vectors\b/.test(sql)) {
			sourceReads.push(sql);
			const iterate = statement.iterate.bind(statement);
			statement.iterate = function* (...params: unknown[]) {
				transactions.push(db.inTransaction);
				for (const row of iterate(...params)) {
					yield row;
					if (failStream) throw new Error("synthetic failure");
				}
			};
			statement.all = () => {
				throw new Error("Vector metadata must stream, not materialize with all()");
			};
		}
		return statement;
	});
	return { snapshots, transactions, sourceReads, preparedSql };
}

function prepareCount(observed: ReturnType<typeof observeMetadata>, pattern: RegExp): number {
	return observed.preparedSql.filter((sql) => pattern.test(sql)).length;
}

function useMetadataFixture() {
	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		sessionId = insertTestSession(db);
		client = {
			model: "test-model",
			dimensions: 384,
			identity: {
				package: "@huggingface/transformers",
				version: "4.2.0",
				model: "test-model",
				revision: "0123456789abcdef0123456789abcdef01234567",
				dtype: "fp32",
				device: "cpu",
				pooling: "mean",
				normalization: "l2",
				dimensions: 384,
			},
			embed: vi.fn(async (texts) => texts.map(() => new Float32Array(384))),
		};
		model = resolveEmbeddingClientVectorIdentityLabel(client);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		db.close();
	});
}

describe("disposable vector metadata snapshots", () => {
	useMetadataFixture();
	it("isolates nested snapshots, uses indexed hashes, and preserves the source schema and TEMP tables", () => {
		// Arrange: callers may already own TEMP state on a MEMORY-tuned connection.
		db.pragma("temp_store = MEMORY");
		db.exec("CREATE TEMP TABLE caller_state(value TEXT); INSERT INTO caller_state VALUES ('kept')");
		addVector(1, "before");
		const schema = db.prepare("SELECT sql FROM main.sqlite_schema ORDER BY name").all();
		const observed = observeMetadata();

		// Act: a nested invocation sees new writes without altering its parent's view.
		const result = withVectorMetadataSnapshot(db, (outer) => {
			addVector(2, "after");
			const innerCount = withVectorMetadataSnapshot(db, (inner) =>
				inner.prepare("SELECT COUNT(*) AS c FROM vector_metadata").get(),
			);
			return {
				innerCount,
				outerCount: outer.prepare("SELECT COUNT(*) AS c FROM vector_metadata").get(),
				plan: outer
					.prepare(
						"EXPLAIN QUERY PLAN SELECT 1 FROM vector_metadata WHERE memory_id = ? AND model = ? AND content_hash = ?",
					)
					.all(1, model, "before") as Array<{ detail: string }>,
			};
		});

		// Assert: independent disposable databases never mutate the source's schema or tuning.
		expect(result.innerCount).toEqual({ c: 2 });
		expect(result.outerCount).toEqual({ c: 1 });
		expect(result.plan.map(({ detail }) => detail).join(" ")).toMatch(/SEARCH.*COVERING INDEX/);
		expect(observed.sourceReads).toHaveLength(2);
		expect([...observed.snapshots].map((snapshot) => snapshot.open)).toEqual([false, false]);
		expect(db.pragma("temp_store", { simple: true })).toBe(2);
		expect(db.prepare("SELECT * FROM caller_state").all()).toEqual([{ value: "kept" }]);
		expect(db.prepare("SELECT sql FROM main.sqlite_schema ORDER BY name").all()).toEqual(schema);
	});

	it.each(["stream", "visitor"])("closes the scratch connection after a %s failure", (failure) => {
		// Arrange: fail after construction has opened the disposable database.
		addVector(1, "before");
		const observed = observeMetadata({ failStream: failure === "stream" });

		// Act / Assert: both failed construction and failed consumers release their connection.
		expect(() =>
			withVectorMetadataSnapshot(db, () => {
				throw new Error("synthetic failure");
			}),
		).toThrow("synthetic failure");
		expect([...observed.snapshots].map((snapshot) => snapshot.open)).toEqual([false]);
		expect(db.open).toBe(true);
	});
});

describe("vector metadata scan counts", () => {
	useMetadataFixture();
	it("does not scan vector metadata when there are no eligible memories", async () => {
		// Arrange: an inactive row and an unrelated vector do not create coverage work.
		const id = addMemory("Inactive");
		db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(id);
		addVector(id, "unrelated");
		const observed = observeMetadata();

		// Act: both coverage and backfill can return without building a snapshot.
		const incomplete = countIncompleteActiveMemoryVectorCoverage(db, model);
		const result = await backfillVectors(db, { client });

		// Assert: an empty pass does no inference or vec0 scan.
		expect(incomplete).toBe(0);
		expect(result).toEqual({ checked: 0, embedded: 0, inserted: 0, skipped: 0 });
		expect(observed.sourceReads).toEqual([]);
		expect(client.embed).not.toHaveBeenCalled();
	});

	it("reuses one planning scan across covered pages until inference is needed", async () => {
		// Arrange: two fully covered pages precede one uncovered memory.
		for (let index = 0; index < 101; index++) {
			const title = `Memory ${index}`;
			const id = addMemory(title);
			if (index < 100) addVector(id, hashText(`${title}\nbody`));
		}
		const observed = observeMetadata();

		// Act: uninterrupted reads can share a snapshot, but writes must recheck after inference.
		const result = await backfillVectors(db, { client });

		// Assert: exactly one planning scan and one insertion scan cover all three pages.
		expect(result).toEqual({ checked: 101, embedded: 1, inserted: 1, skipped: 100 });
		expect(observed.sourceReads).toHaveLength(2);
		expect(observed.transactions).toEqual([false, true]);
		expect(prepareCount(observed, /SELECT memory_id, content_hash FROM vector_metadata/)).toBe(1);
		expect(prepareCount(observed, /SELECT 1 FROM vector_metadata/)).toBe(1);
		expect([...observed.snapshots].every((snapshot) => !snapshot.open)).toBe(true);
	});
});

describe("vector metadata maintenance batches", () => {
	useMetadataFixture();
	it("scans once per coverage pass and once per prune batch, retaining incomplete and other-model rows", () => {
		// Arrange: 251 rows span two pruning batches; coverage varies independently of row presence.
		const ids: number[] = [];
		db.transaction(() => {
			for (let index = 0; index < 251; index++) {
				const title = `Memory ${index}`;
				const id = addMemory(title);
				ids.push(id);
				addVector(id, "stale");
				addVector(id, hashText(`${title}\nbody`), "other-model");
				if (index % 2 === 0) addVector(id, hashText(`${title}\nbody`));
			}
		})();
		const observed = observeMetadata();

		// Act: coverage is exact; pruning only removes stale rows after full target coverage.
		const complete = findMemoryIdsWithCompleteActiveVectorCoverage(db, ids, model);
		const queueHashPrepares = prepareCount(observed, /SELECT 1 FROM vector_metadata/);
		const incomplete = countIncompleteActiveMemoryVectorCoverage(db, model);
		const coverageHashPrepares = prepareCount(observed, /SELECT 1 FROM vector_metadata/);
		const deleted = pruneStaleCurrentModelVectors(db, ids, model);

		// Assert: four scans replace hundreds of per-memory reads; pruning runs inside transactions.
		expect(complete).toEqual(ids.filter((_, index) => index % 2 === 0));
		expect(incomplete).toBe(125);
		expect(deleted).toBe(126);
		expect(observed.sourceReads).toHaveLength(4);
		expect(observed.transactions).toEqual([false, false, true, true]);
		expect([
			queueHashPrepares,
			coverageHashPrepares,
			prepareCount(observed, /SELECT 1 FROM vector_metadata/),
		]).toEqual([1, 2, 4]);
		expect(prepareCount(observed, /SELECT rowid, model, content_hash FROM vector_metadata/)).toBe(
			2,
		);
		expect(prepareCount(observed, /DELETE FROM memory_vectors WHERE rowid/)).toBe(1);
		expect(observed.sourceReads.map((sql) => sql.includes("json_each"))).toEqual([
			false,
			false,
			true,
			true,
		]);
		expect([...observed.snapshots].every((snapshot) => !snapshot.open)).toBe(true);
		vi.restoreAllMocks();
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = ?").get(model),
		).toEqual({ c: 251 });
		expect(
			db.prepare("SELECT COUNT(*) AS c FROM memory_vectors WHERE model = 'other-model'").get(),
		).toEqual({ c: 251 });
	});

	it("refreshes planning after inference and rechecks concurrent hashes inside the write transaction", async () => {
		// Arrange: page two is modified while page one's inference is pending.
		const ids = Array.from({ length: 51 }, (_, index) => addMemory(`Memory ${index}`));
		const observed = observeMetadata();
		vi.mocked(client.embed).mockImplementation(async (texts) => {
			expect([...observed.snapshots].every((snapshot) => !snapshot.open)).toBe(true);
			expect(db.inTransaction).toBe(false);
			if (observed.transactions.length === 1) {
				addVector(ids[0] as number, hashText("Memory 0\nbody"));
				db.prepare("UPDATE memory_items SET body_text = 'edited' WHERE id = ?").run(ids[50]);
				addVector(ids[50] as number, hashText("Memory 50\nedited"));
			}
			return texts.map(() => new Float32Array(384));
		});

		// Act: target hashes inserted during inference must not be duplicated or re-embedded next page.
		const result = await backfillVectors(db, { client });

		// Assert: scans scale with pages/batches, not the 51 memories.
		expect(result).toEqual({ checked: 51, embedded: 50, inserted: 49, skipped: 1 });
		expect(observed.transactions).toEqual([false, true, true, false]);
		expect(observed.sourceReads).toHaveLength(4);
		expect(observed.sourceReads.map((sql) => sql.includes("json_each"))).toEqual([
			false,
			true,
			true,
			false,
		]);
		expect(prepareCount(observed, /SELECT memory_id, content_hash FROM vector_metadata/)).toBe(2);
		expect(prepareCount(observed, /SELECT 1 FROM vector_metadata/)).toBe(2);
		expect([...observed.snapshots].every((snapshot) => !snapshot.open)).toBe(true);
		expect(vi.mocked(client.embed).mock.calls.map(([texts]) => texts.length)).toEqual([32, 18]);
		vi.restoreAllMocks();
		expect(db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get()).toEqual({ c: 51 });
	});
});

describe("vector metadata write and failure semantics", () => {
	useMetadataFixture();
	it("reads fresh state on each pass and rejects stale and wrong-model hashes", () => {
		// Arrange: metadata presence alone does not imply valid target coverage.
		const id = addMemory("Current");
		addVector(id, "stale-content");
		addVector(id, hashText("Current\nbody"), "other-model");
		const missing = countIncompleteActiveMemoryVectorCoverage(db, model);

		// Act: a current row covers the memory until its source text changes.
		addVector(id, hashText("Current\nbody"));
		const current = countIncompleteActiveMemoryVectorCoverage(db, model);
		db.prepare("UPDATE memory_items SET body_text = 'changed' WHERE id = ?").run(id);
		const changed = countIncompleteActiveMemoryVectorCoverage(db, model);
		const deleted = pruneStaleCurrentModelVectors(db, [id], model);

		// Assert: no cached snapshot masks the edit, and incomplete coverage prevents pruning.
		expect([missing, current, changed, deleted]).toEqual([1, 0, 1, 0]);
		expect(db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get()).toEqual({ c: 3 });
	});
	it("preserves repeated chunk hashes at distinct chunk indexes and repairs changed text", async () => {
		// Arrange: identical 1200-character chunks must retain their original positions.
		const body = "x".repeat(3600);
		const id = addMemory("", body);
		const chunks = chunkText(body);
		expect(chunks.length).toBeGreaterThan(1);
		expect(new Set(chunks).size).toBe(1);
		addVector(id, "old-content");
		addVector(id, hashText(chunks[0] as string), "other-model");

		// Act: stale and other-model rows cannot satisfy target-model coverage.
		const first = await backfillVectors(db, { client });
		const second = await backfillVectors(db, { client });
		const pruned = pruneStaleCurrentModelVectors(db, [id], model);

		// Assert: current duplicates survive pruning and are skipped on the next pass.
		expect(first.inserted).toBe(chunks.length);
		expect(second).toEqual({ checked: 1, embedded: 0, inserted: 0, skipped: chunks.length });
		expect(pruned).toBe(1);
		expect(
			db
				.prepare(
					"SELECT chunk_index, content_hash FROM memory_vectors WHERE model = ? ORDER BY chunk_index",
				)
				.all(model),
		).toEqual(chunks.map((chunk, chunk_index) => ({ chunk_index, content_hash: hashText(chunk) })));
	});

	it.each(["inference", "insert"])(
		"cleans up snapshots and candidate tables after %s failure",
		async (failure) => {
			// Arrange: an unrelated TEMP table must survive failed asynchronous maintenance.
			addMemory("Failure one");
			addMemory("Failure two");
			db.exec("CREATE TEMP TABLE caller_state(value); INSERT INTO caller_state VALUES (42)");
			const observed = observeMetadata();
			let successfulInserts = 0;
			if (failure === "inference") {
				vi.mocked(client.embed).mockRejectedValue(new Error("synthetic failure"));
			} else {
				const exec = db.exec.bind(db);
				let inserts = 0;
				vi.spyOn(db, "exec").mockImplementation((sql: string) => {
					if (sql.includes("INSERT INTO memory_vectors")) {
						inserts++;
						if (inserts === 2) throw new Error("synthetic failure");
					}
					const result = exec(sql);
					if (sql.includes("INSERT INTO memory_vectors")) successfulInserts++;
					return result;
				});
			}

			// Act / Assert: rollback and finally paths release all disposable state.
			await expect(backfillVectors(db, { client })).rejects.toThrow("synthetic failure");
			expect(successfulInserts).toBe(failure === "inference" ? 0 : 1);
			expect(client.embed).toHaveBeenCalledTimes(1);
			expect([...observed.snapshots].every((snapshot) => !snapshot.open)).toBe(true);
			expect(observed.snapshots.size).toBe(failure === "inference" ? 1 : 2);
			expect(db.inTransaction).toBe(false);
			expect(db.prepare("SELECT * FROM caller_state").all()).toEqual([{ value: 42 }]);
			expect(
				db
					.prepare(
						"SELECT name FROM temp.sqlite_schema WHERE name LIKE 'codemem_backfill_vector_candidates_%'",
					)
					.all(),
			).toEqual([]);
			vi.restoreAllMocks();
			expect(db.prepare("SELECT COUNT(*) AS c FROM memory_vectors").get()).toEqual({ c: 0 });
		},
	);
});

describe("filtered vector metadata snapshots", () => {
	useMetadataFixture();
	it.each(["deduplicated", "empty", "over-bind-limit"])(
		"copies only %s IDs without changing row metadata",
		(kind) => {
			// Arrange: preserve two same-hash chunks and a second model, but exclude another memory.
			addVector(1, "repeated", model, 0);
			addVector(1, "repeated", model, 1);
			addVector(1, "other", "other-model");
			addVector(2, "excluded");
			const expected = db
				.prepare(
					"SELECT rowid, memory_id, model, content_hash FROM memory_vectors WHERE memory_id = 1 ORDER BY rowid",
				)
				.all();
			let memoryIds = [1, 1, 999];
			if (kind === "empty") memoryIds = [];
			if (kind === "over-bind-limit") {
				const limitOption = (
					db.pragma("compile_options") as Array<{ compile_options: string }>
				).find(({ compile_options }) => compile_options.startsWith("MAX_VARIABLE_NUMBER="));
				if (!limitOption) throw new Error("SQLite variable limit was not reported");
				const limit = Number(limitOption.compile_options.split("=")[1]);
				memoryIds = [1, ...Array.from({ length: limit }, (_, index) => index + 10)];
			}
			const observed = observeMetadata();

			// Act: one JSON binding handles repeated, missing, and over-limit ID lists.
			const rows = withVectorMetadataSnapshot(
				db,
				(metadata) => metadata.prepare("SELECT * FROM vector_metadata ORDER BY rowid").all(),
				{ memoryIds },
			);

			// Assert: membership does not duplicate rows; an empty list never scans vec0.
			expect(rows).toEqual(kind === "empty" ? [] : expected);
			expect(observed.sourceReads).toHaveLength(kind === "empty" ? 0 : 1);
			if (kind !== "empty") expect(observed.sourceReads[0]?.match(/\?/g)).toHaveLength(1);
		},
	);

	it("does not evaluate excluded model/hash projections and preserves nullable legacy metadata", () => {
		// Arrange: an instrumented source view models nullable metadata that vec0 cannot insert today.
		db.exec(`CREATE TEMP TABLE fixture_vectors(rowid INTEGER, memory_id INTEGER, model TEXT, content_hash TEXT);
		 INSERT INTO fixture_vectors VALUES (7, 1, 'first-model', NULL), (9, 1, 'second-model', 'hash'), (11, 2, 'excluded', 'excluded')`);
		const project = vi.fn((id: number, value: string | null) => {
			if (id === 2) throw new Error("Excluded metadata was projected");
			return value;
		});
		db.function("project_metadata", project);
		db.exec(`CREATE TEMP VIEW memory_vectors AS SELECT rowid, memory_id,
		 project_metadata(memory_id, model) AS model,
		 project_metadata(memory_id, content_hash) AS content_hash FROM fixture_vectors`);

		// Act: SQLite must filter memory_id before projecting the expensive metadata columns.
		const rows = withVectorMetadataSnapshot(
			db,
			(metadata) => metadata.prepare("SELECT * FROM vector_metadata ORDER BY rowid").all(),
			{ memoryIds: [1] },
		);

		// Assert: excluded projections never execute, while included values survive unchanged.
		expect(project).toHaveBeenCalledTimes(4);
		expect(rows).toEqual([
			{ rowid: 7, memory_id: 1, model: "first-model", content_hash: null },
			{ rowid: 9, memory_id: 1, model: "second-model", content_hash: "hash" },
		]);
	});
});
