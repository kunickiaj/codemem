import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import { ATTEMPT_MIGRATION, attemptMigrationHarness, registerAttemptMigrationTests } from "../../core/src/coordinator-owner-attempt-migration-test-harness.js";
import { OWNER_TABLE } from "../../core/src/coordinator-owner-enrollment-test-harness.js";

const migration = env.TEST_MIGRATIONS.find(({ name }) => name === ATTEMPT_MIGRATION);
if (!migration) throw new Error("Missing owner attempt migration");
const predecessor = ["0030_add_owner_enrollment_attempts.sql", "0034_add_owner_admission_pin.sql"].flatMap((name) => {
	const found = env.TEST_MIGRATIONS.find((m) => m.name === name);
	if (!found) throw new Error(`Missing predecessor ${name}`);
	return found.queries;
});
const test = attemptMigrationHarness(async (use) => {
	const db = env.COORDINATOR_DB;
	// Native D1 batch, not exec(), owns the enclosing migration transaction.
	const apply = async (queries: string[]) => { await db.batch(queries.map((sql) => db.prepare(sql))); };
	// Test-only cleanup must drop dependent views/children before rebuilding the predecessor.
	for (const sql of ["DROP VIEW IF EXISTS attempt_view", "DROP TABLE IF EXISTS attempt_child", "DROP TABLE IF EXISTS attempt_copy_guarded", `DROP TABLE IF EXISTS ${OWNER_TABLE}`]) await db.prepare(sql).run();
	await apply(predecessor);
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	try {
		await use({
			exec: async (sql, ...values) => { await db.prepare(sql).bind(...values).run(); },
			query: async (sql) => (await db.prepare(sql).all<Record<string, unknown>>()).results,
			apply,
			queries: migration.queries,
		});
		expect(fetch).not.toHaveBeenCalled();
	} finally { fetch.mockRestore(); }
});
registerAttemptMigrationTests(test);
