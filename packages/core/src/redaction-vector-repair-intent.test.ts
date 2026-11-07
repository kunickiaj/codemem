import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as embeddings from "./embeddings.js";
import { scanSecretsRetroactive } from "./maintenance/scan-secrets.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { SecretScanner } from "./secret-scanner.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { queueVectorBackfill, VECTOR_MODEL_MIGRATION_JOB } from "./vector-backfill-queue.js";

vi.mock("./embeddings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./embeddings.js")>()),
	getEmbeddingClient: vi.fn(async () => null),
}));

const syntheticValue = "SYNTHETIC_PRIVATE_VALUE";
const redactedValue = "[REDACTED:fixture]";
let directory: string;
let db: Database.Database;
let sessionId: number;

function openDb() {
	return new Database(join(directory, "redaction.sqlite"));
}

function scanner() {
	return new SecretScanner({
		rules: [{ kind: "fixture", pattern: /SYNTHETIC_PRIVATE_VALUE/g }],
	});
}

function seedMemory(overrides: { title?: string; body?: string; metadata?: string } = {}) {
	return Number(
		db
			.prepare(`INSERT INTO memory_items (
				session_id, kind, title, body_text, metadata_json, concepts, files_read,
				files_modified, active, rev, created_at, updated_at, import_key
			) VALUES (?, 'discovery', ?, ?, ?, '[]', '[]', '[]', 1, 1,
				'2026-01-01', '2026-01-01', ?)`)
			.run(
				sessionId,
				overrides.title ?? "Synthetic title",
				overrides.body ?? "Synthetic body",
				overrides.metadata ?? "{}",
				`synthetic-${db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()}`,
			).lastInsertRowid,
	);
}

function repairJob() {
	return getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
}

function persistedState() {
	return ["memory_items", "memory_concept_refs", "memory_file_refs", "maintenance_jobs"].map(
		(table) => ({ table, rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }),
	);
}

function observeSql(options: { queueFailure?: Error } = {}) {
	const queueTransactions: boolean[] = [];
	const vectorSql: string[] = [];
	const prepare = db.prepare.bind(db);
	const exec = db.exec.bind(db);
	const recordVectorSql = (sql: string) => {
		if (/\b(?:memory_vectors|vec_f32|vec_version|vec0)\b/i.test(sql)) vectorSql.push(sql);
	};
	vi.spyOn(db, "exec").mockImplementation((sql) => {
		recordVectorSql(sql);
		return exec(sql);
	});
	vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
		recordVectorSql(sql);
		if (/^\s*(?:INSERT\s+INTO|UPDATE)\s+maintenance_jobs\b/i.test(sql)) {
			queueTransactions.push(db.inTransaction);
			if (options.queueFailure) throw options.queueFailure;
		}
		return prepare(sql);
	});
	return { queueTransactions, vectorSql };
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-redaction-vector-intent-"));
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.mocked(embeddings.getEmbeddingClient).mockReset().mockResolvedValue(null);
	db = openDb();
	initTestSchema(db);
	sessionId = insertTestSession(db);
});

afterEach(() => {
	vi.restoreAllMocks();
	if (db.open) db.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

it.each(["title", "body"] as const)(
	"persists %s redaction and repair intent together across close and reopen",
	(field) => {
		// Arrange: direct inserts model legacy rows without pre-existing repair work.
		const memoryId = seedMemory({ [field]: syntheticValue });
		const observed = observeSql();

		// Act
		const result = scanSecretsRetroactive(db, { scanner: scanner() });
		vi.restoreAllMocks();
		db.close();
		db = openDb();
		const row = db.prepare("SELECT title, body_text FROM memory_items WHERE id = ?").get(memoryId);

		// Assert: durable intent is written inside the content transaction without inference.
		expect(result).toMatchObject({ checked: 1, updated: 1, staleWrites: 0 });
		expect(row).toMatchObject({ [field === "body" ? "body_text" : "title"]: redactedValue });
		expect(repairJob()).toMatchObject({
			status: "pending",
			metadata: {
				pending_upsert_memory_ids: [memoryId],
				pending_delete_memory_ids: [],
				queue_revision: 1,
			},
		});
		expect(observed.queueTransactions).toEqual([true]);
		expect(observed.vectorSql).toEqual([]);
		expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
	},
);

it("redacts metadata without creating vector repair intent", () => {
	// Arrange
	const memoryId = seedMemory({ metadata: JSON.stringify({ note: syntheticValue }) });
	const observed = observeSql();

	// Act
	const result = scanSecretsRetroactive(db, { scanner: scanner() });

	// Assert: metadata is outside the title/body embedding input.
	expect(result.updated).toBe(1);
	expect(
		db.prepare("SELECT metadata_json FROM memory_items WHERE id = ?").pluck().get(memoryId),
	).toBe(JSON.stringify({ note: redactedValue }));
	expect(repairJob()).toBeNull();
	expect(observed.queueTransactions).toEqual([]);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it("commits refreshed refs with repair intent and queues only rows whose embedding input changed", () => {
	// Arrange: one sweep includes two embedding changes and one metadata-only change.
	const titleId = seedMemory({ title: syntheticValue });
	const bodyId = seedMemory({ body: syntheticValue });
	seedMemory({ metadata: JSON.stringify({ note: syntheticValue }) });
	db.prepare("UPDATE memory_items SET concepts = ?, files_read = ? WHERE id = ?").run(
		JSON.stringify([syntheticValue]),
		JSON.stringify([syntheticValue]),
		titleId,
	);
	db.prepare("INSERT INTO memory_concept_refs (memory_id, concept) VALUES (?, ?)").run(
		titleId,
		syntheticValue,
	);
	db.prepare(
		"INSERT INTO memory_file_refs (memory_id, file_path, relation) VALUES (?, ?, 'read')",
	).run(titleId, syntheticValue);
	const observed = observeSql();

	// Act
	const result = scanSecretsRetroactive(db, { scanner: scanner() });
	vi.restoreAllMocks();
	db.close();
	db = openDb();

	// Assert: each successful title/body row adds intent, while derived refs match redaction.
	expect(result.updated).toBe(3);
	expect(repairJob()?.metadata).toMatchObject({
		pending_upsert_memory_ids: [titleId, bodyId],
		queue_revision: 2,
	});
	expect(
		db.prepare("SELECT concept FROM memory_concept_refs WHERE memory_id = ?").all(titleId),
	).toEqual([{ concept: redactedValue.toLowerCase() }]);
	expect(
		db.prepare("SELECT file_path FROM memory_file_refs WHERE memory_id = ?").all(titleId),
	).toEqual([{ file_path: redactedValue }]);
	expect(observed.queueTransactions).toEqual([true, true]);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it("previews title/body redactions without changing content, refs or repair intent", () => {
	// Arrange
	seedMemory({ title: syntheticValue, body: syntheticValue });
	const before = persistedState();
	const observed = observeSql();

	// Act
	const result = scanSecretsRetroactive(db, { scanner: scanner(), dryRun: true });

	// Assert
	expect(result).toMatchObject({ updated: 1, staleWrites: 0 });
	expect(result.samples).toHaveLength(1);
	expect(persistedState()).toEqual(before);
	expect(observed.queueTransactions).toEqual([]);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it("does not revise existing repair intent when a second sweep finds unchanged content", () => {
	// Arrange
	const memoryId = seedMemory({ title: syntheticValue, body: syntheticValue });
	scanSecretsRetroactive(db, { scanner: scanner() });
	const before = persistedState();
	const previousJob = repairJob();
	const observed = observeSql();

	// Act
	const result = scanSecretsRetroactive(db, { scanner: scanner() });

	// Assert
	expect(previousJob?.metadata?.pending_upsert_memory_ids).toEqual([memoryId]);
	expect(result).toMatchObject({ checked: 1, updated: 0, staleWrites: 0 });
	expect(persistedState()).toEqual(before);
	expect(observed.queueTransactions).toEqual([]);
});

it("does not enqueue or refresh refs when a concurrent revision rejects the redaction", () => {
	// Arrange: inject a revision change after SELECT through the real scanner seam.
	const memoryId = seedMemory({ title: syntheticValue });
	const racy = scanner();
	const scan = racy.scan.bind(racy);
	let bumped = false;
	vi.spyOn(racy, "scan").mockImplementation((text) => {
		if (!bumped) {
			bumped = true;
			db.prepare("UPDATE memory_items SET rev = rev + 1 WHERE id = ?").run(memoryId);
		}
		return scan(text);
	});
	const observed = observeSql();

	// Act
	const result = scanSecretsRetroactive(db, { scanner: racy });

	// Assert
	expect(bumped).toBe(true);
	expect(result).toMatchObject({ updated: 0, staleWrites: 1, samples: [], detections: [] });
	expect(db.prepare("SELECT title, rev FROM memory_items WHERE id = ?").get(memoryId)).toEqual({
		title: syntheticValue,
		rev: 2,
	});
	expect(repairJob()).toBeNull();
	expect(observed.queueTransactions).toEqual([]);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it.each(["insert", "update"])(
	"rolls back memory and refs when the repair queue %s fails",
	(operation) => {
		// Arrange: seed real derived refs so a failed queue cannot leave partial redaction.
		const memoryId = seedMemory({ title: syntheticValue, body: syntheticValue });
		db.prepare("UPDATE memory_items SET concepts = ?, files_read = ? WHERE id = ?").run(
			JSON.stringify([syntheticValue]),
			JSON.stringify([syntheticValue]),
			memoryId,
		);
		db.prepare("INSERT INTO memory_concept_refs (memory_id, concept) VALUES (?, ?)").run(
			memoryId,
			syntheticValue,
		);
		db.prepare(
			"INSERT INTO memory_file_refs (memory_id, file_path, relation) VALUES (?, ?, 'read')",
		).run(memoryId, syntheticValue);
		if (operation === "update") {
			queueVectorBackfill(db, { upsertMemoryIds: [memoryId], deleteMemoryIds: [] });
		}
		const before = persistedState();
		const failure = new Error("synthetic redaction queue failure");
		const observed = observeSql({ queueFailure: failure });

		// Act
		let error: unknown;
		try {
			scanSecretsRetroactive(db, { scanner: scanner() });
		} catch (caught) {
			error = caught;
		}
		vi.restoreAllMocks();
		db.close();
		db = openDb();

		// Assert: failure cannot commit redaction without its durable repair request.
		expect(error).toBe(failure);
		expect(observed.queueTransactions).toEqual([true]);
		expect(persistedState()).toEqual(before);
		expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
	},
);

it.each(["disabled", "no-vec"])(
	"queues redaction with %s embeddings without inference or vector SQL",
	(mode) => {
		// Arrange: bootstrap while disabled so neither case has a vector table or extension.
		const memoryId = seedMemory({ body: syntheticValue });
		expect(
			db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_vectors'").get(),
		).toBeUndefined();
		if (mode === "no-vec") vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
		const observed = observeSql();
		const loadExtension = vi.spyOn(db, "loadExtension").mockImplementation(() => {
			throw new Error("Unexpected extension loading during redaction");
		});

		// Act
		const result = scanSecretsRetroactive(db, { scanner: scanner() });

		// Assert: durable bookkeeping needs neither inference nor a sqlite-vec runtime.
		expect(result.updated).toBe(1);
		expect(repairJob()?.metadata?.pending_upsert_memory_ids).toEqual([memoryId]);
		expect(observed.vectorSql).toEqual([]);
		expect(loadExtension).not.toHaveBeenCalled();
		expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
	},
);
