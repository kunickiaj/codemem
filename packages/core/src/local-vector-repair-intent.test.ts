import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as embeddings from "./embeddings.js";
import { type ExportPayload, importMemories } from "./export-import.js";
import {
	failMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { enrollFixtureSigningKey } from "./managed-scope-test-fixtures.js";
import {
	commitMemoryOwnershipRecovery,
	previewMemoryOwnershipRecovery,
} from "./memory-ownership-recovery.js";
import { ensureVectorSchema } from "./schema-bootstrap.js";
import { type CreatedMemory, MemoryStore } from "./store.js";
import { insertTestSession } from "./test-utils.js";
import { queueVectorBackfill } from "./vector-backfill-queue.js";
import {
	queueVectorBackfillForIncrementalSync,
	runVectorMigrationPass,
	VECTOR_MODEL_MIGRATION_JOB,
	VectorModelMigrationRunner,
} from "./vector-migration.js";

vi.mock("./embeddings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./embeddings.js")>()),
	getEmbeddingClient: vi.fn(async () => null),
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFileSync: vi.fn(() => {
		throw new Error("External subprocess disabled in tests");
	}),
}));

let directory: string;
let store: MemoryStore;
let sessionId: number;

function openStore(): MemoryStore {
	return new MemoryStore(join(directory, "test.sqlite"), {
		keysDir: join(directory, "keys"),
	});
}

function repairJob() {
	return getMaintenanceJob(store.db, VECTOR_MODEL_MIGRATION_JOB);
}

function observeQueueWrites(options: { failure?: Error } = {}) {
	const transactions: boolean[] = [];
	const prepare = Database.prototype.prepare;
	const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql: string,
	) {
		if (/^\s*(?:INSERT\s+INTO|UPDATE)\s+maintenance_jobs\b/i.test(sql)) {
			transactions.push(this.inTransaction);
			if (options.failure) throw options.failure;
		}
		return prepare.call(this, sql);
	});
	return { transactions, spy };
}

function creationState() {
	return [
		"sessions",
		"memory_items",
		"user_prompts",
		"session_summaries",
		"memory_source_bindings",
		"memory_ownership_recoveries",
		"memory_file_refs",
		"memory_concept_refs",
		"replication_ops",
		"memory_local_creation_snapshots",
		"memory_foreign_revisions",
		"memory_local_capture",
		"memory_local_capture_adoption",
	].map((table) => ({
		table,
		rows: store.db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(table)
			? store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
			: [],
	}));
}

function importPayload(): ExportPayload {
	const time = "2026-01-01T00:00:00Z";
	return {
		version: "1.0",
		exported_at: time,
		export_metadata: {
			tool_version: "codemem",
			projects: ["fixture"],
			total_memories: 4,
			total_sessions: 1,
			include_inactive: true,
			filters: {},
		},
		sessions: [{ id: 100, started_at: time, project: "fixture", import_key: "synthetic-session" }],
		memory_items: ["first", "second", "inactive", "deleted"].map((name, index) => ({
			id: 100 + index,
			session_id: 100,
			kind: "discovery",
			title: `Synthetic imported ${name}`,
			body_text: "Synthetic import body",
			active: name === "inactive" ? 0 : 1,
			deleted_at: name === "deleted" ? time : null,
			created_at: time,
			updated_at: time,
			import_key: `synthetic-${name}`,
			files_read: ["src/fixture.ts"],
			concepts: ["fixture"],
			metadata_json: {},
		})),
		user_prompts: [{ id: 100, session_id: 100, prompt_text: "Synthetic prompt", created_at: time }],
		session_summaries: [
			{ id: 100, session_id: 100, request: "Synthetic summary", created_at: time },
		],
	};
}

function recoveryOriginal(title: string): number {
	return Number(
		store.db
			.prepare(`INSERT INTO memory_items (
				session_id, kind, title, body_text, active, created_at, updated_at, metadata_json,
				import_key, origin_device_id, actor_id, visibility, scope_id, files_read, concepts, project
			) VALUES (?, 'discovery', ?, 'Synthetic recovery body', 1, '2026-01-01', '2026-01-01',
				'{}', ?, 'unavailable-source', ?, 'shared', 'local-default', '["src/fixture.ts"]', '["fixture"]', 'test-project')`)
			.run(sessionId, title, `synthetic-original-${title}`, store.actorId).lastInsertRowid,
	);
}

function recoveryInput(ids: number[]) {
	enrollFixtureSigningKey(store.db, join(directory, "keys"), store.deviceId);
	const preview = previewMemoryOwnershipRecovery(store, { version: 1, memoryIds: ids });
	return {
		...preview.request,
		reviewedDigest: preview.reviewedDigest,
		operationId: "synthetic_recovery_operation_01",
		acknowledgeOriginalsRetained: true,
	};
}

function stoppedCutover(options: { status: "failed" | "cancelled"; targetModel?: string }) {
	startMaintenanceJob(store.db, {
		kind: VECTOR_MODEL_MIGRATION_JOB,
		title: "Synthetic stopped cutover",
		metadata: {
			target_model: options.targetModel ?? "synthetic-target",
			requested_model: "synthetic-model",
			requested_revision: "synthetic-revision",
			source_model: "synthetic-old-model",
			cleanup_pending: true,
			removed_stale_rows: 7,
			last_cursor_id: 99,
			processed_embeddable: 2,
			trigger: "model_change",
			pending_upsert_memory_ids: [],
			pending_delete_memory_ids: [],
			queue_revision: 8,
		},
	});
	const diagnostics = {
		message: "Synthetic operator retry required",
		progressCurrent: 2,
		progressTotal: 10,
	};
	if (options.status === "failed") {
		return failMaintenanceJob(
			store.db,
			VECTOR_MODEL_MIGRATION_JOB,
			"synthetic cutover failure",
			diagnostics,
		);
	}
	return updateMaintenanceJob(store.db, VECTOR_MODEL_MIGRATION_JOB, {
		...diagnostics,
		status: "cancelled",
	});
}

function migrationDiagnostics(job: ReturnType<typeof repairJob>) {
	if (!job) return null;
	const { status, error, message, progress, started_at, finished_at, title } = job;
	return { status, error, message, progress, started_at, finished_at, title };
}

function embeddingFixture() {
	const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384)));
	const client: embeddings.EmbeddingClient = {
		model: "synthetic-model",
		dimensions: 384,
		identity: {
			package: "@huggingface/transformers",
			version: "4.2.0",
			model: "synthetic-model",
			revision: "0123456789abcdef0123456789abcdef01234567",
			requestedRevision: "synthetic-revision",
			dtype: "fp32",
			device: "cpu",
			pooling: "mean",
			normalization: "l2",
			dimensions: 384,
		},
		embed,
	};
	return {
		client,
		embed,
		targetModel: embeddings.resolveEmbeddingClientVectorIdentityLabel(client),
	};
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-local-vector-intent-"));
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.mocked(embeddings.getEmbeddingClient).mockReset().mockResolvedValue(null);
	store = openStore();
	sessionId = insertTestSession(store.db);
});

afterEach(async () => {
	await store.flushPendingVectorWrites();
	store.close();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

it("persists repair intent across close and reopen even when embeddings are disabled", () => {
	// Arrange: disabling inference must not disable durable repair bookkeeping.
	const title = "Synthetic local memory";
	const body = "Synthetic content for durable vector repair.";

	// Act: persist through the public creation path, then discard process-local work.
	const memoryId = store.remember(sessionId, "discovery", title, body);
	store.close();
	store = openStore();

	// Assert: content and its existing migration-queue intent both survive reopening.
	expect(store.get(memoryId)).toMatchObject({ title, body_text: body });
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
	expect(repairJob()).toMatchObject({
		status: "pending",
		metadata: {
			pending_upsert_memory_ids: [memoryId],
			queue_revision: expect.any(Number),
		},
	});
});

it("retains repair intent after the embedding client fails and the store reopens", async () => {
	// Arrange: fail only the external client seam, without loading a model runtime.
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	vi.mocked(embeddings.getEmbeddingClient).mockRejectedValue(new Error("synthetic outage"));

	// Act: let the best-effort write settle before discarding the store instance.
	const memoryId = store.remember(sessionId, "discovery", "Failed embedding", "Synthetic body");
	await store.flushPendingVectorWrites();
	store.close();
	store = openStore();

	// Assert: failed inference cannot remove the durable request to repair this row.
	expect(embeddings.getEmbeddingClient).toHaveBeenCalledOnce();
	expect(store.get(memoryId)).toMatchObject({ title: "Failed embedding" });
	expect(repairJob()).toMatchObject({
		status: "pending",
		metadata: { pending_upsert_memory_ids: [memoryId] },
	});
});

it("uses the existing durable migration queue as a persistence control", () => {
	// Arrange: explicitly queue a synthetic row to verify the pre-existing queue contract.
	const memoryId = store.remember(sessionId, "discovery", "Queue control", "Synthetic body");

	// Act
	queueVectorBackfillForIncrementalSync(store.db, {
		upsertMemoryIds: [memoryId],
		deleteMemoryIds: [],
	});
	store.close();
	store = openStore();

	// Assert
	expect(repairJob()).toMatchObject({
		status: "pending",
		metadata: { pending_upsert_memory_ids: [memoryId] },
	});
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it("commits repair intent with rememberForUser before any collector dispatch", () => {
	// Arrange: caller-owned transactions collect identities but may exit before dispatch.
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	const createdMemories: CreatedMemory[] = [];

	// Act: intentionally omit enqueueCommittedVectorWrites after the outer commit.
	const memoryId = store.db.transaction(() =>
		store.rememberForUser(
			sessionId,
			"discovery",
			"Collected creation",
			"Synthetic body",
			0.5,
			undefined,
			undefined,
			{ createdMemories },
		),
	)();
	store.close();
	store = openStore();

	// Assert: identity collection and durable repair are independent of inference dispatch.
	expect(createdMemories).toEqual([{ memoryId, importKey: expect.any(String) }]);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
	expect(store.get(memoryId)).toMatchObject({ title: "Collected creation" });
	expect(repairJob()?.metadata?.pending_upsert_memory_ids).toEqual([memoryId]);
});

it("rolls back both content and repair intent with the caller transaction", () => {
	// Arrange
	const createdMemories: CreatedMemory[] = [];
	let memoryId = 0;
	let error: unknown;

	// Act
	try {
		store.db.transaction(() => {
			memoryId = store.rememberForUser(
				sessionId,
				"discovery",
				"Rolled back creation",
				"Synthetic body",
				0.5,
				undefined,
				undefined,
				{ createdMemories },
			);
			throw new Error("synthetic caller rollback");
		})();
	} catch (caught) {
		error = caught;
	}
	store.enqueueCommittedVectorWrites(createdMemories);
	store.close();
	store = openStore();

	// Assert: stale collected identities must not resurrect rolled-back repair work.
	expect(error).toEqual(new Error("synthetic caller rollback"));
	expect(createdMemories).toEqual([{ memoryId, importKey: expect.any(String) }]);
	expect(store.get(memoryId)).toBeNull();
	expect(repairJob()).toBeNull();
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it("rolls back only the inner creation and intent when a savepoint fails", () => {
	// Arrange
	let rolledBackId = 0;
	let nestedError: unknown;
	let queuedInsideSavepoint: unknown;

	// Act
	const committedId = store.db.transaction(() => {
		const memoryId = store.remember(sessionId, "discovery", "Outer creation", "Synthetic body");
		try {
			store.db.transaction(() => {
				rolledBackId = store.remember(sessionId, "discovery", "Inner creation", "Synthetic body");
				queuedInsideSavepoint = repairJob()?.metadata?.pending_upsert_memory_ids;
				throw new Error("synthetic savepoint rollback");
			})();
		} catch (caught) {
			nestedError = caught;
		}
		return memoryId;
	})();
	store.close();
	store = openStore();

	// Assert: observe intent inside the savepoint as well as its committed remainder.
	expect(nestedError).toEqual(new Error("synthetic savepoint rollback"));
	expect(store.get(committedId)).toMatchObject({ title: "Outer creation" });
	expect(store.get(rolledBackId)).toBeNull();
	expect(queuedInsideSavepoint).toEqual([committedId, rolledBackId]);
	expect(repairJob()?.metadata?.pending_upsert_memory_ids).toEqual([committedId]);
});

it.each(["insert", "update"])(
	"does not commit a memory when the repair queue %s fails",
	(operation) => {
		// Arrange: inject at the real queue SQL boundary, never at memory creation.
		if (operation === "update") {
			const existingId = store.remember(sessionId, "discovery", "Existing row", "Synthetic body");
			queueVectorBackfillForIncrementalSync(store.db, {
				upsertMemoryIds: [existingId],
				deleteMemoryIds: [],
			});
		}
		const previousJob = repairJob();
		const previousRows = store.db.prepare("SELECT id FROM memory_items ORDER BY id").all();
		const prepare = store.db.prepare.bind(store.db);
		const writePattern = /^\s*(?:INSERT\s+INTO|UPDATE)\s+maintenance_jobs\b/i;
		const prepareSpy = vi.spyOn(store.db, "prepare").mockImplementation((sql: string) => {
			if (writePattern.test(sql)) throw new Error("synthetic repair queue failure");
			return prepare(sql);
		});
		let error: unknown;

		// Act
		try {
			store.remember(sessionId, "discovery", "Queue failure creation", "Synthetic body");
		} catch (caught) {
			error = caught;
		}
		prepareSpy.mockRestore();

		// Assert: a repair-write error must abort the same transaction as the content insert.
		expect(error).toEqual(new Error("synthetic repair queue failure"));
		expect(store.db.prepare("SELECT id FROM memory_items ORDER BY id").all()).toEqual(previousRows);
		expect(repairJob()).toEqual(previousJob);
		expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
	},
);

it("does not add rows or revise repair work for an unchanged deduplicated creation", () => {
	// Arrange: seed repair explicitly so this also checks the baseline dedup contract.
	const title = "Unchanged creation";
	const body = "Synthetic body";
	const memoryId = store.rememberForUser(sessionId, "discovery", title, body);
	queueVectorBackfillForIncrementalSync(store.db, {
		upsertMemoryIds: [memoryId],
		deleteMemoryIds: [],
	});
	const previousJob = repairJob();
	const createdMemories: CreatedMemory[] = [];

	// Act
	const duplicateId = store.db.transaction(() =>
		store.rememberForUser(sessionId, "discovery", title, body, 0.5, undefined, undefined, {
			createdMemories,
		}),
	)();
	store.enqueueCommittedVectorWrites(createdMemories);

	// Assert: deduplication creates neither a new identity nor redundant durable work.
	expect(duplicateId).toBe(memoryId);
	expect(createdMemories).toEqual([]);
	expect(store.db.prepare("SELECT id FROM memory_items").all()).toEqual([{ id: memoryId }]);
	expect(repairJob()).toEqual(previousJob);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it("queues only new active nondeleted imports once inside the import transaction", () => {
	// Arrange
	const payload = importPayload();
	const writes = observeQueueWrites();

	// Act
	const result = importMemories(payload, { dbPath: store.dbPath });
	const activeIds = store.db
		.prepare("SELECT id FROM memory_items WHERE active = 1 AND deleted_at IS NULL ORDER BY id")
		.pluck()
		.all();
	store.close();
	store = openStore();

	// Assert: inactive/deleted rows persist but never enter the repair queue.
	expect(result).toMatchObject({ memory_items: 4, dryRun: false });
	expect(activeIds).toHaveLength(2);
	expect(repairJob()?.metadata).toMatchObject({
		pending_upsert_memory_ids: activeIds,
		pending_delete_memory_ids: [],
		queue_revision: 1,
	});
	expect(writes.transactions).toEqual([true]);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it("does not queue dry-run imports or change their persisted state", () => {
	// Arrange
	const before = creationState();
	const writes = observeQueueWrites();

	// Act
	const result = importMemories(importPayload(), { dbPath: store.dbPath, dryRun: true });

	// Assert
	expect(result).toMatchObject({ memory_items: 4, dryRun: true });
	expect(creationState()).toEqual(before);
	expect(repairJob()).toBeNull();
	expect(writes.transactions).toEqual([]);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it("does not revise repair intent when an import is deduplicated", () => {
	// Arrange
	const payload = importPayload();
	importMemories(payload, { dbPath: store.dbPath });
	const before = creationState();
	const previousJob = repairJob();
	const writes = observeQueueWrites();

	// Act
	const result = importMemories(payload, { dbPath: store.dbPath });

	// Assert
	expect(result).toMatchObject({ memory_items: 0, sessions: 0 });
	expect(creationState()).toEqual(before);
	expect(repairJob()).toEqual(previousJob);
	expect(writes.transactions).toEqual([]);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it.each(["inactive", "deleted"])(
	"does not queue an import containing only %s memories",
	(state) => {
		// Arrange
		const payload = importPayload();
		payload.memory_items = payload.memory_items.filter(
			(row) => row.title === `Synthetic imported ${state}`,
		);
		const writes = observeQueueWrites();

		// Act
		const result = importMemories(payload, { dbPath: store.dbPath });

		// Assert
		expect(result.memory_items).toBe(1);
		expect(repairJob()).toBeNull();
		expect(writes.transactions).toEqual([]);
		expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
	},
);

it("rolls back imported content and bookkeeping when the repair queue write fails", () => {
	// Arrange: import opens its own connection, so inject at the shared SQLite write boundary.
	const before = creationState();
	const writes = observeQueueWrites({ failure: new Error("synthetic import queue failure") });
	let error: unknown;

	// Act
	try {
		importMemories(importPayload(), { dbPath: store.dbPath });
	} catch (caught) {
		error = caught;
	}
	writes.spy.mockRestore();

	// Assert: prompts, summaries, refs and foreign provenance cannot outlive failed content.
	expect(error).toEqual(new Error("synthetic import queue failure"));
	expect(writes.transactions).toEqual([true]);
	expect(creationState()).toEqual(before);
	expect(repairJob()).toBeNull();
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it("queues recovered copies once inside their commit and leaves receipt replay unchanged", () => {
	// Arrange: source rows deliberately have no local creation or repair intent.
	const originals = [recoveryOriginal("first"), recoveryOriginal("second")];
	const input = recoveryInput(originals);
	const writes = observeQueueWrites();

	// Act
	const result = commitMemoryOwnershipRecovery(store, input);
	const previousJob = repairJob();
	const beforeReplay = creationState();
	const replay = commitMemoryOwnershipRecovery(store, input);
	store.close();
	store = openStore();

	// Assert: only newly created copies enter the queue and matching receipts add no work.
	const copyIds = result.copies.map((copy) => copy.recoveredMemoryId);
	expect(copyIds).toHaveLength(2);
	expect(copyIds.every((id) => !originals.includes(id))).toBe(true);
	expect(repairJob()?.metadata).toMatchObject({
		pending_upsert_memory_ids: copyIds,
		pending_delete_memory_ids: [],
		queue_revision: 1,
	});
	expect(repairJob()).toEqual(previousJob);
	expect(replay).toEqual({ ...result, idempotent: true });
	expect(creationState()).toEqual(beforeReplay);
	expect(writes.transactions).toEqual([true]);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it("does not queue or copy memories during ownership-recovery preview", () => {
	// Arrange
	const memoryId = recoveryOriginal("preview");
	enrollFixtureSigningKey(store.db, join(directory, "keys"), store.deviceId);
	const before = creationState();
	const writes = observeQueueWrites();

	// Act
	const preview = previewMemoryOwnershipRecovery(store, { version: 1, memoryIds: [memoryId] });

	// Assert
	expect(preview.copyCount).toBe(1);
	expect(creationState()).toEqual(before);
	expect(repairJob()).toBeNull();
	expect(writes.transactions).toEqual([]);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it.each(["inactive", "deleted"])("does not queue recovery when an original becomes %s", (state) => {
	// Arrange
	const memoryId = recoveryOriginal(state);
	const input = recoveryInput([memoryId]);
	if (state === "inactive") {
		store.db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(memoryId);
	} else {
		store.db
			.prepare("UPDATE memory_items SET deleted_at = '2026-01-02' WHERE id = ?")
			.run(memoryId);
	}
	const before = creationState();
	const writes = observeQueueWrites();
	let error: unknown;

	// Act
	try {
		commitMemoryOwnershipRecovery(store, input);
	} catch (caught) {
		error = caught;
	}

	// Assert
	expect(error).toMatchObject({ message: "ownership_records_unavailable" });
	expect(creationState()).toEqual(before);
	expect(repairJob()).toBeNull();
	expect(writes.transactions).toEqual([]);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it("rolls back recovery copies, refs, provenance and receipt when the repair queue write fails", () => {
	// Arrange
	const input = recoveryInput([recoveryOriginal("rollback")]);
	const before = creationState();
	const writes = observeQueueWrites({ failure: new Error("synthetic recovery queue failure") });
	let error: unknown;

	// Act
	try {
		commitMemoryOwnershipRecovery(store, input);
	} catch (caught) {
		error = caught;
	}
	writes.spy.mockRestore();

	// Assert
	expect(error).toEqual(new Error("synthetic recovery queue failure"));
	expect(writes.transactions).toEqual([true]);
	expect(creationState()).toEqual(before);
	expect(repairJob()).toBeNull();
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it.each(
	(["failed", "cancelled"] as const).flatMap((status) =>
		["remember", "import", "recovery"].map((path) => ({ status, path })),
	),
)(
	"preserves $status cutover diagnostics when $path adds durable local repair intent",
	({ status, path }) => {
		// Arrange
		const input = path === "recovery" ? recoveryInput([recoveryOriginal("failed-job")]) : null;
		const stopped = stoppedCutover({ status });
		let newIds: number[];

		// Act
		if (path === "remember") {
			newIds = [store.remember(sessionId, "discovery", "New local repair", "Synthetic body")];
		} else if (input) {
			newIds = commitMemoryOwnershipRecovery(store, input).copies.map(
				(copy) => copy.recoveredMemoryId,
			);
		} else {
			importMemories(importPayload(), { dbPath: store.dbPath });
			newIds = store.db
				.prepare("SELECT id FROM memory_items WHERE active = 1 AND deleted_at IS NULL ORDER BY id")
				.pluck()
				.all() as number[];
		}
		store.close();
		store = openStore();

		// Assert: enqueueing leaves diagnostics intact before the next periodic worker pass.
		expect(newIds.length).toBeGreaterThan(0);
		expect(migrationDiagnostics(repairJob())).toEqual(migrationDiagnostics(stopped));
		expect(repairJob()?.error).toBe(status === "failed" ? "synthetic cutover failure" : null);
		expect(repairJob()?.metadata).toMatchObject({
			...stopped?.metadata,
			pending_upsert_memory_ids: newIds,
			queue_revision: 9,
		});
		if (status === "cancelled") {
			expect(repairJob()?.metadata?.local_repair_preserves_migration_state).toBe(true);
		} else {
			expect(repairJob()?.metadata?.local_repair_preserves_migration_state).toBeUndefined();
		}
		expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
	},
);

it("drains local repair without resuming a cancelled full cutover or clearing its diagnostics", async () => {
	const status = "cancelled";
	// Arrange: an unrelated old-model row makes an accidental full migration observable.
	const { client, embed, targetModel } = embeddingFixture();
	const legacyId = recoveryOriginal("legacy cutover row");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	ensureVectorSchema(store.db);
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	store.db
		.prepare(`INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
		VALUES (vec_f32(?), ?, 0, 'synthetic-old-content', 'synthetic-old-model')`)
		.run(JSON.stringify(Array.from(new Float32Array(384))), BigInt(legacyId));
	const stopped = stoppedCutover({ status, targetModel });
	const memoryId = store.remember(sessionId, "discovery", "Repair only", "Synthetic fresh body");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(client);

	// Act: a second pass after draining must still leave the stopped cutover alone.
	await runVectorMigrationPass(store.db, { batchSize: 10 });
	await runVectorMigrationPass(store.db, { batchSize: 10 });

	// Assert
	expect(embed.mock.calls.flatMap(([texts]) => texts)).toEqual([
		"Repair only\nSynthetic fresh body",
	]);
	expect(
		store.db.prepare("SELECT memory_id, model FROM memory_vectors ORDER BY memory_id").all(),
	).toEqual([
		{ memory_id: legacyId, model: "synthetic-old-model" },
		{ memory_id: memoryId, model: targetModel },
	]);
	expect(migrationDiagnostics(repairJob())).toEqual(migrationDiagnostics(stopped));
	expect(repairJob()?.error).toBe(status === "failed" ? "synthetic cutover failure" : null);
	expect(repairJob()?.metadata).toMatchObject({
		...stopped?.metadata,
		pending_upsert_memory_ids: [],
		queue_revision: 9,
		local_repair_preserves_migration_state: true,
	});
});

it("retains local repair and the cancelled cutover state when repair inference fails", async () => {
	const status = "cancelled";
	// Arrange
	const { client, embed, targetModel } = embeddingFixture();
	embed.mockRejectedValue(new Error("synthetic repair inference failure"));
	const stopped = stoppedCutover({ status, targetModel });
	const memoryId = store.remember(sessionId, "discovery", "Repair failure", "Synthetic body");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	ensureVectorSchema(store.db);
	vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(client);

	// Act
	try {
		await runVectorMigrationPass(store.db, { batchSize: 10 });
	} catch {
		// The runner may report the inference error, but must keep the original migration state.
	}

	// Assert
	expect(embed).toHaveBeenCalledOnce();
	expect(migrationDiagnostics(repairJob())).toEqual(migrationDiagnostics(stopped));
	expect(repairJob()?.error).toBe(status === "failed" ? "synthetic cutover failure" : null);
	expect(repairJob()?.metadata?.pending_upsert_memory_ids).toEqual([memoryId]);
});

it.each(["failed", "cancelled"] as const)(
	"keeps explicit sync retry behavior for a %s migration",
	async (status) => {
		// Arrange
		const { client, targetModel } = embeddingFixture();
		stoppedCutover({ status, targetModel });
		const memoryId = store.remember(
			sessionId,
			"discovery",
			"Explicit sync retry",
			"Synthetic body",
		);
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
		ensureVectorSchema(store.db);
		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(client);

		// Act
		queueVectorBackfillForIncrementalSync(store.db, {
			upsertMemoryIds: [memoryId],
			deleteMemoryIds: [],
		});
		const queued = repairJob();
		await runVectorMigrationPass(store.db, { batchSize: 10 });

		// Assert: explicit sync resumes the existing migration and can finish it normally.
		expect(queued).toMatchObject({
			status: "pending",
			progress: { current: 0, total: status === "failed" ? 10 : null },
		});
		expect(repairJob()).toMatchObject({ status: "completed", error: null });
		expect(store.db.prepare("SELECT memory_id, model FROM memory_vectors").all()).toEqual([
			{ memory_id: memoryId, model: targetModel },
		]);
	},
);

it.each(["remember", "import", "recovery"])(
	"automatically resumes a failed cutover after %s queues local repair without clearing diagnostics at enqueue",
	async (path) => {
		// Arrange: one covered row precedes a failed migration's saved cursor.
		const { client, embed, targetModel } = embeddingFixture();
		const coveredId = recoveryOriginal("Already covered");
		const remainderId = recoveryOriginal("Cutover remainder");
		const input = path === "recovery" ? recoveryInput([recoveryOriginal("Recovery source")]) : null;
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
		ensureVectorSchema(store.db);
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
		const insertVector =
			store.db.prepare(`INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
			VALUES (vec_f32(?), ?, 0, ?, ?)`);
		const vector = JSON.stringify(Array.from(new Float32Array(384)));
		insertVector.run(
			vector,
			BigInt(coveredId),
			embeddings.hashText("Already covered\nSynthetic recovery body"),
			targetModel,
		);
		insertVector.run(vector, BigInt(remainderId), "synthetic-stale-content", "synthetic-old-model");
		const failed = stoppedCutover({ status: "failed", targetModel });
		updateMaintenanceJob(store.db, VECTOR_MODEL_MIGRATION_JOB, {
			metadata: {
				...failed?.metadata,
				cleanup_pending: false,
				last_cursor_id: coveredId,
				processed_embeddable: 1,
			},
		});
		const diagnostics = migrationDiagnostics(repairJob());

		// Act: local capture persists repair first. Periodic passes resume without a sync retry.
		if (path === "remember") {
			store.remember(sessionId, "discovery", "Local retry creation", "Synthetic fresh body");
		} else if (input) {
			commitMemoryOwnershipRecovery(store, input);
		} else {
			importMemories(importPayload(), { dbPath: store.dbPath });
		}
		const afterEnqueue = repairJob();
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(client);
		await runVectorMigrationPass(store.db, { batchSize: 1 });
		const firstCursor = Number(repairJob()?.metadata?.last_cursor_id);
		for (let pass = 0; pass < 8 && repairJob()?.status !== "completed"; pass++) {
			await runVectorMigrationPass(store.db, { batchSize: 10 });
		}

		// Assert: queueing preserves the diagnosis, but does not disable baseline automatic retry.
		expect(migrationDiagnostics(afterEnqueue)).toEqual(diagnostics);
		expect(firstCursor).toBeGreaterThanOrEqual(coveredId);
		expect(repairJob()).toMatchObject({ status: "completed", error: null });
		const embedded = embed.mock.calls.flatMap(([texts]) => texts);
		expect(embedded).toContain("Cutover remainder\nSynthetic recovery body");
		expect(embedded).not.toContain("Already covered\nSynthetic recovery body");
		expect(store.db.prepare("SELECT DISTINCT model FROM memory_vectors").pluck().all()).toEqual([
			targetModel,
		]);
		expect(repairJob()?.metadata?.pending_upsert_memory_ids ?? []).toEqual([]);
		expect(repairJob()?.metadata?.local_repair_preserves_migration_state).toBeUndefined();
	},
);

it("automatically retries a flagged failed migration even when its local repair queue is empty", async () => {
	// Arrange: an empty queue must not make an earlier failed migration permanently idle.
	const { client, embed, targetModel } = embeddingFixture();
	const memoryId = recoveryOriginal("Empty queue retry");
	const failed = stoppedCutover({ status: "failed", targetModel });
	updateMaintenanceJob(store.db, VECTOR_MODEL_MIGRATION_JOB, {
		metadata: {
			...failed?.metadata,
			last_cursor_id: 0,
			cleanup_pending: false,
			local_repair_preserves_migration_state: true,
		},
	});
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	ensureVectorSchema(store.db);
	vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(client);

	// Act
	await runVectorMigrationPass(store.db, { batchSize: 10 });

	// Assert
	expect(embed).toHaveBeenCalledOnce();
	expect(repairJob()).toMatchObject({ status: "completed", error: null });
	expect(repairJob()?.metadata?.local_repair_preserves_migration_state).toBeUndefined();
	expect(store.db.prepare("SELECT memory_id, model FROM memory_vectors").all()).toEqual([
		{ memory_id: memoryId, model: targetModel },
	]);
});

it("records a new queued-repair inference error when the periodic runner retries a failed migration", async () => {
	// Arrange: keep the real runner and SQLite path, replacing only the embedding client.
	const { client, embed, targetModel } = embeddingFixture();
	embed.mockRejectedValue(new Error("synthetic new retry inference failure"));
	stoppedCutover({ status: "failed", targetModel });
	const memoryId = store.remember(
		sessionId,
		"discovery",
		"Periodic retry failure",
		"Synthetic body",
	);
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	ensureVectorSchema(store.db);
	vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue(client);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.useFakeTimers();
	const runner = new VectorModelMigrationRunner({ dbPath: store.dbPath });

	// Act: run the scheduled first tick without a real-time wait.
	try {
		runner.start();
		await vi.advanceTimersByTimeAsync(100);
		await runner.stop();
	} finally {
		await runner.stop();
		vi.useRealTimers();
	}

	// Assert: the current failure replaces obsolete diagnostics without losing queued work.
	expect(embed).toHaveBeenCalledOnce();
	expect(repairJob()).toMatchObject({
		status: "failed",
		error: "synthetic new retry inference failure",
	});
	expect(repairJob()?.metadata?.pending_upsert_memory_ids).toEqual([memoryId]);
	expect(repairJob()?.metadata?.local_repair_preserves_migration_state).toBeUndefined();
});

it("preserves all 5000 disabled-embedding repair IDs when a new local memory is added", () => {
	// Arrange: a large existing job must not lose older IDs as the queue grows.
	const pendingIds = Array.from({ length: 5000 }, (_, index) => index + 10000);
	queueVectorBackfill(store.db, { upsertMemoryIds: pendingIds, deleteMemoryIds: [20000, 20001] });
	const revision = Number(repairJob()?.metadata?.queue_revision);

	// Act
	const memoryId = store.remember(sessionId, "discovery", "Large queue addition", "Synthetic body");
	store.close();
	store = openStore();

	// Assert: no elapsed-time threshold is needed to verify that durable work is retained.
	expect(repairJob()?.metadata).toMatchObject({
		pending_upsert_memory_ids: [...pendingIds, memoryId],
		pending_delete_memory_ids: [20000, 20001],
		queue_revision: revision + 1,
	});
	expect(store.db.prepare("SELECT COUNT(*) FROM maintenance_jobs").pluck().get()).toBe(1);
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});

it.each([
	{ active: null, deleted_at: null, queues: true },
	{ active: "1", deleted_at: "", queues: true },
	{ active: "invalid", deleted_at: "   ", queues: true },
	{ active: "0", deleted_at: null, queues: false },
	{ active: 1, deleted_at: "2026-01-02", queues: false },
])("queues normalized import eligibility for %j", (eligibility) => {
	// Arrange
	const payload = importPayload();
	payload.memory_items = [
		{ ...payload.memory_items[0], active: eligibility.active, deleted_at: eligibility.deleted_at },
	];

	// Act
	importMemories(payload, { dbPath: store.dbPath });
	const memoryId = store.db.prepare("SELECT id FROM memory_items").pluck().get();

	// Assert: queue eligibility must use the same normalized values as persisted content.
	if (eligibility.queues) {
		expect(repairJob()?.metadata?.pending_upsert_memory_ids).toEqual([memoryId]);
	} else {
		expect(repairJob()).toBeNull();
	}
	expect(embeddings.getEmbeddingClient).not.toHaveBeenCalled();
});
