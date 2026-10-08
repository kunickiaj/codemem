import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import { normalizeDefinitions, type SchemaFixture } from "../../core/src/coordinator-auth-browser-migration-test-harness.js";
import { NOW } from "../../core/src/coordinator-auth-link-test-fixtures.js";
import { ownerDefinitions, ownerHarness, OWNER_TABLE, registerOwnerSchemaTests } from "../../core/src/coordinator-owner-enrollment-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

const fixture: SchemaFixture = {
	exec: async (sql, ...values) => { await env.COORDINATOR_DB.prepare(sql).bind(...values).run(); },
	query: async (sql) => (await env.COORDINATOR_DB.prepare(sql).all<Record<string, unknown>>()).results,
};
const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0030_add_owner_enrollment_attempts.sql");
if (!migration) throw new Error("Missing owner schema migration fixture");
const test = ownerHarness(async (use) => {
	// Compare the officially migrated definitions with owner-only fixture recreation.
	const expectedOwner = normalizeDefinitions(await fixture.query(ownerDefinitions));
	await fixture.exec(`DROP TABLE ${OWNER_TABLE}`);
	await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
	expect(normalizeDefinitions(await fixture.query(ownerDefinitions))).toEqual(expectedOwner);
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	try {
		await use({ ...fixture, store: new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW }) });
		expect(fetch).not.toHaveBeenCalled();
	} finally { fetch.mockRestore(); }
});
registerOwnerSchemaTests(test);
