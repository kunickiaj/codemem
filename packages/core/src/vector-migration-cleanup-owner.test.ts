import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { loadSqliteVec } from "./db.js";
import * as embeddings from "./embeddings.js";
import {
	completeMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { runVectorMigrationPass, VECTOR_MODEL_MIGRATION_JOB } from "./vector-migration.js";

vi.mock("./embeddings.js", async () => {
	const actual = await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js");
	return {
		...actual,
		getEmbeddingClient: vi.fn(async () => ({
			model: "test-model",
			dimensions: 384,
			identity: { requestedRevision: "test-revision" },
		})),
		resolveEmbeddingClientVectorIdentityLabel: vi.fn(() => "test-model"),
		embedTexts: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384))),
	};
});

const originalPrepare = Database.prototype.prepare;

function seedUncoveredMemory(db: Database, model = "old-model"): void {
	const sessionId = insertTestSession(db);
	db.prepare(
		`INSERT INTO memory_items(id, session_id, kind, title, body_text, confidence,
		 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
		 VALUES (1, ?, 'feature', 'One', 'Body one', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
	).run(sessionId, new Date().toISOString(), new Date().toISOString());
	db.prepare(
		`INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
		 VALUES (?, 1, 0, 'old-content', ?)`,
	).run(new Float32Array(384), model);
	startMaintenanceJob(db, {
		kind: VECTOR_MODEL_MIGRATION_JOB,
		title: "Re-indexing memories",
		metadata: { target_model: "test-model", cleanup_pending: true, removed_stale_rows: 2 },
	});
	completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
}

it.each([
	{ status: "cancelled", target: "test-model", queued: false },
	{ status: "running", target: "test-model", queued: false },
	{ status: "completed", target: "replacement-model", queued: false },
	{ status: "completed", target: "test-model", queued: false },
	{ status: "completed", target: "test-model", queued: true },
] as const)(
	"preserves $status cleanup replacement before owner capture ($target, queued=$queued)",
	async ({ status, target, queued }) => {
		vi.clearAllMocks();
		const pendingUpserts = queued ? [1] : [];
		const pendingDeletes = queued ? [2] : [];
		const dbDir = mkdtempSync(join(tmpdir(), "codemem-vector-cleanup-owner-"));
		const dbPath = join(dbDir, "cleanup-owner.sqlite");
		const db = new Database(dbPath);
		let writerDb: Database | undefined;
		try {
			initTestSchema(db);
			db.pragma("journal_mode = WAL");
			writerDb = new Database(dbPath);
			seedUncoveredMemory(db);
			let replacement: ReturnType<typeof getMaintenanceJob> = null;
			const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
				const statement = originalPrepare.call(db, sql);
				if (sql === "SELECT * FROM maintenance_jobs WHERE kind = ?") {
					const get = statement.get.bind(statement);
					statement.get = ((...params: unknown[]) => {
						const row = get(...params);
						// Commit after the outer read, before cleanup captures its owner.
						if (replacement || !writerDb) return row;
						replacement = updateMaintenanceJob(writerDb, VECTOR_MODEL_MIGRATION_JOB, {
							status,
							message: "Replacement owns this job",
							metadata: {
								target_model: target,
								cleanup_pending: true,
								removed_stale_rows: 77,
								pending_upsert_memory_ids: pendingUpserts,
								pending_delete_memory_ids: pendingDeletes,
								stale_scan_exhausted_max_rowid: 42,
							},
						});
						return row;
					}) as typeof statement.get;
				}
				return statement;
			});
			try {
				await runVectorMigrationPass(db);
			} finally {
				prepareSpy.mockRestore();
			}
			expect(replacement).not.toBeNull();
			expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toEqual(replacement);
			expect(db.prepare("SELECT model FROM memory_vectors").all()).toEqual([
				{ model: "old-model" },
			]);
			expect(embeddings.embedTexts).not.toHaveBeenCalled();
		} finally {
			writerDb?.close();
			db.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	},
);

it.each(["remote-corpus", "remote-vector", "local-vector", "replacement"] as const)(
	"scans legacy cleanup without reserving the writer and rejects %s changes",
	async (mutation) => {
		const dbDir = mkdtempSync(join(tmpdir(), "codemem-vector-cleanup-scan-"));
		const dbPath = join(dbDir, "cleanup-scan.sqlite");
		const db = new Database(dbPath);
		let writerDb: Database | undefined;
		try {
			initTestSchema(db);
			db.pragma("journal_mode = WAL");
			writerDb = new Database(dbPath, { timeout: 0 });
			loadSqliteVec(writerDb);
			seedUncoveredMemory(db, "test-model");
			updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				metadata: { target_model: "test-model", removed_stale_rows: 2 },
			});
			const originalJob = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
			let replacement = originalJob;
			let injected = false;
			let writerError: unknown;
			let scanInTransaction: boolean | undefined;
			const vectorWriter = mutation === "local-vector" ? db : writerDb;
			const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
				const statement = originalPrepare.call(db, sql);
				if (!sql.includes("vector-source-scan-rowids")) return statement;
				const all = statement.all.bind(statement);
				statement.all = ((...params: unknown[]) => {
					const rows = all(...params);
					if (injected || !writerDb) return rows;
					injected = true;
					scanInTransaction = db.inTransaction;
					try {
						if (mutation === "replacement") {
							replacement = updateMaintenanceJob(writerDb, VECTOR_MODEL_MIGRATION_JOB, {
								status: "cancelled",
								message: "Cancelled during scan",
							});
						} else if (mutation === "remote-corpus") {
							writerDb.exec("UPDATE memory_items SET title = 'Changed' WHERE id = 1");
						} else {
							const writer = vectorWriter;
							writer
								.prepare(`INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
								VALUES (?, 1, 0, 'late-content', 'test-model')`)
								.run(new Float32Array(384));
						}
					} catch (error) {
						writerError = error;
					}
					return rows;
				}) as typeof statement.all;
				return statement;
			});
			try {
				await runVectorMigrationPass(db);
			} finally {
				prepareSpy.mockRestore();
			}
			expect(injected).toBe(true);
			expect(writerError).toBeUndefined();
			expect(scanInTransaction).toBe(false);
			expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toEqual(replacement);
		} finally {
			writerDb?.close();
			db.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	},
);

it("persists the legacy watermark after an unchanged unlocked scan", async () => {
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		seedUncoveredMemory(db, "test-model");
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			metadata: { target_model: "test-model", removed_stale_rows: 2 },
		});
		await runVectorMigrationPass(db);
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toMatchObject({
			status: "completed",
			metadata: {
				target_model: "test-model",
				removed_stale_rows: 2,
				stale_scan_exhausted: true,
				stale_scan_exhausted_max_rowid: 1,
			},
		});
		const completed = getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
		await runVectorMigrationPass(db);
		expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)).toEqual(completed);
	} finally {
		db.close();
	}
});
