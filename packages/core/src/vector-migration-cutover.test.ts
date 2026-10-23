import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSqliteVec } from "./db.js";
import * as embeddings from "./embeddings.js";
import {
	completeMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import {
	queueVectorBackfillForIncrementalSync,
	runVectorMigrationPass,
	VECTOR_MODEL_MIGRATION_JOB,
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

describe("atomic migration cutover", () => {
	it("completes despite a legacy writer committing after every validation page", async () => {
		// Arrange: complete target coverage avoids inference; writer remains independently writable.
		db.exec("CREATE TABLE unrelated_activity(value); INSERT INTO unrelated_activity VALUES (0)");
		let pages = 0;
		afterRead("vector-coverage-validation", () => {
			writer.exec("UPDATE unrelated_activity SET value = value + 1");
			pages++;
		});
		// Act
		await runVectorMigrationPass(db);
		// Assert: both cutover and subsequent cleanup finish without a retry.
		expect(pages).toBeGreaterThanOrEqual(2);
		expect(job()).toMatchObject({
			status: "completed",
			metadata: { cleanup_pending: false, cutover_retry_count: 0 },
		});
		expect(db.prepare("SELECT model FROM memory_vectors").pluck().all()).toEqual(["test-model"]);
		expect(embeddings.embedTexts).not.toHaveBeenCalled();
	});

	it.each(["queue", "cancel", "target", "message"])(
		"preserves a concurrent %s job change before cutover",
		async (change) => {
			// Arrange
			let injected = false;
			afterRead("vector-coverage-validation", () => {
				if (injected) return;
				injected = true;
				if (change === "queue")
					queueVectorBackfillForIncrementalSync(writer, {
						upsertMemoryIds: [1],
						deleteMemoryIds: [],
					});
				if (change === "cancel")
					updateMaintenanceJob(writer, VECTOR_MODEL_MIGRATION_JOB, { status: "cancelled" });
				if (change === "target")
					updateMaintenanceJob(writer, VECTOR_MODEL_MIGRATION_JOB, {
						metadata: { target_model: "replacement" },
					});
				if (change === "message")
					updateMaintenanceJob(writer, VECTOR_MODEL_MIGRATION_JOB, {
						message: "Concurrent owner update",
					});
			});
			// Act
			await runVectorMigrationPass(db);
			// Assert: stale validation never overwrites another job or discards pending IDs.
			expect(injected).toBe(true);
			expect(job()?.status).not.toBe("completed");
			expect(
				db.prepare("SELECT COUNT(*) FROM memory_vectors WHERE model = 'old-model'").pluck().get(),
			).toBe(1);
			if (change === "queue")
				expect(job()?.metadata).toMatchObject({
					pending_upsert_memory_ids: [1],
					queue_revision: 1,
				});
			if (change === "cancel") expect(job()?.status).toBe("cancelled");
			if (change === "target") expect(job()?.metadata.target_model).toBe("replacement");
			if (change === "message") expect(job()?.message).toBe("Concurrent owner update");
		},
	);

	it.each(["abort", "shutdown", "deadline"])(
		"retains fallback when %s interrupts final cutover",
		async (interrupt) => {
			// Arrange: inject after coverage has completed, before final BEGIN IMMEDIATE.
			const controller = new AbortController();
			let stop = false;
			afterRead("vector-coverage-validation", (rows) => {
				if (rows.length !== 0) return;
				if (interrupt === "abort") controller.abort();
				if (interrupt === "shutdown") stop = true;
				if (interrupt === "deadline")
					vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(2001);
			});
			// Act
			await runVectorMigrationPass(db, { signal: controller.signal, shouldStop: () => stop });
			// Assert: no timeout/shutdown path can publish completed state or remove fallback.
			expect(job()).toMatchObject({ status: "running", metadata: { cutover_retry_count: 1 } });
			expect(job()?.message).toMatch(interrupt === "deadline" ? /exceeded 2 seconds/ : /shutdown/);
			expect(
				db.prepare("SELECT COUNT(*) FROM memory_vectors WHERE model = 'old-model'").pluck().get(),
			).toBe(1);
		},
	);
});

describe("cleanup rechecks inside the writer transaction", () => {
	it("finishes multi-batch cleanup while unrelated commits arrive on every scan page", async () => {
		// Arrange: more than two 250-row delete batches, all with current target coverage.
		db.exec("CREATE TABLE unrelated_activity(value); INSERT INTO unrelated_activity VALUES (0)");
		db.transaction(() => {
			for (let index = 0; index < 500; index++) vector(db, "old-model");
		})();
		let pages = 0;
		afterRead("vector-stale-scan-rowids", () => {
			expect(db.inTransaction).toBe(false);
			writer.exec("UPDATE unrelated_activity SET value = value + 1");
			pages++;
		});
		// Act
		await runVectorMigrationPass(db);
		// Assert: unrelated data_version changes cannot trap cleanup on its first batch.
		expect(pages).toBeGreaterThan(2);
		expect(job()).toMatchObject({
			status: "completed",
			metadata: { cleanup_pending: false, removed_stale_rows: 501 },
		});
		expect(db.prepare("SELECT model FROM memory_vectors").pluck().all()).toEqual(["test-model"]);
	});

	it.each(["coverage-loss", "row-model-switch", "job-model-switch"])(
		"does not delete stale candidates after %s",
		async (change) => {
			// Arrange: resume cleanup on a previously completed migration.
			updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				metadata: { ...job()?.metadata, cleanup_pending: true },
			});
			completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
			let injected = false;
			afterRead("vector-stale-scan-rowids", (rows) => {
				if (injected || rows.length === 0) return;
				injected = true;
				if (change === "coverage-loss")
					writer.prepare("DELETE FROM memory_vectors WHERE model = ?").run("test-model");
				if (change === "row-model-switch")
					writer
						.prepare("UPDATE memory_vectors SET model = ? WHERE model = ?")
						.run("test-model", "old-model");
				if (change === "job-model-switch")
					updateMaintenanceJob(writer, VECTOR_MODEL_MIGRATION_JOB, {
						metadata: { target_model: "replacement", cleanup_pending: true },
					});
			});
			// Act
			await runVectorMigrationPass(db);
			// Assert: missing target coverage retains fallback; switched rows/jobs are not stale work.
			expect(injected).toBe(true);
			if (change === "coverage-loss") {
				expect(db.prepare("SELECT model FROM memory_vectors").pluck().all()).toEqual(["old-model"]);
				expect(job()?.metadata.cleanup_pending).toBe(true);
			}
			if (change === "row-model-switch")
				expect(db.prepare("SELECT model FROM memory_vectors").pluck().all()).toEqual([
					"test-model",
					"test-model",
				]);
			if (change === "job-model-switch") {
				expect(job()?.metadata.target_model).toBe("replacement");
				expect(db.prepare("SELECT COUNT(*) FROM memory_vectors").pluck().get()).toBe(2);
			}
		},
	);

	it("records only the scanned watermark and discovers a later legacy insertion next pass", async () => {
		// Arrange: add a legacy vector after the scan's last page is copied into JS.
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			metadata: { ...job()?.metadata, cleanup_pending: true },
		});
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		let inserted: number | undefined;
		let scanned = 0;
		const spy = afterRead("vector-stale-scan-rowids", (rows) => {
			if (inserted !== undefined) return;
			if (rows.length > 0) {
				scanned = Number((rows.at(-1) as { rowid: number }).rowid);
				return;
			}
			inserted = vector(writer, "old-model");
		});
		// Act
		await runVectorMigrationPass(db);
		spy.mockRestore();
		const watermark = job()?.metadata.stale_scan_exhausted_max_rowid;
		const remaining = db
			.prepare("SELECT rowid FROM memory_vectors WHERE model = 'old-model'")
			.pluck()
			.all();
		await runVectorMigrationPass(db);
		// Assert: a post-scan MAX(rowid) must not hide unexamined legacy work.
		expect(inserted).toBeGreaterThan(scanned);
		expect(watermark).toBe(scanned);
		expect(remaining).toEqual([inserted]);
		expect(
			db.prepare("SELECT COUNT(*) FROM memory_vectors WHERE model = 'old-model'").pluck().get(),
		).toBe(0);
		expect(job()?.metadata.cleanup_pending).toBe(false);
	});
});

describe("cleanup ownership across runner handoffs", () => {
	it.each(
		["between-batches", "accepted-cleanup", "committed-cutover"].flatMap((handoff) =>
			["same-start", "new-start"].flatMap((owner) =>
				[true, false].map((cleanupPending) => ({ handoff, owner, cleanupPending })),
			),
		),
	)(
		"does not adopt a replacement at $handoff ($owner, pending=$cleanupPending)",
		async ({ handoff, owner, cleanupPending }) => {
			// Arrange: 251 stale rows force the old cleanup runner to yield after its first batch.
			db.transaction(() => {
				for (let index = 0; index < 250; index++) vector(db, "old-model");
			})();
			if (handoff !== "committed-cutover")
				completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
					metadata: { ...job()?.metadata, cleanup_pending: true },
				});
			const readOwner = () =>
				writer
					.prepare("SELECT * FROM maintenance_jobs WHERE kind = ?")
					.get(VECTOR_MODEL_MIGRATION_JOB);
			let replacement: unknown;
			let deletes = 0;
			let validated = false;
			const replaceOwner = () => {
				updateMaintenanceJob(writer, VECTOR_MODEL_MIGRATION_JOB, {
					message: "Replacement owns all subsequent cleanup",
					metadata: {
						...job()?.metadata,
						cleanup_pending: cleanupPending,
						removed_stale_rows: 700,
						stale_scan_exhausted: true,
						stale_scan_exhausted_max_rowid: 9001,
						queue_revision: 87,
						pending_upsert_memory_ids: [],
						pending_delete_memory_ids: [],
					},
				});
				if (owner === "new-start")
					writer
						.prepare("UPDATE maintenance_jobs SET started_at = ? WHERE kind = ?")
						.run("2099-01-01", VECTOR_MODEL_MIGRATION_JOB);
				replacement = readOwner();
			};
			const prepare = db.prepare.bind(db);
			vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
				if (sql.includes("vector-cutover-exact-metadata") && db.inTransaction) validated = true;
				const statement = prepare(sql);
				if (sql === "DELETE FROM memory_vectors WHERE rowid = ?") {
					const run = statement.run.bind(statement);
					statement.run = (...args: unknown[]) => {
						deletes++;
						return run(...args);
					};
				}
				return statement;
			});
			const transaction = db.transaction.bind(db);
			vi.spyOn(db, "transaction").mockImplementation((fn) => {
				const native = transaction(fn);
				return Object.assign((...args: unknown[]) => native(...args), {
					default: native.default,
					deferred: native.deferred,
					exclusive: native.exclusive,
					immediate: (...args: unknown[]) => {
						const before = deletes;
						validated = false;
						const result = native.immediate(...args);
						if (replacement) return result;
						const batchRecorded =
							before === 250 && deletes === 250 && job()?.metadata.removed_stale_rows === 250;
						const firstHandoff = validated && deletes === 0 && job()?.status === "completed";
						const ready = handoff === "between-batches" ? batchRecorded : firstHandoff;
						if (ready) replaceOwner();
						return result;
					},
				});
			});
			// Act: replace only after the native validation/result transaction has committed.
			await runVectorMigrationPass(db);
			// Assert: first-handoff replacements permit no DELETE; inter-batch replacements permit only batch one.
			expect(replacement).toBeDefined();
			expect.soft(deletes).toBe(handoff === "between-batches" ? 250 : 0);
			expect(readOwner()).toEqual(replacement);
		},
	);
});

describe("cleanup ownership after an unlocked fence check", () => {
	it.each(
		["before-delete", "after-delete"].flatMap((timing) =>
			["started_at", "metadata", "message"].flatMap((change) =>
				[true, false].map((cleanupPending) => ({ timing, change, cleanupPending })),
			),
		),
	)(
		"preserves the exact cleanup owner replaced $timing ($change, pending=$cleanupPending)",
		async ({ timing, change, cleanupPending }) => {
			// Arrange: retain distinctive counters, queue and watermark on a same-target owner.
			updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				metadata: {
					...job()?.metadata,
					cleanup_pending: true,
					removed_stale_rows: 73,
					stale_scan_exhausted: true,
					stale_scan_exhausted_max_rowid: 999,
					queue_revision: 23,
					pending_upsert_memory_ids: [],
					pending_delete_memory_ids: [],
				},
			});
			completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
			const readOwner = () =>
				writer
					.prepare("SELECT * FROM maintenance_jobs WHERE kind = ?")
					.get(VECTOR_MODEL_MIGRATION_JOB);
			let replacement: unknown;
			let deletes = 0;
			const replaceOwner = () => {
				if (replacement) return;
				const metadata = { ...job()?.metadata, cleanup_pending: cleanupPending };
				if (change === "metadata")
					Object.assign(metadata, { removed_stale_rows: 91, stale_scan_exhausted_max_rowid: 4321 });
				updateMaintenanceJob(writer, VECTOR_MODEL_MIGRATION_JOB, {
					metadata,
					...(change === "message" ? { message: "Replacement cleanup owner" } : {}),
				});
				if (change === "started_at")
					writer
						.prepare("UPDATE maintenance_jobs SET started_at = ? WHERE kind = ?")
						.run("2099-01-01", VECTOR_MODEL_MIGRATION_JOB);
				replacement = readOwner();
			};
			const prepare = db.prepare.bind(db);
			const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
				const statement = prepare(sql);
				if (timing === "before-delete" && sql.includes("vector-stale-scan-rowids")) {
					const all = statement.all.bind(statement);
					statement.all = (...args: unknown[]) => {
						const rows = all(...args);
						if (rows.length) replaceOwner();
						return rows;
					};
				}
				if (sql === "DELETE FROM memory_vectors WHERE rowid = ?") {
					const run = statement.run.bind(statement);
					statement.run = (...args: unknown[]) => {
						deletes++;
						return run(...args);
					};
				}
				return statement;
			});
			const transaction = db.transaction.bind(db);
			const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((fn) => {
				const native = transaction(fn);
				return Object.assign((...args: unknown[]) => native(...args), {
					default: native.default,
					deferred: native.deferred,
					exclusive: native.exclusive,
					immediate: (...args: unknown[]) => {
						const result = native.immediate(...args);
						if (timing === "after-delete" && deletes > 0) replaceOwner();
						return result;
					},
				});
			});
			// Act: the independent WAL writer commits outside the native DELETE transaction.
			await runVectorMigrationPass(db);
			prepareSpy.mockRestore();
			transactionSpy.mockRestore();
			// Assert: no stale counts, flags, message, watermark or queue may reach the replacement.
			expect(replacement, `${timing}/${change}/${cleanupPending}`).toBeDefined();
			expect.soft(deletes).toBe(timing === "after-delete" ? 1 : 0);
			expect(readOwner(), `${timing}/${change}/${cleanupPending}`).toEqual(replacement);
		},
	);

	it("does not complete a newly queued job when a corpus edit defers old cleanup", async () => {
		// Arrange: the other writer queues work after the old cleanup-job check,
		// but before the unlocked corpus fence detects the body edit.
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			metadata: { ...job()?.metadata, cleanup_pending: true },
		});
		completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		let compared = false;
		let injected = false;
		const prepare = db.prepare.bind(db);
		vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			if (sql.includes("vector-cutover-exact-metadata")) compared = true;
			return prepare(sql);
		});
		const pragma = db.pragma.bind(db);
		vi.spyOn(db, "pragma").mockImplementation((sql, options) => {
			if (compared && !injected && !db.inTransaction && sql === "schema_version") {
				injected = true;
				writer.exec("UPDATE memory_items SET body_text = 'Edited'");
				queueVectorBackfillForIncrementalSync(writer, {
					upsertMemoryIds: [1],
					deleteMemoryIds: [],
				});
			}
			return pragma(sql, options);
		});
		// Act
		await runVectorMigrationPass(db);
		// Assert: a stale cleanup retry must not mark the new pending queue completed.
		expect(injected).toBe(true);
		expect(job()).toMatchObject({
			status: "pending",
			metadata: { pending_upsert_memory_ids: [1], queue_revision: 1 },
		});
		expect(
			db.prepare("SELECT COUNT(*) FROM memory_vectors WHERE model = 'old-model'").pluck().get(),
		).toBe(1);
	});
});

describe("cleanup metadata rechecks after the scan and before the lock", () => {
	it("removes null, orphan and inactive source references without demanding target coverage", async () => {
		// Arrange: represent nullable legacy metadata with an ordinary TEMP-table fixture.
		db.prepare(`INSERT INTO memory_items(id, session_id, kind, title, body_text, active, created_at, updated_at)
			VALUES (2, ?, 'feature', 'Inactive', 'Body', 0, '2026-09-01', '2026-09-01')`).run(session);
		db.exec(`CREATE TEMP TABLE memory_vectors(rowid INTEGER PRIMARY KEY, memory_id INTEGER, model TEXT, content_hash TEXT);
			INSERT INTO memory_vectors VALUES (2, 1, 'old-model', NULL), (3, NULL, 'old-model', NULL),
			(4, 999, 'old-model', 'orphan'), (5, 2, 'old-model', 'inactive')`);
		db.prepare("INSERT INTO memory_vectors VALUES (1, 1, 'test-model', ?)").run(
			embeddings.hashText("One\nBody"),
		);
		db.exec("CREATE TEMP TABLE memory_vectors_rowids AS SELECT rowid FROM memory_vectors");
		const observed = observeCleanupDeleteTransactions();
		// Act
		await runVectorMigrationPass(db);
		// Assert: active memory one needs coverage; null/missing/inactive references do not.
		expect(db.prepare("SELECT rowid FROM memory_vectors").pluck().all()).toEqual([1]);
		expect(job()).toMatchObject({
			status: "completed",
			metadata: { cleanup_pending: false, removed_stale_rows: 4 },
		});
		expect(
			observed.filter((batch) => batch.deleted > 0).map((batch) => batch.scans.length),
		).toEqual([1]);
	});
});
