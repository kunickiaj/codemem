import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import { normalizeDefinitions, type SchemaFixture } from "../../core/src/coordinator-auth-browser-migration-test-harness.js";
import { COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS } from "../../core/src/coordinator-owner-enrollment-qualification-schema.js";
import { qualificationDefinitions, qualificationHarness, QUALIFICATION_TABLE, registerQualificationSchemaTests } from "../../core/src/coordinator-owner-enrollment-qualification-test-harness.js";

const fixture: SchemaFixture = {
	exec: async (sql, ...values) => { await env.COORDINATOR_DB.prepare(sql).bind(...values).run(); },
	query: async (sql) => (await env.COORDINATOR_DB.prepare(sql).all<Record<string, unknown>>()).results,
};
const test = qualificationHarness(async (use) => {
	// Native D1 persists between tests; recreate this append-only table instead of DELETE.
	const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0035_add_owner_enrollment_qualifications.sql");
	if (!migration) throw new Error("Missing qualification migration");
	await fixture.exec(`DROP TABLE ${QUALIFICATION_TABLE}`);
	await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	try {
		await use(fixture);
		expect(fetch).not.toHaveBeenCalled();
	} finally { fetch.mockRestore(); }
});
registerQualificationSchemaTests(test);
test("native D1 migration 0035 matches the complete source DDL and recreates empty storage", async ({ fixture: f }) => {
	// Arrange: setup applied every official source migration, including 0035.
	const before = normalizeDefinitions(await f.query(qualificationDefinitions));
	expect(env.TEST_MIGRATIONS.some((m) => m.name === "0035_add_owner_enrollment_qualifications.sql")).toBe(true);
	// Act
	await f.exec(`DROP TABLE ${QUALIFICATION_TABLE}`);
	for (let retry = 0; retry < 2; retry++) await env.COORDINATOR_DB.batch(COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS.map((sql) => env.COORDINATOR_DB.prepare(sql)));
	// Assert
	expect(normalizeDefinitions(await f.query(qualificationDefinitions))).toEqual(before);
	expect(await f.query(`SELECT * FROM ${QUALIFICATION_TABLE}`)).toEqual([]);
});
