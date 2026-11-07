import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	failMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { queueVectorBackfill, VECTOR_MODEL_MIGRATION_JOB } from "./vector-backfill-queue.js";

let db: Database.Database;

beforeEach(() => {
	// This helper needs only SQLite and the existing lazy maintenance-jobs schema.
	db = new Database(":memory:");
});

afterEach(() => db.close());

function job() {
	return getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB);
}

it("creates worker-compatible metadata without an embedding runtime or memory schema", () => {
	// Arrange
	const work = { upsertMemoryIds: [3, 1, 3], deleteMemoryIds: [4, 2, 4] };

	// Act
	queueVectorBackfill(db, work);

	// Assert
	expect(job()).toMatchObject({
		kind: "vector_model_migration",
		status: "pending",
		metadata: {
			pending_upsert_memory_ids: [1, 3],
			pending_delete_memory_ids: [2, 4],
			queue_revision: 1,
			trigger: "sync_incremental",
		},
	});
});

it.each(["running", "failed", "cancelled"] as const)(
	"preserves migration metadata when merging into a %s job",
	(status) => {
		// Arrange
		const preserved = {
			target_model: "synthetic-target",
			requested_model: "synthetic-request",
			requested_revision: "synthetic-revision",
			removed_stale_rows: 7,
			cleanup_pending: true,
			trigger: "model_change",
		};
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Synthetic migration",
			metadata: {
				...preserved,
				pending_upsert_memory_ids: [1, 2],
				pending_delete_memory_ids: [3],
				queue_revision: 8,
			},
		});
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
			progressCurrent: 2,
			progressTotal: 10,
		});
		if (status === "failed") {
			failMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, "synthetic cutover error", {
				message: "Synthetic operator retry required",
			});
		} else if (status === "cancelled") {
			updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				status,
				message: "Synthetic operator retry required",
			});
		}

		// Act: newer work reverses the old operations for two IDs.
		queueVectorBackfill(db, { upsertMemoryIds: [3, 4], deleteMemoryIds: [2, 5] });

		// Assert
		expect(job()).toMatchObject({
			status: status === "running" ? "pending" : status,
			progress: { current: 2, total: 10 },
			metadata: {
				...preserved,
				pending_upsert_memory_ids: [1, 3, 4],
				pending_delete_memory_ids: [2, 5],
				queue_revision: 9,
			},
		});
		if (status !== "running") {
			expect(job()).toMatchObject({
				error: status === "failed" ? "synthetic cutover error" : null,
				message: "Synthetic operator retry required",
			});
		}
	},
);

it.each(["completed", "cancelled"] as const)(
	"retains pending cleanup when reopening a %s job",
	(status) => {
		// Arrange
		const cleanup = {
			cleanup_pending: true,
			target_model: "synthetic-target",
			requested_model: "synthetic-request",
			requested_revision: "synthetic-revision",
			removed_stale_rows: 7,
		};
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Synthetic migration",
			metadata: {
				...cleanup,
				pending_upsert_memory_ids: [99],
				pending_delete_memory_ids: [98],
				queue_revision: 8,
			},
		});
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, { status });

		// Act
		queueVectorBackfill(
			db,
			{ upsertMemoryIds: [1], deleteMemoryIds: [] },
			{ resumeMigration: true },
		);

		// Assert: finished work is dropped while unfinished cleanup keeps its model identity.
		expect(job()).toMatchObject({
			status: "pending",
			metadata: {
				...cleanup,
				pending_upsert_memory_ids: [1],
				pending_delete_memory_ids: [],
				queue_revision: 9,
			},
		});
	},
);

it("does not carry obsolete metadata from a completed job without pending cleanup", () => {
	// Arrange
	startMaintenanceJob(db, {
		kind: VECTOR_MODEL_MIGRATION_JOB,
		title: "Synthetic migration",
		metadata: { target_model: "obsolete", pending_upsert_memory_ids: [99], queue_revision: 8 },
	});
	updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, { status: "completed" });

	// Act
	queueVectorBackfill(db, { upsertMemoryIds: [1], deleteMemoryIds: [] });

	// Assert
	expect(job()?.metadata).toEqual({
		pending_upsert_memory_ids: [1],
		pending_delete_memory_ids: [],
		queue_revision: 1,
		trigger: "sync_incremental",
	});
});

it.each(["failed", "cancelled"] as const)(
	"keeps all local repair IDs when explicitly resuming a %s migration",
	(status) => {
		// Arrange: local work accumulates while the full migration is stopped.
		startMaintenanceJob(db, {
			kind: VECTOR_MODEL_MIGRATION_JOB,
			title: "Synthetic stopped migration",
			metadata: {
				source_model: "synthetic-old-source",
				last_cursor_id: 99,
				trigger: "model_change",
				cleanup_pending: true,
				target_model: "synthetic-target",
				requested_model: "synthetic-request",
				requested_revision: "synthetic-revision",
				removed_stale_rows: 7,
				pending_upsert_memory_ids: [1],
				pending_delete_memory_ids: [4],
				queue_revision: 8,
			},
		});
		updateMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, { status });
		queueVectorBackfill(db, { upsertMemoryIds: [2], deleteMemoryIds: [] });

		// Act: an explicit retry may add another ID, but cannot discard accumulated repairs.
		queueVectorBackfill(
			db,
			{ upsertMemoryIds: [3], deleteMemoryIds: [] },
			{ resumeMigration: true },
		);

		// Assert
		expect(job()).toMatchObject({
			status: "pending",
			metadata: {
				pending_upsert_memory_ids: [1, 2, 3],
				pending_delete_memory_ids: [4],
				queue_revision: 10,
			},
		});
		expect(job()?.metadata?.local_repair_preserves_migration_state).toBeUndefined();
		if (status === "cancelled") {
			expect(job()?.metadata).toEqual({
				cleanup_pending: true,
				target_model: "synthetic-target",
				requested_model: "synthetic-request",
				requested_revision: "synthetic-revision",
				removed_stale_rows: 7,
				pending_upsert_memory_ids: [1, 2, 3],
				pending_delete_memory_ids: [4],
				queue_revision: 10,
				trigger: "sync_incremental",
			});
		} else {
			expect(job()?.metadata).toMatchObject({
				source_model: "synthetic-old-source",
				last_cursor_id: 99,
				trigger: "model_change",
			});
		}
	},
);

it.each([false, true])(
	"ignores empty or invalid work without changing a job (existing=%s)",
	(existing) => {
		// Arrange
		if (existing) queueVectorBackfill(db, { upsertMemoryIds: [1], deleteMemoryIds: [] });
		const before = job();

		// Act
		queueVectorBackfill(db, { upsertMemoryIds: [], deleteMemoryIds: [] });
		queueVectorBackfill(db, {
			upsertMemoryIds: [0, -1, Number.NaN],
			deleteMemoryIds: [1.5, Number.POSITIVE_INFINITY],
		});

		// Assert
		expect(job()).toEqual(before);
	},
);

it("restores the previous queue when the caller rolls back its outer transaction", () => {
	// Arrange
	queueVectorBackfill(db, { upsertMemoryIds: [1], deleteMemoryIds: [] });
	const before = job();
	let inside: ReturnType<typeof job> = null;
	let error: unknown;

	// Act
	try {
		db.transaction(() => {
			queueVectorBackfill(db, { upsertMemoryIds: [2], deleteMemoryIds: [1] });
			inside = job();
			throw new Error("synthetic outer rollback");
		})();
	} catch (caught) {
		error = caught;
	}

	// Assert
	expect(error).toEqual(new Error("synthetic outer rollback"));
	expect(inside).toMatchObject({
		metadata: { pending_upsert_memory_ids: [2], pending_delete_memory_ids: [1], queue_revision: 2 },
	});
	expect(job()).toEqual(before);
});
