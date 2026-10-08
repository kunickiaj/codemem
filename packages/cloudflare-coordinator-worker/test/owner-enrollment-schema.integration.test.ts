import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { NOW } from "../../core/src/coordinator-auth-link-test-fixtures.js";
import {
	assertBrowserUniqueness, browserDefinitions, browserSnapshot, normalizeDefinitions,
	seedOldBrowserRows, type SchemaFixture,
} from "../../core/src/coordinator-owner-enrollment-migration-test-harness.js";
import { ownerDefinitions, ownerHarness, OWNER_TABLE, registerOwnerSchemaTests } from "../../core/src/coordinator-owner-enrollment-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

const fixture: SchemaFixture = {
	exec: async (sql, ...values) => { await env.COORDINATOR_DB.prepare(sql).bind(...values).run(); },
	query: async (sql) => (await env.COORDINATOR_DB.prepare(sql).all<Record<string, unknown>>()).results,
};
const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0029_add_owner_enrollment_attempts.sql");
if (!migration) throw new Error("Missing owner schema migration fixture");
const test = ownerHarness(async (use) => {
	await fixture.exec(`DROP TABLE ${OWNER_TABLE}`);
	await env.COORDINATOR_DB.batch(migration.queries.filter((sql) => sql.includes(OWNER_TABLE)).map((sql) => env.COORDINATOR_DB.prepare(sql)));
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	try {
		await use({ ...fixture, store: new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW }) });
		expect(fetch).not.toHaveBeenCalled();
	} finally { fetch.mockRestore(); }
});
registerOwnerSchemaTests(test);

it("native official migration preserves every pre-owner signin/link row and purge counter", async () => {
	// Arrange: reset only this test's disposable database; restore the current schema afterward.
	const expectedBrowser = normalizeDefinitions(await fixture.query(browserDefinitions));
	const expectedOwner = normalizeDefinitions(await fixture.query(ownerDefinitions));
	const reset = async () => {
		await env.COORDINATOR_DB.batch([
			env.COORDINATOR_DB.prepare("DROP TABLE coordinator_auth_browser_transactions"),
			env.COORDINATOR_DB.prepare("DROP TABLE coordinator_auth_signin_purge_floors"),
			env.COORDINATOR_DB.prepare(`DROP TABLE ${OWNER_TABLE}`),
		]);
		for (const name of ["0020_add_auth_browser_transactions.sql", "0023_add_auth_signin_purge_floors.sql"]) {
			const old = env.TEST_MIGRATIONS.find((m) => m.name === name);
			if (!old) throw new Error(`Missing old migration ${name}`);
			await env.COORDINATOR_DB.batch(old.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
		}
	};
	await reset();
	try {
		await seedOldBrowserRows(fixture);
		const before = await browserSnapshot(fixture);
		const oldDefinition = await fixture.query(browserDefinitions);
		const failed = [...migration.queries];
		failed.splice(failed.findIndex((sql) => sql.includes("INSERT INTO coordinator_auth_browser_transactions_owner_upgrade")) + 1, 0, "SELECT absent_fixture_column FROM coordinator_auth_browser_transactions_owner_upgrade");
		// Act/Assert: an actual SQL abort, not an unknown response after commit.
		await expect(env.COORDINATOR_DB.batch(failed.map((sql) => env.COORDINATOR_DB.prepare(sql)))).rejects.toThrow(/absent_fixture_column/);
		expect(await browserSnapshot(fixture)).toEqual(before);
		expect(await fixture.query(browserDefinitions)).toEqual(oldDefinition);
		// Act
		await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
		// Assert
		expect(await browserSnapshot(fixture)).toEqual(before);
		expect(normalizeDefinitions(await fixture.query(browserDefinitions))).toEqual(expectedBrowser);
		expect(normalizeDefinitions(await fixture.query(ownerDefinitions))).toEqual(expectedOwner);
		await assertBrowserUniqueness(fixture);
	} finally {
		// A failed assertion must not leave an old-schema fixture for later native tests.
		const tables = await fixture.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${OWNER_TABLE}'`);
		if (!tables.length) await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
		expect(normalizeDefinitions(await fixture.query(ownerDefinitions))).toEqual(expectedOwner);
	}
});
