import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as database from "./db.js";
import { loadSqliteVec } from "./db.js";
import * as embeddings from "./embeddings.js";
import { getMaintenanceJob, startMaintenanceJob } from "./maintenance-jobs.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import {
	runVectorMigrationPass,
	VECTOR_MODEL_MIGRATION_JOB,
	VectorModelMigrationRunner,
} from "./vector-migration.js";

vi.mock("./embeddings.js", async () => ({
	...(await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js")),
	getEmbeddingClient: vi.fn(),
	embedTexts: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384))),
	resolveEmbeddingModel: vi.fn(() => "test-model"),
	resolveEmbeddingClientVectorIdentityLabel: vi.fn(() => "test-model"),
	tryResolveEmbeddingRevision: vi.fn(() => "test-revision"),
	tryResolveEmbeddingVectorIdentityLabel: vi.fn(() => "test-model"),
}));

let directory: string;
let db: Database;
let writer: Database;
let session: number;
function vector(connection: Database, model: string, rowid?: number) {
	return Number(
		connection
			.prepare(`INSERT INTO memory_vectors(rowid, embedding, memory_id, chunk_index, content_hash, model)
		VALUES (?, ?, 1, 0, ?, ?)`)
			.run(
				rowid === undefined ? null : BigInt(rowid),
				Buffer.alloc(384 * 4),
				embeddings.hashText("One\nBody"),
				model,
			).lastInsertRowid,
	);
}
function job() {
	return getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
}
function seedUnsafeLegacyVector(column: "rowid" | "memory_id", shadow = true) {
	if (!shadow) {
		db.exec(`DROP TABLE memory_vectors;
			CREATE TABLE memory_vectors(rowid INTEGER PRIMARY KEY, embedding BLOB, memory_id INTEGER,
				chunk_index INTEGER, content_hash TEXT, model TEXT)`);
		vector(db, "test-model");
		vector(db, "old-model");
	}
	const huge = 9007199254740993n;
	db.prepare(`INSERT INTO memory_vectors(rowid, embedding, memory_id, chunk_index, content_hash, model)
		VALUES (?, ?, ?, 0, 'legacy', 'old-model')`).run(
		column === "rowid" ? huge : null,
		Buffer.alloc(384 * 4),
		column === "memory_id" ? huge : 1n,
	);
}
function vectorMetadata() {
	return db
		.prepare("SELECT rowid, memory_id, model, content_hash FROM memory_vectors ORDER BY rowid")
		.safeIntegers()
		.all();
}
function afterRead(marker: string, callback: (rows: unknown[]) => void) {
	const original = Database.prototype.prepare;
	return vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
		const statement = original.call(db, sql);
		if (sql.includes(marker)) {
			const all = statement.all.bind(statement);
			statement.all = (...params: unknown[]) => {
				const rows = all(...params);
				callback(rows);
				return rows;
			};
		}
		return statement;
	});
}

function observeCleanupDeleteTransactions() {
	type Batch = {
		deleted: number;
		scans: Array<{ sql: string; params: unknown[]; locked: boolean }>;
		rereads: boolean[];
		writerLocked: boolean;
	};
	const batches: Batch[] = [];
	let current: Batch | null = null;
	const transaction = db.transaction.bind(db);
	vi.spyOn(db, "transaction").mockImplementation((fn) => {
		return transaction(
			new Proxy(fn, {
				apply(target, thisArg, args) {
					const previous = current;
					let writerLocked = false;
					try {
						writer.exec("BEGIN IMMEDIATE");
						writer.exec("ROLLBACK");
					} catch (error) {
						if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
						writerLocked = true;
					}
					current = { deleted: 0, scans: [], rereads: [], writerLocked };
					batches.push(current);
					try {
						return Reflect.apply(target, thisArg, args);
					} finally {
						current = previous;
					}
				},
			}),
		);
	});
	const prepare = db.prepare.bind(db);
	vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
		const statement = prepare(sql);
		if (sql.includes("vector-metadata-snapshot")) {
			const iterate = statement.iterate.bind(statement);
			statement.iterate = function* (...params: unknown[]) {
				current?.scans.push({ sql, params, locked: db.inTransaction });
				yield* iterate(...params);
			};
		}
		if (sql === "SELECT memory_id, model FROM memory_vectors WHERE rowid = ?") {
			const get = statement.get.bind(statement);
			statement.get = (...params: unknown[]) => {
				current?.rereads.push(db.inTransaction);
				return get(...params);
			};
		}
		if (sql === "DELETE FROM memory_vectors WHERE rowid = ?") {
			const run = statement.run.bind(statement);
			statement.run = (...params: unknown[]) => {
				const result = run(...params);
				if (current) current.deleted += result.changes;
				return result;
			};
		}
		return statement;
	});
	return batches;
}
beforeEach(() => {
	vi.clearAllMocks();
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
	directory = mkdtempSync(join(tmpdir(), "codemem-migration-cutover-"));
	db = new Database(join(directory, "synthetic.sqlite"));
	db.pragma("journal_mode = WAL");
	initTestSchema(db);
	session = insertTestSession(db);
	db.prepare(`INSERT INTO memory_items(id, session_id, kind, title, body_text, active, created_at, updated_at)
		VALUES (1, ?, 'feature', 'One', 'Body', 1, '2026-09-01', '2026-09-01')`).run(session);
	vector(db, "test-model");
	vector(db, "old-model");
	writer = new Database(join(directory, "synthetic.sqlite"));
	loadSqliteVec(writer);
	writer.pragma("busy_timeout = 0");
	startMaintenanceJob(db, {
		kind: VECTOR_MODEL_MIGRATION_JOB,
		title: "Synthetic migration",
		status: "running",
		metadata: {
			source_model: "old-model",
			target_model: "test-model",
			last_cursor_id: 10000,
			processed_embeddable: 1,
			embeddable_total: 1,
		},
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	writer.close();
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("batched stale-model cleanup coverage", () => {
	it("streams one ID-and-model-filtered snapshot per 250-row deletion transaction across distinct memories", async () => {
		// Arrange: repeated content chunks across 251 memories span several native delete transactions.
		db.exec("DELETE FROM memory_vectors");
		const body = "x".repeat(3600);
		const chunks = embeddings.chunkText(body);
		expect(chunks.length).toBeGreaterThan(1);
		db.transaction(() => {
			for (let id = 1; id <= 251; id++) {
				if (id !== 1)
					db.prepare(`INSERT INTO memory_items(id, session_id, kind, title, body_text, active, created_at, updated_at)
					VALUES (?, ?, 'feature', '', ?, 1, '2026-09-01', '2026-09-01')`).run(id, session, body);
				else db.prepare("UPDATE memory_items SET title = '', body_text = ? WHERE id = 1").run(body);
				for (const [index, chunk] of chunks.entries()) {
					for (const model of ["test-model", "old-model"])
						db.prepare(`INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
						VALUES (?, ?, ?, ?, ?)`).run(
							Buffer.alloc(384 * 4),
							BigInt(id),
							BigInt(index),
							embeddings.hashText(chunk),
							model,
						);
				}
			}
		})();
		const observed = observeCleanupDeleteTransactions();
		// Act: count real streamed source reads while native immediate transactions hold the write lock.
		await runVectorMigrationPass(db);
		const batches = observed.filter((batch) => batch.deleted > 0);
		// Assert: repeated chunks and distinct IDs share one filtered coverage snapshot per batch.
		expect(batches.length).toBeGreaterThan(2);
		expect(batches.reduce((sum, batch) => sum + batch.deleted, 0)).toBe(251 * chunks.length);
		for (const batch of batches) {
			expect(batch.writerLocked).toBe(true);
			expect(batch.deleted).toBeLessThanOrEqual(250);
			expect(batch.scans).toHaveLength(1);
			expect(batch.rereads.length).toBeGreaterThan(0);
			expect(batch.rereads.every(Boolean)).toBe(true);
			const scan = batch.scans[0];
			expect(scan?.locked).toBe(true);
			expect(scan?.sql).toMatch(
				/memory_id IN \(SELECT value FROM json_each\(\?\)\) AND model = \?/,
			);
			expect(scan?.params[1]).toBe("test-model");
			expect(JSON.parse(String(scan?.params[0])).length).toBeLessThanOrEqual(250);
		}
		expect(job()).toMatchObject({ status: "completed", metadata: { cleanup_pending: false } });
		expect(
			db.prepare("SELECT COUNT(*) FROM memory_vectors WHERE model = 'test-model'").pluck().get(),
		).toBe(251 * chunks.length);
	});

	it.each([
		{ column: "rowid", shadow: true },
		{ column: "memory_id", shadow: true },
		{ column: "rowid", shadow: false },
		{ column: "memory_id", shadow: false },
	] as const)(
		"rejects an inexact legacy $column with shadow=$shadow without partial deletion",
		async ({ column, shadow }) => {
			// Arrange: the unsafe row shares a cleanup page with a safe, covered legacy peer.
			seedUnsafeLegacyVector(column, shadow);
			const before = vectorMetadata();
			// Act: capture the failure so preservation assertions also run against the old behavior.
			const error = await runVectorMigrationPass(db).then(
				() => undefined,
				(error: unknown) => error,
			);
			// Assert: neither rounded identity nor a safe prefix of the failed page may be deleted.
			expect.soft(vectorMetadata()).toEqual(before);
			expect(error).toBeInstanceOf(RangeError);
			expect((error as Error).message).toBe("Vector metadata IDs exceed the exact numeric range");
		},
	);
});

describe("runner cadence after legacy cleanup", () => {
	it.each(["safe", "rowid", "memory_id"] as const)(
		"reports %s cleanup and backs off instead of repeating full coverage every five seconds",
		async (column) => {
			// Arrange: runner connections stay on the synthetic fixture; inference and clocks are mocked.
			if (column !== "safe") seedUnsafeLegacyVector(column);
			const before = vectorMetadata();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const connect = vi
				.spyOn(database, "connect")
				.mockImplementation(() => new Database(join(directory, "synthetic.sqlite")));
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			const runner = new VectorModelMigrationRunner({
				dbPath: join(directory, "synthetic.sqlite"),
				intervalMs: 5000,
				idleIntervalMs: 60000,
			});
			try {
				// Act: finish one tick, then let three active-cadence intervals elapse.
				runner.start();
				await vi.advanceTimersByTimeAsync(100);
				const firstJob = job();
				await vi.advanceTimersByTimeAsync(15000);
				// Assert: successful cleanup and malformed metadata both leave the active cadence.
				expect.soft(connect).toHaveBeenCalledTimes(1);
				expect.soft(job()).toEqual(firstJob);
				expect(embeddings.embedTexts).not.toHaveBeenCalled();
				if (column === "safe") {
					expect(firstJob).toMatchObject({
						status: "completed",
						metadata: { cleanup_pending: false },
					});
					expect(vectorMetadata()).toHaveLength(1);
					expect(warning).not.toHaveBeenCalled();
				} else {
					expect.soft(vectorMetadata()).toEqual(before);
					expect(firstJob).toMatchObject({
						status: "failed",
						error: "Vector metadata IDs exceed the exact numeric range",
					});
					expect(warning).toHaveBeenCalledExactlyOnceWith(
						"Vector migration runner failed",
						new RangeError("Vector metadata IDs exceed the exact numeric range"),
					);
				}
			} finally {
				await runner.stop();
			}
		},
	);
});

describe("cleanup metadata rechecks after the scan and before the lock", () => {
	it.each(["target-loss", "fallback-model-switch", "fallback-id-switch"])(
		"retains fallback on %s before acquiring the deletion lock",
		async (change) => {
			// Arrange: memory two starts covered, but changing the source row's owner must recheck its coverage.
			db.prepare(`INSERT INTO memory_items(id, session_id, kind, title, body_text, active, created_at, updated_at)
			VALUES (2, ?, 'feature', 'Two', 'Body', 1, '2026-09-01', '2026-09-01')`).run(session);
			db.prepare(`INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
			VALUES (?, 2, 0, ?, 'test-model')`).run(
				Buffer.alloc(384 * 4),
				embeddings.hashText("Two\nBody"),
			);
			const stale = db
				.prepare("SELECT rowid FROM memory_vectors WHERE model = 'old-model'")
				.pluck()
				.get();
			let scanned = false;
			let injected = false;
			afterRead("vector-stale-scan-rowids", () => {
				scanned = true;
			});
			const transaction = db.transaction.bind(db);
			vi.spyOn(db, "transaction").mockImplementation((fn) => {
				if (!scanned || injected || db.inTransaction) return transaction(fn);
				injected = true;
				if (change === "target-loss")
					writer
						.prepare("DELETE FROM memory_vectors WHERE model = 'test-model' AND memory_id = 1")
						.run();
				if (change === "fallback-model-switch")
					writer
						.prepare("UPDATE memory_vectors SET model = 'test-model' WHERE rowid = ?")
						.run(stale);
				if (change === "fallback-id-switch") {
					writer.prepare("UPDATE memory_vectors SET memory_id = 2 WHERE rowid = ?").run(stale);
					writer
						.prepare("DELETE FROM memory_vectors WHERE model = 'test-model' AND memory_id = 2")
						.run();
				}
				return transaction(fn);
			});
			// Act
			await runVectorMigrationPass(db);
			// Assert: metadata and ownership must be fetched again inside the writer transaction.
			expect(injected).toBe(true);
			expect(
				db.prepare("SELECT memory_id, model FROM memory_vectors WHERE rowid = ?").get(stale),
			).toEqual({
				memory_id: change === "fallback-id-switch" ? 2 : 1,
				model: change === "fallback-model-switch" ? "test-model" : "old-model",
			});
			expect(job()?.metadata.cleanup_pending).toBe(true);
		},
	);
});
