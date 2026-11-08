import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listProjectScopeInventory } from "./project-scope-settings.js";
import { ensureScopeBackfillScopes, LEGACY_SHARED_REVIEW_SCOPE_ID } from "./scope-backfill.js";
import { LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";
import { initTestSchema } from "./test-utils.js";

describe("scope backfill during inventory reads", () => {
	let directory: string;
	let writer: InstanceType<typeof Database>;
	let reader: InstanceType<typeof Database> | undefined;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "codemem-scope-read-"));
		writer = new Database(join(directory, "test.sqlite"));
		initTestSchema(writer);
	});
	afterEach(() => {
		reader?.close();
		reader = undefined;
		if (writer.inTransaction) writer.exec("ROLLBACK");
		writer.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it.each(["query_only", "readonly", "competing_writer"])(
		"reads existing scopes and inventory without writes under %s",
		(mode) => {
			// Arrange: seeded scopes must not require a SQLite write lock on later GETs.
			ensureScopeBackfillScopes(writer, "2026-11-01T00:00:00Z");
			reader = new Database(join(directory, "test.sqlite"), { readonly: mode === "readonly" });
			reader.pragma("busy_timeout = 0");
			if (mode === "query_only") reader.pragma("query_only = ON");
			if (mode === "competing_writer") writer.exec("BEGIN IMMEDIATE");
			const changesBefore = reader.prepare("SELECT total_changes() AS n").get();

			// Act: both operations throw if they attempt INSERT OR IGNORE under these modes.
			const inserted = ensureScopeBackfillScopes(reader, "2026-11-02T00:00:00Z");
			const inventory = listProjectScopeInventory(reader);

			// Assert: a competing writer cannot delay an already-seeded inventory read.
			expect(inserted).toBe(0);
			expect(inventory).toMatchObject({ total: 0, projects: [] });
			expect(reader.prepare("SELECT total_changes() AS n").get()).toEqual(changesBefore);
		},
	);

	it("still inserts missing scopes and reports only newly inserted rows", () => {
		// Arrange.
		const firstTimestamp = "2026-11-01T00:00:00Z";
		const repairTimestamp = "2026-11-02T00:00:00Z";

		// Act.
		const initial = ensureScopeBackfillScopes(writer, firstTimestamp);
		writer
			.prepare("DELETE FROM replication_scopes WHERE scope_id = ?")
			.run(LEGACY_SHARED_REVIEW_SCOPE_ID);
		const repaired = ensureScopeBackfillScopes(writer, repairTimestamp);
		const repeated = ensureScopeBackfillScopes(writer, repairTimestamp);

		// Assert: repairing one missing scope preserves the existing scope's metadata.
		expect([initial, repaired, repeated]).toEqual([2, 1, 0]);
		expect(
			writer.prepare("SELECT scope_id, created_at FROM replication_scopes ORDER BY scope_id").all(),
		).toEqual([
			{ scope_id: LEGACY_SHARED_REVIEW_SCOPE_ID, created_at: repairTimestamp },
			{ scope_id: LOCAL_DEFAULT_SCOPE_ID, created_at: firstTimestamp },
		]);
	});

	it("does not pretend missing scopes were seeded on a query-only connection", () => {
		// Arrange.
		writer.pragma("query_only = ON");

		// Act.
		const seedMissing = () => ensureScopeBackfillScopes(writer, "2026-11-01T00:00:00Z");

		// Assert: only already-seeded reads can avoid the required write.
		expect(seedMissing).toThrow(/readonly/i);
		expect(writer.prepare("SELECT COUNT(*) AS n FROM replication_scopes").get()).toEqual({ n: 0 });
	});
});
