import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSqliteVec } from "./db.js";
import { chunkText, hashText } from "./embeddings.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { readVectorCorpusFence } from "./vector-corpus-epoch.js";
import {
	prepareVectorCutoverValidation,
	type VectorCutoverValidation,
} from "./vector-cutover-validation.js";
import * as metadataSnapshots from "./vector-metadata-snapshot.js";
import {
	countIncompleteActiveMemoryVectorCoverage,
	findMemoryIdsWithCurrentTargetCoverage,
} from "./vectors.js";

let directory: string;
let db: Database;
let writer: Database;
let session: number;
const validations: VectorCutoverValidation[] = [];

function addMemory(id: number) {
	db.prepare(`INSERT INTO memory_items(id, session_id, kind, title, body_text, active, created_at, updated_at)
			VALUES (?, ?, 'feature', ?, 'Body', 1, '2026-09-01', '2026-09-01')`).run(
		id,
		session,
		`Memory ${id}`,
	);
}
function addVector(
	connection: Database,
	memoryId: number,
	model = "target",
	hash = hashText(`Memory ${memoryId}\nBody`),
	rowid?: number,
) {
	return Number(
		connection
			.prepare(`INSERT INTO memory_vectors(rowid, embedding, memory_id, chunk_index, content_hash, model)
			VALUES (?, ?, ?, 0, ?, ?)`)
			.run(
				rowid === undefined ? null : BigInt(rowid),
				Buffer.alloc(384 * 4),
				BigInt(memoryId),
				hash,
				model,
			).lastInsertRowid,
	);
}
function prepare(options: { signal?: AbortSignal } = {}) {
	const validation = prepareVectorCutoverValidation(db, "target", options);
	validations.push(validation);
	return validation;
}
function finalReason(validation: VectorCutoverValidation) {
	return db.transaction(() => validation.retryReason()).immediate();
}
function afterCoveragePage(callback: (rows: unknown[]) => void) {
	const original = db.prepare.bind(db);
	return vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
		const statement = original(sql);
		if (sql.includes("vector-coverage-validation")) {
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

function observeCatalogDeleteTransactions() {
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
		if (
			sql === "SELECT rowid, memory_id, model, content_hash FROM memory_vectors WHERE rowid = ?"
		) {
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
	directory = mkdtempSync(join(tmpdir(), "codemem-cutover-"));
	db = new Database(join(directory, "synthetic.sqlite"));
	db.pragma("journal_mode = WAL");
	initTestSchema(db);
	session = insertTestSession(db);
	writer = new Database(join(directory, "synthetic.sqlite"));
	loadSqliteVec(writer);
	writer.pragma("busy_timeout = 0");
	addMemory(1);
	addVector(db, 1);
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const validation of validations.splice(0)) validation.close();
	writer.close();
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("corpus fence with a legacy WAL writer", () => {
	it("accepts unrelated writes after every coverage page and never reads bodies in the final lock", () => {
		// Arrange: three non-empty pages plus the exhaustion probe.
		db.exec(
			"CREATE TABLE unrelated_activity(value INTEGER); INSERT INTO unrelated_activity VALUES (0)",
		);
		db.transaction(() => {
			for (let id = 2; id <= 501; id++) {
				addMemory(id);
				addVector(db, id);
			}
		})();
		let pages = 0;
		afterCoveragePage(() => {
			expect(db.inTransaction).toBe(false);
			writer.exec(
				"UPDATE unrelated_activity SET value = value + 1; UPDATE memory_items SET confidence = 0.8, updated_at = updated_at",
			);
			pages++;
		});
		const validation = prepare();
		const finalSql: string[] = [];
		const original = Database.prototype.prepare.bind(db);
		vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			finalSql.push(sql);
			return original(sql);
		});
		// Act: only schema, epoch and vector metadata are allowed in the final transaction.
		const reason = finalReason(validation);
		// Assert: the old global data_version fence would starve on all four commits.
		expect(pages).toBe(4);
		expect(validation.uncovered).toBe(0);
		expect(reason).toBeNull();
		expect(finalSql.join("\n")).not.toMatch(/body_text|FROM memory_items/i);
		expect(finalSql.some((sql) => sql.includes("vector-cutover-exact-metadata"))).toBe(true);
	});

	it.each([
		"UPDATE memory_items SET id = 2 WHERE id = 1",
		"UPDATE memory_items SET title = 'Edited' WHERE id = 1",
		"UPDATE memory_items SET body_text = 'Edited' WHERE id = 1",
		"UPDATE memory_items SET active = 0 WHERE id = 1",
		"DELETE FROM memory_items WHERE id = 1",
		"UPDATE memory_items SET body_text = 'temporary'; UPDATE memory_items SET body_text = 'Body'",
	])("rejects raw SQL corpus mutation after validation: %s", (sql) => {
		// Arrange
		const validation = prepare();
		// Act
		writer.exec(sql);
		// Assert: even an ABA edit invalidates the saved body hashes.
		expect(finalReason(validation)).toMatch(/Memory changes arrived/);
	});
});

describe("exact metadata fence with a legacy WAL writer", () => {
	it.each(["insert", "delete", "hash", "model", "memory", "row-reuse", "target-ABA"])(
		"rejects vector-only %s without a corpus/job write",
		(mutation) => {
			// Arrange: the legacy writer knows nothing about epochs or jobs.
			const rowid = Number(db.prepare("SELECT rowid FROM memory_vectors").pluck().get());
			const validation = prepare();
			const fence = readVectorCorpusFence(db);
			// Act
			if (mutation !== "insert")
				writer.prepare("DELETE FROM memory_vectors WHERE rowid = ?").run(rowid);
			switch (mutation) {
				case "insert":
					addVector(writer, 1);
					break;
				case "hash":
					addVector(writer, 1, "target", "changed", rowid);
					break;
				case "model":
					addVector(writer, 1, "other", undefined, rowid);
					break;
				case "memory":
					addVector(writer, 2, "target", hashText("Memory 1\nBody"), rowid);
					break;
				case "row-reuse":
					addVector(writer, 2, "target", "replacement", rowid);
					break;
				case "target-ABA":
					addVector(writer, 1, "other", "intermediate", rowid);
					writer.prepare("DELETE FROM memory_vectors WHERE rowid = ?").run(rowid);
					addVector(writer, 1, "target", "different-final-hash", rowid);
					break;
			}
			// Assert: exact row identity and cardinality catch mutations the epoch cannot see.
			expect(readVectorCorpusFence(db)).toEqual(fence);
			expect(finalReason(validation)).toMatch(/Target vector metadata changed/);
		},
	);

	it.each(["embedding", "chunk_index", "identical-ABA", "other-model"])(
		"allows coverage-neutral %s changes",
		(mutation) => {
			// Arrange
			const rowid = Number(db.prepare("SELECT rowid FROM memory_vectors").pluck().get());
			const validation = prepare();
			// Act: saved equality ignores blob/chunk positions, and identical final metadata is safe.
			if (mutation === "embedding")
				writer
					.prepare("UPDATE memory_vectors SET embedding = ? WHERE rowid = ?")
					.run(Buffer.alloc(384 * 4, 1), rowid);
			if (mutation === "chunk_index")
				writer.prepare("UPDATE memory_vectors SET chunk_index = 7 WHERE rowid = ?").run(rowid);
			if (mutation === "identical-ABA") {
				writer.prepare("DELETE FROM memory_vectors WHERE rowid = ?").run(rowid);
				addVector(writer, 1, "target", undefined, rowid);
			}
			if (mutation === "other-model") addVector(writer, 1, "other");
			// Assert
			expect(finalReason(validation)).toBeNull();
		},
	);
});

describe("saved coverage and conservative retry paths", () => {
	it("uses saved catalog coverage rather than a newly inserted live hash", () => {
		// Arrange: the catalog is incomplete when copied, then a vector-only writer fills the hole.
		db.exec("DELETE FROM memory_vectors");
		let inserted = false;
		afterCoveragePage(() => {
			if (!inserted) {
				inserted = true;
				addVector(writer, 1);
			}
		});
		// Act
		const validation = prepare();
		// Assert: live coverage must not convert an incomplete saved proof into success.
		expect(validation.uncovered).toBe(1);
		expect(finalReason(validation)).toMatch(/Target vector metadata changed/);
	});

	it("accounts for its own obsolete-target deletions but not a foreign deletion", () => {
		// Arrange
		addVector(db, 1, "target", "obsolete");
		// Act
		const validation = prepare();
		const accepted = finalReason(validation);
		writer.exec("DELETE FROM memory_vectors");
		// Assert: only successful local prune deletes update the saved catalog.
		expect(validation.deleted).toBe(1);
		expect(validation.uncovered).toBe(0);
		expect(accepted).toBeNull();
		expect(finalReason(validation)).toMatch(/Target vector metadata changed/);
	});

	it("does not prune a stale rowid replaced by a current chunk before the delete lock", () => {
		// Arrange: replace an obsolete candidate between its unlocked body read and recheck.
		const rowid = addVector(db, 1, "target", "obsolete");
		const original = db.prepare.bind(db);
		let replaced = false;
		vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			const statement = original(sql);
			if (sql === "SELECT title, body_text, active FROM memory_items WHERE id = ?") {
				const get = statement.get.bind(statement);
				statement.get = (...params: unknown[]) => {
					const row = get(...params);
					if (!replaced) {
						replaced = true;
						writer.prepare("DELETE FROM memory_vectors WHERE rowid = ?").run(BigInt(rowid));
						addVector(writer, 1, "target", undefined, rowid);
					}
					return row;
				};
			}
			return statement;
		});
		// Act
		const validation = prepare();
		// Assert: mismatched row identity survives; it is not mistaken for our own deletion.
		expect(replaced).toBe(true);
		expect(validation.deleted).toBe(0);
		expect(
			db.prepare("SELECT content_hash FROM memory_vectors WHERE rowid = ?").pluck().get(rowid),
		).toBe(hashText("Memory 1\nBody"));
		expect(finalReason(validation)).toMatch(/Target vector metadata changed/);
	});
});

describe("validation fallback and interruption", () => {
	it.each(["external", "same-connection"])(
		"falls back conservatively for %s writes when epoch guards are missing",
		(kind) => {
			// Arrange
			db.exec("DROP TRIGGER vector_corpus_epoch_update; CREATE TABLE unrelated_activity(value)");
			const validation = prepare();
			expect(finalReason(validation)).toBeNull();
			// Act
			(kind === "external" ? writer : db).exec("INSERT INTO unrelated_activity VALUES (1)");
			// Assert
			expect(finalReason(validation)).toMatch(/Memory changes arrived/);
		},
	);

	it("rejects schema replacement even when the epoch value is unchanged", () => {
		// Arrange
		const validation = prepare();
		// Act
		writer.exec("CREATE TABLE unrelated_schema(value)");
		// Assert
		expect(finalReason(validation)).toMatch(/Database schema changed/);
	});

	it("fails closed on shutdown after preparation", () => {
		// Arrange
		const controller = new AbortController();
		const validation = prepare({ signal: controller.signal });
		expect(finalReason(validation)).toBeNull();
		// Act
		controller.abort();
		// Assert
		expect(finalReason(validation)).toMatch(/shutdown/);
	});

	it.each(["target", "non-target", "empty"])(
		"fails closed at the metadata deadline for a %s stream",
		(stream) => {
			// Arrange: a fake monotonic clock avoids slow/flaky timing assertions.
			if (stream !== "target") db.exec("DELETE FROM memory_vectors");
			if (stream === "non-target") addVector(db, 1, "other");
			const validation = prepare();
			vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(2001);
			// Act
			const reason = finalReason(validation);
			// Assert: the empty stream also checks elapsed time after its final native step.
			expect(reason).toMatch(/exceeded 2 seconds/);
			expect(db.inTransaction).toBe(false);
		},
	);
});

describe("metadata numeric safety", () => {
	it.each(["rowid", "memory_id"])(
		"rejects an inexact %s introduced after catalog capture",
		(column) => {
			// Arrange: a legacy writer can store a valid SQLite integer outside JS's exact range.
			const validation = prepare();
			const huge = 9007199254740993n;
			// Act
			writer
				.prepare(`INSERT INTO memory_vectors(rowid, embedding, memory_id, chunk_index, content_hash, model)
			VALUES (?, ?, ?, 0, 'hash', 'target')`)
				.run(
					column === "rowid" ? huge : null,
					Buffer.alloc(384 * 4),
					column === "memory_id" ? huge : 1n,
				);
			// Assert: rounding must never make two distinct rows appear equal.
			expect(finalReason(validation)).toMatch(/IDs exceed the exact numeric range/);
		},
	);

	it.each(["rowid", "memory_id"])(
		"refuses to build a rounded catalog from an inexact %s",
		(column) => {
			// Arrange
			const huge = 9007199254740993n;
			writer
				.prepare(`INSERT INTO memory_vectors(rowid, embedding, memory_id, chunk_index, content_hash, model)
			VALUES (?, ?, ?, 0, 'hash', 'target')`)
				.run(
					column === "rowid" ? huge : null,
					Buffer.alloc(384 * 4),
					column === "memory_id" ? huge : 1n,
				);
			// Act / Assert: construction fails before any cutover or deletion can occur.
			expect(() => prepare()).toThrow(/IDs exceed the exact numeric range/);
			expect(db.inTransaction).toBe(false);
			expect(db.prepare("SELECT COUNT(*) FROM memory_vectors").pluck().get()).toBe(2);
		},
	);
});

describe("active-memory cursor numeric safety", () => {
	function traceCoveragePages() {
		const cursors: unknown[] = [];
		const original = db.prepare.bind(db);
		vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			const statement = original(sql);
			if (sql.includes("vector-coverage-validation")) {
				const all = statement.all.bind(statement);
				statement.all = (...params: unknown[]) => {
					// Stop a broken rounded cursor synchronously; a test timeout cannot interrupt it.
					if (cursors.length >= 4) throw new Error("Coverage page limit exceeded");
					cursors.push(params[0]);
					return all(...params);
				};
			}
			return statement;
		});
		return cursors;
	}

	function traceCatalogs() {
		const catalogs: Array<{ metadata: Database; lookups: unknown[] }> = [];
		const create = metadataSnapshots.createVectorMetadataSnapshot;
		vi.spyOn(metadataSnapshots, "createVectorMetadataSnapshot").mockImplementation((...args) => {
			const metadata = create(...args);
			const lookups: unknown[] = [];
			const original = metadata.prepare.bind(metadata);
			vi.spyOn(metadata, "prepare").mockImplementation((sql: string) => {
				const statement = original(sql);
				if (sql.includes("SELECT 1 FROM vector_metadata")) {
					const get = statement.get.bind(statement);
					statement.get = (...params: unknown[]) => {
						lookups.push(params[0]);
						return get(...params);
					};
				}
				return statement;
			});
			catalogs.push({ metadata, lookups });
			return metadata;
		});
		return catalogs;
	}

	function addUnsafeMemory() {
		db.prepare(`INSERT INTO memory_items(id, session_id, kind, title, body_text, active, created_at, updated_at)
			VALUES (?, ?, 'feature', 'Unsafe ID', 'Body', 1, '2026-09-01', '2026-09-01')`).run(
			9007199254740993n,
			session,
		);
	}

	it("rejects an unsafe later page without repeating it and closes its owned catalog", () => {
		// Arrange: the safe first page opens a catalog before the inexact ID is fetched.
		for (let id = 2; id <= 250; id++) addMemory(id);
		addUnsafeMemory();
		const cursors = traceCoveragePages();
		const catalogs = traceCatalogs();
		// Act / Assert: reject before hashing or looking up the rounded memory ID.
		expect(() => countIncompleteActiveMemoryVectorCoverage(db, "target")).toThrow(RangeError);
		expect(cursors).toEqual([0, 250]);
		expect(catalogs).toHaveLength(1);
		expect(catalogs[0]?.lookups).toEqual(Array.from({ length: 250 }, (_, index) => index + 1));
		expect(catalogs[0]?.metadata.open).toBe(false);
		expect(db.inTransaction).toBe(false);
	});

	it("leaves a supplied catalog open when an unsafe first page fails", () => {
		// Arrange: the caller, not coverage counting, owns this snapshot.
		addUnsafeMemory();
		const catalogs = traceCatalogs();
		const metadata = metadataSnapshots.createVectorMetadataSnapshot(db, { model: "target" });
		const cursors = traceCoveragePages();
		try {
			// Act / Assert: validate the entire page before looking up even its safe row.
			expect(() => countIncompleteActiveMemoryVectorCoverage(db, "target", { metadata })).toThrow(
				RangeError,
			);
			expect(cursors).toEqual([0]);
			expect(catalogs[0]?.lookups).toEqual([]);
			expect(metadata.open).toBe(true);
		} finally {
			metadata.close();
		}
	});

	it("closes the prepare wrapper's supplied catalog when active-memory IDs are unsafe", () => {
		// Arrange: unsafe active content has no vector row to trip metadata numeric checks.
		addUnsafeMemory();
		const cursors = traceCoveragePages();
		const catalogs = traceCatalogs();
		// Act / Assert: preparation must propagate the explicit failure and release its snapshot.
		expect(() => prepare()).toThrow(RangeError);
		expect(cursors).toEqual([0]);
		expect(catalogs).toHaveLength(1);
		expect(catalogs[0]?.lookups).toEqual([]);
		expect(catalogs[0]?.metadata.open).toBe(false);
		expect(db.inTransaction).toBe(false);
	});

	it.each(["owned", "supplied", "wrapper"])(
		"supports MAX_SAFE_INTEGER with a %s catalog",
		(owner) => {
			// Arrange: the exact numeric boundary remains a supported persisted ID.
			addMemory(Number.MAX_SAFE_INTEGER);
			addVector(db, Number.MAX_SAFE_INTEGER);
			const cursors = traceCoveragePages();
			const metadata = metadataSnapshots.createVectorMetadataSnapshot(db, { model: "target" });
			try {
				// Act
				let uncovered: number;
				if (owner === "wrapper") uncovered = prepare().uncovered;
				else if (owner === "supplied")
					uncovered = countIncompleteActiveMemoryVectorCoverage(db, "target", { metadata });
				else uncovered = countIncompleteActiveMemoryVectorCoverage(db, "target");
				// Assert: exact hash lookup and the final cursor retain the original numeric ID.
				expect(uncovered).toBe(0);
				expect(cursors).toEqual([0, Number.MAX_SAFE_INTEGER]);
				expect(metadata.open).toBe(true);
			} finally {
				metadata.close();
			}
		},
	);
});

describe("batched saved-catalog prune coverage", () => {
	it("streams one ID-and-model-filtered snapshot per delete transaction for distinct memories and repeated chunks", () => {
		// Arrange: 251 memories cross catalog pages; repeated chunks must not multiply coverage scans.
		db.exec("DELETE FROM memory_vectors");
		const body = "x".repeat(3600);
		const chunks = chunkText(body);
		expect(chunks.length).toBeGreaterThan(1);
		db.transaction(() => {
			for (let id = 1; id <= 251; id++) {
				if (id !== 1) addMemory(id);
				db.prepare("UPDATE memory_items SET title = '', body_text = ? WHERE id = ?").run(body, id);
				for (const [index, chunk] of chunks.entries()) {
					const rowid = addVector(db, id, "target", hashText(chunk));
					db.prepare("UPDATE memory_vectors SET chunk_index = ? WHERE rowid = ?").run(
						BigInt(index),
						BigInt(rowid),
					);
				}
				addVector(db, id, "target", "obsolete-first");
				addVector(db, id, "target", "obsolete-second");
			}
		})();
		const observed = observeCatalogDeleteTransactions();
		// Act: scans below count actual source iterator executions, not helper calls/prepares.
		const validation = prepare();
		const batches = observed.filter((batch) => batch.deleted > 0);
		// Assert: each <=250-row deletion transaction owns one filtered snapshot and fresh metadata reads.
		expect(validation.deleted).toBe(502);
		expect(validation.uncovered).toBe(0);
		expect(batches.length).toBeGreaterThan(2);
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
			expect(scan?.params[1]).toBe("target");
			expect(JSON.parse(String(scan?.params[0])).length).toBeLessThanOrEqual(250);
		}
		expect(db.prepare("SELECT COUNT(*) FROM memory_vectors").pluck().get()).toBe(
			251 * chunks.length,
		);
	});

	it.each(["target-loss", "candidate-model-change", "candidate-id-change"])(
		"rechecks live metadata after locking on %s",
		(change) => {
			// Arrange: a legacy writer changes vec0 after the unlocked candidate body read.
			const stale = addVector(db, 1, "target", "obsolete");
			const original = db.prepare.bind(db);
			let injected = false;
			const mutateCandidate = () => {
				if (change === "target-loss")
					writer
						.prepare("DELETE FROM memory_vectors WHERE content_hash = ?")
						.run(hashText("Memory 1\nBody"));
				else if (change === "candidate-model-change")
					writer.prepare("UPDATE memory_vectors SET model = 'other' WHERE rowid = ?").run(stale);
				else writer.prepare("UPDATE memory_vectors SET memory_id = 999 WHERE rowid = ?").run(stale);
			};
			vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
				const statement = original(sql);
				if (sql === "SELECT title, body_text, active FROM memory_items WHERE id = ?") {
					const get = statement.get.bind(statement);
					statement.get = (...params: unknown[]) => {
						const row = get(...params);
						if (injected) return row;
						injected = true;
						mutateCandidate();
						return row;
					};
				}
				return statement;
			});
			// Act
			const validation = prepare();
			// Assert: no stale catalog entry authorizes deleting the changed or uncovered row.
			expect(injected).toBe(true);
			expect(validation.deleted).toBe(0);
			expect(
				db.prepare("SELECT content_hash FROM memory_vectors WHERE rowid = ?").pluck().get(stale),
			).toBe("obsolete");
			expect(finalReason(validation)).toMatch(/Target vector metadata changed/);
		},
	);
});

describe("batch coverage legacy metadata semantics", () => {
	it("skips the metadata source scan when every reference is missing or inactive", () => {
		// Arrange: neither an inactive memory nor an orphan needs a target embedding.
		addMemory(2);
		db.exec("UPDATE memory_items SET active = 0 WHERE id = 2");
		const observed = observeCatalogDeleteTransactions();
		// Act
		const covered = db
			.transaction(() => findMemoryIdsWithCurrentTargetCoverage(db, [2, 999], "target"))
			.immediate();
		// Assert: the shortcut does not accidentally perform a full or filtered vector scan.
		expect([...covered]).toEqual([2, 999]);
		expect(observed.map((batch) => batch.scans.length)).toEqual([0]);
		expect(observed[0]?.writerLocked).toBe(true);
	});

	it("preserves exact zero/negative IDs and excludes unsafe IDs without treating uncovered active memories as orphans", () => {
		// Arrange: unlike queued IDs, persisted vector references may be zero or negative.
		for (const id of [0, -1, 2, 3, Number.MAX_SAFE_INTEGER]) addMemory(id);
		for (const id of [0, -1, Number.MAX_SAFE_INTEGER]) addVector(db, id);
		db.exec("UPDATE memory_items SET active = 0 WHERE id = 2");
		const ids = [
			1,
			0,
			-1,
			2,
			3,
			999,
			Number.MAX_SAFE_INTEGER,
			Number.MAX_SAFE_INTEGER + 1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		];
		// Act
		const covered = db
			.transaction(() => findMemoryIdsWithCurrentTargetCoverage(db, ids, "target"))
			.immediate();
		// Assert: inactive/missing references are deletable, but real uncovered memories are not.
		expect([...covered]).toEqual([1, 0, -1, 2, 999, Number.MAX_SAFE_INTEGER]);
	});

	it("prunes null/orphan/inactive references and null hashes only when active coverage permits it", () => {
		// Arrange: an ordinary-table fixture represents nullable legacy metadata vec0 cannot insert today.
		addMemory(2);
		addMemory(3);
		db.exec(`UPDATE memory_items SET active = 0 WHERE id = 2;
			CREATE TEMP TABLE memory_vectors(rowid INTEGER PRIMARY KEY, memory_id INTEGER, model TEXT, content_hash TEXT);
			INSERT INTO memory_vectors VALUES (1, NULL, 'target', 'orphan'), (2, 999, 'target', 'orphan'),
			(3, 2, 'target', 'inactive'), (4, 3, 'target', 'uncovered'), (5, 1, 'target', NULL)`);
		db.prepare("INSERT INTO memory_vectors VALUES (6, 1, 'target', ?)").run(
			hashText("Memory 1\nBody"),
		);
		const observed = observeCatalogDeleteTransactions();
		// Act
		const validation = prepare();
		// Assert: uncovered fallback survives; missing/inactive/null references need no target hash.
		expect(validation.deleted).toBe(4);
		expect(validation.uncovered).toBe(1);
		expect(db.prepare("SELECT rowid FROM memory_vectors ORDER BY rowid").pluck().all()).toEqual([
			4, 6,
		]);
		expect(
			observed.filter((batch) => batch.deleted > 0).map((batch) => batch.scans.length),
		).toEqual([1]);
	});
});
