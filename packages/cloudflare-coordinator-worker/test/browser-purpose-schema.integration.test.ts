import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
	assertBrowserUniqueness,
	browserDefinitions,
	browserSnapshot,
	normalizeDefinitions,
	seedOldBrowserRows,
	type SchemaFixture,
} from "../../core/src/coordinator-auth-browser-migration-test-harness.js";
import { assertReservedOwnerPurposeIsolation } from "../../core/src/coordinator-auth-browser-owner-purpose-test-harness.js";
import { NOW } from "../../core/src/coordinator-auth-link-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

const fixture: SchemaFixture = {
	exec: async (sql, ...values) => {
		await env.COORDINATOR_DB.prepare(sql).bind(...values).run();
	},
	query: async (sql) => (await env.COORDINATOR_DB.prepare(sql).all<Record<string, unknown>>()).results,
};
const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0029_add_owner_enrollment_attempts.sql");
if (!migration) throw new Error("Missing browser-purpose migration fixture");

it("native official migration preserves all six old signin/link rows and purge counters and rolls back SQL failure", async () => {
	const expectedBrowser = normalizeDefinitions(await fixture.query(browserDefinitions));
	await env.COORDINATOR_DB.batch([
		env.COORDINATOR_DB.prepare("DROP TABLE coordinator_auth_browser_transactions"),
		env.COORDINATOR_DB.prepare("DROP TABLE coordinator_auth_signin_purge_floors"),
	]);
	for (const name of ["0020_add_auth_browser_transactions.sql", "0023_add_auth_signin_purge_floors.sql"]) {
		const old = env.TEST_MIGRATIONS.find((m) => m.name === name);
		if (!old) throw new Error(`Missing old migration ${name}`);
		await env.COORDINATOR_DB.batch(old.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
	}
	try {
		await seedOldBrowserRows(fixture);
		const before = await browserSnapshot(fixture);
		const oldDefinition = await fixture.query(browserDefinitions);
		const failed = [...migration.queries];
		failed.splice(failed.findIndex((sql) => sql.includes("INSERT INTO coordinator_auth_browser_transactions_owner_upgrade")) + 1, 0, "SELECT absent_fixture_column FROM coordinator_auth_browser_transactions_owner_upgrade");
		await expect(env.COORDINATOR_DB.batch(failed.map((sql) => env.COORDINATOR_DB.prepare(sql)))).rejects.toThrow(/absent_fixture_column/);
		expect(await browserSnapshot(fixture)).toEqual(before);
		expect(await fixture.query(browserDefinitions)).toEqual(oldDefinition);
		await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
		expect(await browserSnapshot(fixture)).toEqual(before);
		expect(normalizeDefinitions(await fixture.query(browserDefinitions))).toEqual(expectedBrowser);
		await assertBrowserUniqueness(fixture);
	} finally {
		// Restore the browser schema even if rollback assertions fail.
		const tables = await fixture.query("SELECT sql FROM sqlite_master WHERE name = 'coordinator_auth_browser_transactions'");
		if (!String(tables[0]?.sql).includes("'owner_enroll'")) {
			await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
		}
	}
});

it("native legacy handlers reject reserved owner rows without burning browser material", async () => {
	await assertReservedOwnerPurposeIsolation({
		...fixture,
		store: new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW }),
	});
});
