import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, vi } from "vitest";
import { readBrowserFixtureMigrations } from "../../cloudflare-coordinator-worker/test/browser-purpose-migrations-fixture.js";
import {
	ATTEMPT_MIGRATION,
	attemptMigrationHarness,
	normalizeOwnerDefinitions,
	registerAttemptMigrationTests,
} from "./coordinator-owner-attempt-migration-test-harness.js";
import { ownerDefinitions } from "./coordinator-owner-enrollment-test-harness.js";

const migrations = await readBrowserFixtureMigrations();
const migration = migrations.find(({ name }) => name === ATTEMPT_MIGRATION);
if (!migration) throw new Error("Missing owner attempt migration");
const predecessor = [
	"0030_add_owner_enrollment_attempts.sql",
	"0034_add_owner_admission_pin.sql",
].flatMap((name) => {
	const found = migrations.find((m) => m.name === name);
	if (!found) throw new Error(`Missing predecessor ${name}`);
	return found.queries;
});
const test = attemptMigrationHarness(async (use) => {
	const db = new Database(":memory:");
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	const apply = async (queries: string[]) => {
		db.transaction(() => {
			for (const sql of queries) db.exec(sql);
		})();
	};
	try {
		db.pragma("foreign_keys = ON");
		await apply(predecessor);
		await use({
			exec: async (sql, ...values) => {
				db.prepare(sql).run(...values);
			},
			query: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
			apply,
			queries: migration.queries,
		});
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		db.close();
		fetch.mockRestore();
	}
});
registerAttemptMigrationTests(test);
test("Worker schema.sql creates the same current owner storage as explicit migration 0036", async ({
	fixture: f,
}) => {
	// Arrange
	const db = new Database(":memory:");
	try {
		const sql = readFileSync(
			new URL("../../cloudflare-coordinator-worker/schema.sql", import.meta.url),
			"utf8",
		);
		// Act
		db.exec(sql);
		await f.apply(f.queries);
		// Assert
		expect(normalizeOwnerDefinitions(await f.query(ownerDefinitions))).toEqual(
			normalizeOwnerDefinitions(db.prepare(ownerDefinitions).all() as Record<string, unknown>[]),
		);
	} finally {
		db.close();
	}
});
