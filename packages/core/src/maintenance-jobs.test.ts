import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initDatabase } from "./maintenance.js";
import {
	completeMaintenanceJob,
	failMaintenanceJob,
	getMaintenanceJob,
	listMaintenanceJobs,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { initTestSchema } from "./test-utils.js";

function createDbPath(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-maintenance-jobs-"));
	return join(dir, `${name}.sqlite`);
}

describe("maintenance jobs", () => {
	it("starts and reads a running job", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const job = startMaintenanceJob(db, {
				kind: "vector_migration",
				title: "Re-indexing memories",
				message: "Starting rebuild",
				progressTotal: 100,
				metadata: { source_model: "old", target_model: "new" },
			});

			expect(job.kind).toBe("vector_migration");
			expect(job.status).toBe("running");
			expect(job.progress).toEqual({ current: 0, total: 100, unit: "items" });
			expect(job.metadata).toMatchObject({ source_model: "old", target_model: "new" });
			expect(getMaintenanceJob(db, "vector_migration")).toMatchObject({
				kind: "vector_migration",
				status: "running",
			});
		} finally {
			db.close();
		}
	});

	it("updates progress and completion state", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			startMaintenanceJob(db, {
				kind: "vector_migration",
				title: "Re-indexing memories",
				progressTotal: 10,
			});

			const mid = updateMaintenanceJob(db, "vector_migration", {
				message: "Indexed 4 of 10",
				progressCurrent: 4,
			});
			expect(mid).toMatchObject({
				message: "Indexed 4 of 10",
				progress: { current: 4, total: 10, unit: "items" },
				status: "running",
			});

			const done = completeMaintenanceJob(db, "vector_migration", {
				message: "Rebuild complete",
				progressCurrent: 10,
			});
			expect(done).toMatchObject({
				status: "completed",
				message: "Rebuild complete",
				progress: { current: 10, total: 10, unit: "items" },
			});
			expect(done?.finished_at).toBeTruthy();
		} finally {
			db.close();
		}
	});

	it("records failure state and error text", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			startMaintenanceJob(db, {
				kind: "narrative_backfill",
				title: "Backfilling narrative",
			});

			const failed = failMaintenanceJob(db, "narrative_backfill", "observer unavailable", {
				message: "Stopped during provider outage",
				progressCurrent: 12,
				progressTotal: 30,
			});
			expect(failed).toMatchObject({
				status: "failed",
				message: "Stopped during provider outage",
				error: "observer unavailable",
				progress: { current: 12, total: 30, unit: "items" },
			});
			expect(failed?.finished_at).toBeTruthy();
		} finally {
			db.close();
		}
	});

	it("does not rewrite finished_at when updating an already completed job", async () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			startMaintenanceJob(db, {
				kind: "vector_migration",
				title: "Re-indexing memories",
			});
			const completed = completeMaintenanceJob(db, "vector_migration", {
				message: "Done",
			});
			expect(completed).toBeTruthy();
			if (!completed) throw new Error("expected completed job");
			const firstFinishedAt = completed.finished_at;
			expect(firstFinishedAt).toBeTruthy();

			await new Promise((resolve) => setTimeout(resolve, 5));
			const touched = updateMaintenanceJob(db, "vector_migration", {
				message: "Still done",
			});
			expect(touched).toBeTruthy();
			if (!touched) throw new Error("expected touched job");

			expect(touched.status).toBe("completed");
			expect(touched.finished_at).toBe(firstFinishedAt);
		} finally {
			db.close();
		}
	});

	it("clears stale error when a failed job later completes", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			startMaintenanceJob(db, {
				kind: "vector_migration",
				title: "Re-indexing memories",
			});
			failMaintenanceJob(db, "vector_migration", "temporary outage", {
				message: "provider failed",
			});

			const completed = completeMaintenanceJob(db, "vector_migration", {
				message: "Recovered",
			});
			expect(completed).toBeTruthy();
			if (!completed) throw new Error("expected completed job");

			expect(completed.status).toBe("completed");
			expect(completed.error).toBeNull();
		} finally {
			db.close();
		}
	});

	it("clears terminal fields when explicitly moved back to running", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			startMaintenanceJob(db, {
				kind: "vector_migration",
				title: "Re-indexing memories",
			});
			failMaintenanceJob(db, "vector_migration", "temporary outage", {
				message: "provider failed",
			});

			const restarted = updateMaintenanceJob(db, "vector_migration", {
				status: "running",
				message: "Retrying",
			});
			expect(restarted).toBeTruthy();
			if (!restarted) throw new Error("expected restarted job");

			expect(restarted.status).toBe("running");
			expect(restarted.finished_at).toBeNull();
			expect(restarted.error).toBeNull();
		} finally {
			db.close();
		}
	});

	it("supports explicitly clearing the message with null", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			startMaintenanceJob(db, {
				kind: "vector_migration",
				title: "Re-indexing memories",
				message: "Starting rebuild",
			});

			const updated = updateMaintenanceJob(db, "vector_migration", {
				message: null,
			});
			expect(updated).toBeTruthy();
			if (!updated) throw new Error("expected updated job");

			expect(updated.message).toBeNull();
		} finally {
			db.close();
		}
	});

	it("lists jobs newest-first by updated_at", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			startMaintenanceJob(db, { kind: "one", title: "One" });
			startMaintenanceJob(db, { kind: "two", title: "Two" });
			updateMaintenanceJob(db, "one", { message: "recent touch" });

			const jobs = listMaintenanceJobs(db);
			expect(jobs.map((job) => job.kind)).toEqual(["one", "two"]);
		} finally {
			db.close();
		}
	});

	it("initDatabase ensures maintenance_jobs exists on existing schema-ready dbs", () => {
		const dbPath = createDbPath("init-existing");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.prepare("DROP TABLE maintenance_jobs").run();
		} finally {
			db.close();
		}

		initDatabase(dbPath);

		const verify = new Database(dbPath, { readonly: true });
		try {
			expect(() => verify.prepare("SELECT 1 FROM maintenance_jobs LIMIT 1").get()).not.toThrow();
		} finally {
			verify.close();
		}
	});
});
